import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AndroidChrome } from '@/lib/types'

vi.mock('@/hooks/useDecoderStream', () => ({ useDecoderStream: () => {} }))

import { WatchedDevice } from '@/components/device/WatchedDevice'

/**
 * **A watched emulator drawn by its body places the holder's marks back on the frame.** An MCP tap is in the screen
 * Android draws; body mode's shell is the frame, so the mark is turned back by the capture's correction. Every other
 * watch test runs upright, where the two spaces are one and a turn the wrong way round passes.
 */
describe('WatchedDevice — marks on a turned body', () => {
  // Body a quarter clockwise over a portrait-locked screen (correction 270): the screen's bottom-left is the frame's
  // top-left. Mutation: turn the mark by the correction instead of its inverse.
  it('puts a tap on the screen\'s bottom-left at the frame\'s top-left', () => {
    const chrome = { screenWidth: 1080, screenHeight: 2400, streamRotation: 270, bodyRotation: 90 } as AndroidChrome
    render(
      <WatchedDevice
        chrome={chrome} deviceReady platform="android" binaryFrameHandlerRef={{ current: undefined }}
        touch={{ id: 1, at: 0, kind: 'tap', point: { x: 0, y: 1 } }}
      />,
    )
    expect(screen.getByTestId('touch-marks').getAttribute('data-anchor')).toBe('0,0')
  })

  // A body-mode holder sends the frame's own points: the shell is that frame, so they sit as they are — turned like a
  // screen point they landed a quarter off (design review). Asymmetric, so a turn shows. Mutation: turn every point.
  it('puts a point in the frame\'s own space where it is', () => {
    const chrome = { screenWidth: 1080, screenHeight: 2400, streamRotation: 270, bodyRotation: 90 } as AndroidChrome
    render(
      <WatchedDevice
        chrome={chrome} deviceReady platform="android" binaryFrameHandlerRef={{ current: undefined }}
        touch={{ id: 1, at: 0, kind: 'tap', point: { x: 0.2, y: 0.7 }, space: 'frame' }}
      />,
    )
    expect(screen.getByTestId('touch-marks').getAttribute('data-anchor')).toBe('20,70')
  })

  // A watcher sends nothing, so the pointer is kept over the device: hidden, it vanished with nothing standing in for
  // it (user). The QA viewer, which draws its own disc, still hides it (AndroidViewer tests find its surface by it).
  // Mutation: hide it on every screen again.
  it('keeps the pointer over a device it only shows, on both platforms', () => {
    const android = { screenWidth: 1080, screenHeight: 2400, streamRotation: 0 } as AndroidChrome
    const a = render(<WatchedDevice chrome={android} deviceReady platform="android" binaryFrameHandlerRef={{ current: undefined }} touch={null} />)
    expect(a.container.querySelector('[style*="cursor: none"]')).toBeNull()
    a.unmount()
    const i = render(<WatchedDevice chrome={null} deviceReady platform="ios" binaryFrameHandlerRef={{ current: undefined }} touch={null} />)
    expect(i.container.querySelector('canvas:not([data-testid])')).not.toBeNull()
    expect(i.container.querySelector('[style*="cursor: none"]')).toBeNull()
  })

  // A pinch is anchored at both fingers' starts. Mutation: anchor one.
  it('anchors a pinch at both fingers', () => {
    const chrome = { screenWidth: 1080, screenHeight: 2400, streamRotation: 0 } as AndroidChrome
    render(
      <WatchedDevice
        chrome={chrome} deviceReady platform="android" binaryFrameHandlerRef={{ current: undefined }}
        touch={{ id: 1, at: 0, kind: 'pinch', from: [{ x: 0.4, y: 0.45 }, { x: 0.6, y: 0.55 }], to: [{ x: 0.2, y: 0.35 }, { x: 0.8, y: 0.65 }] }}
      />,
    )
    expect(screen.getByTestId('touch-marks').getAttribute('data-anchor')).toBe('40,45;60,55')
  })
})
