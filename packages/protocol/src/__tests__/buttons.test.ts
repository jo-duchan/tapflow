import { describe, expect, it } from 'vitest'

import type { AndroidChrome, ChromeButton, ChromeData } from '../index.js'
import { ANDROID_BUTTONS, buttonAvailability } from '../buttons/index.js'

const button = (name: string, usagePage: number, usage: number): ChromeButton => ({
  name, accessibilityTitle: name, anchor: 'left', onTop: false,
  normalOffset: { x: 0, y: 0 }, rolloverOffset: { x: 0, y: 0 }, buttonW: 1, buttonH: 1, usagePage, usage,
})

const iosChrome = (buttons: ChromeButton[]): ChromeData => ({
  framePng: '', bezelWidth: 1, bezelHeight: 1, compositeWidth: 1, compositeHeight: 1,
  padding: { left: 0, right: 0, top: 0, bottom: 0 }, screenRect: { x: 0, y: 0, width: 1, height: 1 },
  screenCornerRadius: 0, logicalWidth: 1, logicalHeight: 1, buttons,
})

describe('buttonAvailability', () => {
  it('answers Android from the closed map, with no chrome needed', () => {
    for (const name of ANDROID_BUTTONS) expect(buttonAvailability('android', name)).toBe('available')
    expect(buttonAvailability('android', 'action')).toBe('unavailable')
    expect(buttonAvailability('android', 'volume-up')).toBe('unavailable')
  })

  it('refuses Android navigation buttons on iOS without asking the device', () => {
    expect(buttonAvailability('ios', 'back')).toBe('unavailable')
    expect(buttonAvailability('ios', 'recent_apps')).toBe('unavailable')
    expect(buttonAvailability('ios', 'home')).toBe('available')
  })

  // The agent writes nothing for these without a HID usage in the chrome and still answers success.
  it('leaves every other iOS button open until the chrome says', () => {
    expect(buttonAvailability('ios', 'lock')).toBe('unknown')
    expect(buttonAvailability('ios', 'action')).toBe('unknown')
  })

  it('reads an iOS button through the cross-platform alias and requires a usage', () => {
    const chrome = iosChrome([button('power', 12, 48), button('volume-up', 12, 0), button('action', 12, 99)])
    expect(buttonAvailability('ios', 'lock', chrome)).toBe('available')
    expect(buttonAvailability('ios', 'power', chrome)).toBe('available')
    expect(buttonAvailability('ios', 'volume_up', chrome)).toBe('unavailable')
    expect(buttonAvailability('ios', 'volume_down', chrome)).toBe('unavailable')
    expect(buttonAvailability('ios', 'action', chrome)).toBe('available')
    expect(buttonAvailability('ios', 'home', iosChrome([]))).toBe('available')
  })

  it('does not read an Android chrome as an iOS one', () => {
    const android: AndroidChrome = { buttons: [{ name: 'power', accessibilityTitle: 'Power', keyCode: 26 }], streamType: 'h264' }
    expect(buttonAvailability('ios', 'lock', android)).toBe('unknown')
  })

  // A third-party agent's buttons are its own to answer; refusing them here would be a false failure.
  it('answers nothing for a platform it has no table for', () => {
    expect(buttonAvailability('tvos', 'back')).toBe('unknown')
    expect(buttonAvailability('tvos', 'home')).toBe('unknown')
  })
})
