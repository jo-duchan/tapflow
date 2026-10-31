import { describe, it, expect } from 'vitest'
import type { DeviceSummary } from '@/lib/types'
import { groupDevices } from '@/lib/deviceGroups'

const device = (id: string, osVersion: string | undefined, extra: Partial<DeviceSummary> = {}): DeviceSummary =>
  ({ id, name: `Device ${id}`, platform: 'ios', status: 'shutdown', osVersion, sessionId: `s-${id}`, busy: false, ...extra })

const shape = (groups: ReturnType<typeof groupDevices>) => groups.map((g) => [g.title, g.devices.map((d) => d.id)])
const all = { osVersion: '', search: '', showHidden: false }

describe('groupDevices (#1085)', () => {
  it('groups by version, newest first, with the unversioned last', () => {
    const devices = [device('a', 'iOS 18.6'), device('b', 'iOS 26.5'), device('c', undefined), device('d', 'iOS 18.6')]
    expect(shape(groupDevices(devices, all))).toEqual([['iOS 26.5', ['b']], ['iOS 18.6', ['a', 'd']], ['Other', ['c']]])
  })

  it('puts favourites first, and only there', () => {
    const devices = [device('a', 'iOS 18.6'), device('b', 'iOS 26.5', { favourite: true })]
    expect(shape(groupDevices(devices, all))).toEqual([['Favourites', ['b']], ['iOS 18.6', ['a']]])
  })

  it('drops the heading when there is one group', () => {
    expect(shape(groupDevices([device('a', 'iOS 26.5'), device('b', 'iOS 26.5')], all))).toEqual([[null, ['a', 'b']]])
  })

  it('narrows every group to the version picked', () => {
    const devices = [device('a', 'iOS 18.6', { favourite: true }), device('b', 'iOS 26.5', { favourite: true }), device('c', 'iOS 26.5')]
    expect(shape(groupDevices(devices, { ...all, osVersion: 'iOS 26.5' }))).toEqual([['Favourites', ['b']], ['iOS 26.5', ['c']]])
  })

  it('leaves hidden devices out unless asked, and empty groups with them', () => {
    const devices = [device('a', 'iOS 18.6', { hidden: true }), device('b', 'iOS 26.5')]
    expect(shape(groupDevices(devices, all))).toEqual([[null, ['b']]])
    expect(shape(groupDevices(devices, { ...all, showHidden: true }))).toEqual([['iOS 26.5', ['b']], ['iOS 18.6', ['a']]])
  })

  // A renamed device is still found by the name automation uses.
  it('searches the name shown and the device\'s own', () => {
    const devices = [device('a', 'iOS 26.5', { name: 'iPhone 17 Pro', displayName: 'Release phone' }), device('b', 'iOS 26.5', { name: 'iPad Air' })]
    expect(shape(groupDevices(devices, { ...all, search: 'release' }))).toEqual([[null, ['a']]])
    expect(shape(groupDevices(devices, { ...all, search: '17 pro' }))).toEqual([[null, ['a']]])
  })
})
