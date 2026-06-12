import { describe, it, expect } from 'vitest'
import { pickLanAddress } from '../lib/lanAddress'
import type os from 'os'

type Iface = os.NetworkInterfaceInfo

const v4 = (address: string, internal = false): Iface =>
  ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` })
const v6 = (address: string, internal = false): Iface =>
  ({ address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal, cidr: `${address}/64`, scopeid: 0 })

// #271 follow-up — 대시보드 agent 커맨드의 릴레이 호스트 결정에 쓰는 LAN IPv4 선택기
describe('pickLanAddress', () => {
  it('사설 대역 IPv4를 선택한다', () => {
    expect(pickLanAddress({
      lo0: [v4('127.0.0.1', true)],
      en0: [v6('fe80::1'), v4('192.168.219.197')],
    })).toBe('192.168.219.197')
  })

  it('internal·IPv6만 있으면 null', () => {
    expect(pickLanAddress({
      lo0: [v4('127.0.0.1', true)],
      utun3: [v6('fe80::ce81')],
    })).toBeNull()
  })

  it('사설 대역을 공인 IPv4보다 우선한다', () => {
    expect(pickLanAddress({
      en1: [v4('203.0.113.7')],
      en0: [v4('10.0.1.5')],
    })).toBe('10.0.1.5')
  })

  it('사설 대역이 없으면 비-internal IPv4라도 반환한다', () => {
    expect(pickLanAddress({ en0: [v4('203.0.113.7')] })).toBe('203.0.113.7')
  })

  it('CGNAT(100.64/10, Tailscale 등) 주소는 물리 LAN 주소보다 후순위', () => {
    expect(pickLanAddress({
      utun5: [v4('100.101.102.103')],
      en0: [v4('192.168.0.10')],
    })).toBe('192.168.0.10')
  })
})
