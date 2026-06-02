import { WebSocket } from 'ws'
import type { Logger } from '../logger.js'

export const DEFAULT_BACKPRESSURE_BYTES = 1_048_576 // 1 MB

// Returns true if the frame was sent, false if it was dropped (backpressure or closed socket).
export function sendBinaryWithBackpressure(
  ws: WebSocket,
  data: Parameters<WebSocket['send']>[0],
  threshold: number,
  onDrop: () => void,
): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false
  if (ws.bufferedAmount >= threshold) {
    onDrop()
    return false
  }
  ws.send(data, { binary: true })
  return true
}

// Returns a rate-limited warn callback for use as onDrop.
// At most one warn per intervalMs per call site; resets the drop counter after each warn.
export function createRateLimitedDropWarn(
  logger: Logger,
  context: string,
  intervalMs = 1000,
): () => void {
  let lastWarnAt = 0
  let dropCount = 0
  return () => {
    dropCount++
    const now = Date.now()
    if (now - lastWarnAt >= intervalMs) {
      lastWarnAt = now
      logger.warn(`ws backpressure: ${dropCount} frame(s) dropped [${context}]`)
      dropCount = 0
    }
  }
}

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
