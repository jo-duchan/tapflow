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

// Closed role vocabulary shared by all platforms. Unmappable native roles
// become 'other'; the platform-native string is preserved in rawRole.
export type UIElementRole =
  | 'button'
  | 'text'
  | 'input'
  | 'image'
  | 'checkbox'
  | 'switch'
  | 'slider'
  | 'list'
  | 'cell'
  | 'tab'
  | 'other'

// Normalized to 0-1 in the same coordinate space the touch input path
// consumes, so a frame center can be fed straight into tap without conversion.
export interface UIElementFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface UIElement {
  role: UIElementRole
  label: string
  identifier?: string
  frame: UIElementFrame
  enabled: boolean
  rawRole?: string
}
