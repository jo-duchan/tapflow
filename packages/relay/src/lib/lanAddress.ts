import type os from 'os'

const isPrivate = (a: string) =>
  a.startsWith('192.168.') ||
  a.startsWith('10.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(a)

// CGNAT 100.64.0.0/10 — Tailscale 등 VPN 인터페이스. 물리 LAN보다 후순위.
const isCgnat = (a: string) => {
  const m = /^100\.(\d+)\./.exec(a)
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

// 대시보드가 "에이전트 Mac에서 실행할 커맨드"에 박을 릴레이 LAN 주소를 고른다.
// 사설 IPv4 > 기타 비-internal IPv4 > CGNAT 순. 없으면 null (호출부가 폴백).
export function pickLanAddress(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null {
  const candidates: string[] = []
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.internal || info.family !== 'IPv4') continue
      candidates.push(info.address)
    }
  }
  return (
    candidates.find((a) => isPrivate(a)) ??
    candidates.find((a) => !isCgnat(a)) ??
    candidates[0] ??
    null
  )
}
