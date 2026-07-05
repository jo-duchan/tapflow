export type MessageType =
  | 'agent:register'
  | 'agent:registered'
  | 'agent:resources'
  | 'agents:list'
  | 'agents:listed'
  | 'session:start'
  | 'session:joined'
  | 'session:chrome'
  | 'session:deviceInfo'
  | 'session:end'
  | 'session:leave'
  | 'stream:register'
  | 'stream:registered'
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
  | 'open-url'
  | 'open-url:done'
  | 'open-url:error'
  | 'input:touch:start'
  | 'input:touch:move'
  | 'input:touch:end'
  | 'input:pinch:start'
  | 'input:pinch:move'
  | 'input:pinch:end'
  | 'input:key'
  | 'input:type'
  | 'input:button'
  | 'input:rotate'
  | 'input:keyboard:toggle'
  | 'keyboard:toggled'
  | 'screenshot:request'
  | 'screenshot:done'
  | 'screenshot:error'
  | 'ui:tree:request'
  | 'ui:tree:response'
  | 'ui:tree:error'
  | 'error'

import type { AgentResources, UIElement } from '@tapflowio/agent-core'
export type { AgentResources, UIElement }

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  status: string
  osVersion?: string
  sessionId: string
  busy: boolean
}

// agents:listed response groups devices by agent machine
export interface SessionInfo {
  agentName?: string
  platform?: string
  resources?: AgentResources
  devices: DeviceInfo[]
}

export interface RelayMessage {
  type: MessageType
  sessionId?: string
  payload?: unknown
  message?: string
  agentName?: string
  // agent:register: stable per-machine id (macOS IOPlatformUUID). Unique per Mac, unlike agentName
  // (os.hostname() can collide). Absent from older agents → relay falls back to agentName for dedup.
  agentId?: string
  // agent:register: raw device list (without sessionId/busy — added by relay)
  devices?: Array<{ id: string; name: string; platform: string; status: string; osVersion?: string }>
  platform?: string  // agent:register: agent platform ('ios' | 'android')
  // agents:listed: grouped by agent
  sessions?: SessionInfo[]
  // agent:registered: per-device sessionId assignments
  registeredSessions?: Array<{ deviceId: string; sessionId: string }>
  buildId?: number
  resources?: AgentResources
  requestId?: string
  data?: string
  format?: 'png' | 'jpeg'
  // ui:tree:response: unified element schema (normalized 0-1 frames), mapped agent-side
  elements?: UIElement[]
}
