import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// `mcp-server` and `flow-runner` both decorate a session-scoped failure with what the relay has told them
// about that session — `failed()` appends `sessionNote(sessionId)`, so a caller reading "No booted device"
// also learns that the agent reconnected and cleared its binding. The mechanism is shared, so the risk is
// not that it breaks: it is that **one call site stops using it and nothing says so** (#546).
//
// Three anchors were designed and two were broken before this one, and each failure is worth keeping,
// because each is the obvious idea:
//
//  - **Anchor on `throw`.** Misses the sites with the most leverage. `waitFor`'s deadline and the socket's
//    close handler both `reject` from inside a closure, and deleting `sessionNote` from the first removes
//    the cause from *every* waiter's timeout in that file. Neither is a `throw`, and neither closure's
//    enclosing function takes a `sessionId` to key on.
//  - **Allow-list by error class.** Fails open. `PlatformError` is `flow-runner`'s general class, so
//    admitting it passes `queryUITree`'s note-carrying throw *and* the bare `screenshot` one this program
//    had to fix — the two look identical from the class.
//  - **Exempt a method by name.** Fails open more widely. Exempting `awaitInputAck` also exempts the
//    ordinary `failed()` throw inside it — the one #457 exists for.
//
// So the anchor is **construction**, and the judgement is whether the expression reaches a cause path.
// That covers `throw`, `reject`, closures and helpers at once.
//
// Scope is still needed — `send()` and `listBuilds()` construct bare errors and there is no session to
// name — but it is read from the **method body's text**, not its signature. That is the distinction the
// signature could not make: `waitFor` takes `sessionId` as an *optional* parameter and rejects from a
// closure, while `connect()` takes nothing and reaches a session through `w.sessionId`. Both are
// session-scoped; only one says so in its parameters.
//
// **This is a floor, and here is exactly where it stops.** Scope and cause are both read from the
// *innermost enclosing function*, which is coarse in one direction: a function that consults the record
// anywhere before a construction passes every construction after it. Three functions have more than one
// cause call and are therefore only weakly held — both `awaitInputAck`s and `flow-runner`'s `queryUITree`.
// Everything else in these two files has exactly one, so reverting it is caught. Measured that way rather
// than asserted: the four sites this change fixed are each the only cause call in their function. And the
// coarseness is narrowed from the other side — the constructed message must **interpolate** something, so
// a function that reads the record and then throws a constant does not pass on the strength of the read.
//
// One function defeats even that, and it has its own test below: `awaitInputAck` reads `lifecycle` to decide
// whether the optimistic path may run, which is a different question from what its message says. Review
// measured the note being deleted from it while this rule stayed green.
//
// It also cannot see provenance. `new Error(this.sessionNote(id) ? 'x' : 'x')` satisfies it while saying
// nothing. What it holds is the **reversion** — someone deleting the note from a site that had it — which
// is what #546 was filed about.

const root = join(import.meta.dirname, '../..')

/**
 * Classes where **the class is the cause**, so a construction needs nothing else: the session ended, the
 * caller left, the join was refused with a reason, the query should be retried, the relay answered a status.
 *
 * `RequestTimeoutError` and `RelayClosedError` were on this list and had to come off. Their messages read
 * `Request timed out — <note>` and `WebSocket closed — <note>`: the class says *that* the wait ended and the
 * note says *why*, so exempting them let the note be deleted from `waitFor`'s deadline — the single edit
 * that strips the cause from every waiter in the file — while this check stayed green. Mutation testing is
 * what said so.
 */
const SELF_DESCRIBING = new Set([
  'SessionEndedError', 'SessionLeftError', 'SessionJoinError', 'TransientQueryError', 'RelayHttpError',
  // The relay's boot gate refused the boot because the Mac is busy; nothing about the session is the cause.
  'AdmissionRefusedError',
  // A lease refused before any session was chosen: there is no session whose record could explain it.
  'LeaseRefusedError',
])

/** What counts as reaching the cause. `failed()` appends the note; the other two *are* the record. */
const CAUSE = /this\.(failed|sessionNote|lifecycle)\b/

/** The message has to *carry* something, not merely sit near a cause call. Reading the record and then
 *  throwing a constant is the shape the second surviving mutation had — `ui-tree query failed` with the
 *  clause that named the device binding deleted, in a function that consults `lifecycle` for other reasons.
 *  Crude (any interpolation satisfies it) and it closes exactly that. */
const INTERPOLATES = /\$\{/

const FILES = [
  {
    pkg: '@tapflowio/mcp-server',
    path: 'packages/mcp-server/src/client.ts',
    // Measured, and the floor is the measurement rather than a round number: this program's parser failures
    // were all *partial* losses, every one of which left a non-empty result behind.
    //
    // 10 rather than 11: `connectDevice` builds its note inline instead of through `failed()`, because
    // `sessionNote` ranks `away` and `needsReboot` above `terminated` and only `terminated` can be true of
    // a session this client no longer holds — which is the only state a *refused* join can be in. Same
    // shape as `flow-runner`'s `queryUITree` and for the same class of reason.
    failedCalls: 10,
    exempt: [],
  },
  {
    // The session half of the client: waiters, inputs, the lifecycle record. Split out of `RelayClient` so a
    // browser can run it (#1125); the waiter paths and the input-ack wrapper moved with it.
    pkg: '@tapflowio/flow-runner (session channel)',
    path: 'packages/flow-runner/src/sessionChannel.ts',
    failedCalls: 8,
    // Every construction here is session-scoped: the connection failures that had no session to name stayed in
    // `RelayClient` with the socket. The other half of the split is held by that file's entry instead.
    unscoped: false,
    // **Empty, and it started as one entry.** The plan reserved a line-anchored escape for this package's
    // `awaitInputAck` wrapper, which deliberately appends no note because the `e.message` it interpolates
    // already carries one. Reading cause from the enclosing function made the escape unnecessary — and
    // that is a weakening, not a win, so it is named here rather than left as an absence: that wrapper is
    // one of the three constructions this check holds only weakly (see the header).
    exempt: [],
  },
  {
    // What stays on the Node side: the connection, join, boot, lease and the REST reads. Its waits go through the
    // channel's `waitFor`, so the two settle-without-an-answer paths are judged there, not here.
    pkg: '@tapflowio/flow-runner (relay client)',
    path: 'packages/flow-runner/src/RelayClient.ts',
    failedCalls: 3,
    exempt: [],
    ownsWaiters: false,
  },
]

/** Source with comments blanked. Prose in this repo quotes identifiers constantly — `sessionNote` appears
 *  in a dozen comments — so a check that read them would pass on the strength of a sentence.
 *
 *  **Blanked, not removed.** A first version deleted block comments outright, which collapses their
 *  newlines and slides every line number below them; the first run reported four offenders at lines that
 *  hold a type declaration and a doc block. A parser whose *positions* are wrong is worse than one that
 *  finds nothing, because the report looks like a finding. */
function code(path) {
  return readFileSync(join(root, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/**
 * The innermost function containing `at`, as a `[start, end]` line range, found by brace depth.
 *
 * **A class member is the wrong granularity and the first version used it.** `connect()` reaches a session
 * through `w.sessionId` in its close handler and reaches none in its `ws.once('error')` arm — the second is
 * a connection failure with no session to name, and member-level scope demanded a note for it. The arrow
 * function is the unit that separates them.
 */
function enclosingFn(lines, at) {
  // `at` is the construction's line; a candidate opener whose block closes before it is not its function.
  let depth = 0
  for (let i = at; i >= 0; i--) {
    for (const ch of [...lines[i]].reverse()) {
      if (ch === '}') depth++
      else if (ch === '{') { if (depth === 0) { /* opener */ } else depth-- }
    }
    // A line that opens a function and is not yet closed above us.
    // A candidate must **open a block**, or hold the construction on its own line. Requiring only that its
    // range contain the construction was not enough: `const text = await res.text().catch(() => '')` opens
    // no block, so its "range" was itself plus the next line — which is where the construction sat, so it
    // was accepted and the two-line window decided scope. Measured: a newly added `recordVideo(sessionId)`
    // shaped exactly like `screenshot`, ending in a bare `throw new Error`, passed. The same-line clause is
    // what keeps `ws.once('error', (e) => reject(new PlatformError(…)))` its own scope — a connection
    // failure with no session, which the enclosing promise would otherwise lend one to.
    const opensBlock = lines[i].includes('{') || i === at
    if (depth === 0 && opensBlock && /(?:=>|function\b|^ {2}(?:private |protected |public |static |override )*(?:async )?[\w[\]]+\s*[(<])/.test(lines[i])) {
      let d = 0
      let end = lines.length - 1
      for (let j = i; j < lines.length; j++) {
        d += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length
        if (j > i && d <= 0) { end = j; break }
      }
      // **The candidate has to actually contain the construction**, and a first version did not check.
      // `=>` is unanchored on purpose — an arrow is how both files write their handlers — but that makes
      // any earlier line holding one a candidate, and `const text = await res.text().catch(() => '')`
      // closes on itself. Measured before this line existed: 9 of 23 constructions resolved to a two-line
      // range that did not contain them, fell out of scope, and were judged by nothing. Including the
      // shape this change fixed, so a *newly added* bare construction would have passed.
      if (end >= at) return { start: i, end }
    }
  }
  return { start: 0, end: lines.length - 1 }
}

/**
 * Every `new <Class>(` in the file, with the lines around it and whether its member knows a session.
 *
 * The window is **two lines either side**. Backwards is what makes `const note = this.sessionNote(id)` and
 * the `reject(new RequestTimeoutError(note ? … ))` under it one thought; forwards is what reaches a message
 * that continues onto the next line, which is how both `awaitInputAck` wrappers are written. A first
 * version looked backwards only and reported one of them as an offender.
 */
function constructions(src) {
  const lines = src.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/new (\w*Error)\(/g)) {
      const fn = enclosingFn(lines, i)
      const body = lines.slice(fn.start, fn.end + 1).join('\n')
      out.push({
        line: i + 1,
        cls: m[1],
        // The function up to and just past the construction. Everything after is a different failure.
        context: lines.slice(fn.start, i + 3).join('\n'),
        // The construction's own argument list, which is the thing that must carry the cause.
        message: lines.slice(i, i + 4).join('\n'),
        // Text, not signature. `waitFor` takes `sessionId` as an *optional* parameter and rejects from a
        // closure; `connect()` takes none and reaches one through `w.sessionId`. Both are session-scoped
        // and only one says so where a signature could be read.
        sessionScoped: /sessionId/.test(body),
      })
    }
  }
  return out
}

describe('a session-scoped failure carries what the client knows about the session', () => {
  for (const { pkg, path, failedCalls, exempt, ownsWaiters = true, unscoped = true } of FILES) {
    describe(pkg, () => {
      const src = code(path)
      const built = constructions(src)

      it('the parser found the constructions it is meant to judge', () => {
        // Anti-vacuity, and pinned from the measurement. A parser that quietly finds fewer would report
        // full coverage of a subset — the failure this repo has now shipped four times.
        expect(built.length, 'the construction parser found nothing like the measured count').toBeGreaterThanOrEqual(6)
        // Secondary now, and worth saying so: review measured this floor — not the offender test — as the
        // thing catching a deleted `failed()` call, because the scope window had collapsed and most
        // constructions were judged by nothing. With that fixed the offender test does the work and this
        // is back to being what it says it is.
        expect((src.match(/this\.failed\(/g) ?? []).length).toBeGreaterThanOrEqual(failedCalls)
        // Both halves of the scope split have to be non-empty, or the filter above is doing nothing and
        // every offender disappears into "not session-scoped". Measured: each file has both.
        expect(built.filter((b) => b.sessionScoped).length, 'nothing was judged session-scoped').toBeGreaterThanOrEqual(4)
        if (unscoped) expect(built.filter((b) => !b.sessionScoped).length, 'everything was judged session-scoped').toBeGreaterThanOrEqual(1)
      })

      it('every bare Error construction reaches a cause', () => {
        const offenders = built
          .filter((b) => b.sessionScoped)
          .filter((b) => !SELF_DESCRIBING.has(b.cls))
          .filter((b) => !(CAUSE.test(b.context) && INTERPOLATES.test(b.message)))
          .filter((b) => !exempt.some((e) => b.context.includes(e)))
          // `failed()` builds the decorated error itself, so its own construction is the one place a bare
          // one is the point. Recognised by the note being read two lines up, which it is.
          .filter((b) => !/return new \w*Error\(note \?/.test(b.context))
          .map((b) => `${path}:${b.line} — new ${b.cls}(…) with no session note in reach`)
        expect(offenders).toEqual([])
      })

      // **Anchored on the class, because scope cannot hold this one.** Deleting `this.sessionNote(sessionId)`
      // from `waitFor`'s deadline also deletes the only mention of a session in that closure, so the
      // scope test stops considering it and the offender disappears from the general rule above —
      // measured, it survived. These two classes mean *settled without an answer*, which is precisely when
      // nothing else will ever say why, and there are exactly two of them, so naming them costs nothing
      // and does not depend on inferring anything.
      it.runIf(ownsWaiters)('the two paths that settle a waiter without an answer read the record', () => {
        const lines = src.split('\n')
        for (const cls of ['RequestTimeoutError', 'RelayClosedError']) {
          const at = lines.findIndex((l) => l.includes(`new ${cls}(`))
          expect(at, `${cls} is no longer constructed in ${path}`).toBeGreaterThan(-1)
          const fn = enclosingFn(lines, at)
          expect(
            CAUSE.test(lines.slice(fn.start, at + 1).join('\n')),
            `${path}:${at + 1} — ${cls} is built without reading what the relay said about the session, ` +
            'so a wait that ended for a known reason reports only that it ended',
          ).toBe(true)
        }
      })

      // The third path that settles without an answer, and the one the general rule cannot hold: it is a
      // bare `Error`, and its function reads `lifecycle` for an unrelated decision — whether the optimistic
      // path may run — so the cause test passes on that read even with the note deleted. Measured: it did.
      // Anchored on the wording instead, which is stable because it is the contract this package's
      // AGENTS.md states ("could not confirm", never "dropped").
      it.runIf(ownsWaiters)('the input-ack wrapper reads the record', () => {
        const lines = src.split('\n')
        const at = lines.findIndex((l) => /(Could not confirm|was not confirmed)/.test(l))
        expect(at, `${path} no longer builds an unconfirmed-input message`).toBeGreaterThan(-1)
        const fn = enclosingFn(lines, at)
        expect(
          // Either it reads the record itself (`mcp-server`) or it interpolates the wrapped error's own
          // message, which already carries the note from whichever rejection source produced it
          // (`flow-runner`, which declines to append a second copy and says so beside the code).
          /this\.sessionNote\(|\$\{[^}]*\bmessage\b/.test(lines.slice(fn.start, at + 3).join('\n')),
          `${path}:${at + 1} — the unconfirmed-input message neither reads the record nor carries the ` +
          'wrapped error that already did, so what the relay said about the session reaches nobody',
        ).toBe(true)
      })

      it('the self-describing list is not a way to opt out quietly', () => {
        // Every class named above must exist in the repo as a class, so the list cannot be padded with a
        // name that makes an offender disappear. Checked against the file that declares them.
        const declared = new Set([...src.matchAll(/class (\w*Error)\b/g)].map((m) => m[1]))
        const used = new Set(built.map((b) => b.cls).filter((c) => SELF_DESCRIBING.has(c)))
        for (const cls of used) {
          expect(
            declared.has(cls) || src.includes(`${cls},`) || src.includes(`${cls} }`),
            `${cls} is treated as self-describing but is not declared or imported in ${path}`,
          ).toBe(true)
        }
      })
    })
  }

  it('there is no line-anchored escape hatch', () => {
    // The mechanism is kept because a future site may genuinely need one, and emptiness is the fence: an
    // entry appearing here is a claim that a session-scoped failure should carry no cause, and it should
    // have to be argued in a diff rather than added to a list that already has members.
    expect(FILES.flatMap((f) => f.exempt)).toEqual([])
  })
})
