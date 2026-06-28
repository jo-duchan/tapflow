import { describe, it, expect } from 'vitest'
import { enumerateSimPids } from '../SimProcessTree'

const UDID = '0535B2B2-0C96-45FF-88F1-141848964031'
const OTHER = 'AAAAAAAA-1111-2222-3333-444444444444'

// Mimics `ps -axo pid=,ppid=,command=` output (pid, ppid, then the full command line).
const PS = [
  '    1     0 /sbin/launchd',
  '  999     1 /usr/sbin/some-host-daemon',
  `33817     1 launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/${UDID}/data/var/run/launchd_bootstrap.plist`,
  '33854 33817 SpringBoard',
  '34356 33817 MobileSafari',
  '34379 34356 com.apple.WebKit.WebContent', // grandchild via MobileSafari
  '34386 34356 com.apple.WebKit.GPU',
  // a second simulator — must NOT bleed into the first one's set
  `40000     1 launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/${OTHER}/data/var/run/launchd_bootstrap.plist`,
  '40001 40000 SpringBoard',
].join('\n')

describe('enumerateSimPids', () => {
  it('returns the full descendant tree of the matching launchd_sim (incl. grandchildren)', () => {
    expect(enumerateSimPids(UDID, PS).sort((a, b) => a - b)).toEqual([33854, 34356, 34379, 34386])
  })

  it('excludes the launchd_sim root itself (it emits no audio)', () => {
    expect(enumerateSimPids(UDID, PS)).not.toContain(33817)
  })

  it('isolates per-simulator: another booted sim does not bleed in', () => {
    expect(enumerateSimPids(OTHER, PS).sort((a, b) => a - b)).toEqual([40001])
  })

  it('returns [] when no launchd_sim matches the udid', () => {
    expect(enumerateSimPids('UNKNOWN-UDID', PS)).toEqual([])
  })
})
