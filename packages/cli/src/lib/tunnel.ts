export interface TunnelPlugin {
  name: string
  setupServer(): Promise<void>
  start(relayPort: number): Promise<{ publicUrl: string }>
  stop(): Promise<void>
}
