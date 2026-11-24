import { confirm, isCancel } from '@clack/prompts'
import { runSetupAndroid, runSetupIos, type SetupOptions, type SetupStepResult } from '../lib/setup.js'
import { resolveAdb } from '../lib/doctor.js'
import { isInteractive } from '../lib/interactive.js'
import { warn, banner, step, BOLD, GREEN, RED, YELLOW, DIM, R } from '../lib/print.js'

// `--yes` reaches the Windows Android flow only. iOS (sudo, the network-filter approval) never sees it.
const RUNNERS: Record<string, (opts: SetupOptions) => Promise<SetupStepResult[]>> = {
  ios: () => runSetupIos(),
  android: (opts) => runSetupAndroid(opts),
}

// 인자 없이 실행 시 환경을 보고 가능한 플랫폼을 고른다.
// macOS면 iOS, adb가 있으면 Android 자동. adb가 없어도 대화형이면 Android 세팅 의향을 묻는다.
async function detectPlatforms(): Promise<string[]> {
  const platforms: string[] = []
  if (process.platform === 'darwin') platforms.push('ios')
  if (resolveAdb() !== null) {
    platforms.push('android')
  } else if ((process.platform === 'darwin' || process.platform === 'win32') && isInteractive()) {
    const also = await confirm({ message: 'Also set up Android? (adb not found)' })
    if (!isCancel(also) && also) platforms.push('android')
  }
  return platforms
}

function printResults(results: SetupStepResult[]): void {
  for (const r of results) {
    if (r.ok) {
      const tag = r.state ? ` ${DIM}(${r.state})${R}` : ''
      console.log(`  ${GREEN}✓${R}  ${r.label}${tag}`)
      if (r.detail) console.log(`${DIM}       ${r.detail}${R}`)
    } else if (r.warn) {
      console.log(`  ${YELLOW}⚠${R}  ${r.label}`)
      if (r.detail) console.log(`${DIM}       → ${r.detail}${R}`)
    } else {
      console.log(`  ${RED}✗${R}  ${r.label}`)
      if (r.detail) console.log(`${DIM}       → ${r.detail}${R}`)
    }
  }
}

export async function cmdSetup(platform?: string, opts: SetupOptions = {}): Promise<void> {
  let targets: string[]
  if (platform) {
    if (!RUNNERS[platform]) {
      warn(`Unknown or unsupported platform: ${platform}. Supported: ios, android`)
      process.exit(1)
    }
    targets = [platform]
  } else {
    targets = await detectPlatforms()
    if (targets.length === 0) {
      warn('No supported platform detected. Run: tapflow setup ios | android')
      return
    }
  }

  if (opts.assumeYes && !(process.platform === 'win32' && targets.includes('android'))) {
    warn('--yes only answers the prompts of `tapflow setup android` on Windows; it is ignored here.')
  }

  // 각 플랫폼 실행 후, 마지막에 relay/agent READY 톤의 요약 배너로 준비 상태를 알린다.
  const summary: string[] = []
  let allReady = true
  let needsNewShell = false
  for (const t of targets) {
    console.log(`\n${BOLD}tapflow setup ${t}${R}\n`)
    const results = await RUNNERS[t](opts)
    printResults(results)
    if (results.some((r) => r.detail?.includes('new terminal'))) needsNewShell = true
    const pending = results.filter((r) => !r.ok)
    if (pending.length === 0) {
      summary.push(`${t}: ready`)
    } else {
      allReady = false
      summary.push(`${t}: incomplete — ${pending.map((r) => r.label).join(', ')}`)
    }
  }
  banner(allReady ? 'success' : 'error', allReady ? 'SETUP COMPLETE' : 'SETUP INCOMPLETE', summary)

  // env가 rc에 있지만 현재 쉘엔 반영 안 됨 → 새 터미널 안내(doctor가 PATH 경고를 내지 않도록).
  if (needsNewShell) {
    // Windows has no rc file or `exec $SHELL`: setup writes the user environment, which only a
    // terminal opened afterwards reads.
    step(process.platform === 'win32'
      ? 'Open a new terminal, then `tapflow doctor` to verify — ANDROID_HOME and PATH were added to your user environment, but this terminal has not loaded them yet.'
      : "Open a new terminal (or run: exec $SHELL), then `tapflow doctor` to verify — ANDROID_HOME/PATH is configured in your shell, but the current session hasn't loaded it yet.")
  }

  // **The exit code says what the banner says.** This command returned 0 whatever it printed, so
  // anything reading the code — `tapflow setup ios && tapflow agent start`, a provisioning run, a
  // `set -e` bootstrap — carried on against a Mac that is not set up. A person reads the banner; a
  // script reads this, and `!r.ok` is the same predicate the banner already used.
  //
  // **Stricter than `doctor`, deliberately.** `doctor` fails on `!ok && !warn` (`hasFailures`), so it
  // passes a Mac with no simulator runtime and no AVD — both of which this command fails on. They
  // answer different questions: `doctor` reports whether the Mac is usable, and this reports whether
  // the work it was asked to do got done. Do not "align" them without changing what one of them means.
  //
  // Printed first, and after the new-terminal hint: the results list and what to do about them are
  // the useful half, and exiting before them would trade one silent failure for another.
  //
  // **`exitCode`, not `exit()`.** `process.stdout` is asynchronous when it is a pipe, and
  // `process.exit()` does not wait for it — measured on this machine, a run piped to `tail` lost
  // everything past about a thousand lines, five times out of five, while setting the code kept all
  // of it five times out of five. Under 64 KB both are intact, which is every real run of this
  // command, so this buys correctness for `| tee` rather than fixing a bug anyone has hit. The
  // reason it is safe is that nothing here holds the loop open: the prompts are settled by the time
  // this line runs, and a clack prompt that has been answered releases stdin, so the process ends
  // on its own. `doctor` still calls `process.exit(1)`; that is the older form, not a second rule.
  //
  // **Declining an install counts, except where the step is an optional feature.** Answering no to
  // the simulator runtime, Homebrew, a JDK or an AVD leaves the environment just as unready as never
  // being asked, and those return `ok: false`. The network filter does not: it is iOS network
  // control rather than a working Mac, so declining it returns `warn` while still `ok`, and a run
  // that declines it is complete. The audio permission and a host that is not macOS report the same
  // shape for the same reason. What the code reads is `!r.ok`, never `r.warn` — a step decides which
  // side it is on by the `ok` it returns, and `setUpNetFilter`'s non-interactive branch deliberately
  // returns `ok: false`, because a run that could never ask has not resolved anything.
  if (!allReady) process.exitCode = 1
}
