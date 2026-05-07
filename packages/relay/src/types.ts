export type MessageType =
  | 'agent:register'
  | 'agent:registered'
  | 'session:start'
  | 'session:joined'
  | 'session:end'
  | 'stream:frame'
  | 'input:tap'
  | 'input:swipe'
  | 'input:type'
  | 'error'

export interface RelayMessage {
  type: MessageType
  sessionId?: string
  payload?: unknown
  message?: string
}
