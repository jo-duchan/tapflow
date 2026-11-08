import type { MutableRefObject } from 'react'
import type { AndroidChrome, BrowserInbound, BrowserToRelay, ChromeData, PosturesPayload } from '@tapflowio/protocol'
import type { CaptureTap } from './tap'

export interface ViewerCaptureState {
  sessionId: string
  platform: string
  buildId: number
  connected: boolean
  chrome: ChromeData | AndroidChrome | null
  postures: PosturesPayload
}

/**
 * The viewer's `CaptureTap`, built once from its refs and read through them, so the dialog always sees the viewer as
 * it is now rather than as it was when the tap was made. Outside the component: an object of functions that read refs,
 * made during render, is what the React Compiler refuses.
 */
export function viewerCaptureTap(refs: {
  state: MutableRefObject<ViewerCaptureState>
  send: MutableRefObject<(msg: BrowserToRelay) => boolean>
  listeners: MutableRefObject<Set<(msg: BrowserInbound) => void>>
  closeListeners: MutableRefObject<Set<() => void>>
  surface: MutableRefObject<(() => CanvasImageSource | null) | null>
}): CaptureTap {
  return {
    get sessionId() { return refs.state.current.sessionId },
    get platform() { return refs.state.current.platform },
    get buildId() { return refs.state.current.buildId },
    send: (msg) => refs.send.current(msg),
    subscribe: (listener) => {
      refs.listeners.current.add(listener)
      return () => { refs.listeners.current.delete(listener) }
    },
    onConnectionLost: (listener) => {
      refs.closeListeners.current.add(listener)
      return () => { refs.closeListeners.current.delete(listener) }
    },
    connected: () => refs.state.current.connected,
    chrome: () => refs.state.current.chrome,
    postures: () => refs.state.current.postures,
    surface: () => refs.surface.current?.() ?? null,
  }
}
