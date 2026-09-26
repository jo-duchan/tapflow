# @tapflowio/ios-agent

## 0.24.0

### Minor Changes

- 2700746: Lean mode for iOS simulators. With `agent.lean: true` in `tapflow.config.json` (or `TAPFLOW_LEAN=on`), the agent turns off a fixed list of background services — Siri and Apple Intelligence background work, iCloud Keychain and backup, Health app and HomeKit, photo analysis, Screen Time, iMessage and FaceTime, Continuity, telemetry and similar — on each simulator it boots, and puts them back when it shuts the simulator down. Measured on iOS 27, a simulator uses about a quarter less memory. Wallpaper, widgets and the services apps commonly call (push, StoreKit, CloudKit, HealthKit, the photo picker, universal links and others) stay on; an app that needs one on the list should run with Lean mode off. `tapflow init` asks on a Mac (default off) and `tapflow doctor ios` reports it. iOS 18.5 or later. Android emulators get their own Lean mode in this release: four bundled Google apps kept disabled.

### Patch Changes

- 2f66f31: <!-- changelog: internal — fixes a test-teardown race (#826). The product half, a queued liveness check that no longer runs after dispose, changes nothing observable: disconnect queues forget() for every device, which rewrites the same rule, and the enforcement-lost report it drops had no sessions left to reach. -->

  A liveness check queued before `SimulatorNetwork.dispose()` no longer runs, and `idle()` waits for queued work to settle ([#826](https://github.com/jo-duchan/tapflow/issues/826)).

- Updated dependencies [2700746]
  - @tapflowio/agent-core@0.24.0
  - @tapflowio/audiotap-helper@0.3.6
  - @tapflowio/protocol@0.24.0

## 0.23.0

### Patch Changes

- 00dcb7f: The CoreSimulator version-mismatch hint points at the canonical docs origin, so following it no longer costs a redirect.
- Updated dependencies [e63e410]
  - @tapflowio/protocol@0.23.0
  - @tapflowio/agent-core@0.23.0
  - @tapflowio/audiotap-helper@0.3.5

## 0.22.0

### Minor Changes

- 7359488: **iOS input and streaming find SimulatorKit where Xcode 27 put it** ([#797](https://github.com/jo-duchan/tapflow/issues/797)). Xcode 27 moved `SimulatorKit.framework` out of the developer directory (`Contents/Developer/Library/PrivateFrameworks/`) into `Contents/SharedFrameworks/`. The touch and screen-capture helpers knew only the old location, so on a Mac whose only Xcode is 27 they could not start: no input reached the simulator and no stream opened. On a Mac where Xcode 27 is selected and an older Xcode is also in `/Applications`, they fell back to that Xcode's SimulatorKit instead; whether that worked against Xcode 27's simulator service was not tested. Both locations are now checked on the selected Xcode before any other Xcode is, and each helper logs the SimulatorKit it is about to load.

  **Bezels come back on every iPad and most iPhones.** Xcode 27 no longer lists a device's screen size in its `profile.plist` and publishes it in `capabilities.plist` instead, so a device whose frame is assembled from nine slices rather than one image lost its bezel. That is most of them: on Xcode 27, 104 of 129 device types — every iPad, Apple Watch and iPod touch, and the iPhone 6s through 13, 14, 14 Plus, SE, 16e and 17e. The 14 Pro models, Air, and every iPhone 15, 16, 17 and 18 model other than 16e and 17e draw their frame from one image and never lost it. The size is now read from either file; on Xcode 27.0 each of those 104 carries one, and on Xcode 26 it is read exactly as before.

### Patch Changes

- 0699c26: **Taking an iOS simulator offline no longer fails on the first press with "This Mac is not set up"** ([#797](https://github.com/jo-duchan/tapflow/issues/797)). Right after writing the filter rule, the agent asked the network filter once what it was holding, and the filter could still answer with the rule from before the write. That answer was treated as a filter tapflow cannot control: the press was refused, the control said the Mac was not set up, and it kept saying so until a later toggle went through. In one session on a macOS 27 Mac the first offline press was refused on every try, and one press coming back online was too. The first press on a device left running while the filter was switched off met the same lag as a filter reporting itself off, and was refused without a log line. The agent now asks again for up to three seconds before refusing, so only a filter still holding the wrong rule, or still off, after that is reported, and every refusal or recovery is logged with how many asks it took.
  - @tapflowio/protocol@0.22.0
  - @tapflowio/agent-core@0.22.0
  - @tapflowio/audiotap-helper@0.3.4

## 0.21.0

### Patch Changes

- 400f887: <!-- changelog: internal — no behaviour change; three decisions that had no test now have one. -->

  Closes three coverage gaps that earlier reviews found and left written down: the symlink refusal and
  the file-mode half of the state-file guard, and the descriptor-scan bound in the injected library.

  The first two only change the answer for a root-owned target, so they run as root on CI rather than
  being skipped everywhere. The third extracts `tf_fd_scan_bound`, whose `capped` flag is what makes a
  truncated scan audible instead of looking like a process with nothing left to cut.

- 801d360: Taking an iOS simulator off the network now fails its requests in about half a second instead of hanging for twenty-five. The filter blocked name resolution along with everything else, and a blocked UDP query returns nothing to its sender — so a resolver waited out its own timeout, and a page that needed a fresh name sat blank for over half a minute. Name resolution passes now; the connection that follows is still dropped, in about six milliseconds.

  Only outbound UDP to port 53 is allowed. TCP on that same port stays blocked — it already failed immediately, so opening it would buy nothing and would let a device you took offline hold a connection to anything listening there.

  **Your app is affected, though less than everything else was.** tapflow refuses name resolution inside the app under test only where that app uses POSIX resolution; `URLSession` resolves through a path tapflow does not reach, so it now resolves the name and fails when it connects, where a device with no signal would have failed the lookup. An app that treats "the name resolved" as "I am online" will say online while reaching nothing. What is unambiguously better is everything tapflow cannot reach at all — a web view, another app — which used to hang for half a minute.

  Encrypted DNS is not covered. DNS-over-TLS could be, and DNS-over-HTTPS cannot be told apart from ordinary traffic; neither is included because nothing has measured whether a simulator uses them when the Mac is configured that way.

- 676641f: An iOS app that reads `SCNetworkReachability` is now told when its simulator is taken off the network. Taking a device offline already stopped its traffic, and an app built on `NWPathMonitor` drew its offline state correctly — but Alamofire's `NetworkReachabilityManager` and the older `Reachability.swift` read a different API, and that one kept answering "reachable" while every request failed. The offline screen a tester came to check never appeared.

  The fix answers that API too, and **re-fires the callback the library is actually listening on** rather than only changing what a poll would return: a consumer caches what its callback last told it and never polls, so faking the getter alone moves a number nobody reads. Both ways of scheduling that callback are covered — a dispatch queue and a run loop.

- 253e94c: <!-- changelog: internal — no behaviour change; the walk decides the same things, from a seam a test can reach. -->

  The last part of #690. `attribute(pid)` — the climb that decides whether a flow belongs to a
  simulator, to the Mac, or to nothing anyone can name — moves to `attributeWalk`, with its three
  live-kernel reads behind a `ProcessReader` a test can stand in for.

  Twelve cases and twelve mutations cover what the climb decides: where it stops and what the stop means,
  that an unreadable executable path still reaches the arguments, that a cache hit skips the argument
  read entirely, that a failed read is counted apart from a host flow, and the depth bound from both
  sides.

- 26f79c3: <!-- changelog: internal — no behaviour change; one log line regained a field it briefly lost. -->

  The rest of #690. `Heartbeat`'s counters, the state file it renders, its two rate limits and the
  candidate directory list move into `Extension/FlowIdentity.swift` where a test bundle can compile
  them, and `handleNewFlow`'s decision moves with them as `decideFlow` — rule, attribution and endpoint
  in, verdict and counter bucket out.

  The file the agent parses now has its five field names pinned by a test, and a node check compares
  the three copies of the state path list that live in Swift and in two TypeScript packages. 68 tests,
  70 mutations.

- cc8de63: <!-- changelog: internal — no behaviour changes; the extension binary is rebuilt but does the same thing. -->

  Tests for the network filter's Swift (#690). The pure decisions in `Provider.swift` and
  `Host/main.swift` move into files a test bundle can compile — the audit-token readers, the process
  identity and its cache, the drop-count prune, the pulse rate, and the host binary's argument handling
  and rule arithmetic — and each is held by a mutation that must make a test fail.

  Nothing about what the filter does changes. What changes is that four decisions which previously had
  no test now cannot be broken silently: reading the pid from the wrong word of the audit token, keying
  the attribution cache on a pid the kernel reuses, publishing a drop count from a previous episode, and
  letting an argument the host binary does not understand empty the offline rule.

- 913a675: The iOS agent no longer believes a network-filter state file that anyone on the Mac could have written. The filter publishes what it is enforcing to a file, falling back to `/tmp` when its protected directory refuses it, and the agent read whichever was there. `/tmp` is world-writable, so any local process could put a file there naming a device and the agent would take a simulator offline on that word alone. A state file in a world-writable directory is now believed only when root owns it and nobody else can change it; the protected path and the liveness check are covered by the same rule.
- 9bcb989: <!-- changelog: internal — no behaviour change; the injected library decides the same things, from a header a test can compile. -->

  The decidable half of `src/network-hook.m` moves into `src/hook-decisions.h`: whether a peer is
  loopback and therefore must survive a cut, whether a call is refused, whether this process is the one
  to hook, and where the offline flag lives. Plain C with no Foundation, so a test compiles it with a
  bare `cc` and no simulator SDK — the tests run in the ordinary suite rather than on a macOS runner.

  36 cases and 21 mutations. The condition-file path now has a guard comparing the C literal against
  the TypeScript that writes it; nothing compiled both before.

- 7d8eb4e: **Installing a build works when the relay is not on the same machine as the agent.** It never did. The relay sent the agent its own filesystem path and the agent opened it, which is only true when the two share a disk — so on the topology the guide recommends, a relay on a LAN box with agents on Macs, every install failed. A relay in a container failed the same way for the same reason.

  **And it failed by blaming the build.** `unzip` said `cannot find or open`, the agent threw that away, and what reached the browser was "check this is a simulator .app.zip". The archive was fine every time. The tool's own words are in the message now, and a download that fails is reported as a download failing — the three causes a person acts on differently (a bad archive, a relay that cannot be reached, a transfer cut short) had been collapsed into the one sentence that was wrong for all of them.

  The relay now mints a single-use credential where it has already checked who owns the session, and serves that one build against it. Nothing is added to any token's permissions: an agent still cannot ask for a build it was not told to install, and `tapflow start` — whose agent runs with no token at all — keeps working, which a permissions-based approach would have broken. The agent builds the address from the relay URL it is already connected to rather than from anything the relay claims about itself, because that is the one address known to be reachable.

  A truncated transfer is caught against a size that travels with the instruction rather than against `Content-Length`, which a proxy is free to drop — a check that reads an absent header passes while looking at nothing, and hands on a half a file to be reported as a damaged one. Downloads have a stall timeout, so a half-open socket fails instead of hanging forever and leaving a temp copy of the build behind; the Android install path gained the cleanup it never had. An agent too old to fetch builds is unaffected and installs exactly as before, and the relay says so once in its log rather than guessing whether that agent is somewhere else — it cannot tell, and a check that is wrong in both directions is worse than none.

  `@tapflowio/agent-core` gains `downloadBuild`, and `@tapflowio/protocol`'s `app:install` gains `buildTicket`, `buildName` and `buildBytes` — additive, so an agent that predates them keeps working on the field it already reads. Both are named here rather than left to ride the version bump because a third-party platform built on `AgentRegistry.register()` reads those changelogs, and this is the API it would use to support installs from a relay it does not share a disk with.

- Updated dependencies [7d8eb4e]
  - @tapflowio/agent-core@0.21.0
  - @tapflowio/protocol@0.21.0
  - @tapflowio/audiotap-helper@0.3.3

## 0.20.1

### Patch Changes

- a2be8e0: **The check that decides whether the iOS network filter needs replacing now covers two things it
  could not see.** Since the extension keeps its version when its inputs are unchanged, anything the
  check misses is no longer a harmless extra replace — it is a replace macOS skips **silently**,
  leaving that Mac on the old provider with every version reading correctly.

  Two inputs live on the maintainer's Mac rather than in the repository, and both change the shipped
  extension with no source file moving: the **provisioning profile**, which is the extension's only
  sealed resource and is renewed annually, and the **toolchain** that builds it. Both are now compared
  before a build, so a renewal or an Xcode upgrade produces a new version by itself.

  The build machine's OS version is deliberately left out, even though it sits in the same place. It
  moves on every macOS point update, and including it would make a software update replace the filter
  on every Mac — the cost this whole mechanism exists to remove.

  Nothing changes for anyone installing tapflow. The filter is byte-identical; only the rule that
  decides when it needs replacing got stricter.

- 49f95e4: Keep iOS network control working after the filter is upgraded, and stop the upgrade from taking the Mac's network down.

  Replacing the network filter's system extension leaves the previous one holding the XPC service name, so the new provider could not vend its listener and `--confirm` answered "no listener" while the filter was enforcing normally. The agent read that as "not confirmed" and the dashboard's **Take device offline** control went unavailable on every Mac that had upgraded. It now falls back to the provider's own state file, which is the channel the CLI already preferred.

  The upgrade also switches the filter off _before_ it copies the app into `/Applications`, not only before activating it. Copying the app makes macOS restart the filter session on its own timing, and a filter session going down arms a kernel-wide IP drop — that is what took a Mac's network down for 2m34s on 2026-09-02, and the previous ordering was winning the race by 69 milliseconds.

  Also: the provider publishes a rule change immediately instead of waiting for its next idle pulse, its state file names which provider wrote it, and a listener that fails to start now says so rather than logging success.

- 79d5c1b: **A release that changes nothing but the filter's host binary no longer replaces the system
  extension.** `build.sh` stamped one `CFBundleVersion` into the host app and the extension alike, so
  any rebuild bumped both and macOS replaced a running provider — which interrupts every new connection
  on the Mac until the replacement is up. Three of the six filter rebuilds so far touched nothing
  outside `Host/` and paid that for nothing.

  The extension now keeps its version when its own inputs are unchanged. Those inputs are everything
  except `Host/`, `project.yml` and `build.sh` included, because both change what the extension binary
  is without touching a line of Swift — and an extension that changed without its version changing is
  replaced **silently**, leaving the old provider running with every check green.

  **The first rebuild after this still bumps it once**, since `build.sh` is itself an extension input.
  That is one replace, and the change that made a replace survivable landed first.

  **Two versions means the checks that compare them had to be told apart.** `isNetFilterCurrent` and
  `tapflow doctor ios` were comparing the host app's version against the extension macOS runs, which
  only ever agreed because one number was written into both. Left alone, doctor would have reported a
  Mac whose `/Applications` app is stale as fully healthy — and that binary is the agent's own path to
  the filter, so an older one meets flags it does not understand. Doctor now names the app when only
  the app is behind, and says to run `tapflow migrate net-filter`.

  **And an install it cannot judge is refused rather than guessed at.** macOS keeps an extension
  enforcing when its container app is deleted; the extension's version used to stand in for the host's,
  and now only gives a lower bound. In that state tapflow says so and names both remedies instead of
  replacing a filter that may be newer than the one it carries.

  - @tapflowio/protocol@0.20.1
  - @tapflowio/agent-core@0.20.1
  - @tapflowio/audiotap-helper@0.3.2

## 0.20.0

### Minor Changes

- 3f18f70: Gate the dashboard's Full reset toggle on an agent capability instead of the platform string.

  `AgentCapability` gains `full-reset`, `IOSAgent` advertises it, and `SessionInfo` now carries the
  agent's capabilities so the viewer can gate while picking a device — before any session exists to
  join. The old `os !== 'android'` check said "Android cannot" when it meant "this agent did not say
  it can", and got both directions wrong: an iOS agent too old to implement Full reset was still
  offered the toggle, and an Android agent that implements it later would still have it hidden.

- d238c34: Take one iOS simulator off the network and put it back (#607), the iOS half of the toggle Android
  already answers with airplane mode.

  A simulator has no radio to switch off — it is host processes sharing the Mac's network stack — so
  there is nothing to ask. Three mechanisms are applied together instead, and each one alone produces
  a result a tester would sign off on and be wrong about:

  - a **host content filter** drops that simulator's flows at the kernel. It is a content filter and
    not a transparent proxy because the proxy was measured and could not see simulator traffic at
    all: 217 flows reached its handler and every one was a host process.
  - an **injected library** tells the app its path is unsatisfied. Without it the offline banner never
    appears — an app reads `nw_path_get_status` inside its update handler, the real path never
    changed, so the handler never fires again. Measured with the filter alone: traffic dead, path
    satisfied for the life of the process.
  - the **status bar** stops showing service.

  **Which simulator a flow belongs to is recovered from the process tree.** A flow carries a bundle id
  and never a device, so the filter walks the flow's process up to its `launchd_sim` and reads the
  UDID out of that process's arguments — the only place it appears, since simulator binaries live in
  a shared runtime and the working directory is `/`. Two simulators running at once resolve to their
  own UDIDs with no misattribution, which is the isolation RocketSim cannot do: it filters by bundle
  id, so the same app on two simulators is one target.

  **Connections the app already holds are cut, and they have to be.** `URLSession` keeps one
  connection for a whole session, so a tester who goes offline mid-session would otherwise watch the
  app keep talking over the socket it already had while only _new_ requests failed. The host cannot do
  this — Apple is explicit that allowing a connection is one-way, and keeping every flow under a data
  verdict instead was built and measured unusable — so the injected library shuts down the app's own
  non-loopback sockets when it goes offline. `shutdown`, not `close`: the owner sees the connection go
  away, which is what losing signal looks like, and the call does not hand the descriptor's number back
  for something else to be opened onto — which closing it would.

  **Loopback keeps working**, so a dev build talking to Metro on the host, and tapflow's own
  in-simulator instrumentation, are unaffected.

  `network:state` reports `available: false` with a reason until an app has actually run under the
  injection, because the injection arms at boot and names its target when an app is launched. A
  control that claimed to work before then would be the false green this feature exists to prevent.

  **This needs a signed system extension on the host, which ships with tapflow as of this release**
  — an agent without it installed reports `available: false` rather than failing, so nothing else about a session changes.

- 964c145: Check the hook's symbols before use, and stop telling a tester to launch an app they already launched

  Two halves of the same failure. Before a launch: `doctor ios` now reads the iPhoneSimulator SDK's
  export stubs and warns if this Xcode no longer provides a symbol the injected library rebinds — the
  install is all-or-none, so one missing symbol takes iOS network control down, and a tester would find
  out by launching an app and reading a dead control. Reading only: no simulator is booted, installed to
  or launched into.

  After a launch: a library that is present and armed but never loaded by dyld writes no verdict, and
  that was reported as `awaiting-app` — "launch an app through tapflow", to someone who had, for the life
  of the session. Once a launch has had time to report and none has arrived, it now says the injection
  could not be confirmed rather than asking again for something already done.

  **Which is an observation, not a proof.** Nothing was seen, and that is why the answer changed: the
  alternative was to keep asserting the one thing known to be false. It is a deadline, and the reason set
  says so where a consumer reads it.

- 636caf5: Stop attributing every flow on the Mac while nothing is offline, and record drops per device

  The network filter ran its attribution walk on every new connection the Mac made, whoever it belonged
  to, including while its rule was empty — which is most of the life of an installed filter. Measured on
  a Mac with no device offline: 125,989 walks averaging 425.9µs, zero drops, and 96% of the flows
  belonging to the Mac's own browser and mail. With an empty rule every branch allows, so none of it
  could change a verdict.

  Separately, the provider's state file proved that the rule had _arrived_, not that a device's traffic
  had stopped — and a simulator whose flows consistently fail attribution keeps talking while that file
  stays fresh and correct. The file now carries drops per device, which closes the gap in the one
  direction it can: a drop was attributed by construction, so it proves enforcement. Zero drops proves
  nothing, because an offline device that opens no connections drops nothing, so nothing reads it as
  failure. It goes to the log; no control changes.

- d238c34: Stop drawing a working network control as a dead one (#607).

  `NetworkUnavailableReason` gains `awaiting-app`, for a device whose injection is in place and which
  no app has run under yet. That is not an edge case on iOS — the library is delivered when the device
  boots but can only name its target when an app is launched, so **it is the state every session is in
  until its app starts**, and it is the first thing a tester meets.

  It had been reported as `not-armed`, and that value means something else: nothing was delivered, and
  the remedy it prescribes is a reboot. Rebooting does not help here, and neither does the sentence the
  dashboard drew from it — _"tapflow can no longer change it"_ was wrong twice over. Nothing had been
  armed, so there was no "no longer"; and clicking the control **does** change the device, because
  traffic-level control works in this state. What does not work is telling the app, which is the half
  that needed saying.

  So the control now says what is missing — _"Launch an app through tapflow so it is told too"_ — and
  is drawn as what it is: actionable. It keeps its plain action name rather than the `Retry:` prefix,
  which claims a previous attempt that never happened, and a device taken offline here stays amber,
  because it really is offline.

  **A control tapflow cannot currently steer is drawn as unusable wherever the device is pointing**,
  where before it was drawn that way only at `online` and left washed out at `offline` — the same faint
  rendering that reads as disabled on a button that still works, in another hue. A device whose state
  has not been read yet is untouched by this and stays muted: it has had no attempt, so drawing one as
  a failure claims something that never happened, in the opening seconds of every session.

  That colour says the control is unusable **now**, and deliberately not that the device will never do
  it. The dashboard reads this one member and still ignores the rest of the set, for the reason
  recorded where it ignores them: every Android read failure currently arrives as `unsupported-device`,
  so a rebooting device and a permanently incapable one are indistinguishable here, and nothing the
  dashboard draws may tell those apart. `awaiting-app` is not in that set — an agent emits it only
  about a fact it knows — which is what makes it safe to read alone.

### Patch Changes

- f04c2e7: Stop a second tapflow agent from putting the first one's devices back online, and refuse the configuration that made it possible.

  The iOS filter rule is host-wide, and the agent wrote its **whole** offline set on every run — so the host replaced the rule with it. `arm()` runs on every device boot, and a freshly started agent knows of no offline device: starting a second agent therefore put every device the first had taken offline back online, silently, while that tester watched an offline control over an app whose traffic was working. The rule is now changed by a delta the caller names, so an agent removes nothing it was not asked about. The cleanup the whole-set write provided is kept in a more precise form: arming a device names that device, so a rule left behind by a dead process is cleared when that device next boots.

  `tapflow agent start` also refuses when a tapflow agent for the same platform is already running on the Mac, and says so. One agent manages every simulator on its machine — the relay already treats two as one, since agent identity there is the machine's hardware id plus the platform — so the second one was never a supported setup; it just failed later and without a sentence. Nothing changes for the ordinary case of many simulators and many testers on one agent.

  And the filter's container app now exits non-zero on an argument it does not recognise. It used to fall through to writing an empty rule, so a newer agent asking an older installed app a question it could not answer — `--confirm` — did not get a refusal, it **erased the rule**.

- fee8244: Stop a status-bar failure from failing a network toggle that worked, and stop a truncated verdict from claiming the app's hooks were proved broken.

  Layer 3 only reports, so its failure is now swallowed in both directions — unswallowed, one `status_bar` failure threw out of `setOffline` with the two layers that do the work already applied, telling the caller a request failed on a device that really was offline. Coming back it errs the other way and the next successful toggle writes the bar again.

  A verdict file caught mid-write resolved to `hooks-not-installed`, which means the library ran and proved its hooks did not take. A truncated file shows nothing of the sort — the library writes it non-atomically — so it now resolves to `state-unconfirmed`, whose remedy is to look again, which is what actually resolves it. Deliberately not `awaiting-app`, which would hand a healthy-looking control to a device nobody can vouch for, and deliberately not `not-armed`, which would tell a tester to reboot a simulator mid-session for a condition that had already cleared.

  `hooks-not-installed` is now reserved for the one shape that says so. It was answered for every file that was not the library's success signal — `{}`, a bare number, an empty file — each of which supports no verdict at all.

- d4a5965: Ship the iOS network filter with tapflow, and give the CLI the three commands that install, migrate and check it.

  The filter is the one layer of the offline toggle that lives on the Mac, and until now tapflow did not distribute it — the feature was complete and unusable by anyone who could not build and sign it themselves. The signed, notarized app now travels inside `@tapflowio/ios-agent`, so `tapflow setup ios` offers it on a new machine — asked for, like every other install that command performs — and `tapflow migrate net-filter` covers a machine set up before the feature existed, or one where setup was declined.

  `tapflow doctor ios` reports three things separately: installed, approved, and **running the version this tapflow carries**. The third is not the same question as the first two — replacing an extension finishes only on restart, so the app on disk can be current while macOS still runs the old one, and that is exactly the state where the dashboard says the Mac is not set up. The version comparison therefore reads what macOS has activated rather than what is in `/Applications`.

  Installing refuses to replace a newer filter than the one it carries: `/Applications` holds one copy for the whole Mac while each install judges it by its own dependencies, so an older checkout would otherwise downgrade the filter a newer agent depends on.

- cb04a51: Write the injected library's verdict file atomically, so a healthy app stops reporting that its state could not be confirmed.

  The library wrote the file with `fopen(path, "w")`, which truncates it in place. The agent reads that file on every `state()` call — the relay triggers one on `device:ready`, on a viewer's re-join and after every toggle — so a read landing inside the write is reachable on a session where nothing is wrong, and what it gets is half a file. The reader cannot tell that from a real answer, so the network control reported `state-unconfirmed` for no cause. It now writes beside the target and `rename`s onto it: a reader sees the whole old file or the whole new one.

  The dylib is a committed prebuilt with no recorded build recipe, so `packages/ios-agent/build-nethook.sh` now holds one. Its flags were recovered from the committed binary rather than remembered, and confirmed by a rebuild whose every section matched byte for byte.

  Two things that were invisible now report. `bin/libtapflow-nethook.dylib` is a committed prebuilt, and every test that exercised the network hook injected a _fake_ path — so editing the source and shipping the previous binary was silent. It is now recorded against its sources like the network filter next door, with the difference stated in the guard: a failure here is the contributor's to fix, because no signing key is involved.

  And the library itself had no diagnosis at all. `DYLD_INSERT_LIBRARIES` naming a path that does not exist is ignored by dyld without a word, so a damaged install launched the app unhooked and wrote no verdict — leaving the control asking the tester to launch an app through tapflow, for the whole session, while the app they launched was running in front of them. `tapflow doctor ios` now reports the library, and the agent says so instead of asking for something already done.

- 5e2fcc5: Split the network-control reason set so each member carries a remedy, and confirm that a simulator's rule is actually being enforced before reporting it offline.

  `unsupported-device` now means only what it says — the write was accepted, the read-back succeeded, and the device had not moved. Every other Android failure is `state-unconfirmed`, which a retry may fix. Two iOS members are new: `filter-unavailable` for a Mac that cannot take devices offline, and `enforcement-lost` for enforcement that stopped underneath a device that was already offline.

  On iOS the rule is now confirmed over XPC before the other layers are applied, and a request that cannot be confirmed is refused rather than half-applied — applying the app-facing layers alone tells an app it is offline while its requests keep succeeding. Enforcement is watched while any device is offline, so an outage that used to pass silently is reported instead of leaving a tester signing off on requests that succeeded.

  The dashboard says what to do per reason, stops offering a retry where a retry cannot help, and interrupts rather than re-colouring when a finished check has been invalidated.

- f497d0a: Three corrections to the library tapflow injects into the app under test (#635, #640, #643).

  **A network banner no longer risks crashing the app it is testing.** When you take a simulator
  offline, tapflow re-delivers the app's own network-path handler so the app finds out. That handler
  was being called on tapflow's thread rather than the one the app asked for — which for an app that
  updates its UI from that handler means doing it off the main thread. The handler now runs where its
  owner said it should.

  **Cutting the app's open connections says when it might have cut the wrong one.** A file descriptor
  is read twice — once to check where it points, once to shut it down — and nothing stops another
  thread reusing it in between, in which case something else's connection goes down. That window
  cannot be closed from outside the process, so the descriptor is identified by something the cut
  itself does not destroy and re-checked afterwards, and a mismatch is reported instead of passing
  silently.

  **And a branch that had never run is gone.** The injected library was reaching for an app's WebView
  processes, which measurement showed it never loads into. One consequence is worth stating plainly:
  in a hybrid app, the web half is **not** told it is offline. Its requests still fail — the host
  filter blocks traffic for every process — but a WebView that draws its own offline banner will not
  draw it.

- 17c5787: Two ways the iOS network filter reported itself wrong, both found by measuring rather than reading.

  **Installing an update to the filter stopped silently.** Replacing an installed system extension makes macOS ask the app which one to keep, and the object that answers was being collected before the question arrived — `OSSystemExtensionRequest.delegate` is a weak reference and nothing else held it. No callback of any kind then fired, so the only thing left to report was a timeout, which is why this was recorded three separate times as a failure with no known cause. It only ever affected an update, never a first install, because a first install has nothing to ask about.

  **And the filter's status file never came back after the filter was turned off and on again.** Taking a device off the network needs that file — it is how tapflow knows the filter is really running — and it is deliberately removed when the filter stops. The flag that suppressed it was never cleared, so from the first stop onward the file stayed missing for as long as the extension's process lived, while the filter went on filtering. Nothing read that file until the agent side landed in this same release, so this was never something anyone could have seen — it would have become visible as the exact failure the file was added to catch, pointed the other way: a device reported as beyond tapflow's control while its traffic really was being dropped.

- ecf34dd: Let tapflow tell when the iOS network filter is not actually running (#639, #641, #642).

  Taking an iOS simulator off the network needs a system extension on your Mac, and nothing checked
  that it was still there and doing its job. The control decided from evidence inside the app instead
  — so a filter that had been disabled, crashed, or never approved left the toggle reporting a device
  as offline while its traffic kept flowing. That is the one failure this feature exists to prevent,
  and it was invisible.

  The filter now leaves a small status file saying what it is currently enforcing, refreshed every
  few seconds and removed when it stops. Missing, or several beats old, means it is not enforcing —
  and both cases were measured rather than assumed: killing it freezes the file, and macOS brings it
  back about seven seconds later.

  Two other things came out of the same work. **Changing a device's network no longer asks macOS to
  re-install the extension every time** — installation and configuration were one code path, so a
  toggle that only needed to write a setting was requesting a system extension replacement, which can
  hang. And a flow the filter cannot attribute to any simulator is now counted and logged separately
  from ordinary Mac traffic; it is still allowed through, deliberately, because refusing on a
  transient lookup failure would cut your own browser — but it is no longer invisible.

- 7f44ff7: Stop refusing a simulator that never stopped running (#646).

  After the relay restarts — an upgrade, a dropped Wi-Fi moment, a laptop waking — the agent
  re-registers, and re-registering rebuilt its record of each device with "booted" set to false. The
  simulators were still up. Anything that had to work out _which_ device you meant then answered "no
  booted device" about one running in front of you: taking a screenshot, launching an app, reading the
  UI tree, opening a URL, installing a build. It stayed wrong until something else happened to correct
  it, which for an idle session could be never.

  Those five now ask the simulator rather than trusting the flag — and, because the agent process
  survives a reconnect even though its notes do not, it still knows which simulator it booted. Without
  that, a developer with their own simulator open made the question ambiguous again and all five
  refused rather than choosing. The sixth, the raw video stream,
  cannot ask without changing an interface both platforms implement — and nothing in tapflow calls it,
  so it keeps the old path rather than gaining a workaround built for a caller that does not exist.

  You would have seen this as a tool or an MCP call failing after a reconnect while the screen kept
  streaming normally.

- Updated dependencies [becbe77]
- Updated dependencies [3f18f70]
- Updated dependencies [cb04a51]
- Updated dependencies [5e2fcc5]
- Updated dependencies [7152b21]
- Updated dependencies [faeaae9]
- Updated dependencies [4901c8c]
- Updated dependencies [d238c34]
  - @tapflowio/agent-core@0.20.0
  - @tapflowio/protocol@0.20.0
  - @tapflowio/audiotap-helper@0.3.1

## 0.19.0

### Minor Changes

- e55371c: **Requires Node.js ≥ 22.** Node 20 reached end of life on 2026-04-30 and no longer receives security patches.

  Three declarations disagreed about what was supported, and none of them matched what was actually run. The manifests said `>=20.12.0`, the documentation said "≥ 20" — meaning 20.0.0 — and CI ran 20 while Docker ran 22 and the release job ran 24. There was also a band that was declared but unusable: every `undici` 7.x requires Node `>=20.18.1`, so 20.12 through 20.17 could not complete a development install regardless of what the manifests promised.

  The floor is now 22 everywhere, and 22 is a version that will be tested rather than merely claimed — CI runs the suite on both 22 and 24. That is the part that had been missing: `>=20.12.0` was declared for a year and never once exercised on 20.12, which is how it drifted below what the dependency tree already required.

  `tapflow`, `@tapflowio/flow-runner` and `@tapflowio/mcp-server` declared no `engines` at all and now do. `tapflow` is the package installed with `npm i -g`, so until now the CLI announced no Node requirement to the people most likely to need it.

  `tapflow doctor` moves with it and reports `Node ≥ 22 required` below the floor. Without that change it would have printed a green check on Node 20 while the package manifest called the same version unsupported.

  Node 22 is supported until 2027-04-30; Node 24 is the active LTS. Containers and the published image now run 24.

### Patch Changes

- a5466b9: refactor(protocol): declare the agent→relay direction, and type every agent send

  An agent's outbound literal was the one part of the wire contract no compiler could see. The relay forwards
  replies with `JSON.stringify(msg)`, so nothing typed ever re-creates them, and each agent handed its literal
  straight to `ws.send`. #489 (an agent answering nobody) and #490 (a missing `reason`) both came out of that,
  and `scripts/__tests__/inputErrorReason.test.mjs` exists because a script had to stand in for a compiler.

  Seven message types were declared nowhere: `agent:register`, `agent:resources`, `screenshot:done`,
  `screenshot:error`, `stream:register`, `ui:tree:response`, `ui:tree:error` — the last undeclared direction.
  They are now `AgentToRelay` and `StreamToRelay`, and `AgentControlOutbound` is what the agents' typed send
  helpers take.

  `stream:register` is its own direction rather than part of `AgentToRelay`, mirroring `RelayToStream`: the
  relay assigns the role `'stream'` from it, not `'agent'`, so folding it in would make the union's name
  disagree with the runtime role — and would let a control socket claim to be a session's stream socket once
  inbound is narrowed by role.

  ## Two helpers, and why not one

  ```ts
  private sendMsg(msg: AgentControlOutbound): void { this.ws?.send(JSON.stringify(msg)) }
  private sendOn(ws: WebSocket, msg: AgentControlOutbound): void { ws.send(JSON.stringify(msg)) }
  ```

  `sendOn` takes the socket **as an argument**. Seven call sites sit behind an entry guard (`if (!this.ws)
return`) and are therefore compiler-proven non-null; reading `this.ws` inside a helper — or asserting it with
  `!` — would make those guards optional to the compiler and turn deleting one from a compile error into a
  runtime `TypeError`. One of them has a test whose subject is the window that guard covers.

  ## What the compiler found once it could see

  - **30 sends passed an optional `sessionId` into a field declared required.** The agents' dispatcher took
    `{ sessionId?: string }` while every message it dispatches is session-scoped. It now takes a required one,
    with the check moved to the socket boundary — a message with no `sessionId` did not come from the relay's
    forward path, which resolves the session before forwarding.
  - **`requestId` was read as optional in the clipboard cases and required in the screenshot and ui:tree ones**,
    for the same wire guarantee, in the same file. Now consistent. It is still an assertion about unvalidated
    JSON, as the other two always were; that is #444.
  - **The clipboard `respond` helper took `object`**, so all three clipboard replies were unchecked. Typed with
    `ClipboardReplyBody`, which is `ClipboardReply` minus the ids the helper merges.

  **Twenty-five `msg.sessionId!` assertions went away as a consequence**, along with the now-unreachable
  `if (!sessionId) return` inside each agent's `ackNoSession`. That is the same payoff #444 is after on the relay
  side, arriving here first: once the declaration is required, the assertion has nothing left to assert.

  `screenshot:error` and `ui:tree:error` are the first `*-error` messages that do **not** extend `SessionError`.
  They are request-scoped — the relay resolves them by `requestId` alone — and the convention check names them,
  which draws the family's boundary rather than widening it. `SessionError` is for a failure a _session_ is
  waiting on.

  Their `sessionId` is **required**, like every other producer field. A draft made it optional on the grounds
  that the agents pass through an optional id; that was true when written and false by the end of this change,
  which required it on both dispatchers. A field weaker than every producer describes a message nobody sends —
  and here it would also have removed the one field a symmetric ownership check could read, since the clipboard
  replies beside these verify `session.agentSocket === ws` before resolving and these two do not.

  The agents' helpers take `AgentControlOutbound = AgentToRelay | AgentToBrowser`, **not** a union that also
  includes `StreamToRelay`. An earlier draft merged all three, which handed back the exact hazard the direction
  split exists to avoid: `case 'stream:register'` calls `setStreamSocket(session.id, ws)` with no role gate, so a
  control socket that could type-check that message could take over the session's video path.

  `UIElement`, `UIElementRole` and `UIElementFrame` moved from `agent-core` to `protocol` — `ui:tree:response`
  cannot be typed without them and protocol is a leaf that cannot import agent-core. `mcp-server` had a
  hand-written mirror with a comment saying so; it is now a re-export.

  `scripts/__tests__/agentSendTyped.test.mjs` asserts nothing goes around the helpers, and it matches
  **serialization** rather than any spelling of `.send`. Three drafts keyed on `this.ws` were bypassed in review
  by renaming the socket — `streamWs.send(JSON.stringify(…))` walks past them, and that is not hypothetical:
  `streamWs` is in scope in `startBinaryStream` and the relay dispatches a text frame from a stream socket
  through the same agent cases. A commented-out copy of the canonical helper also satisfied the positive
  assertion while the real one took `msg: object`, leaving all 66 of that agent's sends unchecked with the check
  green. Both are closed, and a file in the agent packages that writes to a socket _and_ serializes now has to
  be listed with a reason.

- 15593db: A boot that will not finish says so, instead of letting you wait

  Two halves of one question — what ends the wait for a device to come up — and both used to be answered by
  a timeout somewhere else.

  What you can observe:

  - **A boot that gets overtaken fails immediately, with the reason.** Re-pick a device while the first one
    is still starting, or shut it down mid-boot, and the agent used to abandon the earlier boot silently.
    Nothing was sent in either direction, so whoever asked found out by waiting: 30 seconds for an MCP
    caller, two minutes for a flow run, forever for a spinner. An abandoned boot is now answered on its own
    request — as superseded by a newer boot, abandoned by a shutdown, or invalidated by the agent losing the
    relay — whenever the agent still has an open connection to send that answer on. When it does not, the
    paragraph at the end of this note applies instead.
  - **A slow cold boot is no longer reported as a failure that never happened.** The agents poll a booting
    device for up to 90 seconds (iOS) or 120 (Android) and then explain what went wrong. `mcp-server` gave
    up at 30 — inside both — so a device that was simply slow came back to the model as a bare timeout
    while the explanation was still on its way. `flow-runner` sat at exactly Android's 120, which left no
    room at all. Both now wait past the agent, and a check across the packages keeps them there: the
    numbers may change, the relationship may not. The cost of waiting longer is worth knowing: a wedged
    relay now blocks an MCP caller for three minutes rather than 30 seconds, so a host whose own tool
    timeout is shorter will cut in first with a message of its own.
  - **A tester is no longer told a boot failed when the failure belongs to a boot they replaced.** The
    viewer reports the failure of the boot it is waiting on, and an uncorrelated one — which is how a dead
    video stream is reported, and has no request behind it — exactly as before.
  - **Losing the relay mid-boot no longer leaves Android finishing a boot nobody owns.** Both agents drop
    their device state when the connection goes, but a boot already running holds its own reference to
    one; on Android it ran to completion against that, standing up a video stream and announcing the
    device ready for a session that no longer existed. iOS has invalidated in-flight boots there since its
    helper-leak fix. The two now agree.

  One thing deliberately stays silent: a boot abandoned when the agent has no open connection to the relay.
  The reply's own channel is what is missing. That case is covered by the relay, which declares the agent
  away and ends the session's waits inside its grace window — and `sendMsg` now checks that the socket is
  open rather than merely present, because sending to a closing one buffers the message and reports nothing,
  which is how an answer becomes a silence.

- 513b17b: feat(protocol): correlate input acks, and refuse an input from a socket that does not hold the session

  Closes #499. Five requests carry a required `requestId` — the four terminal frames (`input:touch:end`,
  `input:pinch:end`, `input:key`, `input:button`) and `input:type` — and so do the four replies. The four pairs
  already correlated arrive at the speed a person clicks a button; a swipe is dozens of frames, which is why an
  ack that missed its own deadline being consumed by the **next** input's waiter was never a corner case.

  **Opening and move frames carry none, and neither does `input:rotate`.** Nothing acks them, so an id there
  would name a waiter that does not exist.

  ## Required on both sides, and the compiler holds more here than anywhere else in this work

  No producer of these replies sends one unsolicited — `ackInput` fires on terminal outcomes only,
  `ackNoSession` answers a terminal input for a session the agent lost, and the relay answers one it cannot
  dispatch. Six producers of `input:error`, every one behind a request. So both sides are required, unlike the
  lifecycle pair (#521) whose replies have genuinely unsolicited producers.

  That matters concretely: the relay's own `input:error` goes through `sendTo(msg: RelayOutbound)` and the
  agents' through `sendMsg(msg: AgentControlOutbound)`, so omitting the echo is a **compile error** rather than
  something only a test could catch. That is the position #521 could not reach, and it is exactly where the same
  defect had already shipped twice.

  `input:type-error` moved from `AgentToBrowser` to `RelayOrAgentToBrowser`, because the relay produces it now —
  the compiler refused the send until the union said so, which is the rule `relay/AGENTS.md` states.

  ## The eleven input cases became two clauses

  Written into the shared body, the correlator gate would have dropped every opening and move frame with it: no
  swipe, no pinch, no rotation, and nothing said. `correlatedRequestsGated` resolves fall-through by sharing the
  next non-empty body, so it would have read one gate as covering all eleven — the trap `#521`'s own comment
  documents, walked into one slice later. `TERMINAL_INPUT_TYPES` is deleted: the clause labels are the
  definition now, and a second source of truth for "which inputs are answered" is what this work removes.

  ## The sender must hold the session — on every branch, not just input

  Folded in rather than deferred, because it changes this layer's own reasoning: with the check, a foreign
  `input:error` cannot reach the dashboard, so the rule "the dashboard does not correlate" gets a durable reason
  instead of one a later slice deletes.

  Review then found that **input was one branch of ten.** The relay acted on every browser→agent command on the
  strength of the session existing — `clipboard:write` pasting attacker text into the victim's device,
  `clipboard:read` pressing copy or cut on it with the payload landing on _that_ tester's host OS clipboard,
  `session:end` deleting their session. `clipboard:data` has asked the mirror-image question since the bridge
  was written, with the reason beside it; the browser direction had none anywhere. And the hole was already
  documented in-repo: `SessionList.tsx` sends `session:start` before a shutdown purely to work around it, and
  its comment says so.

  So the check now covers the five acked inputs, `device:boot`, `open-url`, `app:install`, `app:launch`,
  `app:clear-state`, `clipboard:read`, `clipboard:write`, `session:leave` and `session:end`. Nothing in-repo
  relied on the old behaviour — every sender joins first, and the dashboard's app, deeplink and clipboard
  senders all live under the component that joins.

  `dispatchTarget` decides it once: session exists, this socket holds it, agent connected. That collapsed three
  conditions spread across seven `case` bodies as two each — with ownership in none of them — so the cases got
  **shorter**. The app-command handlers check ownership directly instead, after the session lookup and before
  the build lookup: the resolver also decides agent liveness, and using it there would move `agent offline`
  ahead of `Build not found`, changing which of two simultaneous problems the caller is told about.

  A refusal is **answered where a waiter exists** and dropped where none does. Answering is the load-bearing
  half: a session that has never acked reports silence as _success_, so dropping would report a command that
  never left the relay as having landed. `session:leave` and `session:end` have no reply, so they are dropped —
  the same asymmetry as the input frames nothing acks.

  `not-session-owner` is its own reason on this set's rule — one reason per thing a consumer must do
  differently — and it is the only member that can promise nothing reached the device, so the first whose advice
  says "retry after joining" without a hedge (#491). Two prose strings behind it (`ownershipRefusal`), because
  telling a caller the session is in use when it is idle steers it off a device it could have had.

  **`device:shutdown` is the one command left out of the ownership gate**, and the blocker is the dashboard
  rather than the relay:
  three of its four senders come from `useAgentSession`, whose socket never joins, so the gate would break going
  back and the unmount teardown. The question is whether that hook should join — #527.

  One diagnosis improved for free: `open-url` answered `'agent offline'` for a session the relay does not have,
  which is the wrong-diagnosis class #492 fixed for `device:boot` and `input:error` and had left here. The
  shared resolver corrected it, and the test that pinned the old prose says so.

  ## A second door predicate: the request must name a session

  CodeRabbit found that `isCorrelated` validated `requestId` only, so a command with no `sessionId` — or an
  empty one, which type-checks and which `mcp-server`'s bare `z.string()` tool schemas let a model produce —
  reached the reply builders and shipped a frame whose **required** `sessionId` `JSON.stringify` erases. Every
  consumer's session gate then discards it, so the caller waits out its deadline with the diagnosis in hand and
  no way to attribute it. `isAddressed` closes it at the same doors, with the same policy: not forwarded, not
  answered, logged.

  **Dropped rather than answered, and the note this contradicts is in this repo.** `SessionError`'s doc said
  "the only correct thing for it to send with no sessionId is `{ type: 'error' }`". That was written before
  requests carried a second correlator, and its own premise refutes it now: `GenericError` has no `requestId`,
  so a caller that receives one cannot attribute it and waits out the same deadline it would have waited out on
  silence. Answering was never the payoff — not shipping a frame that violates its own declaration is, and
  dropping achieves that more cheaply. Widening `SessionStartFailure` to carry an "unaddressed" reason was the
  alternative, and it is what L5d is for: that union's own doc says it has a single producer in
  `handleSessionStart`, so adding a member would make that false while pre-deciding what `error` is.

  Narrowing `dispatchTarget` to `sessionId: string` is what found the doors — exactly four compile errors, then
  the handler signatures carried the rest. **Seven `msg.sessionId!` assertions went away** on the request side
  as a consequence, which is the payoff `SessionError`'s doc predicted. Twelve are left, and reviewing L5d
  corrected the sentence that stood here: they are **not** all agent→browser forwards. Eight are; `stream:register`,
  `device:shutdown` and `forwardUnacked` are request-side paths that deliberately carry no address gate, and
  `handleAckedInput`'s assertion is dead — this slice's own door predicate narrowed that parameter, so the `!`
  counted itself into #444's body while asserting nothing. Still #444, minus one line L5d removes.

  Three places got the predicate and then **had it removed again**, because a mutation showed there was nothing
  observable to hold it with: the unacked input clause, `device:shutdown`, and the two session commands. In each
  the frame is dropped by the session miss anyway, so the gate bought only its log — one line per
  `input:touch:move` in the first case, which is the ~60/s the ownership warn had already been removed from that
  same method for. A line no test can hold is a line that will drift, and the reason is recorded at each site.

  ## The ledger records a _correlated_ ack

  `ackedSessions` gates whether silence is fatal, and it now records `input:done` only when it carries a
  correlator. `strict` licenses one inference — _silence here is an anomaly, not an agent that does not ack_ —
  and for an agent that never carries a correlator, silence at the waiter is **structural**: its acks can never
  match. Recording it would make every input after the first report a failure the agent had no way to avoid.

  Not a provenance question, which is what a first draft claimed: an id-less `input:done` is still the agent's
  word. What it lacks is attribution, and attribution is the waiter's question. Nor is the condition "an id
  _this client_ issued" — that needs a set of issued ids outliving their waiters, and since the late ack is
  precisely the one worth recording, the set would never shrink in a long-lived stdio process.

  The cost lands on agents predating the correlator, and it is not a revert of #457: `mcp-server/AGENTS.md`
  already documented that an agent whose acks never arrive keeps the optimistic path. This widens that
  exemption from "predating the ack protocol" to "predating the correlator". Because there is **no version
  handshake anywhere** in this system, an id-less ack is the only skew signal that exists — so it goes in a
  second set carrying no strictness, logged once per session. Dropped silently, the session would return to
  optimistic reporting, which from an operator's seat is indistinguishable from #457.

  ## Not closed: #517

  `input:keyboard:toggle` stays out, and not for the reason a first draft gave. It **has** a reply on iOS
  (`keyboard:toggled`) with a consumer that sets session state; what is missing is the **failure half** — the
  `.catch` only logs, so the pending flag never clears and the button latches off. Correlating a pair whose
  failure half does not exist leaves it half-correlated, and the missing half is platform-asymmetric, since
  Android's toggle has no device-side effect at all. #517 is the prerequisite.

  ## What the mutation round found

  **26 mutations, none surviving** — reached in three rounds, and what each round found is the story.

  Round one: nine mutations, **five alive** on a green suite. The correlator gate deleted (600 relay tests
  passed), the ownership check deleted (600 passed), both agents' `input:done` echo replaced with a literal,
  `ackNoSession`'s echo likewise, and a `sessionId` fallback added back to the waiter (77 passed). Every one was
  a test the plan had specified and this work had not written — the same blind spot as #521, where fixing the
  fixtures felt like finishing.

  Round two, after six new tests: the two review channels found **four more**, and the sharpest was not a gap in
  coverage but a new failure mode. `flow-runner`'s `tap`, `swipe` and `pressKey` await nothing, so setting their
  minted id to `''` left all 63 tests passing while every frame was dropped at the relay's door — a flow whose
  taps never left the relay reports **PASS**. The old code could not fail that way, because there was no id to
  get wrong. Also unpinned: the `input:error` half of both agents' `ackInput` (worse than a hang — an unmatched
  reply resolves _optimistically_, so a stated device failure reaches the caller as success), `input:type`'s
  correlation on all four producers and both consumers, and an **unheld** session accepting input from anyone.

  Round three: two of the tests written in round two were themselves Potemkin. Both staged a stale reply and
  then asserted the request count — 1 either way, so they passed with the correlator check deleted. Making the
  stale reply an _error_ is what made which reply resolved the call observable. Asserting a property needs the
  mutation that removes it to fail, and counting requests was not that.

  Six more mutations cover the widened gate, including one that collapses the two ownership prose strings into
  one (nine tests) and one that drops `Session not found` from the resolver (four).

  Two things caught by tooling rather than by me. `pnpm exec tsc -b` does not cover
  `protocol/tsconfig.assertions.json`, so four errors there passed straight through my checks until the
  pre-commit hook refused the commit. And lint reported `TERMINAL_INPUT_TYPES` dead the moment the clause split
  removed its last use.

  Promoting the request side hung both agent suites rather than failing to compile: 64 fixtures across
  `IOSAgent.test.ts` and `AndroidAgent.test.ts` send these inputs from inside `JSON.stringify({ … })`, where no
  annotation exists for a compiler to check. Third slice in a row on that surface — worth a rule for the agent
  packages, as the dashboard has, and out of scope here.

- b5ea86d: feat(protocol): give `input:error` a machine-readable `reason`, so a caller can tell "retry" from "reconnect" from "never"

  `input:error` carried a human-readable `message` and nothing else, so three different situations
  arrived looking identical: an input that would land if retried in 200ms, one that needs a reconnect,
  and one that will never work. With nothing to switch on, a caller could only give up or blindly retry.
  (This is not the same gap as `mcp-server`'s optimistic timeout fallback, which fires when no ack
  arrives at all — that is #457.)

  `InputErrorReason` is a closed string-literal union in `@tapflowio/protocol`, and the set comes from
  **what a consumer must do differently** rather than from how many internal states an agent has. iOS
  has one input path; Android has three. Each agent maps its own states onto the smaller set, so the
  wire contract stays the same size while the platforms stay different.

  - **`channel-starting` is the reason that had no name.** iOS's input helper needs a measured
    186–247ms after spawn before an injected frame reaches the device, and `device:ready` can arrive
    inside that window — so a caller tapping as soon as a boot returned was told the channel was gone
    when it was merely coming up. It now says so, and says to retry.
  - **A refusal from a healthy channel is no longer reported as a dead one.** iOS's gesture-ownership
    guard answers `no-gesture`, which carries its own advice: the message was well-formed and the
    channel may be fine, but _this_ frame can never land, so the caller opens a new gesture rather than
    retrying or giving up. Ownership is checked before readiness, because a gesture whose opening frame
    was refused inside the start-up window owns nothing — reading readiness first told that caller
    "never retry" for the very case `channel-starting` exists to serve.
  - **iOS answers a terminal input for a session it lost state for** (#489), where all four terminal
    handlers used to return silently. Nothing answered, so the caller waited out its own timeout — and
    MCP's fallback reports that as success. Both agents now map it to `channel-unavailable`. Opening
    frames stay silent, since nothing is waiting on them.
  - **`message` stays free prose.** That is what lets iOS keep `unknown key code: KeyFoo` while adding
    `reason: 'unsupported'` — the machine field is separate, so parameterised wording survives.
  - `mcp-server` includes the reason in the error it raises. Acting on it — retrying `channel-starting`
    rather than failing, and dropping the optimistic fallback for reasons that say never retry — is
    separate work.

  The field landed **optional**, so an agent that predates it omits it and nothing breaks; absence means
  _unknown_, never _fine_, and a consumer meeting an unfamiliar reason must treat it as
  `channel-unavailable`. Making it required is the breaking step, and **a later slice in this same release took it**: as of v0.19.0 `reason` is required and `message` is optional. The paragraph above describes the field as it landed, not as it ships — see the root changelog for the upgrade-together note. There is
  deliberately no shared message table: one would be a runtime value, and the protocol entry point has
  to erase under `import type` so it never reaches the dashboard bundle.

- c7d0064: fix(ios-agent): wait for the simulator to finish booting before announcing device:ready

  `simctl boot` returns when CoreSimulator has _accepted_ the boot, not when the device reaches `Booted`, and
  nothing waited for the difference. Measured on an iPhone 17 Pro / iOS 26.5: `xcrun simctl bootstatus` reported
  `Finished` **7.6 seconds** after `boot` had already returned. `device:ready` went out inside that window, so it
  announced something that was not yet true.

  `SimctlWrapper.waitUntilBooted` polls the device list until the device reports `booted` and returns what it
  read; `handleDeviceBoot` awaits it before `sendChromeData`, and a boot that never finishes ends as
  `device:boot-error` at a 90s deadline rather than as a ready device that is not up.

  Android has waited since the beginning (`EmulatorLauncher.waitForBoot` — `adb wait-for-device` plus a
  `sys.boot_completed` poll, awaited on both boot paths), so this closes an asymmetry rather than adding a
  policy. A human is slower than the gap and rarely notices; `mcp-server` installs and taps the moment it sees
  `device:ready`, and #440's "app install intermittently fails with _No devices are booted_" was this — targeting
  the session's udid removed one of its two causes and left this one, because the two were indistinguishable at
  the time.

  **Every status other than `booted` counts as still coming up, `shutdown` included.** `toDeviceStatus` collapses
  `Booting` into `unknown`, and the wait only ever runs after a `boot` was accepted, so a `shutdown` reading is
  the transition not yet observed rather than a failure.

  Keeping that sentence true costs one line elsewhere: **the boot is now issued on every path, including the one
  where the device list already said `booted`.** That skip came with the original on-demand boot feature as an
  obvious economy and had no recorded reason; once a wait existed it became the only route into it with nothing
  bringing the device up, so a tester who quit the simulator inside one `xcrun` round trip paid the full
  deadline. `SimctlWrapper.boot` swallows `Unable to boot device in current state: Booted`, so the economy was
  one no-op subprocess. A short grace on `shutdown` inside the poll was tried first and reverted: that reading is
  not distinguishable from a slow machine's healthy boot, so the clock would have failed real boots.

  A **failed** reading is not a reading at all — this spawns `xcrun simctl list` up to 180 times where the old
  code spawned it once, each an independent chance to kill a healthy boot during the interval when CoreSimulator
  is busiest, so failures are retried and the last one is reported with the deadline. Android's poll has always
  swallowed them.

  The wait also takes an `isStale` signal, checked every iteration. `handleDeviceBoot` is fire-and-forget and its
  `bootSeq` check runs only once the wait returns, so a shutdown arriving mid-wait would otherwise leave a poll
  spawning a process twice a second, for the rest of the deadline, against a device that is now deliberately off
  and will never converge.

  `DeviceStatus` is left alone throughout: widening it to carry `booting` would change a union `agent-core`
  publishes and the dashboard consumes, and the poll's exit condition never needed the distinction.

  The status sent with the chrome data stops being hardcoded. It was `status: 'booted'` written over a value that
  had just been fetched and discarded — a lie in the source that changes nothing observable, because
  `sendChromeData` reads `id`, `name`, `osVersion` and `typeId` and never `status`. What changes is that the value
  is now the one that was observed.

  **Known gap when this was written, closed by #549 in this same release — see "A boot that will not finish says so":** `mcp-server`'s `boot_device` waiter has a 30s deadline
  (`client.ts`), which now sits _inside_ the agent's 90s one. A cold or full-erase boot past 30s
  reports a bare timeout to the LLM rather than the reason the agent is about to send. Before this change that
  ceiling was unreachable, because the agent answered as soon as the boot was accepted — with the answer that
  `No devices are booted` came from. Raising it belongs with the `mcp-server` client rather than here.

  The seq re-check after the wait is load-bearing, not defensive: this is another multi-second `await`, and
  `sendChromeData` starts a helper process on the far side of it. A shutdown or a newer boot arriving in that gap
  would otherwise install a self-reviving helper for the device it is taking down — the same shape #484 had to
  add a check for after exactly this kind of gap.

- d4d68a0: `TouchHelper` and `KeyboardHelperDaemon` now escalate to `SIGKILL` if their helper process (`touch-helper` / `keyboard-helper`) does not exit within 1s of `SIGTERM` on `stop()`, matching the fallback already used by `ScreenCaptureStreamer` and `XCUITreeReader`. Previously `stop()` sent `SIGTERM` only, so a wedged helper process would linger indefinitely.
- a669e0a: feat(protocol): correlate device:boot and device:shutdown, with an optional correlator

  The lifecycle pair joins the four already correlated by `requestId` (`screenshot`, `ui:tree`, `clipboard`, the
  app commands). It is the first one whose correlator is **optional on every reply**, and that difference is the
  whole design — `device:ready`, `device:boot-error` and `device:shutdown-done` all have producers that answer no
  request at all, so absence has a real and permanent meaning: _this frame is not the answer to anything_.

  Consumers correlate when the id is present and fall back to `sessionId` + type when it is not
  (`mcp-server`, `flow-runner`). Precisely what that fallback carries is worth separating, because the two
  id-less cases arrive by different routes and only one of them is permanent:

  - **Android's mid-session `device:boot-error`** carries a `sessionId`, so it reaches a client waiter through
    the fallback. There is no request behind it and never will be, so this half does not expire.
  - **An agent predating the echo** likewise, on either reply. This half is compatibility slack.
  - **The relay's `device:ready` replay** does _not_ reach a client at all — it carries no `sessionId`, so the
    comparison ahead of the fallback excludes it, which is the point of the "not satisfied by the replay" test
    in both clients. It reaches the **dashboard**, and it gets there because `'sessionId' in msg` is false, not
    because of anything the correlator or the fallback does.

  What correlation buys on this pair is narrower than the obvious claim, and review caught the first draft
  making the obvious one. It does **not** let two concurrent boots both resolve: the agents answer a
  superseded boot with nothing at all (`bootSeq` returns silently at every checkpoint), so one of two
  overlapping boots times out either way. Both clients' `dispatch` resolves the first waiter whose predicate
  matches and then stops — so on `sessionId` + type alone, that single reply went to the boot registered
  **first**, the superseded one, and the boot that actually happened was reported as a failure. The
  correlator sends the reply to the request it answers. Same one timeout, correct attribution.

  ## What the design review changed

  The first draft made `DeviceReady.sessionId` required and had the relay stamp its replay, then argued the pair
  faced a forced choice: correlate strictly and break every agent predating the field, or keep a fallback and
  let a replayed ready satisfy an in-flight boot. Measured against a real `RelayServer`, that choice was
  manufactured by the draft itself. **The discriminator today is that the replay carries no `sessionId`**, and
  both boot waiters already depend on it — so requiring and stamping it is what deletes the working guard.
  Dropped from this change; `sessionId` on `device:ready` stays optional, and closing #516's deferral is its own
  later slice, which must carry a test pinning the _value_ stamped. There is none: with the stamp mutated to
  `session.deviceId` — a plausible slip on a line whose payload reads `{ deviceId: session.deviceId }` — the
  relay's 591 tests, the dashboard's 317 and the entire static suite still pass.

  The review also found the producer inventory wrong. `AndroidAgent.restartVideoStream` sends
  `device:boot-error` for a video stream that died mid-session and failed to restart, with no `device:boot`
  anywhere behind it. So that message qualifies for an optional correlator **on its own merits**, and the
  consumer that reads it — `DeviceViewer`, the only surface reporting a dead stream — must not gate on the
  correlator at all, or #426's symptom comes back.

  ## Optional means tests are the entire enforcement

  `<Pair>ReplyBody` cannot be built for a field an object may omit: `Omit<T,'sessionId'|'requestId'>` is
  satisfied by an object with no correlator, so the excess-property trick that catches a freshly minted id has
  nothing to bite on. And `scripts/__tests__/correlatedRequestsGated.test.mjs` derives its set from _required_
  declarations, so it does not see this pair — including the position that matters most: **the relay is itself a
  producer of `device:boot-error`**, answering a boot it cannot hand to an agent. An uncorrelated diagnosis
  there is read as unsolicited and discarded, and the caller waits out its deadline instead of failing. That
  exact defect shipped twice from agent code (`open-url:error`, then `clipboard:error` a slice later); here it
  sits where no check can reach, so a relay test holds it.

  Every echo, prohibition and fallback added here was verified by mutation — 23 of them, each failing only the
  tests that claim it: 5 on the relay, 7 across the two agents, 5 on the dashboard, 6 across the two clients.
  Two are worth naming. A _strict_ correlator gate on `device:boot-error` and a mere _presence_ check fail
  **different** tests, which is why both prohibition cases exist. And replacing an echoed id with a freshly
  minted one fails the echo test **and** the absence test — a shape that, one slice earlier, only the first of
  those caught.

  Those 23 shared a blind spot, and review found it: they all probed what the gate does **with** an id, so
  nothing held how ids enter or leave `bootIdsRef`. Four mutations survived the whole suite. The sharpest is
  `bootIdsRef.current.clear()` added to the `device:booting` branch — invited by the comment above it, since
  that is where every other per-cycle record is dropped, and fatal because both agents send `device:booting`
  _before_ the ready answering the same boot. Every real ready is then rejected while `setDeviceReady(true)`
  has already run: spinner cleared, device apparently healthy, app never installed, on the primary
  manual-testing path. The other three: the rebind boot's id never registered (so #426's recovery keeps the
  picture and loses the controls), the `session:joined` cross-cycle clear removed, and `mcp-server`'s
  `shutdownDevice` correlator left off the wire — where `toMatchObject` ignored the absent key and the
  mismatch test still passed against a hardcoded foreign id. All four are pinned now, each by one test.

  ## `DeviceBoot.requestId` is required, and 42 test fixtures said nothing about it

  The request side is asymmetric on purpose, and for a mechanical reason rather than a stylistic one: a
  request passes _through_ the relay, so one door gates and logs every sender at once, while a reply does not
  — the relay forwards it with `JSON.stringify` without inspecting it. Absence also has no legitimate meaning
  on a boot: nothing originates one but a browser. So `device:boot` is the pair's one required correlator,
  which is what puts it inside `correlatedRequestsGated` and makes the door gate reachable. `device:shutdown`
  stays optional because the relay sends that one itself, from its idle timer.

  Promoting it produced no compile error, and the reason is worth stating precisely, because the convenient
  version of it is false. It is **not** that the compiler cannot see the request side: all four `device:boot`
  senders go through a sink typed `BrowserToRelay` (`DeviceViewer.tsx:38`, `mcp-server/src/client.ts:182`,
  `flow-runner/src/RelayClient.ts:126`), so every one of them would have errored. They did not error because
  the earlier hunks of this same commit had already added the ids. The request side is exactly where the
  compiler works.

  What it produced instead was **two hung agent suites**. 42 fixtures across `IOSAgent.test.ts` and
  `AndroidAgent.test.ts` send `device:boot` through a real `RelayServer`; the door now drops them, and each
  test waited for a `device:ready` that never came. None was a type error, and typechecking the test folders
  would not have found them: those literals sit inside `JSON.stringify({ … })` at an untyped `ws.send`, so
  there is no annotation for a compiler to check. Three _documented_ recipes had the same shape and were
  updated too — `ios-agent/AGENTS.md`, `test-utils/src/socket.ts` and `test-utils/AGENTS.md` — because that
  first one is the file the 42 were copied from, so leaving it would hand the next contributor the same
  30-second mystery. The dashboard has a rule against untyped injected fixtures ("not `as never`, not a local
  shape") and the agent packages have no equivalent; worth one, and out of scope here.

  `case 'device:boot': case 'device:shutdown':` was one fall-through clause and is now two. Not cosmetic: the
  correlator on `device:shutdown` cannot be required, because the relay originates that message from its idle
  timer with no browser behind it — so a gate written into the shared body would have stopped the dashboard's
  four senders and the relay's own from reaching the agent, silently, in the one direction nothing replies to.

  `DeviceViewer` correlates `device:ready` only past the line that clears the spinner, which newly rejects a
  straggler ready from an earlier boot cycle — it used to release the current rebind and install on top of an
  install already in flight. It does **not** close the duplicate-install-on-re-join case that branch's comment
  describes: the replayed ready carries no id, so it is still accepted, and it has to be while an agent
  predating the echo answers the same way. Separating those two needs the replay to be identifiable on its own,
  which is the deferred `sessionId` tightening.

- 36160cb: fix(ios-agent): make the MJPEG fallback actually produce JPEG

  `MjpegStreamer` called `simctl.screenshot(udid)` with no format, and that argument defaults to PNG —
  so the fallback streamer emitted PNG bytes while `IOSAgent` stamped `CODEC_JPEG` on every frame of
  it. The class names its codec, and it was the last place still getting this wrong after #508 fixed
  the same lie on the screenshot path.

  No in-repo entrypoint reaches it: `intervalMs` is what selects this streamer over the IOSurface path,
  and nothing but tests passes one. That is why nobody saw it.

  **It is not unreachable, and this is a behaviour change for one caller.** `IOSAgent`,
  `IOSAgentOptions` and `MjpegStreamer` are all public exports of this package, so a consumer that sets
  `intervalMs` has been receiving PNG bytes under a JPEG stamp and will now receive JPEG. Nothing in the
  browser path breaks either way — `createImageBitmap` sniffs magic bytes and decoded the PNG regardless
  — which is why the fix is one argument rather than a migration.

  Two sentences that described the old behaviour as correct are updated with it.

- a97efa9: fix(ios-agent): recover from a dead touch-helper instead of dropping every input silently

  When the `touch-helper` process died on its own, `TouchHelper` kept pointing at the corpse and
  every write returned early at a `stdin.writable` guard. The session accepted no further input for
  the rest of its life while the stream kept running, so the viewer tapped a screen that updated
  normally and nothing happened — and nothing was reported to the browser or to an MCP caller.

  - The helper is now replaced when it dies rather than on the next input — as soon as the spawn
    budget below allows it — so the first tap after a death does not wait for the replacement to
    start up.
  - Replacing is bounded to 3 spawns in any 30-second window, which self-clears, so a helper that
    cannot run does not churn processes and a transient failure is not permanent.
  - A helper that never announces readiness at all is replaced after a deadline. Otherwise
    running-but-never-ready has no exit: nothing asks for a replacement because it is running, and
    every input is refused because it is not ready.
  - A gesture is only ever continued by the process that _received its opening frame_. A touch end or pinch end injects
    coordinates the _previous_ process had latched, so delivering one to a replacement would release
    the touch at (0,0) and report success; a move with no preceding down is not the gesture the
    tester made either. Both are refused, even when a healthy replacement is available.
  - A freshly spawned helper is not usable for its first ~200ms, and a frame written before it starts
    reading stdin lands nothing at all — the frames buffer and then drain in one go, which collapses a
    swipe into microseconds. The helper already announced when it was ready; that announcement is now
    what gates a write, so those frames report failure instead of reporting success and vanishing.
    This was reachable without any helper death: an MCP caller tapping as soon as `boot_device`
    returns is inside that window.
  - Terminal inputs now ack on whether the write reached a helper that is ready to inject rather than
    on whether the helper object exists. `input:touch:end`, `input:pinch:end`, `input:key`, `input:button`,
    `input:type` and `clipboard:write` with `pasteAfter` answer an error instead of success when the
    input was dropped. Two `input:button` branches deliberately write nothing — a home press-down and
    a button with no HID mapping on this device's chrome — and those answer from the channel's health
    instead, so a healthy channel is not reported as a failure and a dead one is not reported as a
    success.

- 5ab537d: Type-check and lint the test trees

  Backfills: #537

  <!-- changelog: internal — a per-package `typecheck` script and a test-tree tsconfig; no runtime or interface change a self-hoster can observe -->

  Every package's build tsconfig excluded `src/__tests__` and eslint ignored it, so a test double could
  drift from the interface it doubled with both gates green. The manifests gained a `typecheck` script and
  the test trees a tsconfig of their own, which is the only reason this touches published files at all.
  What the gates then found was inside the tests: a double declaring `implements DeviceAgent` while missing
  two members, five duplicate object keys, a call passing one argument to a two-argument method, and a
  `test-utils` constraint no named message could satisfy.

  The CLI is `tapflow`, not `@tapflowio/cli` — the manifest name, which is what `changeset version` resolves.

- 2317d50: feat(protocol): open-url carries a requestId, and both replies echo it

  First pair of the request/response correlation work. `open-url` requests carry a `requestId` and
  `open-url:done` / `open-url:error` echo it, so a caller matches its own reply instead of matching on
  `sessionId` + message type and taking whichever arrives first.

  Nine request/response pairs correlate that way today, and it is the shared root of #499, #512's first
  finding, and the seven relay reply sites in #444. Three other pairs — `screenshot`, `ui:tree`,
  `clipboard` — already carry a `requestId` and have no such issues. This layer extends what works rather
  than inventing anything.

  **`requestId` is required on the reply, not optional, and the reasoning is worth keeping.** A first draft
  made it optional so that an agent predating the field would not falsify the declaration. Review measured
  that decision and reversed it:

  - Required yields **complete, precise** in-repo compile errors — ten, at exactly the ten production sites
    for this pair, nothing else. L4a's typed agent sends are what make the write side fully covered.
  - Optional needs a static check to replace the compiler, and that check **cannot exist.** Presence is
    checkable; the property is _provenance_ — that the id is the request's. A check built and run against
    the clipboard family (100% correlated today) produced seven false positives, because
    `respond({ sessionId, requestId, ...body })` puts the `type` literal and the id in different object
    literals; and it passed when an echo was replaced with a freshly minted id.
  - Absence would carry **two** meanings wanting opposite handling — "an old agent" and "not a reply at
    all". The relay's `device:ready` replay is a permanent producer of the second, and reading it as the
    first is the `{booted: true}` for a boot that never happened that #516 measured and refused to ship.
  - The repo had already decided this seven times: of the eleven messages declaring `requestId`, seven are
    agent-produced replies and all are required.

  The echo is enforced by a mix, and the mix is worth stating precisely because review measured 13 attacks
  and the type caught 3. **Omitting the correlator is a compile error** — from `requestId: string` being
  required on the reply interfaces, reached through the agents' typed send helper. **A freshly minted id
  written as a literal at the `respond(...)` call is an excess property** — that one is `OpenUrlReplyBody`,
  the reply minus the ids, mirroring `ClipboardReplyBody`. The agents spread `...body` **first** so that a
  body _variable_ carrying an id cannot override the real one; excess-property checking does not fire on
  variables, and an earlier draft had the ids first, which let a wrong id win.

  What the types do **not** cover: the agents' send helper accepts any `string`, so a site that bypasses
  `respond` type-checks. Each agent's echo tests are what catch that, including a **concurrency** test —
  hoisting the correlator out of per-request scope compiles clean, passes every other test, and answers two
  in-flight requests with the second one's id, which is precisely the class this layer removes. So each
  remaining pair needs its own echo tests; this helper does not remove that work.

  There is deliberately **no fallback** to `sessionId` + type. The `fixed` version group locks protocol,
  agent-core, both agents and the relay together, so the in-repo skew window is zero. An `open-url` with no
  `requestId` is dropped rather than answered — by both agents **and by the relay**, which is one policy
  instead of the two an earlier draft had: it answered with `requestId: msg.requestId!`, and that is not the
  `sessionId!` beside it in kind. `sessionId!` feeds a read, so a miss still produces a visible error;
  `requestId!` feeds a write into an outbound frame, where `JSON.stringify` drops the key and ships an
  `open-url:error` whose required correlator is absent — which every correlating consumer then discards,
  turning "agent offline" into a caller waiting out its full deadline. The relay drops such a request at the
  door now — before either branch, so forwarding and answering share one policy rather than two. General
  inbound validation is still issue #444's; this is one required field on one message, whose absence the
  relay can act on locally.

  **A reply from a third-party agent predating this field is dropped the same way** — the dashboard shows no
  toast and `mcp-server` / `flow-runner` wait out 15s. In-repo that cannot happen (the `fixed` group), but an
  independently installed older `mcp-server` or `flow-runner` will time out `openUrl` against a current
  relay. That is the upgrade note for this release.

  Two additions from an earlier draft were **removed** after review measured them inert: a `RequestReplies`
  / `ReplyOf` mapping with zero consumers repo-wide (deleting it left `tsc` and all 255 static assertions
  green — exactly the unenforced-mapping property its own doc comment criticised), and `OpenUrl` in
  `RelayToAgent`, whose stated reason was false: neither agent consumes that union, both still read a
  hand-written inbound literal, and removing the member changed nothing. They come back when a second pair
  needs them and something checks them.

  **Routing is unchanged and this does not fix it.** Replies are still delivered to whichever socket holds
  the session rather than to the requester, so an `mcp-server` deeplink on a dashboard-held session now has
  its reply dropped silently by the dashboard instead of toasted as a lie. Correct at both endpoints, still
  misaddressed in the middle — the relay already keys replies by `requestId` for `screenshot` / `ui:tree`
  via a pending map, and the same shape would fix it.

  **The dashboard was a producer nobody had counted, and correlating it fixes a live bug.** It sends
  `open-url` from `DeepLinkDialog`, and `DeviceViewer` toasts the reply — but a reply does not go to whoever
  asked, it goes to whichever socket holds the session, so the viewer was showing "Deeplink opened" for
  `mcp-server`'s deeplinks. The viewer mints and records the id now and toasts only its own. The id comes
  from `getRandomValues`, not `crypto.randomUUID`, which is secure-context only and therefore absent on the
  plain-HTTP LAN deployment that is tapflow's primary path.

  Also: `open-url` had **no test on the iOS side** — the whole change passed that suite because nothing
  exercised the handler, and `SimctlWrapper`'s test double had no `openUrl` at all. Both agents now cover
  the echo and the drop.

- 760e27a: feat(protocol): the app commands carry a requestId, and the relay carries it across a rebuild

  `app:install`, `app:launch` and `app:clear-state` now correlate by `requestId` like `open-url`, so a caller
  matches its own reply instead of matching on `sessionId` + message type and taking whichever arrives first.

  **Two of the three are not forwards, and that is the new part.** `open-url` was re-serialised whole, so the
  correlator rode along for free. `app:install` / `app:launch` arrive carrying a `buildId`, and the relay
  looks up the build and sends the agent a **different message** — so the id has to be copied across the
  rebuild or the agent's reply, which the relay forwards without inspecting, cannot be attributed to
  anything. `AppInstallToAgent` / `AppLaunchToAgent` declare it required, which makes _dropping_ the copy a
  compile error.

  **The reply direction is held entirely by tests, and the first version of this change had none of them.**
  Review made both relay `fail()` closures, the clear-state error exit and all six agent `respond` helpers emit
  a fabricated correlator, and every suite held its baseline exactly. A wrong echo is worse than a
  misattribution now that consumers gate strictly: the dashboard discards the reply and nothing clears
  `installing`, so the Launch control never appears, and the MCP caller burns its full deadline. There are
  assertions on all nine relay error exits, echo tests per pair on both agents, six concurrency tests (the
  mutation that hoists the correlator out of per-request scope was invisible to everything else), dashboard
  tests for both gates, and `mcp-server` tests that fail if the predicate reverts to `sessionId` — which it
  could, silently, before.

  **Nothing type-checks that the copied value is the request's**, and that is not for want of trying. Four
  candidate guards were built and broken: a branded `CorrelatedId` is laundered by any cast to the brand,
  because a brand names a _kind_ while provenance is a property of the _instance_ and TypeScript has no
  value-dependent types; a generic `Omit`-body helper does not compile without a cast of its own, which is
  worse than the literal it replaces since a literal at least gets its whole shape checked. So the reply side
  keeps its `<Pair>ReplyBody` — worth it there, with ~20 literal sites — and the request side is held by
  tests, one per handler, asserting the forwarded id is the one that came in.

  **`device:shutdown` was in this slice and came out.** It had no error type at the time (#542 added one
  later in the same release), and two properties this shape cannot express: the relay **originates** one itself when a browser socket closes (`DeviceShutdown` is a
  single interface shared by both directions, so a required correlator would force the relay to invent an id
  for a request nobody made — exactly what the door checks exist to prevent), and `device:shutdown-done` is
  consumed by `SessionList` as a **device-status broadcast** rather than as a reply to its own request. That
  second property is why `device:ready` was carved out too, so the two go together into the slice that
  decides what a relay-originated request and a dual-role reply mean. It also cannot have a meaningful
  concurrency test — the agents' shutdown handler returns early once state is gone, so a second request
  produces no second reply to correlate.

  **An agent older than this field strands the command, and that is the upgrade cost.** The earlier draft
  argued the skew window is zero because the packages share a `fixed` version group — but `fixed` makes them
  _release_ together, not _install_ together, and the agent runs on a tester's Mac installed separately from
  the relay. Such an agent's `app:install-done` has the key absent, the dashboard discards it, and "Installing…"
  persists with no Launch control. For `open-url` last slice the same skew cost a toast; here it costs the
  primary manual-testing flow. The relay's door checks log now, since otherwise all three hops are silent.

  **Door checks, one policy per request**: an uncorrelatable request is not forwarded, not rebuilt and not
  answered, since every reply these produce declares `requestId` as required. They go through a type
  predicate rather than a bare `typeof`, because a bare check narrows the property and not the object — the
  handler call would not compile — and because narrowing does not survive into a nested function, so a
  `fail()` closure built after the check sees `string | undefined` again, whose shortest fix is the
  `msg.requestId!` that was removed for `open-url` in the previous slice.

  `clipboard:read` / `clipboard:write` get the same door check, and `clipboard:error` stops asserting
  `msg.requestId!`. Not part of this slice's pairs — clipboard has carried a required correlator since it was
  written — but it had the identical defect, and leaving it would have made this change's own claim of one
  policy at the door false the moment it landed.

  The dashboard mints and records ids for its install and launch, like it does for deeplinks, so an
  `mcp-server` install on a session this viewer holds no longer flips its install state. The relay delivers a
  reply to whichever socket holds the session, not to whoever asked.

  One thing this does **not** cover, stated because "every exit carries the request's id" would be false: a
  throw out of the build lookup — SQLITE_BUSY, a closed database, I/O — unwinds to the message-loop catch and
  answers nothing at all. Pre-existing and unchanged.

- Updated dependencies [a5466b9]
- Updated dependencies [d63811f]
- Updated dependencies [15593db]
- Updated dependencies [42987e1]
- Updated dependencies [87cd901]
- Updated dependencies [4d4fe13]
- Updated dependencies [17a7484]
- Updated dependencies [513b17b]
- Updated dependencies [1ce516f]
- Updated dependencies [b5ea86d]
- Updated dependencies [a669e0a]
- Updated dependencies [ef2dac8]
- Updated dependencies [e55371c]
- Updated dependencies [e8b29b8]
- Updated dependencies [3f903c8]
- Updated dependencies [7ad6343]
- Updated dependencies [5ab537d]
- Updated dependencies [e84a2ea]
- Updated dependencies [b459157]
- Updated dependencies [2317d50]
- Updated dependencies [760e27a]
  - @tapflowio/protocol@0.19.0
  - @tapflowio/agent-core@0.19.0
  - @tapflowio/audiotap-helper@0.3.0

## 0.18.0

### Patch Changes

- 971e375: Remove the dead `Simulator.app` hide from `SimctlWrapper.boot`. On the supported Xcode (26.x) `simctl boot` does not open Simulator.app, so the `osascript` call failed with `-10006` on every boot while its callback swallowed the error — it hid nothing, and its silence meant nobody would notice if the assumption changed back. The occlusion throttle it was guarding against only applies to a window that is on screen. Verified by quitting Simulator.app entirely and booting from the dashboard: no Simulator process appears.

  Also make `SimctlWrapper.shutdown` tolerate an already-stopped device, mirroring the guard `boot` has had. Tearing down a session whose device is already `Shutdown` raised `code=405 / Unable to shutdown device in current state: Shutdown`, so a routine teardown logged `shutdown failed` and became indistinguishable from a device that genuinely refused to stop.

- bd9eb37: Fix Full reset erasing devices nobody asked to erase, and failing on the ones people did.

  Two defects that were only safe together. `resetMode` lived in a `useState` that nothing reset: leaving a session with `← All Macs` is a conditional re-render, not an unmount, so an armed toggle survived it and the _next_ device the tester picked was erased too. Separately, `IOSAgent` called `simctl erase` without checking device state, and `erase` refuses a device that is not shut down — so an explicit Full reset on a device that was already running died with `Boot failed: Command failed: xcrun simctl erase <udid>`.

  The second was containing the first: the unwanted erase usually targeted a booted device, so it threw and destroyed nothing. Fixing only the agent would have turned that loud failure into silent data loss, so both move together.

  - **dashboard**: Full reset is now a one-shot intent — arming it applies to the next device you pick and then disarms itself. Asking twice means turning it on twice. The mode the viewer was launched with is held separately from the toggle, so disarming does not disturb the running session.
  - **dashboard**: only the first `device:boot` of a viewer mount carries the reset. `session:joined` arrives again on every socket reconnect, so a Wi-Fi blip or a sleeping laptop would otherwise re-erase the device the tester is looking at, with no click involved.
  - **dashboard**: the toggle is not offered on Android, where nothing acts on it (#447). It used to stay visibly on having done nothing; self-disarming would have made that read as "done".
  - **ios-agent**: shut a running device down before erasing it. Any state other than `Shutdown` gets the shutdown — `Booting` and `Shutting Down` refuse an erase exactly as `Booted` does, and re-picking a device while its shutdown is still draining lands there. The request is never silently skipped.
  - **ios-agent**: if the erase itself fails, boot the device back up before reporting the error — but only when the device really was running and no newer boot has overtaken this one. The shutdown was ours to undo; a device that was already stopping, or one the tester has since asked to stop, is not.

- 535c726: Target the session's simulator, not "whichever one is booted".

  Every app command in `SimctlWrapper` passed `booted` — simctl's alias for the running device — instead of the session's udid: `install`, `launch`, `uninstall`, `terminate`, `get_app_container`, `io screenshot`. With one simulator up that happens to be right. With two, the command lands on whichever simctl picks, and the wrong device accepts it without complaint. Today the defect usually surfaces as `No devices are booted` — loud, and only because nothing was running at all. The quiet case is the one worth fixing.

  `AndroidAgent` already passes an explicit serial; this brings iOS in line.

  - The udid is a required leading parameter with **no default**. A default is how the alias would come back: every call site keeps compiling and every test stays green while the old behaviour returns. `ScreenCaptureStreamer`'s `udid: string = 'booted'` was exactly that, and it is gone too.
  - Session call sites pass `DeviceState.deviceId`. `MjpegStreamer` takes the device through its constructor rather than reaching for the alias mid-stream.
  - The three `DeviceAgent` entry points (`installApp`, `launchApp`, `screenshot`) have no device parameter — the interface is shared with Android and predates multi-session agents. They resolve the one **booted** session and throw when there is none, or when there is more than one. Filtering on booted matters: the relay opens a session per registered simulator, so "the first entry" is whichever simctl listed first, usually shut down — worse than the alias, which at least found the device that was running.

  The same lookup backed `queryUITree`, `stream`, `openUrl` and the input methods, so they went through it too. Input does nothing rather than throwing when the answer is ambiguous — refusing a tap is worse than dropping one.

  One call the compiler could not catch: `screenshot(format)` stayed type-correct when a leading `udid: string` was added — the format string simply became the device id. Tests assert the arguments rather than trusting the signature.

  - @tapflowio/agent-core@0.18.0
  - @tapflowio/audiotap-helper@0.2.8

## 0.17.0

### Minor Changes

- 661356e: Share the clipboard between the dashboard and the simulator/emulator.

  **Paste** works everywhere, including plain-HTTP LAN deployments: Cmd/Ctrl+V in the viewer sends your clipboard to the device and pastes it there.

  **Copy** needs the dashboard served over HTTPS (or localhost). Cmd/Ctrl+C then brings what you copied on the device to your own clipboard in one press. On plain HTTP the copy still lands on the device and the dashboard says why it stopped there: proving the copy actually happened takes a round trip, and no clipboard API available on plain HTTP accepts a value that arrives that late. tapflow already supports LAN HTTPS, which WebCodecs hardware decoding also benefits from.

  Previously neither direction existed: text copied inside the simulator had no way out, so accounts, tokens and deep links had to be retyped by hand.

  - iOS reads and writes the device pasteboard through `simctl pbpaste`/`pbcopy`.
  - Android uses the emulator's gRPC clipboard API (the AVD images do not implement `adb shell cmd clipboard`). Devices on the scrcpy backend report the feature as unsupported instead of failing silently.
  - The agent presses the device-side chord itself and confirms the clipboard actually changed before answering, so a slow or busy device cannot hand back the previous value as if it were freshly copied. When it cannot, it says whether its marker is still on the device, so the viewer knows whether pressing the plain chord as a fallback is safe.
  - Adds the `clipboard:read` / `clipboard:write` / `clipboard:data` / `clipboard:write-done` / `clipboard:error` messages, and an agent capability list in `agent:register`. Additive on the wire: an agent that does not advertise `clipboard` is never sent these messages at all, and the viewer keeps forwarding the shortcuts as plain key input exactly as before — so **an agent running an older version keeps working, it just copies and pastes within the device only.** Update the agent to get the bridge.

- eaa78ac: MCP input tools now report what actually happened instead of always reporting success.

  `tap`, `swipe`, `press_key` and `press_button` were fire-and-forget: the tool answered `{tapped: true}` no matter what the agent did with the input. Against a session whose device is not booted the input was dropped and still reported as success — a false positive that also makes parallel test results untrustworthy.

  Agents now acknowledge a gesture's terminal message with `input:done` or `input:error`, and the tools surface that. `done` means the agent dispatched the input to a booted device; as with the existing `input:type-done`, it is not a guarantee the app reacted.

  Additive: an agent that does not send the ack is handled as before.

### Patch Changes

- eaa78ac: Fix iOS sessions that silently dropped every tap, swipe and keystroke after an agent reconnect.

  The input channel was created only during `device:boot`. When an agent reconnected while the simulator stayed booted, the session came back without one, so touch, pinch, key and button input were discarded with no error — the device looked responsive because screenshots and UI-tree reads went through a different path. Input now sets the channel up on demand.

  Buttons addressed by name still need a fresh `device:boot`; that is a narrower gap tracked separately.

  - @tapflowio/agent-core@0.17.0
  - @tapflowio/audiotap-helper@0.2.7

## 0.16.0

### Patch Changes

- @tapflowio/agent-core@0.16.0
- @tapflowio/audiotap-helper@0.2.6

## 0.15.0

### Patch Changes

- @tapflowio/agent-core@0.15.0
- @tapflowio/audiotap-helper@0.2.5

## 0.14.0

### Minor Changes

- ba0a3d8: Automated QA axis: UI accessibility tree queries and the deterministic flow runner.

  - `query_ui_tree` (MCP) / `GET /api/v1/sessions/:sessionId/ui-tree` — unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`), frames normalized 0-1 so a frame center feeds straight into `tap`. iOS reads the tree via a resident XCUITest runner inside the simulator — window-agnostic (no Simulator.app window required) and still no WebDriverAgent; Android via `uiautomator dump` with a device-side timeout.
  - `@tapflowio/flow-runner` (new package) + `tapflow flow run` — replay YAML flows with zero LLM calls: 10-step vocabulary, identifier/label selector resolution, condition-based waits, JUnit reports, failure screenshots, CI exit-code contract (0/1/2).
  - `run_flow` (MCP) — agents author a flow once, then replay it deterministically over the existing session.
  - New relay messages `app:clear-state` (reset app data — `pm clear` on Android, data-container wipe on iOS) and `input:type-done`/`input:type-error` (text-entry completion ack, so a following key press stays ordered). Text entry now waits for this ack: a self-hosted agent older than this release will not send it, so text steps time out — update the agent alongside the relay.
  - mcp-server and flow-runner graduate from the `experimental` dist-tag to the standard npm channel, versioned with the repo-wide fixed group.

### Patch Changes

- Updated dependencies [ba0a3d8]
  - @tapflowio/agent-core@0.14.0
  - @tapflowio/audiotap-helper@0.2.4

## 0.13.0

### Patch Changes

- @tapflowio/agent-core@0.13.0
- @tapflowio/audiotap-helper@0.2.3

## 0.12.0

### Minor Changes

- Accept EAS `eas build` iOS simulator artifacts (`.tar.gz` / `.tgz`) as a first-class build upload, alongside `.app.zip` and `.apk`. The archive is stored as-is (no re-zip) and extracted with `tar` at install time, so the `.app`'s executable bits and symlinks are preserved. Uploads are validated before storage — path traversal (`..`/absolute), symbolic/hard links, corrupt gzip, and gzip bombs (`TAPFLOW_MAX_UNPACKED_BYTES`, default upload cap ×4) are rejected. This removes the CI re-packaging step for Expo/EAS teams: `eas build → CI → tapflow` uploads the native `.tar.gz` directly.

### Patch Changes

- @tapflowio/agent-core@0.12.0
- @tapflowio/audiotap-helper@0.2.2

## 0.11.1

### Patch Changes

- Confine physical device-frame buttons to the bezel and add button press-and-hold.

  A tap inside the screen area is no longer hijacked as a button press (previously a circular hit-test around each button center could overlap the screen on devices where a button sits near the bezel, e.g. iPhone SE). HID buttons now support real-time hold: `input:button` accepts an optional `phase: 'down' | 'up'` so a button can be held instead of only tapped. The field is optional, so existing single-press clients (e.g. MCP sending `{ name }`) are unaffected.

  - @tapflowio/agent-core@0.11.1
  - @tapflowio/audiotap-helper@0.2.1

## 0.11.0

### Minor Changes

- 0c2b82c: Simulator audio output (device → browser) is now **on by default** for both iOS and Android. Opt out with `TAPFLOW_AUDIO=off` — one env for both platforms (`agent start --ios/--android` already selects the platform). The no-degradation contract (audio yields to video) keeps the video path safe whether audio is on or off.

  **iOS**: simulator processes are host processes, so tapflow taps the whole simulator's process tree with a Core Audio process tap (macOS 14.2+) — app audio + WebKit `WebContent` (web audio, e.g. YouTube in Safari) + system sounds, with no device routing, no dylib injection, no host-output hijack, on any signed build. The tap stays current as processes spawn and start/stop audio (process-tree polling + a Core Audio process-object listener); each simulator is isolated (no cross-bleed); the sim's own volume is reflected; and the host (agent Mac) stays muted so audio goes only to the browser. The audio-capture permission is primed at `tapflow agent start` — re-run it if browser audio is silent.

  **Android**: emulator audio is captured over gRPC `streamAudio`. Unlike iOS, the emulator also plays to the host Mac (it has no host-output-only mute) — use the Mac's own volume to silence it.

  Capture normalizes to 44100/Stereo/S16 and rides the existing `CODEC_AUDIO` transport. The capture runs in a small signed helper (`audiotap-helper`, iOS) launched via LaunchServices so it holds its own one-time audio-recording grant.

### Patch Changes

- 6bd8ebe: Symmetric host-mute for Android (#341): the emulator's audio no longer leaks to the agent Mac's speakers.

  The macOS Core Audio process-tap helper is now a shared package, `@tapflowio/audiotap-helper` (moved out of `ios-agent`), used by both platforms — so android-agent depending on it is a clean direction (no cross-platform-agent dependency). On macOS 14.2+, android-agent holds a **mute-only** `.muted` tap on the emulator's qemu process, silencing its host output while gRPC keeps capturing for the browser — matching iOS's `muteBehavior=.muted`. The helper self-exits when qemu dies; below 14.2 / non-macOS it's a no-op (fall back to the Mac's volume). `tapflow agent start` / `start` now also prime the audio-capture permission when Android is selected.

  `ios-agent` keeps the same public API (`requestAudioPermission`/`isAudioSupported` are re-exported from the shared package); only the helper's internal location changed.

- 3377bfe: Fix the package type entrypoint for npm consumers (#345). `exports.types` now points at the published `dist/*.d.ts` instead of `src/` — which isn't shipped in the tarball (`files` ships only `dist`/`bin`), so consumers couldn't resolve the package's types.

  The monorepo moves to **TypeScript project references** (each lib package gets `composite: true` + `references`, plus a root solution `tsconfig.json`). `typecheck`/`build` run via `tsc -b`, so workspace typecheck stays build-light (incremental, no manual dist build) while the published packages expose correct types from `dist`. No runtime or public API changes.

- Updated dependencies [6bd8ebe]
- Updated dependencies [3377bfe]
  - @tapflowio/audiotap-helper@0.2.0
  - @tapflowio/agent-core@0.11.0

## 0.10.0

### Patch Changes

- c3ea54c: The iOS screen-capture helper now reports a `capture-wait` metric under `TAPFLOW_STREAM_METRICS=1` — the polling gap between an IOSurface change and when the frame is encoded, emitted as `info: capture-wait avg/max/n` per 150-sample window. Diagnostic only; capture behavior is unchanged.
  - @tapflowio/agent-core@0.10.0

## 0.9.2

### Patch Changes

- 16-align downscaled encode dimensions to remove the WASM (tinyh264) green edge on the no-downscale tier.
- Updated dependencies
  - @tapflowio/agent-core@0.9.2

## 0.9.1

### Patch Changes

- @tapflowio/agent-core@0.9.1

## 0.9.0

### Patch Changes

- @tapflowio/agent-core@0.9.0

## 0.8.2

### Patch Changes

- @tapflowio/agent-core@0.8.2

## 0.8.1

### Patch Changes

- 80f4d78: iOS: auto-recover a simulator whose data directory vanished from disk. When an Xcode/macOS update prunes a runtime, `boot` fails with "cannot be located on disk"; the agent now erases the device to regenerate its data and retries the boot once (guarded so a healthy device is never erased), so dashboard/MCP sessions no longer dead-end on a broken simulator.

  Pre-boot is removed: `tapflow start` no longer boots a guessed device on startup. The agent only registers devices and boots on demand via `device:boot` (parity with android-agent). As a result, `--device` is now a relay-exposure filter (which simulators are exposed, default: all), not a boot target.

- 6e4801a: Restore remote agent connections to the relay (#271). The WS auth gate added in 17b8615 closed every non-loopback connection without a cookie/PAT, so no remote agent could register — the agent then hung forever on a silent pre-registration close ("Connecting ios agent…"). Remote agents now connect again, authenticated with a token.

  **Changed — remote agents now require a token.** A relay on a different machine only accepts agents that present a PAT with the new `agent` scope (create one in Settings → Tokens, pass it via `--token` or `TAPFLOW_AGENT_TOKEN`). Agents connecting to a relay on the same machine (`localhost`) stay unauthenticated, so `tapflow start` is unchanged. See [Remote relay authentication](https://www.tapflow.dev/operate/agents#remote-relay-authentication).

  Details:

  - relay: remote connections presenting a PAT with the new `agent` scope are accepted and roled by their first message (`agent:register` / `stream:register`); the rejection close reason explains the fix and is logged. Token creation API accepts a `scope` field (`agent` scope is Admin-only; default scope unchanged).
  - dashboard: token dialog gains an API/Agent type selector; creating an agent token shows a ready-to-run `tapflow agent start --token` command.
  - agents (iOS/Android): new `token` option sends `Authorization: Bearer` on the control and stream WS; pre-registration closes now reject with the close code/reason instead of hanging; handshake timeout (10s default); reconnect failures log their cause.
  - cli: `tapflow agent start --token` flag (or `TAPFLOW_AGENT_TOKEN` env); a 1008 rejection prints token setup guidance. Local (`localhost`) agents stay unauthenticated — `tapflow start` is unchanged.

- Updated dependencies [6e4801a]
  - @tapflowio/agent-core@0.8.1

## 0.8.1-next.0

### Patch Changes

- 80f4d78: iOS: auto-recover a simulator whose data directory vanished from disk. When an Xcode/macOS update prunes a runtime, `boot` fails with "cannot be located on disk"; the agent now erases the device to regenerate its data and retries the boot once (guarded so a healthy device is never erased), so dashboard/MCP sessions no longer dead-end on a broken simulator.

  Pre-boot is removed: `tapflow start` no longer boots a guessed device on startup. The agent only registers devices and boots on demand via `device:boot` (parity with android-agent). As a result, `--device` is now a relay-exposure filter (which simulators are exposed, default: all), not a boot target.

  - @tapflowio/agent-core@0.8.1-next.0

## 0.8.0

### Patch Changes

- @tapflowio/agent-core@0.8.0

## 0.8.0-next.4

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.4

## 0.8.0-next.3

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.3

## 0.8.0-next.2

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.2

## 0.8.0-next.1

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.1

## 0.8.0-next.0

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.0

## 0.7.0

### Minor Changes

- Low-latency render pipeline.

  - **Android host-encode**: emulators now capture over gRPC and encode H.264 on the Mac host (VideoToolbox). The gRPC backend is the default for emulators, with a 30fps cap and automatic scrcpy fallback; real devices continue to use scrcpy.
  - **Unified downscale**: per-session resolution is chosen from the viewer's connection context (native on a secure context, 1280px on LAN-HTTP, 1000px external) and is tunable via `TAPFLOW_MAX_SIZE` and the per-platform / `_LAN` / `_EXTERNAL` overrides.
  - **Relay IDR-on-rejoin**: the relay requests an IDR keyframe when a browser (re)joins a booted device, so a late joiner paints immediately.
  - **iOS**: static-frame skip, tear-free framebuffer snapshots, and keyframe-aware backpressure on the agent→relay stream.
  - **Android**: keyframe-aware backpressure and 16-aligned encode sizing to avoid macroblock padding on the WASM decoder.

  The dashboard unifies iOS/Android decoding and perf telemetry behind a single `useDecoderStream` hook (hardware WebCodecs on a secure context, WASM fallback otherwise).

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.7.0

## 0.6.1

### Patch Changes

- @tapflowio/agent-core@0.6.1

## 0.6.0

### Minor Changes

- Robust Android LAN streaming — keyframe-aware backpressure, on-demand IDR recovery, and idle-throttle prevention.

  - Android H.264 frames now carry the codec/keyframe flags in the stream envelope, so the relay's keyframe-aware backpressure preserves the reference chain under LAN congestion — it drops to the next keyframe instead of forwarding P-frames that tear. (`scrcpy send_frame_meta=true`; the public `stream()` contract is unchanged.)
  - On-demand IDR recovery for Android: the relay's `stream:request-idr` now resets the scrcpy encoder (RESET_VIDEO), resyncing fast instead of waiting for the periodic IDR — bringing Android congestion recovery to parity with iOS.
  - Agents hold a macOS power assertion (`caffeinate -i`) while connected so an unattended/idle Mac doesn't throttle the simulator/emulator. macOS-only; no-op elsewhere.
  - Fixed: the Android scrcpy stream now terminates on socket close, so the agent's pump and its timers no longer leak after a device shuts down.
  - Added: opt-in Android stream throughput metrics (`TAPFLOW_STREAM_METRICS=1`), matching the iOS agent.

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.6.0

## 0.5.1

### Patch Changes

- @tapflowio/agent-core@0.5.1

## 0.5.0

### Minor Changes

- H.264 streaming pipeline with automatic codec negotiation.

  - iOS streams H.264 by default (VideoToolbox encoder), cutting bandwidth ~10× vs JPEG (~16–27 KB/frame vs ~235 KB) for noticeably lower latency. Android streaming moves to a runtime decoder layer.
  - The browser advertises its decode capability (`acceptH264`) at boot; the agent picks H.264 only when the client can decode it, otherwise falls back to JPEG — no black screens on older browsers.
  - Tiered browser decoders: HTTPS → WebCodecs, plain-HTTP LAN → WASM (tinyh264), both WebGL2-rendered.

  Backward compatible: the envelope codec/keyframe marker reuses a previously zero flag byte, so older clients read frames as JPEG and the relay forwards payloads untouched. Agents without `acceptH264` (version skew) default to JPEG. Opt out of H.264 anytime with `TAPFLOW_IOS_CODEC=jpeg`.

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.5.0

## 0.4.1

### Patch Changes

- 17b8615: fix: path traversal in /uploads/ and unauthenticated WebSocket access
- Updated dependencies [17b8615]
  - @tapflowio/agent-core@0.4.1

## 0.4.0

### Minor Changes

- feat!: tapflow init redesign, Tailscale tunnel, web onboarding, and UX improvements

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.4.0

## 0.3.1

### Patch Changes

- Fix mcp-server release: add publishConfig for experimental tag and public access
- Updated dependencies
  - @tapflowio/agent-core@0.3.1

## 0.3.0

### Minor Changes

- bec7ff1: Release v0.3.0

  - relay: add screenshot REST endpoint (`GET /api/v1/sessions/:id/screenshot`) for CI and AI agent use
  - relay: enforce PAT scope checks on builds endpoints; new tokens include `view` scope by default
  - relay: add `session:leave` message type — MCP clients can disconnect without ending the session
  - relay: fix `.app` bundle names with spaces in zip upload validation
  - dashboard: add deeplink URL execution from QA session toolbar
  - dashboard: add keyboard shortcuts and Kbd UI to simulator toolbar
  - dashboard: add streaming performance overlay

### Patch Changes

- Updated dependencies [bec7ff1]
  - @tapflowio/agent-core@0.3.0

## 0.2.2

### Patch Changes

- @tapflowio/agent-core@0.2.2

## 0.2.1

### Patch Changes

- fix: WebSocket backpressure, Android pinch via scrcpy multi-touch, dashboard skeleton visibility
- Updated dependencies
  - @tapflowio/agent-core@0.2.1

## 0.2.0

### Minor Changes

- Add typed errors, CLI install banner, and dashboard toast feedback

  - **typed errors** (`agent-core`): `ValidationError`, `PlatformError`, `AuthError` exported from `@tapflowio/agent-core`; key runtime throw sites updated for typed `instanceof` handling (#63)
  - **CLI install banner**: `postinstall` prints success banner after global npm install (suppressed in CI / non-TTY / local workspace); `tapflow` with no args shows version banner and quick-start commands (#90)
  - **dashboard toast feedback**: sonner toasts on all key mutation flows — token create/revoke/copy, workspace/profile/password/app settings, app creation, build upload; `confirm()` replaced with `AlertDialog`; `toast.promise` for upload progress (#91)

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.2.0

## 0.1.0

### Patch Changes

- @tapflowio/agent-core@0.1.0

## 0.1.0-alpha.8

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.7

## 0.1.0-alpha.2

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.2
