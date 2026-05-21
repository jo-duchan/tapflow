import { useCallback, useEffect, useRef, useState } from 'react'

type RecordState = 'idle' | 'recording' | 'uploading' | 'done'

interface UseClientRecordingOptions {
  sessionId: string
  buildId?: number
  onRecordingUploaded?: () => void
}

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

export function useClientRecording({ sessionId, buildId, onRecordingUploaded }: UseClientRecordingOptions) {
  const [recordState, setRecordState] = useState<RecordState>('idle')
  const recordCanvasRef = useRef<HTMLCanvasElement>(null)

  // Stable ref so identity changes in the prop never trigger re-subscriptions (#58 regression)
  const onUploadedRef = useRef(onRecordingUploaded)
  useEffect(() => { onUploadedRef.current = onRecordingUploaded }, [onRecordingUploaded])

  const recordingRef = useRef(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordChunksRef = useRef<Blob[]>([])
  const recordMimeRef = useRef('')
  const rafIdRef = useRef(0)
  // Stable ref wrapper so RAF always calls the latest composeFrame without recreating the loop
  const composeFrameRef = useRef<(() => void) | null>(null)

  const rafLoop = useCallback(() => {
    if (!recordingRef.current) return
    composeFrameRef.current?.()
    rafIdRef.current = requestAnimationFrame(rafLoop)
  }, [])

  // Caller must set recordCanvasRef.current.width/height before calling this.
  // (iOS uses container px, Android multiplies by devicePixelRatio — kept as caller responsibility.)
  const startClientRecording = useCallback((composeFrame: () => void) => {
    const rc = recordCanvasRef.current
    if (!rc) return
    const ctx0 = rc.getContext('2d')
    if (ctx0) { ctx0.fillStyle = '#000'; ctx0.fillRect(0, 0, rc.width, rc.height) }

    const mime = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
    if (!mime) return

    recordMimeRef.current = mime
    recordChunksRef.current = []

    const mr = new MediaRecorder(rc.captureStream(30), { mimeType: mime })
    mr.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data) }
    mediaRecorderRef.current = mr
    mr.start(1000)

    composeFrameRef.current = composeFrame
    recordingRef.current = true
    rafIdRef.current = requestAnimationFrame(rafLoop)
    setRecordState('recording')
  }, [rafLoop])

  const stopClientRecording = useCallback(async () => {
    setRecordState('uploading')
    recordingRef.current = false
    cancelAnimationFrame(rafIdRef.current)

    const mr = mediaRecorderRef.current
    if (!mr) { setRecordState('idle'); return }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000)
      mr.onstop = () => { clearTimeout(timeout); resolve() }
      try { mr.stop() } catch { clearTimeout(timeout); resolve() }
    })
    mediaRecorderRef.current = null

    const mime = recordMimeRef.current
    const ext = mime.includes('mp4') ? '.mp4' : '.webm'
    const blob = new Blob(recordChunksRef.current, { type: mime })
    recordChunksRef.current = []

    const formData = new FormData()
    formData.append('file', blob, `tapflow-${Date.now()}${ext}`)
    try {
      const params = new URLSearchParams({ sessionId })
      if (buildId) params.set('buildId', String(buildId))
      const res = await fetch(`/api/v1/recordings/upload?${params}`, { method: 'POST', credentials: 'include', body: formData })
      const json = await res.json() as { url?: string }
      if (res.ok && json.url) {
        const a = document.createElement('a'); a.href = json.url; a.download = ''; a.click()
        onUploadedRef.current?.()
        setRecordState('done')
        setTimeout(() => setRecordState('idle'), 2000)
      } else {
        setRecordState('idle')
      }
    } catch {
      setRecordState('idle')
    }
  }, [sessionId, buildId])

  // Auto-stop on tab hide + cleanup on unmount
  useEffect(() => {
    if (recordState !== 'recording') return
    const onVisibility = () => { if (document.visibilityState === 'hidden') stopClientRecording() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (recordingRef.current) {
        recordingRef.current = false
        cancelAnimationFrame(rafIdRef.current)
        mediaRecorderRef.current?.stop()
        mediaRecorderRef.current = null
      }
    }
  }, [recordState, stopClientRecording])

  return { recordState, recordCanvasRef, startClientRecording, stopClientRecording }
}
