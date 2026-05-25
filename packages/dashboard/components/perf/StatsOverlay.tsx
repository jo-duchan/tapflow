import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { PerfHook } from './types'

interface Props {
  perfHookRef: MutableRefObject<PerfHook | null>
}

export function StatsOverlay({ perfHookRef }: Props) {
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let cancelled = false
    let dom: HTMLElement | null = null

    import('stats.js').then(({ default: Stats }) => {
      if (cancelled) return
      const stats = new Stats()
      stats.showPanel(0) // FPS
      document.body.appendChild(stats.dom)
      dom = stats.dom

      perfHookRef.current = {
        onFrameBegin: () => stats.begin(),
        onFrameEnd: () => stats.end(),
      }
    })

    return () => {
      cancelled = true
      perfHookRef.current = null
      if (dom?.parentNode) dom.parentNode.removeChild(dom)
    }
  }, [perfHookRef])

  return null
}
