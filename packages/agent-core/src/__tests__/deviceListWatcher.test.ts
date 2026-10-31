import { describe, it, expect, vi } from 'vitest'
import type { DeviceReport } from '@tapflowio/protocol'
import { DeviceListWatcher } from '../utils/deviceListWatcher'

const A: DeviceReport = { id: 'a', name: 'iPhone A', platform: 'ios', status: 'shutdown', osVersion: 'iOS 26.5' }
const B: DeviceReport = { id: 'b', name: 'iPhone B', platform: 'ios', status: 'shutdown', osVersion: 'iOS 18.6' }

/** A watcher whose reads return the queued lists in order, and the lists it sent. */
function setup(baseline: DeviceReport[], ...reads: Array<DeviceReport[] | Error>) {
  const sent: DeviceReport[][] = []
  const onReadError = vi.fn()
  const watcher = new DeviceListWatcher({
    read: () => {
      const next = reads.shift()
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? [])
    },
    send: (devices) => sent.push(devices),
    onReadError,
    intervalMs: 60_000,
  })
  watcher.start(baseline)
  return { watcher, sent, onReadError }
}

describe('DeviceListWatcher (#1085)', () => {
  it('sends nothing while the list is the one registered', async () => {
    const { watcher, sent } = setup([A], [A], [A])
    await watcher.tick()
    await watcher.tick()
    expect(sent).toEqual([])
    watcher.stop()
  })

  it('sends a device that appeared on the first read', async () => {
    const { watcher, sent } = setup([A], [A, B])
    await watcher.tick()
    expect(sent).toEqual([[A, B]])
    watcher.stop()
  })

  it('sends a rename, and a form factor or version that changed', async () => {
    const { watcher, sent } = setup([A], [{ ...A, name: 'Renamed' }], [{ ...A, name: 'Renamed', osVersion: 'iOS 27.0' }])
    await watcher.tick()
    await watcher.tick()
    expect(sent.map((l) => [l[0]!.name, l[0]!.osVersion])).toEqual([['Renamed', 'iOS 26.5'], ['Renamed', 'iOS 27.0']])
    watcher.stop()
  })

  // The relay tracks these itself; a read in between must not look like news.
  it('ignores status and service tier', async () => {
    const { watcher, sent } = setup([A], [{ ...A, status: 'booted', serviceTier: 'unsupported' }])
    await watcher.tick()
    expect(sent).toEqual([])
    watcher.stop()
  })

  // An Android emulator that is not running reports no version.
  it('does not treat a version going missing as a change, then or later', async () => {
    const noVersion = { ...A, osVersion: undefined }
    const { watcher, sent } = setup([A], [noVersion], [noVersion, B], [noVersion, B])
    await watcher.tick()
    expect(sent).toEqual([])
    await watcher.tick()
    await watcher.tick()
    expect(sent).toEqual([[noVersion, B]])
    watcher.stop()
  })

  // Sent without its version for another reason, then running again with the same one: the relay kept it all along.
  it('does not send a version coming back to what it was', async () => {
    const noVersion = { ...A, osVersion: undefined }
    const { watcher, sent } = setup([A], [noVersion, B], [A, B])
    await watcher.tick()
    await watcher.tick()
    expect(sent).toEqual([[noVersion, B]])
    watcher.stop()
  })

  it('removes a device only on the second read in a row without it', async () => {
    const { watcher, sent } = setup([A, B], [A], [A])
    await watcher.tick()
    expect(sent).toEqual([])
    await watcher.tick()
    expect(sent).toEqual([[A]])
    watcher.stop()
  })

  it('keeps a device that was missing from one read only', async () => {
    const { watcher, sent } = setup([A, B], [A], [A, B], [A])
    await watcher.tick()
    await watcher.tick()
    // Missing again, but not twice in a row since it came back.
    await watcher.tick()
    expect(sent).toEqual([])
    watcher.stop()
  })

  it('sends nothing for a read that failed, and says why', async () => {
    const { watcher, sent, onReadError } = setup([A, B], new Error('simctl wedged'), [A, B])
    await watcher.tick()
    await watcher.tick()
    expect(sent).toEqual([])
    expect(onReadError).toHaveBeenCalledWith(expect.objectContaining({ message: 'simctl wedged' }))
    watcher.stop()
  })

  it('runs one read at a time', async () => {
    let release!: (l: DeviceReport[]) => void
    const read = vi.fn(() => new Promise<DeviceReport[]>((r) => { release = r }))
    const watcher = new DeviceListWatcher({ read, send: () => {}, intervalMs: 60_000 })
    watcher.start([A])
    const first = watcher.tick()
    await watcher.tick()
    expect(read).toHaveBeenCalledTimes(1)
    release([A])
    await first
    watcher.stop()
  })

  // A read that outlives its connection belongs to no relay: the next connection starts from its own register.
  it('drops a read that finished after a stop', async () => {
    let release!: (l: DeviceReport[]) => void
    const send = vi.fn()
    const watcher = new DeviceListWatcher({ read: () => new Promise((r) => { release = r }), send, intervalMs: 60_000 })
    watcher.start([A])
    const pending = watcher.tick()
    watcher.stop()
    watcher.start([A])
    release([A, B])
    await pending
    expect(send).not.toHaveBeenCalled()
    watcher.stop()
  })

  // A read wedged on CoreSimulator holds back the next connection's reads too, rather than gaining a sibling per
  // reconnect; its result still belongs to no one.
  it('starts no second read across a reconnect while one is pending', async () => {
    let release!: (l: DeviceReport[]) => void
    const read = vi.fn(() => new Promise<DeviceReport[]>((r) => { release = r }))
    const send = vi.fn()
    const watcher = new DeviceListWatcher({ read, send, intervalMs: 60_000 })
    watcher.start([A])
    const pending = watcher.tick()
    watcher.stop()
    watcher.start([A])
    await watcher.tick()
    expect(read).toHaveBeenCalledTimes(1)
    release([A, B])
    await pending
    expect(send).not.toHaveBeenCalled()
    const next = watcher.tick()
    expect(read).toHaveBeenCalledTimes(2)
    release([A])
    await next
    watcher.stop()
  })

  it('does nothing once stopped', async () => {
    const { watcher, sent } = setup([A], [A, B])
    watcher.stop()
    await watcher.tick()
    expect(sent).toEqual([])
  })

  it('reads on its interval', async () => {
    vi.useFakeTimers()
    try {
      const read = vi.fn(() => Promise.resolve([A]))
      const watcher = new DeviceListWatcher({ read, send: () => {}, intervalMs: 30_000 })
      watcher.start([A])
      await vi.advanceTimersByTimeAsync(29_999)
      expect(read).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(read).toHaveBeenCalledTimes(1)
      watcher.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
