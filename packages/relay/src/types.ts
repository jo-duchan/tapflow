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
  | 'device:boot'
  | 'device:booting'
  | 'device:ready'
  | 'device:boot-error'
  | 'device:shutdown'
  | 'device:shutdown-done'
  | 'app:install'
  | 'app:install-done'
  | 'app:install-error'
  | 'app:launch'
  | 'app:launch-done'
  | 'app:launch-error'
  | 'input:touch:start'
  | 'input:touch:move'
  | 'input:touch:end'
  | 'input:pinch:start'
  | 'input:pinch:move'
  | 'input:pinch:end'
  | 'input:type'
  | 'input:button'
  | 'input:rotate'
  | 'error'

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  status: string
}

export interface SessionInfo {
  sessionId: string
  agentName?: string
  busy: boolean
  devices: DeviceInfo[]
}

export interface RelayMessage {
  type: MessageType
  sessionId?: string
  payload?: unknown
  message?: string
  agentName?: string
  devices?: DeviceInfo[]
  sessions?: SessionInfo[]
  buildId?: number
}
