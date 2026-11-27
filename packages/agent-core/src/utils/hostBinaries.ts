import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// Host-binary resolution that does not assume macOS or Linux.
//
// tapflow probed SDK tools as `<sdk>/platform-tools/adb` and asked `which adb` for PATH. On Windows the
// files are `adb.exe`, `emulator.exe`, `aapt.exe`, `sdkmanager.bat`, and `which` does not exist, so a
// valid SDK read as missing and the Android agent never registered (#1100). Every probe here is pure
// Node: no `which`/`where` subprocess, so there is nothing platform-specific to spawn and nothing to
// block the event loop on. `platform`, `env` and `isFile` are injectable so the Windows behaviour is
// testable on any host.

/** The SDK's command-line scripts, which ship as `.bat` on Windows rather than `.exe`. */
const BATCH_TOOLS = new Set(['sdkmanager', 'avdmanager'])

/** The file name a host tool has on `platform`: `adb` → `adb.exe`, `sdkmanager` → `sdkmanager.bat` on win32. */
export function hostExecutableName(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return name
  if (/\.[A-Za-z0-9]+$/.test(name)) return name
  return BATCH_TOOLS.has(name) ? `${name}.bat` : `${name}.exe`
}

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

export interface FindOnPathOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Defaults to a `stat` check. Injectable for tests. */
  isFile?: (candidate: string) => boolean
}

/** Read an env var the way the OS does: case-insensitively on Windows (`Path` vs `PATH`). */
function readEnv(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[key]
  const match = Object.keys(env).find((k) => k.toUpperCase() === key)
  return match === undefined ? undefined : env[match]
}

/**
 * The first `name` on PATH, the way `which` (POSIX) or `where` (Windows) would find it, or null.
 *
 * On Windows a bare name is tried with each `PATHEXT` extension, and a name that already has one is
 * tried as given. Directories of the right name are passed over. Executability is not checked on
 * POSIX: the callers spawn the result, and a spawn reports EACCES with the path, which says more
 * than a silent skip.
 */
export function findOnPath(name: string, opts: FindOnPathOptions = {}): string | null {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const isFile = opts.isFile ?? isRegularFile
  const p = platform === 'win32' ? path.win32 : path.posix
  const rawPath = readEnv(env, 'PATH', platform) ?? ''

  let names = [name]
  if (platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(name)) {
    const exts = (readEnv(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
      .split(';').map((e) => e.trim()).filter(Boolean)
    names = exts.map((e) => `${name}${e.toLowerCase()}`)
  }

  for (const rawDir of rawPath.split(p.delimiter)) {
    // Windows PATH entries may be quoted when they contain a delimiter.
    const dir = platform === 'win32' ? rawDir.replace(/^"(.*)"$/, '$1') : rawDir
    if (!dir) continue
    for (const n of names) {
      const candidate = p.join(dir, n)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

export interface AndroidSdkCandidateOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

/**
 * Where an Android SDK may live, in lookup order: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then the
 * default location Android Studio installs to on this host. The doctor, the agent and the relay's
 * `findAapt` read the same list so they agree on which SDK is in use.
 */
export function androidSdkCandidates(opts: AndroidSdkCandidateOptions = {}): string[] {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const p = platform === 'win32' ? path.win32 : path.posix
  const defaults: string[] = []
  if (platform === 'win32') {
    // Android Studio's default on Windows: %LOCALAPPDATA%\Android\Sdk.
    const localAppData = readEnv(env, 'LOCALAPPDATA', platform) ?? p.join(home, 'AppData', 'Local')
    defaults.push(p.join(localAppData, 'Android', 'Sdk'))
  } else {
    defaults.push(p.join(home, 'Library', 'Android', 'sdk')) // macOS
    defaults.push(p.join(home, 'Android', 'Sdk')) // Linux
  }
  return [
    readEnv(env, 'ANDROID_HOME', platform),
    readEnv(env, 'ANDROID_SDK_ROOT', platform),
    ...defaults,
  ].filter((c): c is string => Boolean(c))
}
