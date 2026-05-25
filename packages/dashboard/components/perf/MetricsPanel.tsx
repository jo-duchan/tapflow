import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { FrameTiming } from './types'

interface Props {
  pushRef: MutableRefObject<((t: FrameTiming) => void) | null>
}

const LS_KEY = 'tapflow-perf-expanded'
const MAX_TRACE_FRAMES = 3600 // ~60s at 60fps

export function MetricsPanel({ pushRef }: Props) {
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let cancelled = false

    const container = document.createElement('div')
    container.style.cssText = 'position:fixed;top:0;left:80px;z-index:9999;'
    document.body.appendChild(container)

    const params = { recvFps: 0, decodeMs: 0, paintMs: 0 }
    const traceBuffer: FrameTiming[] = []
    let dispose: (() => void) | null = null

    import('tweakpane').then(({ Pane }) => {
      if (cancelled) return

      const pane = new Pane({ title: 'perf', container })
      const expanded = localStorage.getItem(LS_KEY) !== '0'
      const folder = pane.addFolder({ title: 'latency', expanded })
      folder.on('fold', () => {
        localStorage.setItem(LS_KEY, folder.expanded ? '1' : '0')
      })

      folder.addBinding(params, 'recvFps', {
        readonly: true, view: 'graph', label: 'recv fps', min: 0, max: 65,
      })
      folder.addBinding(params, 'decodeMs', {
        readonly: true, view: 'graph', label: 'decode ms', min: 0, max: 60,
      })
      folder.addBinding(params, 'paintMs', {
        readonly: true, view: 'graph', label: 'paint ms', min: 0, max: 10,
      })

      pane.addButton({ title: 'Export trace' }).on('click', () => {
        if (traceBuffer.length === 0) return
        const events: object[] = [
          { ph: 'M', pid: 1, tid: 1, name: 'thread_name', args: { name: 'ws-recv' } },
          { ph: 'M', pid: 1, tid: 2, name: 'thread_name', args: { name: 'decode' } },
          { ph: 'M', pid: 1, tid: 3, name: 'thread_name', args: { name: 'paint' } },
        ]
        for (const t of traceBuffer) {
          const recvUs = t.recvAt * 1000
          const decodeUs = t.decodeMs * 1000
          const paintUs = t.paintMs * 1000
          events.push({ ph: 'i', ts: recvUs, pid: 1, tid: 1, name: 'ws-recv', s: 't' })
          events.push({ ph: 'X', ts: recvUs, dur: Math.max(1, decodeUs), pid: 1, tid: 2, name: 'decode' })
          events.push({ ph: 'X', ts: recvUs + decodeUs, dur: Math.max(1, paintUs), pid: 1, tid: 3, name: 'paint' })
        }
        const json = JSON.stringify({ traceEvents: events, displayTimeUnit: 'ms' })
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `tapflow-trace-${Date.now()}.json`
        a.click()
        URL.revokeObjectURL(url)
      })

      dispose = () => pane.dispose()
      pushRef.current = (t: FrameTiming) => {
        params.recvFps = t.recvInterval > 0 ? 1000 / t.recvInterval : 0
        params.decodeMs = t.decodeMs
        params.paintMs = t.paintMs
        pane.refresh()
        if (traceBuffer.length >= MAX_TRACE_FRAMES) traceBuffer.shift()
        traceBuffer.push(t)
      }
    })

    return () => {
      cancelled = true
      pushRef.current = null
      dispose?.()
      if (container.parentNode) container.parentNode.removeChild(container)
    }
  }, [pushRef])

  return null
}
