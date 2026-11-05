import { describe, it, expect } from 'vitest'
import { parsePostures, parseCurrentPosture, bootPostureId, parseKeyguard } from '../postures'

// Verbatim from a Pixel 9 Pro Fold (API 36) on 2026-09-18 — `adb shell cmd device_state
// print-states`. Kept whole rather than trimmed to the fields the parser reads: the trailing
// `app_accessible` / `cancel_when_requester_not_on_top` are what make the `[^}]*?` in the pattern
// load-bearing, and a fixture that dropped them would pass a parser that could not read the device.
const PRINT_STATES = `Supported states: [
  DeviceState{identifier=0, name='CLOSED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=1, name='HALF_OPENED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=2, name='OPENED', app_accessible=true, cancel_when_requester_not_on_top=false},
  DeviceState{identifier=3, name='REAR_DISPLAY_MODE', app_accessible=true, cancel_when_requester_not_on_top=false},
]`

describe('parsePostures', () => {
  it('offers one control per screen a person can tell apart', () => {
    // The guest lists four states and tapflow shows two. `REAR_DISPLAY_MODE` has no
    // `adb emu posture` equivalent so it cannot be reached at all; `OPENED` can be, and presents
    // the same 2076x2152 screen as `HALF_OPENED` — measured. Offering both put a step in the
    // control that changed nothing visible, which reads as a press that was dropped.
    expect(parsePostures(PRINT_STATES)).toEqual([
      { id: '1', label: 'Folded' },
      { id: '2', label: 'Unfolded' },
    ])
  })

  it('carries the emulator id, not the guest identifier', () => {
    // The two numberings disagree — the guest calls HALF_OPENED 1, the console calls it 2 — and the
    // id on the wire is the argument to `emu posture`, so it has to be the console's.
    const unfolded = parsePostures(PRINT_STATES).find((p) => p.label === 'Unfolded')
    expect(unfolded?.id).toBe('2')
  })

  it('never leaks a raw token into a label', () => {
    for (const p of parsePostures(PRINT_STATES)) {
      expect(p.label).not.toMatch(/_/)
      expect(p.label).not.toBe(p.label.toUpperCase())
    }
  })

  it('drops a posture this build has not been taught rather than showing a dead button', () => {
    const withNew = PRINT_STATES.replace("name='HALF_OPENED'", "name='TENT_MODE'")
    expect(parsePostures(withNew).map((p) => p.label)).toEqual(['Folded'])
  })

  it('returns [] for a device with no postures — the contract\'s empty list', () => {
    expect(parsePostures('Supported states: [\n]')).toEqual([])
    expect(parsePostures('')).toEqual([])
  })
})

describe('parseCurrentPosture', () => {
  it('answers with the emulator id for the guest\'s committed state', () => {
    expect(parseCurrentPosture(
      "Committed state: DeviceState{identifier=1, name='HALF_OPENED', app_accessible=true}",
    )).toBe('2')
    expect(parseCurrentPosture(
      "Committed state: DeviceState{identifier=0, name='CLOSED', app_accessible=true}",
    )).toBe('1')
  })

  it('returns null for a posture tapflow does not offer', () => {
    // Honest rather than convenient: the viewer highlights nothing instead of the wrong button.
    // `OPENED` lands here — it is reachable but shares a screen with the posture that is offered,
    // so the device sitting in it is a state the control cannot point at.
    expect(parseCurrentPosture(
      "Committed state: DeviceState{identifier=3, name='REAR_DISPLAY_MODE'}",
    )).toBeNull()
    expect(parseCurrentPosture(
      "Committed state: DeviceState{identifier=2, name='OPENED'}",
    )).toBeNull()
  })

  it('returns null when the device reports none', () => {
    expect(parseCurrentPosture('Committed state: (none)')).toBeNull()
    expect(parseCurrentPosture('')).toBeNull()
  })
})

describe('bootPostureId', () => {
  const PAIR = [{ id: '1', label: 'Folded' }, { id: '2', label: 'Unfolded' }]

  it('names the posture a session starts in, rather than taking the last entry', () => {
    expect(bootPostureId(PAIR)).toBe('2')
  })

  it('still names it when a more open posture is appended after it', () => {
    // The failure this function exists to stop. `REAR_DISPLAY_MODE` is an open hinge lighting the
    // *cover* panel and the guest orders it last, so a table edit that appended it in guest order
    // would silently boot every session into rear display — with the rule living in another file
    // and no test able to say the table was wrong.
    expect(bootPostureId([...PAIR, { id: '3', label: 'Rear display' }])).toBe('2')
  })

  it('answers null for a device that does not offer it', () => {
    // A phone, or a foldable whose emulator cannot reach the unfolded posture. The caller then
    // leaves the device alone rather than folding it somewhere arbitrary.
    expect(bootPostureId([])).toBeNull()
    expect(bootPostureId([{ id: '1', label: 'Folded' }])).toBeNull()
  })
})

// The `KeyguardServiceDelegate` block of `adb shell dumpsys window policy`, verbatim from a Pixel 9 Pro Fold (API 36).
const POLICY = (showing: boolean, secure: boolean) => `    KeyguardServiceDelegate
      showing=${showing}
      inputRestricted=false
      occluded=false
      secure=${secure}
      dreaming=false
      systemIsReady=true
      deviceHasKeyguard=true
    KeyguardStateMonitor
        mIsShowing=${showing}
        mSimSecure=false`

describe('parseKeyguard', () => {
  it('reads whether the keyguard is up and whether it is a secure one', () => {
    expect(parseKeyguard(POLICY(true, false))).toEqual({ showing: true, secure: false })
    expect(parseKeyguard(POLICY(false, false))).toEqual({ showing: false, secure: false })
    expect(parseKeyguard(POLICY(true, true))).toEqual({ showing: true, secure: true })
  })

  // An image that words it differently is left alone rather than read as unlocked.
  it('answers null when the dump does not say', () => {
    expect(parseKeyguard('')).toBeNull()
    expect(parseKeyguard('      showing=true')).toBeNull()
  })
})
