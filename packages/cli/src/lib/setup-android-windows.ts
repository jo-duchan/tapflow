import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { win32 as winPath } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { confirm, isCancel } from '@clack/prompts'
import { findOnPath } from '@tapflowio/agent-core/utils'
import { isInteractive } from './interactive.js'
import type { SetupStepResult } from './setup.js'

// `tapflow setup android` on Windows, without Android Studio (#1100 follow-up).
//
// Mirrors the macOS flow in setup.ts — JDK → SDK → AVD, each step skipped when already satisfied,
// every download asked for first — with the Windows-native pieces instead of Homebrew:
//
// - **JDK**: one already usable (JAVA_HOME, then `java` on PATH) is reused if it is 17+, which is
//   what cmdline-tools 23 needs (its newest classes are class-file 61). Otherwise winget installs
//   Temurin 21 (an LTS above the 17 floor), and without winget the official Temurin zip from the
//   Adoptium API is unpacked under the per-machine tapflow home.
// - **Host**: x64 only. The Android Emulator does not run on Windows on Arm, so an ARM64 PC is told so
//   before anything is downloaded.
// - **cmdline-tools**: the archive and SHA-1 come from Google's repository manifest, the same source
//   sdkmanager reads, so there is no pinned URL to go stale.
// - **SDK**: an existing SDK is extended, not replaced. Android Studio users and half-finished
//   installs keep what they have; only missing packages are asked for.
//
// Nothing here needs administrator rights. winget may raise its own UAC prompt for the JDK MSI; the
// zip path never does. Windows features (WHPX, Hyper-V) are reported, never changed.

export const WINDOWS_JDK_MIN_MAJOR = 17
export const WINDOWS_JDK_MAJOR = 21
export const WINGET_JDK_ID = `EclipseAdoptium.Temurin.${WINDOWS_JDK_MAJOR}.JDK`
export const ANDROID_REPOSITORY_XML = 'https://dl.google.com/android/repository/repository2-3.xml'
const ANDROID_REPOSITORY_BASE = 'https://dl.google.com/android/repository/'

/** Same packages as the macOS path (setup.ts), plus the platform the system image targets. */
export const WINDOWS_AVD_IMAGE_API = 'android-35'
export const WINDOWS_BUILD_TOOLS = '35.0.0'

/** The macOS path's AVD set, reused so a team sees the same device names on both hosts. */
export const WINDOWS_AVD_SPECS: { name: string; deviceCandidates: string[] }[] = [
  { name: 'tapflow-compact', deviceCandidates: ['pixel_5', 'pixel_4a', 'pixel_4'] },
  { name: 'tapflow-phone', deviceCandidates: ['pixel_7', 'pixel_6', 'pixel'] },
  { name: 'tapflow-large', deviceCandidates: ['pixel_7_pro', 'pixel_6_pro', 'pixel_4_xl'] },
  { name: 'tapflow-tablet', deviceCandidates: ['pixel_tablet', 'pixel_c', 'Nexus 10'] },
]

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv
  input?: string
  /** Stream the tool's output to the terminal (installs); otherwise capture it. */
  inherit?: boolean
}

/** Everything that touches the machine, so the flow can be tested on any host. */
export interface WindowsSetupDeps {
  env: NodeJS.ProcessEnv
  arch: string
  home: string
  /** The per-machine tapflow home for downloaded tools: `TAPFLOW_HOME`, else `~/.tapflow`. */
  toolsHome: () => string
  exists: (p: string) => boolean
  readdir: (p: string) => string[]
  mkdirp: (p: string) => void
  rename: (from: string, to: string) => void
  remove: (p: string) => void
  tempDir: () => string
  run: (file: string, args: string[], opts?: RunOptions) => RunResult
  which: (name: string) => string | null
  fetchText: (url: string) => Promise<string>
  download: (url: string, dest: string) => Promise<void>
  fileHash: (file: string, algorithm: 'sha1' | 'sha256') => Promise<string>
  interactive: () => boolean
  confirm: (message: string) => Promise<boolean>
  /**
   * `tapflow setup android --yes`: the download/install/create-AVD confirms answer themselves, even
   * without a TTY. It never elevates: winget is skipped (its MSI can raise UAC), so a missing JDK
   * comes from the per-user Temurin zip instead.
   */
  unattended?: boolean
  log: (line: string) => void
}

// ── command lines ──────────────────────────────────────────────────────────

/**
 * The cmd.exe command line for a `.bat`/`.cmd` script. Node refuses to spawn those directly since
 * the CVE-2024-27980 fix, so they go through `cmd /d /s /c "<line>"`, every argument double-quoted
 * so a path with spaces (`C:\Users\Isaac Obeng\…`) or an argument holding `;` (package ids) reaches
 * the script whole. Neither a `"` nor a `%` can be passed through cmd reliably — quotes do not stop
 * `%VAR%` expansion — so an argument holding either is refused rather than silently corrupted.
 */
export function cmdLine(script: string, args: string[]): string {
  for (const a of [script, ...args]) {
    if (a.includes('"')) throw new Error(`refusing to pass an argument containing a double quote to cmd.exe: ${a}`)
    if (a.includes('%')) throw new Error(`refusing to pass an argument containing % to cmd.exe (it would be expanded): ${a}`)
  }
  return [script, ...args].map((a) => `"${a}"`).join(' ')
}

function isBatch(file: string): boolean {
  return /\.(bat|cmd)$/i.test(file)
}

/** Run a tool, routing batch scripts through cmd.exe. */
export function runTool(deps: WindowsSetupDeps, file: string, args: string[], opts: RunOptions = {}): RunResult {
  if (!isBatch(file)) return deps.run(file, args, opts)
  const comspec = deps.env['ComSpec'] ?? deps.env['COMSPEC'] ?? 'cmd.exe'
  return deps.run(comspec, ['/d', '/s', '/c', `"${cmdLine(file, args)}"`], opts)
}

// ── locations ──────────────────────────────────────────────────────────────

/** ANDROID_HOME / ANDROID_SDK_ROOT if set, else Android Studio's default `%LOCALAPPDATA%\Android\Sdk`. */
export function windowsSdkDir(deps: Pick<WindowsSetupDeps, 'env' | 'home'>): string {
  const set = deps.env['ANDROID_HOME'] || deps.env['ANDROID_SDK_ROOT']
  if (set) return set
  const local = deps.env['LOCALAPPDATA'] || winPath.join(deps.home, 'AppData', 'Local')
  return winPath.join(local, 'Android', 'Sdk')
}

/**
 * Where a JDK tapflow downloads itself lives: the per-machine tapflow home (`TAPFLOW_HOME`, else
 * `~/.tapflow`), like the tunnel binaries cached in `~/.tapflow/bin` — a tool, not install state.
 * Deliberately not `resolveInstallDir()`: that answers the current directory when it holds an install,
 * which would unpack ~300 MB of JDK into whatever repo setup was run from (and fetch it again from
 * anywhere else).
 */
export function managedJdkRoot(deps: Pick<WindowsSetupDeps, 'toolsHome'>): string {
  return winPath.join(deps.toolsHome(), 'tools', 'jdk')
}

export function windowsSystemImage(arch: string): string {
  return `system-images;${WINDOWS_AVD_IMAGE_API};google_apis;${arch === 'arm64' ? 'arm64-v8a' : 'x86_64'}`
}

const sdkmanagerOf = (sdk: string) => winPath.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat')
const avdmanagerOf = (sdk: string) => winPath.join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat')
const emulatorOf = (sdk: string) => winPath.join(sdk, 'emulator', 'emulator.exe')

// ── JDK ────────────────────────────────────────────────────────────────────

/** The major version `java -version` reports (`"17.0.18"` → 17, `"1.8.0_402"` → 8), or null. */
export function parseJavaMajor(versionOutput: string): number | null {
  const m = versionOutput.match(/version "(\d+)(?:\.(\d+))?/)
  if (!m) return null
  const first = Number(m[1])
  return first === 1 && m[2] ? Number(m[2]) : first
}

function javaMajorAt(deps: WindowsSetupDeps, javaExe: string): number | null {
  const r = deps.run(javaExe, ['-version'])
  // `java -version` writes to stderr.
  return parseJavaMajor(`${r.stderr}\n${r.stdout}`)
}

export interface JdkFound { javaHome: string | null; javaExe: string; major: number }

/** A usable JDK (17+): JAVA_HOME first, then `java` on PATH, then one tapflow downloaded earlier. */
export function findUsableJdk(deps: WindowsSetupDeps): JdkFound | null {
  const candidates: { javaHome: string | null; javaExe: string }[] = []
  const javaHome = deps.env['JAVA_HOME']
  if (javaHome) candidates.push({ javaHome, javaExe: winPath.join(javaHome, 'bin', 'java.exe') })
  const onPath = deps.which('java')
  if (onPath) candidates.push({ javaHome: null, javaExe: onPath })
  for (const home of managedJdkHomes(deps)) candidates.push({ javaHome: home, javaExe: winPath.join(home, 'bin', 'java.exe') })
  for (const c of candidates) {
    if (!deps.exists(c.javaExe)) continue
    const major = javaMajorAt(deps, c.javaExe)
    if (major !== null && major >= WINDOWS_JDK_MIN_MAJOR) return { ...c, major }
  }
  return null
}

function managedJdkHomes(deps: WindowsSetupDeps): string[] {
  const root = managedJdkRoot(deps)
  if (!deps.exists(root)) return []
  try {
    return deps.readdir(root).filter((d) => d.startsWith('jdk-')).sort().reverse().map((d) => winPath.join(root, d))
  } catch {
    return []
  }
}

/** Where winget's Temurin MSI lands. Not on PATH for this process until a new terminal opens. */
function wingetJdkHomes(deps: WindowsSetupDeps): string[] {
  const roots = [deps.env['ProgramFiles'], deps.env['LOCALAPPDATA'] && winPath.join(deps.env['LOCALAPPDATA'], 'Programs')]
    .filter((r): r is string => Boolean(r))
    .map((r) => winPath.join(r, 'Eclipse Adoptium'))
  const homes: string[] = []
  for (const root of roots) {
    if (!deps.exists(root)) continue
    try {
      for (const d of deps.readdir(root)) if (d.startsWith(`jdk-${WINDOWS_JDK_MAJOR}`)) homes.push(winPath.join(root, d))
    } catch { /* unreadable — try the next */ }
  }
  return homes
}

export interface AdoptiumPackage { link: string; checksum: string; name: string }

export function adoptiumApiUrl(arch: string): string {
  const a = arch === 'arm64' ? 'aarch64' : 'x64'
  return `https://api.adoptium.net/v3/assets/latest/${WINDOWS_JDK_MAJOR}/hotspot?architecture=${a}&image_type=jdk&os=windows&vendor=eclipse`
}

/** The zip package in an Adoptium `assets/latest` answer. */
export function parseAdoptiumAssets(json: string): AdoptiumPackage | null {
  let data: unknown
  try { data = JSON.parse(json) } catch { return null }
  if (!Array.isArray(data)) return null
  for (const asset of data as { binary?: { package?: Partial<AdoptiumPackage> } }[]) {
    const p = asset.binary?.package
    if (p?.link && p.checksum && p.name?.endsWith('.zip')) return { link: p.link, checksum: p.checksum, name: p.name }
  }
  return null
}

async function installJdkFromZip(deps: WindowsSetupDeps): Promise<JdkFound | null> {
  const pkg = parseAdoptiumAssets(await deps.fetchText(adoptiumApiUrl(deps.arch)))
  if (!pkg) return null
  const work = deps.tempDir()
  const zip = winPath.join(work, pkg.name)
  deps.log(`Downloading ${pkg.name}…`)
  await deps.download(pkg.link, zip)
  if ((await deps.fileHash(zip, 'sha256')).toLowerCase() !== pkg.checksum.toLowerCase()) {
    deps.remove(work)
    throw new Error(`checksum mismatch for ${pkg.name}`)
  }
  const root = managedJdkRoot(deps)
  deps.mkdirp(root)
  if (!extractZip(deps, zip, root)) { deps.remove(work); return null }
  deps.remove(work)
  return findUsableJdk(deps)
}

function jdkFailure(detail: string): SetupStepResult {
  return { label: 'Java (JDK)', ok: false, detail }
}

const JDK_MANUAL = `Install a JDK ${WINDOWS_JDK_MIN_MAJOR}+ (e.g. winget install ${WINGET_JDK_ID}) and re-run tapflow setup android.`

export async function checkAndFixJdkWindows(deps: WindowsSetupDeps): Promise<{ result: SetupStepResult; jdk: JdkFound | null }> {
  const found = findUsableJdk(deps)
  if (found) return { result: { label: `Java (JDK ${found.major})`, ok: true, state: 'found' }, jdk: found }
  if (!deps.interactive()) {
    return { result: { ...jdkFailure(`${JDK_MANUAL} (skipped in non-interactive mode)`), warn: true }, jdk: null }
  }
  const winget = deps.unattended ? null : deps.which('winget')
  const how = winget ? `with winget (${WINGET_JDK_ID})` : 'from adoptium.net into the tapflow folder'
  if (!(await deps.confirm(`A JDK ${WINDOWS_JDK_MIN_MAJOR}+ is required for the Android SDK tools. Install Temurin ${WINDOWS_JDK_MAJOR} ${how}?`))) {
    return { result: { ...jdkFailure(`Skipped. ${JDK_MANUAL}`), warn: true }, jdk: null }
  }
  if (winget) {
    const r = runTool(deps, winget, [
      'install', '--id', WINGET_JDK_ID, '--exact', '--silent',
      '--accept-package-agreements', '--accept-source-agreements',
    ], { inherit: true })
    if (r.status === 0) {
      for (const home of wingetJdkHomes(deps)) {
        const javaExe = winPath.join(home, 'bin', 'java.exe')
        const major = deps.exists(javaExe) ? javaMajorAt(deps, javaExe) : null
        if (major !== null && major >= WINDOWS_JDK_MIN_MAJOR) {
          return { result: { label: `Java (JDK ${major}) installed`, ok: true, state: 'created', detail: 'Installed with winget.' }, jdk: { javaHome: home, javaExe, major } }
        }
      }
    }
    deps.log('winget did not leave a usable JDK — falling back to the Temurin zip.')
  }
  try {
    const jdk = await installJdkFromZip(deps)
    if (jdk) {
      return { result: { label: `Java (JDK ${jdk.major}) installed`, ok: true, state: 'created', detail: `JDK at ${jdk.javaHome ?? jdk.javaExe}.` }, jdk }
    }
  } catch (e) {
    return { result: jdkFailure(`JDK download failed: ${(e as Error).message}. ${JDK_MANUAL}`), jdk: null }
  }
  return { result: jdkFailure(`JDK install failed. ${JDK_MANUAL}`), jdk: null }
}

// ── archives ───────────────────────────────────────────────────────────────

/**
 * Unpack a zip with Windows' own bsdtar (`%SystemRoot%\System32\tar.exe`, Windows 10 1803+), and
 * PowerShell's Expand-Archive when that is missing. Neither needs administrator rights.
 */
export function extractZip(deps: WindowsSetupDeps, zip: string, destDir: string): boolean {
  const systemRoot = deps.env['SystemRoot'] ?? deps.env['SYSTEMROOT'] ?? 'C:\\Windows'
  const tar = winPath.join(systemRoot, 'System32', 'tar.exe')
  if (deps.exists(tar) && deps.run(tar, ['-xf', zip, '-C', destDir]).status === 0) return true
  const ps = deps.run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -LiteralPath $env:TAPFLOW_ZIP -DestinationPath $env:TAPFLOW_DEST -Force',
  ], { env: { ...deps.env, TAPFLOW_ZIP: zip, TAPFLOW_DEST: destDir } })
  return ps.status === 0
}

// ── cmdline-tools ──────────────────────────────────────────────────────────

export interface RepoArchive { url: string; sha1: string; size: number; revision: string }

/** The Windows archive of `cmdline-tools;latest` in Google's repository2 manifest. */
export function parseCmdlineToolsArchive(xml: string): RepoArchive | null {
  const start = xml.indexOf('<remotePackage path="cmdline-tools;latest"')
  if (start < 0) return null
  const end = xml.indexOf('</remotePackage>', start)
  const pkg = xml.slice(start, end < 0 ? undefined : end)
  const major = pkg.match(/<major>(\d+)<\/major>/)?.[1]
  const minor = pkg.match(/<minor>(\d+)<\/minor>/)?.[1]
  for (const a of pkg.split('<archive>').slice(1)) {
    if (!/<host-os>windows<\/host-os>/.test(a)) continue
    const url = a.match(/<url>([^<]+)<\/url>/)?.[1]
    const sha1 = a.match(/<checksum type="sha1">([0-9a-f]{40})<\/checksum>/)?.[1]
    const size = a.match(/<size>(\d+)<\/size>/)?.[1]
    if (url && sha1) {
      return {
        url: /^https?:/.test(url) ? url : ANDROID_REPOSITORY_BASE + url,
        sha1,
        size: Number(size ?? 0),
        revision: major ? `${major}.${minor ?? 0}` : 'latest',
      }
    }
  }
  return null
}

async function installCmdlineTools(deps: WindowsSetupDeps, sdk: string): Promise<string | null> {
  const archive = parseCmdlineToolsArchive(await deps.fetchText(ANDROID_REPOSITORY_XML))
  if (!archive) throw new Error('cmdline-tools for Windows not found in the Android repository manifest')
  // Downloaded and unpacked beside its destination, so the final move is a rename on one volume
  // (an SDK on D: with %TEMP% on C: would fail with EXDEV).
  const work = winPath.join(sdk, 'cmdline-tools', '.tapflow-download')
  if (deps.exists(work)) deps.remove(work)
  deps.mkdirp(work)
  const zip = winPath.join(work, 'cmdline-tools.zip')
  deps.log(`Downloading Android command-line tools ${archive.revision} (${Math.round(archive.size / 1_000_000)} MB)…`)
  await deps.download(archive.url, zip)
  if ((await deps.fileHash(zip, 'sha1')).toLowerCase() !== archive.sha1) {
    deps.remove(work)
    throw new Error('checksum mismatch for the Android command-line tools')
  }
  const unpacked = winPath.join(work, 'unpacked')
  deps.mkdirp(unpacked)
  if (!extractZip(deps, zip, unpacked)) { deps.remove(work); return null }
  // The zip holds `cmdline-tools/{bin,lib,…}`; sdkmanager expects it at `<sdk>\cmdline-tools\latest`.
  const target = winPath.join(sdk, 'cmdline-tools', 'latest')
  deps.mkdirp(winPath.join(sdk, 'cmdline-tools'))
  if (deps.exists(target)) deps.remove(target)
  try {
    deps.rename(winPath.join(unpacked, 'cmdline-tools'), target)
  } finally {
    deps.remove(work)
  }
  return deps.exists(sdkmanagerOf(sdk)) ? sdkmanagerOf(sdk) : null
}

// ── SDK packages ───────────────────────────────────────────────────────────

function hasAapt(deps: WindowsSetupDeps, sdk: string): boolean {
  const dir = winPath.join(sdk, 'build-tools')
  if (!deps.exists(dir)) return false
  try {
    return deps.readdir(dir).some((v) => deps.exists(winPath.join(dir, v, 'aapt.exe')))
  } catch {
    return false
  }
}

/** The SDK packages still missing, in install order. Present ones are left alone. */
export function missingSdkPackages(deps: WindowsSetupDeps, sdk: string): string[] {
  const image = windowsSystemImage(deps.arch)
  const missing: string[] = []
  if (!deps.exists(winPath.join(sdk, 'platform-tools', 'adb.exe'))) missing.push('platform-tools')
  if (!deps.exists(emulatorOf(sdk))) missing.push('emulator')
  if (!hasAapt(deps, sdk)) missing.push(`build-tools;${WINDOWS_BUILD_TOOLS}`)
  if (!deps.exists(winPath.join(sdk, 'platforms', WINDOWS_AVD_IMAGE_API, 'android.jar'))) missing.push(`platforms;${WINDOWS_AVD_IMAGE_API}`)
  if (!isSystemImageInstalled(deps, sdk, image)) missing.push(image)
  return missing
}

/**
 * A system image counts as installed only when `system.img` itself is there — the large download can
 * drop partway and leave the package directory behind (the very failure the retry loop exists for).
 * `system.img` is the file the emulator boots, so no other marker (`source.properties` is small and
 * could outlive a half-finished extraction) is accepted in its place.
 */
function isSystemImageInstalled(deps: WindowsSetupDeps, sdk: string, image: string): boolean {
  return deps.exists(winPath.join(sdk, ...image.split(';'), 'system.img'))
}

/** sdkmanager/avdmanager need the JDK and the SDK root; PATH gets the JDK first so `java` resolves. */
export function sdkToolEnv(deps: WindowsSetupDeps, sdk: string, jdk: JdkFound | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...deps.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }
  if (jdk?.javaHome) {
    env['JAVA_HOME'] = jdk.javaHome
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path'
    env[pathKey] = `${winPath.join(jdk.javaHome, 'bin')};${env[pathKey] ?? ''}`
  } else if (jdk) {
    // The accepted JDK came from `java` on PATH (17+). sdkmanager.bat/avdmanager.bat prefer JAVA_HOME
    // when it is set, so an inherited JAVA_HOME pointing at an older JDK (a Java 8 install alongside a
    // Java 17 on PATH) would run the SDK tools on the wrong Java and fail their version check. Drop it
    // so the wrappers fall back to the PATH `java` that findUsableJdk already vetted.
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'JAVA_HOME') delete env[k]
  }
  return env
}

const LICENSE_INPUT = 'y\n'.repeat(50)

/** A dropped sdkmanager download (common on a large system image) is retried this many times. */
export const SDKMANAGER_INSTALL_ATTEMPTS = 3

export async function checkAndFixAndroidSdkWindows(
  deps: WindowsSetupDeps,
  jdk: JdkFound | null,
): Promise<{ result: SetupStepResult; sdk: string; ok: boolean }> {
  const sdk = windowsSdkDir(deps)
  let sdkmanager = deps.exists(sdkmanagerOf(sdk)) ? sdkmanagerOf(sdk) : null
  const missing = missingSdkPackages(deps, sdk)
  if (sdkmanager && missing.length === 0) {
    return { result: { label: `Android SDK ready: ${sdk}`, ok: true, state: 'found' }, sdk, ok: true }
  }
  if (!jdk) {
    return { result: { label: 'Android SDK', ok: false, detail: 'Install a JDK first (Android SDK tools need Java).' }, sdk, ok: false }
  }
  const todo = [...(sdkmanager ? [] : ['cmdline-tools']), ...missing]
  if (!deps.interactive()) {
    return { result: { label: 'Android SDK', ok: false, warn: true, detail: `Missing: ${todo.join(', ')} (skipped in non-interactive mode).` }, sdk, ok: false }
  }
  if (!(await deps.confirm(`Install into ${sdk}: ${todo.join(', ')}? (downloads from dl.google.com)`))) {
    return { result: { label: 'Android SDK', ok: false, warn: true, detail: `Skipped. Missing: ${todo.join(', ')}` }, sdk, ok: false }
  }
  deps.mkdirp(sdk)
  if (!sdkmanager) {
    try {
      sdkmanager = await installCmdlineTools(deps, sdk)
    } catch (e) {
      return { result: { label: 'Android SDK', ok: false, detail: `Could not install the command-line tools: ${(e as Error).message}` }, sdk, ok: false }
    }
    if (!sdkmanager) return { result: { label: 'Android SDK', ok: false, detail: 'Could not unpack the Android command-line tools.' }, sdk, ok: false }
  }
  const env = sdkToolEnv(deps, sdk, jdk)
  const root = `--sdk_root=${sdk}`
  runTool(deps, sdkmanager, [root, '--licenses'], { env, input: LICENSE_INPUT, inherit: true })
  // sdkmanager downloads are large and a dropped connection fails the whole run. Retry only
  // packages still missing, up to SDKMANAGER_INSTALL_ATTEMPTS times.
  let leftover = missing
  for (let attempt = 1; leftover.length > 0 && attempt <= SDKMANAGER_INSTALL_ATTEMPTS; attempt++) {
    const inst = runTool(deps, sdkmanager, [root, ...leftover], { env, input: LICENSE_INPUT, inherit: true })
    leftover = missingSdkPackages(deps, sdk)
    if (leftover.length === 0) break
    if (attempt < SDKMANAGER_INSTALL_ATTEMPTS) {
      deps.log(`sdkmanager failed installing ${leftover.join(', ')} (attempt ${attempt}/${SDKMANAGER_INSTALL_ATTEMPTS}, exit ${inst.status}); retrying`)
      continue
    }
    const detail = inst.status !== 0
      ? `sdkmanager failed installing: ${leftover.join(', ')}`
      : `Still missing after install: ${leftover.join(', ')}`
    return { result: { label: 'Android SDK', ok: false, detail }, sdk, ok: false }
  }
  const reg = registerWindowsUserEnv(deps, sdk)
  const envNote = reg === 'added' ? ` ${WINDOWS_NEW_TERMINAL_HINT}` : reg === null ? ` ${WINDOWS_ENV_WRITE_FAILED}` : ''
  return {
    result: {
      label: 'Android SDK installed',
      ok: true,
      state: 'created',
      detail: `SDK at ${sdk}.${envNote}`,
    },
    sdk,
    ok: true,
  }
}

// ── user environment ───────────────────────────────────────────────────────

export const WINDOWS_NEW_TERMINAL_HINT =
  'ANDROID_HOME and PATH were added to your user environment — open a new terminal to use them.'

export const WINDOWS_ENV_WRITE_FAILED =
  'Could not write ANDROID_HOME and PATH to your user environment: set ANDROID_HOME to the SDK and add its platform-tools and emulator folders to your user PATH, then open a new terminal.'

/**
 * Persist ANDROID_HOME and the SDK's platform-tools/emulator on the **user** PATH (HKCU, no admin),
 * the Windows counterpart of the macOS rc-file block. Values travel through env vars, not the command
 * text, so nothing in a path needs quoting for PowerShell.
 *
 * The user Path is read and written through the registry, not `[Environment]::Get/SetEnvironmentVariable`.
 * On Windows PowerShell (.NET Framework) those expand the value on read and store REG_SZ on write, so
 * every `%USERPROFILE%`-style entry would be frozen to today's absolute path and the value would stop
 * being REG_EXPAND_SZ — the same class of damage `setx` does (which also truncates at 1024 characters).
 * Here the raw value is read with DoNotExpandEnvironmentNames, compared entry by entry in expanded form
 * (so `%LOCALAPPDATA%\Android\Sdk\platform-tools` already counts), and written back as ExpandString.
 * Setting ANDROID_HOME through `SetEnvironmentVariable` afterwards is what broadcasts WM_SETTINGCHANGE,
 * so a terminal opened from Explorer sees both. `TAPFLOW_ENV_KEY` exists for the Windows-only test,
 * which points the script at a scratch key under HKCU\Software and skips that broadcast.
 */
export const REGISTER_ENV_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$sdk = $env:TAPFLOW_SDK',
  "$keyName = if ($env:TAPFLOW_ENV_KEY) { $env:TAPFLOW_ENV_KEY } else { 'Environment' }",
  '$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyName)',
  "$changed = $key.GetValue('ANDROID_HOME') -ne $sdk",
  "$p = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
  // @(...) keeps $parts an array: a one-entry user PATH makes Where-Object return a bare string, and
  // `$parts += $d` would then concatenate the directory onto it with no separator, corrupting PATH.
  "$parts = @($p.Split(';') | Where-Object { $_ -ne '' })",
  "$seen = @($parts | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') })",
  "foreach ($d in @((Join-Path $sdk 'platform-tools'), (Join-Path $sdk 'emulator'))) { if ($seen -notcontains $d) { $parts += $d; $seen += $d; $changed = $true } }",
  "if ($changed) { $key.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString); if ($keyName -eq 'Environment') { [Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'User') } else { $key.SetValue('ANDROID_HOME', $sdk) } }",
  '$key.Close()',
  "if ($changed) { 'added' } else { 'present' }",
].join('; ')

export function registerWindowsUserEnv(deps: WindowsSetupDeps, sdk: string): 'added' | 'present' | null {
  const r = deps.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', REGISTER_ENV_SCRIPT], {
    env: { ...deps.env, TAPFLOW_SDK: sdk },
  })
  if (r.status !== 0) return null
  const out = r.stdout.trim().split(/\r?\n/).pop()
  return out === 'added' || out === 'present' ? out : null
}

// ── AVDs ───────────────────────────────────────────────────────────────────

export function listAvdsWindows(deps: WindowsSetupDeps, sdk: string): string[] {
  const emulator = emulatorOf(sdk)
  if (!deps.exists(emulator)) return []
  const r = deps.run(emulator, ['-list-avds'], { env: sdkToolEnv(deps, sdk, null) })
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('INFO') && !l.startsWith('WARNING'))
}

export function parseDeviceIds(out: string): string[] {
  return [...out.matchAll(/id:\s*\d+\s+or\s+"([^"]+)"/g)].map((m) => m[1]).filter((id): id is string => Boolean(id))
}

export async function checkAndFixAvdWindows(deps: WindowsSetupDeps, sdk: string, sdkOk: boolean, jdk: JdkFound | null): Promise<SetupStepResult> {
  if (!sdkOk) return { label: 'AVD', ok: false, detail: 'Set up the Android SDK first.' }
  const avds = listAvdsWindows(deps, sdk)
  const ready: SetupStepResult = { label: `AVD ready: ${avds.length} device(s)`, ok: true, state: 'found' }
  // AVDs of the person's own, with no tapflow-* set started, are enough, as they always were. A tapflow-*
  // set an earlier run left incomplete is offered to be finished: only the names still missing are made,
  // so the AVDs that exist are never overwritten. The AVDs already there make the step pass either way —
  // declining, or a name avdmanager cannot make, must not leave setup incomplete on every run after.
  const missingOurs = WINDOWS_AVD_SPECS.filter((s) => !avds.includes(s.name))
  const finishing = avds.length > 0
  if (finishing && (missingOurs.length === 0 || missingOurs.length === WINDOWS_AVD_SPECS.length)) return ready
  const todo = finishing ? missingOurs : WINDOWS_AVD_SPECS
  const stop = (fail: SetupStepResult): SetupStepResult => (finishing ? { ...ready, detail: fail.detail } : fail)
  const situation = finishing ? `Not created yet: ${todo.map((s) => s.name).join(', ')}.` : 'No AVD found.'
  const manualHint = 'Create an AVD with avdmanager.bat (see Android docs).'
  // avdmanager.bat is a Java tool: without a JDK it fails, and the result would blame the AVDs.
  if (!jdk) return stop({ label: 'AVD', ok: false, detail: `${situation} Install a JDK 17+ first (avdmanager needs Java), then re-run tapflow setup android.` })
  if (!deps.interactive()) return stop({ label: 'AVD', ok: false, warn: true, detail: `${situation} ${manualHint}` })
  const avdmanager = avdmanagerOf(sdk)
  if (!deps.exists(avdmanager)) return stop({ label: 'AVD', ok: false, warn: true, detail: 'Android cmdline-tools not found in the SDK.' })
  const env = sdkToolEnv(deps, sdk, jdk)
  // Read before asking: a spec whose device ids this avdmanager does not offer cannot be made on any run.
  const available = parseDeviceIds(runTool(deps, avdmanager, ['list', 'device'], { env }).stdout)
  const creatable: { spec: (typeof WINDOWS_AVD_SPECS)[number]; device: string }[] = []
  const unavailable: (typeof WINDOWS_AVD_SPECS)[number][] = []
  for (const spec of todo) {
    const device = spec.deviceCandidates.find((d) => available.includes(d))
    if (device) creatable.push({ spec, device })
    else unavailable.push(spec)
  }
  const unavailableNote = unavailable.length > 0
    ? ` This avdmanager offers no device for ${unavailable.map((s) => `${s.name} (${s.deviceCandidates.join(', ')})`).join('; ')}, so ${unavailable.length === 1 ? 'it was' : 'they were'} left out.`
    : ''
  if (creatable.length === 0) return stop({ label: 'AVD', ok: false, warn: true, detail: `${situation}${unavailableNote}` })
  const names = creatable.map((c) => c.spec.name).join(', ')
  const question = finishing
    ? `An earlier run did not create every tapflow AVD. Create ${names} now?`
    : 'No Android Virtual Device found. Create a set of AVDs now?'
  if (!(await deps.confirm(question))) {
    return stop({ label: 'AVD', ok: false, warn: true, detail: `Skipped. ${situation} ${manualHint}` })
  }
  const image = windowsSystemImage(deps.arch)
  const created: string[] = []
  const failed: string[] = []
  for (const { spec, device } of creatable) {
    // `--force` only replaces a half-made AVD of a name -list-avds does not show: `todo` holds no listed name.
    const r = runTool(deps, avdmanager, ['create', 'avd', '-n', spec.name, '-k', image, '-d', device, '--force'], { env, input: 'no\n', inherit: true })
    if (r.status === 0) created.push(spec.name)
    else failed.push(spec.name)
  }
  const listed = listAvdsWindows(deps, sdk)
  // What was agreed to and did not happen fails the step; a re-run offers exactly these names again.
  const notReady = [...failed, ...created.filter((n) => !listed.includes(n))]
  if (notReady.length > 0) {
    const made = created.filter((n) => listed.includes(n))
    return {
      label: 'AVD',
      ok: false,
      warn: true,
      detail: `Could not create: ${notReady.join(', ')}.${made.length > 0 ? ` Created: ${made.join(', ')}.` : ''} Re-run tapflow setup android to try ${notReady.length === 1 ? 'it' : 'them'} again.${unavailableNote}`,
    }
  }
  return { label: `AVDs created: ${created.join(', ')}`, ok: true, state: 'created', ...(unavailableNote ? { detail: unavailableNote.trim() } : {}) }
}

// ── hardware acceleration ──────────────────────────────────────────────────

export const ACCEL_GUIDANCE =
  'The emulator has no hardware acceleration, so x86_64 images will not boot usefully. Turn on ' +
  '"Windows Hypervisor Platform" in Windows Features (optionalfeatures.exe), or install the Android ' +
  'Emulator hypervisor driver (AEHD) from the SDK, enable virtualization (SVM/VT-x) in the BIOS if it ' +
  'is off, then reboot and re-run tapflow setup android. tapflow does not change Windows features itself.'

/** `emulator -accel-check`: exit 0 means WHPX or AEHD is usable. Reported, never fixed — that needs admin. */
export function checkAccelWindows(deps: WindowsSetupDeps, sdk: string): SetupStepResult {
  const emulator = emulatorOf(sdk)
  if (!deps.exists(emulator)) return { label: 'Hardware acceleration', ok: false, detail: 'Android emulator not installed.' }
  const r = deps.run(emulator, ['-accel-check'], { env: sdkToolEnv(deps, sdk, null) })
  const text = `${r.stdout}\n${r.stderr}`
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /WHPX|AEHD|GVM|HAXM|hypervisor/i.test(l))
  if (r.status === 0) return { label: `Hardware acceleration${line ? `: ${line}` : ''}`, ok: true, state: 'found' }
  return { label: 'Hardware acceleration', ok: false, warn: true, detail: `${line ? `${line}. ` : ''}${ACCEL_GUIDANCE}` }
}

// ── entry point ────────────────────────────────────────────────────────────

/** Said instead of setting anything up on an ARM64 PC, before any download. */
export const WINDOWS_ARM64_UNSUPPORTED =
  'The Android Emulator does not run on Windows on Arm (Google requires an x86_64 CPU on Windows), so tapflow ' +
  'cannot set up Android on this PC. Use an x64 Windows PC, a Mac, or Linux.'

export async function runSetupAndroidWindows(deps: WindowsSetupDeps = realWindowsDeps()): Promise<SetupStepResult[]> {
  if (deps.arch === 'arm64') return [{ label: 'Android emulator', ok: false, detail: WINDOWS_ARM64_UNSUPPORTED }]
  const results: SetupStepResult[] = []
  const { result: jdkResult, jdk } = await checkAndFixJdkWindows(deps)
  results.push(jdkResult)
  const sdkStep = await checkAndFixAndroidSdkWindows(deps, jdk)
  results.push(sdkStep.result)
  results.push(await checkAndFixAvdWindows(deps, sdkStep.sdk, sdkStep.ok, jdk))
  if (sdkStep.ok) results.push(checkAccelWindows(deps, sdkStep.sdk))
  return results
}

export interface WindowsSetupOptions {
  /** `--yes`: answer the install/download/create-AVD prompts, also when not interactive. */
  assumeYes?: boolean
}

export function realWindowsDeps(opts: WindowsSetupOptions = {}): WindowsSetupDeps {
  const assumeYes = opts.assumeYes === true
  return {
    env: process.env,
    arch: process.arch,
    home: homedir(),
    toolsHome: () => (process.env['TAPFLOW_HOME'] ? winPath.resolve(process.env['TAPFLOW_HOME']) : winPath.join(homedir(), '.tapflow')),
    exists: existsSync,
    readdir: (p) => readdirSync(p),
    mkdirp: (p) => { mkdirSync(p, { recursive: true }) },
    rename: renameSync,
    remove: (p) => { rmSync(p, { recursive: true, force: true }) },
    tempDir: () => {
      const dir = winPath.join(tmpdir(), `tapflow-setup-${process.pid}-${Date.now()}`)
      mkdirSync(dir, { recursive: true })
      return dir
    },
    run: (file, args, opts = {}) => {
      const r = spawnSync(file, args, {
        env: opts.env ?? process.env,
        input: opts.input,
        encoding: 'utf8',
        windowsHide: true,
        // cmd.exe gets its line verbatim: Node's own quoting would escape the quotes cmdLine placed.
        windowsVerbatimArguments: /(^|\\)cmd(\.exe)?$/i.test(file),
        stdio: opts.inherit ? [opts.input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] : 'pipe',
        maxBuffer: 64 * 1024 * 1024,
      })
      return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    which: (name) => findOnPath(name),
    fetchText: async (url) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
      return res.text()
    },
    download: async (url, dest) => {
      const res = await fetch(url)
      if (!res.ok || !res.body) throw new Error(`GET ${url} → HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(dest))
    },
    fileHash: (file, algorithm) => new Promise((resolve, reject) => {
      const h = createHash(algorithm)
      createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')))
    }),
    interactive: () => assumeYes || isInteractive(),
    unattended: assumeYes,
    confirm: async (message) => {
      if (assumeYes) {
        console.log(`${message} yes (--yes)`)
        return true
      }
      const answer = await confirm({ message })
      return !isCancel(answer) && answer === true
    },
    log: (line) => console.log(line),
  }
}
