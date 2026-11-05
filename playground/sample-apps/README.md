# Tree measurement sample apps

Small apps whose screens are known in advance, so the UI tree can be measured against them: does each
element appear in the tree (recall), and does a tap on what the tree reported actually land (round trip).
Each app sets a `status` label to `tapped:<key>` when an element is used, which is how a landed tap is
proven without looking at the screen.

| | |
|---|---|
| `ios/` | One xcodegen project, two targets with the same screens: `SampleUIKit` and `SampleSwiftUI` |
| `android/` | One Jetpack Compose app with the same screens and ids (`testTag`s, exposed as `resource-id`) |
| `expected/` | What each app's screens should expose, per screen and group |
| `build.sh` | Builds the iOS targets and the Android app into `playground/test-builds/` (gitignored); `ios` or `android` builds one |
| `measure.ts` | Uploads a build, drives it through the relay, prints recall and round trip per group |
| `flows/` | Flows that drive the Gestures tab: `gestures.yaml` (long press, pinch, the home button) on every app, `android-back.yaml` on Android |

Only source is committed. Nothing built here is, for the same reasons as `packages/ios-agent/netprobe`. The one
binary is `android/gradle/wrapper/gradle-wrapper.jar`, which every Gradle project commits so it builds without a
Gradle install; it matches the checksum Gradle publishes for 8.8.

## Run it

iOS needs Xcode and `xcodegen` (`brew install xcodegen`); `build.sh` generates the project with it. Android needs
JDK 17 and the Android SDK (`ANDROID_HOME`); Gradle comes through the wrapper.

```sh
playground/sample-apps/build.sh                      # → test-builds/sample-uikit.app.zip, sample-swiftui.app.zip, sample-compose.apk
cp playground/sample-apps/.env.example playground/sample-apps/.env   # then add a token for the local relay
pnpm dev:relay & pnpm dev:ios &                      # from the repo root (pnpm dev:android for Android)
pnpm --filter @tapflowio/playground measure-tree \
  --expected sample-apps/expected/ios-uikit.json \
  --zip test-builds/sample-uikit.app.zip --device <udid> --out <file.json>
# Android: --expected sample-apps/expected/android-compose.json --zip test-builds/sample-compose.apk --device <avd name>
```

`--device` takes a name or the device id. A name repeats once per installed runtime, so the id is the safe
choice. `--dump` prints each screen's tree, which is how a miss in the tree is told apart from a miss in the
matching.

## The Gestures tab

The tab the flow input steps are checked on, outside the tree measurement (`expected/` does not list it). A short
tap and a long press on **Hold me** set different statuses (`gesture.hold.short`, `gesture.hold.long`), so a long
press that arrived as a tap fails the flow rather than passing it. A pinch on the green area sets
`gesture.zoom.in` or `gesture.zoom.out` by which way the scale went. Going to the background sets
`app.background`, which is what `pressButton: home` leaves for the next `launchApp` to show, and Android's back
button on this tab sets `app.back` instead of closing the app.

```sh
tapflow flow run playground/sample-apps/flows/gestures.yaml --build <id>
```

## Reading a result

Groups are scored apart. `basic` is what a tester expects to work; `hard` and `web` are there to fail
sometimes, and folding them into `basic` would make every number meaningless. `offscreen` holds a list row
below the fold: it is never tapped, and `0/1` there records that the tree does not report rows that are not
on screen, not a defect.

Elements are used the way a person would use them (`gesture` in `expected/`): a tap by default, a swipe for
a slider. `hold`, a 150ms press, is there for measuring how often a zero-length tap fails on a control.

A failure is sorted into one of two kinds before anything is changed:

- **Our input or parsing differs from the platform's** — fix it once, for every widget. An identifier with
  the placeholder glued on was this kind (#1035). A `UISwitch` that sometimes ignores our tap may be too —
  the zero-length tap is the suspect, and `hold` is how its failure rate gets measured before anything changes.
- **A widget reports itself oddly** — record it, do not add a per-widget rule. A SwiftUI `Toggle` reported
  as one row-wide switch is this kind.

If a WebView renders blank, reboot the simulator before reading anything into it. A simulator was seen to
get into a state where WebKit drew nothing at all, in this app and in Safari alike, and a reboot cleared it.
