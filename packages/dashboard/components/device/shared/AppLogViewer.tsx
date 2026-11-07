import { useLayoutEffect, useRef } from 'react'

interface AppLogViewerProps {
  text: string
}

export function AppLogViewer({ text }: AppLogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  useLayoutEffect(() => {
    const container = containerRef.current
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
        onScroll={(event) => {
          const element = event.currentTarget
          atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 12
        }}
        className="max-h-40 min-h-16 overflow-auto rounded-md border bg-muted/30 p-2"
      >
        <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-foreground/80">
          {text || 'Waiting for app logs…'}
        </pre>
      </div>
    </section>
  )
}
