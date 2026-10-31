import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { DeviceSummary, SessionInfo } from '@/lib/types'
import { useDeviceSelector } from '@/hooks/useDeviceSelector'

const device = (id: string, osVersion: string, extra: Partial<DeviceSummary> = {}): DeviceSummary =>
  ({ id, name: id, platform: 'ios', status: 'shutdown', osVersion, sessionId: `s-${id}`, busy: false, ...extra })
const mac = (devices: DeviceSummary[]): SessionInfo => ({
  agentName: 'mac', agentKey: 'mac', platform: 'ios', capabilities: [],
  admission: { booting: false, overloaded: false, memoryRefuses: [] }, devices,
})

// #1085: hiding the last device of the version picked takes that version out of the Select's items. The filter falls
// back to every version rather than naming one the Select cannot show.
describe('useDeviceSelector — a picked version whose devices were hidden', () => {
  it('falls back to every version', () => {
    const { result, rerender } = renderHook(({ session }) => useDeviceSelector(session, 'ios'), {
      initialProps: { session: mac([device('a', 'iOS 18.3'), device('b', 'iOS 26.5')]) },
    })
    act(() => result.current.setOsVersion('iOS 18.3'))
    expect(result.current.versionedDevices.map((d) => d.id)).toEqual(['a'])

    rerender({ session: mac([device('a', 'iOS 18.3', { hidden: true }), device('b', 'iOS 26.5')]) })
    expect(result.current.osVersion).toBe('')
    expect(result.current.versionedDevices.map((d) => d.id)).toEqual(['b'])
  })
})
