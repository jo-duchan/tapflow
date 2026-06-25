// audio-tap.c — injected into the iOS-simulator guest app via SIMCTL_CHILD_DYLD_INSERT_LIBRARIES.
// Taps the app's PCM at the CoreAudio source (no host device, no routing — the only per-sim-isolated,
// headless, non-host-hijacking path; routeGuest is a no-op on headless sims). The captured PCM is
// streamed to the agent over loopback TCP as length-prefixed frames: [u32 BE len][PCM bytes].
//
// Build (iphonesimulator, like the other ios-agent helpers):
//   xcrun --sdk iphonesimulator clang -arch arm64 -dynamiclib src/audio-tap.c \
//     -framework AudioToolbox -o bin/audio-tap.dylib
#include <AudioToolbox/AudioToolbox.h>
#include <AudioUnit/AudioUnit.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>

static int g_sock = -1;

// Length-prefixed send. On any short write the peer is gone (agent closed) — disable and stop trying.
// NOTE: blocking write on the audio callback thread is fine for the MVP; a production tap should hand
// off to a ring buffer + sender thread so a stalled socket can never glitch playback.
static void send_frame(const void *data, uint32_t len) {
    if (g_sock < 0 || len == 0) return;
    uint32_t belen = htonl(len);
    if (write(g_sock, &belen, 4) != 4 || write(g_sock, data, len) != (ssize_t)len) {
        close(g_sock);
        g_sock = -1;
    }
}

// AudioQueue path (AudioServicesPlaySystemSound, raw AudioQueue apps) — assumed S16 PCM.
static OSStatus tap_AudioQueueEnqueueBuffer(
    AudioQueueRef inAQ, AudioQueueBufferRef inBuffer,
    UInt32 inNumPacketDescs, const AudioStreamPacketDescription *inPacketDescs)
{
    send_frame(inBuffer->mAudioData, inBuffer->mAudioDataByteSize);
    return AudioQueueEnqueueBuffer(inAQ, inBuffer, inNumPacketDescs, inPacketDescs);
}

__attribute__((used)) static struct { const void *replacement; const void *replacee; }
_interpose_aqeb __attribute__((section("__DATA,__interpose"))) =
    { (const void *)tap_AudioQueueEnqueueBuffer, (const void *)AudioQueueEnqueueBuffer };

// AVAudioEngine / AudioUnit path. The output unit (AURemoteIO) is a v3 unit pulled internally, so it
// can't be hooked via the public v2 API. But AVAudioEngine routes its mix through a v2
// MultiChannelMixer (mainMixerNode) whose render DOES go through AudioUnitRender — and the mixer's
// output is the final mix. We lock onto the first mixer instance (avoids interleaving submixes) and
// convert its Float32 planar output to the canonical S16 interleaved stereo.
#define DST_SR 44100.0          // canonical rate the dashboard plays at (matches android-agent)
#define CONV_CAP 8192           // g_conv capacity in int16 → 4096 stereo frames

static AudioUnit g_mixerUnit = NULL;
static int16_t g_conv[CONV_CAP];
static double g_srcSR = 0;      // the mixer's output sample rate, queried once (0 = not yet known)

static inline int16_t f2s16(float f) {
    if (f > 1.0f) f = 1.0f; else if (f < -1.0f) f = -1.0f;
    return (int16_t)(f * 32767.0f);
}

// Convert one mixer render (Float32 planar, g_srcSR) to canonical S16 interleaved stereo @ 44100.
// Resamples with linear interpolation when g_srcSR != 44100 (e.g. a 48 kHz app), so the dashboard's
// fixed-44100 playback isn't pitch-shifted.
static void send_mixer(const AudioBufferList *io, UInt32 frames) {
    if (g_sock < 0 || io->mNumberBuffers == 0 || g_srcSR <= 0) return;
    const float *L = (const float *)io->mBuffers[0].mData;
    const float *R = (io->mNumberBuffers > 1) ? (const float *)io->mBuffers[1].mData : L; // mono → dup

    if (g_srcSR == DST_SR) {
        if (frames * 2 > CONV_CAP) return;
        for (UInt32 i = 0; i < frames; i++) {
            g_conv[2 * i]     = f2s16(L[i]);
            g_conv[2 * i + 1] = f2s16(R[i]);
        }
        send_frame(g_conv, frames * 2 * sizeof(int16_t));
        return;
    }

    const double ratio = DST_SR / g_srcSR; // out frames per in frame
    UInt32 outFrames = (UInt32)(frames * ratio);
    if (outFrames * 2 > CONV_CAP) outFrames = CONV_CAP / 2;
    for (UInt32 j = 0; j < outFrames; j++) {
        const double srcPos = j / ratio;            // position in the source buffer
        const UInt32 i0 = (UInt32)srcPos;
        const UInt32 i1 = (i0 + 1 < frames) ? i0 + 1 : i0;
        const float frac = (float)(srcPos - i0);
        g_conv[2 * j]     = f2s16(L[i0] + (L[i1] - L[i0]) * frac);
        g_conv[2 * j + 1] = f2s16(R[i0] + (R[i1] - R[i0]) * frac);
    }
    send_frame(g_conv, outFrames * 2 * sizeof(int16_t));
}

static OSStatus tap_AudioUnitRender(
    AudioUnit inUnit, AudioUnitRenderActionFlags *ioActionFlags,
    const AudioTimeStamp *inTimeStamp, UInt32 inBus, UInt32 inFrames, AudioBufferList *ioData)
{
    OSStatus r = AudioUnitRender(inUnit, ioActionFlags, inTimeStamp, inBus, inFrames, ioData);
    if (g_sock >= 0 && ioData) {
        AudioComponent c = AudioComponentInstanceGetComponent(inUnit);
        AudioComponentDescription d;
        if (c && AudioComponentGetDescription(c, &d) == noErr && d.componentType == kAudioUnitType_Mixer) {
            if (g_mixerUnit == NULL) {
                g_mixerUnit = inUnit;
                AudioStreamBasicDescription asbd; UInt32 sz = sizeof(asbd);
                if (AudioUnitGetProperty(inUnit, kAudioUnitProperty_StreamFormat,
                                         kAudioUnitScope_Output, 0, &asbd, &sz) == noErr) {
                    g_srcSR = asbd.mSampleRate;
                    fprintf(stderr, "audio-tap: mixer output SR=%.0f ch=%u\n", g_srcSR, asbd.mChannelsPerFrame);
                }
            }
            if (inUnit == g_mixerUnit) send_mixer(ioData, inFrames);
        }
    }
    return r;
}

__attribute__((used)) static struct { const void *replacement; const void *replacee; }
_interpose_aur __attribute__((section("__DATA,__interpose"))) =
    { (const void *)tap_AudioUnitRender, (const void *)AudioUnitRender };

__attribute__((constructor)) static void audio_tap_init(void) {
    const char *ps = getenv("TAPFLOW_AUDIO_PORT");
    if (!ps) { fprintf(stderr, "audio-tap: no TAPFLOW_AUDIO_PORT — capture disabled\n"); return; }
    int port = atoi(ps);
    if (port <= 0) return;
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // 127.0.0.1 — guest reaches the host's loopback
    if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        fprintf(stderr, "audio-tap: connect 127.0.0.1:%d failed — capture disabled\n", port);
        close(s);
        return;
    }
    g_sock = s;
    fprintf(stderr, "audio-tap: connected to 127.0.0.1:%d (AudioQueue + AudioUnit mixer hooks)\n", port);
}
