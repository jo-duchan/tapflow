import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import type { ReactNode } from 'react'

/**
 * **The device as it is drawn, apart from the controls that drive it.** `IOSDeviceScreen` /
 * `AndroidDeviceScreen` and their hooks are shared by the viewers and by a page that only watches, so
 * what they take from the caller — handlers, overlays, the press targets — is the seam a refactor can
 * quietly cut. The viewer tests exercise it through the viewers; four mutations of the seam survived
 * them (an overlay dropped on either platform, Android's pointer handlers dropped, a rotation in flight
 * ignored), so this file holds each one directly.
 */

type Size = { width: number; height: number }
const captured: { onResize?: (s: Size) => void } = {}
vi.mock('@/hooks/useDecoderStream', () => ({
  useDecoderStream: (opts: { onResize: (s: Size) => void }) => { captured.onResize = opts.onResize },
}))

import { useIOSScreen } from '@/hooks/useIOSScreen'
import { IOSDeviceScreen, type IOSFrameButtonControls } from '@/components/device/IOSDeviceScreen'
import { useAndroidScreen, type AndroidScreen } from '@/hooks/useAndroidScreen'
import { AndroidDeviceScreen } from '@/components/device/AndroidDeviceScreen'

// jsdom implements no pointer capture.
Element.prototype.setPointerCapture ??= () => {}

const sideButton = (name: string, y: number) => ({
  name, accessibilityTitle: name, anchor: 'left', onTop: false,
  normalOffset: { x: 10, y }, rolloverOffset: { x: 8, y },
  buttonW: 12, buttonH: 100, usagePage: 0, usage: 0, buttonPng: 'AA==',
})
const chrome = {
  framePng: '', bezelWidth: 600, bezelHeight: 1200,
  compositeWidth: 640, compositeHeight: 1240,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: 560, height: 1160 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844,
  buttons: [sideButton('action', 300), sideButton('volume_up', 500)],
} as unknown as React.ComponentProps<typeof IOSDeviceScreen>['chrome']

function IOSHarness(props: {
  buttons?: IOSFrameButtonControls
  onPointerDown?: () => void
  overlay?: ReactNode
  areaOverlay?: ReactNode
}) {
  const screen = useIOSScreen({
    chrome, binaryFrameHandlerRef: { current: undefined }, fps: 0, frameCount: { current: 0 },
  })
  return (
    <IOSDeviceScreen
      screen={screen} chrome={chrome} isLandscape={false} joined fps={0}
      containerHandlers={props.onPointerDown ? { onPointerDown: props.onPointerDown } : undefined}
      buttons={props.buttons} overlay={props.overlay} areaOverlay={props.areaOverlay}
    />
  )
}

describe('IOSDeviceScreen', () => {
  // A page that only watches passes no button controls; a press target there would be an element
  // that looks pressable and leads nowhere.
  it('draws the frame buttons but no press targets when nobody can press', () => {
    const { container } = render(<IOSHarness />)
    expect(container.querySelectorAll('[data-frame-button]')).toHaveLength(0)
    expect(container.querySelectorAll('img[src="data:image/png;base64,AA=="]')).toHaveLength(2)
  })

  it('puts a press target on each button when the caller can press', () => {
    const onPress = vi.fn()
    const { container } = render(<IOSHarness buttons={{ hovered: null, flashed: null, onHoverChange: vi.fn(), onPress }} />)
    const targets = container.querySelectorAll<HTMLElement>('[data-frame-button]')
    expect(targets).toHaveLength(2)
    fireEvent.pointerDown(targets[1])
    expect(onPress).toHaveBeenCalledWith('volume_up', expect.anything())
  })

  // Mutation: drop the spread. Every tap on the screen goes nowhere.
  it('hands the device container the caller\'s pointer handlers', () => {
    const onPointerDown = vi.fn()
    const { container } = render(<IOSHarness onPointerDown={onPointerDown} />)
    fireEvent.pointerDown(container.querySelector('canvas')!)
    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  // Mutation: drop either slot. The pinch hints and the live cursor vanish with no other symptom.
  it('draws the overlays, the device one inside the device and the area one beside it', () => {
    const { getByTestId } = render(
      <IOSHarness overlay={<i data-testid="inside" />} areaOverlay={<i data-testid="beside" />} />,
    )
    const canvas = document.querySelector('canvas')!
    expect(canvas.parentElement!.contains(getByTestId('inside'))).toBe(true)
    expect(canvas.parentElement!.contains(getByTestId('beside'))).toBe(false)
  })
})

function AndroidHarness(props: {
  rotatePending?: boolean
  onPointerDown?: () => void
  overlay?: ReactNode
  expose?: (s: AndroidScreen) => void
}) {
  const screen = useAndroidScreen({
    binaryFrameHandlerRef: { current: undefined }, frameCount: { current: 0 },
    screenWidth: 1080, screenHeight: 2400, streamRotation: 0,
    userWantsLandscape: false, rotatePending: props.rotatePending ?? false,
  })
  props.expose?.(screen)
  return (
    <AndroidDeviceScreen
      screen={screen} deviceReady posturePending={false}
      surfaceHandlers={props.onPointerDown ? { onPointerDown: props.onPointerDown } : undefined}
      overlay={props.overlay}
    />
  )
}

describe('AndroidDeviceScreen', () => {
  // Mutation: drop the spread. The surface host takes the pointer, so every tap goes nowhere.
  it('hands the surface host the caller\'s pointer handlers', () => {
    const onPointerDown = vi.fn()
    let screen: AndroidScreen | null = null
    render(<AndroidHarness onPointerDown={onPointerDown} expose={(s) => { screen = s }} />)
    const host = screen!.surfaceHostRef.current
    expect(host).not.toBeNull()
    fireEvent.pointerDown(host!)
    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  it('draws the overlay over the screen', () => {
    const { getByTestId } = render(<AndroidHarness overlay={<i data-testid="cursor" />} />)
    expect(getByTestId('cursor')).toBeTruthy()
  })

  // Mutation: stop reading `rotatePending`. A new correction angle is applied to the frame drawn
  // under the old one, and on an idle screen the picture stays turned.
  it('holds the picture back while a rotation is in flight, and shows it once it lands', () => {
    let screen: AndroidScreen | null = null
    const expose = (s: AndroidScreen) => { screen = s }
    const host = () => screen!.surfaceHostRef.current!
    const view = render(<AndroidHarness expose={expose} />)
    act(() => captured.onResize!({ width: 1080, height: 2400 }))
    expect(host().style.visibility).toBe('visible')
    view.rerender(<AndroidHarness rotatePending expose={expose} />)
    expect(host().style.visibility).toBe('hidden')
    view.rerender(<AndroidHarness expose={expose} />)
    expect(host().style.visibility).toBe('visible')
  })
})
