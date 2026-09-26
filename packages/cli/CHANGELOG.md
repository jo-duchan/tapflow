# tapflow

## 0.25.0

### Minor Changes

- 761db41: `tapflow logs` reads the relay on this machine, `http://localhost:<local.port>`, instead of `relay.url`, because the relay now serves its log buffer only to its own host. A `403` prints what to run on the relay machine instead of "Could not reach relay", and any other error status is named. `--relay` still picks another URL on the same machine.

  `tapflow agent start` leaves out its "create a PAT with the agent scope" hint when the relay refuses the token because its owner is no longer an Admin; the relay's reason says what to do instead. Every other refusal keeps the hint.

  When the local relay answers `403` (a Docker relay sees the host as remote), `tapflow logs` points at `docker compose logs`; when nothing answers and `relay.url` is set, it says that `relay.url` is not read and the command belongs on the relay host.

### Patch Changes

- d1a22da: `tapflow flow run --session` no longer tells you to find the session id in `tapflow status`, which prints none. Its help, and the error for a `--device` name that matches more than one device, now point at the MCP server's `list_devices`, the one command that lists session ids.
- Updated dependencies [e466590]
- Updated dependencies [761db41]
- Updated dependencies [761db41]
- Updated dependencies [9751c9c]
- Updated dependencies [853a2aa]
  - @tapflowio/relay@0.25.0
  - @tapflowio/flow-runner@0.25.0
  - @tapflowio/android-agent@0.25.0
  - @tapflowio/ios-agent@0.25.0
  - @tapflowio/agent-core@0.25.0

## 0.24.0

### Minor Changes

- bcc7c8e: Lean mode on Android emulators. With `agent.lean` on, the agent keeps four bundled Google apps disabled — the Google app, YouTube, YouTube Music and Digital Wellbeing — which start on their own at boot. Measured on an API 34 emulator, the guest takes about 350 MB, just under a fifth, less of the Mac's memory. The emulator returns memory only when it exits, so the apps stay disabled while Lean mode is on, and the saving starts from an emulator's second boot through tapflow; turning Lean mode off brings them back at the next boot. Photos, Messages, Gmail and Maps stay on because apps open images, texts, mail and maps through them. An emulator that is already running when a session asks for it is left as it is. `tapflow init` now asks wherever adb is installed, and `tapflow doctor` shows the setting per platform.
- 2700746: Lean mode for iOS simulators. With `agent.lean: true` in `tapflow.config.json` (or `TAPFLOW_LEAN=on`), the agent turns off a fixed list of background services — Siri and Apple Intelligence background work, iCloud Keychain and backup, Health app and HomeKit, photo analysis, Screen Time, iMessage and FaceTime, Continuity, telemetry and similar — on each simulator it boots, and puts them back when it shuts the simulator down. Measured on iOS 27, a simulator uses about a quarter less memory. Wallpaper, widgets and the services apps commonly call (push, StoreKit, CloudKit, HealthKit, the photo picker, universal links and others) stay on; an app that needs one on the list should run with Lean mode off. `tapflow init` asks on a Mac (default off) and `tapflow doctor ios` reports it. iOS 18.5 or later. Android emulators get their own Lean mode in this release: four bundled Google apps kept disabled.
- 5407be5: **`tapflow migrate` runs every migration an install still needs.** It checks each one, lists what applies, asks once in a terminal and runs without asking elsewhere, and stops at the first failure with exit 1. Today that is `data-dir`, when the install has a `.tapflow-data/` with data in it, and `net-filter`, when the iOS network filter is installed but out of date or not filtering. A Mac that never installed the filter is left alone. `tapflow migrate data-dir` and `tapflow migrate net-filter` work as before.

  **Builds still install after their data directory moves** ([#836](https://github.com/jo-duchan/tapflow/issues/836)). The relay stored each build's full path, so after `tapflow migrate data-dir` every build uploaded before it failed to install with "cannot read this build file", and expired ones were removed from the list while their files stayed on disk. The relay now finds the file in its current `uploads/builds/` first and falls back to the stored path.

  `tapflow migrate data-dir` refuses while something is listening on the relay's port, since a running relay would put later uploads back into `.tapflow-data/`. It also rewrites `tapflow.config.json` before the move and puts it back if the move fails, where a config it could not write used to leave the data moved and the config pointing at the old directory.

- 9f3a141: **tapflow keeps one install per machine, in `~/.tapflow`.** `tapflow init` writes the configuration there instead of the directory you happened to be standing in, and every command finds the same install: `TAPFLOW_HOME` when it is set, the current directory when it already is an install, and `~/.tapflow` otherwise. `tapflow start` and `tapflow relay start` print the install directory, the configuration file and the data directory they resolved. Existing installs keep running where they are, and nothing moves.

  `init` also writes an `AGENTS.md` — a tapflow section between `<!-- tapflow:begin -->` markers, leaving anything you wrote outside them alone — and, when the directory is tapflow's own, a `CLAUDE.md` containing `@AGENTS.md`. A coding agent opened in the install directory then answers tapflow questions from the documentation, with the configuration and `tapflow doctor` in reach. Running `init` again keeps the configuration and refreshes only that section.

  Every CLI command used to leave a `jwt-secret` file in whatever directory it ran in, including `tapflow --version`: the relay created it when its configuration module loaded, and the CLI loads every command at startup. The relay creates it when it starts now.

### Patch Changes

- e03c9da: `tapflow flow run` now exits 2 when every failed flow failed for environmental reasons (relay, agent or session level: a refused input with an environmental reason, a session lost to an agent restart, a dropped relay connection). Those used to reach CI as exit 1, reading as product regressions on the dashboards that rely on the 1-vs-2 distinction. Selector, assertion and other product failures still exit 1, successful runs still exit 0, and a run with both kinds keeps exit 1 so a real regression is never masked by a blip. The engine carries the kind on the flow result, so consumers never branch on prose; `run_flow` (MCP) now also returns `failureKind` and classifies input refusals the same way as the CLI. Fractional `durationMs` values (e.g. 250.5) stay valid as on 0.23.0.
- Updated dependencies [a5630d8]
- Updated dependencies [0a29931]
- Updated dependencies [75660db]
- Updated dependencies [ad39cd2]
- Updated dependencies [eb6fb90]
- Updated dependencies [e03c9da]
- Updated dependencies [2a96beb]
- Updated dependencies [6b71a1d]
- Updated dependencies [bcc7c8e]
- Updated dependencies [2700746]
- Updated dependencies [5407be5]
- Updated dependencies [2f66f31]
- Updated dependencies [96bd914]
- Updated dependencies [cc4676d]
- Updated dependencies [9f3a141]
- Updated dependencies [adc07d2]
  - @tapflowio/android-agent@0.24.0
  - @tapflowio/relay@0.24.0
  - @tapflowio/flow-runner@0.24.0
  - @tapflowio/agent-core@0.24.0
  - @tapflowio/ios-agent@0.24.0

## 0.23.0

### Minor Changes

- 3b63307: `tapflow migrate net-filter` and `tapflow setup ios` now finish an install that stopped at macOS approval in the same run. Until now they printed where to approve the network extension and exited with the filter switched off, so even someone who approved straight away had to run the command a second time before iOS network control worked.

  In an interactive terminal the command now offers to open the approval screen — the Network Extensions sheet with tapflow's switch in it — and **the question itself says what a yes leads to**: once the switch is on, tapflow turns the filter on, and connections the Mac already has open may drop, SSH sessions included. It then waits up to two minutes for the switch and turns the filter on, naming the content-filtering question macOS may ask at that point. It will not switch on over a simulator somebody started while it waited, and when it declines it says whether the filter is off. It never claims the window opened, because nothing can check that: the path to the screen is printed alongside.

  Without an interactive terminal — stdin as well as stdout, since a prompt reading an empty stdin ends the command with no output at all — or when the offer is declined or nobody switches it on in time, the banner now says to run the command again rather than to check with `tapflow doctor ios`, which only led back to the same instruction.

  How to remove the network extension changed too. `tapflow doctor ios`, `tapflow setup ios` and `tapflow migrate net-filter` all suggested `systemextensionsctl uninstall` for an extension whose app is gone from `/Applications`, and macOS refuses that command on any Mac with System Integrity Protection on. They now give the steps that work: switch the filter off with the binary inside the package (the exact command is printed), remove the extension in System Settings, and restart the Mac to finish.

- 57a244e: `tapflow setup ios` and `tapflow migrate net-filter` now say what the network-filter install is waiting on, instead of printing nothing while it runs. The install can take up to three minutes, and the silence read as a hang.

  Each step is named as it starts: checking what the Mac already has, taking the current filter out of the path, copying, activating, and confirming that a filter came back up. The activation line carries the approval warning **before** macOS asks, because the host binary reports "needs user approval" only by exiting 120 seconds later — a synchronous install cannot read that in between, so a warning afterwards would describe a wait that is already over.

  `tapflow setup ios` reports the first check too, on the path where it then _skips_ the install. That is the common case — a Mac that is already set up — and it decides it from the same four probes, so it was the half of the silence a report inside the installer could never reach.

- 7d703ad: `tapflow setup` now exits 1 when it prints `SETUP INCOMPLETE`. It returned 0 whatever the banner said, so anything that chained on it — `tapflow setup ios && tapflow agent start`, a provisioning run, a Makefile — carried on against a Mac that was not set up. A person reads the banner and a script reads the code, and the two disagreed. This is stricter than `tapflow doctor`, which passes a check that only warns and so reports a Mac with no simulator runtime as fine — the two answer different questions, one whether the Mac is usable and one whether the work got done.

  Only pending work counts. A step that reports a note while still being fine — the audio permission on a run that cannot ask, a host that is not macOS — leaves the run complete and the code 0. Declining an install at a prompt does count, because the environment is then just as unready as if nothing had asked. The network filter is the exception: it is an optional feature rather than part of a working Mac, so declining it leaves the run complete, while a non-interactive run that could never ask reports it as pending.

  The banner, the results list and the new-terminal hint all still print first.

  Migrate: a script that should carry on past an incomplete setup needs `;` or `|| true` where it used `&&`, or `|| true` on the line itself under `set -e`.

- 7877bc9: Tunnel traffic no longer counts as local. The relay opens a loopback-only tunnel port (`TAPFLOW_TUNNEL_PORT`) where every connection must authenticate, and `tapflow start` and `tapflow relay start` open it on 4001 whenever a tunnel is configured (4002 when the relay itself runs on 4001). The CLI points the rathole client at it, warns when `tailscale serve` forwards to the relay port or `tailscaled` runs in userspace-networking mode, and stops rathole clients left behind by an exited tapflow process.

### Patch Changes

- 4638949: `tapflow migrate net-filter` and `tapflow setup ios` now offer the approval screen **before** the install, and open it the moment macOS starts waiting for approval. The offer used to come only after the two-minute approval wait had run out, and on macOS 27 those two minutes were where people got lost: macOS's own prompt highlights OK, which closes it without approving anything, and a rerun shows no prompt at all because macOS does not ask twice about a request already waiting.

  The offer is made when no tapflow extension is approved yet (a first install, a rerun over a waiting request, a reinstall after removing it), and only in an interactive terminal. It carries the same warning as before about connections dropping when the filter goes on. A yes is not asked for again after the wait, and a no is not repeated. Pressing Ctrl-C or Esc at the question stops the command with nothing installed (`setup ios` skips the step), since the question comes before anything has changed. When macOS was not expected to ask, the offer after the wait is unchanged. The activation line now tells people to choose Open System Settings rather than OK.

- ef22d67: `tapflow setup` no longer ends at exit 0 with nothing after the question when stdin is empty. Every prompt in setup decided whether it could ask by reading `stdout` alone, so a run whose output is a terminal but whose input is not — `tapflow setup ios </dev/null`, or a wrapper that leaves stdin closed — drew the prompt and waited on a promise that never settles. The process then left the event loop and exited **0**: no results list, no `SETUP INCOMPLETE` banner, and every step after the one that asked never ran. A Mac that is already set up reached it at the audio-permission step, which is offered on every macOS 14.2+ run, so the network filter install behind it was silently skipped.

  A session now counts as interactive only when both ends are a terminal, decided in one place that the setup steps, `tapflow init`, `tapflow admin init` and the network filter's approval all read. `tapflow admin init` had the same unguarded prompts and is the command self-hosting points headless servers at, so a provisioning script got exit 0 and no admin account; it now says a terminal is required and exits 1.

  Two consequences worth knowing. Answers piped into stdin — `yes | tapflow setup android` — no longer reach the prompts, and the steps print what to run instead. That idiom was never whole: measured over three questions, clack answers the first from the pipe and then never settles again, so the run died the same silent death one step later. And a pty on both ends with nobody holding the other end (`ssh -tt host 'tapflow setup ios' </dev/null`, `docker run -t` without `-i`) reads as a terminal on both descriptors, so it is unchanged: no test of the file descriptors separates it from a person who has not typed yet.

- Updated dependencies [00dcb7f]
- Updated dependencies [e63e410]
- Updated dependencies [9d4cfd5]
- Updated dependencies [7877bc9]
  - @tapflowio/ios-agent@0.23.0
  - @tapflowio/agent-core@0.23.0
  - @tapflowio/android-agent@0.23.0
  - @tapflowio/relay@0.23.0
  - @tapflowio/flow-runner@0.23.0

## 0.22.0

### Minor Changes

- 7359488: **iOS input and streaming find SimulatorKit where Xcode 27 put it** ([#797](https://github.com/jo-duchan/tapflow/issues/797)). Xcode 27 moved `SimulatorKit.framework` out of the developer directory (`Contents/Developer/Library/PrivateFrameworks/`) into `Contents/SharedFrameworks/`. The touch and screen-capture helpers knew only the old location, so on a Mac whose only Xcode is 27 they could not start: no input reached the simulator and no stream opened. On a Mac where Xcode 27 is selected and an older Xcode is also in `/Applications`, they fell back to that Xcode's SimulatorKit instead; whether that worked against Xcode 27's simulator service was not tested. Both locations are now checked on the selected Xcode before any other Xcode is, and each helper logs the SimulatorKit it is about to load.

  **Bezels come back on every iPad and most iPhones.** Xcode 27 no longer lists a device's screen size in its `profile.plist` and publishes it in `capabilities.plist` instead, so a device whose frame is assembled from nine slices rather than one image lost its bezel. That is most of them: on Xcode 27, 104 of 129 device types — every iPad, Apple Watch and iPod touch, and the iPhone 6s through 13, 14, 14 Plus, SE, 16e and 17e. The 14 Pro models, Air, and every iPhone 15, 16, 17 and 18 model other than 16e and 17e draw their frame from one image and never lost it. The size is now read from either file; on Xcode 27.0 each of those 104 carries one, and on Xcode 26 it is read exactly as before.

### Patch Changes

- a12ff53: **The invite link the dashboard copies is the one the invitation email carries** ([#788](https://github.com/jo-duchan/tapflow/issues/788)). The email was built from the relay's configured address, while the dialog rebuilt the link from whatever address your browser was on — so on the Vite dev server it copied `localhost:3001`, and an admin working on the relay Mac copied `localhost:4000`. The dialog now shows the relay's link. The same applies to "Copy link to comment" and to the relay address in the agent command under Settings → Tokens: with `TAPFLOW_RELAY_URL` (or `relay.url`) set, all three use it. With nothing set they keep your browser's address, except that a browser on `localhost` gets the relay's LAN address, which the agent command already did. The invite response gains an `inviteUrl` field, `null` when the relay has no address a teammate can open.

  **A tunnel's address is the one it actually got** ([#794](https://github.com/jo-duchan/tapflow/issues/794)). Choosing Tailscale in `tapflow init` leaves `publicUrl` empty and `tapflow start` detects the MagicDNS name, but only the startup banner ever used it — invitations still pointed at `localhost:4000`. The tunnel now starts before the relay and hands over what it got, so invitations, dashboard links and the CORS allowlist use the detected address, and a tunnel that fails to start no longer leaves its configured address in any of them. A tunnel address is for teammates' browsers: the agent command uses `relay.url`, never the tunnel, so an agent on the relay's own network does not stream through it. If the port is already taken, the command now stops before touching the tunnel, rather than restarting a running instance's rathole server on its way to failing.

  **Running the relay image without `TAPFLOW_RELAY_URL` is said out loud.** The relay logs a warning at startup when it runs in a container with no address a teammate can open, since invitations then point at `localhost`. Inside a container it also stops offering its bridge address (such as `172.17.0.2`) as the LAN address for the agent command.

  **The invite dialog no longer claims a copy that did not happen.** It said "copied" even when the browser refused, and on a plain-HTTP page, which has no clipboard API, it reported the invitation itself as failed. The invite link, a new token and the agent command now sit in read-only fields that take focus, so on such a page they can be selected and copied by keyboard, and the invite dialog states its outcome to screen readers, which cannot hear a toast behind an open dialog. "Copy & close" on a new token no longer does nothing on a plain-HTTP page.

- Updated dependencies [e2123d5]
- Updated dependencies [0699c26]
- Updated dependencies [a12ff53]
- Updated dependencies [7359488]
  - @tapflowio/relay@0.22.0
  - @tapflowio/ios-agent@0.22.0
  - @tapflowio/android-agent@0.22.0
  - @tapflowio/agent-core@0.22.0
  - @tapflowio/flow-runner@0.22.0

## 0.21.0

### Patch Changes

- 676641f: An iOS app that reads `SCNetworkReachability` is now told when its simulator is taken off the network. Taking a device offline already stopped its traffic, and an app built on `NWPathMonitor` drew its offline state correctly — but Alamofire's `NetworkReachabilityManager` and the older `Reachability.swift` read a different API, and that one kept answering "reachable" while every request failed. The offline screen a tester came to check never appeared.

  The fix answers that API too, and **re-fires the callback the library is actually listening on** rather than only changing what a poll would return: a consumer caches what its callback last told it and never polls, so faking the getter alone moves a number nobody reads. Both ways of scheduling that callback are covered — a dispatch queue and a run loop.

- Updated dependencies [400f887]
- Updated dependencies [7f8ba98]
- Updated dependencies [da074d3]
- Updated dependencies [801d360]
- Updated dependencies [676641f]
- Updated dependencies [15e98fc]
- Updated dependencies [253e94c]
- Updated dependencies [26f79c3]
- Updated dependencies [cc8de63]
- Updated dependencies [913a675]
- Updated dependencies [9bcb989]
- Updated dependencies
- Updated dependencies [bd7a9f5]
- Updated dependencies [7d8eb4e]
  - @tapflowio/ios-agent@0.21.0
  - @tapflowio/android-agent@0.21.0
  - @tapflowio/relay@0.21.0
  - @tapflowio/agent-core@0.21.0
  - @tapflowio/flow-runner@0.21.0

## 0.20.1

### Patch Changes

- a6ab06d: TLS startup instructions now use the certificate-resolved hostname for remote agent connections instead of leaving a misleading host placeholder.
- 06db7d9: **Replacing the iOS network filter no longer takes the Mac's network down with it.** The filter is a
  content filter, so every new connection on the Mac waits for the provider to decide, not only the
  simulator's. `migrate net-filter` replaced the extension while that configuration stayed switched on,
  which killed the process that decides and left new connections waiting for an answer nobody would
  give. Measured on 2026-09-02: the Mac's own traffic timed out and a restart was the only way back.
  Already-open connections kept working, so the visible symptom was a dead browser next to things that
  carried on.

  The replace now switches the filter off first and `--install` turns it back on. The window that
  remains was measured across ~300 probes on a same-version disable/enable cycle: about four seconds of
  raised latency, no failures, because the kernel passes traffic for a provider that has not applied
  its settings yet. That cycle did not swap the provider process, so a real replacement is **expected**
  to behave the same way over a longer window rather than measured to.

  The disable runs before the activation, and the binary asked to perform it is the one this
  package shipped rather than whatever was already installed. **A later entry in this same release
  moves a second disable ahead of the copy too**, because the copy into `/Applications` turned out
  not to be as inert as this paragraph originally claimed: macOS runs the extension from its own
  directory, which is why it keeps filtering for an app you deleted, but the copy still prompts it
  to restart on its own schedule. The shipped order is now off, copy, off, activate. Asking
  whatever was already installed would have been wrong twice over: a build older than the flag
  does not refuse it, it falls through to writing `isEnabled = true`, and a Mac whose app had been
  deleted had nothing to ask while its extension was still activated and filtering.

  **It also refuses while devices are in use.** Booted simulators, attached emulators and a relay
  serving on `:4000` all count, because the filter is host-wide and the person affected is not
  necessarily the person at the keyboard. `--ignore-running-devices` replaces it anyway;
  `tapflow migrate data-dir` rejects that flag rather than ignoring it. The gate sits in the shared
  install routine, so `tapflow setup ios` is covered too.

  **And a filter that was switched off is no longer reported as up to date.** `systemextensionsctl`
  describes the system extension, not `NEFilterManager.isEnabled`, so a Mac interrupted between the
  disable and the install had the right app, the right activated extension, no filter, and `doctor ios`
  all green — with the only thing that would restore it being the run that had just declined to do
  anything. Being current now means enforcing as well as matching, in all three places that ask:
  `doctor ios` says the filter is switched off and names the command that turns it back on, and neither
  `migrate net-filter` nor `setup ios` reports a stopped filter as nothing to do.

- 49f95e4: Keep iOS network control working after the filter is upgraded, and stop the upgrade from taking the Mac's network down.

  Replacing the network filter's system extension leaves the previous one holding the XPC service name, so the new provider could not vend its listener and `--confirm` answered "no listener" while the filter was enforcing normally. The agent read that as "not confirmed" and the dashboard's **Take device offline** control went unavailable on every Mac that had upgraded. It now falls back to the provider's own state file, which is the channel the CLI already preferred.

  The upgrade also switches the filter off _before_ it copies the app into `/Applications`, not only before activating it. Copying the app makes macOS restart the filter session on its own timing, and a filter session going down arms a kernel-wide IP drop — that is what took a Mac's network down for 2m34s on 2026-09-02, and the previous ordering was winning the race by 69 milliseconds.

  Also: the provider publishes a rule change immediately instead of waiting for its next idle pulse, its state file names which provider wrote it, and a listener that fails to start now says so rather than logging success.

- 3ead059: **`tapflow migrate net-filter` now checks that the filter actually came back before saying it did.**
  The host binary's exit 0 means macOS did not refuse the change, which is smaller than "it works" —
  the configuration reaches the provider afterwards with nothing coming back — and by that point the
  command has switched the filter off in order to replace it safely. So a run could report _iOS network
  control is available now_ over a Mac where nothing was filtering.

  It now waits, up to thirty seconds, for a filter to report itself running — one that started _after_
  the install, not the previous provider's last heartbeat — and leaves as soon as one does.
  `tapflow setup ios` does the same when it installs the filter.

  When none appears the command says so and **exits non-zero** instead of claiming success, because
  that state is the one where the configuration is switched on and nothing is answering for it. Usually
  it is simply still starting, and `tapflow doctor ios` will say so a moment later; if new connections
  on the Mac have stopped, the command names the `--off` that takes the filter out of the path.

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

- Updated dependencies [a2be8e0]
- Updated dependencies [3d2aade]
- Updated dependencies [49f95e4]
- Updated dependencies [79d5c1b]
- Updated dependencies [07d4b40]
- Updated dependencies [da07ac4]
- Updated dependencies [ea2b5cc]
- Updated dependencies [916b02a]
  - @tapflowio/ios-agent@0.20.1
  - @tapflowio/relay@0.20.1
  - @tapflowio/android-agent@0.20.1
  - @tapflowio/agent-core@0.20.1
  - @tapflowio/flow-runner@0.20.1

## 0.20.0

### Minor Changes

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

### Patch Changes

- 6d20bba: Advertise the first teammate-ready DNS host from an imported TLS certificate in relay startup output, preferring a concrete SAN over `localhost`. DNS SANs take precedence over the legacy subject CN; certificates with unusable DNS SANs keep the safe `localhost` fallback and now explain it with a warning.
- f04c2e7: Stop a second tapflow agent from putting the first one's devices back online, and refuse the configuration that made it possible.

  The iOS filter rule is host-wide, and the agent wrote its **whole** offline set on every run — so the host replaced the rule with it. `arm()` runs on every device boot, and a freshly started agent knows of no offline device: starting a second agent therefore put every device the first had taken offline back online, silently, while that tester watched an offline control over an app whose traffic was working. The rule is now changed by a delta the caller names, so an agent removes nothing it was not asked about. The cleanup the whole-set write provided is kept in a more precise form: arming a device names that device, so a rule left behind by a dead process is cleared when that device next boots.

  `tapflow agent start` also refuses when a tapflow agent for the same platform is already running on the Mac, and says so. One agent manages every simulator on its machine — the relay already treats two as one, since agent identity there is the machine's hardware id plus the platform — so the second one was never a supported setup; it just failed later and without a sentence. Nothing changes for the ordinary case of many simulators and many testers on one agent.

  And the filter's container app now exits non-zero on an argument it does not recognise. It used to fall through to writing an empty rule, so a newer agent asking an older installed app a question it could not answer — `--confirm` — did not get a refusal, it **erased the rule**.

- d4a5965: Ship the iOS network filter with tapflow, and give the CLI the three commands that install, migrate and check it.

  The filter is the one layer of the offline toggle that lives on the Mac, and until now tapflow did not distribute it — the feature was complete and unusable by anyone who could not build and sign it themselves. The signed, notarized app now travels inside `@tapflowio/ios-agent`, so `tapflow setup ios` offers it on a new machine — asked for, like every other install that command performs — and `tapflow migrate net-filter` covers a machine set up before the feature existed, or one where setup was declined.

  `tapflow doctor ios` reports three things separately: installed, approved, and **running the version this tapflow carries**. The third is not the same question as the first two — replacing an extension finishes only on restart, so the app on disk can be current while macOS still runs the old one, and that is exactly the state where the dashboard says the Mac is not set up. The version comparison therefore reads what macOS has activated rather than what is in `/Applications`.

  Installing refuses to replace a newer filter than the one it carries: `/Applications` holds one copy for the whole Mac while each install judges it by its own dependencies, so an older checkout would otherwise downgrade the filter a newer agent depends on.

- cb04a51: Write the injected library's verdict file atomically, so a healthy app stops reporting that its state could not be confirmed.

  The library wrote the file with `fopen(path, "w")`, which truncates it in place. The agent reads that file on every `state()` call — the relay triggers one on `device:ready`, on a viewer's re-join and after every toggle — so a read landing inside the write is reachable on a session where nothing is wrong, and what it gets is half a file. The reader cannot tell that from a real answer, so the network control reported `state-unconfirmed` for no cause. It now writes beside the target and `rename`s onto it: a reader sees the whole old file or the whole new one.

  The dylib is a committed prebuilt with no recorded build recipe, so `packages/ios-agent/build-nethook.sh` now holds one. Its flags were recovered from the committed binary rather than remembered, and confirmed by a rebuild whose every section matched byte for byte.

  Two things that were invisible now report. `bin/libtapflow-nethook.dylib` is a committed prebuilt, and every test that exercised the network hook injected a _fake_ path — so editing the source and shipping the previous binary was silent. It is now recorded against its sources like the network filter next door, with the difference stated in the guard: a failure here is the contributor's to fix, because no signing key is involved.

  And the library itself had no diagnosis at all. `DYLD_INSERT_LIBRARIES` naming a path that does not exist is ignored by dyld without a word, so a damaged install launched the app unhooked and wrote no verdict — leaving the control asking the tester to launch an app through tapflow, for the whole session, while the app they launched was running in front of them. `tapflow doctor ios` now reports the library, and the agent says so instead of asking for something already done.

- Updated dependencies [6d20bba]
- Updated dependencies [9d0df7d]
- Updated dependencies [becbe77]
- Updated dependencies [ca397f4]
- Updated dependencies [f04c2e7]
- Updated dependencies [3f18f70]
- Updated dependencies [04c7090]
- Updated dependencies [fee8244]
- Updated dependencies [d4a5965]
- Updated dependencies [cb04a51]
- Updated dependencies [5e2fcc5]
- Updated dependencies [7152b21]
- Updated dependencies [d238c34]
- Updated dependencies [f497d0a]
- Updated dependencies [faeaae9]
- Updated dependencies [4901c8c]
- Updated dependencies [964c145]
- Updated dependencies [df94718]
- Updated dependencies [17c5787]
- Updated dependencies [ecf34dd]
- Updated dependencies [2bac3f4]
- Updated dependencies [1823117]
- Updated dependencies [636caf5]
- Updated dependencies [d238c34]
- Updated dependencies [7f44ff7]
  - @tapflowio/relay@0.20.0
  - @tapflowio/agent-core@0.20.0
  - @tapflowio/android-agent@0.20.0
  - @tapflowio/ios-agent@0.20.0
  - @tapflowio/flow-runner@0.20.0

## 0.19.0

### Minor Changes

- e55371c: **Requires Node.js ≥ 22.** Node 20 reached end of life on 2026-04-30 and no longer receives security patches.

  Three declarations disagreed about what was supported, and none of them matched what was actually run. The manifests said `>=20.12.0`, the documentation said "≥ 20" — meaning 20.0.0 — and CI ran 20 while Docker ran 22 and the release job ran 24. There was also a band that was declared but unusable: every `undici` 7.x requires Node `>=20.18.1`, so 20.12 through 20.17 could not complete a development install regardless of what the manifests promised.

  The floor is now 22 everywhere, and 22 is a version that will be tested rather than merely claimed — CI runs the suite on both 22 and 24. That is the part that had been missing: `>=20.12.0` was declared for a year and never once exercised on 20.12, which is how it drifted below what the dependency tree already required.

  `tapflow`, `@tapflowio/flow-runner` and `@tapflowio/mcp-server` declared no `engines` at all and now do. `tapflow` is the package installed with `npm i -g`, so until now the CLI announced no Node requirement to the people most likely to need it.

  `tapflow doctor` moves with it and reports `Node ≥ 22 required` below the floor. Without that change it would have printed a green check on Node 20 while the package manifest called the same version unsupported.

  Node 22 is supported until 2027-04-30; Node 24 is the active LTS. Containers and the published image now run 24.

### Patch Changes

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

- Updated dependencies [a5466b9]
- Updated dependencies [c9bad6e]
- Updated dependencies [d63811f]
- Updated dependencies [15593db]
- Updated dependencies [42987e1]
- Updated dependencies [2bf043f]
- Updated dependencies [87cd901]
- Updated dependencies [c67a690]
- Updated dependencies [edfc65d]
- Updated dependencies [252262b]
- Updated dependencies [4d4fe13]
- Updated dependencies [57981a1]
- Updated dependencies [17a7484]
- Updated dependencies [513b17b]
- Updated dependencies [b5ea86d]
- Updated dependencies [c7d0064]
- Updated dependencies [d4d68a0]
- Updated dependencies [a669e0a]
- Updated dependencies [36160cb]
- Updated dependencies [ef2dac8]
- Updated dependencies [e55371c]
- Updated dependencies [e8b29b8]
- Updated dependencies [96b8ce8]
- Updated dependencies [3f903c8]
- Updated dependencies [7ad6343]
- Updated dependencies [c007606]
- Updated dependencies [1123d63]
- Updated dependencies [0c63c1b]
- Updated dependencies [a97efa9]
- Updated dependencies [5ab537d]
- Updated dependencies [e84a2ea]
- Updated dependencies [b459157]
- Updated dependencies [2317d50]
- Updated dependencies [760e27a]
  - @tapflowio/agent-core@0.19.0
  - @tapflowio/ios-agent@0.19.0
  - @tapflowio/android-agent@0.19.0
  - @tapflowio/relay@0.19.0
  - @tapflowio/flow-runner@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [2aebd34]
- Updated dependencies [f4235e5]
- Updated dependencies [971e375]
- Updated dependencies [76a00e7]
- Updated dependencies [bd9eb37]
- Updated dependencies [7637be3]
- Updated dependencies [bd6e64f]
- Updated dependencies [a391b85]
- Updated dependencies [273c016]
- Updated dependencies [535c726]
  - @tapflowio/relay@0.18.0
  - @tapflowio/ios-agent@0.18.0
  - @tapflowio/android-agent@0.18.0
  - @tapflowio/agent-core@0.18.0
  - @tapflowio/flow-runner@0.18.0

## 0.17.0

### Patch Changes

- Updated dependencies [eaa78ac]
- Updated dependencies [eaa78ac]
- Updated dependencies [661356e]
- Updated dependencies [eaa78ac]
- Updated dependencies [eaa78ac]
  - @tapflowio/android-agent@0.17.0
  - @tapflowio/relay@0.17.0
  - @tapflowio/ios-agent@0.17.0
  - @tapflowio/agent-core@0.17.0
  - @tapflowio/flow-runner@0.17.0

## 0.16.0

### Minor Changes

- Flow-runner reliability and MCP session lifecycle.

  - **flow-runner: retry transient ui-tree query errors while polling.** Wait steps (`tapOn` / `assertVisible` / `assertNotVisible`) no longer fail the instant a query throws — e.g. the app not being in the foreground yet right after `launchApp`. The poll loop distinguishes transient failures (foreground race, idle timeout, network) from permanent ones (bad request, auth, missing session) and retries the transient ones until the step deadline, so waits are truly condition-based (no `sleep` workarounds). A stalled query is also bounded by an abort signal so it can't block past the deadline.
  - **flow-runner: `role` and `index` selector disambiguators.** The object-form selector takes two new optional fields — `role` (narrow by element kind, e.g. `{ label, role: button }` when a button and its inner text share a label) and `index` (0-based, pick the Nth remaining match, e.g. `{ role: cell, index: 2 }` for a label-less row). Additive: bare-string and `{ id }` / `{ label }` selectors are unchanged; the object form now needs at least one of `id` / `label` / `role`.
  - **mcp: `run_flow` installs the build before replaying** when `buildId` is set (parity with `tapflow flow run --build`), so `clearState` / `launchApp` find the app present; pass `install: false` to skip.
  - **mcp: `shutdown_device` tool** — powers a session's booted simulator/emulator down to free resources or force a cold boot, distinct from `disconnect_device` (which only leaves the session, keeping the device running).
  - Security: pinned `axios`, `protobufjs`, `body-parser`, and `js-yaml` past their advisories via `pnpm.overrides`.

### Patch Changes

- Updated dependencies
  - @tapflowio/flow-runner@0.16.0
  - @tapflowio/agent-core@0.16.0
  - @tapflowio/ios-agent@0.16.0
  - @tapflowio/android-agent@0.16.0
  - @tapflowio/relay@0.16.0

## 0.15.0

### Minor Changes

- Unify project state under a single `.tapflow/` root and harden Android build ingestion.

  - **Breaking — default data directory moved** from `.tapflow-data/` to `.tapflow/data/`, unifying all project state under one `.tapflow/` root (`data/` runtime, `flows/` committed, `artifacts/` screenshots). Existing installs keep working without action — a pinned `local.dataDir` is honored and a config-less default install keeps reading a pre-existing `.tapflow-data/`. Run `tapflow migrate data-dir` once to unify the layout (atomic rename, no data loss; repoints `local.dataDir` and updates `.gitignore`). Docker: remount your data volume at `/app/.tapflow/data`.
  - **Breaking — stricter APK ingestion.** `POST /api/v1/builds` now returns `400` for an `.apk` uploaded with `app_id` when the relay can't read the APK's package name (Android build-tools / `aapt` missing, or the archive is unreadable), instead of storing an unversioned build under that app. Install build-tools with `tapflow setup android`, or omit `app_id` to file the build separately.
  - Added `tapflow migrate data-dir`, an Android `build-tools` install in `tapflow setup android`, and an `aapt (build-tools)` check in `tapflow doctor`.
  - `tapflow flow run` writes failure screenshots to `.tapflow/artifacts/` by default, matching the `--artifacts` help text.
  - Fixed: an `.apk` with unreadable metadata is no longer merged into an unrelated app or false-promoted to platform `both`; `tapflow doctor` and the relay now share the same `aapt` search paths.

### Patch Changes

- Updated dependencies
  - @tapflowio/relay@0.15.0
  - @tapflowio/android-agent@0.15.0
  - @tapflowio/ios-agent@0.15.0
  - @tapflowio/agent-core@0.15.0
  - @tapflowio/flow-runner@0.15.0

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
  - @tapflowio/ios-agent@0.14.0
  - @tapflowio/android-agent@0.14.0
  - @tapflowio/relay@0.14.0
  - @tapflowio/flow-runner@0.14.0

## 0.13.0

### Minor Changes

- Outbound webhooks for build review-status changes

  The relay now POSTs to registered URLs when a build's review status transitions to `Done` or `Rejected`, so review outcomes can flow into Slack or the next CI step. Endpoints are registered at runtime via the REST API (`/api/v1/webhooks`, `builds:write` scope) or declared in `tapflow.config.json` (`webhooks`, with signing secrets read from env vars). Deliveries carry metadata only — never app binaries — and are HMAC-SHA256 signed (`X-Tapflow-Signature`) when a secret is set. Registration blocks loopback and cloud-metadata addresses.

### Patch Changes

- Updated dependencies
  - @tapflowio/relay@0.13.0
  - @tapflowio/android-agent@0.13.0
  - @tapflowio/ios-agent@0.13.0
  - @tapflowio/agent-core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies
  - @tapflowio/relay@0.12.0
  - @tapflowio/ios-agent@0.12.0
  - @tapflowio/android-agent@0.12.0
  - @tapflowio/agent-core@0.12.0

## 0.11.1

### Patch Changes

- Patch js-yaml to 3.15.0 to address CVE-2026-53550, and bump the npm minor/patch dependency group.
- Updated dependencies
  - @tapflowio/ios-agent@0.11.1
  - @tapflowio/agent-core@0.11.1
  - @tapflowio/android-agent@0.11.1
  - @tapflowio/relay@0.11.1

## 0.11.0

### Minor Changes

- 0c2b82c: Simulator audio output (device → browser) is now **on by default** for both iOS and Android. Opt out with `TAPFLOW_AUDIO=off` — one env for both platforms (`agent start --ios/--android` already selects the platform). The no-degradation contract (audio yields to video) keeps the video path safe whether audio is on or off.

  **iOS**: simulator processes are host processes, so tapflow taps the whole simulator's process tree with a Core Audio process tap (macOS 14.2+) — app audio + WebKit `WebContent` (web audio, e.g. YouTube in Safari) + system sounds, with no device routing, no dylib injection, no host-output hijack, on any signed build. The tap stays current as processes spawn and start/stop audio (process-tree polling + a Core Audio process-object listener); each simulator is isolated (no cross-bleed); the sim's own volume is reflected; and the host (agent Mac) stays muted so audio goes only to the browser. The audio-capture permission is primed at `tapflow agent start` — re-run it if browser audio is silent.

  **Android**: emulator audio is captured over gRPC `streamAudio`. Unlike iOS, the emulator also plays to the host Mac (it has no host-output-only mute) — use the Mac's own volume to silence it.

  Capture normalizes to 44100/Stereo/S16 and rides the existing `CODEC_AUDIO` transport. The capture runs in a small signed helper (`audiotap-helper`, iOS) launched via LaunchServices so it holds its own one-time audio-recording grant.

### Patch Changes

- 3377bfe: Fix the package type entrypoint for npm consumers (#345). `exports.types` now points at the published `dist/*.d.ts` instead of `src/` — which isn't shipped in the tarball (`files` ships only `dist`/`bin`), so consumers couldn't resolve the package's types.

  The monorepo moves to **TypeScript project references** (each lib package gets `composite: true` + `references`, plus a root solution `tsconfig.json`). `typecheck`/`build` run via `tsc -b`, so workspace typecheck stays build-light (incremental, no manual dist build) while the published packages expose correct types from `dist`. No runtime or public API changes.

- d6da20c: Clarify the Android setup/doctor PATH refresh guidance when the SDK rc block already exists but the current shell has not loaded it.
- a0d3eac: Add a `tapflow doctor` check that warns when the default relay port 4000 is already occupied.
- Updated dependencies [2af1938]
- Updated dependencies [2af1938]
- Updated dependencies [6bd8ebe]
- Updated dependencies [0c2b82c]
- Updated dependencies [3377bfe]
  - @tapflowio/android-agent@0.11.0
  - @tapflowio/ios-agent@0.11.0
  - @tapflowio/agent-core@0.11.0
  - @tapflowio/relay@0.11.0

## 0.10.0

### Minor Changes

- Build review status is now decoupled from the storage deletion lifecycle (#258). Marking a build **Done** no longer schedules it for deletion — `status_label` is a pure review state, and purge keys off a new nullable `delete_after` timestamp instead of `completed_at`. Deletion is an explicit action via `POST /api/v1/builds/:id/schedule-deletion` (and `DELETE …/schedule-deletion` to cancel); the response and build payloads now include `delete_after`. Migration `012` adds the column and grandfathers builds already on the old `completed_at` clock (`delete_after = completed_at + TTL`) so upgrades keep reclaiming disk. The dashboard shows a deletion-countdown badge separate from the status column with explicit schedule/cancel actions.

### Patch Changes

- 9864d2d: Build-upload validation errors are now returned in English, matching the rest of the API (previously the `.app.zip` format, missing-`.app`-directory, and device-only-slice messages were Korean only). Internal code comments are unchanged.
- `tapflow setup` now reports per-step state — `found` / `created` / `repaired` — instead of a binary result, so you can see which prerequisites were already in place versus newly provisioned. Android SDK environment registration that was already present is now reported as `repaired` rather than `found`.
- c3ea54c: The iOS screen-capture helper now reports a `capture-wait` metric under `TAPFLOW_STREAM_METRICS=1` — the polling gap between an IOSurface change and when the frame is encoded, emitted as `info: capture-wait avg/max/n` per 150-sample window. Diagnostic only; capture behavior is unchanged.
- d1b36a9: The relay now runs a WebSocket heartbeat (ping/pong, 30s) over every socket and terminates one that misses a pong window, so dead agent/browser/stream sockets (Wi-Fi loss, sleep, cable pull) are detected promptly instead of lingering until the TCP timeout. Termination reuses the existing close cleanup, evicting stale sessions and clearing the duplicate "Stale" card.
- Updated dependencies
- Updated dependencies [9864d2d]
- Updated dependencies [c3ea54c]
- Updated dependencies [d1b36a9]
  - @tapflowio/relay@0.10.0
  - @tapflowio/ios-agent@0.10.0
  - @tapflowio/android-agent@0.10.0
  - @tapflowio/agent-core@0.10.0

## 0.9.2

### Patch Changes

- Wire TLS into the all-in-one `tapflow start` so LAN teammates get secure-context streaming (Smooth/WebCodecs) — previously only `relay start` served HTTPS. The co-located agent accepts the localhost `wss://` cert only, while external relays keep full verification.

  Include `--token` in the agent connect hint for remote relays, and unify the stream-quality tier label to "Smooth".

- Updated dependencies
  - @tapflowio/agent-core@0.9.2
  - @tapflowio/android-agent@0.9.2
  - @tapflowio/ios-agent@0.9.2
  - @tapflowio/relay@0.9.2

## 0.9.1

### Patch Changes

- The relay now loads `.tapflow-data/.env` before reading its config, so every secret can live in that file — not just DNS/ACME tokens. `JWT_SECRET`, the SMTP password, and the tunnel token are all picked up from `.env` now. Precedence is shell env > `.env` > config file (a shell variable still overrides the file). `TAPFLOW_DATA_DIR` is the one exception, since it decides where `.env` lives.
- Updated dependencies
  - @tapflowio/relay@0.9.1
  - @tapflowio/android-agent@0.9.1
  - @tapflowio/ios-agent@0.9.1
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
- Updated dependencies
- Updated dependencies [da68b9e]
- Updated dependencies [37f1aae]
  - @tapflowio/relay@0.9.0
  - @tapflowio/android-agent@0.9.0
  - @tapflowio/ios-agent@0.9.0
  - @tapflowio/agent-core@0.9.0

## 0.8.2

### Patch Changes

- 859f9e3: Harden the relay for public and proxied exposure:

  - A per-install JWT secret is generated and persisted automatically when `JWT_SECRET` is unset, replacing the shared development default.
  - Authentication endpoints apply rate limiting with exponential backoff.
  - Bootstrap (`auth/init`) is restricted to localhost — on headless servers, run `tapflow admin init` on the relay host.
  - New `TAPFLOW_TRUSTED_PROXIES` resolves the real client IP from `X-Forwarded-For` when the relay runs behind a same-host reverse proxy.

- Updated dependencies [859f9e3]
  - @tapflowio/relay@0.8.2
  - @tapflowio/android-agent@0.8.2
  - @tapflowio/ios-agent@0.8.2
  - @tapflowio/agent-core@0.8.2

## 0.8.1

### Patch Changes

- 6e4801a: Restore remote agent connections to the relay (#271). The WS auth gate added in 17b8615 closed every non-loopback connection without a cookie/PAT, so no remote agent could register — the agent then hung forever on a silent pre-registration close ("Connecting ios agent…"). Remote agents now connect again, authenticated with a token.

  **Changed — remote agents now require a token.** A relay on a different machine only accepts agents that present a PAT with the new `agent` scope (create one in Settings → Tokens, pass it via `--token` or `TAPFLOW_AGENT_TOKEN`). Agents connecting to a relay on the same machine (`localhost`) stay unauthenticated, so `tapflow start` is unchanged. See [Remote relay authentication](https://www.tapflow.dev/operate/agents#remote-relay-authentication).

  Details:

  - relay: remote connections presenting a PAT with the new `agent` scope are accepted and roled by their first message (`agent:register` / `stream:register`); the rejection close reason explains the fix and is logged. Token creation API accepts a `scope` field (`agent` scope is Admin-only; default scope unchanged).
  - dashboard: token dialog gains an API/Agent type selector; creating an agent token shows a ready-to-run `tapflow agent start --token` command.
  - agents (iOS/Android): new `token` option sends `Authorization: Bearer` on the control and stream WS; pre-registration closes now reject with the close code/reason instead of hanging; handshake timeout (10s default); reconnect failures log their cause.
  - cli: `tapflow agent start --token` flag (or `TAPFLOW_AGENT_TOKEN` env); a 1008 rejection prints token setup guidance. Local (`localhost`) agents stay unauthenticated — `tapflow start` is unchanged.

- Updated dependencies [80f4d78]
- Updated dependencies [129b5b1]
- Updated dependencies [6e4801a]
  - @tapflowio/ios-agent@0.8.1
  - @tapflowio/relay@0.8.1
  - @tapflowio/agent-core@0.8.1
  - @tapflowio/android-agent@0.8.1

## 0.8.1-next.0

### Patch Changes

- Updated dependencies [80f4d78]
- Updated dependencies [129b5b1]
  - @tapflowio/ios-agent@0.8.1-next.0
  - @tapflowio/relay@0.8.1-next.0
  - @tapflowio/android-agent@0.8.1-next.0
  - @tapflowio/agent-core@0.8.1-next.0

## 0.8.0

### Minor Changes

- 2552e53: feat(cli): add `tapflow doctor --json` and diagnose adb installed-but-not-in-PATH

  - `tapflow doctor --json` emits machine-readable `{ ok, common, ios, android }` with no ANSI color, exiting 1 on failure — usable from CI and automation without screen-scraping.
  - `doctor` now detects adb present in a standard SDK location (`$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, `~/Android/Sdk`) but missing from PATH, instead of silently dropping the entire Android section. It surfaces an `adb (not in PATH)` warning hinting `tapflow setup android`.

- 5bd3381: fix(cli): `doctor` shows Android even without adb, and adds `doctor [platform]`

  `tapflow doctor` no longer hides the Android section when adb is not found — it surfaces an `adb not found → tapflow setup android` warning so people setting up an Android-only agent can still diagnose it. Added `tapflow doctor ios|android` to check a single platform (mirrors `tapflow setup [platform]`); omit the argument to check all.

- 3991d68: feat(cli): setup android bootstraps a self-contained SDK (JDK + cmdline-tools), no Android Studio

  `tapflow setup android` no longer relies on Android Studio (whose `.app` install doesn't include the SDK, breaking unattended setup). Instead it builds a self-contained SDK at `~/Library/Android/sdk`:

  - installs a JDK via Temurin when missing (required by sdkmanager)
  - bootstraps `cmdline-tools;latest` + `platform-tools` + `emulator` + a `google_apis` system image into the SDK with `sdkmanager --sdk_root`, auto-accepting licenses
  - registers `ANDROID_HOME` and platform-tools/emulator on PATH
  - creates the form-factor AVD set with the SDK's own avdmanager

  Because cmdline-tools live inside the SDK, the avdmanager resolves the SDK root automatically — fixing the "Valid system image paths are: null" failure caused by a brew/SDK path split. Verified end-to-end on a clean Mac.

- 78743d4: feat(cli): add `tapflow setup android` — guided Android environment setup

  `tapflow doctor` diagnoses problems; `tapflow setup android` fixes them. It walks through the required Android dependencies and applies fixes where safe:

  - **Homebrew** — checks `which brew`, prints the install URL if missing (cannot auto-install).
  - **adb** — if present in PATH it passes; if found in a standard SDK location but missing from PATH it registers the `platform-tools` directory in your shell rc (`.zshrc`/`.bashrc`) inside an idempotent marker block; if absent it runs `brew install android-platform-tools`.
  - **Android Studio** — checks `/Applications/Android Studio.app`; since the cask is large (~1GB+) it asks for confirmation before `brew install --cask android-studio`, and skips with guidance in non-interactive shells.
  - **Emulator** — reports running emulators and hints how to start an AVD.

  Each step is idempotent — re-running on a configured machine prints ✓ and makes no changes.

- e21902e: feat(cli): `tapflow setup` can install Homebrew after confirmation

  When Homebrew is missing, `tapflow setup android` (and upcoming `setup ios`) now offers to install it via the official script after an explicit confirmation prompt, instead of only printing the install URL. In non-interactive shells it still just prints guidance — no remote script runs without consent. This makes Homebrew the shared first step for all platform setups.

- 64d9a59: feat(cli): add `tapflow setup ios` and unify the setup command

  `tapflow setup ios` guides iOS environment setup: Homebrew → Xcode → Xcode activation → Simulator.

  - **Xcode** — since Xcode is App-Store-only, an interactive flow opens the App Store and waits for you to finish installing, then re-checks. Non-interactive shells print the App Store link instead.
  - **Xcode activation** — detects the "installed but not usable" case (active developer dir on CommandLineTools, missing license, or first-launch) and prints the exact `sudo xcode-select -s …` / `xcodebuild -license accept` / `-runFirstLaunch` commands (these need sudo, so setup guides rather than auto-runs them).
  - **Simulator** — boots the first available simulator if none is running.

  The `setup` command now takes an optional platform: `tapflow setup ios`, `tapflow setup android`, or `tapflow setup` to auto-detect and run every supported platform (iOS on macOS, Android when adb is found).

  Closes #144 (and completes #142 together with `setup android`).

- 3b5b28e: feat(cli): setup completes in one run; doctor reflects on-demand boot

  `tapflow setup` is now an end-to-end interactive wizard instead of stopping to print manual commands:

  - runs sudo steps directly after confirmation (`xcode-select -s`, `xcodebuild -license accept`, `-runFirstLaunch`) — no more "run this and re-run setup" loop.
  - iOS: downloads the simulator runtime when no device exists.
  - Android: when no AVD exists, installs a `google_apis` system image once and creates a set of 4 AVDs across form factors (compact / phone / large / tablet) so the device list is comparable to iOS. Device ids are chosen per-environment from candidates; ABI matches the host arch.
  - no longer boots devices — relay boots on-demand when a QA Session connects, so setup only ensures a bootable device/AVD exists.
  - `tapflow setup` (no argument) offers to set up Android even when adb isn't found, and ends with a `SETUP COMPLETE` / `SETUP INCOMPLETE` summary banner (per-platform ready state).

  `tapflow doctor` now passes when a simulator device or AVD _exists_ (any state) rather than requiring a _running_ one, matching the on-demand boot model.

### Patch Changes

- 4f957e1: fix(cli): doctor reports missing adb as a failure, consistent with Xcode

  `tapflow doctor` now marks a missing adb as a failure (✗) — the same as a missing Xcode — instead of a warning, so a clean machine shows its checks uniformly. `tapflow setup android` resolves it.

- 629741f: fix(cli): doctor AVD is a failure (not a warning) when the SDK/emulator is absent

  On a clean machine, `tapflow doctor` showed Android SDK/adb as ✗ but AVD as ⚠. AVD now mirrors iOS Simulator: a missing SDK/emulator is a failure (✗, `tapflow setup android`), while a present emulator with no AVD stays a warning (⚠). The emulator is resolved from the SDK directory.

- a593b9a: fix(cli): doctor no longer triggers the macOS "install Command Line Tools" popup

  On a Mac without Xcode, `tapflow doctor` called `xcodebuild`/`xcrun`, which makes macOS pop up the Command Line Tools installer. doctor now checks for `/Applications/Xcode.app` first (no popup) and only invokes those tools when Xcode is present — otherwise it reports "Install Xcode / run tapflow setup ios" directly.

- fc98ebd: feat(cli): setup highlights "open a new terminal" after registering ANDROID_HOME/PATH

  When `tapflow setup android` adds `ANDROID_HOME`/PATH to your shell rc, the current shell doesn't pick them up — so running `tapflow doctor` right away showed confusing adb/AVD warnings. setup now prints a clear "open a new terminal (or run `exec zsh`), then `tapflow doctor`" note after the summary banner, only when the env was just registered.

  - @tapflowio/agent-core@0.8.0
  - @tapflowio/ios-agent@0.8.0
  - @tapflowio/android-agent@0.8.0
  - @tapflowio/relay@0.8.0

## 0.8.0-next.4

### Patch Changes

- a593b9a: fix(cli): doctor no longer triggers the macOS "install Command Line Tools" popup

  On a Mac without Xcode, `tapflow doctor` called `xcodebuild`/`xcrun`, which makes macOS pop up the Command Line Tools installer. doctor now checks for `/Applications/Xcode.app` first (no popup) and only invokes those tools when Xcode is present — otherwise it reports "Install Xcode / run tapflow setup ios" directly.

  - @tapflowio/agent-core@0.8.0-next.4
  - @tapflowio/ios-agent@0.8.0-next.4
  - @tapflowio/android-agent@0.8.0-next.4
  - @tapflowio/relay@0.8.0-next.4

## 0.8.0-next.3

### Patch Changes

- 629741f: fix(cli): doctor AVD is a failure (not a warning) when the SDK/emulator is absent

  On a clean machine, `tapflow doctor` showed Android SDK/adb as ✗ but AVD as ⚠. AVD now mirrors iOS Simulator: a missing SDK/emulator is a failure (✗, `tapflow setup android`), while a present emulator with no AVD stays a warning (⚠). The emulator is resolved from the SDK directory.

- fc98ebd: feat(cli): setup highlights "open a new terminal" after registering ANDROID_HOME/PATH

  When `tapflow setup android` adds `ANDROID_HOME`/PATH to your shell rc, the current shell doesn't pick them up — so running `tapflow doctor` right away showed confusing adb/AVD warnings. setup now prints a clear "open a new terminal (or run `exec zsh`), then `tapflow doctor`" note after the summary banner, only when the env was just registered.

  - @tapflowio/agent-core@0.8.0-next.3
  - @tapflowio/ios-agent@0.8.0-next.3
  - @tapflowio/android-agent@0.8.0-next.3
  - @tapflowio/relay@0.8.0-next.3

## 0.8.0-next.2

### Minor Changes

- 3991d68: feat(cli): setup android bootstraps a self-contained SDK (JDK + cmdline-tools), no Android Studio

  `tapflow setup android` no longer relies on Android Studio (whose `.app` install doesn't include the SDK, breaking unattended setup). Instead it builds a self-contained SDK at `~/Library/Android/sdk`:

  - installs a JDK via Temurin when missing (required by sdkmanager)
  - bootstraps `cmdline-tools;latest` + `platform-tools` + `emulator` + a `google_apis` system image into the SDK with `sdkmanager --sdk_root`, auto-accepting licenses
  - registers `ANDROID_HOME` and platform-tools/emulator on PATH
  - creates the form-factor AVD set with the SDK's own avdmanager

  Because cmdline-tools live inside the SDK, the avdmanager resolves the SDK root automatically — fixing the "Valid system image paths are: null" failure caused by a brew/SDK path split. Verified end-to-end on a clean Mac.

### Patch Changes

- 4f957e1: fix(cli): doctor reports missing adb as a failure, consistent with Xcode

  `tapflow doctor` now marks a missing adb as a failure (✗) — the same as a missing Xcode — instead of a warning, so a clean machine shows its checks uniformly. `tapflow setup android` resolves it.

  - @tapflowio/agent-core@0.8.0-next.2
  - @tapflowio/ios-agent@0.8.0-next.2
  - @tapflowio/android-agent@0.8.0-next.2
  - @tapflowio/relay@0.8.0-next.2

## 0.8.0-next.1

### Minor Changes

- 5bd3381: fix(cli): `doctor` shows Android even without adb, and adds `doctor [platform]`

  `tapflow doctor` no longer hides the Android section when adb is not found — it surfaces an `adb not found → tapflow setup android` warning so people setting up an Android-only agent can still diagnose it. Added `tapflow doctor ios|android` to check a single platform (mirrors `tapflow setup [platform]`); omit the argument to check all.

- 3b5b28e: feat(cli): setup completes in one run; doctor reflects on-demand boot

  `tapflow setup` is now an end-to-end interactive wizard instead of stopping to print manual commands:

  - runs sudo steps directly after confirmation (`xcode-select -s`, `xcodebuild -license accept`, `-runFirstLaunch`) — no more "run this and re-run setup" loop.
  - iOS: downloads the simulator runtime when no device exists.
  - Android: when no AVD exists, installs a `google_apis` system image once and creates a set of 4 AVDs across form factors (compact / phone / large / tablet) so the device list is comparable to iOS. Device ids are chosen per-environment from candidates; ABI matches the host arch.
  - no longer boots devices — relay boots on-demand when a QA Session connects, so setup only ensures a bootable device/AVD exists.
  - `tapflow setup` (no argument) offers to set up Android even when adb isn't found, and ends with a `SETUP COMPLETE` / `SETUP INCOMPLETE` summary banner (per-platform ready state).

  `tapflow doctor` now passes when a simulator device or AVD _exists_ (any state) rather than requiring a _running_ one, matching the on-demand boot model.

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.1
- @tapflowio/ios-agent@0.8.0-next.1
- @tapflowio/android-agent@0.8.0-next.1
- @tapflowio/relay@0.8.0-next.1

## 0.8.0-next.0

### Minor Changes

- 2552e53: feat(cli): add `tapflow doctor --json` and diagnose adb installed-but-not-in-PATH

  - `tapflow doctor --json` emits machine-readable `{ ok, common, ios, android }` with no ANSI color, exiting 1 on failure — usable from CI and automation without screen-scraping.
  - `doctor` now detects adb present in a standard SDK location (`$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, `~/Android/Sdk`) but missing from PATH, instead of silently dropping the entire Android section. It surfaces an `adb (not in PATH)` warning hinting `tapflow setup android`.

- 78743d4: feat(cli): add `tapflow setup android` — guided Android environment setup

  `tapflow doctor` diagnoses problems; `tapflow setup android` fixes them. It walks through the required Android dependencies and applies fixes where safe:

  - **Homebrew** — checks `which brew`, prints the install URL if missing (cannot auto-install).
  - **adb** — if present in PATH it passes; if found in a standard SDK location but missing from PATH it registers the `platform-tools` directory in your shell rc (`.zshrc`/`.bashrc`) inside an idempotent marker block; if absent it runs `brew install android-platform-tools`.
  - **Android Studio** — checks `/Applications/Android Studio.app`; since the cask is large (~1GB+) it asks for confirmation before `brew install --cask android-studio`, and skips with guidance in non-interactive shells.
  - **Emulator** — reports running emulators and hints how to start an AVD.

  Each step is idempotent — re-running on a configured machine prints ✓ and makes no changes.

- e21902e: feat(cli): `tapflow setup` can install Homebrew after confirmation

  When Homebrew is missing, `tapflow setup android` (and upcoming `setup ios`) now offers to install it via the official script after an explicit confirmation prompt, instead of only printing the install URL. In non-interactive shells it still just prints guidance — no remote script runs without consent. This makes Homebrew the shared first step for all platform setups.

- 64d9a59: feat(cli): add `tapflow setup ios` and unify the setup command

  `tapflow setup ios` guides iOS environment setup: Homebrew → Xcode → Xcode activation → Simulator.

  - **Xcode** — since Xcode is App-Store-only, an interactive flow opens the App Store and waits for you to finish installing, then re-checks. Non-interactive shells print the App Store link instead.
  - **Xcode activation** — detects the "installed but not usable" case (active developer dir on CommandLineTools, missing license, or first-launch) and prints the exact `sudo xcode-select -s …` / `xcodebuild -license accept` / `-runFirstLaunch` commands (these need sudo, so setup guides rather than auto-runs them).
  - **Simulator** — boots the first available simulator if none is running.

  The `setup` command now takes an optional platform: `tapflow setup ios`, `tapflow setup android`, or `tapflow setup` to auto-detect and run every supported platform (iOS on macOS, Android when adb is found).

  Closes #144 (and completes #142 together with `setup android`).

### Patch Changes

- @tapflowio/agent-core@0.8.0-next.0
- @tapflowio/ios-agent@0.8.0-next.0
- @tapflowio/android-agent@0.8.0-next.0
- @tapflowio/relay@0.8.0-next.0

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
  - @tapflowio/ios-agent@0.7.0
  - @tapflowio/android-agent@0.7.0
  - @tapflowio/relay@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies
  - @tapflowio/android-agent@0.6.1
  - @tapflowio/agent-core@0.6.1
  - @tapflowio/ios-agent@0.6.1
  - @tapflowio/relay@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.6.0
  - @tapflowio/android-agent@0.6.0
  - @tapflowio/ios-agent@0.6.0
  - @tapflowio/relay@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [c469362]
  - @tapflowio/android-agent@0.5.1
  - @tapflowio/agent-core@0.5.1
  - @tapflowio/ios-agent@0.5.1
  - @tapflowio/relay@0.5.1

## 0.5.0

### Minor Changes

- H.264 streaming pipeline with automatic codec negotiation.

  - iOS streams H.264 by default (VideoToolbox encoder), cutting bandwidth ~10× vs JPEG (~16–27 KB/frame vs ~235 KB) for noticeably lower latency. Android streaming moves to a runtime decoder layer.
  - The browser advertises its decode capability (`acceptH264`) at boot; the agent picks H.264 only when the client can decode it, otherwise falls back to JPEG — no black screens on older browsers.
  - Tiered browser decoders: HTTPS → WebCodecs, plain-HTTP LAN → WASM (tinyh264), both WebGL2-rendered.

  Backward compatible: the envelope codec/keyframe marker reuses a previously zero flag byte, so older clients read frames as JPEG and the relay forwards payloads untouched. Agents without `acceptH264` (version skew) default to JPEG. Opt out of H.264 anytime with `TAPFLOW_IOS_CODEC=jpeg`.

- 267447c: feat(cli): `tapflow start` now reads the tunnel config from `tapflow.config.json` and prints the public URL in the startup banner.

  Previously only `tapflow relay start` brought up the tunnel (Tailscale/rathole). Now the local all-in-one `tapflow start` starts the tunnel too, auto-detecting the Tailscale MagicDNS hostname (or tailnet IP) and showing a `Public :` URL in the banner. Tunnel startup logic was consolidated into `lib/tunnel-runner.ts`.

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.5.0
  - @tapflowio/ios-agent@0.5.0
  - @tapflowio/relay@0.5.0
  - @tapflowio/android-agent@0.5.0

## 0.4.1

### Patch Changes

- 17b8615: fix: path traversal in /uploads/ and unauthenticated WebSocket access
- Updated dependencies [17b8615]
  - @tapflowio/agent-core@0.4.1
  - @tapflowio/ios-agent@0.4.1
  - @tapflowio/android-agent@0.4.1
  - @tapflowio/relay@0.4.1

## 0.4.0

### Minor Changes

- feat!: tapflow init redesign, Tailscale tunnel, web onboarding, and UX improvements

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.4.0
  - @tapflowio/ios-agent@0.4.0
  - @tapflowio/android-agent@0.4.0
  - @tapflowio/relay@0.4.0

## 0.3.1

### Patch Changes

- Fix mcp-server release: add publishConfig for experimental tag and public access
- Updated dependencies
  - @tapflowio/agent-core@0.3.1
  - @tapflowio/ios-agent@0.3.1
  - @tapflowio/android-agent@0.3.1
  - @tapflowio/relay@0.3.1

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
  - @tapflowio/ios-agent@0.3.0
  - @tapflowio/android-agent@0.3.0
  - @tapflowio/relay@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [306d859]
  - @tapflowio/relay@0.2.2
  - @tapflowio/android-agent@0.2.2
  - @tapflowio/ios-agent@0.2.2
  - @tapflowio/agent-core@0.2.2

## 0.2.1

### Patch Changes

- fix: WebSocket backpressure, Android pinch via scrcpy multi-touch, dashboard skeleton visibility
- Updated dependencies
  - @tapflowio/agent-core@0.2.1
  - @tapflowio/relay@0.2.1
  - @tapflowio/ios-agent@0.2.1
  - @tapflowio/android-agent@0.2.1

## 0.2.0

### Minor Changes

- Add typed errors, CLI install banner, and dashboard toast feedback

  - **typed errors** (`agent-core`): `ValidationError`, `PlatformError`, `AuthError` exported from `@tapflowio/agent-core`; key runtime throw sites updated for typed `instanceof` handling (#63)
  - **CLI install banner**: `postinstall` prints success banner after global npm install (suppressed in CI / non-TTY / local workspace); `tapflow` with no args shows version banner and quick-start commands (#90)
  - **dashboard toast feedback**: sonner toasts on all key mutation flows — token create/revoke/copy, workspace/profile/password/app settings, app creation, build upload; `confirm()` replaced with `AlertDialog`; `toast.promise` for upload progress (#91)

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.2.0
  - @tapflowio/ios-agent@0.2.0
  - @tapflowio/android-agent@0.2.0
  - @tapflowio/relay@0.2.0

## 0.1.0

### Patch Changes

- a27f220: fix(ci): use --tag alpha for changeset publish in pre mode
- f13bd85: **Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

  If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.

- Updated dependencies [f13bd85]
  - @tapflowio/relay@0.1.0
  - @tapflowio/android-agent@0.1.0
  - @tapflowio/ios-agent@0.1.0
  - @tapflowio/agent-core@0.1.0

## 0.1.0-alpha.8

### Patch Changes

- fix(ci): use --tag alpha for changeset publish in pre mode
  - @tapflowio/agent-core@0.1.0-alpha.8
  - @tapflowio/ios-agent@0.1.0-alpha.8
  - @tapflowio/android-agent@0.1.0-alpha.8
  - @tapflowio/relay@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- f13bd85: **Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

  If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.

- Updated dependencies [f13bd85]
  - @tapflowio/relay@0.1.0-alpha.7
  - @tapflowio/android-agent@0.1.0-alpha.7
  - @tapflowio/ios-agent@0.1.0-alpha.7
  - @tapflowio/agent-core@0.1.0-alpha.7

## 0.1.0-alpha.2

### Patch Changes

- fix(release): correct build filter name for CLI package and add npm README thumbnail
  - @tapflowio/agent-core@0.1.0-alpha.2
  - @tapflowio/ios-agent@0.1.0-alpha.2
  - @tapflowio/android-agent@0.1.0-alpha.2
  - @tapflowio/relay@0.1.0-alpha.2
