import { useEffect, useRef, useState } from 'react'

export function useFps() {
  const frameCount = useRef(0)
  const [fps, setFps] = useState(0)
  useEffect(() => {
    const t = setInterval(() => { setFps(frameCount.current); frameCount.current = 0 }, 1000)
    return () => clearInterval(t)
  }, [])
  return { fps, frameCount }
}
