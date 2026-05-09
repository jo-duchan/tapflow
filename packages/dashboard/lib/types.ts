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
  framePng: string         // full composite PDF at 2× — device frame visible, screen hole transparent
  bezelWidth: number
  bezelHeight: number
  compositeWidth: number   // full PDF width including devicePadding, at 2× px
  compositeHeight: number  // full PDF height including devicePadding, at 2× px
  padding: { left: number; right: number; top: number; bottom: number }
  screenRect: ChromeRect
  screenCornerRadius: number  // screen corner radius in 2× px (0 if device has no rounded corners)
  logicalWidth: number
  logicalHeight: number
  buttons: ChromeButton[]
}

export type RelayMessage =
  | { type: 'agents:listed'; sessions: SessionInfo[] }
  | { type: 'session:joined'; sessionId: string }
  | { type: 'session:chrome'; payload: ChromeData }
  | { type: 'stream:frame'; payload: string; mimeType?: string }
  | { type: 'input:touch:start'; sessionId: string; payload: { x: number; y: number } }
  | { type: 'input:touch:move'; sessionId: string; payload: { x: number; y: number } }
  | { type: 'input:touch:end'; sessionId: string }
  | { type: 'input:button'; sessionId: string; payload: { name: string } }
  | { type: 'webrtc:offer'; payload: { type: 'offer'; sdp: string } }
  | { type: 'webrtc:ice'; payload: RTCIceCandidateInit }
  | { type: 'error'; message: string }
