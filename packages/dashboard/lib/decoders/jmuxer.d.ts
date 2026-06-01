// jmuxer ships no type definitions (package.json "types": none).
// Minimal ambient declaration covering the subset MSEDecoder uses.
declare module 'jmuxer' {
  interface JMuxerOptions {
    node: HTMLElement | string
    mode?: 'both' | 'audio' | 'video'
    flushingTime?: number
    fps?: number
    clearBuffer?: boolean
    debug?: boolean
    onReady?: () => void
    onError?: (error: unknown) => void
  }

  interface JMuxerFeed {
    video?: Uint8Array
    audio?: Uint8Array
    duration?: number
  }

  export default class JMuxer {
    constructor(options: JMuxerOptions)
    feed(data: JMuxerFeed): void
    destroy(): void
  }
}
