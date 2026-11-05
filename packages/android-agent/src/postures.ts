import type { DevicePosture } from '@tapflowio/protocol'

/**
 * The postures tapflow can actually put an emulator into, in the order the protocol requires:
 * **most closed → most open**.
 *
 * **Two vocabularies, and only one of them can fold anything.** The guest lists what it supports
 * through `cmd device_state print-states` — `CLOSED(0)`, `HALF_OPENED(1)`, `OPENED(2)`,
 * `REAR_DISPLAY_MODE(3)` on a Pixel 9 Pro Fold. The *emulator* takes `adb emu posture` with its own
 * numbering (1 closed, 2 half-opened, 3 opened, 4 flipped, 5 tent). Writing the guest's state moves
 * the framework and leaves the emulator rendering the screen it had, so this table is keyed by the
 * guest's name and carries the emulator's id, and `id` on the wire is the emulator's.
 *
 * **Two of the guest's four are deliberately absent, for the same reason twice: a control that
 * changes nothing is worse than no control.**
 *
 * `REAR_DISPLAY_MODE` has no `adb emu posture` equivalent, so tapflow cannot reach it at all.
 *
 * `OPENED` can be reached and presents **the same 2076x2152 screen as `HALF_OPENED`** — measured on
 * a Pixel 9 Pro Fold, where `emu posture 2` and `emu posture 3` differ only in what the guest calls
 * the state. Offering both put a step in the control that visibly did nothing, which read as a
 * press that had been dropped. So the unfolded screen is offered once, under the label a person
 * would look for, and `HALF_OPENED` is the id that reaches it because the two are indistinguishable
 * on screen. An app that branches on the *guest's* posture would want the distinction back; nothing
 * tapflow shows today can express it.
 *
 * A guest posture with no entry here is dropped rather than falling through to a title-cased
 * label — appearing as a button that does nothing is the failure this table exists to prevent.
 *
 * The labels are what a person reads. The raw tokens are not — nobody should see
 * `REAR_DISPLAY_MODE` in a UI, and a viewer that had to map them would need a case per platform,
 * which is what `AgentRegistry` exists to avoid.
 */
const KNOWN: ReadonlyArray<{ name: string; emuId: string; label: string; boot?: true }> = [
  { name: 'CLOSED', emuId: '1', label: 'Folded' },
  { name: 'HALF_OPENED', emuId: '2', label: 'Unfolded', boot: true },
]

/**
 * The posture a session starts in, named here rather than derived from the list's order.
 *
 * `postures[length - 1]` gives the same answer today and stops doing so the moment a third entry
 * is added: `REAR_DISPLAY_MODE` is an open hinge lighting the *cover* panel and the guest orders
 * it last, so appending it in guest order would silently boot every session into rear display —
 * from a one-line edit to the table above, with the rule living in another file.
 */
export function bootPostureId(available: ReadonlyArray<DevicePosture>): string | null {
  const boot = KNOWN.find((k) => k.boot)
  return boot && available.some((p) => p.id === boot.emuId) ? boot.emuId : null
}

export function parsePostures(output: string): DevicePosture[] {
  const names = new Set<string>()
  for (const m of output.matchAll(/name='([A-Z_]+)'/g)) names.add(m[1]!)
  // KNOWN's own order is the contract's order, so filtering it keeps that without a sort.
  return KNOWN.filter((k) => names.has(k.name)).map(({ emuId, label }) => ({ id: emuId, label }))
}

/**
 * Parse `cmd device_state state` — "Committed state: DeviceState{identifier=2, name='OPENED', …}".
 *
 * Answers with the **emulator** id, so it can be compared against what `parsePostures` returned.
 * The guest is read rather than the emulator because the emulator console has no query form — and
 * the guest does follow an `emu posture`, which is measurable: `wm size` changes with it.
 *
 * `null` when the device reports a posture tapflow cannot reach, which is honest: the viewer then
 * highlights nothing rather than pointing at the wrong button.
 */
export function parseCurrentPosture(output: string): string | null {
  const m = output.match(/name='([A-Z_]+)'/)
  if (!m) return null
  return KNOWN.find((k) => k.name === m[1])?.emuId ?? null
}

/**
 * Parse `dumpsys window policy` for the keyguard: whether it is up, and whether it is a secure one (a PIN, a
 * pattern, a password). Read from the `KeyguardServiceDelegate` block, whose `showing=` and `secure=` lines are
 * the only ones of those names in the dump. `null` when either is missing, so an image that words it differently
 * is left alone rather than read as unlocked.
 */
export function parseKeyguard(output: string): { showing: boolean; secure: boolean } | null {
  const showing = output.match(/^\s*showing=(true|false)\s*$/m)
  const secure = output.match(/^\s*secure=(true|false)\s*$/m)
  if (!showing || !secure) return null
  return { showing: showing[1] === 'true', secure: secure[1] === 'true' }
}
