import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { AppLogHandler } from '@/components/device/shared/AppLogViewer'
import { fakeAppLogLayout } from './appLogLayout'

// A relay upgraded under an open tab renames its chunks, so the rows' chunk can fail to load on launch.
vi.mock('@/components/device/shared/AppLogRows', () => {
  throw new Error('chunk 404')
})

const { AppLogViewer } = await import('@/components/device/shared/AppLogViewer')

let frames: FrameRequestCallback[] = []
let layout: ReturnType<typeof fakeAppLogLayout>
beforeEach(() => {
  frames = []
  layout = fakeAppLogLayout()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
  layout.restore()
})

describe('AppLogViewer when the rows cannot load', () => {
  it('says so in the box and leaves the rest of the page standing', async () => {
    const handlerRef = { current: null as AppLogHandler | null }
    render(<div><p>page</p><AppLogViewer handlerRef={handlerRef} supported /></div>)
    act(() => handlerRef.current?.({ kind: 'launch' }))
    act(() => handlerRef.current?.({ kind: 'text', text: 'first line\n' }))
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(await screen.findByText(/App logs could not load/)).toBeInTheDocument()
    expect(screen.getByText('page')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })
})
