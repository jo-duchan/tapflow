import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// **A client that gives up before the agent does replaces a reason with a bare timeout.** The agents poll
// for a booting device — 90s on iOS, 120s on Android — and then answer `device:boot-error` with what went
// wrong. `mcp-server` waited 30s, *inside* both, so a cold boot past 30 seconds reported a timeout to the
// model while the boot was proceeding normally and its explanation was already on its way (#549).
//
// The two numbers live in different packages and neither imports the other, so nothing could hold them
// together. That is what this file is: not a check that a constant has a particular value — anyone may
// change any of them — but that the relationship between them survives the change.
//
// **The margin is the part that is easy to get wrong, and it is why this is not a bare `<`.** Those agent
// constants bound *one stage* — the wait for the device to report itself up — not the request. A boot also
// lists devices, may shut the device down and erase it, boots it, opens a stream, none of which has a named
// ceiling anywhere. `flow-runner` sat at exactly Android's 120s, which passes an inequality that reads
// `deadline > ceiling` only if you squint, and buys zero room for any of those stages. So the check requires
// room, and names how much.
//
// What it therefore does **not** prove: that the agent answers within the deadline. A margin is an
// allowance, not a ceiling, and no total boot ceiling exists to compare against — #588.

const root = join(import.meta.dirname, '../..')
const read = (p) => readFileSync(join(root, p), 'utf8')

/** How much a client must allow beyond the poll it can see, for the stages it cannot. */
const MIN_MARGIN_MS = 30_000

/** Each entry: where the number lives, and the declaration that carries it. A `_`-separated literal is the
 *  repo's style for these, and the pattern accepts underscores rather than requiring them, so a plain
 *  `120000` is still read rather than silently missed. */
const CEILINGS = [
  {
    what: 'iOS simulator boot poll',
    file: 'packages/ios-agent/src/SimctlWrapper.ts',
    pattern: /BOOT_READY_TIMEOUT_MS = ([\d_]+)/,
  },
  {
    what: 'Android emulator boot poll',
    file: 'packages/android-agent/src/EmulatorLauncher.ts',
    pattern: /BOOT_READY_TIMEOUT_MS = ([\d_]+)/,
  },
]

const DEADLINES = [
  {
    what: 'mcp-server bootDevice',
    file: 'packages/mcp-server/src/client.ts',
    pattern: /BOOT_DEADLINE_MS = ([\d_]+)/,
    // The waiter, not the constant. Reading a declaration says nothing about what `bootDevice` passes.
    usedBy: /'device:boot-error'[\s\S]{0,240}?\n\s+BOOT_DEADLINE_MS,/,
  },
  {
    what: 'flow-runner bootDevice',
    file: 'packages/flow-runner/src/RelayClient.ts',
    pattern: /BOOT_DEADLINE_MS = ([\d_]+)/,
    // Two waiters share one predicate (`bootDevice` and `lease`), so every waiter on it is read, not the first:
    // each capture is the deadline that waiter passes.
    usedBy: /waitFor\(this\.bootAnswers\([^)]*\), ([^,]+),/g,
  },
]

/** All matches, not the first: `exec` stops at match one, so a doc line quoting `BOOT_DEADLINE_MS = 180_000`
 *  above a real `= 30_000` would satisfy every comparison below. The count is asserted separately. */
const valuesOf = ({ file, pattern }) =>
  [...read(file).matchAll(new RegExp(pattern, 'g'))].map((m) => Number(m[1].replace(/_/g, '')))

const valueOf = (c) => valuesOf(c)[0] ?? null

/** The rule itself, as a function, so it can be tested in both directions rather than only asserted. */
const clears = (deadline, slowestPoll) => deadline - slowestPoll >= MIN_MARGIN_MS

describe('a relay client outlives the agent boot it is waiting on', () => {
  it('every constant this check compares was actually found', () => {
    // Anti-vacuity, and it is not ceremony here: the whole check is four regexes over four files, so a
    // rename turns every assertion below into a comparison of `null` — which is neither greater nor less
    // than anything, and `toBeGreaterThan` on it fails loudly, but the *pair* count would silently drop to
    // zero if a list were emptied instead. Both failures are covered by asserting the shape first.
    expect(CEILINGS.length).toBe(2)
    expect(DEADLINES.length).toBe(2)
    for (const c of [...CEILINGS, ...DEADLINES]) {
      expect(valuesOf(c), `${c.what}: ${c.pattern} matched more or less than once in ${c.file}`).toHaveLength(1)
      expect(valueOf(c), `${c.what}: ${c.pattern} found nothing in ${c.file}`).toBeGreaterThan(0)
    }
  })

  it('the waiter is what carries the deadline, not a constant declared beside it', () => {
    // **The mutation this check was blind to, and it is the state that shipped before this slice.** Reading
    // the `const` proves a number exists in a file. It proves nothing about `waitFor`'s second argument —
    // which is where both clients previously had a literal (`30_000`, `120_000`). Declare the constant,
    // leave the literal at the call site, and every other assertion here stays green while the
    // relationship they describe is broken. `contributing/test-and-guard-coverage.md` calls this aiming the
    // mutation at the path that already worked.
    for (const d of DEADLINES) {
      const message = `${d.what}: the boot waiter does not pass BOOT_DEADLINE_MS — a literal there defeats this check`
      if (!d.usedBy.global) {
        expect(read(d.file), message).toMatch(d.usedBy)
        continue
      }
      const passed = [...read(d.file).matchAll(d.usedBy)].map((m) => m[1])
      expect(passed.length, `${d.what}: no boot waiter found`).toBeGreaterThan(0)
      for (const arg of passed) expect(arg, message).toBe('BOOT_DEADLINE_MS')
    }
  })

  it('each client deadline clears the slowest agent poll by the stated margin', () => {
    const slowest = Math.max(...CEILINGS.map(valueOf))
    for (const d of DEADLINES) {
      const deadline = valueOf(d)
      expect(
        clears(deadline, slowest) ? MIN_MARGIN_MS : deadline - slowest,
        `${d.what} is ${deadline}ms against a ${slowest}ms poll — leaves ${deadline - slowest}ms for the ` +
          `stages that have no ceiling (list, shutdown, erase, boot, open stream). Raise it, or lower the poll.`,
      ).toBeGreaterThanOrEqual(MIN_MARGIN_MS)
    }
  })

  // A boot from `flow run` can carry a run reset, which the agent carries out before `device:ready`: its budget, the one
  // step that may be in flight when it runs out, and Android's wait for a `pm clear` that step timed out on (one more
  // step's time) come after the poll. Only flow-runner sends one; MCP never does.
  it('the client that asks for a run reset also clears the reset it asked for', () => {
    const budget = valueOf({ file: 'packages/agent-core/src/utils/runReset.ts', pattern: /RUN_RESET_BUDGET_MS = ([\d_]+)/ })
    const steps = [
      valueOf({ file: 'packages/ios-agent/src/SimctlWrapper.ts', pattern: /RESET_CMD_TIMEOUT_MS = ([\d_]+)/ }),
      valueOf({ file: 'packages/android-agent/src/AndroidAgent.ts', pattern: /RUN_RESET_CMD_TIMEOUT_MS = ([\d_]+)/ }),
    ]
    for (const v of [budget, ...steps]) expect(v).toBeGreaterThan(0)
    const ceiling = Math.max(...CEILINGS.map(valueOf)) + budget + 2 * Math.max(...steps)
    const deadline = valueOf(DEADLINES.find((d) => d.what === 'flow-runner bootDevice'))
    expect(
      deadline - ceiling,
      `flow-runner bootDevice is ${deadline}ms against ${ceiling}ms of poll, reset budget and two reset steps`,
    ).toBeGreaterThanOrEqual(MIN_MARGIN_MS)
  })

  // Flow Capture's dialog resets a device the session already holds (#1139): no boot poll, but an iOS reinstall can be
  // the step in flight when the budget runs out — finding the bundle and uninstalling at one command's bound each, the
  // install at its own — and one more step after it, as at a boot.
  it('the dialog that resets a held device clears the reset it asked for', () => {
    const file = 'packages/dashboard/lib/flowCapture/channel.ts'
    const budget = valueOf({ file: 'packages/agent-core/src/utils/runReset.ts', pattern: /RUN_RESET_BUDGET_MS = ([\d_]+)/ })
    const command = valueOf({ file: 'packages/ios-agent/src/SimctlWrapper.ts', pattern: /RESET_CMD_TIMEOUT_MS = ([\d_]+)/ })
    const install = valueOf({ file: 'packages/ios-agent/src/SimctlWrapper.ts', pattern: /REINSTALL_TIMEOUT_MS = ([\d_]+)/ })
    const steps = [
      command,
      valueOf({ file: 'packages/android-agent/src/AndroidAgent.ts', pattern: /RUN_RESET_CMD_TIMEOUT_MS = ([\d_]+)/ }),
      valueOf({ file: 'packages/ios-agent/src/IOSAgent.ts', pattern: /RUN_RESET_PASTEBOARD_TIMEOUT_MS = ([\d_]+)/ }),
    ]
    for (const v of [budget, install, ...steps]) expect(v).toBeGreaterThan(0)
    const ceiling = budget + 2 * command + install + Math.max(...steps)
    const deadline = valueOf({ file, pattern: /RUN_RESET_WAIT_MS = ([\d_]+)/ })
    expect(
      deadline - ceiling,
      `the dialog waits ${deadline}ms for a reset against ${ceiling}ms of budget, a reinstall and one more step`,
    ).toBeGreaterThanOrEqual(MIN_MARGIN_MS)
    // The waiter, not the constant: the wait it passes is what gives up.
    expect(read(file)).toMatch(/'device:run-reset-error'[\s\S]{0,160}?\n\s+RUN_RESET_WAIT_MS,/)
  })

  it('the rule rejects the state that motivated it, not just states far from it', () => {
    // The check's own strictness, exercised in both directions against the exact numbers this slice found:
    // `flow-runner` was 120_000 against Android's 120_000. A bare `>=` calls that fine and a bare `>` calls
    // it a defect by one millisecond; neither says what is actually wrong, which is that a boot has several
    // unbounded stages to get through after the poll it can see.
    expect(clears(120_000, 120_000), 'equal is not clearing it').toBe(false)
    expect(clears(120_000 + MIN_MARGIN_MS - 1, 120_000), 'one short of the margin is still short').toBe(false)
    expect(clears(120_000 + MIN_MARGIN_MS, 120_000)).toBe(true)
  })

  it('names what it cannot see, on both platforms', () => {
    // Both ceilings are **defaults**, so either caller may pass its own and this check would not know. The
    // reachable half is asserting that the in-repo callers do not — and it has to cover both, since a
    // one-platform version reads as coverage while leaving the other free to drift. What stays unseen is
    // written down rather than implied: the stages with no ceiling at all (`listDevices`, `shutdown`,
    // `erase`, `boot`, opening the stream), which is what `MIN_MARGIN_MS` is the allowance for.
    const androidCalls = [...read('packages/android-agent/src/AndroidAgent.ts').matchAll(/waitForBoot\(([^)]*)\)/g)]
      .map((m) => m[1])
    expect(androidCalls.length, 'no waitForBoot call found — did it move?').toBeGreaterThan(0)
    for (const args of androidCalls) {
      expect(args.split(',').length, `waitForBoot(${args}) passes its own timeout, which this check cannot see`).toBe(1)
    }

    // iOS takes its override in an options bag, and the in-repo caller passes that bag — with `isStale` and
    // no `timeoutMs`. So the assertion is on the key, not on the argument count.
    const iosCalls = [...read('packages/ios-agent/src/IOSAgent.ts').matchAll(/waitUntilBooted\(([^)]*\})?[^)]*\)/g)]
      .map((m) => m[0])
    expect(iosCalls.length, 'no waitUntilBooted call found — did it move?').toBeGreaterThan(0)
    for (const call of iosCalls) {
      expect(call, `${call} sets its own timeoutMs, which this check cannot see`).not.toContain('timeoutMs')
    }
  })
})
