export type Platform = 'ios' | 'android'

export type DeviceStatus = 'booted' | 'shutdown' | 'unknown'

export interface Device {
  id: string
  name: string
  platform: Platform
  status: DeviceStatus
}

export interface Point {
  x: number
  y: number
}
