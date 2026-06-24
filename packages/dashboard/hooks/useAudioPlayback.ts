import { useCallback, useEffect, useRef, useState } from 'react'
import { pcmS16ToFloat32Planar } from '@/lib/audio/pcm'

// MVP fixed format: the Android emulator's gRPC audio is S16LE / 44100 / Stereo. iOS will
// negotiate its format later. The AudioContext resamples 44100 buffers to its own rate.
const SAMPLE_RATE = 44100
const CHANNELS = 2
// Small jitter buffer: schedule each chunk this far ahead so network jitter doesn't underrun.
const JITTER_LEAD = 0.06 // 60ms
// If the playhead falls behind or drifts too far ahead, resync (a brief glitch beats growing latency).
const RESYNC_GAP = 0.3 // 300ms
const SILENCE_THRESHOLD = 0.01 // |sample| above this counts as audible
const SOUND_HOLD_MS = 1200     // keep the "on" indicator this long after the last audible frame

type AnyAudioContext = typeof AudioContext

export interface AudioPlayback {
  // Feed one raw-PCM payload (envelope already stripped). Stable identity — safe in deps.
  pushFrame: (pcm: ArrayBuffer) => void
  hasAudio: boolean      // an audio stream exists for this session (first frame seen)
  soundActive: boolean   // audible sound is currently coming through (non-silent recently)
}

// Always-on playback: we play whatever the emulator outputs and never mute on our side —
// muting is the emulator's job (its own volume keys). We only surface an on/off indicator.
export function useAudioPlayback(): AudioPlayback {
  const ctxRef = useRef<AudioContext | null>(null)
  const nextStartRef = useRef(0)
  const lastSoundAtRef = useRef(0)

  const [hasAudio, setHasAudio] = useState(false)
  const [soundActive, setSoundActive] = useState(false)

  const ensureCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current) return ctxRef.current
    const Ctor: AnyAudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AnyAudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctxRef.current = new Ctor()
    setHasAudio(true)
    return ctxRef.current
  }, [])

  const pushFrame = useCallback((pcm: ArrayBuffer) => {
    const ctx = ensureCtx()
    if (!ctx) return
    // The user reached this view via a click (Start QA), so resume() is allowed if autoplay-suspended.
    if (ctx.state === 'suspended') void ctx.resume()

    const planar = pcmS16ToFloat32Planar(pcm, CHANNELS)
    const frameCount = planar[0]?.length ?? 0
    if (frameCount === 0) return

    // Drive the on/off indicator: mark "sound now" if this frame is audible (stride-sampled for cheapness).
    const ch0 = planar[0]
    for (let i = 0; i < frameCount; i += 16) {
      if (Math.abs(ch0[i]) > SILENCE_THRESHOLD) { lastSoundAtRef.current = performance.now(); break }
    }

    const buffer = ctx.createBuffer(CHANNELS, frameCount, SAMPLE_RATE)
    for (let c = 0; c < CHANNELS; c++) buffer.getChannelData(c).set(planar[c])

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)

    const now = ctx.currentTime
    let start = nextStartRef.current
    // Resync if we've fallen behind (would start in the past) or drifted too far ahead.
    if (start < now + 0.005 || start > now + RESYNC_GAP + JITTER_LEAD) start = now + JITTER_LEAD
    src.start(start)
    nextStartRef.current = start + buffer.duration
  }, [ensureCtx])

  // Poll the "audible recently" window → soundActive. Bounded re-renders (only on transitions).
  useEffect(() => {
    if (!hasAudio) return
    const id = setInterval(() => {
      const active = performance.now() - lastSoundAtRef.current < SOUND_HOLD_MS
      setSoundActive((prev) => (prev === active ? prev : active))
    }, 400)
    return () => clearInterval(id)
  }, [hasAudio])

  useEffect(() => {
    return () => {
      void ctxRef.current?.close()
      ctxRef.current = null
    }
  }, [])

  return { pushFrame, hasAudio, soundActive }
}
