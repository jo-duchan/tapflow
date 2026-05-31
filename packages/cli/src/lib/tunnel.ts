export interface TunnelPlugin {
  name: string
  start(relayPort: number): Promise<{ publicUrl: string }>
  stop(): Promise<void>
}
