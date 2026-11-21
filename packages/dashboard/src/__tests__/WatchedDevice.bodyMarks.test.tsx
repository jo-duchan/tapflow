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
})
