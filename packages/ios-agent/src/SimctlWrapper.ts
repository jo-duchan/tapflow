import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import type { Device, DeviceStatus } from '@tapflow/agent-core'
import { defaultRunner, type SimctlRunner } from './simctl'

interface SimctlDevice {
  udid: string
  name: string
  state: string
  isAvailable: boolean
  deviceTypeIdentifier?: string
}

interface SimctlListOutput {
  devices: Record<string, SimctlDevice[]>
}

function toDeviceStatus(state: string): DeviceStatus {
  if (state === 'Booted') return 'booted'
  if (state === 'Shutdown') return 'shutdown'
  return 'unknown'
}

export class SimctlWrapper {
  constructor(private readonly runner: SimctlRunner = defaultRunner) {}

  async listDevices(): Promise<Device[]> {
    const output = await this.runner.exec('list', 'devices', '--json')
    const parsed: SimctlListOutput = JSON.parse(output)
    const devices: Device[] = []

    for (const runtimeDevices of Object.values(parsed.devices)) {
      for (const d of runtimeDevices) {
        if (!d.isAvailable) continue
        devices.push({
          id: d.udid,
          name: d.name,
          platform: 'ios',
          status: toDeviceStatus(d.state),
          typeId: d.deviceTypeIdentifier,
        })
      }
    }

    return devices
  }

  async boot(deviceId: string): Promise<void> {
    try {
      await this.runner.exec('boot', deviceId)
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr ?? ''
      // already booted is not an error
      if (stderr.includes('Unable to boot device in current state: Booted')) return
      throw err
    }
  }

  async shutdown(deviceId: string): Promise<void> {
    await this.runner.exec('shutdown', deviceId)
  }

  async installApp(appPath: string): Promise<void> {
    await this.runner.exec('install', 'booted', appPath)
  }

  async launchApp(bundleId: string): Promise<void> {
    await this.runner.exec('launch', 'booted', bundleId)
  }

  async screenshot(): Promise<Buffer> {
    const tmpPath = `${tmpdir()}/tapflow-${randomUUID()}.png`
    try {
      await this.runner.exec('io', 'booted', 'screenshot', tmpPath)
      return await fs.readFile(tmpPath)
    } finally {
      await fs.unlink(tmpPath).catch(() => {})
    }
  }
}
