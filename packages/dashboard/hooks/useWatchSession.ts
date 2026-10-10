import { useCallback, useEffect, useRef, useState } from 'react'
import type { WatchEndReason, WatchRefusal } from '@tapflowio/protocol'
import { useRelay } from '@/hooks/useRelay'
import { CODEC_AUDIO, HEADER_SIZE, parseEnvelopeHeader, type BinaryFrameHandler } from '@/lib/envelope'
import type { BrowserInbound, ChromePayload, DeviceSummary, PosturesPayload } from '@/lib/types'

/** Where a watch stands, as the page says it. */
export type WatchPhase =
  | { kind: 'connecting' }
  | { kind: 'watching' }
  | { kind: 'refused'; reason: WatchRefusal }
  | { kind: 'ended'; reason: WatchEndReason }

/**
 * **Watch, read-only, a session an AI client is driving.** The whole of what a watch page knows about the
 * session, from one socket of its own.
 *
 * **It sends `watch:start` and nothing else that names the session** — never `session:start`, `device:boot`
 * or `device:shutdown`, and it does not use `useAgentSession`, which shuts the device down on unmount. A
 * watch page closing must not end what the agent is in the middle of. The relay refuses those from a
 * watching socket anyway; this is the half that does not depend on it.
 *
 * `watch:start` goes again on every reconnect: a new socket is a new watcher to the relay.
 */
export function useWatchSession(sessionId: string) {
  const [phase, setPhase] = useState<WatchPhase>({ kind: 'connecting' })
  const [chrome, setChrome] = useState<ChromePayload | null>(null)
  const [postures, setPostures] = useState<PosturesPayload | undefined>(undefined)
  const [deviceReady, setDeviceReady] = useState(false)
  const [holderLeft, setHolderLeft] = useState(false)
  const [agentAway, setAgentAway] = useState(false)
  /** The device as the list describes it — name, platform, who is driving. Kept when a later listing
   *  leaves it out (an agent reconnecting), so the page does not lose its title for a few seconds. */
  const [device, setDevice] = useState<DeviceSummary | null>(null)
  const binaryFrameHandlerRef = useRef<BinaryFrameHandler | undefined>(undefined)

  const handleMessage = useCallback((msg: BrowserInbound) => {
    // The relay's `device:ready` replay carries no `sessionId`; everything else names one.
    if (msg.type === 'agents:listed') {
      const found = msg.sessions.flatMap((s) => s.devices).find((d) => d.sessionId === sessionId)
      if (found) setDevice(found)
      // The relay says nothing when the same client re-joins after a drop, and a device already booted sends
      // no chrome or ready. The listing names an AI holder only while one is live, so it is the signal.
      if (found?.holder) setHolderLeft(false)
      return
    }
    if ('sessionId' in msg && msg.sessionId !== undefined && msg.sessionId !== sessionId) return
    if (msg.type === 'watch:started') setPhase({ kind: 'watching' })
    else if (msg.type === 'watch:refused') setPhase({ kind: 'refused', reason: msg.reason })
    else if (msg.type === 'watch:ended') setPhase({ kind: 'ended', reason: msg.reason })
    else if (msg.type === 'watch:holder-left') setHolderLeft(true)
    else if (msg.type === 'session:agent-away') setAgentAway(true)
    else if (msg.type === 'session:rebound') { setAgentAway(false); setDeviceReady(false) }
    // Neither of these says the holder is back: a foldable re-sends its chrome on a screen change, and the
    // device stays booted while the holder is away. Only the listing does — see `agents:listed` above.
    else if (msg.type === 'session:chrome') setChrome(msg.payload)
    else if (msg.type === 'device:postures') setPostures(msg.payload)
    else if (msg.type === 'device:booting') { setChrome(null); setPostures(undefined); setDeviceReady(false); setAgentAway(false) }
    else if (msg.type === 'device:ready') { setDeviceReady(true); setAgentAway(false) }
  }, [sessionId])

  // Video only. The relay sends watchers no audio; an envelope that says audio is dropped here too, so a
  // relay that ever did would not start playing sound in a tab that never asked for it.
  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    const envelope = parseEnvelopeHeader(data)
    if (envelope?.codec === CODEC_AUDIO) return
    const payload = envelope ? data.slice(HEADER_SIZE) : data
    const meta = envelope
      ? { codec: envelope.codec, keyframe: envelope.keyframe, capturedAt: envelope.capturedAt, relayedAt: envelope.relayedAt }
      : undefined
    binaryFrameHandlerRef.current?.(payload, meta)
  }, [])

  const { send, connected } = useRelay(handleMessage, handleBinaryFrame)

  // **Final once ended or refused.** A reconnect after the watch ended must not quietly start a new one —
  // the relay ended it because the session became someone else's, and a fresh `watch:start` would be
  // refused at best and, against an older relay, silently dropped.
  const finalRef = useRef(false)
  useEffect(() => { finalRef.current = phase.kind === 'ended' || phase.kind === 'refused' }, [phase])
  useEffect(() => {
    if (!connected) return
    send({ type: 'agents:list' })
    if (!finalRef.current) send({ type: 'watch:start', sessionId })
    // Also how a holder that dropped and came back is noticed — the relay pushes nothing on a re-join — so
    // the disconnect notice can outlast the return by up to this interval. Accepted: it is the true signal.
    const id = setInterval(() => send({ type: 'agents:list' }), 10_000)
    return () => clearInterval(id)
  }, [connected, send, sessionId])

  return { phase, device, chrome, postures, deviceReady, holderLeft, agentAway, connected, binaryFrameHandlerRef }
}
