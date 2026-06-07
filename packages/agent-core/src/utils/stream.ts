import { WebSocket } from 'ws'
import type { Logger } from '../logger.js'

export const DEFAULT_BACKPRESSURE_BYTES = 1_048_576 // 1 MB

/** Disable Nagle on a ws client's TCP socket so small writes (touch, frame tails) aren't held
 *  waiting for an ACK — negligible on localhost, but ~40ms stalls on LAN. Safe to call after open. */
export function disableNagle(ws: WebSocket): void {
  const sock = (ws as unknown as { _socket?: { setNoDelay?(b: boolean): void } })._socket
  sock?.setNoDelay?.(true)
}

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

export interface KeyframeAwareSender {
  /**
   * Sends `frame`, or drops it to keep the H.264 reference chain intact.
   * `isKeyframe` must be true for IDR frames and for independent frames (JPEG).
   * Returns true if sent, false if dropped.
   */
  send(
    ws: WebSocket,
    frame: Parameters<WebSocket['send']>[0],
    threshold: number,
    isKeyframe: boolean,
    onDrop: () => void,
    /** Fired while dropping when the socket has room but no keyframe has arrived —
     *  the moment to request an on-demand IDR to resync faster. */
    onWantKeyframe?: () => void,
  ): boolean
}

/**
 * Stateful, keyframe-aware backpressure sender (one per session/stream).
 *
 * Unlike sendBinaryWithBackpressure (drop-to-latest, fine for independent JPEG
 * frames), this preserves the H.264 reference chain: once a frame is dropped under
 * backpressure it enters a "dropping" state and discards every frame until a keyframe
 * (IDR) can be sent — so the decoder never receives a P-frame that references a
 * dropped frame, which would tear until the next IDR. Independent frames (JPEG) pass
 * isKeyframe=true every frame, reproducing drop-to-latest exactly.
 */
export function createKeyframeAwareSender(): KeyframeAwareSender {
  let dropping = false
  return {
    send(ws, frame, threshold, isKeyframe, onDrop, onWantKeyframe) {
      if (ws.readyState !== WebSocket.OPEN) return false
      const full = ws.bufferedAmount >= threshold

      if (dropping) {
        // Resync only on a keyframe we can actually send; otherwise keep dropping.
        if (isKeyframe && !full) {
          dropping = false
          ws.send(frame, { binary: true })
          return true
        }
        onDrop()
        // Buffer drained but still no keyframe — ask the source for an IDR to resync.
        if (!full) onWantKeyframe?.()
        return false
      }

      if (full) {
        // Drop this frame and stop forwarding until the next sendable keyframe.
        dropping = true
        onDrop()
        return false
      }

      ws.send(frame, { binary: true })
      return true
    },
  }
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
      disableNagle(ws) // stream socket carries the video frames — keep it un-delayed on LAN
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
