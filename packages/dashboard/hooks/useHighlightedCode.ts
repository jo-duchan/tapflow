import { useEffect, useState, type ReactNode } from 'react'
import { loadHighlighter, type Highlighter } from '@/lib/highlighter'

/**
 * `value` as lines for `CodeBlockLine`, highlighted once the language has loaded and plain until then (shadcn's
 * `useHighlightedCode`, without its streaming: the dashboard shows finished text).
 */
export function useHighlightedCode(value: string, language: string): ReactNode[] {
  // A trailing newline would render as an extra empty line.
  const code = value.endsWith('\n') ? value.slice(0, -1) : value
  const [loaded, setLoaded] = useState<{ language: string; highlighter: Highlighter | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    loadHighlighter(language).then((highlighter) => { if (!cancelled) setLoaded({ language, highlighter }) }, () => {})
    return () => { cancelled = true }
  }, [language])
  const highlighter = loaded?.language === language ? loaded.highlighter : null
  return highlighter ? highlighter.highlight(code).lines : code.split('\n')
}
