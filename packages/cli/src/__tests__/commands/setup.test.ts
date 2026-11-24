import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

vi.mock('../../lib/setup.js', () => ({
  runSetupAndroid: vi.fn(),
  runSetupIos: vi.fn(),
}))
vi.mock('../../lib/doctor.js', () => ({
  resolveAdb: vi.fn(),
}))
vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
}))

import { runSetupAndroid, runSetupIos } from '../../lib/setup.js'
import { resolveAdb } from '../../lib/doctor.js'
import { confirm } from '@clack/prompts'
import { cmdSetup } from '../../commands/setup.js'
import { WINDOWS_ENV_WRITE_FAILED } from '../../lib/setup-android-windows.js'

const mockRunSetupAndroid = vi.mocked(runSetupAndroid)
const mockRunSetupIos = vi.mocked(runSetupIos)
const mockResolveAdb = vi.mocked(resolveAdb)
const mockConfirm = vi.mocked(confirm)

/** A whole terminal, both ends — `detectPlatforms` asks only when stdin is one too. */
function setTTY(value: boolean | undefined) {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

/** stdout is a terminal, stdin is not — `tapflow setup </dev/null`, or a script under a pty. */
function setEmptyStdin() {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
}

describe('cmdSetup', () => {
  let logLines: string[]
  let errLines: string[]
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    logLines = []
    errLines = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logLines.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => errLines.push(args.join(' ')))
    vi.spyOn(console, 'warn').mockImplementation((...args) => errLines.push(args.join(' ')))
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    mockRunSetupAndroid.mockResolvedValue([{ label: 'Homebrew installed', ok: true }])
    mockRunSetupIos.mockResolvedValue([{ label: 'Xcode installed', ok: true }])
    // **Process-wide, so it is reset around every case.** `cmdSetup` reports an incomplete run by
    // setting `process.exitCode` rather than calling `process.exit`, and vitest's workers share this
    // process — a case that left it at 1 would make the whole suite exit 1 with every test green.
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setTTY(undefined)
    process.exitCode = undefined
  })

  it('setup ios → runSetupIos만 호출', async () => {
    await cmdSetup('ios')
    expect(mockRunSetupIos).toHaveBeenCalled()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
  })

  it('setup android → runSetupAndroid만 호출 (회귀)', async () => {
    await cmdSetup('android')
    expect(mockRunSetupAndroid).toHaveBeenCalled()
    expect(mockRunSetupIos).not.toHaveBeenCalled()
  })

  it('--yes reaches runSetupAndroid only, never runSetupIos', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await cmdSetup('android', { assumeYes: true })
    expect(mockRunSetupAndroid).toHaveBeenCalledWith({ assumeYes: true })
    expect(errLines.join('\n')).not.toContain('--yes')

    await cmdSetup('ios', { assumeYes: true })
    expect(mockRunSetupIos).toHaveBeenCalledWith()
  })

  it('tells Windows to open a new terminal, without the POSIX `exec $SHELL`', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mockRunSetupAndroid.mockResolvedValue([{ label: 'Android SDK installed', ok: true, detail: 'open a new terminal to use them.' }])
    await cmdSetup('android', {})
    const out = logLines.join('\n')
    expect(out).toContain('Open a new terminal, then `tapflow doctor`')
    expect(out).not.toContain('exec $SHELL')
  })

  it('on Windows, does not say the environment was written when writing it failed', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mockRunSetupAndroid.mockResolvedValue([{ label: 'Android SDK installed', ok: true, detail: `SDK at C:\\sdk. ${WINDOWS_ENV_WRITE_FAILED}` }])
    await cmdSetup('android', {})
    const out = logLines.join('\n')
    expect(out).toContain('Open a new terminal, then `tapflow doctor`')
    expect(out).not.toMatch(/were added|was added|has added/)
  })

  it('--yes off Windows is ignored, with a warning', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await cmdSetup('android', { assumeYes: true })
    expect(errLines.join('\n')).toContain('--yes only answers')
  })

  it('인자 없음 + darwin + adb 있음 → ios와 android 둘 다', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockResolveAdb.mockReturnValue({ path: '/x/adb', inPath: true })

    await cmdSetup()
    expect(mockRunSetupIos).toHaveBeenCalled()
    expect(mockRunSetupAndroid).toHaveBeenCalled()
  })

  it.each([
    ['터미널 아님', () => setTTY(false)],
    // #807: this shape passed a `stdout.isTTY` guard and reached a prompt that never settles, so
    // `cmdSetup` never returned a platform list and the run ended at exit 0 with no banner.
    ['stdout만 터미널, stdin은 EOF', () => setEmptyStdin()],
  ])('인자 없음 + darwin + adb 없음 + 비대화형(%s) → ios만 (Android 안 물음)', async (_shape, notATerminal) => {
    notATerminal()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockResolveAdb.mockReturnValue(null)

    await cmdSetup()
    expect(mockRunSetupIos).toHaveBeenCalled()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('인자 없음 + darwin + adb 없음 + TTY + Android 수락 → 둘 다', async () => {
    setTTY(true)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockResolveAdb.mockReturnValue(null)
    mockConfirm.mockResolvedValue(true as never)

    await cmdSetup()
    expect(mockConfirm).toHaveBeenCalled()
    expect(mockRunSetupIos).toHaveBeenCalled()
    expect(mockRunSetupAndroid).toHaveBeenCalled()
  })

  it('인자 없음 + darwin + adb 없음 + TTY + Android 거절 → ios만', async () => {
    setTTY(true)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockResolveAdb.mockReturnValue(null)
    mockConfirm.mockResolvedValue(false as never)

    await cmdSetup()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
  })

  it('전부 ready면 SETUP COMPLETE 배너 + exit 없음', async () => {
    mockRunSetupIos.mockResolvedValue([{ label: 'Xcode ready', ok: true }])

    await cmdSetup('ios')
    expect(logLines.join('\n')).toContain('SETUP COMPLETE')
    expect(process.exitCode).toBeUndefined()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('미완 step 있으면 SETUP INCOMPLETE 배너 + 사유 + exitCode 1', async () => {
    mockRunSetupIos.mockResolvedValue([
      { label: 'Xcode ready', ok: true },
      { label: 'Simulator', ok: false, warn: true, detail: '...' },
    ])

    await cmdSetup('ios')
    const out = logLines.join('\n')
    expect(out).toContain('SETUP INCOMPLETE')
    expect(out).toContain('Simulator')
    // The banner and the results list still print. `exit()` is deliberately not called: killing the
    // process there drops whatever stdout still has buffered when it is a pipe.
    expect(process.exitCode).toBe(1)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it("ok인 채 warn만 붙은 step은 실패가 아니다", async () => {
    // The audio permission on a non-interactive run, and a host that is not macOS, both report this
    // shape. They are notes, not pending work, so `SETUP COMPLETE` and exit 0 are correct — the
    // filter that decides is `!r.ok`, not `r.warn`.
    mockRunSetupIos.mockResolvedValue([
      { label: 'Xcode ready', ok: true },
      { label: 'Audio permission', ok: true, warn: true, detail: '`tapflow agent start` will prompt instead.' },
    ])

    await cmdSetup('ios')
    expect(logLines.join('\n')).toContain('SETUP COMPLETE')
    expect(process.exitCode).toBeUndefined()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('플랫폼 하나만 미완이어도 exitCode 1', async () => {
    // Auto-detect runs both. The code is about the whole command, not the last platform it looked at.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockResolveAdb.mockReturnValue({ path: '/x/adb', inPath: true })
    mockRunSetupIos.mockResolvedValue([{ label: 'Xcode ready', ok: true }])
    mockRunSetupAndroid.mockResolvedValue([{ label: 'AVD', ok: false, warn: true, detail: 'No AVD found.' }])

    await cmdSetup()
    expect(mockRunSetupIos).toHaveBeenCalled()
    expect(mockRunSetupAndroid).toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('env를 방금 등록(detail에 new terminal)하면 새 터미널 안내 출력', async () => {
    mockRunSetupAndroid.mockResolvedValue([
      { label: 'Android SDK installed', ok: true, detail: 'SDK at /x. ANDROID_HOME/PATH is configured in ~/.zshrc — open a new terminal (or run: exec zsh) to use them.' },
    ])

    await cmdSetup('android')
    expect(logLines.join('\n')).toMatch(/new terminal/i)
  })

  // issue #326: ok 단계의 state를 체크 옆에 함께 출력한다.
  it('state가 있으면 체크 옆에 (found/created/repaired) 표기', async () => {
    mockRunSetupAndroid.mockResolvedValue([
      { label: 'Homebrew installed', ok: true, state: 'found' },
      { label: 'Android SDK installed', ok: true, state: 'created' },
    ])

    await cmdSetup('android')
    const out = logLines.join('\n')
    expect(out).toMatch(/Homebrew installed.*\(found\)/)
    expect(out).toMatch(/Android SDK installed.*\(created\)/)
  })

  it('state가 없는 ok 단계는 기존처럼 표기 없이 출력 (회귀)', async () => {
    mockRunSetupIos.mockResolvedValue([{ label: 'Xcode installed', ok: true }])

    await cmdSetup('ios')
    const out = logLines.join('\n')
    expect(out).toContain('Xcode installed')
    expect(out).not.toMatch(/Xcode installed.*\((found|created|repaired)\)/)
  })

  it('인자 없음 + 감지 0개 → 안내, exit 없음', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mockResolveAdb.mockReturnValue(null)

    await cmdSetup()
    expect(mockRunSetupIos).not.toHaveBeenCalled()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(errLines.join('\n')).toMatch(/no supported platform/i)
  })

  it('알 수 없는 platform → warn + exit(1)', async () => {
    await expect(cmdSetup('windows')).rejects.toThrow('process.exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errLines.join('\n')).toMatch(/platform/i)
    expect(mockRunSetupIos).not.toHaveBeenCalled()
    expect(mockRunSetupAndroid).not.toHaveBeenCalled()
  })
})
