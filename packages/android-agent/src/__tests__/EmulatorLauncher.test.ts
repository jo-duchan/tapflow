import { describe, it, expect } from 'vitest'
import { buildEmulatorArgs } from '../EmulatorLauncher'

describe('buildEmulatorArgs', () => {
  it('includes -no-audio by default (audio off — video path unchanged)', () => {
    const args = buildEmulatorArgs('Pixel', 8554)
    expect(args).toContain('-no-audio')
    expect(args).toEqual(['-avd', 'Pixel', '-no-audio', '-no-snapshot', '-no-window', '-gpu', 'host', '-grpc', '8554'])
  })

  it('drops -no-audio when audio is enabled, leaving all other args intact', () => {
    const args = buildEmulatorArgs('Pixel', 8554, { audio: true })
    expect(args).not.toContain('-no-audio')
    expect(args).toEqual(['-avd', 'Pixel', '-no-snapshot', '-no-window', '-gpu', 'host', '-grpc', '8554'])
  })

  it('omits -grpc when no port given', () => {
    const args = buildEmulatorArgs('Pixel')
    expect(args).not.toContain('-grpc')
    expect(args).toContain('-no-audio')
  })

  it('explicit audio:false keeps -no-audio (parity with default)', () => {
    expect(buildEmulatorArgs('Pixel', 8554, { audio: false })).toContain('-no-audio')
  })
})
