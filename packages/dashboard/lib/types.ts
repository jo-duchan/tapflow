export interface AgentDevice {
  id: string
  name: string
  platform: string
  status: string
  osVersion?: string
  sessionId: string
  busy: boolean
}

export interface Comment {
  id: number
  author: string
  authorAvatarUrl: string | null
  body: string
  created_at: string
  attachments: CommentAttachment[]
}

export interface CommentAttachment {
  id: number
  file_path: string
  mime: string
}

export interface SessionInfo {
  agentName?: string
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

export interface Recording {
  id: number
  url: string
  sessionId: string | null
  fileSize: number
  mime: string
  createdAt: string
  expiresAt: string
}

export interface App {
  id: number
  name: string
  bundle_id_key: string
  platform: 'ios' | 'android' | 'both'
  latest_build_id: number | null
  version_name: string | null
  build_number: string | null
  status_label: string | null
  latest_uploaded_at: string | null
}

export interface Build {
  id: number
  app_id: number
  name: string
  version_name: string | null
  build_number: string | null
  version_label: string | null
  status_label: 'Backlog' | 'In Progress' | 'Done' | 'Rejected' | null
  platform: 'ios' | 'android'
  bundle_id: string | null
  uploaded_at: string
  uploader: string | null
}

export interface ReleaseGroup {
  versionName: string
  builds: Build[]
}

export type RelayMessage =
  | { type: 'agents:listed'; sessions: SessionInfo[] }
  | { type: 'session:joined'; sessionId: string }
  | { type: 'session:chrome'; payload: ChromeData }
  | { type: 'session:deviceInfo'; payload: DeviceInfo }
  | { type: 'device:boot'; sessionId: string; payload: { deviceId: string } }
  | { type: 'device:booting' }
  | { type: 'device:ready'; payload: { deviceId: string } }
  | { type: 'device:boot-error'; message: string }
  | { type: 'device:shutdown'; sessionId: string; payload: { deviceId: string } }
  | { type: 'device:shutdown-done'; payload: { deviceId: string } }
  | { type: 'input:touch:start'; sessionId: string; payload: { x: number; y: number } }
  | { type: 'input:touch:move'; sessionId: string; payload: { x: number; y: number } }
  | { type: 'input:touch:end'; sessionId: string }
  | { type: 'input:pinch:start'; sessionId: string; payload: { f0: { x: number; y: number }; f1: { x: number; y: number } } }
  | { type: 'input:pinch:move'; sessionId: string; payload: { f0: { x: number; y: number }; f1: { x: number; y: number } } }
  | { type: 'input:pinch:end'; sessionId: string }
  | { type: 'input:key'; sessionId: string; payload: { key: string } }
  | { type: 'input:type'; sessionId: string; payload: { text: string } }
  | { type: 'input:button'; sessionId: string; payload: { name: string } }
  | { type: 'input:rotate'; sessionId: string }
  | { type: 'input:keyboard:toggle'; sessionId: string }
  | { type: 'app:install-done' }
  | { type: 'app:install-error'; message: string }
  | { type: 'app:launch-done' }
  | { type: 'app:launch-error'; message: string }
  | { type: 'error'; message: string }
