import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { avdHomes, avdRotationLockMemory, classifyAvd, formFactorOf, osVersionFromConfig, osVersionOf, parseIni } from '../avdConfig'

// What kind of device an AVD is, read from its config.ini before it boots — the dashboard draws the
// boot skeleton from it. Fixtures are the keys that matter, copied from AVDs on a real Mac on
// 2026-10-01; the ones not measured there come from the SDK's device profiles and say so.

const PIXEL_6 = `hw.initialOrientation = portrait
hw.lcd.density = 420
hw.lcd.height = 2400
hw.lcd.width = 1080
hw.sensor.hinge = no
hw.sensor.hinge.count = 0
tag.id = google_apis
`
// The other spelling the same Mac had: no spaces around `=`, and no hinge keys at all.
const GALAXY_S23 = 'hw.initialOrientation=portrait\r\nhw.lcd.density=420\r\nhw.lcd.height=2400\r\nhw.lcd.width=1080\r\ntag.id=google_apis_playstore\r\n'
const PIXEL_9_PRO_FOLD = `hw.lcd.density = 390
hw.lcd.height = 2152
hw.lcd.width = 2076
hw.sensor.hinge = yes
hw.sensor.hinge.count = 1
tag.id = google_apis_playstore
`

const cfg = (text: string) => parseIni(text)

describe('parseIni', () => {
  it('reads both spellings, and CRLF', () => {
    expect(cfg(PIXEL_6)['hw.lcd.width']).toBe('1080')
    expect(cfg(GALAXY_S23)['hw.lcd.width']).toBe('1080')
    expect(cfg(GALAXY_S23)['tag.id']).toBe('google_apis_playstore')
  })
})

describe('classifyAvd', () => {
  // Phones measure about 411 dp across their short side.
  it('calls a phone a phone, with or without hinge keys', () => {
    expect(classifyAvd(cfg(PIXEL_6))).toBe('phone')
    expect(classifyAvd(cfg(GALAXY_S23))).toBe('phone')
  })

  // Unfolded, the Fold is 852 dp across — past the tablet line — so the hinge is read first.
  //
  // Mutation: test smallest width before the hinge. The Fold becomes a tablet.
  it('calls a book-style foldable a foldable', () => {
    expect(classifyAvd(cfg(PIXEL_9_PRO_FOLD))).toBe('foldable')
  })

  // A hinge key that is present but says no is not a hinge — three of the six measured AVDs carry one.
  // Only a large screen tells: a small one is a phone either way, since a flip is drawn as a phone.
  //
  // Mutation: treat the key's presence as a hinge. The tablet becomes a foldable.
  it('is not fooled by a hinge key that says no', () => {
    expect(classifyAvd(cfg('hw.lcd.width=1080\nhw.lcd.height=2400\nhw.lcd.density=420\nhw.sensor.hinge=no\nhw.sensor.hinge.count=0\n'))).toBe('phone')
    expect(classifyAvd(cfg('hw.lcd.width=1600\nhw.lcd.height=2560\nhw.lcd.density=320\nhw.sensor.hinge=no\nhw.sensor.hinge.count=0\n'))).toBe('tablet')
  })

  // sw600dp is Android's own tablet line. The SDK's "10.1in WXGA" profile: 1280×800 at 160 dpi.
  //
  // Mutation: compare the long side, or forget the density.
  it('calls 600 dp and up a tablet', () => {
    expect(classifyAvd(cfg('hw.lcd.width=1280\nhw.lcd.height=800\nhw.lcd.density=160\n'))).toBe('tablet')
    expect(classifyAvd(cfg('hw.lcd.width=1200\nhw.lcd.height=1920\nhw.lcd.density=320\n'))).toBe('tablet') // exactly 600
  })

  // A flip folds to a phone and unfolds to a tall phone (the SDK's "6.7in Horizontal Fold-in": 1080×2636
  // at 480 dpi, about 360 dp). Drawing it as a tablet would be further off than drawing it as a phone.
  //
  // Mutation: any hinge → foldable.
  it('calls a flip a phone', () => {
    expect(classifyAvd(cfg('hw.lcd.width=1080\nhw.lcd.height=2636\nhw.lcd.density=480\nhw.sensor.hinge=yes\nhw.sensor.hinge.count=1\n'))).toBe('phone')
  })

  // "Resizable (Experimental)" carries a hinge so it can pose as a foldable, but it is not one.
  //
  // Mutation: ignore `hw.resizable.configs`. A 411 dp resizable phone becomes a... phone anyway, so
  // the case that tells is the large one.
  it('reads a resizable AVD by its screen, not its hinge', () => {
    expect(classifyAvd(cfg('hw.lcd.width=1800\nhw.lcd.height=2400\nhw.lcd.density=240\nhw.sensor.hinge=yes\nhw.sensor.hinge.count=1\nhw.resizable.configs=phone-0-1080-2340-420\n'))).toBe('tablet')
  })

  // TV, Wear, desktop and automotive images would land on phone or tablet by size alone, and neither
  // is true. When it cannot say, it says nothing.
  //
  // Mutation: drop the tag check. The TV calls itself a phone (540 dp) and the desktop a tablet.
  it.each([
    ['android-tv', 1920, 1080, 320],
    ['google-tv', 1920, 1080, 320],
    ['android-wear', 454, 454, 320],
    ['android-wear-cn', 454, 454, 320],
    ['android-desktop', 3840, 2160, 320],
    ['android-automotive-playstore', 1024, 768, 160],
  ])('says nothing for a %s image', (tag, w, h, d) => {
    expect(classifyAvd(cfg(`hw.lcd.width=${w}\nhw.lcd.height=${h}\nhw.lcd.density=${d}\ntag.id=${tag}\n`))).toBeUndefined()
  })

  it('says nothing when the screen is not fully described', () => {
    expect(classifyAvd(cfg('hw.lcd.width=1080\nhw.lcd.height=2400\n'))).toBeUndefined()
    expect(classifyAvd(cfg('hw.lcd.width=1080\nhw.lcd.height=2400\nhw.lcd.density=abc\n'))).toBeUndefined()
  })
})

describe('avdHomes', () => {
  // The emulator's own order, read from its binary: it does not look at ANDROID_USER_HOME at all,
  // so that one only comes before the default.
  //
  // Mutation: put ANDROID_USER_HOME first, or drop ANDROID_SDK_HOME.
  it('lists the places the emulator looks, in its order', () => {
    expect(avdHomes({
      ANDROID_AVD_HOME: '/a', ANDROID_SDK_HOME: '/s', ANDROID_EMULATOR_HOME: '/e',
      ANDROID_PREFS_ROOT: '/p', ANDROID_USER_HOME: '/u',
    }, '/h')).toEqual(['/a', '/s/avd', '/s/.android/avd', '/e/avd', '/p/.android/avd', '/u/avd', '/h/.android/avd'])
    expect(avdHomes({}, '/h')).toEqual(['/h/.android/avd'])
  })
})

describe('formFactorOf', () => {
  const files = (map: Record<string, string>) => ({
    existsSync: (p: string) => p in map,
    readFileSync: (p: string) => { if (!(p in map)) throw new Error('ENOENT'); return map[p] },
  })

  it('follows the .ini to the AVD directory, in the first home that has it', () => {
    const fs = files({
      '/e/avd/Fold.ini': 'path=/elsewhere/Fold.avd\n',
      '/elsewhere/Fold.avd/config.ini': PIXEL_9_PRO_FOLD,
      '/h/.android/avd/Fold.ini': 'path=/wrong/Fold.avd\n',
      '/wrong/Fold.avd/config.ini': PIXEL_6,
    })
    expect(formFactorOf('Fold', { ANDROID_EMULATOR_HOME: '/e' }, '/h', fs)).toBe('foldable')
  })

  it('falls back to <home>/<name>.avd when the .ini names no path', () => {
    const fs = files({ '/h/.android/avd/P6.ini': 'target=android-34\n', '/h/.android/avd/P6.avd/config.ini': PIXEL_6 })
    expect(formFactorOf('P6', {}, '/h', fs)).toBe('phone')
  })

  // Mutation: trust `path=` alone. A stale absolute path — a renamed home directory — then reports
  // nothing for an AVD the emulator still boots from beside its .ini.
  it('finds the AVD beside its .ini when `path=` has gone stale', () => {
    const fs = files({ '/h/.android/avd/P6.ini': 'path=/Users/old-name/.android/avd/P6.avd\n', '/h/.android/avd/P6.avd/config.ini': PIXEL_6 })
    expect(formFactorOf('P6', {}, '/h', fs)).toBe('phone')
  })

  // Mutation: let a read error escape. connect() would then fail for the whole Mac over a skeleton.
  it('says nothing, without throwing, when the files are not there', () => {
    expect(formFactorOf('Ghost', {}, '/h', files({}))).toBeUndefined()
    expect(formFactorOf('NoConfig', {}, '/h', files({ '/h/.android/avd/NoConfig.ini': 'path=/x\n' }))).toBeUndefined()
  })
})

// Freed once per AVD, remembered beside it — a recreated AVD starts over. Mutations: keep it anywhere else;
// treat an AVD that cannot be found as one to free (it would be freed on every boot, with nowhere to remember).
describe('avdRotationLockMemory', () => {
  const saved = process.env.ANDROID_AVD_HOME
  let home = ''
  afterEach(() => {
    if (saved === undefined) delete process.env.ANDROID_AVD_HOME
    else process.env.ANDROID_AVD_HOME = saved
    if (home) rmSync(home, { recursive: true, force: true })
  })
  it('remembers freeing an AVD beside it, and never frees one it cannot find', () => {
    home = mkdtempSync(join(tmpdir(), 'tapflow-avd-'))
    process.env.ANDROID_AVD_HOME = home
    mkdirSync(join(home, 'Pixel.avd'))
    writeFileSync(join(home, 'Pixel.ini'), `path=${join(home, 'Pixel.avd')}\n`)
    expect(avdRotationLockMemory.freed('Pixel')).toBe(false)
    avdRotationLockMemory.markFreed('Pixel')
    expect(avdRotationLockMemory.freed('Pixel')).toBe(true)
    expect(avdRotationLockMemory.freed('Missing')).toBe(true)
    // A lock tapflow writes later is tapflow's again. Mutation: forget nothing.
    avdRotationLockMemory.forget('Pixel')
    expect(avdRotationLockMemory.freed('Pixel')).toBe(false)
    avdRotationLockMemory.forget('Missing')
  })
})

// #1085: an emulator that is not running has a version too, from the image it was built on.
describe('osVersionFromConfig', () => {
  it('reads the API level off the system image and writes it as a running emulator reports it', () => {
    expect(osVersionFromConfig({ 'image.sysdir.1': 'system-images/android-34/google_apis/arm64-v8a/' })).toBe('Android 14')
    expect(osVersionFromConfig({ 'image.sysdir.1': 'system-images/android-35/google_apis_playstore/arm64-v8a/' })).toBe('Android 15')
    // 12L reports 12 when running, so it groups with 12.
    expect(osVersionFromConfig({ 'image.sysdir.1': 'system-images/android-32/google_apis/arm64-v8a/' })).toBe('Android 12')
  })

  it('falls back to the older target key', () => {
    expect(osVersionFromConfig({ target: 'android-33' })).toBe('Android 13')
  })

  it('names a level it has no release for by its number', () => {
    expect(osVersionFromConfig({ 'image.sysdir.1': 'system-images/android-99/google_apis/arm64-v8a/' })).toBe('API 99')
  })

  it('gives nothing for a codename image or no image', () => {
    expect(osVersionFromConfig({ 'image.sysdir.1': 'system-images/android-VanillaIceCream/google_apis/arm64-v8a/' })).toBeUndefined()
    expect(osVersionFromConfig({})).toBeUndefined()
  })

  it('is found by AVD name the way the form factor is', () => {
    const fs = {
      existsSync: (p: string) => ['/h/.android/avd/P.ini', '/h/.android/avd/P.avd/config.ini'].includes(p),
      readFileSync: (p: string) => (p.endsWith('P.ini') ? '' : 'image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\n'),
    }
    expect(osVersionOf('P', {}, '/h', fs)).toBe('Android 16')
    expect(osVersionOf('Missing', {}, '/h', fs)).toBeUndefined()
  })
})
