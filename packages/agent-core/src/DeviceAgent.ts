import type { Device, Point } from './types'

export interface DeviceAgent {
  listDevices(): Promise<Device[]>
  boot(deviceId: string): Promise<void>
  shutdown(deviceId: string): Promise<void>
  installApp(path: string): Promise<void>
  launchApp(bundleId: string): Promise<void>
  screenshot(): Promise<Buffer>
  stream(): ReadableStream
  tap(x: number, y: number): Promise<void>
  swipe(from: Point, to: Point): Promise<void>
  type(text: string): Promise<void>
}

export type DeviceAgentConstructor = new () => DeviceAgent
