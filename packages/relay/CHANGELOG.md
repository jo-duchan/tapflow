# @tapflowio/relay

## 0.24.0

### Minor Changes

- 2700746: Lean mode for iOS simulators. With `agent.lean: true` in `tapflow.config.json` (or `TAPFLOW_LEAN=on`), the agent turns off a fixed list of background services — Siri and Apple Intelligence background work, iCloud Keychain and backup, Health app and HomeKit, photo analysis, Screen Time, iMessage and FaceTime, Continuity, telemetry and similar — on each simulator it boots, and puts them back when it shuts the simulator down. Measured on iOS 27, a simulator uses about a quarter less memory. Wallpaper, widgets and the services apps commonly call (push, StoreKit, CloudKit, HealthKit, the photo picker, universal links and others) stay on; an app that needs one on the list should run with Lean mode off. `tapflow init` asks on a Mac (default off) and `tapflow doctor ios` reports it. iOS 18.5 or later. Android emulators get their own Lean mode in this release: four bundled Google apps kept disabled.
- 5407be5: **`tapflow migrate` runs every migration an install still needs.** It checks each one, lists what applies, asks once in a terminal and runs without asking elsewhere, and stops at the first failure with exit 1. Today that is `data-dir`, when the install has a `.tapflow-data/` with data in it, and `net-filter`, when the iOS network filter is installed but out of date or not filtering. A Mac that never installed the filter is left alone. `tapflow migrate data-dir` and `tapflow migrate net-filter` work as before.

  **Builds still install after their data directory moves** ([#836](https://github.com/jo-duchan/tapflow/issues/836)). The relay stored each build's full path, so after `tapflow migrate data-dir` every build uploaded before it failed to install with "cannot read this build file", and expired ones were removed from the list while their files stayed on disk. The relay now finds the file in its current `uploads/builds/` first and falls back to the stored path.

  `tapflow migrate data-dir` refuses while something is listening on the relay's port, since a running relay would put later uploads back into `.tapflow-data/`. It also rewrites `tapflow.config.json` before the move and puts it back if the move fails, where a config it could not write used to leave the data moved and the config pointing at the old directory.

- 9f3a141: **tapflow keeps one install per machine, in `~/.tapflow`.** `tapflow init` writes the configuration there instead of the directory you happened to be standing in, and every command finds the same install: `TAPFLOW_HOME` when it is set, the current directory when it already is an install, and `~/.tapflow` otherwise. `tapflow start` and `tapflow relay start` print the install directory, the configuration file and the data directory they resolved. Existing installs keep running where they are, and nothing moves.

  `init` also writes an `AGENTS.md` — a tapflow section between `<!-- tapflow:begin -->` markers, leaving anything you wrote outside them alone — and, when the directory is tapflow's own, a `CLAUDE.md` containing `@AGENTS.md`. A coding agent opened in the install directory then answers tapflow questions from the documentation, with the configuration and `tapflow doctor` in reach. Running `init` again keeps the configuration and refreshes only that section.

  Every CLI command used to leave a `jwt-secret` file in whatever directory it ran in, including `tapflow --version`: the relay created it when its configuration module loaded, and the CLI loads every command at startup. The relay creates it when it starts now.

### Patch Changes

- 0a29931: The App Center remembers which releases you opened or closed, per app and per browser. A release you never touched follows the default, where the newest is open, so a version uploaded since your last visit arrives open, and one you collapsed stays collapsed.

  With a status filter on, changing a build to a status the filter hides no longer drops focus to the top of the page. Focus moves to the next build in the release, or the previous one, or the neighbouring release's header, and that control says why the build disappeared. After a retry the first release is announced in its actual state from the start, instead of collapsed and then expanded. Release headers are headings, so a screen reader can move between releases. Scheduling and cancelling a deletion now say so. Every control on a build row names the build it acts on, and the deletion icons show what they do on keyboard focus as well as on hover.

- 75660db: Switching apps in the App Center no longer flashes "No builds yet" on the way. The page cleared the list the moment you clicked, before it had asked the server anything, so for one frame an app nobody had fetched yet looked like an app with nothing in it — and what you saw on a single click was the list, then that message, then "Loading…", then the new list.

  The list you were looking at now stays on screen until the new one arrives, with the release you had open still open.

  Two things the same page got wrong for the same reason are fixed with it. A slow answer for one app could paint its builds under a different app you had since selected. And a failed request was shown as "No builds yet", so a relay you could not reach and an app with no builds looked identical — including when the relay answered with an error rather than not answering at all, which the page had no way to tell apart. A failure now says so, and offers to try again.

- ad39cd2: The comment panel beside a QA session says so when its comments cannot be loaded, instead of showing "No comments yet". It reads through the same query cache as the rest of the dashboard.
- eb6fb90: The dashboard reads every server list through one query cache. When a list cannot be loaded, it now says so and offers a retry. Before, Tokens and Team settings took a failed response for their rows and broke, and recordings showed a failure as "No recordings yet". Saving the workspace name or logo updates the sidebar without a reload, and signing out clears what was cached, so the next person to sign in never sees the last one's data. An invite or password-reset link with no token shows as expired at once, not after a blank screen.
- 2a96beb: When the App Center's build list is replaced — by its failure state, by its empty state, or by the list again after a retry — focus moves to the first control in what replaced it, or to the search box when there is none, instead of falling to the top of the page. It moves only when replacing the view is what removed it. Wherever focus lands says what happened. A failed search fetched again in the background keeps its failure on screen with "Trying…" until the answer arrives, and "Trying…" keeps focus while it runs. Closing a build's "Schedule deletion" dialog returns focus to the button that opened it, and each release header says whether it is open.
- 6b71a1d: Form fields no longer report an error when you leave them without typing. Every form in the dashboard validated on blur regardless of whether anything had been entered, so leaving a field you had not touched showed `Enter a valid email` or `Password must be at least 8 characters` before you had done anything. Opening a dialog was enough on its own: it focuses its first control, so the next pointer move anywhere else triggered the message.

  In a dialog it also cost the first click on Close. The message enters the layout, everything below it moves, and a `click` needs its press and release on the same element, so the press that dismissed the dialog landed on nothing and it took a second one.

  Validation now runs when the form is submitted, and from then on corrects as you type. A message also names its field now, and the field points back at it, so it is read out with the field rather than left on screen for someone who cannot see it. Eight fields used to report the validation library's own developer text — "Too small: expected string to have >=8 characters" — and now say what they mean. This covers sign-in, first-run setup, the invitation and password-reset pages, and the team, token and settings forms, and the App Center's add-app dialog gained the announcement the others have.

- 96bd914: The dashboard is built with the React Compiler. It memoises the work React would otherwise repeat on every render, without the hand-written `useCallback` and `useMemo` that were doing part of that job.

  The bundle grows: the first load is 3,810 B larger compressed (170,543 → 174,353), because the memoisation the compiler adds is code. No behaviour change is intended — the compiler only memoises, and leaves alone any function it cannot prove — and the test run is compiled the same way the build is, so the suite exercises what ships.

- cc4676d: The setup page no longer shows its form to a browser that cannot create the first account. Only the relay host may create it, so opening a new relay from another machine showed the form and refused it only after the email and both passwords had been typed in. Such a browser now sees the instruction instead: run `tapflow admin init` on the relay host, or, for the Docker image, set `TAPFLOW_ADMIN_EMAIL` and `TAPFLOW_ADMIN_PASSWORD`. `GET /api/v1/auth/status` reports this as `canInitialize`, decided by the same check `POST /api/v1/auth/init` enforces, so the two cannot disagree; the refusal on submit stays as it was.
- adc07d2: <!-- changelog: internal — no behaviour changes; the one timing difference the refactor could have introduced was kept identical on purpose (see below) -->

  Neither device viewer compiled under the React Compiler. Both do now, and the two halves of the
  reason were in different places.

  `AndroidViewer` mirrored the current rotation into refs so `composeFrame` could read it without
  being rebuilt — a Rules of React violation rather than a style choice, because the closure was
  handed to `useClientRecording` and _then_ the turn it reads was written into a ref the hook already
  held. The recorder now takes a `setComposeFrame` setter and calls whichever composer was registered
  last, so the turn is an ordinary dependency again. Registration is a layout effect because
  `requestAnimationFrame` fires before paint, which is the timing the mirrors had. `IOSViewer` takes
  the same setter, but its composer reads what it needs live on every draw, so it registers once.

  The unmount cleanup that puts a rotated device back upright keeps its whole body in a ref, so its
  dependency list is honestly empty — the `react-hooks/exhaustive-deps` suppression it carried was
  enough on its own to keep the React Compiler out of the entire file.

- Updated dependencies [2700746]
  - @tapflowio/agent-core@0.24.0
  - @tapflowio/protocol@0.24.0

## 0.23.0

### Minor Changes

- e63e410: Foldable devices. Taps now land where you press them on a device whose display is rotated — the emulator's gRPC input takes coordinates in the display's natural orientation, and the viewer normalises against the rotated picture it is showing, so the two axes were swapped on every unfolded foldable. Folded, they also land in the right place: the emulator scales injected touch pixels by its own display size, which stays at the unfolded panel's, so scaling by the panel the guest reports sent every tap 1.92x too far across. A toolbar control folds and unfolds the device, keeping the orientation you were in, and the device frame follows the screen when it changes. A session starts unfolded and upright rather than inheriting whatever the last one left. Screenshots and recordings save the picture on screen rather than the frame behind it — the emulator captures a foldable's panel in its own fixed orientation, so an unfolded device was portrait on screen and landscape in the file, with the cursor overlay a quarter turn from the finger. `PosturableAgent` (`agent-core`) and the `input:posture` / `device:postures` messages carry it, with posture ids and labels owned by the platform so a device that folds differently needs no change outside its own agent.
- 7877bc9: Tunnel traffic no longer counts as local. The relay opens a loopback-only tunnel port (`TAPFLOW_TUNNEL_PORT`) where every connection must authenticate, and `tapflow start` and `tapflow relay start` open it on 4001 whenever a tunnel is configured (4002 when the relay itself runs on 4001). The CLI points the rathole client at it, warns when `tailscale serve` forwards to the relay port or `tailscaled` runs in userspace-networking mode, and stops rathole clients left behind by an exited tapflow process.

### Patch Changes

- 9d4cfd5: Use the configured public URL for member password-reset links instead of request headers, and warn when the configured URL uses HTTP.
- Updated dependencies [e63e410]
  - @tapflowio/protocol@0.23.0
  - @tapflowio/agent-core@0.23.0

## 0.22.0

### Patch Changes

- e2123d5: **The Mac Resources charts follow the clock now** ([#751](https://github.com/jo-duchan/tapflow/issues/751)). They were fetched once, when the page opened, and the window ended at that moment for as long as the page stayed open — so a monitoring screen showed nothing newer than when you arrived, and the space between the last time label and the right edge read as an axis skewed to one side. The window's edge now advances at a pace set by the range, labels enter on the right and fade out on the left, and the history is re-fetched on a cadence that matches what the relay stores: every minute on 1h and 6h, every five minutes on 24h, every fifteen on 7d. The charts stop advancing and refreshing while the tab is hidden, a history younger than its interval is not re-fetched on return, and a refresh that fails keeps the chart as it was instead of emptying it.

  **The line reaches the present.** The relay stores one averaged sample a minute, so the newest stored point is up to a minute old. The Mac's latest report, sent every five seconds and already part of the dashboard's Mac list, ends each line in a dot, and is never stored. Hovering the dot, or pressing End on the chart, reads its value at the current time. It is dropped within ten seconds of turning 30 seconds old, the same bound within which the QA Session cards call a Mac stale.

  **Time labels sit on local round times** ([#749](https://github.com/jo-duchan/tapflow/issues/749)). They were aligned in UTC, which is only round where the offset is a whole number of hours: in a 45-minute zone the 1h axis read 07:45, 07:55, and west of Greenwich a 7d label named the day before the midnight it marked. Across a daylight-saving change one gap is now 23 or 25 hours wide, because that day is 23 or 25 hours long.

- a12ff53: **The invite link the dashboard copies is the one the invitation email carries** ([#788](https://github.com/jo-duchan/tapflow/issues/788)). The email was built from the relay's configured address, while the dialog rebuilt the link from whatever address your browser was on — so on the Vite dev server it copied `localhost:3001`, and an admin working on the relay Mac copied `localhost:4000`. The dialog now shows the relay's link. The same applies to "Copy link to comment" and to the relay address in the agent command under Settings → Tokens: with `TAPFLOW_RELAY_URL` (or `relay.url`) set, all three use it. With nothing set they keep your browser's address, except that a browser on `localhost` gets the relay's LAN address, which the agent command already did. The invite response gains an `inviteUrl` field, `null` when the relay has no address a teammate can open.

  **A tunnel's address is the one it actually got** ([#794](https://github.com/jo-duchan/tapflow/issues/794)). Choosing Tailscale in `tapflow init` leaves `publicUrl` empty and `tapflow start` detects the MagicDNS name, but only the startup banner ever used it — invitations still pointed at `localhost:4000`. The tunnel now starts before the relay and hands over what it got, so invitations, dashboard links and the CORS allowlist use the detected address, and a tunnel that fails to start no longer leaves its configured address in any of them. A tunnel address is for teammates' browsers: the agent command uses `relay.url`, never the tunnel, so an agent on the relay's own network does not stream through it. If the port is already taken, the command now stops before touching the tunnel, rather than restarting a running instance's rathole server on its way to failing.

  **Running the relay image without `TAPFLOW_RELAY_URL` is said out loud.** The relay logs a warning at startup when it runs in a container with no address a teammate can open, since invitations then point at `localhost`. Inside a container it also stops offering its bridge address (such as `172.17.0.2`) as the LAN address for the agent command.

  **The invite dialog no longer claims a copy that did not happen.** It said "copied" even when the browser refused, and on a plain-HTTP page, which has no clipboard API, it reported the invitation itself as failed. The invite link, a new token and the agent command now sit in read-only fields that take focus, so on such a page they can be selected and copied by keyboard, and the invite dialog states its outcome to screen readers, which cannot hear a toast behind an open dialog. "Copy & close" on a new token no longer does nothing on a plain-HTTP page.

  - @tapflowio/protocol@0.22.0
  - @tapflowio/agent-core@0.22.0

## 0.21.0

### Minor Changes

- **The relay has a documented Docker deployment.** The image has been published since 0.20.0, and until now nothing said so — no page in the guide mentioned Docker, so the only way to find it was to guess the name. `docs/guide/self-hosting.md` now carries a Compose file, the settings a container needs that a local install does not, and the reasons behind both.

  **The image is the relay, not tapflow.** It serves the dashboard and brokers traffic. The agents that drive simulators and emulators are macOS-native and stay on your Macs, connecting outbound to the container with an `agent`-scope token. A container alone streams nothing.

  **Run it on the same Mac or a box on your own network — not on a cloud VM.** Every video and audio frame between an agent and a browser passes through the relay, so a relay outside your network sends app screen data out with it, and the detour costs more latency than a 30fps budget can absorb.

  Three things a container needs that a local install does not, each of which fails in a way that does not name its cause:

  - **The data volume is required, not a convenience.** The relay writes a per-install secret to `<dataDir>/jwt-secret` and reuses it. Without the volume that file lives in the container's writable layer, which `docker restart` keeps but anything that _recreates_ the container destroys — an image update, `docker compose down && up`, `docker rm`. A new secret logs out every user and drops every agent at once.
  - **`TAPFLOW_RELAY_URL` decides what invite links say.** The relay never reads its address from the `Host` header, because a forged one would turn an invite into a phishing link. Unset, invites point at `localhost:4000` — the recipient's own machine.
  - **`TAPFLOW_ADMIN_EMAIL` and `TAPFLOW_ADMIN_PASSWORD` create the first account.** The interactive setup a local install offers has no terminal to run in here.

  The build also gained the toolchain its own fallback assumed. `better-sqlite3` is fetched as a prebuilt binary and compiles from source when that fetch fails — except the builder had no compiler, so the fallback could never run and a failed _download_ surfaced as a missing Python. Forcing the source path through CI measured the fallback at 82s on amd64 and 90s on arm64, against about 35s when the prebuilt binary arrives.

  Every published image is booted in CI on both architectures before the manifest is pushed: the dashboard is fetched over HTTP, the auth endpoint is asked for its state, a WebSocket is opened, and the container is destroyed and recreated to prove the JWT secret survived on the volume.

  **Installing a build into it works, which it did not when this was written.** The relay used to hand the agent its own filesystem path, so a container — whose paths mean nothing on the Mac running the agent — could stream a device and never install anything onto it. That is fixed in this same release, and it is why the documentation ships now rather than earlier: a documented deployment that cannot do the thing tapflow is for would have been worse than no documentation at all.

### Patch Changes

- da074d3: Show a consistent unsupported-streaming status for Android and iOS viewers.
- 15e98fc: Pressing the upper half of an iPhone's Volume Up pressed the **Action** button instead. The tooltip said Action and the press followed it, so a tester reaching for volume changed a setting they never opened.

  A button's catchment was a fixed radius around its _centre_, and the first button in range won rather than the nearest — so on an iPhone 15 Pro, where the Action button sits close above a much taller Volume Up, Action's circle covered Volume Up's own pixels and claimed them because the agent happens to list it first. Catchment is now measured to each button's rectangle, the nearest one wins, and a press inside a button can no longer lose to a neighbour. Targets are as generous as before: the same margin now surrounds the button instead of radiating from its middle.

- bd7a9f5: Serve the dashboard compressed on plain-HTTP deployments. Browsers only offer Brotli on a secure origin, so over `http://<lan-box>:4000` the relay had only `.br` siblings on disk and sent every asset uncompressed — measured on the largest bundle, 300K where gzip is 92K. The build now emits `.gz` beside `.br` and `serveStatic` picks whichever the client will take, preferring Brotli when both are offered and honouring an explicit `q=0` over a permissive `*`. Assets under `/assets/` are marked `immutable`, `index.html` `no-cache`, and `Vary: Accept-Encoding` is always set so a shared cache cannot cross-serve (#260, #737).
- 7d8eb4e: **Installing a build works when the relay is not on the same machine as the agent.** It never did. The relay sent the agent its own filesystem path and the agent opened it, which is only true when the two share a disk — so on the topology the guide recommends, a relay on a LAN box with agents on Macs, every install failed. A relay in a container failed the same way for the same reason.

  **And it failed by blaming the build.** `unzip` said `cannot find or open`, the agent threw that away, and what reached the browser was "check this is a simulator .app.zip". The archive was fine every time. The tool's own words are in the message now, and a download that fails is reported as a download failing — the three causes a person acts on differently (a bad archive, a relay that cannot be reached, a transfer cut short) had been collapsed into the one sentence that was wrong for all of them.

  The relay now mints a single-use credential where it has already checked who owns the session, and serves that one build against it. Nothing is added to any token's permissions: an agent still cannot ask for a build it was not told to install, and `tapflow start` — whose agent runs with no token at all — keeps working, which a permissions-based approach would have broken. The agent builds the address from the relay URL it is already connected to rather than from anything the relay claims about itself, because that is the one address known to be reachable.

  A truncated transfer is caught against a size that travels with the instruction rather than against `Content-Length`, which a proxy is free to drop — a check that reads an absent header passes while looking at nothing, and hands on a half a file to be reported as a damaged one. Downloads have a stall timeout, so a half-open socket fails instead of hanging forever and leaving a temp copy of the build behind; the Android install path gained the cleanup it never had. An agent too old to fetch builds is unaffected and installs exactly as before, and the relay says so once in its log rather than guessing whether that agent is somewhere else — it cannot tell, and a check that is wrong in both directions is worse than none.

  `@tapflowio/agent-core` gains `downloadBuild`, and `@tapflowio/protocol`'s `app:install` gains `buildTicket`, `buildName` and `buildBytes` — additive, so an agent that predates them keeps working on the field it already reads. Both are named here rather than left to ride the version bump because a third-party platform built on `AgentRegistry.register()` reads those changelogs, and this is the API it would use to support installs from a relay it does not share a disk with.

- Updated dependencies [7d8eb4e]
  - @tapflowio/agent-core@0.21.0
  - @tapflowio/protocol@0.21.0

## 0.20.1

### Patch Changes

- 3d2aade: **A Docker install can now create its first account.** Until now it could not, at all. The bootstrap endpoint `POST /api/v1/auth/init` only answers a local client — that check is what stops a stranger claiming a public instance between first boot and the owner setting a password — and a container is always behind its bridge gateway, so the call answered 403 from the host's own browser and from the LAN alike. The error text points at `tapflow admin init`, but the image is relay-only by design and carries no CLI to run it. `docker compose up` therefore ended at a login screen nobody could get past.

  Set `TAPFLOW_ADMIN_EMAIL` and `TAPFLOW_ADMIN_PASSWORD` and the relay creates that first Admin while it boots, before it serves anything. They can go in `<dataDir>/.env` instead of the compose file, which keeps the password out of your shell history and inside the volume you already mount — but **`chmod 600` it yourself**. `tapflow init` creates that file 0600 and the relay-only image has no CLI, so a container operator writes it under their own umask; the relay now warns at boot when it is readable by others.

  It runs on every boot and does nothing when an owner already exists — your account is never replaced and nothing is logged, so a long-running relay does not collect a line per restart. **A password under 8 characters, or one variable without the other, stops the relay starting.** That only happens when an admin was asked for and there is none: an install that already has an owner returns before those checks, so a typo cannot strand a relay that is already serving. Serving anyway would leave the install ownerless and claimable by anything that can reach loopback, for as long as nobody notices — and an ownerless relay is not a working service to begin with. The password is never written to the log on any path, and is removed from the environment once used.

  Nothing changes for an install that does not set them, including the 403 above, which is still the right answer for a browser reaching a relay it has not been given.

  **Deploying tapflow with Docker is not documented yet** ([#352](https://github.com/jo-duchan/tapflow/issues/352)): there is no Compose file in the repository and no deployment guide, so this removes the wall that stood at the end of that path rather than opening the path. It is released as a fix for that reason.

- 07d4b40: Backfills: #739

  tapflow no longer pins any transitive dependency. The `pnpm.overrides` block is empty.

  Nothing you install changes: every package the block named already resolves at or above its security floor without it, verified by resolving the workspace both ways and comparing — `hono` 4.13.0, `axios` 1.18.1, `undici` 7.29.0, `body-parser` 2.3.0, `protobufjs` 7.6.5, `fast-uri` 3.1.7, `qs` 6.16.0, identical either way.

  It is recorded because three of the eight entries had gone stale in a way that mattered. Each pinned `fast-uri` up to a floor its advisories have since moved past — 2.4.4 where 2.4.5 is required, 3.1.5 where 3.1.6 is, 4.1.2 where 4.1.3 is — so had any of them ever taken effect it would have landed on a version that was still affected, while reading, to anyone scanning the block, as though the matter were handled. A fourth named a line with no patched version anywhere, which no override can rescue.

- da07ac4: The record button keeps keyboard focus while a recording is processed and saved, and announces both outcomes to assistive technology. It used `disabled` for those states, which took the focused button out of the tab order the moment "Stop recording" was activated, so focus fell to the page body and the name that changed to say what happened was read to nobody. It now stays focusable, refuses a click on its own while busy, and carries the outcome in a live region beside it.
- ea2b5cc: **The resource charts no longer reserve space for time that has not happened.** The window's right edge was rounded up to the next round tick so the tick labels would stay on clean times, which left up to a full step of axis that no sample can ever reach — an hour of empty chart on the 6h range, and 63 pixels of 504 on 7d. Empty because it is in the future, which reads as a gap in the data rather than as the edge of the window. The window now ends at the moment of the reading and the ticks are counted down from the last round step at or before it, so the labels stay round and the newest sample sits at the right edge. The same strip existed at both ends for a second reason — the plot was padded 16px inside the gridlines that frame it — so the window's own edges are now the grid's edges and the chart is filled from one side to the other.

  **The device viewer no longer draws a box around itself while you type.** Clicking the phone put the browser's focus on the whole viewer, and a focus has to be shown — so a ring appeared around everything at once, the phone and the buttons and the status card, and it came back mid-sentence on the keystrokes you were sending to the device. The viewer no longer takes focus at all. Nothing depended on it: tapflow starts forwarding your keys when you click the screen, not when the browser focuses something, so typing at the phone works exactly as before. The one place that focus was doing real work is kept — restart a device and you are put back on the restart button when it comes back, instead of at the top of the page.

- 916b02a: Add a stable page-level heading to Mac Resources, expose the selected Mac and its online/offline state to assistive technology via aria-current, and announce file-attachment validation errors tied to the attach button.
  - @tapflowio/protocol@0.20.1
  - @tapflowio/agent-core@0.20.1

## 0.20.0

### Minor Changes

- 3f18f70: Gate the dashboard's Full reset toggle on an agent capability instead of the platform string.

  `AgentCapability` gains `full-reset`, `IOSAgent` advertises it, and `SessionInfo` now carries the
  agent's capabilities so the viewer can gate while picking a device — before any session exists to
  join. The old `os !== 'android'` check said "Android cannot" when it meant "this agent did not say
  it can", and got both directions wrong: an iOS agent too old to implement Full reset was still
  offered the toggle, and an Android agent that implements it later would still have it hidden.

- faeaae9: A viewer that reconnects now learns whether its device is on the network (#614).

  `network:state` is produced by the agent, and the relay replays only three things to a re-joining
  browser — so the network toggle had no value to render and would have shown a guessed position. The
  relay now asks the agent to re-read the device, from the same block that already asks for a
  keyframe, and the Android agent answers with an uncorrelated report.

  The relay asks only agents that announce `network-control`, so an agent without the feature — one
  predating this release, say — is never asked and a viewer never has to guess from a silence.

  Caching it in the relay would have been cheaper and wrong: the relay caches only what it can
  invalidate, and airplane mode changes when someone types `adb` in a terminal.

- 4901c8c: Add the wire contract for taking a device under test off the network (#607): `network:set` from the
  viewer, `network:state` and `network:error` back, and a `NetworkControlCapability` beside
  `DeviceAgent` for the agents that implement it.

  This is the contract, and it landed before the platforms so each one had something to build
  against; both of them and the control ship in this same release.

  **`network-control` in `capabilities` claims less than the other two entries do.** `clipboard` and
  `full-reset` are settled facts about an agent's own code, but that string is sent once at
  `agent:register`, before any device is booted or app launched — so it can only mean "this agent has
  the code". Whether the mechanism actually takes is per device and per app, and `network:state`
  carries that as `available` plus a closed `reason`. A single boolean was tried and rejected: with the
  capability gating the control, `available: false` would have been unreachable, and the state it
  describes — conditioned but no longer steerable — would have hidden the only control that could undo
  it.

  `offline` reports the **device**, not the request: one taken offline and then left unsteerable is
  still offline, and saying otherwise would render "online" over a device whose app reaches nothing.
  The payload shape and its reason set live in `@tapflowio/protocol` and are re-exported by
  `agent-core`, the rule that package already follows for `ClipboardErrorPayload`.

- 2bac3f4: Add a restart control to the device toolbar

  The network control can report `not-armed`, whose remedy the protocol states as "reboot the device" —
  and there was no way to reboot a device from the session screen. `input:error`'s `not-booted` has the
  same shape. The only route was back to the device list, which loses the session.

  The control sits last in the Device group and asks before it fires, since the state a tester has built
  up on the device does not come back. It restarts only: wiping stays on the selector screen.

  `device:boot` on a running device does nothing on its own — the non-erase path issues a boot the
  simulator ignores — so a restart is a `device:shutdown` followed by a `device:boot`. Both already
  existed on the wire, so no agent, relay or protocol change was needed.

### Patch Changes

- 6d20bba: Advertise the first teammate-ready DNS host from an imported TLS certificate in relay startup output, preferring a concrete SAN over `localhost`. DNS SANs take precedence over the legacy subject CN; certificates with unusable DNS SANs keep the safe `localhost` fallback and now explain it with a warning.
- 9d0df7d: Make network-state request coalescing deterministic in tests and prevent a delayed trailing timer from sending a duplicate request after a new window begins.

  <!-- changelog: internal — relay scheduling and test determinism, nothing a user can observe -->

- 04c7090: **Take the device off the network from the browser.** The control that #607 asked for is on screen.

  A button in the simulator toolbar puts an Android emulator into airplane mode and takes it back out, so the offline banner, the failed retry and the stale cached screen can be seen without touching a terminal. It appears only for an agent that says it can do this, which is why the iOS half needed no dashboard change when it landed alongside this one.

  It has four positions rather than two, and that is deliberate. A device nobody has heard from yet and one whose report never came are drawn differently from each other and from both on and off — because saying "on the network" about a device nobody has heard from is exactly the mistake this feature exists to catch. Neither is disabled: clicking is what asks the device, so a session with no report has a way out rather than a dead end.

  A device whose network tapflow can no longer change still shows where it is. That is a separate thing from not knowing, and the button says which of the two it is.

  The toggle never moves on the click. It moves when the device answers, so what is on screen is where the device is rather than where someone asked it to go.

- 5e2fcc5: Split the network-control reason set so each member carries a remedy, and confirm that a simulator's rule is actually being enforced before reporting it offline.

  `unsupported-device` now means only what it says — the write was accepted, the read-back succeeded, and the device had not moved. Every other Android failure is `state-unconfirmed`, which a retry may fix. Two iOS members are new: `filter-unavailable` for a Mac that cannot take devices offline, and `enforcement-lost` for enforcement that stopped underneath a device that was already offline.

  On iOS the rule is now confirmed over XPC before the other layers are applied, and a request that cannot be confirmed is refused rather than half-applied — applying the app-facing layers alone tells an app it is offline while its requests keep succeeding. Enforcement is watched while any device is offline, so an outage that used to pass silently is reported instead of leaving a tester signing off on requests that succeeded.

  The dashboard says what to do per reason, stops offering a retry where a retry cannot help, and interrupts rather than re-colouring when a finished check has been invalidated.

- 7152b21: Stop the network control describing a device that is rebooting, and settle what the toolbar's groups mean.

  A device that restarts keeps its session, and the control only forgot what it knew when the _session_ changed — so for the 30–60 seconds an emulator takes to come back, the toolbar showed the position from before it. Worse than merely stale: the agent's boot path turns airplane mode off and reports the device online, so an amber "offline" sat over a device being reset to the opposite, and nothing ever replaced it. The control now forgets the moment the device stops being ready, and starts waiting for the report again.

  The toolbar's buttons were grouped by a criterion nobody had written down. They are now grouped by what the tester is doing to the device — **move around the app → leave the device in a condition → take the state out of the session → change what the device is sitting in** — and the rule, with its worked examples, is in `packages/dashboard/AGENTS.md`. A new button has an answer before anyone argues: GPS goes in Environment, Shake in Device.

  Where a button sits is now decided in one place. Android's toolbar was ordered by the _agent_, because its buttons arrive as a capability list and the dashboard rendered that array in array order — so reordering that list moved buttons in the browser, and nothing on either side would have said so. The dashboard names its own order now and looks each button up. A button the agent adds and no group claims does not render — deliberately, so that where it belongs is a decision rather than an accident, and a check fails if one is left unclaimed.

  Also recorded rather than changed: `NetworkControlCapability` is an in-process API. `mcp-server` and `flow-runner` hold a relay client and address devices by session over the wire, so the network tool they would expose goes through `network:set`, which already names its session and answers with a correlated report. Two issues had been filed asking this interface to take a session id and report on the wire, on the premise that MCP calls it.

- 1823117: The dashboard's icon set moved to lucide-react 1.x, from 0.577.

  Housekeeping ahead of the network control for #607, which will use `radio-off` — an icon added in lucide v1.6.0. Not a necessity: 0.577 already carries `wifi-off`, `plane`, `signal` and `antenna`, and the slash could have been drawn by hand. It is a preference for the glyph that says "no radio at all", which is what airplane mode does, and doing the bump now keeps it out of the diff that adds the control.

  Nothing you interact with changes. Forty-nine of the fifty icons in use are drawn from identical data; the fiftieth is the book on the sidebar's Docs link, and it has been redrawn — same book, rounder corners. All the JS the dashboard ships grows by 30 bytes.

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

## 0.19.0

### Minor Changes

- e55371c: **Requires Node.js ≥ 22.** Node 20 reached end of life on 2026-04-30 and no longer receives security patches.

  Three declarations disagreed about what was supported, and none of them matched what was actually run. The manifests said `>=20.12.0`, the documentation said "≥ 20" — meaning 20.0.0 — and CI ran 20 while Docker ran 22 and the release job ran 24. There was also a band that was declared but unusable: every `undici` 7.x requires Node `>=20.18.1`, so 20.12 through 20.17 could not complete a development install regardless of what the manifests promised.

  The floor is now 22 everywhere, and 22 is a version that will be tested rather than merely claimed — CI runs the suite on both 22 and 24. That is the part that had been missing: `>=20.12.0` was declared for a year and never once exercised on 20.12, which is how it drifted below what the dependency tree already required.

  `tapflow`, `@tapflowio/flow-runner` and `@tapflowio/mcp-server` declared no `engines` at all and now do. `tapflow` is the package installed with `npm i -g`, so until now the CLI announced no Node requirement to the people most likely to need it.

  `tapflow doctor` moves with it and reports `Node ≥ 22 required` below the floor. Without that change it would have printed a green check on Node 20 while the package manifest called the same version unsupported.

  Node 22 is supported until 2027-04-30; Node 24 is the active LTS. Containers and the published image now run 24.

- e8b29b8: Check every message the relay receives against the contract, and make the inbound frame a discriminated union

  The outbound direction has been compile-checked since #419 — `sendTo` refuses a message outside its
  union. Nothing checked the inbound direction: the relay's `RelayMessage` was a flat interface where
  `type` was the only required member, so every field it read was optional by construction and every
  field it needed came with a `!`. That is how the two type systems could disagree about the same wire
  field — `format?` in the relay against a required `format` in the protocol — with nothing to report it.

  `@tapflowio/protocol/validate` is a second entry point, imported only by the relay, that parses an
  inbound frame into a discriminated union at the door. It is a parse rather than a cast on purpose:
  narrowing the union with `as` would have turned the relay's one visible `msg.payload as ChromePayload`
  into an invisible `msg.payload`, with the compiler vouching for JSON that arrived over a socket.

  What a user can observe:

  - **A malformed command is refused before it reaches a device, and the caller is told which field was
    wrong.** A `device:boot` with no payload, an `open-url` with no URL, an `app:install` whose `buildId`
    is an object — these were forwarded to an agent before, and the agent's own guard answered if it had
    one. The relay answers now, in the shape that request's waiter reads, so the diagnosis arrives sooner
    and does not depend on which agent is on the other end. A request that has no reply at all is dropped
    and logged with the field that failed. No client shipped here can produce any of these; a third-party
    one can.
  - **A command with no usable session id or request id is refused outright**, including the empty
    string, which type-checks and which an LLM driving the MCP tools could produce. Answering one is not
    possible — the reply's own required fields would be missing, and every client discards such a frame —
    so it is dropped with a log rather than turned into a caller waiting out its deadline.
  - **A key appended to a browser message no longer reaches a device.** Browser-origin frames are
    forwarded as the parse product, so anything the contract does not declare is gone before an agent
    sees it. Agent-origin frames are forwarded unchanged, so a field a newer agent adds still survives a
    relay that does not know it.
  - **Nothing else changes.** Every well-formed frame routes exactly as before.

  `@tapflowio/protocol` gains a `./validate` subpath and, with it, a runtime dependency on `zod` — its
  first dependency of any kind. The main entry is unchanged: still types only, still fully erased by
  `import type`, and it does not reach `zod`. A consumer that imports only `@tapflowio/protocol` gains
  nothing in its bundle and one package in its install.

  Agent payloads are deliberately not validated, and that is a decision with a reason rather than a gap:
  `AgentRegister.platform` is `string` — open, so a third-party platform can register through
  `AgentRegistry.register()` — while `ChromePayload` is a closed two-member union. A platform this
  project promises to support has no valid `session:chrome` variant to send, and refusing one would cost
  it bezel and buttons for the life of the session. The six messages the relay consumes are validated,
  each with a default for every field the relay previously read through a `??`, so an agent older than a
  field keeps working exactly as it did.

- 7ad6343: Answer a shutdown the relay cannot deliver, release every session a closing socket held, and let a viewer re-join a session it already holds

  Three defects that share a subject — who holds a session — and none of which needed the question that
  sounds like their root. The root question — **who should be allowed to drive a session** — is answered in this same release; see
  the note titled "A session belongs to whoever opened it". It could not be answered in this slice because the dashboard's four
  senders per tab are four connections, and a socket-shaped owner refuses the tab's own teardown.

  What a user can observe:

  - **A device shut down from an MCP client fails in a second instead of half a minute.** `device:shutdown`
    was the one browser command the relay never answered when it could not deliver it — a stale session id
    or an agent that went away produced no reply at all, and `shutdown_device` reported `Request timed out`
    with no cause after 30 seconds. It now says which of the two happened.
  - **A device list stops getting stuck on "Shutting down…".** The same silence left that row inert with
    both its buttons hidden for the life of the page.
  - **A tester whose browser reconnects lands back in their session instead of being thrown out of it.**
    Re-sending `session:start` for a session the socket already held was answered `session-not-found` — for
    a live session, held by the caller, that the device list reported as theirs two lines later. The viewer
    reads that reason as the agent having disconnected and takes the tester off a session that is fine.
    A re-join is idempotent now: same reply as a fresh join, and the session's cached state is replayed.
  - **Devices no longer stay booted with nobody watching them.** The relay tracked one session per browser
    socket while the relation is one-to-many — `mcp-server` runs a single socket for the whole process and
    joins a session per device. Closing it released only the last one joined; the rest stayed marked in-use
    for the life of the relay, with no idle timer, so their simulators kept running. All of them are
    released now, each with its own idle timeout.

  `@tapflowio/protocol` gains `device:shutdown-error` on the browser-inbound surface. It is relay-produced
  only: neither agent has a failure path that emits a message, so a shutdown that reaches a device either
  completes or times out. Its `requestId` is optional because the request's is — the relay originates
  `device:shutdown` from its own idle timer, and a reply cannot demand a field the request need not carry.

  `SessionManager.join()` returns its two expected failures instead of throwing them. It used to throw both
  as `ValidationError`, which left the caller's `catch` unable to tell an expected refusal from a bug — so
  it guessed a reason, and guessed wrong for the most common one. Nothing in tapflow depended on the throw;
  this affects code outside it that called `SessionManager` directly. `getByBrowserSocket` returns an array
  for the same reason the index changed.

- 0c63c1b: A session belongs to whoever opened it, not to one of their connections

  Two defects met on the same two lines, and both came from the relay answering "who holds this session?"
  with a socket.

  What a user can observe:

  - **Nobody else can power off a device you are using.** Any signed-in client that knew a session id could
    shut down a colleague's simulator mid-test. The check that stops it could not be added before, because
    the browser tab that holds a session and the one that sends the shutdown when you navigate away are
    different connections — so refusing "not the holder" would have refused the tab's own cleanup and left
    devices running.
  - **A Wi-Fi blip no longer costs you your session.** The relay treated a connection as present until TCP
    or a heartbeat noticed otherwise, up to a minute after a laptop went to sleep. Returning within that
    window meant being told the device was in use — by yourself. The tab is now recognised as the same tab, and the
    session is simply resumed — unless you reload while the connection is down, which gives the page a new
    identity even though it is the same tab, and waits out the window.
  - **A device whose tester's connection died frees up in at most 45 seconds** rather than up to a minute,
    and no longer appears free while it is still in use. (A tester who leaves a tab open is a different
    case — that is the idle timer's, not this.) Both questions — "can I take this?" and the "In use" badge — now read the same signal, and
    that signal is when the holder last answered rather than a flag that read every healthy connection as
    gone for the length of a round trip.

  The relay reads an optional `client` parameter on the WebSocket handshake and pairs it with the signed-in
  user, so a leaked identifier is useless to anyone else's account. A connection that sends none is given one
  of its own, which is per-connection ownership — what it had before. The shutdown check is then relaxed for
  that session, because every one of such a client's connections is a stranger to the others and gating them
  would refuse the client's own cleanup — **but only for the same signed-in user**, so an older build never
  becomes a way to power off someone else's device. Whether an identity was claimed or granted is recorded by
  the relay, not read back out of the identifier, which the caller supplies.

  The dashboard sends one value per open page. Deliberately not stored: browsers copy that storage into a tab
  opened from another one, and two tabs sharing an identity would take each other's devices silently.

- e84a2ea: fix: enforce union membership in both directions, not just narrowing

  The wire-contract program made every message's **fields** checked and left its **set membership**
  checked in one direction only. Narrowing was held by the compiler and held well — `sendTo` refuses a
  message outside its union. Widening was free: measured on `main`, adding `DeviceBooting` to
  `BrowserToRelay` left `pnpm typecheck` at zero errors and all 294 static tests green.

  ## The copy with the security consequence

  `AGENT_MSG_TYPES` in the relay is a hand-maintained second list of what an agent produces, and the
  door check closes a `browser`-role socket with 1008 for any member. The forwards it guards mostly
  resolve a session from the message and send to _that session's_ browser with no check that the sender
  is that session's agent — `clipboard:*` is the deliberate exception. So an agent→browser message added
  to the protocol and forgotten in that list makes a viewer drivable by anyone who knows a session id,
  with the type union claiming otherwise.

  Measured before this change: dropping `keyboard:toggled` from the set left both suites green.
  `clipboard:data` was held only because somebody had written that one test by hand.

  Types erase, so no runtime array can be derived from a union. What is available is the compiler
  checking two lists against each other, and that is what this adds — as type-level assertions, so a
  violated invariant is a compile error at the declaration rather than a test somebody has to run.

  Three invariants now hold:

  - the relay's `MessageType` covers every protocol literal and invents none. It was missing
    `stream:request-idr` — the exact drift `protocol/AGENTS.md` cites as this package's reason to exist,
    still alive in the copy underneath it;
  - `AGENT_MSG_TYPES` equals what the agent directions declare, both ways;
  - **nothing a browser may send is something an agent produces.** This is the one that catches widening
    without restating 63 literals, and it is the invariant the door enforces at runtime. Not blanket
    disjointness: `device:shutdown` is deliberately a member of both `RelayToAgent` and `BrowserToRelay`.

  ## And the half a type cannot state about itself

  A message declared in the protocol but placed in **no** direction reaches none of the above — it is
  absent from the union those assertions read, so nothing is ever obliged to know it. Types cannot
  enumerate their own declarations, so that one is checked as source text alongside the two facts
  `protocolMessageNames.test.mjs` already checks that way. All 65 declared messages reach a direction
  today.

  `AnyWireMessage` is new and public: the seven directions unioned, so a consumer can assert its own
  list is complete rather than merely correct so far.

### Patch Changes

- d63811f: fix: a screenshot's format is what the bytes are, not what was asked for

  An Android screenshot requested as JPEG came back as **PNG bytes labelled `image/jpeg`** (#508).
  `AdbWrapper.screenshot()` runs `screencap -p` and takes no format argument, so Android always produces
  PNG — but the reply echoed the _requested_ format, and the relay turns that field into the HTTP
  `Content-Type`.

  ## The part that is not cosmetic

  `mcp-server`'s `getImageDimensions` picks a parser **by format**. Handed PNG bytes and told they are
  JPEG, it scans for a JPEG SOF0 marker; in a few hundred KB of IDAT a stray `ff c0` is close to certain,
  so it returned a **wrong** width and height. Those numbers go into the response text the LLM reads and
  hands back as `tap`'s `screenshotWidth` / `screenshotHeight`, which are its divisors — so the tap lands
  somewhere else on the screen. The usual reassurance that decoders sniff magic bytes and render anyway
  does not apply here: this format is not deciding how to render, it is deciding how to measure.

  ## What changed, and what each edit is worth on its own

  - **`protocol`** now says what the request's `format` means: a **preference**, not a requirement. That
    asymmetry is the platform contract rather than slack — `DeviceAgent.screenshot()` takes no format
    argument, so no agent was ever asked to honour it. iOS happens to (`simctl io … --type`), Android
    cannot, and a third-party platform registered through `AgentRegistry` is free to produce whatever it
    can. Only `ScreenshotDone.format` describes an outcome, and even that is a claim.
  - **`android-agent`** answers `format: 'png'` unconditionally, because that is what it produced. On its
    own this fixes **no in-repo consumer** — it makes the HTTP `Content-Type` honest for anything reading
    the REST endpoint directly, and makes protocol's declaration true.
  - **`mcp-server`** reads the magic bytes instead of the request. This is the edit users feel, and it
    works against an agent that has **not** been upgraded — agents are separate processes on separate
    release lines and this protocol has no version handshake, so a self-hosted install running an older
    Mac agent is the ordinary case, not an edge one. When the format differs from what was asked for, the
    response says so; when the bytes match neither signature it falls back to the request and says that
    too, rather than presenting a guess as a reading.
  - **`relay`** logs a mismatch between the bytes and the agent's claim, and **does not overwrite it**.
    Correcting the field there would make the relay the authority on something only the agent can know,
    which is a contract change where this is a drift detector. It costs four bytes of a buffer the relay
    had already decoded. Without it the consumer-side sniff would hide a lying agent forever — #508 was
    found by a person noticing, and nothing reported it.

  The MCP `screenshot` tool keeps its `format` parameter: dropping it is a change to a published tool
  schema, and it is a working feature on iOS. Its description and the docs now name the platform
  difference.

  Not addressed: `relay/src/types.ts` keeps its own `format?: 'png' | 'jpeg'` while protocol declares it
  required — the drift that package exists to remove, and a separate slice.

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

- 42987e1: refactor(protocol): complete the browser-inbound surface by direction, and delete the dashboard's hand-copy of it

  A browser receives 28 message types. `@tapflowio/protocol` declared 17 of them — one of which does
  not go to a browser at all — and the dashboard declared its own copy of 24 in `lib/types.ts`. The
  twelve an agent sends were in neither, because the relay forwards them with `JSON.stringify(msg)` and
  so nothing on its typed send path ever mentions them.

  The two copies had drifted in four places, and nothing reported any of it: three error types were
  `sessionId?` in the dashboard against protocol's required, `session:joined.capabilities` was optional
  against required, four members were declared with no `sessionId` the wire always carries, and four
  more were missing outright.

  - `AgentToBrowser` — the twelve forward-only messages, shapes derived from both agents' send literals.
  - `RelayOrAgentToBrowser` — the ten with both producers, declared **once** and referenced by both
    directions rather than written into each. `device:ready` carries `sessionId?` here because the two
    producers genuinely differ: both agents stamp it, and the relay's replay to a re-joining viewer does
    not. (`session:chrome` and `session:deviceInfo` were in the same position and are required now — the
    relay stamps them; see the entry for that change.)
  - `BrowserInbound` — what a consumer should use. The dashboard's `RelayMessage` is gone; view code
    imports this.
  - `RelayToStream` — `stream:registered` goes to an agent's stream socket, not a browser.

  `scripts/__tests__/browserInboundRouting.test.mjs` now compares the relay's forward case labels
  against `AgentToBrowser` in both directions, because no compiler can: a forwarded message is never
  constructed by the relay, so `sendTo(socket, msg: RelayOutbound)` does not see it.

  Two silent drops surfaced once the dashboard read the real union. The clipboard bridge had declared
  its own `{ type: string; payload?: unknown }`, wide enough that a `clipboard:write-done` answering a
  read parsed as "no text" and cancelled the claim with nothing said; the same for `clipboard:data`
  answering a write. Both now report. Five test fixtures were also sending a `device:booting` with no
  `sessionId` — a message the wire does not produce, and one that bypasses the viewer's session
  scoping; they compiled because the injection ended in `as never`.

- edfc65d: fix(dashboard): tell the tester when an input never reached the device

  The relay forwarded `input:done` / `input:error` to the browser and the dashboard dropped both. They
  were declared in `lib/types.ts` and had no handler anywhere, so the only consumer of a failed input
  was `mcp-server` — the experimental path. Manual testing, which is tapflow's primary use, heard
  nothing.

  That mattered more after #484/#488/#490. Before those, an agent reported a dropped input as success;
  now it reports the truth with a machine-readable `reason`, and the truth was being discarded before it
  reached a human. Concretely, a session whose input channel has permanently failed (a helper binary
  that is missing or built for the wrong architecture) showed a stream that kept updating, taps that did
  nothing, and no indication anywhere.

  A failed input now raises a toast whose copy is chosen by `reason`, so the tester is told what to do
  rather than just that something failed — reconnect, start the device, report a bug, or that the input
  has no equivalent on this device. `not-booted` gets its own wording because the protocol prescribes a
  different action for it than for `channel-unavailable`. The wire `message` rides along as the
  description, which is where its detail (`unknown key code: KeyFoo`) is useful; it is not used as the
  headline, because it is free prose each agent owns and cannot be localised.

  Two reasons are deliberately shown nowhere: `channel-starting` (the input channel is up ~200ms later)
  and `no-gesture` (the gesture is gone; a fresh one works). Reporting an error for something already
  fixed by the time it is read is noise.

  There is **no session-level "input unavailable" state**, which was the first design and was discarded
  after review. Per-input acks cannot support one: no message carries evidence that input is working
  again — a replaced helper announces nothing, and an agent restart is not the same as a healthy channel —
  the acks are not ordered (a dispatch is awaited before its ack while a refusal is not), and an ack does
  not say which channel answered, so on Android, where buttons always take the adb path, a working Home
  button would have erased a warning about a dead touch channel. The toast's own lifetime carries it instead:
  repeats reuse one id, so it stays up while inputs keep failing and fades when they stop.

  Nothing is shown while the agent is away, either: the relay answers every terminal input itself in that
  state, and the viewer already says the session is being held open and waiting.

  Dashboard-only change, released as part of `@tapflowio/relay` because that is the package the built
  dashboard ships inside.

- 252262b: Split stable dashboard vendor dependencies into smaller chunks to reduce maximum bundle size and improve cache reuse across releases.
- 4d4fe13: feat(protocol): `error` is the session-start refusal, and it names the session it refuses

  Closes #512's first finding, and ends a contradiction that sat in two files at once. `GenericError`'s doc
  claimed _"the escape hatch for a failure the relay cannot correlate to a session"_, while
  `SessionStartFailure`'s claimed the reason has **a single producer inside `handleSessionStart`**. Both cannot
  be true.

  The correlation work settled it by removing the general role rather than the specific one. A request naming no
  session is dropped at the relay's door, because answering it would ship a frame whose own required `sessionId`
  `JSON.stringify` erases — and `error` has no `requestId` either, so a caller could not attribute the answer and
  would wait out the same deadline silence costs. With nothing left needing an unaddressed failure, all five
  producers answer one specific join.

  ## What the address buys

  The join waiters in `mcp-server` and `flow-runner` matched `sessionId === undefined || sessionId === mine`, and
  with no such key **the left half was always true** — so any refusal resolved any pending join. Two concurrent
  `connect_device` calls and the first refusal woke the wrong one, reported as a failure that session never had,
  while the one actually refused waited out its deadline, because `dispatch` resolves only the first matching
  waiter. That is the defect; the escape was it.

  ## `extends SessionError`, not a bolted-on field

  The naming check forced the decision the plan had left open. `protocolMessageNames.test.mjs` asserts that a
  session-scoped failure declares `extends SessionError`, and its predicate is exactly this change: `'error'`
  already matched `/error$/`, and it survived only because it had no `sessionId`. Adding the field flips that.

  Joining the family is the honest answer rather than carving an exception: the shape is the base verbatim, and
  the base's own definition — a failure a _session_ is waiting on — is now exactly what `error` is. The check's
  note saying `error` _"cannot be a `SessionError`… that is the member's nature, not an exception"_ described a
  nature this change replaced, so the note is corrected in place rather than worked around.

  ## The name stays `GenericError`

  A first draft leaned toward `SessionStartError`, arguing that a narrowed role was the only chance to remove the
  naming exception. **Review refuted it.** The derivation rule splits the literal and PascalCases it, so `'error'`
  yields `Error` — which shadows the global, and that is the exception's whole reason. `SessionStartError` is not
  the derived name either, so it needs an exception entry just the same; `NAME_EXCEPTIONS.size` stays 6. The
  exception is removable only by renaming the **wire literal**, which this slice does not scope. Renaming would
  have touched every consumer plus `typeAssertions` and bought nothing.

  ## Skew is logged, not hedged

  A client newer than its relay sees unaddressed refusals, which now match nothing — so the join runs to its
  deadline instead of reporting why it was refused. There is no version handshake anywhere in this protocol, so
  the alternative was a fallback, and a fallback here is the ambiguity this work removes. Both clients log once
  per session instead: the same shape and the same reasoning as the input-ack skew record, that logging is not
  matching. Approved as part of the breaking change, in that direction specifically.

  ## What the design review changed

  Eight things, and two of them were premises the plan had asserted rather than measured.

  - **The scope in the program plan was wrong in three ways.** Its table called this slice _"`session:start`/`error`
    echo (#512 finding 1 · #444's seven reply sites)"_. The seven reply sites had **already gone** — the input
    slice's door predicate removed them, so what is left is #444's own body. "Echo" was rejected by the same
    file's decision log, which had already refused a correlator on `error` on the grounds that attaching one
    makes it a different message. And the general role was already dead in code while two comments still claimed
    it.
  - **Three consumers, not one.** The plan said the dashboard's filtering would newly affect
    `DeviceViewer`, `SessionList` and `useAgentSession`. `SessionList` has no session gate at all, and **`error`
    never arrives at `useAgentSession`** — every producer is `sendTo(ws, …)` to the socket that sent
    `session:start`, and that hook's socket only sends `agents:list` and `device:shutdown`. So the filtering
    affects one consumer, and it is a no-op there: no `error` the wire can deliver to that socket will be dropped.
    A planned test for "the dashboard receives another session's error" was deleted — the wire cannot produce it.
  - **`useAgentSession`'s `error` and `session:joined` branches are unreachable**, and `inboundDisposition` named
    it as handling both. Correcting that by _removing_ the name made the table stale in the other direction, and
    the reverse-direction check said so: `at` answers "which files compare `.type` against this", which is still
    true. The name stays and the reachability went into the comment — with what the first attempt got wrong.
  - **Stale prose was in six places, not two — and a second review found five more that the first pass had not
    reached.** The sharpest of the first six is `SessionList`, where three comments justify a serialisation guard
    on `error` carrying no sessionId, and #527 has that list joining before it shuts down as a client-side
    stand-in for a missing server check, so someone deleting the guard on the strength of the old comment would
    unlock the wrong row's badge. The sharpest of the second five is worse, because this change's own headline
    claimed to have fixed it: the retired _"send `error` instead"_ argument was still on `SessionError`, the
    interface `GenericError` now `extends`, 140 lines above the rewritten block — so the contradiction moved
    inside one file instead of ending, and a #444 implementer reading the base was told to do the thing this
    slice removed, with seven line numbers that had drifted onto a `break` and three comments. Two files were
    where the first pass looked; the six places it then found were the ones that mention `error` by name. What it
    did not do was re-read the **paragraph above each edit**, and four of the five survivors were exactly that.
  - **`typeAssertions` needed two edits and a relocation.** One line was in the must-compile section and failed
    under `pnpm --filter @tapflowio/protocol typecheck`, which `tsc -b` does not cover. And the `@ts-expect-error`
    being flipped was the file's **only whole-message excess-property assertion** — flipping it would have retired
    an assertion class as a side effect, so the guard moved to another message instead.
  - **Fixtures the compiler cannot see.** Two `mcp-server` fixtures send `error` through a fake relay typed
    `Record<string, unknown>`; they carried neither `sessionId` nor the already-required `reason` and passed only
    because of the escape. `flow-runner` had **no `error` fixture at all**, so removing its escape was untested in
    both directions — three tests now cover it.

  - **The remaining `msg.sessionId!` count was wrong, and its composition was the misleading half.** A first
    draft of this note said "the eleven left are all agent→browser forwards". There were **twelve**, and four
    were not forwards: `stream:register`, `device:shutdown`, `forwardUnacked` and `handleAckedInput` — whose
    assertion was **dead**, since L5c's door predicate had already narrowed that parameter to
    `sessionId: string`. Removing it leaves eleven, of which eight are forwards and three are request-side
    paths that deliberately carry no address gate. "All forwards" invited the conclusion that the request side
    was settled, while `device:shutdown` sits on it with no ownership gate either (#527). The count and the
    composition are now recorded next to the sites, with an instruction to re-derive rather than trust the
    sentence.

  ## Mutations

  Ten in the author's round, none surviving — and then **four more from review, all four alive**, which is the
  number worth reporting.

  - **`session:joined`'s address held nothing.** Pointing it at `session.deviceId` passed relay 620, ios 382,
    android 263 and the static suite, while **no client could join at all**: both clients match
    `sessionId === mine` strictly and the dashboard's gate drops the rest. This slice added four assertions that
    each _refusal_ names the right session and zero that the _reply_ does — and the reply is the half that was
    already strict, so it had the largest blast radius and the least cover. The agent suites miss it because they
    wait on the type alone.
  - **The mcp skew log's stated reason was free**, and its keying contradicted its own docstring. Adding
    `&& this.waiters.length > 0` passed 81, so nothing held the "recorded whether or not anything is waiting"
    claim — which exists for the refusal that arrives _after_ its join gave up, the one caller who has been told
    "timed out" with no cause. Worse, the record keyed on the literal `'a pending join'`, so it was once per
    **process** rather than once per session: against an old relay the first refused session logged and every
    later one was silent. Keying per session is not available — the frame carries no address and `Waiter` keeps
    its predicate as a closure — and naming one anyway is a guess between pending joins, which is the false
    attribution this slice removes. So it is once per **client**, which is the honest cardinality: an agent is
    per session, a relay is per client.
  - **`flow-runner`'s once-guard was free too.** Its fixture answered a single `session:start`, so "once" and
    "every time" were indistinguishable. The premise that flow-runner already held all three properties was
    two-thirds true.
  - **The gate's new reach over `error` was unpinned in both directions.** Exempting `error` passed all 329.
    Unreachable today because `useRelay` opens a socket per hook, but the unreachability expires with #527, and
    then a foreign `session-not-found` tears down a healthy viewer. Four on the relay's `error` exits — and the fourth, the `join()` catch, **survived at
    first**: it is reached only when `join()` throws for something the two checks above it do not cover, so no
    existing test touched it. Forced with a spy rather than left unpinned, on the rule the previous slice arrived at:
    an address no test can hold is one that will drift.

  Three more on the mcp client survived at first for a subtler reason — the foreign-address test does not exercise
  the `sessionId === undefined` escape, because that half only fires for a refusal carrying **no** address. The
  test that holds it is the unaddressed one, and it holds the skew log and its once-guard too.

- 17a7484: fix(dashboard): tell the second tester the device is in use, and make an unhandled message a compile error

  `Session busy` reached the viewer and did nothing. The relay sends it when another browser socket already
  holds the session, so **two testers opening the same device** — the likeliest collision in a product whose
  premise is that the whole team opens a browser — left the second tab waiting on a `session:joined` that
  cannot arrive.

  Nothing reported it, because from the outside `error` _was_ a handled type. The viewer branched on the
  free-prose `message` and covered two of the three wordings the relay sends.

  `error` now carries a closed `reason` — the same split #491 gave `input:error`: `message` stays prose the
  producer owns, the machine field is closed. **Required here, unlike `InputErrorReason`**, because that
  one's producer set is open by design (a third-party platform registers through `AgentRegistry.register()`
  and may predate the field) while this one has a single producer: the relay, at three sites. So `sendTo`
  enforces it. The viewer switches on `reason` exhaustively, and a fourth reason is a compile error instead
  of another silent case.

  `busy-elsewhere` and `mac-overloaded` are dashboard-local stop reasons rather than new
  `SessionTerminatedReason` values, because in both cases the session is **alive** — widening the protocol
  vocabulary would let `session:terminated` carry a reason it can never mean. The copy record is keyed on the
  union, so it forced both wordings.

  The busy wording deliberately does **not** name another person. The relay answers `session-busy` whenever
  the session's browser socket still reads OPEN, and the commonest cause is the tester's _own_ previous
  socket: a sleeping laptop reconnects in 2s while the relay takes up to a heartbeat (30s) to notice the old
  one died. "Someone else is testing this device" would be false in exactly the case the viewer's own comment
  calls routine. Relatedly, the relay now checks occupancy _before_ the resource gate — with both true, the
  tester was told to pick a different Mac while the real reason went unreported — and skips the check for a
  socket re-joining the session it already holds, which is what `SessionList` does before a shutdown.

  `agent-resources-exhausted` also gained an exit. It only toasted, and the relay `return`s after sending it,
  so the tab sat on "Starting device…" indefinitely: making `reason` required stopped a case from being
  unhandled without making the handled cases _end_.

  **`SessionList` was dropping `error` too**, and the same shape of bug: `handleShutdown` sends
  `session:start` on its own socket, a refused join is answered there, and `device:shutdown-done` — the only
  message that clears `shutting` — never arrives. The badge read "Shutting down..." permanently and the gate
  on it hid both buttons, so the row went inert.

  ## The layer this belongs to

  Browser-inbound is 28 message types; the dashboard handled 22 and dropped 6. The three reasons for
  dropping — handled elsewhere, deliberately ignored, nobody wrote it — were **indistinguishable in code**,
  since all three look like an absent branch. `lib/inboundDisposition.ts` states one per message under
  `satisfies Record<BrowserInbound['type'], Disposition>`, so a message added to the wire breaks the file
  until someone picks a category. Measured: adding one produces `TS1360` at the table.

  Deriving the _reachable_ subset and obliging only that was designed and discarded, and it is the obvious
  idea, so both reasons are recorded in the file: `send()` is shared by four sockets that each open their
  own WebSocket, and a reply does not go to whoever asked — the relay forwards to whichever socket holds the
  session now, so "we never send `input:type`" is true per session, not per socket.

  Also corrects a false comment: `DeviceDetails` was documented as "what the viewer shows in its info card".
  Nothing reads it — both agents send `session:deviceInfo` and the relay replays it, while the viewer takes
  device name and OS from `agents:listed`. It stays on the wire because third-party agents send it.

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

- ef2dac8: refactor(protocol): give every wire message a name

  58 messages were anonymous members of a union, which meant two things could not be done. A single
  message could not be referred to — consumers reached for `Extract<Union, { type: 'x' }>`, one of them
  needing `extends { payload: infer P }` to get at a payload. And shared structure had nowhere to live:
  eight session-scoped failures carry the same `{ sessionId, message }` contract with no place to say so,
  and the comment explaining it floated above a union line.

  Each message is now an `export interface`, and the unions are unions of those names.

  - **`SessionError`** — the eight session-scoped failures extend it. Not for DRY (two fields) but so
    that "this is a failure addressed to a session" is something a reader and a check can see, and the
    contract note has a home. `error` does not inherit: it has no `sessionId`, which is the whole point
    of that member.
  - **Direction suffixes where a literal means two things.** `app:install` and `app:launch` travel in
    both directions with _different_ shapes — the browser sends `buildId`, the relay resolves it and
    sends `payload: { filePath, bundleId }`. Naming forced the split: `AppInstallToRelay` /
    `AppInstallToAgent`. `device:shutdown` is identical in both directions, so it is one interface both
    unions reference, which now says out loud that the relay forwards it untouched.
  - `GenericError`, because `Error` would shadow the global.

  **Names were derived from the `type` literals mechanically, not typed by hand.** The conversion's real
  hazard is a copy-paste that leaves two interfaces holding each other's literal, and `AgentToBrowser`
  has seven members whose shape is identical apart from the literal. A type-level equivalence check
  cannot see it — a union is a set, so which name owns which literal is not part of the comparison, and
  the routing check compares membership, so the literal set is unchanged. Measured: the swap produced
  zero errors from the nine equivalence assertions.

  So `typeAssertions.ts` carries one binding per message (`_InputDone: InputDone['type'] = 'input:done'`),
  and `scripts/__tests__/protocolMessageNames.test.mjs` asserts every message has one — plus that the
  eight failures declare `extends SessionError`, which no type can state about itself because every
  object with `{ sessionId, message }` is assignable to it.

  The conversion itself was proven with `Equals<Union, UnionOld>` against verbatim snapshots and then
  deleted along with them; that net was for the conversion window, not for keeping.

  **Two properties were given up, neither visible to that proof.** A named `interface` has no implicit
  index signature, so a message is no longer assignable to `Record<string, unknown>` — nothing breaks
  today because the three such sinks in this repo only ever receive fresh object literals, and the fix
  when one needs a typed value is to type the sink rather than widen the message. And an `interface` can
  be reopened by a consumer via `declare module`, which an anonymous union member could not. Both are
  recorded in `packages/protocol/AGENTS.md`.

- 96b8ce8: fix(relay): carry a reason on `input:error`, and stop blaming an agent for a session it never had

  The relay answers a terminal input it cannot dispatch — `input:touch:end`, `input:pinch:end`,
  `input:key`, `input:button` — so an MCP or browser caller fails immediately instead of waiting out its
  own timeout, which its fallback would report as success. That reply carried no `reason`, making the
  relay the last producer of `input:error` without one, and the one whose answer was least in doubt: an
  agent infers a reason from its own state, while the relay is looking straight at the socket.

  It now sends `reason: 'channel-unavailable'`. Two things change visibly: `mcp-server` puts the reason in
  the error it raises, and the dashboard's guidance for this reason is reworded (below). What does _not_
  change is the dashboard's branching — its unknown-reason rule already resolved to this same reason, and
  while the agent is away it suppresses the notice entirely. So the field itself buys something narrower
  and more durable: **absence now means an agent older than it and nothing else**, which is what makes it
  possible to require the field later.

  The prose was also wrong for half the cases it covered. Two situations reach that reply: the session
  is held with a socket that is no longer open, or there is no such session — evicted after the reconnect
  grace expired, or never valid. Only the first is the agent's fault; in the second the agent can be
  perfectly healthy, and `agent offline` sent the reader after the wrong problem. It now says
  `Session not found` there, the same two strings `device:boot` already used for the same pair.

  Both keep `channel-unavailable` rather than splitting into two wire reasons. The set is derived from
  what a consumer must do differently, and a reconnect or a re-join answers both — the machine field was
  right for both cases while the prose was wrong for one, which is exactly why consumers should branch on
  `reason` and display `message`.

  One consequence of that collapse had to be followed through: the dashboard's copy for this reason told
  the reader to check the agent on the Mac, which is a wild goose chase for a session the relay simply no
  longer has. It now says to rejoin the session and leaves the specific cause to the message shown beside
  it.

  No protocol change: `reason` has been optional on this message since it was introduced, so this is
  additive. Absence of the field now means an agent older than it, and nothing else.

- 3f903c8: fix(relay): the session-state replay carries a sessionId, so two of the three can require it

  `session:chrome`, `session:deviceInfo` and `device:ready` were declared `sessionId?: string` while both
  agents stamped the field on every copy they sent. The relay was the only producer that did not: its
  replay of cached session state to a re-joining viewer (`handleSessionStart`) omitted it, and the three
  share one declaration with the forwarded copies, so `optional` was the honest thing that declaration
  could say about two producers that disagreed.

  **The disagreement was the defect.** When this surface was consolidated, two ways to tighten the
  _declaration_ were weighed and rejected. The third option was not considered: fix the producer. The relay
  stamps `session:chrome` and `session:deviceInfo` now and both are required. Closes the Major deferred
  on #503 for those two.

  **`device:ready` is deliberately left optional, and that is the interesting half.** Its `sessionId?` is
  doing correlation work by accident: `mcp-server` and `flow-runner` gate a pending `device:boot` on
  `msg.sessionId === sessionId` with no truthiness escape, so the unstamped replay is invisible to them.
  Stamping it makes a _replayed_ `device:ready` satisfy an in-flight boot — measured on a real relay with a
  silent agent, `boot_device` answers `{booted: true}` having received nothing, where the same harness
  reports still-waiting without the stamp. The replay is cached state addressed to a **join**, not an answer
  to a **boot**, and `readySent` is cleared by nothing while an agent is wedged-but-connected, which is
  exactly when a boot hangs — so the value is stalest precisely when it would be consumed.

  The defect underneath is that leaving a session does not clear its waiters: a _real_ `device:ready` after
  a re-join already satisfies the stale one, so this is pre-existing and stamping only widens the trigger.
  Filed separately. What makes this message tightenable is a request correlator, not another field.

  `minor`, because the two that changed are published exports and adding a required field is source-breaking
  for an out-of-repo producer that omits it. `CONTRIBUTING.md` makes any breaking change a `major`, relaxed
  to `minor` before `v1.0.0`, and that is not conditional on a consumer being known.

  **The dashboard's session gate got stricter as a consequence.** It read
  `'sessionId' in msg && msg.sessionId && msg.sessionId !== sessionId`. The middle check was never what
  carried the replay — the relay omits the key, so `'sessionId' in msg` already lets those through — it only
  ever admitted a key that was _present and falsy_. With it gone, `sessionId: ''` is a mismatch rather than
  a pass. That is defence in depth against the unvalidated-inbound gap (#444), not a live hole: measured, an
  agent-sent `''` never reaches a viewer, because every agent→browser forward resolves
  `sessions.get(msg.sessionId!)` against a `randomUUID` key and breaks on the miss.

  One correction to a reason recorded three times in this package: rejecting the `Omit`-mapping alternative
  was justified by "it breaks `useClipboardBridge`, which reads its replies through `Extract<>`". It does
  not — that hook takes the three replies as named members and says so in its own comment, and its only
  `Extract` is over `ClipboardRequest`, an outbound union the mapping would never touch. The outcome is
  unchanged, since fixing the producer made both alternatives unnecessary.

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

- b459157: refactor(protocol): wire payload types are declared once, and a check keeps them that way

  Every wire payload type was declared separately in three to five packages, and they had drifted **in
  both directions**: `@tapflowio/protocol` was missing the `payload` field on `clipboard:error` that both
  agents send and the viewer reads, while the dashboard's `session:chrome` declaration was missing three
  fields its own `DeviceViewer` reads. Nothing checked either side, which is the situation
  `@tapflowio/protocol` was created to end — it had been half done.

  Protocol now owns them and everyone else imports: `ChromeData`, `ChromeButton`, `ChromeRect`,
  `AndroidButton`, `AgentResources`, `SessionInfo`, `Point`, and `ClipboardErrorPayload` (which moves out
  of `agent-core`, since neither the dashboard nor `mcp-server` can reach that package). `agent-core`,
  `flow-runner` and the relay re-export the names they published, so no consumer of those packages
  changes — including third-party agents built on `AgentRegistry.register()`.

  Three shapes were also the same thing under different names, which is how the duplication survived:
  protocol's `DeviceSummary` was `AgentDevice` in the dashboard and `DeviceInfo` in `mcp-server` and
  `flow-runner`, and that last name collided with the relay's own `DeviceInfo`, which is a _different_
  shape. `DeviceSummary` is now the one name; `flow-runner` keeps exporting `DeviceInfo` as an alias
  because the CLI imports it.

  **The comments moved with the types, and that mattered more than the types.** `ChromeData`'s fields
  were described accurately only in `ios-agent`, which produces them: the viewer lays out against an
  _expanded_ composite canvas (the device frame grown by the button margins), and protocol's copy said
  `compositeWidth` was "full PDF width including devicePadding" — a different quantity. Deleting the
  producer's declaration would have deleted the only correct description of the coordinate space three
  viewers compute against. Protocol's fields now carry it, with the two spaces named explicitly.

  A new check (`scripts/__tests__/protocolPayloadTypes.test.mjs`) fails if any package re-declares a
  protocol payload shape. It matches on **field sets, not names** — the inventory that planned this work
  grepped for names and missed two of the five copies of one shape for exactly the reason above, so a
  name-scoped check would have passed with all five standing and would be bypassed by a rename. It found
  two more copies during implementation: the relay's own `SessionInfo` and `agent-core`'s `Point`.

  No behaviour change: type declarations, imports and comments only. Every package's test count is
  unchanged.

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

## 0.18.0

### Minor Changes

- 7637be3: Add `@tapflowio/protocol`, one wire contract for the WebSocket messages exchanged between browser, relay and agents, and type every place that originates a message against it.

  Nothing checked those messages before. The relay built them as inline object literals passed to `JSON.stringify`, the dashboard's `send()` took `object`, and mcp-server's took `Record<string, unknown>` — so the definitions each package kept were descriptions, not contracts, and three of them had already drifted from the wire:

  - `stream:request-idr` was sent by the relay from two places while absent from its own `MessageType`.
  - `input:key` was documented as `payload: { key: string }`. Every sender and both agents use `{ code, modifiers }`, with `modifiers` a HID bitmap — so the field name and the type were both wrong.
  - `input:touch:end` and `app:clear-state` carried payloads from mcp-server that no definition mentioned.

  All three are fixed by the contract now describing what actually travels. The relay's 25 originating sends go through a typed `sendTo`, which also folds in the `readyState` check that was repeated at most call sites and missing at some. `Session.chromeData` is `ChromePayload` rather than `unknown`; the relay still only stores and forwards it, but a new platform now extends the union instead of the relay.

  No message changed shape on the wire. This is types only, and `@tapflowio/protocol` emits no runtime code — consumers import it with `import type`, so nothing reaches a browser bundle.

- 273c016: Tell an open dashboard tab when its session ends because the agent went away, instead of leaving it to spin.

  Restarting a device agent used to orphan the viewer: the relay deleted the session, the browser kept a live socket addressed to a `sessionId` that no longer existed, and everything it sent was dropped as unknown. The tab sat on `Waiting for first frame...` forever with no message, and only a manual page refresh recovered it.

  The relay now sends `session:terminated` (with `reason: 'agent-disconnected'`) to whoever is attached, before removing the session — after removal the socket reference is gone. The viewer reports it upward and the dashboard returns to the Mac list with an explanation, then refreshes the agent list immediately so picking the same Mac again does not try to join the dropped session.

  The relay also logs one line when an agent connects and one when it disconnects. It previously printed `Waiting for agents...` at startup and then said nothing either way, so a terminal gave no signal about whether an agent was attached.

  This is the first half of the fix. Rebinding the tab to the restarted agent's new session — so a restart is invisible rather than merely announced — is tracked separately.

### Patch Changes

- 2aebd34: Make an agent restart survivable for the tab that is watching (#426).

  The relay could already re-point a session at a restarted agent's socket (#458), but the trigger almost never fired. It required the old socket to still be registered when the new one arrived, and on a restart it never is: the close is processed in under 400 ms while a new agent takes about a second to register. Measured on a real simulator — the tab got the same bounce to the Mac list it got before any of this existed.

  So a closed agent socket no longer ends its sessions on the spot. They are held for 15 seconds (`TAPFLOW_AGENT_GRACE_MS`), which is long enough for the agent to come back and reclaim them, and the tab keeps its place. If it does not come back the window closes and the session ends exactly as before.

  The sessions stay where they are rather than moving to a holding area of their own — a returning agent is found by walking the sessions and reading the socket each one points at, so a session parked anywhere else could never be reclaimed.

  **`session:agent-away`** tells an attached viewer what is going on. Without it the tab would sit on a picture that stopped updating for the length of the window, which is the complaint #426 was opened with. The viewer drops the frame and says the agent went away; whichever answer follows — reconnected, or ended — replaces it. A genuinely dead agent is now better reported than before, not worse: the wait is explained, and only the news that it is over arrives later.

  Also, while an agent is away:

  - **Its devices are not offered.** A held session is not something anyone can pick, and listing it would draw a Mac card carrying the dead agent's last CPU and memory reading with no warning attached — the existing staleness badge keys off a 30-second-old sample, far longer than the window. It also prevents a duplicate card when a returning agent identifies itself differently, which is what happens when the upgrade that prompted the restart is the one that starts sending a machine id.
  - **Joining says so.** The join is allowed and answered with `session:agent-away`, rather than refused. Refusing looked simpler and was a trap: the viewer sends `session:start` once per reconnect and ignores a plain error, so a browser blip inside the window would strand the tab past any recovery.
  - **Nothing from the previous process is replayed** to a viewer that joins — its chrome, device info and readiness all describe an agent that is gone.
  - `device:boot` for a held session answers `agent offline` rather than `Session not found`. The id is valid, and retrying in a moment may well work.
  - A device that comes back under a different identity — which is what happens when the upgrade prompting the restart is the one that starts sending a machine id — ends the held session immediately rather than making its viewer wait out a window for a device that is demonstrably present.

  `agents:listed` has three other consumers, and a restarting Mac's devices are absent from all of them for the length of the window: `tapflow status` reads as no agents connected, and a one-shot `list_devices` over MCP or flow-runner returns nothing. Retrying after the window gives the normal answer. Shortening `TAPFLOW_AGENT_GRACE_MS` narrows it.

- f4235e5: Make app install/launch failures reach the caller that asked.

  Three paths through `handleBrowserAppInstall` / `handleBrowserAppLaunch` ended without a usable answer: an unknown session got a generic `error` with no `sessionId`, a missing build or bundle id got an app-specific error also without one, and an agent whose socket was not open got nothing at all — the `if` had no `else`. A dashboard viewer holds one session per socket, so an unattributed error still lands somewhere sensible and a human sees it. An MCP caller waits for the reply carrying its own `sessionId`, so all three looked the same from there: silence until the deadline. The caller was told "timed out" when the truth was "that build has no bundle ID".

  - **relay**: every exit from both handlers carries the request's `sessionId`, including `Session not found` — a generic `error` cannot be correlated by construction. An unreachable agent is answered immediately instead of being left to time out, matching what `open-url` and `clipboard:read` already do.
  - **relay**: `device:boot` gets the same treatment. A boot the agent never receives used to leave the viewer on "Waiting for first frame…" with nothing said. `device:shutdown` stays fire-and-forget — nothing waits on it, and inventing a reply type for it would grow the contract for a message no one reads.
  - **protocol**: `app:install-error` and `app:launch-error` now declare `sessionId` as required, and `device:boot-error` joins `RelayToBrowser`. Because `sendTo` is typed against that union, an omission at those call sites is a compile error rather than a silent gap. Messages the relay merely forwards, and the agents' own raw literals, stay outside that check — and nothing yet validates an inbound `sessionId` (#444), so this is a much tighter contract than before rather than an airtight one.
  - **relay**: `buildId` is checked before it reaches the query. `JSON.parse` does not honour `RelayMessage`, and an object or array there makes the driver throw — an exception the message loop used to swallow alongside genuine parse failures, leaving the caller with nothing. That loop no longer catches a parse failure and a routing failure in the same block, and it rejects payloads that are valid JSON but not messages (`null`, numbers, strings) before routing reads a field off them.
  - **dashboard**: the viewer ignores messages addressed to another session, and its local union carries the new field. Adding `sessionId` without a consumer that reads it would not have fixed a correlation bug.

- 76a00e7: Stop telling a viewer a device is ready when nothing is streaming.

  The relay replays `device:ready` when a browser joins, so a tab that lost its socket mid-session gets a picture back without waiting for another boot. The condition for that replay was `deviceStatus === 'booted'` — and `deviceStatus` starts life as the agent's `simctl list` snapshot at registration. Since the relay opens a session for every device an agent reports, a simulator somebody left running had a session marked booted before the agent had done anything with it. Joining that session produced a `device:ready` with no stream behind it.

  The replay now keys off whether this session announced a stream and has not since taken it back, tracked separately from the device's own state. `deviceStatus` is unchanged and still answers "is this device up" for the device list and the REST guards — the two questions were sharing one field.

  The flag is cleared on three events: `device:shutdown-done`, `device:booting`, and the stream socket closing.

  `device:booting` already cleared the cached chrome for the same reason — a browser joining mid-boot should not be promised a stream that is being torn down. The stream socket matters because the agent does not always get to report the end: `handleDeviceShutdown` tears the streamer down before running `simctl shutdown`, and if that throws, no `device:shutdown-done` is ever sent.

- bd9eb37: Fix Full reset erasing devices nobody asked to erase, and failing on the ones people did.

  Two defects that were only safe together. `resetMode` lived in a `useState` that nothing reset: leaving a session with `← All Macs` is a conditional re-render, not an unmount, so an armed toggle survived it and the _next_ device the tester picked was erased too. Separately, `IOSAgent` called `simctl erase` without checking device state, and `erase` refuses a device that is not shut down — so an explicit Full reset on a device that was already running died with `Boot failed: Command failed: xcrun simctl erase <udid>`.

  The second was containing the first: the unwanted erase usually targeted a booted device, so it threw and destroyed nothing. Fixing only the agent would have turned that loud failure into silent data loss, so both move together.

  - **dashboard**: Full reset is now a one-shot intent — arming it applies to the next device you pick and then disarms itself. Asking twice means turning it on twice. The mode the viewer was launched with is held separately from the toggle, so disarming does not disturb the running session.
  - **dashboard**: only the first `device:boot` of a viewer mount carries the reset. `session:joined` arrives again on every socket reconnect, so a Wi-Fi blip or a sleeping laptop would otherwise re-erase the device the tester is looking at, with no click involved.
  - **dashboard**: the toggle is not offered on Android, where nothing acts on it (#447). It used to stay visibly on having done nothing; self-disarming would have made that read as "done".
  - **ios-agent**: shut a running device down before erasing it. Any state other than `Shutdown` gets the shutdown — `Booting` and `Shutting Down` refuse an erase exactly as `Booted` does, and re-picking a device while its shutdown is still draining lands there. The request is never silently skipped.
  - **ios-agent**: if the erase itself fails, boot the device back up before reporting the error — but only when the device really was running and no newer boot has overtaken this one. The shutdown was ours to undo; a device that was already stopping, or one the tester has since asked to stop, is not.

- bd6e64f: Keep a session alive across an agent restart — the relay half (#426).

  Restarting a device agent ended every session it held: the browser was told `session:terminated` and sent back to the Mac list, losing its navigation for something that should have been invisible. The relay now recognises the restart for what it is on the wire — a second socket registering the same devices under the same identity — and re-points the session at it, keeping the id and telling the viewer with `session:rebound`, which the viewer answers with a fresh `device:boot`.

  Only devices the restarted agent still reports are kept. One that is gone gets the old treatment: its session ends and its viewer is told why.

  `SessionManager.rebind()` owns the whole move, rather than the call site doing it inline:

  - **The index order is load-bearing.** The session's id has to leave the old socket's set _before_ `agentSocket` is reassigned. Following the idiom in `remove()` — dereferencing the index through `session.agentSocket` — deletes it from the new set and leaves the old one holding it, so the old socket's close, which the relay itself triggers, evicts the session that was just re-pointed.
  - **Agent-derived fields now have one writer.** `create()` and `rebind()` both take them from a single function, so a field added to a session cannot land on one path only — and `rebind` is the path that would be missed.
  - Capabilities are refreshed, because an upgrade is the usual reason to restart an agent and `session:joined` is only sent once. The device's reported status is refreshed too: left stale, a device that came back down still reads `booted` to the REST guards.
  - `readySent` goes false. Carried across, a browser joining just after the restart would be replayed a `device:ready` for a stream that died with the old process.
  - The old socket's resource entry is dropped. `evictAgentSocket` normally does this, but it returns early when the socket has no sessions left — exactly the case where all of them were rebound — so the map would otherwise keep a dead socket per restart.

  Two things that used to be handled by the eviction the rebind now skips: in-flight screenshot and UI-tree requests are rejected outright instead of waiting out their timeout, and a device that gets a new session is left out of `create()` so the same simulator cannot end up behind two of them. `agent:registered` pairs devices with sessions by id rather than by position, which stops holding the moment some devices are rebound and others are new.

  A device named twice in one register payload now gets one session rather than two, one of which the agent was never told about — the same orphan the rebind prevents, arriving by a different door.

- a391b85: Teach the viewer to recover from an agent restart — the receiving half.

  Restart a device agent today and the tab is told `session:terminated` and sent back to the Mac list. That is better than the silence it replaced (#446), but it makes the tester redo navigation for something that should be invisible.

  `session:rebound` carries the alternative: the relay keeps the session, re-points it at the new agent socket, and tells the viewer to ask for its device back. The relay cannot restart the stream itself — the codec negotiation and the downscale tier ride in the browser's own `device:boot` payload and exist nowhere the relay can see.

  The receiving half landed before the sending one, and on its own it changed nothing. The reverse order would have left the tab worse than it was: the viewer would drop a message it did not know, and `device:boot` is only re-sent from the `session:joined` branch, so there was no recovery path to fall back on — a frozen frame that looks live until someone refreshes. Both halves are in this release, along with the window that gives a restarting agent time to come back.

  On receipt the viewer tears down first, then re-boots:

  - Clears what a restart invalidates, including three flags `device:booting` never touches — `launching`, `swKeyboardPending`, `swKeyboardVisible`. Their acknowledgements died with the old agent. This was unreachable before: a dead agent unmounted the viewer, so nothing could outlive it.
  - Re-sends `device:boot` carrying `app-only`, never a reset. A restart is not a request to erase the device (#439).
  - Skips the reinstall when the build was already on the device. The simulator stayed up across the restart, and reinstalling would kill the app state the recovery exists to preserve. The skip cannot key off `installed` at that point — `device:booting` clears that flag and the agent sends it on every boot, so it is always false by the time `device:ready` arrives — so the state is captured when the rebind starts.
  - Restores `installed` when it skips. That flag gates the Launch control, and without `app:install-done` to set it the tester would silently lose the button.
  - Installs anyway when the rebind interrupted an install. An agent is at its most fragile mid-install, and there the app really is absent — skipping would leave a Launch button for something that is not on the device.
  - Counts pending rebinds rather than flagging one. A crash-looping agent rebinds repeatedly, each with its own boot and its own `device:ready`; a flag is spent by the first, and the second reinstalls. The count is also reset by `session:joined` and `device:boot-error`, so a rebind whose agent never answers cannot absorb a later ordinary boot and suppress installs for the rest of the mount.

  Also names the Launch button on both platforms. It was icon-only with no accessible name, so screen-reader and voice-control users had no way to reach it.

- Updated dependencies [2aebd34]
- Updated dependencies [f4235e5]
- Updated dependencies [7637be3]
- Updated dependencies [a391b85]
- Updated dependencies [273c016]
  - @tapflowio/protocol@0.18.0
  - @tapflowio/agent-core@0.18.0

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

- @tapflowio/agent-core@0.17.0

## 0.16.0

### Patch Changes

- @tapflowio/agent-core@0.16.0

## 0.15.0

### Minor Changes

- Unify project state under a single `.tapflow/` root and harden Android build ingestion.

  - **Breaking — default data directory moved** from `.tapflow-data/` to `.tapflow/data/`, unifying all project state under one `.tapflow/` root (`data/` runtime, `flows/` committed, `artifacts/` screenshots). Existing installs keep working without action — a pinned `local.dataDir` is honored and a config-less default install keeps reading a pre-existing `.tapflow-data/`. Run `tapflow migrate data-dir` once to unify the layout (atomic rename, no data loss; repoints `local.dataDir` and updates `.gitignore`). Docker: remount your data volume at `/app/.tapflow/data`.
  - **Breaking — stricter APK ingestion.** `POST /api/v1/builds` now returns `400` for an `.apk` uploaded with `app_id` when the relay can't read the APK's package name (Android build-tools / `aapt` missing, or the archive is unreadable), instead of storing an unversioned build under that app. Install build-tools with `tapflow setup android`, or omit `app_id` to file the build separately.
  - Added `tapflow migrate data-dir`, an Android `build-tools` install in `tapflow setup android`, and an `aapt (build-tools)` check in `tapflow doctor`.
  - `tapflow flow run` writes failure screenshots to `.tapflow/artifacts/` by default, matching the `--artifacts` help text.
  - Fixed: an `.apk` with unreadable metadata is no longer merged into an unrelated app or false-promoted to platform `both`; `tapflow doctor` and the relay now share the same `aapt` search paths.

### Patch Changes

- @tapflowio/agent-core@0.15.0

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

## 0.13.0

### Minor Changes

- Outbound webhooks for build review-status changes

  The relay now POSTs to registered URLs when a build's review status transitions to `Done` or `Rejected`, so review outcomes can flow into Slack or the next CI step. Endpoints are registered at runtime via the REST API (`/api/v1/webhooks`, `builds:write` scope) or declared in `tapflow.config.json` (`webhooks`, with signing secrets read from env vars). Deliveries carry metadata only — never app binaries — and are HMAC-SHA256 signed (`X-Tapflow-Signature`) when a secret is set. Registration blocks loopback and cloud-metadata addresses.

### Patch Changes

- @tapflowio/agent-core@0.13.0

## 0.12.0

### Minor Changes

- Accept EAS `eas build` iOS simulator artifacts (`.tar.gz` / `.tgz`) as a first-class build upload, alongside `.app.zip` and `.apk`. The archive is stored as-is (no re-zip) and extracted with `tar` at install time, so the `.app`'s executable bits and symlinks are preserved. Uploads are validated before storage — path traversal (`..`/absolute), symbolic/hard links, corrupt gzip, and gzip bombs (`TAPFLOW_MAX_UNPACKED_BYTES`, default upload cap ×4) are rejected. This removes the CI re-packaging step for Expo/EAS teams: `eas build → CI → tapflow` uploads the native `.tar.gz` directly.

### Patch Changes

- @tapflowio/agent-core@0.12.0

## 0.11.1

### Patch Changes

- @tapflowio/agent-core@0.11.1

## 0.11.0

### Patch Changes

- 3377bfe: Fix the package type entrypoint for npm consumers (#345). `exports.types` now points at the published `dist/*.d.ts` instead of `src/` — which isn't shipped in the tarball (`files` ships only `dist`/`bin`), so consumers couldn't resolve the package's types.

  The monorepo moves to **TypeScript project references** (each lib package gets `composite: true` + `references`, plus a root solution `tsconfig.json`). `typecheck`/`build` run via `tsc -b`, so workspace typecheck stays build-light (incremental, no manual dist build) while the published packages expose correct types from `dist`. No runtime or public API changes.

- Updated dependencies [3377bfe]
  - @tapflowio/agent-core@0.11.0

## 0.10.0

### Minor Changes

- Build review status is now decoupled from the storage deletion lifecycle (#258). Marking a build **Done** no longer schedules it for deletion — `status_label` is a pure review state, and purge keys off a new nullable `delete_after` timestamp instead of `completed_at`. Deletion is an explicit action via `POST /api/v1/builds/:id/schedule-deletion` (and `DELETE …/schedule-deletion` to cancel); the response and build payloads now include `delete_after`. Migration `012` adds the column and grandfathers builds already on the old `completed_at` clock (`delete_after = completed_at + TTL`) so upgrades keep reclaiming disk. The dashboard shows a deletion-countdown badge separate from the status column with explicit schedule/cancel actions.

### Patch Changes

- 9864d2d: Build-upload validation errors are now returned in English, matching the rest of the API (previously the `.app.zip` format, missing-`.app`-directory, and device-only-slice messages were Korean only). Internal code comments are unchanged.
- d1b36a9: The relay now runs a WebSocket heartbeat (ping/pong, 30s) over every socket and terminates one that misses a pong window, so dead agent/browser/stream sockets (Wi-Fi loss, sleep, cable pull) are detected promptly instead of lingering until the TCP timeout. Termination reuses the existing close cleanup, evicting stale sessions and clearing the duplicate "Stale" card.
  - @tapflowio/agent-core@0.10.0

## 0.9.2

### Patch Changes

- - Bump nodemailer to 9.0.1, resolving the `raw`-option file-access / SSRF advisory (GHSA-p6gq-j5cr-w38f).
  - Reject in-flight screenshots when an agent is evicted on re-register.
  - Dedup agent re-register by machine id to remove duplicate "Stale" cards.
  - Extract `startTlsBackgroundTasks` (cert renewal + address publish) shared by all three entry points.
- Updated dependencies
  - @tapflowio/agent-core@0.9.2

## 0.9.1

### Patch Changes

- The relay now loads `.tapflow-data/.env` before reading its config, so every secret can live in that file — not just DNS/ACME tokens. `JWT_SECRET`, the SMTP password, and the tunnel token are all picked up from `.env` now. Precedence is shell env > `.env` > config file (a shell variable still overrides the file). `TAPFLOW_DATA_DIR` is the one exception, since it decides where `.env` lives.
  - @tapflowio/agent-core@0.9.1

## 0.9.0

### Minor Changes

- LAN HTTPS — terminate TLS in-process with automatic certificates.

  - relay: in-process TLS termination with a disk-backed certificate store and automatic renewal. Two providers: `AcmeCertProvider` (Let's Encrypt via DNS-01) and `ImportCertProvider` (bring your own cert).
  - relay: pluggable `DnsProviderRegistry` for DNS-01 challenges, with `CloudflareDnsProvider` and `VercelDnsProvider` adapters. New DNS providers register without touching relay code.
  - relay: auto-publishes the detected LAN IP to the configured domain's A record and self-heals it on change, so the HTTPS hostname keeps resolving on the local network.
  - relay: DNS/ACME credentials load from a gitignored `.env` file, namespaced under `TAPFLOW_`. Requires Node >= 20.12.0.
  - cli: `tapflow init` gains a guided HTTPS setup step for the LAN path; `tapflow start` wires `--trusted-proxies` / `--cors-origins`.

  This enables WebCodecs-based low-latency streaming, which requires a secure context on the LAN.

### Patch Changes

- da68b9e: Further harden the relay for public exposure:

  - CORS is restricted to the configured origins (public URL + loopback) instead of `*`, so an `Authorization` token can't be used from an unlisted cross-origin script.
  - Cookie-authenticated state-changing requests must come from a same-origin or allowlisted origin (lightweight CSRF guard); PAT-authenticated requests are exempt.
  - Invite links are built from the configured base URL (tunnel public URL / relay URL) instead of the request `Host` header.
  - Uploads that exceed the size limit are rejected and their partial files removed (builds and comment attachments). Limits are configurable via `TAPFLOW_MAX_BUILD_BYTES` / `TAPFLOW_MAX_COMMENT_BYTES`.

- 37f1aae: The relay now logs handler exceptions (method, path, stack) instead of silently swallowing them, so 5xx failures are diagnosable. Response bodies still return only a generic message, and PATs are masked in the logs.
  - @tapflowio/agent-core@0.9.0

## 0.8.2

### Patch Changes

- 859f9e3: Harden the relay for public and proxied exposure:

  - A per-install JWT secret is generated and persisted automatically when `JWT_SECRET` is unset, replacing the shared development default.
  - Authentication endpoints apply rate limiting with exponential backoff.
  - Bootstrap (`auth/init`) is restricted to localhost — on headless servers, run `tapflow admin init` on the relay host.
  - New `TAPFLOW_TRUSTED_PROXIES` resolves the real client IP from `X-Forwarded-For` when the relay runs behind a same-host reverse proxy.
  - @tapflowio/agent-core@0.8.2

## 0.8.1

### Patch Changes

- 129b5b1: relay: bind the server dual-stack (IPv4 + IPv6). A bare `listen(port)` bound IPv6-only on some macOS/node setups, so an agent on another Mac connecting over `ws://<ipv4>:4000` timed out (TCP/HTTP reached the host, but the WebSocket handshake never hit the server). The relay now binds with `{ host: '::', ipv6Only: false }`, so LAN agents connect over IPv4 without a workaround.
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

- 129b5b1: relay: bind the server dual-stack (IPv4 + IPv6). A bare `listen(port)` bound IPv6-only on some macOS/node setups, so an agent on another Mac connecting over `ws://<ipv4>:4000` timed out (TCP/HTTP reached the host, but the WebSocket handshake never hit the server). The relay now binds with `{ host: '::', ipv6Only: false }`, so LAN agents connect over IPv4 without a workaround.
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

- 306d859: feat: auto-delete build files 7 days after done status

  - Add `completed_at` column to builds table (migration 010)
  - Record timestamp when build status changes to Done
  - Block status changes on completed (Done) builds
  - Run TTL cleanup on server start and every 24 hours
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

- f13bd85: **Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

  If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.

  - @tapflowio/agent-core@0.1.0

## 0.1.0-alpha.8

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- f13bd85: **Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

  If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.

  - @tapflowio/agent-core@0.1.0-alpha.7

## 0.1.0-alpha.2

### Patch Changes

- @tapflowio/agent-core@0.1.0-alpha.2
