# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **An in-flight `device:boot` fails fast when its session rebounds instead of burning its full deadline.** The rebinding agent never saw the parked boot, so it can never be answered. The failure carries the rebound cause and reads as environmental; every other in-flight request keeps waiting for its reply on the new socket, and a boot issued after the rebound restores the binding as before.

- **`tapflow flow run --session` points at where a session id can be found.** Its help and the error for a `--device` name matching more than one device said to look in `tapflow status`, which prints no session ids. Both now name the MCP server's `list_devices`.

- **`POST /api/v1/comments` accepts a PAT with the `builds:write` scope.** The CI step in the Build Distribution guide that posts branch and commit info as a comment got a 401, because the route accepted only the dashboard cookie, and failed the job under `curl -sf`. It now works with the same token that uploaded the build; a token without `builds:write` gets a 403.

- **A comment the database refuses no longer takes the relay down.** `POST /api/v1/comments` with an unknown `build_id`, or from a browser whose user an Admin had removed, failed a foreign-key check where nothing caught it, and a relay started with the `tapflow` CLI exited. An unknown build now answers 404, anything else 500.

## [0.24.0] - 2026-09-26

### Breaking Changes

- **`tapflow init` writes to this machine's install directory, not the current one.** It is `~/.tapflow` by default, so `tapflow init` from a fresh directory no longer leaves a `tapflow.config.json` in it. Every command resolves the same install: `TAPFLOW_HOME` when set, the current directory when it already holds an install (a `tapflow.config.json`, or a `.tapflow/data` or `.tapflow-data` with data in it), and `~/.tapflow` otherwise — so an existing install keeps running exactly where it is, with its data untouched. Migrate: to keep a per-directory install, set `TAPFLOW_HOME=<dir>` for the commands that use it, in your shell profile or the service environment; the systemd and Docker examples in the docs now do.

- **`tapflow migrate data-dir` refuses while the relay is running.** Moving the data under a running relay left anything uploaded afterwards in a recreated `.tapflow-data/`, outside the data the relay reads after a restart, and the next migrate stopped on two directories. The command now checks the relay's port (`local.port` or `TAPFLOW_PORT`) and exits 1 without moving anything when something is listening there. A relay started on another port with `tapflow relay start --port` is not detected. Migrate: stop the relay before running it, in a script as well as by hand.

- **Re-running `tapflow init` on a configured install exits 0 instead of 1.** It keeps the configuration and refreshes only the tapflow section of `AGENTS.md`, which is how an existing install picks that up. `--force` still writes a fresh configuration, and `--tunnel` without it now stops rather than ignoring the flag. Migrate: a script that relied on the failure to detect an existing configuration should test for the file, or use `--force` when it means to overwrite.


### Added

- **Lean mode makes iOS simulators and Android emulators lighter.** Set `"agent": { "lean": true }` in `tapflow.config.json`, or answer On when `tapflow init` asks (on a Mac, or wherever adb is installed), and the agent turns off a fixed list of background services on each simulator it boots: Siri and Apple Intelligence background work, iCloud Keychain and backup, the Health app and HomeKit, photo analysis, Screen Time, iMessage and FaceTime, Continuity and telemetry among them. Measured on iOS 27, a simulator uses about a quarter less memory, roughly 0.5 GB, so a Mac holds more of them before it swaps. Wallpaper, widgets and the services apps commonly call — push, StoreKit, CloudKit, HealthKit, the photo picker, universal links and more — stay on; if an app under test needs one on the list, leave Lean mode off. The agent puts everything back when it shuts the simulator down, so the same simulator opened from Xcode is untouched. Off by default; iOS 18.5 or later. On Android emulators it keeps four bundled Google apps disabled instead — the Google app, YouTube, YouTube Music and Digital Wellbeing — which measured about 350 MB, just under a fifth, less memory on API 34; the emulator only returns memory when it exits, so the apps stay disabled while Lean mode is on and the saving starts from an emulator's second boot through tapflow, and they come back at the next boot once it is off. `TAPFLOW_LEAN=on|off` overrides the file. `tapflow doctor ios` reports how many simulators are lean, and `tapflow doctor android` shows the setting.

- **`tapflow init` writes the documentation a coding agent needs.** In the install directory it creates an `AGENTS.md` with a tapflow section between `<!-- tapflow:begin -->` and `<!-- tapflow:end -->`, and — when that directory is tapflow's own — a `CLAUDE.md` containing `@AGENTS.md`. The section points at the documentation index rather than repeating it, says how to read any page as markdown, names the files holding this install's secrets, and tells the agent to compare `tapflow --version` against the changelog, because the site follows the latest source. Open an agent in `~/.tapflow` and it can read your configuration and run `tapflow doctor`, `status` and `logs` as well. Anything you write outside the markers is kept; running `init` again replaces only what is between them. In a directory that is also something else — an app repository an older install lives in — no `CLAUDE.md` is written, because one would stop Claude Code reading that repository's other `AGENTS.md` files.

- **`tapflow migrate` runs every migration this install still needs.** With no subcommand it checks each migration and lists the ones that apply: `data-dir` when the install has a `.tapflow-data/` with data in it, and `net-filter` when the iOS network filter is installed but older than this release or not filtering. A Mac that never installed the filter is left alone, because the filter is optional. In a terminal it asks once; without one it runs the list, as each subcommand already does. The first failure stops the rest with exit 1. When both `.tapflow-data/` and `.tapflow/data/` exist, `data-dir` is reported and skipped rather than run into the same refusal every time. `tapflow migrate data-dir` and `tapflow migrate net-filter` are unchanged.

- **`TAPFLOW_HOME` names the install directory**, for a server, a second install, or a CI job. `TAPFLOW_HOME=/var/lib/tapflow tapflow init` creates it, and every command carrying the variable uses it. A value naming a directory that does not exist stops any command that runs or reaches the relay, instead of quietly starting an empty install elsewhere.

### Changed

- **The App Center remembers which releases you opened or closed**, per app and per browser. Every visit used to open only the newest release, so an app with many versions had to be unfolded again each time. Only what you toggled is stored, and a release you never touched follows that default: a version uploaded since your last visit arrives open, and one you collapsed stays collapsed.

- **`tapflow flow run` exits 2 when every failed flow failed environmentally** ([#543](https://github.com/jo-duchan/tapflow/issues/543)). A refused input with an environmental reason, a session lost to an agent restart, or a dropped relay connection used to reach CI as exit 1, reading as a product regression on dashboards that rely on the 1-vs-2 distinction. Selector, assertion and other product failures still exit 1, successful runs still exit 0, and a run with both kinds keeps exit 1 so a real regression is never masked by a blip.

- **The dashboard is built with the React Compiler.** It memoises what React would otherwise recompute on every render, in place of the hand-written `useCallback` and `useMemo` that were doing part of that by hand — 62 of the first and 3 of the second, against no memoised components at all. 158 functions are compiled and 15 are skipped, which is safe: a function the compiler cannot prove is left exactly as it was. Fourteen of those 15 are a shape the compiler does not lower yet, nine of them `try`/`catch`; the fifteenth is an internal compiler invariant. None is anything this codebase is doing wrong. The first load grows 3,810 B compressed, since the memoisation is code. No behaviour change is intended — the compiler only memoises — and the dashboard's test suite runs against the compiled output rather than beside it.

### Fixed

- **The setup page tells a browser on another machine where to create the first account** ([#850](https://github.com/jo-duchan/tapflow/issues/850)), instead of showing a form it would refuse. Only the relay host can create it, and the refusal used to arrive after the email and both passwords were typed in. The page now says to run `tapflow admin init` on the relay host, or, for the Docker image, to set `TAPFLOW_ADMIN_EMAIL` and `TAPFLOW_ADMIN_PASSWORD`. `GET /api/v1/auth/status` gains a `canInitialize` field for it.

- **Android screenshots of photo-heavy screens no longer fail with "stdout maxBuffer length exceeded"** ([#842](https://github.com/jo-duchan/tapflow/issues/842)). The agent captured them through Node's `execFile`, whose stdout buffer is 1 MiB unless set, so a 1080×2424 PNG with photos in it was rejected before it left the Mac while a flatter screen of the same size went through. `adb` output may now be 64 MiB, for the screenshot and for the `uiautomator dump` behind the accessibility tree.

- **The comment panel says when its comments could not be loaded** ([#845](https://github.com/jo-duchan/tapflow/issues/845)), instead of "No comments yet". It was the one list the move to a shared query cache missed.

- **Dashboard lists say when they could not be loaded** ([#845](https://github.com/jo-duchan/tapflow/issues/845)). Tokens and Team settings took a failed response for their rows and broke. Recordings showed a failure as "No recordings yet", and Tokens showed "No tokens yet" while still loading. Each list now says it is loading, says it failed and offers to try again, or says it is empty. Saving the workspace name or logo updates the sidebar without a reload. Signing out clears what the dashboard had cached, so the next person to sign in on that browser never sees the last one's user, apps or tokens. An invite or password-reset link with no token shows as expired at once, not after a blank screen.

- **Changing a build's status under a status filter no longer drops focus to the top of the App Center** ([#833](https://github.com/jo-duchan/tapflow/issues/833)). When the new status was one the filter hides, the refetch removed the row along with the control that had focus. Focus now moves to the next build in the release, or the previous one, or the neighbouring release's header, and that control says why the build disappeared. If the list empties, focus goes to the search box as before. A change the server refuses moves nothing.
- **Four more App Center accessibility gaps** ([#834](https://github.com/jo-duchan/tapflow/issues/834)):
  - After a retry, the first release is announced in its actual state from the start. It used to be announced collapsed and then report its own expansion.
  - Release headers are headings, so a screen reader can move between releases.
  - Scheduling or cancelling a deletion is announced with the build and when it will be deleted, where before only the icon changed.
  - Every control on a build row names its build. The deletion icons were all called "Schedule deletion", so voice control could not pick one row's button, and their tooltip appeared only on hover; it now shows on keyboard focus too.

- **Builds still install after their data directory moves** ([#836](https://github.com/jo-duchan/tapflow/issues/836)). The relay stored each build's full path, so after `tapflow migrate data-dir`, or after copying an install to another disk, every build uploaded before the move failed to install with "The relay cannot read this build file". Expired builds were dropped from the list with their files left on disk. The relay now looks for the file in its current `uploads/builds/` first and falls back to the stored path, for installs and for the expiry purge. Nothing in the database is rewritten.

- **`tapflow migrate data-dir` no longer leaves the config and the data disagreeing.** It moved the directory and then rewrote `tapflow.config.json`, so a config it could not write left the data moved, the config naming the old directory, and a stack trace. The config is now rewritten first and put back if the move fails; if it cannot be put back, the command says what to set it to.

- **No tapflow command leaves a `jwt-secret` behind any more.** Every one of them wrote one into whatever directory it ran in — `tapflow --version` in a repository, `tapflow flow run` in CI, `tapflow agent start` on a Mac that never runs a relay — because the relay created the secret as its configuration module loaded and the CLI loads every command at startup. The relay creates it when it starts now, so the file appears where an install actually runs and nowhere else.

- **A relative path in `tapflow.config.json` is read from beside the file**, the way `tsconfig.json` and `litestream.yml` read theirs, rather than from the directory a command was run in. `local.dataDir` and the `tls` certificate paths of an install started from elsewhere used to resolve against that other directory and come up empty or missing.

- **Keyboard and screen-reader focus survives the App Center's list being replaced** ([#829](https://github.com/jo-duchan/tapflow/issues/829)). When a search's answer failed while focus was inside the build list — reachable by tabbing into a row before the search settled — the list was replaced by its failure state and focus fell to the top of the page, with nothing said about where it went. A retry that succeeded did the same in reverse, and so did the list emptying out under the caret. Focus now moves to the first control in what replaced it — "Try again", or the first release — or to the search box when there is none, and only when replacing the view is what removed it, so a failed first load does not take focus and someone typing in the search box keeps it. Wherever focus lands says what happened — that the load failed, that the list is loading or nothing matches, or that the retry worked. A failed search that is fetched again in the background, on returning to the tab, now keeps its failure on screen with "Trying…" until the answer arrives, instead of briefly showing the previous search's builds and dropping focus to the top of the page — only a failure that was on screen, so returning to a search that failed minutes ago loads it normally; "Trying…" keeps focus and still looks unavailable while it runs. Closing a build's "Schedule deletion" dialog now returns focus to the button that opened it, where it used to fall to the top of the page as well, and each release header now says whether it is open.

- **Switching apps in the App Center no longer flashes "No builds yet".** The page cleared the list the moment you clicked, before asking the server anything, so for one frame an app nobody had fetched yet looked like an app with nothing in it — one click showed the list, that message, "Loading…", and then the new list. The list you were looking at now stays until the new one arrives, with the release you had open still open. Two faults with the same cause go with it: a slow answer for one app could paint its builds under a different app you had since selected, and a failed request was shown as "No builds yet", so an unreachable relay and an app with no builds looked identical — a relay that answered with an error at all, rather than not answering, was not even distinguishable to the page. A failure now says so in the same shape as the empty state, with a button to try again.

- **Form fields no longer report an error when you leave them without typing.** Every dashboard form validated on blur whether or not anything had been entered, so leaving a field you had not touched showed a validation message before you had done anything. Opening a dialog was enough on its own: it focuses its first control, so the next pointer move anywhere else triggered the message — and there it also cost the first click on Close: the message enters the layout, what is below it moves, and a `click` needs its press and release on the same element. Validation now runs on submit and corrects as you type from then on. Each message now has an id its field points at and sits in a region a screen reader is already watching, so it is heard as well as seen. Eight fields that reported the validation library's own developer text — "Too small: expected string to have >=8 characters" — now say what they mean. Sign-in, first-run setup, invitation, password reset, and the team, token and settings forms.

## [0.23.0] - 2026-09-21

### Breaking Changes

- **`tapflow setup` exits 1 when it says `SETUP INCOMPLETE`.** It returned 0 whatever the banner said, so `tapflow setup ios && tapflow agent start`, a provisioning run or a Makefile carried on against a Mac that was not set up. It is stricter than `tapflow doctor`, which passes a check that only warns: the two answer different questions, one whether the Mac is usable and one whether the work got done. Steps that report a note while still being fine, such as the audio permission on a run that cannot ask, do not count; declining an install at a prompt does. The network filter is the exception, because it is an optional feature rather than part of a working Mac: declining it leaves the run complete, while a run that could never ask — a non-interactive one — reports it as pending and exits 1. Migrate: use `;` or `|| true` where a script relied on `&&` continuing, or `|| true` on the line itself under `set -e`.

- **Clients that reach the relay through a tunnel now have to authenticate.** A rathole tunnel, and `tailscale serve` pointed at the relay port, delivered their traffic to the relay from the relay's own machine, which the relay treats as local. Browsers were signing in anyway and are unaffected. An agent or tool that connects through the tunnel URL without a token is now refused, as it already was from anywhere else. Migrate: pass an `agent`-scope token (`--token` or `TAPFLOW_AGENT_TOKEN`), or a `view` token for flows and MCP. If you run `tailscale serve 4000`, run `tailscale serve reset`, then `tailscale serve --bg 4001`.

### Added

- **[tapflow.dev](https://www.tapflow.dev) is readable by an LLM agent.** `llms.txt` listed 18 of the 28 English pages, and every link in it led to HTML only — an agent following one had to strip the site's navigation back off to reach the prose, and could not know that the flow reference, network control or `tapflow setup` pages existed. Every page is now also served as its source markdown at the same URL with a `.md` suffix (Korean included, under `/ko/`), all the English pages concatenated are at [llms-full.txt](https://www.tapflow.dev/llms-full.txt), and the index lists all 27 of them. Links across the site, the sitemap and the social metadata now name the canonical `www` origin rather than the apex, which answered every one of them with a redirect.

- **Foldables can be folded from the browser** ([#797](https://github.com/jo-duchan/tapflow/issues/797)). A device whose screens rearrange now reports the postures it offers, and the toolbar shows a control that moves between them — Folded, Rear display, Half open, Unfolded on a Pixel 9 Pro Fold. The device frame follows the screen when it changes, because the agent re-sends it rather than describing the screen it had at boot, and folding keeps the orientation you were already in. Taps land where you press them in either posture — folded, the emulator still scales injected touch pixels by the unfolded panel's size, so the divisor now comes from the emulator rather than from the screen the guest reports. A session starts unfolded and upright instead of inheriting the posture and rotation the previous one left behind. Screenshots and recordings save what is on screen rather than the frame behind it: the emulator captures a foldable's panel in its own fixed orientation, so an unfolded device came out landscape in the file while being portrait in the browser, and a recording that spans a fold is letterboxed rather than stretched. Posture names and labels come from the platform's own agent, so a device that folds differently needs no change in the relay or the dashboard.

- **`TAPFLOW_TUNNEL_PORT` (`local.tunnelPort`)** sets the loopback-only port that tunnel clients connect to. `tapflow start` and `tapflow relay start` open it on `4001` whenever a `tunnel` is configured, or on `4002` when the relay itself runs on 4001. The Docker image and any other way of running the relay open it only when this names a port, which is what a `cloudflared` sidecar or a same-host proxy needs. See [Configuration](https://www.tapflow.dev/reference/configuration).

### Changed

- **The network filter install says what it is waiting on** ([#799](https://github.com/jo-duchan/tapflow/issues/799)). `tapflow setup ios` and `tapflow migrate net-filter` printed nothing while the install ran — up to three minutes on a new Mac, which reads as a hang rather than as work. Each step now names itself as it starts: checking what the Mac already has, taking the current filter out of the path, copying, activating, and confirming a filter came back up. The activation step warns about the macOS approval prompt before it appears, since the host binary reports that only by exiting 120 seconds later. `setup ios` reports the first check on the path where it goes on to *skip* the install as well — the common case on a Mac that is already set up, and the half of the silence nothing inside the installer could reach.

- **Approving the network filter finishes the install in the same run** ([#799](https://github.com/jo-duchan/tapflow/issues/799)). When the install stopped waiting for macOS approval, `tapflow migrate net-filter` and `tapflow setup ios` printed where to approve it and exited with the filter switched off, so even an approval given straight away needed a second run. In an interactive terminal, on a Mac with no approved tapflow extension, they now ask before installing whether to open the approval screen, and open it as soon as macOS starts waiting. macOS's own prompt highlights OK, which closes it without approving, and it does not appear at all on a rerun, so that screen is what gets people there. Unless that offer is declined, an approval that takes longer than the host's two minutes is still followed through: the command waits up to two more minutes for the switch and turns the filter on, offering the screen at that point if it had not already. The question says a yes ends with the Mac's open connections possibly dropping, SSH included, and when the command switches the filter on itself it declines to do so over a simulator started while it waited, saying whether the filter is off when it does. Without an interactive terminal, or when the offer is declined, the banner now says to run the command again instead of pointing at `doctor`.

- **Runtime dependencies moved up within their major lines.** React 19.2.8 → 19.3.0 and `react-hook-form` 7.87 → 7.88 in the dashboard the relay serves, `zod` 4.5.4 → 4.6.5 in every package that validates a wire message, `@clack/prompts` 1.7.0 → 1.8.1 in the CLI, `yaml` 2.6 → 2.9.1 in the flow runner, and `lucide-react` 1.41 → 1.45. Nothing a self-hoster configures changed; the entry is here because dependency updates arrive as bot pull requests, which the changeset gate does not apply to, so this file is the only place that records them.

### Fixed

- **`tapflow setup` no longer exits 0 without finishing when stdin is empty** ([#807](https://github.com/jo-duchan/tapflow/issues/807)). Every prompt in setup decided whether it could ask by reading `stdout` alone, so a run whose output is a terminal but whose input is not — `tapflow setup ios </dev/null`, or a wrapper that leaves stdin closed — drew the question and then waited on a promise that never settles. The process left the event loop and exited 0 with no results list and no `SETUP INCOMPLETE` banner, and every step after the one that asked never ran. A Mac that is already set up reached it at the audio-permission step, which is offered on every macOS 14.2+ run, so the network filter install behind it was skipped in silence. A session now counts as interactive only when both ends are a terminal — the rule the filter's own approval prompt already used — and `tapflow init` and `tapflow admin init` read the same one. `admin init` is where self-hosting sends headless servers, and it had the same unguarded prompts: it used to exit 0 having created no account, and now says a terminal is required and exits 1. Two consequences: answers piped into stdin (`yes | tapflow setup android`) no longer reach the prompts — an idiom that was never whole, since clack answers only the first question from a pipe and then never settles again — and a pty on both ends with nobody holding the other end (`ssh -tt … </dev/null`, `docker run -t` without `-i`) is unchanged, because on the file descriptors it is identical to a person who has not typed yet.

- **The documentation site no longer publishes its own contributor rules.** `docs/AGENTS.md` and `docs/CLAUDE.md` — conventions for working on the VitePress site — were built into the public site and took the first two entries of the sitemap, so a crawler or an agent surveying the documentation met them before the product.

- **Taps land where you press them on a rotated Android display** ([#797](https://github.com/jo-duchan/tapflow/issues/797)). An unfolded foldable runs rotated — a Pixel 9 Pro Fold reports a natural 2076x2152 while its live display is 2152x2076 — and the emulator's input takes coordinates in the natural orientation while the browser normalises against the rotated picture it shows. Nothing bridged the two, so every tap landed 90° counter-clockwise from the finger, before any folding. The agent now maps input through the rotation the emulator reports per frame. Ordinary phones are unaffected: they run unrotated, where the map is the identity.

- **Removing the network extension is described in steps that work** ([#799](https://github.com/jo-duchan/tapflow/issues/799)). `tapflow doctor ios`, `tapflow setup ios`, `tapflow migrate net-filter` and the network control and troubleshooting guides all said to run `systemextensionsctl uninstall`, which macOS refuses whenever System Integrity Protection is on, as it is on almost every Mac. They now say to switch the filter off first, then remove the extension in System Settings → General → Login Items & Extensions → Network Extensions, then restart the Mac to finish. The guide also says to stop tapflow on that Mac first, since a running iOS agent switches the filter back on. When the app is already gone from `/Applications`, the commands print the exact switch-off command, which uses the binary inside the package.

- **Member password-reset emails now use the configured public URL.** The reset endpoint previously constructed its link from the request's `Host` and `X-Forwarded-Proto` headers, which a proxy can pass through from an untrusted request. It now uses the same configured URL selection as invitations: public tunnel URL first, then the configured relay URL, then the local fallback.

### Security

- **Visitors of a tunnel URL no longer skip sign-in.** The rathole tunnel handed every public connection to the relay from `127.0.0.1`, and `tailscale serve 4000` did the same for tailnet members. The relay does not ask local connections to sign in, so device control and agent registration were open to anyone who had the URL. `TAPFLOW_TRUSTED_PROXIES` could not close this, because rathole forwards raw TCP and adds no header. The relay now opens a separate loopback-only tunnel port, and nothing that arrives there counts as local. `tapflow start` and `tapflow relay start` point rathole at that port and refuse to start when it is taken. They warn when `tailscale serve` still forwards to the relay port, and when `tailscaled` runs in userspace-networking mode, where no port can tell tailnet visitors apart. They also stop rathole clients left running by a tapflow process that exited without cleaning up. On a relay with no admin yet, they say to create the admin on the relay's machine, because setup is refused through the tunnel.

## [0.22.0] - 2026-09-16

### Added

- **Xcode 27 and macOS 27 are supported** ([#797](https://github.com/jo-duchan/tapflow/issues/797)). Checked on a Mac running macOS 27.0 with Xcode 27.0 as its only Xcode, through the dashboard and against the helpers directly. On an iOS 27.0 simulator: streaming, touch and gestures, hardware buttons, rotation, keyboard input including Korean composition, device bezels, the UI tree the MCP server and flows read, and taking the device off the network. On an iOS 26.5 runtime under the same Xcode, which is where most people are right after upgrading: touch, buttons, streaming and network control. Android emulators on that Mac boot, stream and take input as before, and Xcode 26 keeps working unchanged. [Requirements](https://www.tapflow.dev/guide/requirements) now lists both versions. The fixes this took are listed under Fixed below; installing and approving the network extension on a new Mac still has rough edges, tracked in [#799](https://github.com/jo-duchan/tapflow/issues/799).

### Fixed

- **Taking an iOS simulator offline no longer fails on the first press with "This Mac is not set up"** ([#797](https://github.com/jo-duchan/tapflow/issues/797)). The agent asked the network filter what it was holding right after changing it, once, and could hear the rule from before the change; the press was refused and the control said the Mac was not set up until a later toggle went through. On a macOS 27 Mac that was nearly every first offline press, and the first press on a device left running while the filter was switched off. It now asks again for up to three seconds before refusing.

- **The iOS helpers find SimulatorKit where Xcode 27 moved it** ([#797](https://github.com/jo-duchan/tapflow/issues/797)). Xcode 27 moved `SimulatorKit.framework` from `Contents/Developer/Library/PrivateFrameworks/` to `Contents/SharedFrameworks/`, and the touch and screen-capture helpers knew only the old place: with Xcode 27 alone no input reached the simulator and no stream opened, and with Xcode 27 selected and an older `Xcode*.app` in `/Applications` they fell back to that Xcode's SimulatorKit, untested against Xcode 27's simulator service. Both places are now checked on the selected Xcode first. Every iPad and most iPhones (6s through 13, 14, 14 Plus, SE, 16e, 17e) lost their bezel too, because their frame is drawn from nine slices and Xcode 27 moved the screen size it needs from `profile.plist` to `capabilities.plist`; either file is now read.

- **Invite links, comment links and the agent command use the relay's real address** ([#788](https://github.com/jo-duchan/tapflow/issues/788), [#794](https://github.com/jo-duchan/tapflow/issues/794)). The invite dialog copied your browser's address while the invitation email carried the configured one, so on the Vite dev server or on the relay Mac itself the copied link opened the recipient's own machine. All three now follow `TAPFLOW_RELAY_URL` / `relay.url` when set; with nothing set they keep your browser's address, and a browser on `localhost` gets the relay's LAN address. A Tailscale address that `tapflow start` detects now reaches invitations and CORS instead of only the banner, a tunnel that fails to start no longer leaves its address behind, and the agent command never routes an agent through the tunnel. A relay running in a container without `TAPFLOW_RELAY_URL` warns at startup, the invite dialog stops saying "copied" when the copy failed, and on a plain-HTTP page the invite link and a new token can be selected and copied by keyboard.

- **The Mac Resources charts follow the clock instead of freezing where the page loaded** ([#751](https://github.com/jo-duchan/tapflow/issues/751), [#749](https://github.com/jo-duchan/tapflow/issues/749)). The history was fetched once, so an open page never showed anything newer than when you arrived, and the gap between the last time label and the right edge looked like a skewed axis. The window now advances with time and the history refreshes on a cadence matched to the range (1 minute on 1h/6h, 5 on 24h, 15 on 7d), pausing while the tab is hidden; a failed refresh keeps the chart as it was. Each line now ends in a dot at the Mac's latest report, so it reaches the present instead of stopping up to a minute short, and hovering the dot reads its current value. Time labels sit on local round times rather than UTC ones, which were not round in 45-minute zones and put a 7d label on the wrong date west of Greenwich.

## [0.21.0] - 2026-09-12

### Added

- **Docker is a documented way to run the relay.** The image has been on Docker Hub since 0.20.0 and nothing in the guide said so, so the only way to find it was to guess the name. [Self-Hosting the Relay](https://www.tapflow.dev/guide/self-hosting) now carries a Compose file and the three settings a container needs that a local install does not — each of which fails in a way that does not name its cause.

  **The image is the relay, not tapflow.** It serves the dashboard and brokers traffic; the agents that drive simulators and emulators are macOS-native and stay on your Macs, connecting outbound to the container with an `agent`-scope token. A container on its own streams nothing.

  **Run it on the same Mac or a box on your own network — not on a cloud VM.** Every video and audio frame between an agent and a browser passes through the relay, so a relay outside your network sends app screen data out with it, and the detour costs more latency than a 30fps budget can absorb.

  The three settings: the data volume is required rather than a convenience, because the relay writes a per-install sign-in secret to `<dataDir>/jwt-secret` and anything that *recreates* the container destroys an unmounted one — logging out every user and dropping every agent at once. `TAPFLOW_RELAY_URL` decides what invite links say, and unset they point at `localhost:4000`, which is the recipient's own machine; the relay never reads its address from the `Host` header, because a forged one would turn an invite into a phishing link. `TAPFLOW_ADMIN_EMAIL` and `TAPFLOW_ADMIN_PASSWORD` create the first account, since the interactive setup a local install offers has no terminal to run in.

  The image also gained the toolchain its own fallback assumed: `better-sqlite3` is fetched as a prebuilt binary and compiles from source when that fetch fails, except the builder had no compiler, so the fallback could never run and a failed *download* surfaced as a missing Python. Every published image is now booted in CI on both architectures before its manifest is pushed — the dashboard is fetched, the auth endpoint is asked for its state, a WebSocket is opened, and the container is destroyed and recreated to prove the sign-in secret survived on the volume.

  **And installing a build into it works now**, which it did not when that documentation was written — see the first entry under Fixed. A documented deployment that could stream a device but never install anything onto it would have been worse than no documentation.

### Fixed

- **Installing a build works when the relay is not on the same machine as the agent** — it never did. The relay sent the agent its own filesystem path and the agent opened it, which holds only when the two share a disk. So on the topology the guide recommends — a relay on a LAN box, agents on Macs — every install failed, and a relay in a container failed the same way. **It also failed by blaming the build**: `unzip` said `cannot find or open`, the agent discarded that, and the browser was told to check whether the file was a real simulator archive. It was, every time.

  The relay now mints a single-use credential where it has already established who owns the session, and serves that one build against it. No token gains a permission: an agent still cannot ask for a build it was not told to install, and `tapflow start` — whose agent runs with no token at all — keeps working, which a permissions-based design would have broken. The agent forms the address from the relay URL it is already connected to, not from anything the relay says about itself, because that is the one address known to reach it.

  The three causes a person acts on differently — a damaged archive, a relay that cannot be reached, a transfer cut short — are now three different messages, and the extraction tool's own words ride along. A short transfer is caught against a size that travels with the instruction rather than against `Content-Length`, which a proxy may drop; a check that reads an absent header passes while looking at nothing, and hands on half a file to be reported as a damaged one. Downloads time out instead of hanging, and the Android install path gained the temp-file cleanup it never had. An agent too old to fetch builds installs exactly as before, and the relay notes that once in its log rather than trying to decide whether that agent is elsewhere — it cannot tell, and the check would have been wrong in both directions.

- **Pressing the upper half of Volume Up pressed the Action button on an iPhone.** The tooltip said Action and the press followed it, so a tester reaching for volume changed a setting they never opened. A button's catchment was a fixed radius around its *centre*, and the first button in range won rather than the nearest — on an iPhone 15 Pro the Action button sits close above a much taller Volume Up, so Action's circle covered Volume Up's own pixels and claimed them, because that is the order the agent reports them in. Catchment is now measured to each button's rectangle and the nearest wins, so a press inside a button cannot lose to a neighbour. Targets are as generous as before — the same margin surrounds the button instead of radiating from its middle. Found by hand on a simulator; nothing automated was looking at where these targets actually are.

- **The dashboard is finally compressed on the deployment almost everyone runs** ([#260](https://github.com/jo-duchan/tapflow/issues/260), [#737](https://github.com/jo-duchan/tapflow/issues/737)). tapflow has been building Brotli copies of its dashboard assets for a while, and on a default install they were never sent. Browsers only offer Brotli on a secure origin, and the relay is plain HTTP unless you configure TLS — so over `http://<lan-box>:4000` the browser asks for gzip, the relay had only `.br` on disk, and every asset went out uncompressed. The build now writes `.gz` alongside `.br`, and the relay serves whichever the browser will take, preferring Brotli when both are offered. Nothing is compressed at request time: both files are built once, so this costs no CPU while you are streaming. Content-hashed files under `/assets/` are also marked `immutable` for a year, so a returning tab stops re-fetching them, while `index.html` is marked `no-cache` so an update is picked up on the next load rather than after a hard refresh.

- **android-agent**: Log unexpected scrcpy server process exits with their exit code and signal as warnings, while expected exits from `stop()` log at debug level (#481).

- **Android and iOS now show the same unsupported-streaming status.** When the browser cannot decode the device stream, both viewers now report it through the shared status region instead of Android showing a Korean-only message and iOS showing nothing.

- **A state file anyone could have written no longer confirms the iOS network filter** ([#734](https://github.com/jo-duchan/tapflow/issues/734)). The filter publishes what it is enforcing to a file, and falls back to `/tmp` when its protected directory refuses it. `/tmp` is world-writable, so any local process could write a file there with a current timestamp and a rule naming a device, and since the state file became the confirmation of a rule write the agent would take that simulator offline on its word — the sign-off failure the feature exists to prevent. A state file in a world-writable directory is now believed only when root owns it and nobody else can change it, checked on the file that is then read rather than on the path. The liveness check reads the same way, so a forged file cannot hide a filter that stopped either. The protected path is unaffected, and a refused file is named once in the log.

- **An app that uses Alamofire or Reachability.swift now shows its offline screen when you take an iOS simulator off the network.** Taking a device offline already stopped its traffic, and an app built on `NWPathMonitor` — the modern API — drew its offline state correctly. An app that asks `SCNetworkReachability` instead was never told: it went on reporting a reachable network while every request failed, so the offline screen you came to check never appeared and the traffic being blocked looked like the feature not working. That API is answered now. What made it more than a one-line change is that these libraries do not poll — they register a callback, remember what it last told them, and recompute only when it fires — so tapflow re-fires that callback rather than only changing what a poll would return. Both ways a library can ask for that callback are covered, a dispatch queue and a run loop, and each is re-fired where its owner asked for it rather than wherever tapflow happened to be.

- **Taking an iOS simulator off the network fails its requests in about half a second, instead of hanging for twenty-five.** The filter blocked name resolution along with everything else, and a blocked DNS query returns nothing at all to whoever sent it — no error, no refusal — so the resolver simply waited out its own timeout. A request for a name the simulator had looked up recently failed in six milliseconds; one that needed a fresh lookup took **25 seconds** in a command-line client and left Safari on a blank page past **35**. That is the shape the complaint took: the toggle looked like it had not worked, because nothing on the screen changed for half a minute. Name resolution now passes through, so every request behaves like the fast case — the name resolves and the connection is dropped immediately. Measured after the change: the request now costs whatever the lookup costs — 0.3 to 0.6 seconds across runs, where it used to be 25. Safari's error page arrives in about 2. **Only outbound UDP to port 53 is allowed** — a connection to that same port over TCP stays blocked, because that already failed immediately and opening it would let a device you took offline hold a connection to anything listening there. **Your app is affected too, though less than everything else was**: tapflow refuses name resolution inside the app under test only where the app resolves the POSIX way, and `URLSession` resolves through a path tapflow cannot reach — so it now resolves the name and fails when it connects, where a device with no signal would have failed the lookup itself. An app that treats "the name resolved" as "I am online" will draw an online banner over a device that can reach nothing. What is unambiguously better is everything tapflow cannot reach at all, a web view or another app, which used to hang for half a minute. **Encrypted DNS is not covered**: DNS-over-TLS has a port of its own and could be added, DNS-over-HTTPS cannot be told apart from ordinary web traffic, and neither is included because nothing has yet measured whether a simulator uses them when the Mac is set up that way.

### Security

- `js-yaml` moved to 3.15.2 / 4.3.2 and `hono` to 4.13.7, closing **five Dependabot alerts across four advisories**, and `pnpm.overrides` stayed empty. The two counts differ because GHSA-2883-xcg3-v3hh is raised once for each of `js-yaml`'s affected version lines, 3.x and 4.x — the same shape as alerts #71 and #72 in the previous cycle. The four are GHSA-2883-xcg3-v3hh, GHSA-crvj-82cr-hjcx, GHSA-g6gw-c38x-mqfc and GHSA-gqvv-2mrq-wpjv. **Dependabot reported both as impossible** — `security_update_not_possible`, `latest-resolvable-version: 3.15.1` against a floor of 3.15.2, with `conflicting-dependencies: []` naming nothing that blocked it. Nothing did: `read-yaml-file` declares `^3.6.1`, which admits 3.15.2 freely, and `pnpm update` took all five with a fifteen-line lockfile change and no pin. That is the second time in two cycles that a bump reported as blocked was a lockfile which had never re-evaluated a range that already allowed the patch — see the entry under 0.20.0 below, which says the same thing about the previous `js-yaml` advisory.
- `js-yaml` (GHSA-2883-xcg3-v3hh, `maxTotalMergeKeys` does not limit CPU use for empty merge sources) is a **development dependency only** — it reaches the tree through `@changesets/cli` and `@manypkg/get-packages`, and no published package's production tree contains it.
- `hono` (GHSA-crvj-82cr-hjcx, GHSA-g6gw-c38x-mqfc, GHSA-gqvv-2mrq-wpjv) does sit in a published package's production tree, through `@modelcontextprotocol/sdk` inside `@tapflowio/mcp-server` — **and no hono code runs.** The SDK reaches it from `server/streamableHttp.js`, and tapflow's MCP server imports `server/mcp.js` and `server/stdio.js` and speaks over stdio. Verified by loading each entry point under a resolver hook rather than by reading imports: those two pull in nothing matching `hono`, while `streamableHttp.js` as a control pulls `@hono/node-server` and then `hono/ws`. So this is hygiene, not a hole being closed. It is worth stating plainly because the first attempt to establish it was a source grep for `from 'hono'`, which missed `@hono/node-server` entirely and would have called a first-class SDK export an example.

## [0.20.1] - 2026-09-04

### Changed

- **tapflow no longer pins any transitive dependency.** The `pnpm.overrides` block is empty. Nothing you install changes — every package it named already resolves at or above its security floor without it, checked by resolving the project both ways and comparing. It is mentioned because three of the eight entries had quietly gone out of date: each pinned `fast-uri` up to a version that later advisories moved past, so had any of them taken effect it would have chosen a version that was still affected, while looking, to anyone reading the list, like the matter was handled.

### Fixed

- **A Docker install can create its first account** ([#352](https://github.com/jo-duchan/tapflow/issues/352)). Until now it could not, at all: `POST /api/v1/auth/init` only answers a local client — the check that stops a stranger claiming a public instance before you set a password — and a container is always behind its bridge gateway, so `docker compose up` ended at a login screen nobody could get past. The error text points at `tapflow admin init`, but the image is relay-only by design and carries no CLI to run it. Set `TAPFLOW_ADMIN_EMAIL` and `TAPFLOW_ADMIN_PASSWORD` and the relay creates that first Admin while it boots. They can live in `<dataDir>/.env` instead of your compose file, which keeps the password out of your shell history and inside the volume you already mount — but `chmod 600` it yourself: `tapflow init` creates that file 0600 and the relay-only image has no CLI, so a container operator writes it under their own umask. The relay warns at boot when it is readable by others. It does nothing when an owner already exists, so your account is never replaced and restarts do not repeat it. **A password under 8 characters, or one variable without the other, stops the relay starting** — that only happens on an install with no owner yet, where serving anyway would leave it claimable by anything that reaches loopback, and where there is no working service to lose because nobody can log in either. Nothing changes if you do not set them. **Deploying tapflow with Docker is not documented yet** — there is no Compose file in this repository and no deployment guide, so this removes the wall at the end of that path rather than opening the path.

- **iOS network control keeps working after the filter is upgraded** ([#733](https://github.com/jo-duchan/tapflow/issues/733)). Every release that changes the filter replaces its system extension, and the version being retired holds on to the channel tapflow uses to ask the filter what it is enforcing. The new filter could not claim that channel, so the question went unanswered — while the filter itself was working normally. tapflow read the silence as "not working" and **Take device offline** went unavailable on Macs that had just upgraded, with `tapflow doctor ios` showing every check green. It now asks a second way, reading what the filter publishes about itself, so the control survives the upgrade that used to break it.

- **Upgrading the filter is less likely to interrupt the Mac's network** ([#733](https://github.com/jo-duchan/tapflow/issues/733)). The entry below switches the filter off before activating a replacement, which is what stops the outage it describes — but copying the new app into `/Applications` also makes macOS restart the filter on its own schedule, and that step ran while the filter was still on. It happened to finish 69 milliseconds ahead of the restart, which is a race rather than a margin: a slower disk reorders them. The filter is now switched off before the copy as well. Two other things that made the window longer are gone with it: the filter republishes its state as soon as it changes rather than waiting out an idle timer, and a filter that fails to open its control channel now says so in the log instead of reporting success.

- **Installing the network filter now checks that it came back** ([#725](https://github.com/jo-duchan/tapflow/issues/725)). macOS answers "not refused" rather than "working" when the filter is installed, and the entry below means the command has switched the filter off to replace it safely — so `tapflow migrate net-filter` could report that iOS network control was available over a Mac where nothing was filtering. It waits for a filter to report itself running — one that started after the install, rather than the previous filter's last heartbeat, which stays readable for a few seconds after it dies — and leaves as soon as one does. `tapflow setup ios` does the same. When none appears the command says so and exits non-zero rather than claiming success, and tells you how to take the filter out of the path if new connections on the Mac have stopped.

- **A renewed signing profile or a new Xcode now counts as a changed filter** ([#728](https://github.com/jo-duchan/tapflow/issues/728)). Since the previous entry, the extension keeps its version when nothing about it changed — which means anything the check misses stops being an extra replace and becomes one macOS skips silently, leaving a Mac on the old filter with every version reading correctly. Two things change the shipped extension without any source file moving: the provisioning profile it is signed with, renewed once a year, and the Xcode that builds it. Both are compared now. The build machine's own OS version is deliberately not, because it changes with every macOS point update and would make a software update replace the filter on every Mac.

- **Upgrading tapflow no longer replaces the network filter when the filter did not change** ([#724](https://github.com/jo-duchan/tapflow/issues/724)). Replacing it interrupts every new connection on your Mac while it happens, and until now every tapflow release that touched the filter's tooling at all triggered one — three of the six rebuilds so far changed nothing the extension is built from. The extension now keeps its version unless its own sources changed, so those releases cost a file copy and nothing else. The first rebuild after this change still replaces it once, because the build script itself counts as an input. `tapflow doctor ios` also tells the two apart now: when only the app in `/Applications` is behind it says so and points at `tapflow migrate net-filter`, rather than reporting a healthy filter over a binary the agent is about to call with flags it does not understand. And if the app has been deleted while its extension is still running, tapflow refuses to reinstall rather than guessing — it cannot tell whether what is on that Mac is newer than what it carries, and says which two things will fix it.

- **Replacing the iOS network filter no longer takes your Mac's network down with it** ([#723](https://github.com/jo-duchan/tapflow/issues/723)). The filter sits in front of **every** new connection on the Mac, not only the simulator's — that is how one simulator can be taken offline while nothing else is. `tapflow migrate net-filter` replaced it while that was still switched on, and when a filter stops while it is switched on macOS does not let traffic through unchecked — it blocks all of it, which is the safe choice for a filter and a sudden one for you. New connections failed immediately with `No route to host` rather than hanging. Connections already open kept working, so what you saw was a dead browser next to things that carried on, and a restart looked like the only way out. It was not: `TapflowNetFilter --off` takes the filter out of the path and your traffic returns, and [Troubleshooting](https://tapflow.io/guide/troubleshooting#network-lost-on-replace) now says so. The command switches the filter off before it activates the replacement and back on afterwards, and if it fails partway it tells you the filter is off rather than leaving you to find out. It also **refuses while devices are in use** — booted simulators, attached emulators, or a relay serving on `:4000`, because the person testing through that relay is not necessarily you; `--ignore-running-devices` replaces it anyway. A filter that was switched off is no longer reported as up to date: `tapflow doctor ios` says it is switched off and names the command that turns it back on, and neither `migrate net-filter` nor `setup ios` now treats a stopped filter as nothing to do. So a Mac interrupted midway is repaired by running the command again instead of showing green checks over a control that does not work.

- **The record button no longer drops keyboard focus when a recording stops** ([#624](https://github.com/jo-duchan/tapflow/issues/624)). It was `disabled` while the recording was processed and once it was saved, which takes a focused button out of the tab order — so activating "Stop recording" from the keyboard left the user on the page body, and the name that changed to say what happened was announced to nobody. The button now stays focusable and refuses the click itself, and a live region beside it says when the recording is being processed and when it is saved.

- `MacResources` now has a stable page-level heading, exposes the selected Mac via `aria-current`, and announces each Mac's online/offline state through visually hidden status text; the comment composer's file-attachment errors are announced and tied to the attach button.

- **TLS startup instructions now use the certificate-resolved hostname for remote agent connections** ([#627](https://github.com/jo-duchan/tapflow/issues/627)). HTTP and local fallback paths intentionally retain the host placeholder because an agent running on another Mac must not be directed to `localhost`.

- **The resource charts no longer reserve space for time that has not happened.** The window's right edge was rounded up to the next round tick so the tick labels would stay on clean times, which left up to a full step of axis that no sample can ever reach — an hour of empty chart on the 6h range, and 63 pixels of 504 on 7d. Empty because it is in the future, which reads as a gap in the data rather than as the edge of the window. The window now ends at the moment of the reading and the ticks are counted down from the last round step at or before it, so the labels stay round and the newest sample sits at the right edge. The same strip existed at both ends for a second reason — the plot was padded 16px inside the gridlines that frame it — so the window's own edges are now the grid's edges and the chart is filled from one side to the other.
- **The device viewer no longer draws a box around itself while you type.** Clicking the phone put the browser's focus on the whole viewer, and a focus has to be shown — so a ring appeared around everything at once, the phone and the buttons and the status card, and it came back mid-sentence on the keystrokes you were sending to the device. The viewer no longer takes focus at all. Nothing depended on it: tapflow starts forwarding your keys when you click the screen, not when the browser focuses something, so typing at the phone works exactly as before. The one place that focus was doing real work is kept — restart a device and you are put back on the restart button when it comes back, instead of at the top of the page.

## [0.20.0] - 2026-08-28

### Breaking Changes

- **`AudioStreamCapability` and `hasAudioCapability` are gone from `@tapflowio/agent-core`.** Nothing
  implemented them, nothing called them, and audio was never a detectable capability — it has no
  `AgentCapability` string because nothing gates on it, and the agents stream it through their own
  per-session machinery. An interface declared for a detection nobody performs told a third-party
  platform to do something neither built-in agent does. `Migrate:` if you built a platform against it, drop the
  `implements AudioStreamCapability` clause **and its import** — leaving the import behind is a hard
  error, not a warning. If you *called* `hasAudioCapability`, drop the check: audio was never gated,
  so there is nothing to detect. The frame types are unchanged and still exported —
  `AudioFormat`, `AudioFrame`, `AudioSampleFormat` and `AudioChannels` now come from the package's
  shared types rather than from that file.

### Added

- **Restart a device without leaving the session** ([#628](https://github.com/jo-duchan/tapflow/issues/628)). The network control could tell you to restart the device, and there was no way to do it from the screen you were on — the same is true of the input errors that say a device is not booted. The only route was back to the device list to pick it again, which loses the session. There is now a restart button in the toolbar, last in the group that holds the device's own controls. **It asks first**, because whatever state you had built up on the device does not come back; installed apps and their data do, since this restarts rather than erases — wiping is still the toggle on the device list where a session is being started. If the device does not answer, tapflow says so rather than spinning, and an answer that arrives late still finishes the restart rather than leaving the device switched off.

- **The iOS network filter now comes with tapflow, and one command installs it** ([#647](https://github.com/jo-duchan/tapflow/issues/647)). Taking an iOS simulator off the network needs a small system extension on the Mac that runs the agent, and until now tapflow did not ship it — so the feature worked and nobody outside the project could use it. It now travels inside the agent package: `tapflow setup ios` offers to put it in place on a new machine — it asks first, since a system extension that sees every connection a simulator opens is the last thing that should install unasked — and `tapflow migrate net-filter` does the same for a Mac that is already configured, or one where setup was declined. `tapflow doctor ios` tells you three things rather than one — whether it is installed, whether you have approved it in System Settings, and whether the extension actually running is the one your tapflow carries. That last one is not pedantry: replacing an extension only finishes when the Mac restarts, so the file can be up to date while the old one is still doing the filtering, and that is exactly when the control says your Mac is not set up. **What you are trusting is written down** — the extension is handed every connection the simulator opens before the traffic leaves the Mac, it is signed by the project, nothing leaves your Mac, and the docs say plainly what the signature does and does not prove.

- **Take an iOS simulator off the network, and put it back** ([#607](https://github.com/jo-duchan/tapflow/issues/607)). The counterpart to the Android half above, and it takes three mechanisms rather than one, because a simulator has no radio to switch off — it is processes on your Mac sharing your Mac's network stack. So a host-level filter drops that one simulator's traffic, an injected library tells the app under test its path is unsatisfied, and the status bar stops showing service. Each alone would let you sign off on something untrue: block the traffic without telling the app and the offline banner never appears, tell the app without blocking anything and only the banner is real, change the status bar alone and nothing is. **Only the simulator you toggled is affected** — your Mac keeps working, and so does every other simulator, which is what tells two testers' sessions apart on one machine. **The connections the app is already holding are cut too**, so going offline mid-session behaves like losing signal rather than like a device that keeps talking over the socket it already had. **localhost keeps working**, so a dev build talking to Metro on your Mac, and tapflow's own instrumentation inside the simulator, are untouched. **This needs a signed system extension on the Mac running the agent**, which now ships with tapflow — see the entry above for installing it; until it is installed the control says so instead of failing, and the app under test has to have been launched through tapflow for the app-facing half to work — the control says that too, and says what to do about it.
- **Take an Android device off the network, and put it back** ([#607](https://github.com/jo-duchan/tapflow/issues/607)). Airplane mode, so the emulator is genuinely offline rather than the app being told a story — offline banners appear, retries fail, and cached screens behave the way they will on a real phone in a lift. A device someone left offline is put back on the network when the next session boots it, so you never inherit a colleague's test state.
- **Take a device off the network from the browser** ([#607](https://github.com/jo-duchan/tapflow/issues/607)). A button in the simulator toolbar puts an Android emulator into airplane mode and takes it back out — so the offline banner, the failed retry and the stale cached screen can be seen without touching a terminal. It appears only for an agent that says it can do this, which is why the iOS half above needed no dashboard change of its own. The button has four positions rather than two: a device nobody has heard from yet and one whose report never came are shown differently from each other and from both on and off, because "on the network" is not a safe thing to say about a device nobody has heard from. A device whose network tapflow can no longer change still shows where it is — that is a different thing from not knowing, and the button says which. Neither unsettled position is disabled: clicking is what asks the device. And the toggle moves when the device answers, never when you click, so what is on screen is where the device is rather than where you asked it to go.
- **Reconnecting no longer loses track of whether the device is offline** ([#614](https://github.com/jo-duchan/tapflow/issues/614)). Close the tab, lose Wi-Fi for a moment, or open the session on a second screen, and the relay asks the agent to re-read the device rather than guessing — so the control shows what the device is actually doing instead of whatever it was doing when you first opened it. The relay deliberately does not remember the answer, because airplane mode can be changed by anyone with `adb` and a terminal, and a remembered value would be confidently wrong.
- **Full reset now works on Android.** The toggle wipes the emulator's user data before booting it, the counterpart to erasing a simulator on iOS — so a tester can start from a first-launch state without touching Android Studio. Because the wipe can only be applied while the emulator starts, one that is already running is stopped and started again, which is what iOS does for the same reason; expect the extra boot. If it will not stop — or if tapflow cannot see well enough to tell — the boot fails and says so rather than quietly handing you a device that was never wiped. `-no-snapshot` was already passed on every boot and is **not** this: it skips the saved snapshot and keeps user data, so nothing was being wiped before ([#447](https://github.com/jo-duchan/tapflow/issues/447)).

### Fixed

- **The network control stops asking you to launch an app you already launched** ([#629](https://github.com/jo-duchan/tapflow/issues/629)). Taking an iOS simulator off the network needs a small library loaded into the app under test. If macOS declined to load it — a mismatched architecture, a change in a new Xcode — nothing said so anywhere: the control asked you to launch an app through tapflow, which you had, and went on asking for the rest of the session. It now says that tapflow could not confirm the library loaded — which is what is actually known, since nothing was heard from it — instead of asking again for something you had already done. And `tapflow doctor ios` gained a check that reads what your Xcode provides, so the version of this failure that a new Xcode causes is visible before you start rather than after you have signed something off.

- **Taking one simulator off the network no longer costs the whole Mac a little on every connection** ([#685](https://github.com/jo-duchan/tapflow/issues/685)). The filter that drops a simulator's traffic was working out which process owned every new connection your Mac made — your browser, your mail, everything — including while no device was offline at all, which is most of the time. With nothing to block, that answer could not change anything. It now does no work until a device is actually offline. This is not a speed-up you will feel: measured at roughly five connections a second, it was about 0.2% of one core, and turning the filter off entirely changed nothing observable. It stops because it was work being done for nothing.
- **tapflow can now tell that a simulator's traffic was actually dropped, not just that the filter was told to drop it** ([#654](https://github.com/jo-duchan/tapflow/issues/654)). The filter's status file said which devices it had been asked to block. That is not the same as blocking them — a simulator whose connections cannot be traced back to it keeps talking while the file looks perfect, which is deliberate, because guessing wrong there would cut your own browser. The file now records how many of each device's connections were actually dropped. **Nothing changes on screen**: a count of zero means nothing at all, since a device sitting idle makes no connections to drop, so it is written to the log for whoever is diagnosing rather than shown as a state. Requires reinstalling the network filter — `tapflow migrate net-filter` — and until you do, everything behaves as before.

- **A tapflow agent no longer answers for a device you did not ask about** ([#617](https://github.com/jo-duchan/tapflow/issues/617)). On a Mac running two Android emulators, the entry points that take no session — the ones an embedded caller or a third-party platform would use — resolved the device by whichever the relay registered first. A screenshot could come back from the other emulator, and taking a device off the network could take *somebody else's* off instead, while they were testing on it. They now refuse and say how many they found, which is what the iOS agent has done since the feature shipped. Nothing changes for the browser: every control you touch names its session already.

- **The network button no longer describes a device that is restarting** ([#625](https://github.com/jo-duchan/tapflow/issues/625)). A restart keeps the session, and the control only reset when the session changed — so for the half-minute an emulator takes to come back it kept showing the position from before, while the device was being brought up with the opposite setting. It now waits for the device to say where it is, the way it does on a first boot.
- **The device toolbar's groups mean something, and the same button is in the same place on both platforms** ([#634](https://github.com/jo-duchan/tapflow/issues/634)). The buttons are ordered by what you are doing to the device — move around the app, leave the device in a state, take something out of the session, change the environment around it — and Android's order came from the agent while iOS's came from the browser, which meant a change in one package could rearrange the toolbar in another with nothing to notice.

- **Starting a second tapflow agent no longer puts the first one's devices back online** ([#658](https://github.com/jo-duchan/tapflow/issues/658)). The network filter is shared by the whole Mac, and each agent used to write its entire idea of it — so a second agent starting, which knows of no offline device, wiped the first one's work. Its tester was left watching an offline control over an app that could reach the network fine. Agents now change only the devices they name. `tapflow agent start` also stops rather than starting a second agent for a platform that already has one on that Mac, which is the setup that made this reachable; one agent has always managed every simulator on its machine.

- **A healthy app no longer reports that its network state could not be confirmed** ([#653](https://github.com/jo-duchan/tapflow/issues/653)). The library tapflow injects into the app writes a small file saying whether its hooks took, and it wrote it in place — truncating the file the agent may be reading at that moment. The agent reads it whenever a viewer joins, whenever a device becomes ready and after every toggle, so a read landing inside the write happened on sessions where nothing was wrong, and the control said it could not confirm the state. The file is now written beside its target and renamed onto it, so a reader sees the whole old one or the whole new one.
- **`tapflow doctor ios` reports the injected library, and a missing one stops asking for a pointless reboot** ([#653](https://github.com/jo-duchan/tapflow/issues/653)). The library tapflow injects to tell an app it is offline had no check anywhere, while the filter that cuts the traffic has five. A damaged install was therefore silent in the worst way: macOS ignores an injection path that does not exist without a word, so the app ran unhooked and the control went on asking you to launch an app through tapflow — while the app you launched was running in front of you, for as long as the session lasted. Doctor now names the library, and the control says tapflow could not reach inside the app, which is what happened.

- **A failure to change the status bar no longer fails the whole toggle, and a half-written check no longer reads as a broken app.** Taking an iOS simulator off the network sets three things, and the last of them — the status bar's signal indicator — only reports. If it failed, the whole request failed and said so, on a device whose traffic really had just been cut: you were told the toggle did not work while the app under test was already offline. It is now let go, and the next toggle sets the bar again. Separately, the small file the injected library writes to say whether it took is written a byte at a time, so reading it at the wrong instant gets half a file — which tapflow reported as "this app cannot be told it is offline", a verdict that file cannot support. It now says it could not confirm and to try again, which is what actually resolves it — the file finishes writing a moment later. Telling you to restart the device would have cost the session's app state to fix nothing.
- **The network control now refuses rather than half-working, and tells you when a device came back online behind your back.** Taking an iOS simulator off the network needs three things to happen together, and only one of them actually stops traffic. If that one cannot be applied — the host filter is not installed, not approved, or not running — tapflow used to apply the other two anyway: the app under test was told it had no connection and its open sockets were cut, while every request it made carried on succeeding. You could watch an offline banner appear, tick off "handles no connection", and have tested nothing. It now applies all three or none, and the button says which. **And enforcement can stop after you have already checked something**: if the filter is switched off or crashes while a device is offline, the traffic flows again for a few seconds before macOS brings it back, so you are now interrupted and told that what you checked while it was off needs checking again — rather than being left looking at a control that still says offline.
- **The network button says what to do, and stops offering a retry that cannot work.** Every failure used to arrive under one name, so a device that was merely rebooting was reported as one that will never do this — and the dashboard, unable to trust the name, said only "tapflow can no longer change it" for all of them. Each state now carries its own next step: launch an app through tapflow, restart the device, try again, or go and ask whoever runs the Mac. Where clicking again genuinely might work the button offers it; where it cannot, the button says so in its name instead of leaving the colour to carry it — which is the channel a screen reader does not have.
- **Updating the iOS network filter no longer stops without saying why, and its status file comes back after the filter is switched off and on.** Two separate faults in the system extension that takes a simulator off the network, both of which made tapflow describe itself wrongly. Installing an *update* to the filter would hang and then report a timeout with nothing to explain it — macOS asks the app which version to keep, and the object meant to answer had already been released, so no answer ever came. That failure was investigated three times and written off as having no known cause; it never affected a first install, only a replacement. Separately, the small status file the filter writes — the thing that tells tapflow it is genuinely running — was removed when the filter stopped and then never rewritten, so from the first stop onward the file stayed missing while the filter went on filtering. Nothing read that file until the agent side landed in this same release, so this was never something anyone could have seen. It would have become visible as the opposite of the confusion the file was added to prevent: a device reported as beyond tapflow's control while its traffic really was being dropped.
- **tapflow can now tell when the network filter is not actually running.** Taking an iOS simulator off the network needs a system extension on your Mac, and until now nothing checked that it was still there and doing its job — so if it had been disabled, or had crashed, the control would happily report the device as offline while traffic kept flowing. The filter now leaves a small status file that says what it is enforcing, refreshed every few seconds, and removed when it stops. Also: changing a device's network no longer asks macOS to re-install the extension every single time, which it was doing for what is really just a settings write.
- **The offline banner no longer risks crashing the app you are testing.** When you take a simulator off the network, tapflow re-delivers the app's own network-path handler so the app finds out. That handler was being called on tapflow's thread rather than the one the app asked for — and an app that updates its UI from it was then doing so off the main thread. It now runs where its owner said it should. Cutting the app's open connections got safer too: a descriptor that changes identity while tapflow is deciding about it — or that cannot be identified at all — is now left alone, rather than cut on a verdict about a socket that is already gone.
- **Reconnecting no longer makes tapflow forget which simulator is yours.** When the relay restarts — an upgrade, a dropped Wi-Fi moment, a laptop waking — the agent reconnects and used to lose track of which devices were running. Anything that had to work out *which* device you meant then failed on one that was up in front of you: taking a screenshot, launching an app, reading the UI tree, opening a URL, installing a build. It stayed wrong until you happened to tap the screen or boot something, which on an idle session could be never. Those now ask the simulator instead of trusting a note they had just thrown away — and if you also have a simulator of your own open in Simulator.app, tapflow still knows which one is its, rather than refusing because it can see two.
- **The network button no longer looks broken while it works.** Two problems, both about a control saying the opposite of what it does. Pointing at it repainted it as an ordinary button, so whatever colour it was using to report a state disappeared exactly while you were looking at it. And on iOS, the ordinary opening seconds of a session — the injection in place, no app launched under it yet — were reported as a failure, drawn as if nothing could be done and captioned "tapflow can no longer change it": wrong about the past, since nothing had been armed, and wrong about the present, since clicking really does take the device off the network. That state now says what is actually missing — launch an app so it is told too — while a control tapflow really cannot steer is drawn as unusable whichever way the device is pointing, rather than only when it is online — it used to go faint at offline, which reads as a button you cannot press.
- Relay startup output now advertises the first concrete non-`localhost` DNS SAN from an imported TLS certificate, falling back to a concrete subject CN only when the SAN extension is absent. Certificates with unusable DNS SANs keep the `localhost` fallback and emit a warning; IP-only and malformed certificates fall back without that warning. ([#293](https://github.com/jo-duchan/tapflow/issues/293))
- **Full reset** now appears based on what the device agent says it can do, rather than on which platform you picked. The control was offered for every iOS device and hidden for every Android one, which was right about the agents of the day and wrong about any other combination: an agent older than the feature was still offered a toggle it has no code for, and an Android agent that gains the ability would still have had it hidden — which is the half that landed above in this same release. If you run an agent from before this release against a newer relay, the toggle is now correctly absent instead of erasing nothing — one more reason to upgrade agents and relay together, as 0.19.0 asked.

### Changed

- The dashboard's icon set moved to **lucide-react 1.x** from 0.577 — housekeeping ahead of the network control for [#607](https://github.com/jo-duchan/tapflow/issues/607), which will use an icon lucide added in v1.6.0. Nothing you interact with changes: forty-nine of the fifty icons in use are drawn from identical data, the fiftieth is the book on the sidebar's Docs link and it has been redrawn with rounder corners, and all the JS the dashboard ships grows by 30 bytes.

### Security

- `js-yaml` moved to 3.15.1 / 4.3.1 (GHSA-5p4m-2wfm-xmqj — quadratic CPU consumption resolving `!!omap`), and its two `pnpm.overrides` entries were retired with it. The pin listed under 0.16.0 below no longer exists: the declared ranges had admitted the patch all along, so what held the old version in place was a lockfile that never re-evaluated them, not a range that forbade it. Development dependency only — no published package carries `js-yaml`.
- `shell-quote` and `dompurify` lost their `pnpm.overrides` entries as well, this time with no version change at all: both already sit at the highest floor any advisory for them asks for (1.9.0 and 3.4.13), and neither entry was doing the work. `concurrently` pins `shell-quote` to an exact version, which the key `<1.8.4` never intersected; `mermaid`'s caret on `dompurify` reaches the same release the override named. 0.9.2 below announced a dompurify pin at 3.4.11, raised since without a note of its own — there is now no pin on either package at all. Both are development dependencies of private packages only.
- `@hono/node-server` lost its entry as well, again with no version change, and this is the one that reaches a published package's production tree — through `@modelcontextprotocol/sdk` inside `@tapflowio/mcp-server`. It is also one of the two that pnpm was really consulting: the SDK declares `^1.19.9 || ^2.0.5`, the key `<2.0.5` intersected its 1.x branch, and the replacement `>=2.0.5 <3` therefore withdrew a major line the SDK says it supports. Installing `@tapflowio/mcp-server` from npm was unaffected either way — `pnpm.overrides` does not travel into a published tarball, so a consumer has always resolved the SDK's own range.
- `esbuild` lost the last entry, emptying the block of everything the audit had flagged. It was the other one pnpm consulted — `tsx` declares `~0.28.0` and the key `>=0.27.3 <0.28.1` intersects the bottom of that — but the newest 0.28.x is 0.28.2, so the declared range reaches it unaided. 0.9.0 below announced an esbuild bump to clear advisories; that pin is gone too. **This does not make esbuild clean.** `vite@5.4.21` under vitepress resolves 0.21.5 and `vite@6.4.3` resolves 0.25.12, both inside GHSA-gv7w-rqvm-qjhr, and the retired key never intersected either caret — so nothing about them changed here. They are build tooling, they reach no published package, and moving them means moving vitepress.

## [0.19.0] - 2026-08-19

**The wire answers.** Every request now carries an identifier its reply echoes, every refusal comes back
with a machine-readable reason, and a session belongs to the client that opened it rather than to one of
its sockets. Most of what is listed below is one program: paths where nothing was sent, so whoever asked
found out by waiting.

### Breaking Changes

- **Requires Node.js ≥ 22.** Node 20 reached end of life on 2026-04-30 and no longer receives security
  patches.
  `Migrate:` upgrade the Node on the Mac running the agent and on whatever runs the relay. `nvm install 22`
  or the installer from nodejs.org; `tapflow doctor` reports the version it finds.
- **Update your agents and your relay together.** Requests now carry an identifier the reply echoes, so
  the relay can tell which answer belongs to which request. An agent from before this release does not
  echo it, and the reply is then discarded rather than misattributed — safer, and still a failure: an app
  install started from the dashboard sits on "Installing…" with no Launch control, and a deep link opened
  through `open_url` does nothing. A client newer than its relay has the mirror problem on a refused
  session join, which runs to its deadline instead of saying why.
  `Migrate:` upgrade every device agent to this release at the same time as the relay. Packages are
  versioned together, but nothing installs them together — this is the case where a Mac left on the
  previous agent is the one that breaks.
- **An agent must now send a machine-readable `reason` when it refuses an input.** `input:error` used
  to guarantee only `message`, the human-readable prose each agent writes for itself, while `reason` —
  the closed set a caller actually branches on — was optional. That is backwards: the field you were
  guaranteed was the one you must not depend on. `reason` is required now and `message` is optional.
  Every agent shipped with tapflow already sends one, so no producer here had to change; what this
  affects is a third-party or self-modified agent built against an older contract.
  `Migrate:` add `reason` to every `input:error` your agent sends, choosing from `not-booted`,
  `channel-starting`, `channel-unavailable`, `no-gesture`, `dispatch-failed`, `unsupported` or
  `malformed`. Pick by what the caller should do differently, not by which of your internal states
  produced it — the set is deliberately smaller than any one agent's internals. (`not-session-owner`
  is the eighth member and is the relay's alone: it refuses such a frame at its door, before any agent
  sees it.) Prose stays welcome in `message` and may now be omitted.
- **`@tapflowio/relay` no longer exports `RelayMessage` or `MessageType`.** They were the relay's own
  copy of the wire contract — a flat interface where `type` was the only required member, and a
  hand-maintained list of 63 literals beside it — and they disagreed with `@tapflowio/protocol` about
  the same fields, which is the drift this release closes. Nothing in tapflow imported them; this
  affects code outside it that did.
  `Migrate:` import the message types from `@tapflowio/protocol` instead, which declares one interface
  per message and unions them by direction — `BrowserToRelay`, `AgentToRelay`, `BrowserInbound` and so
  on. A `RelayMessage` used as "any frame on this socket" becomes the union for that socket's
  direction, and narrowing on `type` gives the individual message.

### Changed

- **The relay now checks every message it receives against the contract, and refuses the ones that
  break it.** Every frame is checked for its type, its address and its correlator; a command sent by a
  browser is checked in full, down to its payload. Until now it checked only what it *sent*. A command with a missing payload, an empty
  session id, or a build id that was not a number was forwarded to a device anyway — or answered with a
  reply whose own required field was missing, which every client discards, turning a diagnosis into a
  caller waiting out its deadline. A refused command is now answered where the request has a reply, so
  the caller is told which field was wrong instead of waiting; where it has none, the frame is dropped
  and the log names the field. Well-formed messages are unaffected.
- **A field appended to a browser message no longer reaches a device.** Anything the contract does not
  declare is removed before the relay forwards it on. Messages coming *from* an agent are forwarded
  untouched, so an agent newer than its relay does not lose fields it adds.
- **`@tapflowio/protocol` has a second entry point, `@tapflowio/protocol/validate`.** It holds the
  relay's inbound parser, and it brings the package its first runtime dependency (`zod`). The main
  entry is unchanged — types only, fully erased by `import type`, and it does not reach `zod` — so a
  consumer that imports only `@tapflowio/protocol` gains nothing in its bundle.
- Split stable dashboard vendor dependencies into smaller chunks to reduce maximum bundle size and improve cache reuse across releases.
- **A refused session now says which session it refused and why.** Opening a device someone else already
  has open, or one whose Mac is under load, used to produce a generic failure the dashboard could not
  attribute — with two tabs opening at once it could even be shown against the wrong one. The refusal now
  names the session and carries one of three reasons, so the second tester is told the device is in use
  rather than that something went wrong.

### Fixed

- **A boot that will not finish now says so, instead of letting you wait.** Re-pick a device while the
  first one is still starting, or shut it down mid-boot, and the agent abandoned the earlier boot in
  silence — nothing was sent in either direction, so whoever asked found out by waiting: 30 seconds for an
  MCP caller, two minutes for a flow run, forever for a spinner. An abandoned boot is now answered on its
  own request — superseded by a newer boot, abandoned by a shutdown, or invalidated by the agent losing
  the relay — as long as the agent still has an open connection to answer on; when it does not, the relay
  ends the wait instead by declaring the agent away. A tester sees nothing for the boot they replaced
  themselves, and the failure of the one they are waiting on exactly as before.
- **A slow cold boot is no longer reported as a failure that never happened.** The agents poll a booting
  device for up to 90 seconds (iOS) or 120 (Android) before explaining what went wrong; `mcp-server` gave
  up at 30, inside both, so a device that was simply slow came back as a bare timeout while the
  explanation was on its way. `flow-runner` sat at exactly Android's 120, leaving no room at all. Both now
  wait past the agent. The cost of waiting longer is worth knowing: a wedged relay blocks an MCP caller
  for three minutes rather than 30 seconds, so a host whose own tool timeout is shorter will cut in first
  with a message of its own.
- **Losing the relay mid-boot no longer leaves an Android agent finishing a boot nobody owns.** Both
  agents drop their device state when the connection goes, but a boot already running holds its own
  reference to one; on Android it ran to completion against that, standing up a video stream and
  announcing the device ready for a session that no longer existed.
- **Nobody else can power off a device you are using.** Any signed-in client that knew a session id could
  shut down a colleague's simulator mid-test. The check that stops it could not be added before: the
  browser tab that holds a session and the one that sends the shutdown when you navigate away are
  different connections, so refusing "not the holder" would have refused the tab's own cleanup and left
  devices running. A session now belongs to whoever opened it rather than to one of their connections.
- **A Wi-Fi blip no longer costs you your session.** The relay treated a connection as present until TCP
  or a heartbeat noticed otherwise — up to a minute after a laptop went to sleep — so returning inside
  that window meant being told the device was in use, by yourself. A device whose tester's connection
  died — a sleeping laptop, a dropped network — frees up in at most 45 seconds rather than up to a minute,
  and no longer shows as free while it is still in use: "can I take this?" and the
  "In use" badge read the same signal now.
- **A refused `connect_device` says which of the three refusals it was.** It reported the relay's prose
  alone, so "the device is open in another browser session" and "this Mac is over its resource ceiling"
  arrived as sentences a model had to guess at rather than the closed reason it can act on. A failed
  screenshot or UI-tree query likewise says what is wrong with the *session* now, not only what the relay
  said about the request — so one failing because the agent dropped its device binding no longer reads as a
  bare status code. That is the least useful moment for it, since a screenshot is usually being taken to
  explain a step that already failed.
- **Disconnecting from a session no longer leaves a request hanging for its full deadline.** An AI agent
  that disconnects while a boot is still in flight — ordinary, since tool calls run in parallel — used to
  get a bare timeout thirty seconds later. It fails immediately now and says the disconnect is what ended
  it, while still warning that the request may have reached the device anyway. A worse version of the same
  gap could have reported a boot that never happened as success, after re-joining the same session.
- **A flow run whose device dies stops blaming the selector.** When the agent restarts mid-run its device
  binding is gone, and nothing in a flow can restore it — flows boot once, before the first step. Every
  remaining step used to poll for its full timeout and fail with "no element matched", so a restart three
  steps into a ten-step flow spent eighty seconds pointing at the wrong thing. They now fail as soon as the query does and say the
  session needs booting again. The relay's fifteen-second grace for an agent that may come back is
  untouched: queries keep retrying through it exactly as before.
- **Shutting a device down through an MCP client fails in a second instead of half a minute.**
  `device:shutdown` was the one command from a browser that the relay never answered when it could not
  deliver it — a stale session id or an agent that had gone away produced no reply at all, so
  `shutdown_device` reported "Request timed out" with no cause after 30 seconds. It now says which of the
  two happened. The device list had the other half of the same silence: a row stuck on "Shutting down…"
  with both its buttons hidden for the rest of the page's life.
- **A tester whose browser reconnects lands back in their session instead of being thrown out of it.**
  Re-joining a session the tab already held was refused as "session not found" — for a live session, held
  by that tab, which the device list reported as theirs. The viewer reads that as the agent having
  disconnected, so a two-second Wi-Fi blip ended a session that was fine. Re-joining is now the same as
  joining, cached screen state included.
- **Devices no longer stay booted with nobody watching them.** The relay tracked one session per browser
  connection, but one connection can hold several — an AI agent driving two devices uses a single one. When
  it went away only the most recent session was released; the rest stayed marked in use for as long as the
  relay ran, with no idle timeout, so their simulators kept running. Every session a connection held is
  released now, each with its own timeout.
- **An input that never reached the device was reported as having landed.** Every path that could refuse
  or drop an input — a simulator that is not booted, an input channel still starting, an agent that went
  away, a helper process that died — either said nothing or said success. An LLM driving the device through
  MCP moved on as though the tap had happened; a `tapflow flow` run failed several steps later with
  "selector not found", which is the worst place to lose a cause; and the dashboard showed nothing at all.
  Every one of those now answers, and says which of the two it is: the input was refused, with the reason,
  or it could not be confirmed — which is not the same as saying it did not happen, because an
  acknowledgement can arrive after the wait for it has ended. Repeating an input that did land would
  duplicate it, so the message says to check the device rather than to retry.
- **A reply could be attributed to the wrong request.** Boots, shutdowns, app installs and launches, URL
  opens and input acknowledgements carried nothing tying a reply to the request that asked. Two overlapping
  requests on one session and the first answer settled the wrong one — so a boot that failed could be
  reported as the one that succeeded, and an acknowledgement that arrived late was read as the next input's.
  Each of those now carries a correlator the reply echoes.
- **A dead session hung until the deadline instead of saying so.** When an agent went away mid-command, the
  relay said so on the wire, and the MCP server and flow runner ignored it — an app
  install waited out its full two minutes and reported a timeout. They read those messages now and fail with
  the reason. A device whose agent reconnected is reported as needing a boot rather than as a reset device,
  because the app is still running.
- **An app install could fail with "No devices are booted" on a device that was starting up.** Booting a
  simulator was announced as finished when the command to boot it returned, which is 7.6 seconds before the
  device is actually ready. Anything issued in that window — an install, a launch, an input — hit a device
  that was still coming up. The agent now waits for the device to report itself booted before saying so.
- **A JPEG screenshot could come back as PNG bytes labelled JPEG.** Android always produces PNG whatever is
  asked for, and the label was taken from the request. The MCP server picks its image parser by that label,
  so it measured PNG bytes with a JPEG parser and handed the model a wrong screen size — which the model then
  used as the divisor for every tap coordinate. The format is read from the bytes now.
- **`tapflow flow` reported an environment failure as a product failure.** A step whose input the relay or
  the agent refused failed with the selector error from the next step rather than the refusal, so a CI run
  showed a broken assertion where the device had simply not been reachable.
- The iOS fallback video path emitted PNG frames under a JPEG label. No entrypoint shipped with tapflow
  selects it; it affects a consumer of `@tapflowio/ios-agent` that sets `intervalMs` itself.

- **A scrcpy server process error could take down every Android device the agent manages, not just the one session.** The scrcpy server process spawned for a real-device session had no error handler; an unhandled error on it (e.g. the server process failing to spawn, or a permission error on kill) crashed the whole android-agent process, ending every session it was managing. It's now logged instead.
- `TouchHelper` and `KeyboardHelperDaemon` could leave a wedged helper process running after `stop()` — only `SIGTERM` was sent, with no fallback. Both now escalate to `SIGKILL` after 1s if the process hasn't exited, matching `ScreenCaptureStreamer` and `XCUITreeReader`.

## [0.18.0] - 2026-08-03

### Added

- **Restarting a device agent no longer costs you your place.** Upgrading or restarting an agent used to end every session it held: the tab you had open was sent back to the Mac list, and you navigated back through the app to where you had been. The relay now holds a session for 15 seconds after its agent's connection drops, and an agent that comes back reclaims it — the stream returns on its own with the app still on the screen you left it on, and no reinstall, so nothing you had entered is lost. If the agent does not come back the tab says it is waiting and then says the session ended, instead of showing a picture that quietly stopped updating. `TAPFLOW_AGENT_GRACE_MS` sets the window; `0` turns it off.
- `@tapflowio/protocol`, one place the WebSocket message shapes are declared for the relay, the dashboard and the MCP server. They were three hand-kept copies that had already drifted; a message the relay sends is now a compile error everywhere it is spelled wrong.

### Fixed

- **Full reset erased devices nobody asked to erase, and failed on the ones people did.** The toggle stayed on for the rest of the session, so every later reconnect wiped the simulator again — a Wi-Fi blip was enough. It also failed outright on a device that was already running, which is most of them. It now erases once, when asked, and shuts a running device down first.
- **App install and launch failures reached nobody.** A missing build, an unknown session or an offline agent produced either an error with no session attached or, when the agent was gone, nothing at all — so an MCP caller waited out its timeout and reported a failure with no cause. Every one of those paths now answers immediately, addressed to the session that asked.
- **Commands went to whichever simulator happened to be booted.** With two devices up, an install or a launch could land on the wrong one, and `simctl` picked silently rather than erroring. Each command now names the session's own device.
- The dashboard could report a device as ready with nothing streaming behind it — a simulator someone had left running was announced as live before the agent had done anything with it, leaving a viewer waiting for a first frame that was never coming.
- Booting an iOS device no longer hides `Simulator.app`. The workaround dated from an older Xcode and, on the supported line, only cost a window flash on every boot.

### Changed

- An agent that goes away while you are watching now tells the tab so, and the tab says which of the two it is: waiting for the agent to come back, or the session is over. Both are new messages on the relay-to-browser contract; a viewer that predates them ignores them, as before.
- While an agent is away its devices are not offered on the Mac list, and `tapflow status`, `list_devices` over MCP and flow-runner see the same — a device nobody can reach for the length of the window is not one to hand out.

## [0.17.0] - 2026-07-27

### Added

- **Copy and paste now cross between the dashboard and the device.** Cmd/Ctrl+V sends your clipboard to the simulator or emulator and pastes it there; Cmd/Ctrl+C brings what you copied on the device to your own clipboard in one press. Previously neither direction existed, so accounts, tokens and deep links had to be retyped by hand. Paste works everywhere including plain-HTTP LAN; copy needs the dashboard over HTTPS or localhost, because proving the copy actually landed takes a round trip and no clipboard API available on plain HTTP accepts a value arriving that late — on plain HTTP the copy still reaches the device and the dashboard says why it stopped there. The agent presses the device-side chord itself and confirms the clipboard changed before answering, so a slow device cannot hand back its previous contents as if freshly copied.
- MCP `tap`, `swipe`, `press_key` and `press_button` report what actually happened instead of always reporting success. They were fire-and-forget: against a session whose device was not booted the input was dropped and still answered `{tapped: true}`, which also made parallel test results untrustworthy.

### Fixed

- Cmd/Ctrl+C, +V and +X on Android typed the letter into the app instead of copying, pasting or cutting. The key handler ignored the Ctrl/Meta modifier; a chord is now a command, not text.
- No audio from Android in the dashboard, with the emulator's sound coming out of the agent Mac's speakers instead. The bundled encoder binary lost its executable bit on a fresh install, so the agent fell back from the emulator's gRPC backend to scrcpy — and audio capture and host-mute only exist on the gRPC path. Only visible with the dashboard and the agent on separate Macs.
- iOS sessions silently dropped every tap, swipe and keystroke after an agent reconnect. The input channel was created only during `device:boot`, so a session that came back without one discarded input with no error — and the device looked responsive because screenshots and UI-tree reads travel a different path.

### Changed

- Agents advertise what they implement in `agent:register`, and the relay echoes it to the viewer on `session:joined`. Absent means unsupported, so an agent older than a capability keeps working untouched rather than being probed by timeout.

## [0.16.0] - 2026-07-22

### Added

- Flow selectors gain two optional disambiguators for the object form: `role` narrows by element kind (e.g. `{ label: "New Orders", role: button }` when a button and its inner text share a label), and `index` (0-based) picks the Nth remaining match (e.g. `{ role: cell, index: 2 }` for a label-less, id-less row). Additive — bare-string and `{ id }` / `{ label }` selectors are unchanged; the object form now needs at least one of `id` / `label` / `role`.
- MCP `run_flow` installs the build before replaying when `buildId` is set (parity with `tapflow flow run --build`), so a flow's `clearState` / `launchApp` finds the app present even after a session ended or the app was never installed. Pass `install: false` to skip.
- MCP `shutdown_device` — powers a session's booted simulator/emulator down to free resources or force a cold boot next time. Distinct from `disconnect_device`, which only leaves the session and keeps the device running.

### Fixed

- `tapflow flow run`: wait steps (`tapOn` / `assertVisible` / `assertNotVisible`) no longer fail the instant a ui-tree query throws — e.g. the app not being in the foreground yet right after `launchApp`. The poll loop retries transient query failures (foreground race, idle timeout, network) until the step deadline while failing fast on permanent ones (bad request, auth, missing session), and bounds each query with an abort signal so a stalled response can't block past the deadline. This removes the long-press-as-sleep workaround.

### Security

- Pinned transitive dependencies past their advisories via `pnpm.overrides`: `axios` ≥ 1.18.0 (GHSA-xj6q-8x83-jv6g), `protobufjs` ≥ 7.6.5 (GHSA-j3f2-48v5-ccww), `body-parser` ≥ 2.3.0 (GHSA-v422-hmwv-36x6), and `js-yaml` 4.x ≥ 4.3.0 (GHSA-52cp-r559-cp3m).

## [0.15.0] - 2026-07-20

### Added

- `tapflow migrate data-dir` — a one-shot command that moves a legacy `.tapflow-data/` into the unified `.tapflow/data/` layout: atomic rename (no copy, no data loss), repoints `local.dataDir` in `tapflow.config.json` when it pinned the old default, and updates `.gitignore`. Idempotent; conflicting or cross-filesystem states stop with manual guidance.
- `tapflow setup android` installs Android `build-tools` (pinned `35.0.0`), and `tapflow doctor` gains an `aapt (build-tools)` check — apk metadata extraction needs it.

### Breaking Changes

- `POST /api/v1/builds`: an `.apk` upload that specifies `app_id` is now rejected with `400` whenever the relay can't read the APK's package name (Android build-tools / `aapt` missing, or the APK itself unreadable/corrupt), instead of storing an unversioned build under that app. Migrate: install build-tools on the relay host with `tapflow setup android` (or re-export a valid APK), or omit `app_id` to file the build separately.
- The default relay data directory moved from `.tapflow-data/` to `.tapflow/data/`, unifying all project state under a single `.tapflow/` root (`data/` runtime, `flows/` committed, `artifacts/` screenshots). **Existing installs keep working without action:** a `tapflow.config.json` that pins `local.dataDir` (which older `tapflow init` wrote) is honored as-is, and a config-less default install keeps reading a pre-existing `.tapflow-data/` (with a one-line hint). To unify the layout, run **`tapflow migrate data-dir`** once — it atomically renames `.tapflow-data/` → `.tapflow/data/` (no copy, no data loss), repoints `local.dataDir` when it pinned the old default, and adds the runtime paths to `.gitignore`. Cross-filesystem or conflicting states are reported with manual steps instead of guessing. **Docker:** the image volume moved from `/app/.tapflow-data` to `/app/.tapflow/data` — remount your data volume at the new path.

### Changed

- `tapflow flow run` now writes failure screenshots to `.tapflow/artifacts/` by default (was `.tapflow-data/artifacts/`), matching the `--artifacts` help text.

### Fixed

- relay: an `.apk` whose metadata can't be read is no longer merged into an unrelated app or false-promoted to platform `both`; without `app_id` it is isolated under its own entry. `tapflow doctor` and the relay now share the same `aapt` search paths (`ANDROID_SDK_ROOT` and the Linux SDK path included), so a green doctor no longer masks an upload failure.

## [0.14.0] - 2026-07-09

### Added

- Automated QA axis. `query_ui_tree` (MCP) and `GET /api/v1/sessions/:sessionId/ui-tree` return a unified element schema (`role`/`label`/`identifier`/`frame`/`enabled`) with frames normalized 0–1, so a frame center feeds straight into `tap`. iOS reads the tree via a resident XCUITest runner inside the simulator — window-agnostic (no Simulator.app window, no WebDriverAgent); Android via `uiautomator dump` with a device-side timeout (#133).
- `@tapflowio/flow-runner` (new package) and `tapflow flow run` replay YAML flows with zero LLM calls: a 10-step vocabulary, identifier/label selector resolution, condition-based waits, JUnit reports, failure screenshots, and a CI exit-code contract (0 pass / 1 flow failed / 2 env error).
- `run_flow` (MCP) — an agent authors a flow once, then replays it deterministically over the existing session.
- relay `app:clear-state` — reset app data (Android `pm clear`, iOS data-container wipe).
- `@tapflowio/mcp-server` and `@tapflowio/flow-runner` graduate from the `experimental` dist-tag to the standard npm channel, versioned with the repo-wide fixed group.

### Changed

- Text entry waits for an `input:type-done` ack so a following key press stays correctly ordered. **A self-hosted agent older than v0.14.0 does not send this ack — update the agent and relay together, or text steps will time out.**

### Fixed

- mcp: `type_text`, cross-platform hardware buttons, and input payloads aligned with the agent protocol (#376, #377).

## [0.13.0] - 2026-07-05

### Added

- relay: outbound webhooks for build review-status changes. The relay POSTs to registered URLs when a build's review status transitions to `Done` or `Rejected`, so review outcomes can flow into Slack or the next CI step. Register at runtime via `POST /api/v1/webhooks` (`builds:write` scope) or declare endpoints in `tapflow.config.json` (`webhooks`, with signing secrets read from env vars). Deliveries carry metadata only — never app binaries — and are HMAC-SHA256 signed (`X-Tapflow-Signature`) when a secret is set. Registration blocks loopback and cloud-metadata addresses (#367).

## [0.12.0] - 2026-07-03

### Added

- relay: accept EAS `eas build` iOS simulator artifacts (`.tar.gz` / `.tgz`) as a first-class build upload, alongside `.app.zip` (iOS) and `.apk` (Android). The archive is stored as-is and extracted with `tar` at install time — no re-zip — so the `.app`'s executable bits and symlinks are preserved. Uploads are validated before storage: path traversal (`..`/absolute), symbolic/hard links, corrupt gzip, and gzip bombs (`TAPFLOW_MAX_UNPACKED_BYTES`, default upload cap ×4) are rejected. Expo/EAS teams can now run `eas build → CI → tapflow` and upload the native `.tar.gz` directly, with no CI re-packaging step (#362).

## [0.11.1] - 2026-07-02

### Added

- relay: Docker support and a container image publish workflow, so the relay can be self-hosted as an image instead of only from source (#352).
- docs: add navigation links to the project changelog.

### Changed

- deps: bump the npm minor/patch dependency group (22 updates).

### Fixed

- ios: physical device-frame buttons are confined to the bezel — a tap inside the screen area is no longer hijacked as a button press on devices where a button sits near the edge (e.g. iPhone SE). HID buttons also support press-and-hold via an optional `phase: 'down' | 'up'` on `input:button`; existing single-press clients are unaffected.
- dashboard: use the `TimerOff` icon for the cancel-deletion action.

### Security

- Patch js-yaml to 3.15.0 to address CVE-2026-53550.

## [0.11.0] - 2026-06-29

### Added

- audio: simulator/emulator audio output is streamed to the browser, **on by default** on both iOS and Android (opt out with `TAPFLOW_AUDIO=off`). iOS taps the whole simulator process tree via Core Audio process taps (macOS 14.2+) — app audio, WebKit `WebContent`, and system sounds; Android captures over the emulator's gRPC stream. The agent Mac stays muted so audio goes only to the browser — on Android via a shared mute-only process tap (`@tapflowio/audiotap-helper`, macOS 14.2+; below that, use the Mac's volume). The simulator/emulator's own volume is reflected. (#339, #341)
- docs: add self-hosted relay backup guidance for `.tapflow-data/`, Litestream replication, restore order, and non-database artifacts.

### Changed

- build: migrate the monorepo to TypeScript project references and point each package's `exports.types` at the published `dist/*.d.ts` (was `src/`, which isn't in the npm tarball) so consumers resolve types correctly. typecheck/build run via `tsc -b`. Also extracts the shared macOS process-tap helper into `@tapflowio/audiotap-helper`. (#345)

### Fixed

- android: concurrent emulators now each use their own gRPC port (discovered from the running emulator's `.ini`) instead of a fixed `8554`, which collided and made every session show the first emulator's screen.
- cli: `tapflow setup android` now treats a missing emulator binary or Android system image as a partial SDK and repairs it instead of reporting the SDK as ready.
- cli: `tapflow doctor` now checks whether the default relay port 4000 is already in use and prints the `lsof -ti:4000 | xargs kill` recovery command before `tapflow start` hits `EADDRINUSE`.
- cli: `tapflow setup android` now reminds users to open a new shell when the Android SDK rc block already exists but `adb` is still missing from the live `PATH`; `tapflow doctor` now points to the shell-refresh step instead of looping back to setup.

## [0.10.0] - 2026-06-23

### Added

- builds: deletion is now an explicit, manual action decoupled from review status (#258). Marking a build **Done** no longer schedules it for deletion — `status_label` stays a pure review state and purge keys off a new `delete_after` timestamp instead of `completed_at`. Schedule or cancel via `POST`/`DELETE /api/v1/builds/:id/schedule-deletion`; build payloads now include `delete_after`. Migration 012 grandfathers builds already on the old clock (`delete_after = completed_at + TTL`) so upgrades keep reclaiming disk. The App Center shows a deletion-countdown badge separate from the status column with explicit schedule/cancel controls.
- relay: WebSocket heartbeat (ping/pong, 30s) terminates sockets that miss a pong window, so dead agent/browser/stream connections (Wi-Fi loss, sleep, cable pull) are detected promptly instead of lingering until the TCP timeout — evicting stale sessions and clearing the duplicate "Stale" card.
- ios: `capture-wait` diagnostic metric under `TAPFLOW_STREAM_METRICS=1` — the polling gap between an IOSurface change and when the frame is encoded, emitted per 150-sample window. Capture behavior is unchanged.

### Changed

- cli: `tapflow setup` reports per-step state (found / created / repaired) instead of a binary result, so you can see which prerequisites were already in place versus newly provisioned. Android SDK env registration that was already present is reported as "repaired" rather than "found".
- relay: build-upload validation errors are returned in English, matching the rest of the API (previously the `.app.zip` format, missing-`.app`-directory, and device-only-slice messages were Korean only).

## [0.9.2] - 2026-06-20

### Changed

- cli: unify the stream-quality tier label to "Smooth".

### Fixed

- cli: `tapflow start` now wires TLS like `relay start`, so the all-in-one path can serve HTTPS/WSS for secure-context streaming (Smooth/WebCodecs) to LAN teammates — previously only `relay start` did. The co-located agent trusts the localhost `wss://` cert only (it never leaves the machine); external relays keep full verification.
- cli: include `--token` in the agent connect hint for remote relays.
- agent: prevent display sleep by default (`caffeinate -di`) so the host Mac keeps streaming during a session.
- relay/agents: dedup agent re-register by machine id, removing duplicate "Stale" cards.
- relay: reject in-flight screenshots when an agent is evicted on re-register.
- ios: 16-align downscaled encode dimensions to remove the WASM (tinyh264) green edge on the no-downscale tier.

### Security

- Bump nodemailer to 9.0.1 — the message-level `raw` option bypassed `disableFileAccess`/`disableUrlAccess`, enabling arbitrary file read and full-response SSRF (GHSA-p6gq-j5cr-w38f). relay uses a plain SMTP send path, so real-world exposure was nil.
- Bump undici to 7.28.0 (TLS certificate validation bypass via SOCKS5 ProxyAgent, GHSA-vmh5-mc38-953g) and override dompurify to 3.4.11 (`ALLOWED_ATTR` pollution via `setConfig()`, GHSA-cmwh-pvxp-8882) — both dev/build-only transitive dependencies. Remove an orphaned dashboard lockfile the security graph scanned as a duplicate manifest.

## [0.9.1] - 2026-06-18

### Changed

- relay: every secret can now live in `.tapflow-data/.env`, not just DNS/ACME tokens. The relay loads `.env` before reading its config, so `JWT_SECRET`, the SMTP password, and the tunnel token are picked up from there too. Precedence is shell env > `.env` > config file (a shell variable still overrides the file); `TAPFLOW_DATA_DIR` is the exception since it determines where `.env` lives.

## [0.9.0] - 2026-06-17

### Added

- LAN HTTPS: the relay terminates TLS in-process with automatic certificates — Let's Encrypt via DNS-01 (Cloudflare / Vercel) or bring-your-own — backed by a disk certificate store with automatic renewal. It auto-publishes the detected LAN IP to the configured domain's A record and self-heals it so the HTTPS hostname keeps resolving on the local network. `tapflow init` gains a guided HTTPS setup step; DNS/ACME credentials load from a gitignored `.env` file namespaced under `TAPFLOW_`. This enables WebCodecs-based low-latency streaming, which requires a secure context. Requires Node >= 20.12.0.
- dashboard: a performance-mode indicator in the session info strip shows the active decode path, with a Standard-mode upgrade notice.
- relay: upload size limits are configurable via `TAPFLOW_MAX_BUILD_BYTES` / `TAPFLOW_MAX_COMMENT_BYTES`.

### Changed

- relay: serves brotli-precompressed static assets with immutable caching for faster dashboard loads.
- dashboard: route-level code splitting (`React.lazy`) and a lighter chart stack (visx, replacing recharts) shrink the initial bundle; variable fonts are trimmed to woff2 + latin subsets.
- relay: hardened for public exposure — CORS is restricted to the configured origins instead of `*`, cookie-authenticated state-changing requests need a same-origin / allowlisted origin (lightweight CSRF guard; PAT requests exempt), and invite links are built from the configured base URL instead of the request `Host` header.

### Fixed

- relay: handler exceptions are logged (method, path, stack) instead of silently swallowed, so 5xx failures are diagnosable. Response bodies still return a generic message and PATs are masked.
- relay: robust `Accept-Encoding` negotiation for static assets.

### Security

- Bump esbuild, hono, and other transitive dependencies to clear open Dependabot advisories. Add `.github/dependabot.yml` for weekly grouped updates, excluding semver-major (reviewed manually).

## [0.8.2] - 2026-06-13

### Changed

- relay: a per-install JWT secret is now generated and persisted automatically when `JWT_SECRET` is unset, replacing the shared development default. No action is needed for a single relay; set `JWT_SECRET` only to share one key across multiple instances.
- relay: login attempts are rate-limited with exponential backoff (per IP + account).
- relay: first-time bootstrap (`auth/init`) is restricted to localhost. On headless servers, run `tapflow admin init` on the relay host.

### Added

- relay: `TAPFLOW_TRUSTED_PROXIES` — when the relay runs behind a same-host reverse proxy, set this so it resolves the real client IP from `X-Forwarded-For` instead of treating every proxied client as localhost. Configure the proxy to forward `X-Forwarded-For`.

## [0.8.1] - 2026-06-12

### Changed

- relay: agents connecting from another machine now authenticate with a token. A relay only accepts a remote agent that presents a PAT with the new `agent` scope (create one in Settings → Tokens; pass it via `tapflow agent start --token` or `TAPFLOW_AGENT_TOKEN`). Agents on the same machine as the relay (`localhost`, e.g. `tapflow start`) stay unauthenticated. See [Remote relay authentication](https://github.com/jo-duchan/tapflow/blob/main/docs/guide/agent.md#remote-relay-authentication).
- ios: `tapflow agent start --device` is a relay-exposure filter (which simulators are offered), not a boot target. `connect` no longer pre-boots a simulator — booting stays on-demand via the dashboard.

### Fixed

- relay: restore remote agent connections (#271). A prior security fix closed every non-loopback WebSocket without a credential, so no remote agent could register and the agent hung at "Connecting ios agent…". Remote agents connect again, authenticated; the agent also fails fast with a clear reason instead of hanging on a rejected or malformed handshake.
- relay: bind dual-stack (IPv4 + IPv6) so an agent on another Mac connecting over `ws://<ipv4>:4000` no longer times out (#269).
- ios: auto-recover a simulator whose data directory vanished from disk (an Xcode/macOS update can prune it) — the agent erases and retries the boot once instead of failing.

## [0.8.0] - 2026-06-11

### Added

- cli: `tapflow setup [platform]` — guided, one-pass environment setup. Auto-detects platforms when run without an argument. iOS opens the App Store for Xcode, activates it (license / first-launch), and downloads a simulator runtime. Android installs a JDK and builds a self-contained SDK at `~/Library/Android/sdk` (command-line tools, platform-tools, emulator, system image — no Android Studio GUI), then creates a set of AVDs across form factors. Booting stays on-demand via the relay.
- cli: `tapflow doctor [platform]` — checks a single platform or all. iOS shows Xcode / simctl / Simulator; Android shows SDK / adb / AVD (symmetric). `--json` emits machine-readable output; a device/AVD only needs to exist, not be running.

### Changed

- cli: `doctor` reports a missing prerequisite as a failure consistently across iOS and Android, and no longer triggers the macOS Command Line Tools install popup on a machine without Xcode.

## [0.7.0] - 2026-06-08

### Added

- android: emulators now capture over gRPC and encode H.264 on the Mac host (VideoToolbox). The gRPC backend is the default for emulators (auto-detected, 30fps cap), with automatic scrcpy fallback; real devices continue to use scrcpy.
- streaming: unified per-session downscale. Resolution is chosen from the viewer's connection context — native on a secure context, 1280px on LAN-HTTP, 1000px external — and is tunable via `TAPFLOW_MAX_SIZE` and the per-platform / `_LAN` / `_EXTERNAL` overrides.
- relay: request an IDR keyframe when a browser (re)joins a booted device, so a late joiner paints immediately.

### Changed

- dashboard: iOS/Android decoding and perf telemetry are unified behind a single `useDecoderStream` hook (hardware WebCodecs on a secure context, WASM fallback otherwise).
- ios-agent: static-frame skip — unchanged H.264 frames are no longer re-sent.

### Fixed

- ios: tear-free framebuffer snapshots via a seed-stable copy, and keyframe-aware backpressure on the agent→relay stream.
- android: keyframe-aware backpressure on the agent→relay stream, and 16-aligned encode sizing to avoid macroblock padding on the WASM decoder.

## [0.6.1] - 2026-06-06

### Fixed

- android: fix a crash when the scrcpy video stream is cancelled. The v0.6.0 socket-close cleanup could call `close()`/`error()` on an already-closed stream controller, throwing inside the socket event handler.

## [0.6.0] - 2026-06-06

### Added

- android: opt-in stream throughput metrics (`TAPFLOW_STREAM_METRICS=1`) logging fps / KB·s / drop every 5s, matching the iOS agent.
- agents: hold a macOS power assertion (`caffeinate -i`) while connected so an unattended/idle Mac doesn't throttle the simulator/emulator. macOS-only; no-op elsewhere.

### Changed

- android: H.264 frames now carry the codec/keyframe flags in the stream envelope, so the relay's keyframe-aware backpressure drops to the next keyframe under LAN congestion instead of forwarding P-frames that tear. (scrcpy `send_frame_meta=true`; the public `stream()` contract is unchanged.)
- android: on-demand IDR recovery — `stream:request-idr` now resets the scrcpy encoder (RESET_VIDEO), resyncing fast instead of waiting for the periodic IDR (parity with iOS).

### Fixed

- android: the scrcpy stream now terminates on socket close, so the agent's pump and its timers no longer leak after a device shuts down.

## [0.5.1] - 2026-06-06

### Fixed

- android: screen rotation on Android 15+ (API 35+). `AdbWrapper.setRotation` now uses `wm user-rotation lock` instead of the legacy `settings put system user_rotation`, which newer Android silently ignores (only a rotation suggestion appears). The bundled scrcpy server is upgraded 3.1 → 3.3, fixing the locked capture-orientation direction (scrcpy #6010) that left the stream sideways after rotation. Verified on API 34 and API 36 emulators.

## [0.5.0] - 2026-06-04

### Added

- H.264 streaming pipeline: iOS streams H.264 by default via a VideoToolbox encoder, cutting bandwidth ~10× vs JPEG (~16–27 KB/frame vs ~235 KB) for noticeably lower latency. Android streaming moves to a runtime decoder layer.
- Automatic codec negotiation: the browser advertises its decode capability (`acceptH264`) at boot; the agent picks H.264 only when the client can decode it, otherwise falls back to JPEG — no black screens on older browsers. Opt out with `TAPFLOW_IOS_CODEC=jpeg`.
- Tiered browser decoders: HTTPS → WebCodecs, plain-HTTP LAN → WASM (tinyh264), both WebGL2-rendered.
- cli: `tapflow start` prints the public tunnel URL banner (Tailscale MagicDNS host / tailnet IP auto-detected); a missing rathole token now falls back to local-only instead of exiting.
- dashboard: 404 error page and rectangular auth submit button.

### Changed

- envelope: codec/keyframe marker added to the frame header (byte5 flags). Backward compatible — older clients read frames as JPEG and the relay forwards payloads untouched; agents without `acceptH264` (version skew) default to JPEG.
- ios-agent: lower the default JPEG stream quality `0.95` → `0.8`, cutting iOS frame bandwidth ~40% on idle/simple screens to reduce relay→browser frame drops on LAN. Tune with the `TAPFLOW_JPEG_QUALITY` env var (`0`–`1`).

### Fixed

- android: landscape rotation and recording via a locked stream + local intent.

## [0.4.1] - 2026-06-01

### Security

- relay: fix path traversal in `/uploads/` — `serveUpload` now validates that the resolved file path stays within `uploadsDir`; requests that escape the directory return 403.
- relay: `/uploads/` route now requires view authentication — unauthenticated requests return 401 before file serving.
- relay: WebSocket connections from non-localhost clients without a valid JWT cookie or PAT are rejected with close code 1008.
- relay: WebSocket role gating — browser-role sockets that send agent-only messages (`agent:register`, `agent:resources`, etc.) are disconnected immediately.

## [0.4.0] - 2026-06-01

### Breaking Changes

- `tapflow init` no longer creates an admin account. It now scaffolds `tapflow.config.json`.
  - **Before:** `tapflow start` (auto-created config) → `tapflow init` (admin creation via CLI)
  - **After:** `tapflow init` (scaffold config) → `tapflow start` → open `/setup` in browser (admin creation)
  - **Migrate:** use the `/setup` page on first launch, or `tapflow admin init` in headless environments.
- `tapflow start` and `tapflow relay start` no longer create `tapflow.config.json` as a side effect. Run `tapflow init` explicitly, or skip it to use built-in defaults (port 4000, `.tapflow-data/`).

### Added

- `tapflow init` — scaffold `tapflow.config.json` interactively; `--tunnel tailscale|rathole` for non-interactive mode; `--force` to overwrite.
- `tapflow init` auto-updates `.gitignore` — creates the file if absent, appends `.tapflow-data/` if not already present.
- `tapflow admin init` — create the first admin account via CLI (headless / CI fallback).
- Dashboard `/setup` page — web-based first admin account creation; auto-redirected from `/login` when no accounts exist.
- `GET /api/v1/auth/status` — public endpoint returning `{ initialized: boolean }`.
- Tailscale tunnel provider (`tunnel.provider: "tailscale"`) — E2E encrypted, no VPS required.

### Removed

- Automatic `tapflow.config.json` creation as a side effect of `tapflow start` / `tapflow relay start`.

[Unreleased]: https://github.com/jo-duchan/tapflow/compare/v0.24.0...HEAD
[0.24.0]: https://github.com/jo-duchan/tapflow/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/jo-duchan/tapflow/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/jo-duchan/tapflow/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/jo-duchan/tapflow/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/jo-duchan/tapflow/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/jo-duchan/tapflow/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/jo-duchan/tapflow/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/jo-duchan/tapflow/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/jo-duchan/tapflow/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/jo-duchan/tapflow/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/jo-duchan/tapflow/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/jo-duchan/tapflow/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/jo-duchan/tapflow/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/jo-duchan/tapflow/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/jo-duchan/tapflow/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/jo-duchan/tapflow/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/jo-duchan/tapflow/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/jo-duchan/tapflow/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/jo-duchan/tapflow/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/jo-duchan/tapflow/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/jo-duchan/tapflow/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/jo-duchan/tapflow/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/jo-duchan/tapflow/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jo-duchan/tapflow/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/jo-duchan/tapflow/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jo-duchan/tapflow/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/jo-duchan/tapflow/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/jo-duchan/tapflow/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/jo-duchan/tapflow/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jo-duchan/tapflow/compare/v0.3.1...v0.4.0
