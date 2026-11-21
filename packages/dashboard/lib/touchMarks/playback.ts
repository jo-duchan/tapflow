import type { MachineTouch } from './model'

/**
 * A recording's playback position, for what draws over it: read when it draws, told when it moves. The player moves it
 * every frame it plays and on every seek; nothing here re-renders, so the device screen under the marks stays as it is
 * (the run player keeps it from re-rendering per frame — design review of #1205's follow-up).
 */
export class PlaybackClock {
  private ms: number
  private readonly listeners = new Set<() => void>()

  constructor(ms = 0) { this.ms = ms }

  now(): number { return this.ms }

  set(ms: number): void {
    this.ms = ms
    for (const l of this.listeners) l()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/** A recording's touches and where its playback is: a layer draws what `timelineState` says at the clock's time. */
export interface TouchTimeline { touches: readonly MachineTouch[]; clock: PlaybackClock }
