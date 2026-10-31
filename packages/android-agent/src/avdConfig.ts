import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { FormFactor } from '@tapflowio/protocol'

/** `k=v` and `k = v` both occur in real config.ini files, with CRLF on some. */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** Images that are neither a phone nor a tablet, though their screen size would say one or the other. */
const NOT_HANDHELD = /(^|[,\s])(android-tv|google-tv|android-wear[\w-]*|wear|android-desktop|android-automotive[\w-]*)(?=$|[,\s])/

/**
 * What kind of device an AVD is, from its config.ini — or nothing when it cannot tell.
 *
 * Smallest width in dp against 600, Android's own tablet line (`sw600dp`); `hw.lcd.density` is dpi.
 * A hinge is read first, because an unfolded book-style foldable is past that line (Pixel 9 Pro Fold:
 * 2076×2152 at 390, 852 dp) — but only a large one is `foldable`. A flip unfolds to a tall phone
 * (about 360 dp) and is drawn as one, and a "Resizable" AVD carries a hinge to pose as a foldable
 * without being one, so it is read by its screen. A hinge key that says `no` is not a hinge.
 */
export function classifyAvd(cfg: Record<string, string>): FormFactor | undefined {
  if (NOT_HANDHELD.test(`${cfg['tag.id'] ?? ''},${cfg['tag.ids'] ?? ''}`)) return undefined
  const w = Number(cfg['hw.lcd.width'])
  const h = Number(cfg['hw.lcd.height'])
  const dpi = Number(cfg['hw.lcd.density'])
  if (!(w > 0 && h > 0 && dpi > 0)) return undefined
  const large = (Math.min(w, h) * 160) / dpi >= 600
  const hinge = !('hw.resizable.configs' in cfg)
    && (cfg['hw.sensor.hinge'] === 'yes' || Number(cfg['hw.sensor.hinge.count']) > 0)
  if (hinge) return large ? 'foldable' : 'phone'
  return large ? 'tablet' : 'phone'
}

/**
 * Where the emulator looks for AVDs, in its order — read from its binary, which does not consult
 * `ANDROID_USER_HOME` at all; that one is tried only before the default. Searched per name rather
 * than picking one home, so a name `emulator -list-avds` found is looked up where it came from.
 */
export function avdHomes(env: NodeJS.ProcessEnv, home: string): string[] {
  const out: string[] = []
  if (env.ANDROID_AVD_HOME) out.push(env.ANDROID_AVD_HOME)
  if (env.ANDROID_SDK_HOME) out.push(join(env.ANDROID_SDK_HOME, 'avd'), join(env.ANDROID_SDK_HOME, '.android', 'avd'))
  if (env.ANDROID_EMULATOR_HOME) out.push(join(env.ANDROID_EMULATOR_HOME, 'avd'))
  if (env.ANDROID_PREFS_ROOT) out.push(join(env.ANDROID_PREFS_ROOT, '.android', 'avd'))
  if (env.ANDROID_USER_HOME) out.push(join(env.ANDROID_USER_HOME, 'avd'))
  out.push(join(home, '.android', 'avd'))
  return out
}

interface Files {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
}
const realFiles: Files = { existsSync, readFileSync: (p, e) => readFileSync(p, e) }

/** An AVD's config.ini, parsed, or nothing when its files cannot be found or read. Never throws: it runs inside
 *  `connect()`, and a skeleton is not worth a Mac dropping out of the device list. */
export function avdConfigOf(
  avdName: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fs: Files = realFiles,
): Record<string, string> | undefined {
  try {
    for (const dir of avdHomes(env, home)) {
      const ini = join(dir, `${avdName}.ini`)
      if (!fs.existsSync(ini)) continue
      // `path=` is absolute and goes stale when a home directory is renamed or the AVDs are copied
      // over; the emulator still finds the AVD beside its .ini, so this does too.
      const named = parseIni(fs.readFileSync(ini, 'utf8')).path
      const candidates = [named, join(dir, `${avdName}.avd`)].filter((p): p is string => Boolean(p))
      const config = candidates.map((d) => join(d, 'config.ini')).find((p) => fs.existsSync(p))
      return config ? parseIni(fs.readFileSync(config, 'utf8')) : undefined
    }
  } catch {
    // Unreadable is the same as unknown.
  }
  return undefined
}

/** An AVD's form factor by name, or nothing when its files cannot be found or read. */
export function formFactorOf(
  avdName: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fs: Files = realFiles,
): FormFactor | undefined {
  const cfg = avdConfigOf(avdName, env, home, fs)
  return cfg ? classifyAvd(cfg) : undefined
}

/**
 * Android's version by API level, written the way a running emulator reports it (`getprop ro.build.version.release`,
 * which the agent prefixes with `Android `), so a device lands in the same group running or not. 32 is 12L, which
 * reports 12. A level missing here is shown as `API <n>` until a line is added.
 */
const RELEASE_BY_API: Record<number, string> = {
  21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1.1', 26: '8.0.0', 27: '8.1.0', 28: '9', 29: '10', 30: '11',
  31: '12', 32: '12', 33: '13', 34: '14', 35: '15', 36: '16',
}

/**
 * The Android version an AVD's system image carries, from its config (#1085) — so an emulator that is not running has
 * one too, where only `getprop` on a running one used to give it. `image.sysdir.1` names the image
 * (`system-images/android-34/google_apis/arm64-v8a/`); `target` (`android-34`) is the older key for the same thing.
 * A codename image (`android-VanillaIceCream`) has no level and gives nothing.
 */
export function osVersionFromConfig(cfg: Record<string, string>): string | undefined {
  const level = /(?:^|\/)android-(\d+)/.exec(cfg['image.sysdir.1'] ?? '')?.[1] ?? /^android-(\d+)/.exec(cfg['target'] ?? '')?.[1]
  if (level === undefined) return undefined
  const release = RELEASE_BY_API[Number(level)]
  return release ? `Android ${release}` : `API ${level}`
}

/** An AVD's Android version by name, from its config, or nothing when it cannot tell. */
export function osVersionOf(
  avdName: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fs: Files = realFiles,
): string | undefined {
  const cfg = avdConfigOf(avdName, env, home, fs)
  return cfg ? osVersionFromConfig(cfg) : undefined
}

/** An AVD's own directory (`<name>.avd`), or nothing when it cannot be found. Same search as `formFactorOf`. */
export function avdDirOf(avdName: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir(), fs: Files = realFiles): string | undefined {
  try {
    for (const dir of avdHomes(env, home)) {
      const ini = join(dir, `${avdName}.ini`)
      if (!fs.existsSync(ini)) continue
      const named = parseIni(fs.readFileSync(ini, 'utf8')).path
      return [named, join(dir, `${avdName}.avd`)].filter((p): p is string => Boolean(p)).find((d) => fs.existsSync(d))
    }
  } catch {
    // Unreadable is the same as not found.
  }
  return undefined
}

/**
 * Whether tapflow has already freed this AVD's rotation lock once. **Once per AVD, kept beside it**: earlier
 * tapflow versions locked the rotation (`wm user-rotation lock`) and a lock tapflow wrote cannot be told from one
 * a person chose, so the body-turning model frees it the first time it sees the AVD and leaves any later lock
 * alone. Beside the AVD rather than in a tapflow store, so a deleted or recreated AVD starts over.
 *
 * **A lock tapflow writes afterwards is tapflow's again**, so writing one forgets the AVD (`forget`): the toggle on
 * an emulator streaming without gRPC still locks, and the next gRPC session must free that lock as it freed the
 * old ones.
 */
export interface RotationLockMemory {
  freed(avdName: string): boolean
  markFreed(avdName: string): void
  forget(avdName: string): void
}

const ROTATION_FREED_MARKER = 'tapflow-rotation-freed'

export const avdRotationLockMemory: RotationLockMemory = {
  freed(avdName) {
    const dir = avdDirOf(avdName)
    // An AVD whose directory cannot be found is not one tapflow can remember freeing — so it is never freed.
    return dir === undefined || existsSync(join(dir, ROTATION_FREED_MARKER))
  },
  markFreed(avdName) {
    const dir = avdDirOf(avdName)
    if (dir) writeFileSync(join(dir, ROTATION_FREED_MARKER), `${new Date().toISOString()}\n`)
  },
  forget(avdName) {
    const dir = avdDirOf(avdName)
    if (dir) rmSync(join(dir, ROTATION_FREED_MARKER), { force: true })
  },
}
