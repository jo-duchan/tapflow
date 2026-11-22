import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { appendAppLogText } from '@/lib/appLogs'

export type AppLogHandler = (text: string | null) => void

interface AppLogViewerProps {
  handlerRef: MutableRefObject<AppLogHandler | null>
  supported: boolean
}

export function AppLogViewer({ handlerRef, supported }: AppLogViewerProps) {
  const [text, setText] = useState('')
  const pendingTextRef = useRef('')
  const animationFrameRef = useRef<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  useEffect(() => {
    const handleText: AppLogHandler = (chunk) => {
      if (chunk === null) {
        pendingTextRef.current = ''
        if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
        setText('')
        return
      }
      pendingTextRef.current += chunk
      if (animationFrameRef.current !== null) return
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null
        setText((current) => appendAppLogText(current, pendingTextRef.current))
        pendingTextRef.current = ''
      })
    }
    handlerRef.current = handleText
    return () => {
      if (handlerRef.current === handleText) handlerRef.current = null
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current)
    }
  }, [handlerRef])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (text === '') atBottomRef.current = true
    if (container && atBottomRef.current) container.scrollTop = container.scrollHeight
  }, [text])

  return (
    <section className="flex min-h-0 flex-col gap-1.5" aria-label="App logs">
      <h2 className="text-[11px] font-medium text-muted-foreground">App logs</h2>
      <div
        ref={containerRef}
        role="log"
        aria-label="App log output"
        aria-live="polite"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget
          atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 12
        }}
        className="max-h-40 min-h-16 overflow-auto rounded-md border bg-muted/30 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-foreground/80">
          {!supported ? 'Update the device agent to view app logs.' : (text || 'Waiting for app logs…')}
        </pre>
      </div>
    </section>
  )
}
