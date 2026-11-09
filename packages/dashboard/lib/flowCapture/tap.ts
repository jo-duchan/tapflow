import type { AndroidChrome, BrowserInbound, BrowserToRelay, ChromeData, PosturesPayload } from '@tapflowio/protocol'

/**
 * What the device viewer hands Flow Capture's dialog (#1125): its socket, what the relay has said about the session,
 * and the decoded picture. **Types only, and no flow-runner import**: the viewer imports this file, and anything it
 * imports is downloaded with every QA session whether or not anyone captures — the channel built on it lives in the
 * dialog's own chunk.
 */
export interface CaptureTap {
  sessionId: string
  platform: string
  buildId: number
  /** `false` when the socket is not open and the message was dropped. */
  send(msg: BrowserToRelay): boolean
  /** Every message for this session, before the viewer's own handling returns early on a lifecycle frame. */
  subscribe(handler: (msg: BrowserInbound) => void): () => void
  /** The socket closed: called at that moment, not a render later. */
  onConnectionLost(handler: () => void): () => void
  connected(): boolean
  /** What the relay sent at the join and the boot, which a channel opened later would otherwise wait for in vain. */
  chrome(): ChromeData | AndroidChrome | null
  postures(): PosturesPayload
  /** The decoded frame the viewer draws, for the dialog to show the replay on; `null` before the first frame. */
  surface(): CanvasImageSource | null
}
