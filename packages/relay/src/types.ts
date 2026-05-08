export type MessageType =
  | 'agent:register'
  | 'agent:registered'
  | 'agents:list'
  | 'agents:listed'
  | 'session:start'
  | 'session:joined'
  | 'session:chrome'
  | 'session:end'
  | 'stream:frame'
  | 'input:tap'
  | 'input:swipe'
  | 'input:type'
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
  devices?: DeviceInfo[]
  sessions?: SessionInfo[]
}
