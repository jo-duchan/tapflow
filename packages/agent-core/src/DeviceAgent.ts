import type { Device } from './types.js'

export interface DeviceAgent {
  listDevices(): Promise<Device[]>
  boot(deviceId: string): Promise<void>
  shutdown(deviceId: string): Promise<void>
  installApp(path: string): Promise<void>
  launchApp(bundleId: string): Promise<void>
  screenshot(): Promise<Buffer>
  stream(): ReadableStream
  touchStart(x: number, y: number): void
  touchMove(x: number, y: number): Promise<void>
  touchEnd(): Promise<void>
  type(text: string): Promise<void>
  pressKey(key: string): Promise<void>
  startRecording(deviceId: string): Promise<void>
  stopRecording(deviceId: string): Promise<string>
}

export type DeviceAgentConstructor = new () => DeviceAgent
