export interface DeviceInfo {
  id: string
  name: string
  platform: string
  status: string
}

export interface SessionInfo {
  sessionId: string
  devices: DeviceInfo[]
}

export interface ChromeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ChromeButton {
  name: string
  accessibilityTitle: string
  anchor: string
  normalOffset: { x: number; y: number }
}

export interface ChromeData {
  bezelPng: string
  bezelWidth: number
  bezelHeight: number
  screenRect: ChromeRect
  buttons: ChromeButton[]
}

export type RelayMessage =
  | { type: 'agents:listed'; sessions: SessionInfo[] }
  | { type: 'session:joined'; sessionId: string }
  | { type: 'session:chrome'; payload: ChromeData }
  | { type: 'stream:frame'; payload: string }
  | { type: 'error'; message: string }
