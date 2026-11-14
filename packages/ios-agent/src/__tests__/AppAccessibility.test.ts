import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppAccessibility } from '../AppAccessibility'

// App accessibility for a recorded person (P1 of the record-time observation plan): on before the app launches, put
// back from a host marker, since the setting persists on the device and an agent that dies cannot restore it (#1162).
let root: string
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

function setup(device: boolean | null) {
  root = mkdtempSync(join(tmpdir(), 'app-ax-'))
  const state = { value: device }
  const host = {
    readAppAccessibility: vi.fn(async () => state.value),
    writeAppAccessibility: vi.fn(async (_u: string, v: boolean | null) => { state.value = v }),
  }
  return { ax: new AppAccessibility(host, join(root, 'markers')), host, state }
}

describe('AppAccessibility', () => {
  it('turns it on and puts back what the device had, from the marker', async () => {
    for (const before of [false, null]) {
      const { ax, state } = setup(before)
      await ax.enable('UDID-1')
      expect(state.value).toBe(true)
      expect(ax.markedDevices()).toEqual(['UDID-1'])
      await ax.restore('UDID-1')
      expect(state.value).toBe(before)
      expect(ax.markedDevices()).toEqual([])
    }
  })

  it('leaves a device that already had it on alone, and restores nothing there', async () => {
    const { ax, host, state } = setup(true)
    await ax.enable('UDID-1')
    expect(host.writeAppAccessibility).not.toHaveBeenCalled()
    expect(ax.markedDevices()).toEqual([])
    await ax.restore('UDID-1')
    expect(state.value).toBe(true)
  })

  // A second recorded boot reads the device as on — its own doing — and must not take that as the prior value.
  it('keeps the first prior value across repeated enables', async () => {
    const { ax, host, state } = setup(false)
    await ax.enable('UDID-1')
    await ax.enable('UDID-1')
    expect(host.readAppAccessibility).toHaveBeenCalledTimes(1)
    await ax.restore('UDID-1')
    expect(state.value).toBe(false)
  })

  it('writes the marker before turning it on, private, so an agent that dies between them leaves something to undo', async () => {
    const { ax, host } = setup(false)
    host.writeAppAccessibility.mockImplementationOnce(async () => { throw new Error('agent died') })
    await expect(ax.enable('UDID-1')).rejects.toThrow('agent died')
    const marker = join(root, 'markers', 'UDID-1.json')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ prior: false })
    expect(statSync(marker).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'markers')).mode & 0o777).toBe(0o700)
  })

  it('keeps the marker when the restore fails, so the next one tries again', async () => {
    const { ax, host } = setup(false)
    await ax.enable('UDID-1')
    host.writeAppAccessibility.mockImplementationOnce(async () => { throw new Error('device gone') })
    await expect(ax.restore('UDID-1')).rejects.toThrow('device gone')
    expect(ax.markedDevices()).toEqual(['UDID-1'])
  })

  it('removes the key when the marker cannot be read', async () => {
    const { ax, host } = setup(false)
    await ax.enable('UDID-1')
    writeFileSync(join(root, 'markers', 'UDID-1.json'), 'not json')
    await ax.restore('UDID-1')
    expect(host.writeAppAccessibility).toHaveBeenLastCalledWith('UDID-1', null)
    expect(existsSync(join(root, 'markers', 'UDID-1.json'))).toBe(false)
  })

  it('refuses a device id that is not one, rather than naming a file with it', async () => {
    const { ax, host } = setup(false)
    await expect(ax.enable('../../etc/x')).rejects.toThrow('not a device id')
    expect(host.readAppAccessibility).not.toHaveBeenCalled()
  })

  // Correctness review: a shutdown's restore ran while the enable's write was still out, then the late write left the
  // setting on with no marker. One change at a time per device.
  it('puts a restore that arrives during an enable after it, so nothing is left on unmarked', async () => {
    const { ax, host, state } = setup(false)
    let finish!: () => void
    host.writeAppAccessibility.mockImplementationOnce(async (_u: string, v: boolean | null) => { await new Promise<void>((r) => { finish = r }); state.value = v })
    const enabling = ax.enable('UDID-1')
    await vi.waitFor(() => expect(host.writeAppAccessibility).toHaveBeenCalledTimes(1))
    const restoring = ax.restore('UDID-1')
    // Room for a restore that does not wait to write first: the race the order prevents.
    await new Promise((r) => setTimeout(r, 30))
    finish()
    await enabling
    await restoring
    expect(state.value).toBe(false)
    expect(ax.markedDevices()).toEqual([])
  })

  // Privacy review: /private/var/tmp is everyone's; a directory or temporary file another user planted is refused.
  it('refuses a marker directory that is a symlink, and never writes through a file left at the temporary name', async () => {
    const { host } = setup(false)
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(root, 'linked'))
    await expect(new AppAccessibility(host, join(root, 'linked')).enable('UDID-1')).rejects.toThrow('refusing')
    const markers = join(root, 'markers2')
    mkdirSync(markers, { mode: 0o700 })
    const victim = join(root, 'victim')
    writeFileSync(victim, 'keep')
    symlinkSync(victim, join(markers, 'UDID-1.json.tmp'))
    await new AppAccessibility(host, markers).enable('UDID-1')
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(JSON.parse(readFileSync(join(markers, 'UDID-1.json'), 'utf8'))).toEqual({ prior: false })
  })

  it('lists nothing before any marker was written', () => {
    const { ax } = setup(false)
    expect(ax.markedDevices()).toEqual([])
  })
})
