import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { FrameTiming } from './types'
import { summarizeLatency, type Percentiles } from './latencyStats'

const fmtPct = (p: Percentiles | null): string =>
  p ? `${p.p50.toFixed(0)}/${p.p95.toFixed(0)} (max ${p.max.toFixed(0)})` : '—'

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
    // p50/p95/max readouts — the numbers to paste into the campaign §4 table.
    const summary = { glassToGlass: '—', decode: '—', agentRelay: '—' }
    const traceBuffer: FrameTiming[] = []
    let sinceSummary = 0
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

      const sumFolder = pane.addFolder({ title: 'p50/p95 ms', expanded })
      sumFolder.addBinding(summary, 'glassToGlass', { readonly: true, label: 'glass→glass' })
      sumFolder.addBinding(summary, 'decode', { readonly: true, label: 'decode→present' })
      sumFolder.addBinding(summary, 'agentRelay', { readonly: true, label: 'agent→relay' })

      pane.addButton({ title: 'Log latency summary' }).on('click', () => {
        console.log('[latency]', JSON.stringify(summarizeLatency(traceBuffer)))
      })

      pane.addButton({ title: 'Export trace' }).on('click', () => {
        if (traceBuffer.length === 0) return
        const hasAgentHops = traceBuffer.some((t) => t.capturedAt !== undefined)
        const events: object[] = [
          { ph: 'M', pid: 1, tid: 1, name: 'thread_name', args: { name: 'ws-recv' } },
          { ph: 'M', pid: 1, tid: 2, name: 'thread_name', args: { name: 'decode' } },
          { ph: 'M', pid: 1, tid: 3, name: 'thread_name', args: { name: 'paint' } },
        ]
        if (hasAgentHops) {
          events.push({ ph: 'M', pid: 1, tid: 4, name: 'thread_name', args: { name: 'relay' } })
          events.push({ ph: 'M', pid: 1, tid: 5, name: 'thread_name', args: { name: 'agent-capture' } })
        }
        for (const t of traceBuffer) {
          const recvUs = t.recvAt * 1000
          const decodeUs = t.decodeMs * 1000
          const paintUs = t.paintMs * 1000
          if (t.capturedAt !== undefined && t.relayedAt !== undefined) {
            const capturedUs = t.capturedAt * 1000
            const relayedUs = t.relayedAt * 1000
            events.push({ ph: 'i', ts: capturedUs, pid: 1, tid: 5, name: 'agent-capture', s: 't' })
            events.push({ ph: 'X', ts: relayedUs, dur: Math.max(1, recvUs - relayedUs), pid: 1, tid: 4, name: 'relay' })
          }
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
        setTimeout(() => URL.revokeObjectURL(url), 0)
      })

      dispose = () => pane.dispose()
      pushRef.current = (t: FrameTiming) => {
        params.recvFps = t.recvInterval > 0 ? 1000 / t.recvInterval : 0
        params.decodeMs = t.decodeMs
        params.paintMs = t.paintMs
        if (traceBuffer.length >= MAX_TRACE_FRAMES) traceBuffer.shift()
        traceBuffer.push(t)
        // Recompute percentiles ~1x/sec over the recent window (cheap, not per-frame).
        if (++sinceSummary >= 30) {
          sinceSummary = 0
          const s = summarizeLatency(traceBuffer.slice(-300))
          summary.decode = fmtPct(s.decodeMs)
          summary.glassToGlass = fmtPct(s.glassToGlassMs)
          summary.agentRelay = fmtPct(s.agentRelayMs)
        }
        pane.refresh()
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
