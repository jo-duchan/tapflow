import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

export function usePerfMode() {
  const [searchParams] = useSearchParams()
  const perfMode = searchParams.get('perf') === '1'
  const [visible, setVisible] = useState(perfMode)

  useEffect(() => {
    if (!perfMode) { setVisible(false); return }
    setVisible(true)
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'P') setVisible(v => !v)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [perfMode])

  return { perfMode, visible }
}
