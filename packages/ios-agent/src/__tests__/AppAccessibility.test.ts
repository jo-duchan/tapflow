import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs'
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

  it('lists nothing before any marker was written', () => {
    const { ax } = setup(false)
    expect(ax.markedDevices()).toEqual([])
  })
})
