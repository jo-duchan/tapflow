export type MessageType =
  | 'agent:register'
  | 'agent:registered'
  | 'agents:list'
  | 'agents:listed'
  | 'session:start'
  | 'session:joined'
  | 'session:chrome'
  | 'session:deviceInfo'
  | 'session:end'
  | 'stream:frame'
  | 'input:touch:start'
  | 'input:touch:move'
  | 'input:touch:end'
  | 'input:pinch:start'
  | 'input:pinch:move'
  | 'input:pinch:end'
  | 'input:type'
  | 'input:button'
  | 'input:rotate'
  | 'webrtc:offer'
  | 'webrtc:answer'
  | 'webrtc:ice'
  | 'error'

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

export interface RelayMessage {
  type: MessageType
  sessionId?: string
  payload?: unknown
  message?: string
  mimeType?: string
  devices?: DeviceInfo[]
  sessions?: SessionInfo[]
}
