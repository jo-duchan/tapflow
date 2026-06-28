// Shared macOS Core Audio process-tap helper utilities.
//
// The helper itself (audiotap-helper.swift) taps host processes by PID. tapflow uses it two ways:
//   - iOS:     capture a simulator's audio and stream it to the browser (launchAudioHelper)
//   - Android: mute the emulator (qemu) process's host output while gRPC does the capture (launchMuteOnlyTap)
//
// Both platforms share the same signed .app so they share one audio-capture TCC grant (keyed on the
// app's cdhash). This package owns the bundle build, launch, and permission-priming; the per-platform
// capture/stream logic lives in ios-agent / android-agent.
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger, PlatformError } from '@tapflowio/agent-core'

const logger = createLogger('audiotap-helper')

const HELPER_SRC = join(import.meta.dirname, '..', 'src', 'audiotap-helper.swift')
const HELPER_APP = join(import.meta.dirname, '..', 'bin', 'audiotap-helper.app')
const HELPER_BIN = join(HELPER_APP, 'Contents', 'MacOS', 'audiotap-helper')

// LSUIElement → no Dock icon (background agent). NSAudioCaptureUsageDescription → the one-time TCC
// "audio recording" prompt. LSMinimumSystemVersion 14.2 → Core Audio process taps.
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>audiotap-helper</string>
  <key>CFBundleIdentifier</key><string>io.tapflow.audiotap-helper</string>
  <key>CFBundleName</key><string>audiotap-helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.2</string>
  <key>NSAudioCaptureUsageDescription</key><string>tapflow taps the simulator/emulator audio to stream it to the browser.</string>
  <key>NSMicrophoneUsageDescription</key><string>tapflow taps the simulator/emulator audio to stream it to the browser.</string>
</dict></plist>
`
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
`

/**
 * Build (mtime-gated) the audiotap-helper as a signed `.app` and return its path.
 *
 * WHY a `.app`, not a bare binary like the other helpers: a Core Audio process tap returns silence
 * unless the *responsible process* holds the audio-recording TCC grant. A CLI child the agent spawns
 * inherits the agent's (ungranted) responsibility. Launched via `open` (LaunchServices), the helper
 * is its own responsible process with its own one-time grant — so it must be a bundle. Steady state
 * (unchanged source) skips the rebuild/re-sign, so the grant persists (TCC keys on the cdhash).
 */
export function ensureHelperApp(): string {
  if (existsSync(HELPER_BIN)) {
    if (!existsSync(HELPER_SRC)) return HELPER_APP // source not shipped — trust the prebuilt bundle
    if (statSync(HELPER_BIN).mtimeMs >= statSync(HELPER_SRC).mtimeMs) return HELPER_APP
    logger.info('audiotap-helper source changed, rebuilding...')
  }
  if (!existsSync(HELPER_SRC)) {
    throw new PlatformError('audiotap-helper.app missing and source not found — reinstall @tapflowio/audiotap-helper')
  }
  logger.info('building audiotap-helper.app...')
  mkdirSync(join(HELPER_APP, 'Contents', 'MacOS'), { recursive: true })
  execFileSync('swiftc', [
    HELPER_SRC, '-o', HELPER_BIN, '-framework', 'CoreAudio', '-framework', 'AudioToolbox',
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  writeFileSync(join(HELPER_APP, 'Contents', 'Info.plist'), INFO_PLIST)
  const entPath = join(import.meta.dirname, '..', 'bin', '.audiotap.entitlements')
  writeFileSync(entPath, ENTITLEMENTS)
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', entPath, HELPER_APP],
    { stdio: ['ignore', 'ignore', 'inherit'] })
  logger.info('built audiotap-helper.app')
  return HELPER_APP
}

/**
 * Launch the helper bundle via LaunchServices, pointed at the agent's loopback port and the simulator
 * process PID(s) to tap (iOS capture). `-g` keeps it backgrounded (no focus steal). `-n` forces a NEW
 * instance per simulator — without it `open -a` reuses the first sim's running helper, so a second
 * concurrent sim never gets its own tap and its audio silently breaks. LaunchServices makes each its
 * own TCC-responsible process; it connects back to `port` and streams PCM.
 */
export function launchAudioHelper(appPath: string, port: number, pids: number[]): void {
  execFileSync('open', ['-g', '-n', '-a', appPath, '--args', String(port), ...pids.map(String)],
    { stdio: ['ignore', 'ignore', 'ignore'] })
}

/**
 * Launch the helper in mute-only mode (Android host-mute symmetry, #341): it holds a `.muted` process
 * tap on `pids` (the emulator/qemu process) to silence their host output, but captures/streams nothing
 * — Android captures audio via gRPC. No port/socket. The helper self-exits once every target pid is
 * gone (emulator stopped). `-n` forces a fresh instance so it never collides with the iOS capture helper.
 */
export function launchMuteOnlyTap(appPath: string, pids: number[]): void {
  execFileSync('open', ['-g', '-n', '-a', appPath, '--args', '--mute-only', ...pids.map(String)],
    { stdio: ['ignore', 'ignore', 'ignore'] })
}

// Core Audio process taps need macOS 14.2+ (Darwin 23.2+). os.release() → "<darwinMajor>.<minor>.…".
export function isAudioSupported(): boolean {
  const [maj, min] = os.release().split('.').map(Number)
  return maj > 23 || (maj === 23 && min >= 2)
}

/**
 * Prime the audio-capture TCC grant up front (from `tapflow setup ios` / `tapflow agent start`) so the
 * operator approves it while present — not at first simulator boot, which a headless operator would miss.
 *
 * Runs the helper's --request-permission mode: a global tap whose *capture start* raises the same
 * audio-capture prompt a per-pid tap needs (the grant keys on the app cdhash + service, not the tap
 * shape), so no port/pid/booted simulator is required. The grant isn't readable back, so the caller
 * treats a clean return as "prompt shown / answered" and leaves approve-vs-deny to the operator.
 *
 * `wait` (default true, for `tapflow setup ios`): `open -W` blocks until the modal is answered.
 * `wait=false` (for `tapflow agent start`): fire-and-forget so agent startup isn't blocked — if the
 * grant exists the helper exits silently, otherwise the modal pops for the operator to allow.
 */
export function requestAudioPermission(wait = true): void {
  try {
    const app = ensureHelperApp()
    const flags = wait ? ['-W', '-n'] : ['-g', '-n']
    execFileSync('open', [...flags, '-a', app, '--args', '--request-permission'], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch (e) {
    if (wait) throw e // setup wants to surface it; agent-start priming is best-effort (never block startup)
    logger.warn(`audio permission priming skipped: ${e instanceof Error ? e.message : String(e)}`)
  }
}
