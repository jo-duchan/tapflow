---
type: rules
topics: [dashboard, react, ui]
status: living
---

# dashboard — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## Design Reference

Before any design or frontend work, read **[DESIGN.md](./DESIGN.md)** and follow the color tokens, typography, and elevation rules defined there.

## WHAT

React SPA team dashboard: provides the simulator viewer, build comments, and team invite screens.
The audience is the whole team (PO, PM, designers, backend, QA) — not just QA. See root [AGENTS.md](../../AGENTS.md) for the two testing modes (manual vs. AI Agent via MCP).
**No standalone deployment** — bundled to `dist/` via `vite build`, then copied to the relay package's `public/` directory and served directly by the relay server.

### App Center Structure

`/app-center` route. Left app list sidebar + center Release Accordion + Build cards.

- **App sidebar**: `GET /api/v1/apps` → selecting an app manages state via `?appId=N` URL parameter.
- **Release Accordion**: `GET /api/v1/builds?app_id=N` → grouped by `version_name` (`groupByRelease()`). No dedicated `releases` table — UI grouping uses `version_name` metadata.
- **Build card**: shows `build_number`, `platform`, `status_label`, uploader, `uploaded_at`. Inline status dropdown. **"Start QA" CTA** → `/app-center/build?id={build_id}`.
- **Viewer is read-only**: `AppCenter` reads the role once (`useAuth`) and passes `canWrite` down. For a Viewer the build card draws no status dropdown or deletion button, and **Add App** / **Upload build** stay as plain buttons whose click raises a toast instead of opening a dialog. The relay enforces the same rule (`assertCanWrite`), so this only decides what is offered.
- **Upload**: `UploadBuildDialog` — iOS `.app.zip` or `.tar.gz`/`.tgz` (EAS simulator build) / Android `.apk`. `version_name` / `build_number` are auto-extracted from plist, so no manual input fields.

## HOW

- **Stack**: Vite + React 19 + React Router v7 + Shadcn/Tailwind + next-themes
- **Structure**: `src/` — app entry, router, pages; `components/` — shared components; `hooks/` — custom hooks; `lib/` — utils, types, API client
- **Routing**: `BrowserRouter`-based. `/login` and `/invite` are public. Everything else is protected by `DashboardLayout` via `useAuth` (redirects to `/login`).
- **Auth**: Session confirmed via `GET /api/v1/auth/me`. HttpOnly cookie (not readable from JS).
- **Streaming**: set `binaryType = 'arraybuffer'` in `useRelay`, branch on `e.data instanceof ArrayBuffer` for binary frames.
- **Message shapes live in [`@tapflowio/protocol`](../protocol/AGENTS.md)**, imported with `import type` so nothing lands in the bundle. `send()` takes `BrowserToRelay`, so a new outbound message has to be added to that union first. What the viewer *receives* is **`BrowserInbound`**, re-exported from `lib/types.ts` so view code keeps one import site.
  - This package used to hand-copy that inbound union as a local `RelayMessage`, and it drifted: three error types were `sessionId?` against protocol's required, `session:joined.capabilities` was optional against required, four members were declared with no `sessionId` the wire always carries, and four more were missing entirely. Nothing reported any of it. The name also collided with the relay's own `RelayMessage`, which is its *inbound* type — a different set.
  - **Do not type an injected test message with `as never` or a local shape.** Both accept anything, so the fixture is free to disagree with the wire and the suite will not say so. `useClipboardBridge.test.tsx` builds replies as `ClipboardBridgeMessage` via an annotation; when that replaced `as never`, five fixtures in `DeviceViewer.rebind.test.tsx` turned out to be sending a `device:booting` with no `sessionId` — a message the wire does not produce, and one that bypasses the viewer's session scoping.
- **Dev server proxy**: `vite.config.ts` proxies `/api` and `/uploads` → `http://localhost:4000`.
- **An address for someone else comes from `lib/publicLink.ts`** — an invite link, a link to a comment, the relay address in the agent command. The browser's own `location.origin` is right for this page and wrong for a teammate: on the Vite server it is `localhost:3001`, which is how #788 was found. The relay reports what its settings mean and the helper only falls back. `useRelay` is the exception, because it connects this page to its own relay. `scripts/__tests__/teammateUrlsSingleSource.test.mjs` fails on a `location` read other than `pathname`/`search`/`hash`/`hostname`/`protocol` outside the files it allows.
- **Build order**: dashboard first → relay second (`agent-core → dashboard → relay`).

### The React Compiler is on

`babel-plugin-react-compiler` runs on this package through `reactPlugin.ts` — **shared by
`vite.config.ts` and `vitest.config.ts` on purpose.** The test run used to build its own `react()`
without the compiler, which would have left the suite exercising source the product does not ship.

**Two configs need two guards, and for a while only one had one.** Everything the compiler does is
an optimisation, so a config that quietly stops applying it fails nothing else.

- `src/__tests__/reactCompilerOn.test.tsx` asserts the emitted memo-cache read. It runs *under
  vitest*, so what it proves is that `vitest.config.ts` applies the compiler.
- `scripts/__tests__/dashboardFirstLoadBudget.test.mjs` asserts that the built entry chunk contains
  `react.memo_cache_sentinel` — a string literal the compiler writes into every function it caches
  for, which survives minification and lands in app code only when app code was compiled. On an
  uncompiled build it appears in the React vendor chunk alone, where React itself defines it.

Measured: deleting `reactWithCompiler()` from `vite.config.ts` alone leaves the first test green and
ships an uncompiled bundle. The second one fails on it.

`reactPlugin.ts` sits at the package root, which used to be outside both gates — `lint` globbed
`*.config.ts` and the tsconfig included only `src`/`components`/`hooks`/`lib`. The `lint` glob is
`*.ts` now, so every root TypeScript file is linted; a root `.mjs` (`postcss.config.mjs` is one) or
a root `.tsx` is still outside it.

**The tsconfig lists the root configs one by one, and `vitest.config.ts` is deliberately not among
them.** `build` is `tsc --noEmit && vite build`, so whatever the tsconfig includes becomes a
dependency of the *production image build* — and the Docker builder copies `packages/` and the
workspace manifests, not the repo root. Globbing `*.ts` there was tried and the image build died on
`TS2307: Cannot find module '../../vitest.shared'`, with every local check green; it is the Docker
job in CI that says so. Copying that file into the image context would have moved the fragility
rather than removed it, since the next test-only root file breaks it again. So the tsconfig covers
what the build itself loads, and `vitest.config.ts` keeps exactly the coverage it always had —
linted, not type-checked.

**Stop adding `useCallback` and `useMemo` for identity.** The compiler does that. What is here, in
product code (`src`/`components`/`hooks`/`lib` minus `__tests__`): 62 `useCallback`, 3 `useMemo`, and
**zero** `memo()` components — so most of that is stabilising effect dependencies by hand. Existing ones are not worth a sweep; new ones need a reason that is not
"so the child does not re-render".

Measured 2026-09-22: **158 functions compiled, 15 skipped.** A skip is safe — the compiler leaves the
function alone rather than guessing — and **none of the 15 is ours.** Fourteen are syntax it cannot
lower yet, nine of them `try`/`catch` shapes (value blocks inside a `try`, a `finally` clause, a
`throw` inside a `try`), plus `UpdateExpression` on a variable captured in a lambda and dynamic
`import()`. The fifteenth is an internal invariant in `useClientRecording.ts`, recorded at the top
of that file with both its bails and why neither is worth working around.

`src/__tests__/noSuppressedCompilation.test.ts` is what keeps that "none of the 15 is ours" true. It
runs the compiler over the package and fails on any skip whose **reason** is a suppression, which is
the only kind anybody here can cause. A bundle check cannot do this job — one suppressed component
removes its share of 161 sentinels and leaves the rest, and 73 of them sit in a lazy chunk the build
guard never opens.

It must drive the Babel the *build* drives, and it asserts that rather than assuming it: `@babel/core`
is a devDependency here and a dependency of `@vitejs/plugin-react`, so the two are one install only
while their ranges agree, and the test compares the resolved paths. Measured, 8.0.6 and 7.29.7
disagree about whether `AndroidViewer` compiles — a drift would have the census reporting on a
toolchain nothing ships. Comparing resolution rather than pinning exact versions, because a pin is a
rule nothing enforces while this fails the moment pnpm hands the plugin a different copy.

#### What an `eslint-disable` costs the compiler, stated as measured

`AndroidViewer` and `IOSViewer` compiled **nothing** until #830, and the cause was easy to read too
broadly. Probed directly, it is narrower on both axes:

- **Per function, not per file.** A file with four components, one carrying a suppression, compiles
  the other three. It looked file-wide on the viewers only because each of those files is a single
  component, so the one skip was the whole file.
- **Exactly two rules, and they are a hardcoded list.**
  `DEFAULT_ESLINT_SUPPRESSIONS` in `babel-plugin-react-compiler@1.0.0` is
  `['react-hooks/exhaustive-deps', 'react-hooks/rules-of-hooks']`, overridable through the
  `eslintSuppressionRules` option, which we do not set. Suppressing anything else costs nothing.

**The list is not "the rules the compiler validates", and guessing that gets it wrong both ways.**
`react-hooks/purity`, `refs`, `immutability`, `globals` and `set-state-in-effect` are all in the
compiler's own diagnostics table at `severity: "Error", recommended: true`, and suppressing any of
them compiles fine — `src/pages/QASession.tsx` and `components/ui/sidebar.tsx` each carry a `purity`
suppression and both compile. `rules-of-hooks` is **not** in that table and does bail, which is the
direction that costs something: it reads as the safe one and it is not. Probed directly rather than
reasoned about, because the first reading of this was wrong.

So the cost of a suppression is real, local and narrow: it is the function it sits in, for two rule
names, and it is silent, because a skipped function still works. Removing one is how the two viewers
went from 0 to 1 each.

`react-hooks/set-state-in-effect` is **on**, like the other 15 rules of `eslint-plugin-react-hooks@7`'s
recommended set. It was off over 15 violations until #845 cleared them. It is one of the compiler's own
diagnostics but not one of the two names above, so a suppression of it costs no compilation. That makes
it cheap, which is why suppressions are held to one kind of case.

When it fires, ask what the state *is*, then use the answer:

- **Derived from props or other state?** Compute it during render. `usePerfMode` is an example: visible
  means perf mode and not hidden by the shortcut.
- **Reset when a prop changes?** Adjust it during render against the previous value, as
  `useDeviceReboot` does for `pending`, `useNetworkControl` for a new session and AndroidViewer for a
  frame the description has moved past. Keep a ref's half of the reset in an effect, since refs cannot
  be written during render. Or put the state in a child that unmounts, as `DeepLinkDialog` does with its
  field inside the dialog's content. **Do not key a reset on a value that can come back.** AndroidViewer
  first stored "ahead of *this* description", and a description that went A → B → A was ahead again
  with no new frame behind it.
- **Read from outside React?** Use `useSyncExternalStore` (`useIsMobile`), or read it once as the initial
  state (`SimulatorInfoCard`'s dismissal).
- **Server data?** Read it with Query (below). The rule does not flag `setState` inside `.then()`, so
  a fetch in an effect passes the lint and still breaks that section.

**A suppression is for syncing with a timer or an external system, and it carries its reason on the
line.** There are two. `useFlowingNow` catches the clock up on resume: `Date.now()` cannot be read in
render, and deferring it to a 0 ms timer would draw a frame of the old window (#751).
`useNetworkControl`'s readiness effect sets a position that depends on `everReady`, a ref the same
effect raises, so the two cannot be split between render and effect. Its session reset was suppressed
too at first, with a reason that turned out to be false. Nothing later read the state it reset, so it
moved to render.

### Server data is read with TanStack Query, not fetched in an effect

A page that owns server rows in `useState` and fills them from a `useEffect` has to hand-roll three
things, and the App Center had none of them: a pending state that covers the gap between the click
and the effect, a way to drop a response that arrives after the selection moved on, and a failure
path that is distinguishable from an empty result.

What that cost, measured on one page: switching apps cleared `builds` synchronously while `loading`
was still `false`, so one commit rendered "No builds yet" for an app nobody had asked about — the
flicker this rule exists because of. A slow response for app A could paint its rows under app B.
And a failed fetch fell into the empty state, so "the request failed" and "this app has no builds"
looked the same.

So: `useQuery` for reads, `useMutation` with an optimistic write for actions on those rows.

- **The query key carries every input the request depends on** — `['builds', appId, search,
  statusFilter]`. That is what makes a late answer harmless: it lands under a key nobody is
  rendering. A key that omits an input is a stale-response bug with no symptom until someone clicks
  twice quickly.
- **`placeholderData: keepPreviousData` on anything a user switches between.** Without it the page
  re-renders with no rows while the next set loads, and a page with no rows is the empty state.
- **State derived from a fetch is read against the rows it came from.** The App Center works out
  which releases are open during render, from the rows on screen and the app *those rows* belong to
  (`builds[0].app_id`), not the app selected. During the placeholder window the held rows are judged
  by the previous app's toggles, and the new app's are used once its own rows land.
  `AppCenter.switch.test.tsx` holds both halves: the previous list stays, and the new one opens when
  it lands. An earlier version seeded the open set from an effect instead, and #834 found the cost: a
  header focused in a layout effect was announced collapsed before the seed expanded it.
- Defaults live in `lib/queryClient.ts` (`retry: 0`, `refetchOnWindowFocus: true`) with the reason
  for each.

Every page reads through Query now (#845), and so do `useAuth`, the sidebar, the recordings list and
the comment panel. The comment panel was missed in #845 and found by the review of the lint below.
Keys live in `queryKeys` in `lib/queries.ts`, so a mutation invalidates the key a page reads rather than
a spelling of it. Where a list can fail, `ListStateRow` shows loading, the failure with a retry, or empty.
It never shows the failure as "none yet".

**A new fetch in an effect fails lint.** `set-state-in-effect` cannot catch one, because it does not
flag `setState` inside `.then()`. So `eslint.config.mjs` flags the call itself: `fetch` or `api.*`
inside `useEffect`/`useLayoutEffect`, including the `React.useEffect` form.
`scripts/__tests__/dashboardNoFetchInEffect.test.mjs` plants these and checks the rule still fires.
Two limits, both written beside the rule:

- **It does not see function boundaries.** A `fetch` in an event handler that an effect registers is
  flagged too. Today there are none. If one appears, suppress that line with the reason.
- **It sees a call only where it is written.** A fetch inside a `useCallback` that the effect calls
  passes. That is not a rare shape: CommentPanel's `load()` was exactly this and passed until review.
  A helper such as `getBuild()`, `window.fetch`, or a renamed `api` import also passes. A reviewer has
  to look for these.

## Testing

- `pnpm test` is always run foreground (terminal). **Never run vitest as a background process** — worker forks accumulate as zombies and exhaust CPU/RAM.
- If a test appears to hang, Ctrl+C immediately and diagnose. Do not re-run without fixing the root cause.
- Components that combine several queries + `react-hook-form` `Controller` + `useWatch` (e.g. `DefaultSettings`) can hang in jsdom under full render. `vitest.config.ts` has `testTimeout: 10000` as a safety net — a timeout failure means the test setup needs fixing, not more retries.
- When mocking `fetch` in a component that makes several concurrent requests (e.g. `GET /api/v1/settings` + `GET /api/v1/apps`), use URL-based dispatch (`mockImplementation((url) => {...})`) instead of `mockResolvedValueOnce` chains — call order is non-deterministic.

### Every browser-inbound message has a declared disposition

`lib/inboundDisposition.ts` says, for each of the 29 messages a browser socket can receive, either which
files handle it or why it is deliberately ignored. It is written with
`satisfies Record<BrowserInbound['type'], Disposition>`, so **a message added to the wire breaks that file**
until someone picks a category.

`mcp-server` and `flow-runner` have the same table as of #544, with their own categories and a check that
also holds an `ignored` entry to the absence of a handler.

It exists because "handled elsewhere", "deliberately ignored" and "nobody wrote it" all look like an absent
branch. Six messages were being dropped and the three reasons were indistinguishable — one of them turned
out to be a real bug hiding inside a *handled* type (`error`, whose meaning was carried in free prose).

**Do not branch on a message's `message` field.** It is prose the producer owns. `error` carries a closed
`reason`; branch on that, exhaustively.

### The lifecycle replies are correlated **selectively**, and the exceptions are the point

`DeviceViewer` mints a `requestId` for every `device:boot` it sends and gates on it — but not uniformly,
and the disposition table above cannot show the difference. Three rules, each holding a defect shut:

- **An *uncorrelated* `device:boot-error` is always reported, and a correlated one only when it answers
  the boot this viewer is still waiting on.** The first half is #426: `AndroidAgent.restartVideoStream`
  sends this message for a stream that died mid-session, with no `device:boot` behind it and so no id it
  could carry, and this branch is the only surface that reports it — gate that and a dead stream becomes a
  picture that has quietly stopped updating. The second half arrived with #526: both agents now answer a
  boot they abandon rather than going silent, so the id of a boot **this viewer replaced itself** comes
  back as a failure while its replacement is running normally.
  Judged against the latest boot id, **never against `bootIdsRef` membership**. `session:joined` clears
  that set and it arrives again on every socket reconnect, so one Wi-Fi blip leaves a still-running boot's
  id outside the set — a membership gate would then report exactly the failure this rule exists to
  suppress. The gate sits above the `rebindRef` release for the same reason: the boot that replaced this
  one owns that release.
- **`setDeviceReady(true)` runs before the gate.** The relay replays a cached `device:ready` to a
  re-joining viewer as `{ type, payload }` — no `sessionId`, no correlator — and clearing the spinner is
  what that replay is *for* (#440).
- **Everything else on `device:ready` is gated, with absent accepted.** A mismatched id is rejected; an
  absent one is not, because both the replay and an agent predating the echo arrive that way — and while
  the correlator is optional those two are indistinguishable. So what this newly catches is a straggler
  from an earlier boot cycle releasing the current rebind, and *not* the replayed ready firing a duplicate
  install, which stays as it was.

And a fourth rule, about the set rather than the gate — **`bootIdsRef` is cleared on `session:joined` and
nowhere else.** Not on `device:booting`, even though that branch is where every other per-cycle record is
dropped and its comment says so: both agents send `device:booting` *before* the `device:ready` answering the
same boot, so a boot id has to span it. Clearing it there rejects every real ready, and the failure is quiet
in the worst way — the spinner clears, the device looks healthy, and the app is never installed. That one
was found by review after the first three were already pinned: the tests held what the gate did **with** an
id and nothing held how ids entered or left the set.

Getting any of the three the other way round passes typecheck and most of the suite:
`src/__tests__/DeviceViewer.lifecycleCorrelation.test.tsx` is what fails. Nothing else can — the
correlator on these replies is optional, so neither the compiler nor
`scripts/__tests__/correlatedRequestsGated.test.mjs` sees this pair at all. Background:
「Lifecycle correlation」 in [protocol/AGENTS.md](../protocol/AGENTS.md).

### `input:error` is shown per input, and there is no session-level input state

A failed input surfaces as a toast keyed on the wire `reason` (`lib/inputErrorNotice.ts`), or is shown
nowhere for the two reasons that fix themselves. `input:done` is **not handled at all**.

A latched "input unavailable" line on the status card was designed and discarded, and it will look
like the obvious improvement to whoever reads this next. It cannot be made honest on the current
protocol, for three independent reasons:

- **Nothing announces that input is working again.** iOS replaces a dead helper eagerly and is
  injecting ~200ms later with no message to the browser, so no edge carries *evidence of input health*.
  Lifecycle messages do arrive — `session:rebound` on an agent restart, `session:joined` on a socket
  reconnect, both already handled above — but neither is that evidence: with a helper binary still
  missing (#464) a rebound would clear the latch and the next tap would raise it again. The only
  signal that would mean anything is a successful input, and `channel-unavailable`'s own advice is *do
  not blindly retry*, so a latch's clear edge needs the tester to do what the UI just told them not
  to.
- **The acks are unordered.** A success is awaited and a refusal is not, so an earlier input's
  `input:done` can arrive after a later input's `input:error` and clear a latch that is still true. Not
  via `ackInput`'s boot verify, which looks like the culprit and is cached on `device:ready` — the
  paths that reorder on every input are Android awaiting the dispatch itself before acking
  (`pressButton` → `adb shell input`, measured 26–29ms steady state) and iOS acking a key only after
  awaiting `hideSoftwareKeyboard`, while a `malformed` or `channel-down` refusal reaches `ws.send`
  within microtasks.
- **An ack does not say which channel answered.** On Android a button always takes the adb path, while
  touch takes the pointer channel whenever a video backend is up — which is every streaming session,
  the only kind a tester has. So pressing Home to check whether input works at all succeeds on a
  session whose touch channel is dead, and under the latch that success erased the warning.

Instead the toast's own lifetime carries the state: repeats reuse `id`, which sonner refreshes rather
than stacks, so it stays up while inputs keep failing and fades on its own when they stop. **Being
observed rather than stored is the point** — there is no clear edge to get wrong.

Copy lives here rather than in the agents because `message` on the wire is free prose each agent owns
and cannot be localised; `reason` is the contract. `message` rides along as the description, where its
diagnostic detail (`unknown key code: KeyFoo`) belongs. Absent or unrecognised reasons resolve to
`channel-unavailable` — absence means *unknown*, never *fine*.

Suppressed entirely while the agent is away. An absent agent cannot send this, so in that state the
*relay* answers every terminal input itself (`agent offline`, `channel-unavailable` since #492); a
tapping tester would refresh the toast indefinitely, with advice contradicting the status card, which
already says the relay is holding the session open and waiting.

A persistent indicator needs a protocol-level input-health signal, or acks that identify their channel
and arrive in order. Two tests guard the decision (`DeviceViewer.inputError.test.tsx`): `input:done`
must do nothing, and a success between two failures must change nothing.

## Where a new device button goes

The device toolbar has four groups, and they are ordered by **what the tester is doing to the
device**, not by how the feature is built:

> **Navigation → Device → Capture → Environment**, and inside each group the ones reached for most
> come first.

| Group | What belongs in it | Today |
|---|---|---|
| **Navigation** | Move around the app or the OS. Press it and it is over. | launch, home, back, recent apps, deeplink |
| **Device** | Leave the device in a condition that stays until somebody changes it back. | software keyboard, volume, sleep, rotate, restart |
| **Capture** | Take the current state out of the session. | screenshot, recording |
| **Environment** | Change what the device is sitting in. | network on/off |

**This exists so that "where does this go?" has an answer before anyone argues.** GPS mock →
Environment. Shake → Device. Log download → Capture. A deeplink is Navigation and not a tool,
because from the tester's side it is "go to this screen" rather than "type a URL".

**A restart is Device rather than a group of its own**, and it closes that group: it acts on the
device the way the power button does, and inside a group the order runs frequent → rare. It is also
the only control here a tester cannot undo, which is why it is the only one behind a confirmation —
the placement rule decides *where*, and destructiveness decides *what it takes to fire it*. Wiping
stays on the selector screen; two irreversible buttons side by side is how #439's accidental erase
happened.

Sticky beats momentary when a button could be read either way — the keyboard is Device, not
Navigation, because a keyboard left up stays up. That is the same reasoning `networkLook` in
`SimulatorToolbar.tsx` gives for the network control having the toolbar's only colour: *a state a
tester deliberately put the device into and will forget about, and forgetting is what makes the next
hour of testing confusing.*

### The order is the same on both platforms, on purpose

A tester moving between iOS and Android should find rotate at the end of Device and the network
control alone in Environment on both. That is why the toolbar takes `navigationSlot` and `deviceSlot`
rather than one `platformSlot`: the viewers hand it buttons already sorted into groups, so where a
button belongs is decided in one place instead of two.

**How far that is enforced, exactly.** `SimulatorToolbar.groups.test.tsx` holds the toolbar's own
group order with stand-in buttons, and `scripts/__tests__/androidButtonsClassified.test.mjs` holds
that every agent button is classified and that each list reaches the slot it is named for. The last
of those is a source-text check — a floor, not a fence. **Nothing renders `AndroidViewer` or
`IOSViewer`**, so a viewer that builds its slots some other way would pass; that is the gap to close
if this ever drifts.

**The dashboard owns the order; the agent owns what exists.** Android's buttons arrive from the
agent's `ANDROID_BUTTONS`, which is a *capability* list — the key codes are why it lives there.
Rendering it in array order leaked that list's ordering out as a layout decision: **a reorder in
`android-agent` moved buttons in the browser**, with nothing on either side to notice. The two
platforms did not actually diverge — the shared buttons sat in the same relative places all along —
so this closes a way for them to, rather than repairing a way they had. `AndroidViewer` names its own
order and looks each button up; a name the agent reports that no group claims does not render, which
is deliberate — a new key code appears once somebody has decided where it belongs, rather than
turning up wherever the array happened to put it.

### When a group gets too long

Nothing is collapsed today: iOS shows eight buttons and Android twelve, which a vertical toolbar
still carries. The point to reconsider is when a single group needs more than about four — that is
when its low-frequency members should move behind a popover and the frequent ones stay on the
surface, rather than the toolbar growing until it runs off the screen.

**Android's Navigation group is already there**, at five whenever a build is loaded: launch, home,
back, recent apps, deeplink. So the threshold is crossed rather than approaching, and it was
Navigation that crossed it — not Environment, which is the group whose *future* members (location,
battery, appearance, locale, time zone, permissions) make it the one to watch next.

**And Device followed it**: the restart (#628) takes Android's Device group to four and iOS's to
three. Both are at the threshold rather than over it, so nothing moves yet — but the next button
either platform adds to Device is the one that should arrive with a popover rather than a slot.

## HOW NOT

- Do not reintroduce the `next` package.
- Do not call the Agent directly from the dashboard — always go through the relay.
- Do not put platform-specific conditionals (`if platform === 'ios'`) in UI components.
- Do not send session recording data to external storage.

---

## Compound

### WebSocket Binary Frame Reception

**When**: receiving and rendering binary stream frames

**How**: `useRelay` receives binary frames (set `socket.binaryType = 'arraybuffer'`, else `e.data` is a `Blob`); `IOSViewer` / `AndroidViewer` render via a decoder chosen by `pickDecoder` (`lib/decoders/`) — WebCodecs on secure contexts, WASM (tinyh264) on plain HTTP, `createImageBitmap` for the JPEG fallback.

**Why** (not obvious from the code):
- Both H.264 tiers paint **straight to a canvas with no `<video>` media element** — WebCodecs decodes to a `VideoFrame`, WASM (tinyh264) decodes to I420 rendered by `YUVWebGLRenderer` — so there is no media-element buffer adding latency. H.264 is hardware-decoded (WebCodecs) on secure contexts; only the JPEG fallback is CPU-decoded (`createImageBitmap`).
- Release the GPU texture/frame every frame (`bitmap.close()` / `VideoFrame.close()`) — otherwise GPU memory leaks per frame.

---

<!-- a11y-lens:begin -->
## Accessibility rules (a11y-lens)

This project uses [a11y-lens](https://github.com/jo-duchan/a11y-lens) for semantic accessibility review. Staged UI changes are checked at commit time; findings with `error` severity block the commit.

When writing or modifying UI code (JSX/TSX/HTML/Vue/Svelte), apply the rule set in `node_modules/@a11y-lens/cli/skills/a11y-lens/references/` — read the relevant category before implementing:

- `01-landmarks-headings.md` — document outline, one h1, no level skips, labelled landmarks
- `02-images-alt.md` — alt text that describes function in context; icon-only controls need accessible names
- `03-forms-labels.md` — placeholder is not a label; errors tied via `aria-describedby`; name matches visible label
- `04-aria-widgets.md` — prefer native elements; custom widgets implement the complete WAI-ARIA APG pattern
- `05-keyboard-interaction.md` — full APG key sets, no hover-only affordances, no keyboard traps
- `06-focus-management.md` — overlays move and return focus; async results are announced via live regions

Each check is tagged `[core]` or `[full]`. If this project's `a11y-lens.config.json` (or the `"a11y-lens"` field of `package.json`) sets `"level": "core"`, apply only the `[core]` checks — the commit-time review checks nothing else.

Tip: agents with skills support get richer guidance via `npx skills add jo-duchan/a11y-lens`.

Self-check against these categories before finishing any UI task — it is cheaper than failing the pre-commit gate.
<!-- a11y-lens:end -->

> 아래는 이 레포의 결정이고 **마커 밖에 둔다** — `a11y-lens init`은 `begin`/`end` 사이를
> 템플릿으로 통째 치환하므로, 안에 쓰면 다음 init에 지워진다.

This package is the only one with DOM code, so the rules above apply here. The root lefthook
`a11y-lens` job checks staged UI files at commit time.

### The level is `core`: what everyone needs, not screen-reader choreography

`a11y-lens.config.json` at the repository root sets `"level": "core"` and `"report": "errors"`.
tapflow is used by a team that sees the screen, and it streams the device as images, so it is not a
product a screen-reader user does manual QA with. What it keeps is what helps **anyone** who does
not drive it with a mouse, or who uses voice control or zoom:

- **Kept, and checked at commit time:** accessible names (icon-only buttons, labels that are not
  placeholders, a name that matches the visible label), keyboard operation, focus that is moved,
  returned and never lost, and no focus stealing.
- **Kept, but not checked by a11y-lens:** colour contrast. The rule set leaves contrast to static
  tools, and no check here looks at it, so it holds only if the colours used come from the theme's
  tokens.
- **Not pursued:** screen-reader-specific choreography, such as announcement timing, live regions
  for async results and loading, descriptions written for a state change, complete ARIA widget
  patterns, heading and landmark outlines, and alt-text wording. The same goes for manual VoiceOver
  passes and for a11y-lens warnings, which `report: errors` no longer prints.

**What is already built stays.** #829 and #841 went further than core (status-line descriptions,
the leaving-row note, release headings). That code is tested and costs nothing to keep. A `full`
review is a superset of a `core` one, so it passes. Keep it working when you touch it. Do not build
new work of that kind unless someone asks for it.

**A check that was skipped is not a check that passed.** When the gate times out or its agent
fails, the commit goes through and the files are recorded as pending; review them with
`pnpm exec a11y-lens check --pending`. The root AGENTS.md has the Stop gate that asks for it.

### The streamed device is out of scope, and everything in the DOM is not

**The device frame and what is drawn on it are deliberately not made accessible.** The stream is a
sequence of images with no semantics — there is nothing under it for a screen reader to read, and a
tester who cannot see the screen cannot do manual QA on it whatever we label. Putting focusable
controls over those pixels would announce an affordance that leads nowhere, which is worse than the
absence: it is a11y theatre, and it costs the keyboard user tab stops that do not help them.

So the physical side buttons drawn on the frame — volume, action, power, and the hit-testing behind
them in `IOSViewer`'s `toButton` — carry no accessible name and take no focus, on purpose. An
`a11y-lens` finding against that surface is answered with `A11Y_LENS_SKIP=1` and a line in the commit
message saying which surface and why.

**Everything else gets the `core` rule set** (see the section above), and the line is the DOM
rather than the feature: toolbar buttons, dialogs, forms, the app centre, settings, invitations. A
control that exists as an element is a control that must be reachable and named.

**The line is also the answer when a frame control has no DOM equivalent.** `AndroidViewer` already
renders volume and power as real toolbar buttons (`deviceSlot = buttonsIn(DEVICE_BUTTONS)`, each an
`aria-label`led `<Button>`), while iOS has only the keyboard toggle there and leaves volume, action
and power to the frame. That gap is **platform parity, not accessibility** — the fix is to give iOS
the toolbar buttons Android has, not to overlay the frame. Read it that way whenever a finding says a
device control is unreachable: ask whether the control should exist in the DOM at all, and if it
should, put it in the toolbar where the group rules above already say it belongs.

### A view that replaces another puts back the focus it destroyed

Swapping one view of a region for another — the list for its failure, the failure for the list a
retry brought back, the list for its empty state — unmounts whatever inside had focus, and the
browser drops it on `body`. Spread `useFocusAfterSwap(view, fallback)` onto the element holding the
views and render from the same `view` name, so the key cannot say "list" over an empty state. App
Center is the example (#829).

**It acts only when one commit both changes the view and removes the focused element.** A second
design acted on any removal and broke the page's most common interaction: picking a row's status
unmounts the `Select`'s content, and the status mutation re-rendered the page before Radix handed
focus back to the trigger — so focus went to the first release and the list scrolled to the top under
a mouse user. A removal that is not a swap belongs to whatever caused it, so **a row leaving a list
that stays a list** is handled by the change that removed it, not here. In App Center that is a status
change a filter then hides (#833). Candidates are ranked when the change is made, from the rows on
screen: rows of the same release nearest first (next before previous), then release headers nearest
first. Focus moves to the first one still on screen on the commit that removes the row, and only if
focus went down with it. The move cannot happen earlier, because Radix hands focus back to the row's
trigger after the pick, and the ranking cannot happen later, because by then the order is gone. A
list of candidates rather than one target, because the same refetch can take the nearest neighbour
too. The destination is described by a
note that says why the row left, and the note clears when focus goes elsewhere. Someone who moved
focus while the change was in flight keeps it, and hears the same sentence as a toast, since
without a focus move nothing flushes it.

**A failed key being fetched again is still the failure.** The manual retry holds the failure screen
until its answer, and so does a background refetch of the same failure (returning to the tab, an
upload invalidating builds). Without that, `keepPreviousData` fills the refetching key with the
previous search's rows, the view becomes a list that belongs to a different search, and focus is
moved into rows the answer then replaces. Holding it keeps focus on "Try again", now "Trying…".
**Only the failure that was on screen**, though — `isFetchedAfterMount`, not `errorUpdateCount`,
which counts any failure in the cache's lifetime and so resurrected a search the relay had failed
minutes ago, and opened a remounted page on an old failure instead of loading.

**Focus goes to the first control in the new view, else to `fallback`, and that control has to say
what happened.** Not a `tabIndex={-1}` heading: `DeviceViewer` tried parking focus on a non-control
and took it out again, since such an element takes focus from a mouse too and then has to wear a ring
nobody can use. And not trusting `role="status"` to explain it, because NVDA and JAWS flush a pending
polite announcement when focus moves in the same commit. App Center's "Try again" is described by the
failure's two lines; its fallback, the search box, by whichever of the loading line and the empty
state's title is showing; and the first release,
where a successful retry lands, by the status line itself — not while its rows are held from the app
being left, when that line is about a different app.

A busy control uses `aria-disabled`, never `disabled`, and dims itself with `aria-disabled:` classes
because the shared `Button` only styles `disabled:`. A focused element that becomes disabled is dropped
to `body` by the focus-fixup rule, which jsdom does not model — a test asserting focus stayed on it
passes in jsdom while a browser loses it.

"Had focus in the region" follows the React tree, not the DOM: a `Select` or menu opened from a row
lives in a portal under `body` and still goes with its owner.

**A dialog opened by state rather than by a trigger returns focus itself.** Radix returns focus to an
`AlertDialogTrigger`; without one it drops it on `body`. `BuildRow`'s deletion dialog is opened from
its trash button's `onClick`, so it passes `onCloseAutoFocus` to put focus back on that button.

### A toast fired while a dialog is open is not heard

`<Toaster>` renders in place inside the app root, and an open Radix dialog sets `aria-hidden` on everything
outside its portal. So a toast's live region is hidden for as long as the dialog stays open, and a
screen-reader user hears nothing. An outcome that belongs to a dialog is said inside it, in a
`role="status"` element mounted before the outcome arrives; `Team.tsx`'s invite dialog is the example. A
value the user has to copy goes in a focusable read-only field, not a `<code>`: on a plain-HTTP page there
is no clipboard API, and a keyboard user can only select what can take focus.

