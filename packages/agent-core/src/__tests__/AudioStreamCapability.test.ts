import { describe, it, expect } from 'vitest'
import { hasAudioCapability } from '../AudioStreamCapability'
import type { AudioStreamCapability, AudioFormat, AudioFrame } from '../AudioStreamCapability'
import type { DeviceAgent } from '../DeviceAgent'
import type { Device } from '../types'

// A minimal video-only agent: implements DeviceAgent but NOT AudioStreamCapability.
class VideoOnlyAgent implements DeviceAgent {
  listDevices(): Promise<Device[]> { return Promise.resolve([]) }
  boot(_deviceId: string): Promise<void> { return Promise.resolve() }
  shutdown(_deviceId: string): Promise<void> { return Promise.resolve() }
  installApp(_path: string): Promise<void> { return Promise.resolve() }
  launchApp(_bundleId: string): Promise<void> { return Promise.resolve() }
  screenshot(): Promise<Buffer> { return Promise.resolve(Buffer.alloc(0)) }
  stream(): ReadableStream<Buffer> { return new ReadableStream() }
  touchStart(_x: number, _y: number): void {}
  touchMove(_x: number, _y: number): Promise<void> { return Promise.resolve() }
  touchEnd(): Promise<void> { return Promise.resolve() }
  openUrl(_url: string): Promise<void> { return Promise.resolve() }
}

// An audio-capable agent: DeviceAgent + AudioStreamCapability.
class AudioAgent extends VideoOnlyAgent implements AudioStreamCapability {
  audioFormat(): AudioFormat {
    return { sampleRate: 44100, channels: 'stereo', sampleFormat: 's16' }
  }
  audioStream(): ReadableStream<AudioFrame> {
    return new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue({ payload: Buffer.from([1, 2, 3, 4]), timestamp: 1000 })
        controller.close()
      },
    })
  }
}

describe('AudioStreamCapability', () => {
  it('hasAudioCapability is false for a video-only agent', () => {
    const agent = new VideoOnlyAgent()
    expect(hasAudioCapability(agent)).toBe(false)
  })

  it('hasAudioCapability narrows an audio-capable agent', () => {
    const agent: DeviceAgent = new AudioAgent()
    expect(hasAudioCapability(agent)).toBe(true)
    if (hasAudioCapability(agent)) {
      // type narrowing: these calls must typecheck without casts
      const fmt = agent.audioFormat()
      expect(fmt).toEqual({ sampleRate: 44100, channels: 'stereo', sampleFormat: 's16' })
    }
  })

  it('is false when audioStream is missing even if audioFormat exists', () => {
    const partial = { audioFormat: () => ({ sampleRate: 44100, channels: 'stereo', sampleFormat: 's16' }) }
    expect(hasAudioCapability(partial as unknown as DeviceAgent)).toBe(false)
  })

  it('audioStream yields AudioFrames with PCM payload and timestamp', async () => {
    const agent = new AudioAgent()
    const reader = agent.audioStream().getReader()
    const { value, done } = await reader.read()
    expect(done).toBe(false)
    expect(value?.payload).toBeInstanceOf(Buffer)
    expect(value?.timestamp).toBe(1000)
  })
})
