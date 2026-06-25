import type { DeviceAgent } from './DeviceAgent.js'

// Optional audio-output capability (device → browser), kept OUT of the core
// DeviceAgent interface (ISP): audio capture is platform-asymmetric and opt-in,
// so only agents that can capture audio implement it. Consumers must feature-detect
// with hasAudioCapability() before using it — the video path never depends on this.

export type AudioSampleFormat = 's16' | 'u8'
export type AudioChannels = 'mono' | 'stereo'

export interface AudioFormat {
  sampleRate: number          // e.g. 44100
  channels: AudioChannels
  sampleFormat: AudioSampleFormat
}

export interface AudioFrame {
  payload: Buffer             // raw PCM samples in the stream's AudioFormat (no codec)
  timestamp: number           // capture timestamp, epoch microseconds — for loose A/V sync
}

export interface AudioStreamCapability {
  // The constant PCM format this agent produces (known up front, no await needed).
  audioFormat(): AudioFormat
  // Raw PCM frames. Mirrors DeviceAgent.stream(): a ReadableStream the caller drains.
  audioStream(): ReadableStream<AudioFrame>
}

export function hasAudioCapability(agent: DeviceAgent): agent is DeviceAgent & AudioStreamCapability {
  const a = agent as Partial<AudioStreamCapability>
  return typeof a.audioFormat === 'function' && typeof a.audioStream === 'function'
}
