import JMuxer from 'jmuxer'
import type { Muxer } from './MSEDecoder'

/**
 * Browser-only jmuxer factory for MSEDecoder. Imports jmuxer (which touches
 * MediaSource), so it is kept out of MSEDecoder itself and only wired in by
 * pickDecoder at runtime — tests inject a mock Muxer instead.
 *
 * flushingTime: 0 flushes the buffer immediately to minimize latency.
 */
export function createJMuxer(video: HTMLVideoElement): Muxer {
  return new JMuxer({
    node: video,
    mode: 'video',
    flushingTime: 0,
    fps: 30,
    debug: false,
  })
}
