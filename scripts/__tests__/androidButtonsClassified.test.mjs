// Every button the Android agent reports has a group in the dashboard, or it does not render.
//
// **The dashboard owns where buttons go and the agent owns which exist** (#634,
// `packages/dashboard/AGENTS.md` → "Where a new device button goes"). `AndroidViewer` therefore names
// its own order and looks each button up, instead of rendering the agent's array in array order —
// which is how that capability list's ordering used to leak out as a layout decision, leaving Android
// ordered by the agent while iOS was ordered by the dashboard.
//
// The cost of that split is what this check exists for: a name the agent adds and no group claims
// **silently does not appear**. That is the right default — a new button turning up wherever the array
// happened to put it is the problem being fixed — but "silently" is only acceptable if something says
// so at the moment it happens. This is that something.
//
// What it does **not** hold: which group each button is in. That is a judgement the rule in AGENTS.md
// exists to make cheap, and restating the two lists here would assert the code against itself.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const AGENT = join(ROOT, 'packages/android-agent/src/AndroidAgent.ts')
const VIEWER = join(ROOT, 'packages/dashboard/components/device/AndroidViewer.tsx')

/** The `name:` fields of the agent's `ANDROID_BUTTONS` array. */
function agentButtons() {
  const src = readFileSync(AGENT, 'utf8')
  const start = src.indexOf('const ANDROID_BUTTONS')
  expect(start, 'ANDROID_BUTTONS is gone — this check no longer guards anything').toBeGreaterThan(-1)
  const block = src.slice(start, src.indexOf('\n]', start))
  return [...block.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1])
}

/** Every name the viewer places in a group. */
function classifiedButtons() {
  const src = readFileSync(VIEWER, 'utf8')
  const names = []
  for (const list of ['NAVIGATION_BUTTONS', 'DEVICE_BUTTONS']) {
    const start = src.indexOf(`const ${list}`)
    expect(start, `${list} is gone from AndroidViewer`).toBeGreaterThan(-1)
    const block = src.slice(start, src.indexOf(']', start))
    names.push(...[...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
  }
  return names
}

describe('the Android toolbar places every button the agent offers', () => {
  it('reads both ends, so neither side can be empty and pass', () => {
    // Anti-vacuity floor from the measured counts: a regex that matched nothing would satisfy every
    // assertion below by comparing two empty sets.
    expect(agentButtons().length, 'the agent list parsed as empty').toBeGreaterThanOrEqual(6)
    expect(classifiedButtons().length, 'the viewer lists parsed as empty').toBeGreaterThanOrEqual(6)
  })

  it('leaves nothing the agent reports without a group', () => {
    const missing = agentButtons().filter((b) => !classifiedButtons().includes(b))
    expect(
      missing,
      'These buttons come from the agent and no group in AndroidViewer claims them, so they do not\n'
      + '  render at all. Put each one in NAVIGATION_BUTTONS or DEVICE_BUTTONS — the rule for choosing\n'
      + '  is in packages/dashboard/AGENTS.md, "Where a new device button goes".',
    ).toEqual([])
  })

  it('hands each list to the slot it is named for', () => {
    // **The seam the two guards left open.** This file checks the lists and
    // `SimulatorToolbar.groups.test.tsx` checks the toolbar with stand-in buttons — and nothing
    // between them checks that the lists reach the slots. Measured: swapping the two arguments, or
    // dropping `deviceSlot={deviceSlot}`, left the whole dashboard suite and this one green while
    // half the Android toolbar vanished or landed in the wrong group.
    //
    // A spelling assertion, and a floor rather than a fence — but not self-referential: it pins the
    // wiring, which is a different fact from the lists it pins elsewhere.
    const src = readFileSync(VIEWER, 'utf8')
    expect(src).toContain('const navigationSlot = buttonsIn(NAVIGATION_BUTTONS)')
    // The Device group's buttons sit behind the toolbar's "⋯" menu since #785's follow-up, the same
    // menu iOS uses, so the list reaches the slot through the menu's items rather than `buttonsIn`.
    expect(src).toMatch(/const deviceSlot = \(\s*<ToolbarOverflowMenu[\s\S]*?items=\{DEVICE_BUTTONS\b/)
    expect(src, 'a slot is built and never passed').toContain('navigationSlot={navigationSlot}')
    expect(src).toContain('deviceSlot={deviceSlot}')
  })

  it('places each button once', () => {
    // A name in both groups would render twice, in two places, which is worse than not rendering.
    const seen = classifiedButtons()
    expect(seen, 'a button is in more than one group').toEqual([...new Set(seen)])
  })
})
