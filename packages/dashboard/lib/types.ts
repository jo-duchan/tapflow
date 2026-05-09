export interface AgentDevice {
  id: string
  name: string
  platform: string
  status: string
}

export interface SessionInfo {
  sessionId: string
  devices: AgentDevice[]
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
  onTop: boolean                            // true = button is above device frame (e.g. home button)
  normalOffset: { x: number; y: number }   // button center at retracted/default position in 2× composite px
  rolloverOffset: { x: number; y: number } // button center at extended/hover position in 2× composite px
  buttonW: number                           // button width in 2× composite px
  buttonH: number                           // button height in 2× composite px
  usagePage: number                         // HID usage page for SimulatorKit injection (0 = unknown)
  usage: number                             // HID usage code (0 = unknown)
  buttonPng?: string                        // base64 PNG of button at 2× (for CSS-animated overlay)
  pressedPng?: string                       // base64 PNG of pressed state (imageDown asset)
  pressedRect?: ChromeRect
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

export interface DeviceInfo {
  deviceName: string
  osVersion: string
}

export type RelayMessage =
  | { type: 'agents:listed'; sessions: SessionInfo[] }
  | { type: 'session:joined'; sessionId: string }
  | { type: 'session:chrome'; payload: ChromeData }
  | { type: 'session:deviceInfo'; payload: DeviceInfo }
  | { type: 'stream:frame'; payload: string; mimeType?: string }
  | { type: 'input:touch:start'; sessionId: string; payload: { x: number; y: number } }
  | { type: 'input:touch:move'; sessionId: string; payload: { x: number; y: number } }
  | { type: 'input:touch:end'; sessionId: string }
  | { type: 'input:button'; sessionId: string; payload: { name: string } }
  | { type: 'input:rotate'; sessionId: string }
  | { type: 'webrtc:offer'; payload: { type: 'offer'; sdp: string } }
  | { type: 'webrtc:ice'; payload: RTCIceCandidateInit }
  | { type: 'error'; message: string }
