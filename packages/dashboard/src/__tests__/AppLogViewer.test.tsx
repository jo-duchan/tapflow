import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AppLogViewer } from '@/components/device/shared/AppLogViewer'

describe('AppLogViewer', () => {
  it('explains when the connected agent does not support app logs', () => {
    render(<AppLogViewer text="" supported={false} />)
    expect(screen.getByRole('log', { name: 'App log output' }).textContent).toBe('Update the device agent to view app logs.')
  })

  it('resumes following the tail after the buffer is cleared', () => {
    const { rerender } = render(<AppLogViewer text="first output" supported />)
    const log = screen.getByRole('log', { name: 'App log output' })
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    })

    log.scrollTop = 0
    fireEvent.scroll(log)
    rerender(<AppLogViewer text="older output plus another line" supported />)

    rerender(<AppLogViewer text="" supported />)
    expect(log.scrollTop).toBe(300)
    rerender(<AppLogViewer text="new launch output" supported />)
    expect(log.scrollTop).toBe(300)
  })
})
