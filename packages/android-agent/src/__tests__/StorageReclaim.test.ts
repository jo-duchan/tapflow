import { describe, expect, it } from 'vitest'
import { ValidationError } from '@tapflowio/agent-core'
import { StorageFullError } from '../AdbWrapper.js'
import { LEAN_PACKAGES } from '../LeanPackages.js'
import { BootSupersededError, RETRY_DELAYS_MS, installReclaimingStorage, type ReclaimDevice } from '../StorageReclaim.js'

const [GSA, YT] = LEAN_PACKAGES

/** A package manager that knows which apps are installed and which carry updates under /data/app. */
class FakeDevice implements ReclaimDevice {
  installed = new Set<string>(['android', 'com.google.android.gms', ...LEAN_PACKAGES])
  updated = new Set<string>([GSA, YT, 'com.google.android.gms'])
  rolledBack: string[] = []

  async installedPackages() { return new Set(this.installed) }
  async hasUpdates(pkg: string) {
    if (!this.installed.has(pkg)) throw new Error(`pm path ${pkg}: not installed`)
    return this.updated.has(pkg)
  }
  async uninstallUpdates(pkg: string) {
    this.rolledBack.push(pkg)
    this.updated.delete(pkg)
  }
}

/** An install that answers from a script, one entry per attempt. */
function scriptedInstall(...outcomes: Array<'ok' | 'full' | Error>) {
  const attempts: number[] = []
  const install = async () => {
    attempts.push(attempts.length)
    const next = outcomes[Math.min(attempts.length - 1, outcomes.length - 1)]
    if (next === 'full') throw new StorageFullError()
    if (next instanceof Error) throw next
  }
  return { install, attempts }
}

function recordSleep() {
  const waits: number[] = []
  return { sleep: async (ms: number) => { waits.push(ms) }, waits }
}

describe('installReclaimingStorage', () => {
  it('installs without touching the device when there is room', async () => {
    const device = new FakeDevice()
    const { install, attempts } = scriptedInstall('ok')
    const { sleep, waits } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: true, sleep })).resolves.toEqual([])
    expect(attempts).toHaveLength(1)
    expect(device.rolledBack).toEqual([])
    expect(waits).toEqual([])
  })

  it('passes any other install failure through untouched', async () => {
    const device = new FakeDevice()
    const downgrade = new ValidationError('INSTALL_FAILED_VERSION_DOWNGRADE')
    const { install, attempts } = scriptedInstall(downgrade)
    const { sleep } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: true, sleep })).rejects.toBe(downgrade)
    expect(attempts).toHaveLength(1)
    expect(device.rolledBack).toEqual([])
  })

  it('leaves an emulator tapflow did not launch alone', async () => {
    const device = new FakeDevice()
    const { install, attempts } = scriptedInstall('full', 'ok')
    const { sleep } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: false, sleep })).rejects.toBeInstanceOf(StorageFullError)
    expect(attempts).toHaveLength(1)
    expect(device.rolledBack).toEqual([])
  })

  it('rolls back only Lean packages that carry updates, then installs', async () => {
    const device = new FakeDevice()
    const { install, attempts } = scriptedInstall('full', 'ok')
    const { sleep, waits } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: true, sleep })).resolves.toEqual([GSA, YT])
    // GMS carries updates too and is never touched; YouTube Music is installed but not updated.
    expect(device.rolledBack).toEqual([GSA, YT])
    expect(attempts).toHaveLength(2)
    expect(waits).toEqual([RETRY_DELAYS_MS[0]])
  })

  it('skips a Lean package the image does not have', async () => {
    const device = new FakeDevice()
    device.installed.delete(YT)
    device.updated.delete(YT)
    const { install } = scriptedInstall('full', 'ok')
    const { sleep } = recordSleep()
    await installReclaimingStorage({ install, device, owned: true, sleep })
    expect(device.rolledBack).toEqual([GSA])
  })

  it('does not retry when there is nothing left to roll back', async () => {
    const device = new FakeDevice()
    device.updated = new Set(['com.google.android.gms'])
    const { install, attempts } = scriptedInstall('full', 'ok')
    const { sleep, waits } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: true, sleep })).rejects.toBeInstanceOf(StorageFullError)
    expect(attempts).toHaveLength(1)
    expect(waits).toEqual([])
  })

  // Space comes back asynchronously: measured on API 35, part at once and the rest ~5.5s later.
  it('keeps retrying while the freed space arrives', async () => {
    const device = new FakeDevice()
    const { install, attempts } = scriptedInstall('full', 'full', 'full', 'ok')
    const { sleep, waits } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: true, sleep })).resolves.toEqual([GSA, YT])
    expect(attempts).toHaveLength(4)
    expect(waits).toEqual(RETRY_DELAYS_MS)
  })

  it('gives up with the storage error once the retries are spent', async () => {
    const device = new FakeDevice()
    const { install, attempts } = scriptedInstall('full')
    const { sleep } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: true, sleep })).rejects.toBeInstanceOf(StorageFullError)
    expect(attempts).toHaveLength(1 + RETRY_DELAYS_MS.length)
  })

  it('stops retrying on a failure that is not about space', async () => {
    const device = new FakeDevice()
    const downgrade = new ValidationError('INSTALL_FAILED_VERSION_DOWNGRADE')
    const { install, attempts } = scriptedInstall('full', downgrade, 'ok')
    const { sleep } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: true, sleep })).rejects.toBe(downgrade)
    expect(attempts).toHaveLength(2)
  })

  // Mutation: let one package's failure abort the loop, and the first rollback's space goes unused.
  it('uses what was freed when a later package fails to roll back', async () => {
    const device = new FakeDevice()
    const real = device.uninstallUpdates.bind(device)
    device.uninstallUpdates = async (pkg: string) => {
      if (pkg === YT) throw new Error("Couldn't uninstall package")
      await real(pkg)
    }
    const { install, attempts } = scriptedInstall('full', 'ok')
    const { sleep } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: true, sleep })).resolves.toEqual([GSA])
    expect(attempts).toHaveLength(2)
  })

  it('keeps the storage error when every rollback fails', async () => {
    const device = new FakeDevice()
    device.uninstallUpdates = async () => { throw new Error("Couldn't uninstall package") }
    const { install, attempts } = scriptedInstall('full', 'ok')
    const { sleep } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: true, sleep })).rejects.toBeInstanceOf(StorageFullError)
    expect(attempts).toHaveLength(1)
  })

  // After a rollback already succeeded, so that swallowing the supersede would show up as a retry.
  // Mutation: treat BootSupersededError like any other per-package failure.
  it('stops at a superseded boot without retrying, even after a rollback', async () => {
    const device = new FakeDevice()
    const real = device.uninstallUpdates.bind(device)
    device.uninstallUpdates = async (pkg: string) => {
      if (pkg === YT) throw new BootSupersededError()
      await real(pkg)
    }
    const { install, attempts } = scriptedInstall('full', 'ok')
    const { sleep } = recordSleep()
    await expect(installReclaimingStorage({ install, device, owned: true, sleep })).rejects.toBeInstanceOf(StorageFullError)
    expect(device.rolledBack).toEqual([GSA])
    expect(attempts).toHaveLength(1)
  })
})

describe('StorageFullError', () => {
  it('is a ValidationError, so the install reply is unchanged', () => {
    const e = new StorageFullError()
    expect(e).toBeInstanceOf(ValidationError)
    expect(e.message).toMatch(/^Device storage is full/)
  })
})

describe('LEAN_PACKAGES', () => {
  // Kept beside the list it is scoped to: nothing here may ever reach GMS, WebView or Play Store.
  it('never names a package an app under test depends on', () => {
    for (const pkg of ['com.google.android.gms', 'com.google.android.webview', 'com.android.vending']) {
      expect(LEAN_PACKAGES as readonly string[]).not.toContain(pkg)
    }
  })
})
