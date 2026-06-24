import { execSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DoctorCheck {
  label: string
  ok: boolean
  warn?: boolean
  detail?: string
}

export interface DoctorResult {
  common: DoctorCheck[]
  ios: DoctorCheck[] | null
  android: DoctorCheck[] | null
}

// platform: 'ios' | 'android' 지정 시 해당 플랫폼만. 없으면 자동(iOS는 macOS에서만, Android은 항상).
export async function runDoctorChecks(platform?: string): Promise<DoctorResult> {
  const isMac = process.platform === 'darwin'
  const wantIos = platform === 'ios' || (!platform && isMac)
  const wantAndroid = platform === 'android' || !platform

  return {
    common: [checkNodeVersion(), await checkPort(4000)],
    ios: wantIos ? buildIosChecks(isMac) : null,
    android: wantAndroid ? buildAndroidChecks(resolveAdb()) : null,
  }
}

function buildIosChecks(isMac: boolean): DoctorCheck[] {
  if (!isMac) {
    return [{ label: 'iOS', ok: false, warn: true, detail: 'iOS testing requires macOS.' }]
  }
  // Xcode.app이 없으면 xcodebuild/xcrun을 부르지 않는다 — 호출 시 macOS가 CLT 설치 팝업을 띄운다.
  if (!existsSync('/Applications/Xcode.app')) {
    return [
      {
        label: 'Xcode',
        ok: false,
        detail: 'Install Xcode from https://developer.apple.com/xcode/ or the Mac App Store. Or run: tapflow setup ios',
      },
    ]
  }
  return [checkXcode(), checkSimctl(), checkBootedSimulator()]
}

// adb가 없어도 섹션을 숨기지 않고 진단을 노출한다(Android를 세팅하려는 사용자가 볼 수 있도록).
// iOS(Xcode / simctl / Simulator)와 대칭: Android SDK / adb / AVD.
function buildAndroidChecks(adb: AdbResolution | null): DoctorCheck[] {
  return [checkAndroidSdk(), checkAdbStatus(adb), checkAvdAvailable()]
}

function androidSdkDir(): string | null {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'), // macOS
    join(homedir(), 'Android', 'Sdk'), // Linux
  ]
  for (const c of candidates) {
    if (c && existsSync(join(c, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'))) return c
  }
  return null
}

function checkAndroidSdk(): DoctorCheck {
  const dir = androidSdkDir()
  if (dir) {
    return { label: `Android SDK: ${dir}`, ok: true }
  }
  return { label: 'Android SDK', ok: false, detail: 'Android SDK not found. Run: tapflow setup android' }
}

function checkAdbStatus(adb: AdbResolution | null): DoctorCheck {
  if (!adb) {
    // 미설치는 iOS(Xcode)와 동일하게 fail(✗)로 — setup으로 해결 가능함을 안내.
    return { label: 'adb', ok: false, detail: 'adb not found. Run: tapflow setup android' }
  }
  if (adb.inPath) {
    return checkAdb(adb.path)
  }
  return {
    label: 'adb (not in PATH)',
    ok: false,
    warn: true,
    detail: `adb found at ${adb.path} but not in PATH. Open a new terminal or run: exec $SHELL, then re-run tapflow doctor`,
  }
}

function checkXcode(): DoctorCheck {
  try {
    const out = execSync('xcodebuild -version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const version = out.split('\n')[0]?.replace('Xcode ', '') ?? ''
    return { label: `Xcode ${version}`, ok: true }
  } catch {
    if (existsSync('/Applications/Xcode.app')) {
      return {
        label: 'Xcode',
        ok: false,
        detail: 'Xcode is installed but xcode-select is not configured. Run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      }
    }
    return {
      label: 'Xcode',
      ok: false,
      detail: 'Install Xcode from https://developer.apple.com/xcode/ or the Mac App Store.',
    }
  }
}

function checkSimctl(): DoctorCheck {
  try {
    execSync('xcrun simctl list --json', { stdio: 'pipe' })
    return { label: 'xcrun simctl', ok: true }
  } catch {
    return {
      label: 'xcrun simctl',
      ok: false,
      detail: 'Run: xcode-select --install',
    }
  }
}

// 부팅은 QA Session 접속 시 relay가 on-demand로 한다 — 미부팅은 정상, 디바이스 존재만 확인.
function checkBootedSimulator(): DoctorCheck {
  try {
    const raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe' })
    const data = JSON.parse(raw) as { devices: Record<string, Array<{ name: string; state: string; udid: string }>> }
    const allDevices = Object.values(data.devices).flat()
    if (allDevices.length === 0) {
      return { label: 'Simulator', ok: false, warn: true, detail: 'No simulator available. Run: tapflow setup ios' }
    }
    const booted = allDevices.find((d) => d.state === 'Booted')
    return {
      label: booted ? `Simulator: ${booted.name} (booted)` : `Simulator available (${allDevices.length})`,
      ok: true,
    }
  } catch {
    return { label: 'Simulator', ok: false, detail: 'Could not query simulators. Is Xcode installed?' }
  }
}

function checkNodeVersion(): DoctorCheck {
  const version = process.version
  const [, major] = version.match(/^v(\d+)/) ?? []
  const ok = Number(major) >= 20
  return {
    label: `Node ${version}`,
    ok,
    detail: ok ? undefined : 'Node ≥ 20 required. Install from https://nodejs.org/',
  }
}

async function checkPort(port: number): Promise<DoctorCheck> {
  const ok = await isPortAvailable(port)
  return {
    label: `Port ${port}`,
    ok,
    detail: ok ? undefined : `Port ${port} is already in use. Run: lsof -ti:${port} | xargs kill`,
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

export interface AdbResolution {
  path: string
  inPath: boolean
}

export function resolveAdb(): AdbResolution | null {
  try {
    const found = execSync('which adb', { encoding: 'utf8', stdio: 'pipe' }).trim()
    if (found) return { path: found, inPath: true }
  } catch {
    // PATH에 없으면 표준 SDK 위치 탐색으로 진행
  }
  for (const candidate of standardAdbPaths()) {
    if (existsSync(candidate)) return { path: candidate, inPath: false }
  }
  return null
}

function standardAdbPaths(): string[] {
  const paths: string[] = []
  if (process.env.ANDROID_HOME) paths.push(join(process.env.ANDROID_HOME, 'platform-tools', 'adb'))
  if (process.env.ANDROID_SDK_ROOT) paths.push(join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'))
  const home = homedir()
  paths.push(join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb')) // macOS
  paths.push(join(home, 'Android', 'Sdk', 'platform-tools', 'adb')) // Linux
  return paths
}

function checkAdb(path: string): DoctorCheck {
  return { label: `adb found: ${path}`, ok: true }
}

// 부팅은 relay on-demand가 한다 — AVD가 하나라도 존재하면 ok.
// iOS Simulator와 대칭: SDK/emulator 자체가 없으면 fail(✗), emulator는 있는데 AVD만 없으면 warn(⚠).
function checkAvdAvailable(): DoctorCheck {
  const dir = androidSdkDir()
  const emulator = dir ? join(dir, 'emulator', 'emulator') : null
  if (!emulator || !existsSync(emulator)) {
    return { label: 'AVD', ok: false, detail: 'Android SDK/emulator not found. Run: tapflow setup android' }
  }
  try {
    const out = spawnSync(emulator, ['-list-avds'], { encoding: 'utf8' }).stdout ?? ''
    const avds = out.trim() ? out.trim().split('\n').map((l) => l.trim()).filter(Boolean) : []
    if (avds.length > 0) {
      return { label: `AVD available: ${avds[0]}`, ok: true }
    }
  } catch {
    // 조회 실패 — 아래 warn
  }
  return { label: 'AVD', ok: false, warn: true, detail: 'No AVD found. Run: tapflow setup android' }
}
