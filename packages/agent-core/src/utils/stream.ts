import { WebSocket } from 'ws'

// Performs the stream:register handshake on an already-created WebSocket.
// Caller is responsible for creating the WebSocket and storing it for cleanup before calling this.
export function registerStreamWs(ws: WebSocket, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'stream:register', sessionId }))
    })

    const onMsg = (data: Buffer) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'stream:registered') {
        ws.off('message', onMsg)
        resolve()
      }
    }
    ws.on('message', onMsg)
    ws.once('error', reject)
  })
}
