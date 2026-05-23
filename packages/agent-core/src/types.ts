export type Platform = string

export type DeviceStatus = 'booted' | 'shutdown' | 'unknown'

export interface Device {
  id: string
  name: string
  platform: Platform
  status: DeviceStatus
  typeId?: string     // platform device type identifier (iOS: com.apple.CoreSimulator.SimDeviceType.*)
  osVersion?: string  // e.g. "iOS 18.3"
}

export interface Point {
  x: number
  y: number
}

export interface AgentResources {
  cpuPercent: number
  memUsedMB: number
  memTotalMB: number
  slotsAvailable: number
  slotsTotal: number
  reportedAt: number  // Date.now()
}

// Android physical button descriptor sent via session:chrome payload
export interface AndroidButton {
  name: string
  accessibilityTitle: string
  keyCode: number
}
