import { describe, it, expect, vi } from 'vitest'
import { PlatformError, ValidationError } from '@tapflowio/agent-core'
import { AdbWrapper } from '../AdbWrapper'
import type { AdbRunner } from '../adb'

function mockRunner(responses: {
  devices?: string
  avds?: string[]
  avdName?: string
  osVersion?: string
  screenSize?: string
  uiDump?: string
} = {}): AdbRunner {
  return {
    exec: vi.fn(async (...args: string[]) => {
      if (args[0] === 'devices') {
        return responses.devices ?? 'List of devices attached\n'
      }
      if (args.includes('emu') && args.includes('avd') && args.includes('name')) {
        return `${responses.avdName ?? ''}\nOK\n`
      }
      if (args.includes('ro.build.version.release')) {
        return `${responses.osVersion ?? '14'}\n`
      }
      if (args.includes('wm') && args.includes('size')) {
        return `Physical size: ${responses.screenSize ?? '1080x2400'}\n`
      }
      if (args.includes('uiautomator')) {
        return responses.uiDump ?? ''
      }
      return ''
    }),
    execBinary: vi.fn().mockResolvedValue(Buffer.from('PNG')),
    listAvds: vi.fn().mockResolvedValue(responses.avds ?? []),
  }
}

describe('AdbWrapper', () => {
  // #1085. The periodic re-read must not move the serial map a boot is relying on.
  describe('peekDevices', () => {
    it('lists what listDevices lists without touching the serial map', async () => {
      const runner = mockRunner({
        avds: ['Pixel_8_API_34', 'Pixel_9'],
        devices: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: 'Pixel_8_API_34',
        osVersion: '14',
      })
      const wrapper = new AdbWrapper(runner)
      // A boot that set its serial before adb lists the emulator.
      wrapper.setSerial('avd:Pixel_9', 'emulator-5556')
      const peeked = await wrapper.peekDevices()
      expect(peeked).toEqual([
        { id: 'avd:Pixel_8_API_34', name: 'Pixel_8_API_34', platform: 'android', status: 'booted', osVersion: 'Android 14' },
        { id: 'avd:Pixel_9', name: 'Pixel_9', platform: 'android', status: 'shutdown', osVersion: undefined },
      ])
      expect(wrapper.getSerial('avd:Pixel_9')).toBe('emulator-5556')
      expect(wrapper.getSerial('avd:Pixel_8_API_34')).toBeUndefined()
      // The syncing one, for contrast: it drops the serial adb does not list and adds the one it does.
      expect(await wrapper.listDevices()).toEqual(peeked)
      expect(wrapper.getSerial('avd:Pixel_9')).toBeUndefined()
      expect(wrapper.getSerial('avd:Pixel_8_API_34')).toBe('emulator-5554')
    })
  })

  // A re-read runs one at a time, so a call stuck on a wedged emulator must be killed, not waited on.
  it('bounds every adb call of a re-read', async () => {
    const runner = mockRunner({
      avds: ['Pixel_8_API_34'],
      devices: 'List of devices attached\nemulator-5554\tdevice\n',
      avdName: 'Pixel_8_API_34',
    })
    const bounded = vi.fn((_ms: number, ...args: string[]) => runner.exec(...args))
    const wrapper = new AdbWrapper({ ...runner, execBounded: bounded })
    const exec = runner.exec as ReturnType<typeof vi.fn>
    exec.mockClear()
    expect((await wrapper.peekDevices())[0]).toMatchObject({ status: 'booted', osVersion: 'Android 14' })
    expect(bounded.mock.calls.map((c) => [c[0], c[1]])).toEqual([[10_000, 'devices'], [10_000, '-s'], [10_000, '-s']])
    // Every call went through the bounded one; `exec` ran only beneath the test double.
    expect(exec).toHaveBeenCalledTimes(3)
  })

  describe('listDevices', () => {
    it('returns empty array when no AVDs exist', async () => {
      const wrapper = new AdbWrapper(mockRunner({ avds: [] }))
      expect(await wrapper.listDevices()).toEqual([])
    })

    it('returns shutdown device when AVD exists but emulator not running', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\n',
      }))
      const devices = await wrapper.listDevices()
      expect(devices).toHaveLength(1)
      expect(devices[0]).toMatchObject({
        id: 'avd:Pixel_8_API_34',
        name: 'Pixel_8_API_34',
        platform: 'android',
        status: 'shutdown',
      })
    })

    it('returns booted device when emulator is running and AVD name matches', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: 'Pixel_8_API_34',
        osVersion: '14',
      }))
      const devices = await wrapper.listDevices()
      expect(devices).toHaveLength(1)
      expect(devices[0]).toMatchObject({
        id: 'avd:Pixel_8_API_34',
        status: 'booted',
        osVersion: 'Android 14',
      })
    })

    it('uses avd: prefix as stable id regardless of serial', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5556\tdevice\n',
        avdName: 'Pixel_8_API_34',
      }))
      const devices = await wrapper.listDevices()
      expect(devices[0].id).toBe('avd:Pixel_8_API_34')
    })

    it('tracks serial in serialMap after listDevices', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: 'Pixel_8_API_34',
      }))
      await wrapper.listDevices()
      expect(wrapper.getSerial('avd:Pixel_8_API_34')).toBe('emulator-5554')
    })

    it('clears stale serial when emulator is no longer running', async () => {
      const wrapper = new AdbWrapper(mockRunner({
        avds: ['Pixel_8_API_34'],
        devices: 'List of devices attached\nemulator-5554\tdevice\n',
        avdName: 'Pixel_8_API_34',
      }))
      await wrapper.listDevices()
      expect(wrapper.getSerial('avd:Pixel_8_API_34')).toBe('emulator-5554')

      // Emulator shuts down externally
      const runner2 = mockRunner({ avds: ['Pixel_8_API_34'], devices: 'List of devices attached\n' })
      const wrapper2 = new AdbWrapper(runner2)
      wrapper2.setSerial('avd:Pixel_8_API_34', 'emulator-5554')
      await wrapper2.listDevices()
      expect(wrapper2.getSerial('avd:Pixel_8_API_34')).toBeUndefined()
    })
  })

  describe('installApp', () => {
    it('calls adb install -r with serial and path', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.installApp('emulator-5554', '/tmp/app.apk')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'install', '-r', '/tmp/app.apk')
    })

    it('throws ValidationError when adb returns INSTALL_FAILED code', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
        stderr: 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]',
      })
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.installApp('emulator-5554', '/tmp/app.apk')).rejects.toThrow(
        new ValidationError('INSTALL_FAILED_VERSION_DOWNGRADE'),
      )
    })

    // The message measured on a Play Store AVD whose /data had filled with Google app updates,
    // set in adb's stderr shape (prefix and a stack frame) so the stripping is exercised too.
    const STREAMED_FULL =
      "adb: failed to install /tmp/app.apk: Exception occurred while executing 'install':\n" +
      'android.os.ParcelableException: java.io.IOException: Requested internal only, but not enough space\n' +
      '\tat android.util.ExceptionUtils.wrap(ExceptionUtils.java:34)\n'

    it.each([
      ['a streamed install', STREAMED_FULL],
      ['a Failure code', 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]'],
      // Not observed: the expected shape of a write that runs out after the size pre-check passed.
      ['a write that ran out mid-install', 'adb: failed to install /tmp/app.apk: java.io.IOException: write failed: ENOSPC (No space left on device)'],
    ])('explains a full device for %s instead of passing the raw error through', async (_, stderr) => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ stderr })
      const wrapper = new AdbWrapper(runner)
      const err = await wrapper.installApp('emulator-5554', '/tmp/app.apk').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as Error).message).toMatch(/^Device storage is full/)
      expect((err as Error).message).toContain('Full reset')
      expect((err as Error).message).toContain('disk.dataPartition.size')
    })

    it('does not read a full device into a build whose name has a colon before the mention', async () => {
      const runner = mockRunner()
      const apk = '/tmp/x/1-ab_fix:ENOSPC.apk'
      ;(runner.exec as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
        stderr: `adb: failed to install ${apk}: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]`,
      })
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.installApp('emulator-5554', apk)).rejects.toThrow(
        new ValidationError('INSTALL_FAILED_VERSION_DOWNGRADE'),
      )
    })

    it('does not read a full device into a build whose name mentions one', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
        stderr: 'adb: failed to install /tmp/fix-ENOSPC-not-enough-space.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]',
      })
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.installApp('emulator-5554', '/tmp/app.apk')).rejects.toThrow(
        new ValidationError('INSTALL_FAILED_VERSION_DOWNGRADE'),
      )
    })
  })

  describe('system app updates', () => {
    it('reads an update from a /data/app code path', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        'package:/data/app/~~F4n8==/com.google.android.apps.wellbeing-Na84==/base.apk\n' +
        'package:/data/app/~~F4n8==/com.google.android.apps.wellbeing-Na84==/split_config.xxhdpi.apk\n',
      )
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.hasSystemUpdates('emulator-5554', 'com.google.android.apps.wellbeing')).resolves.toBe(true)
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'pm', 'path', 'com.google.android.apps.wellbeing')
    })

    it('reads no update from a /product code path', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockResolvedValueOnce('package:/product/app/YouTube/YouTube.apk\n')
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.hasSystemUpdates('emulator-5554', 'com.google.android.youtube')).resolves.toBe(false)
    })

    // Measured: `pm` prints Success and exits 1, so adb's exit status rejects the call.
    it('treats Success on a non-zero exit as success', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error('Command failed: adb shell pm uninstall-system-updates'), {
          code: 1,
          stdout: 'Uninstalling updates to com.google.android.youtube...\nSuccess\n',
        }),
      )
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.uninstallSystemUpdates('emulator-5554', 'com.google.android.youtube')).resolves.toBeUndefined()
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'pm', 'uninstall-system-updates', 'com.google.android.youtube')
    })

    it('fails when pm does not say Success', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error('Command failed'), { code: 255, stdout: "\nException occurred while executing 'uninstall-system-updates':\n" }),
      )
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.uninstallSystemUpdates('emulator-5554', 'com.example.nope')).rejects.toBeInstanceOf(PlatformError)
    })

    it('fails on a zero exit without Success', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockResolvedValueOnce('Failure\n')
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.uninstallSystemUpdates('emulator-5554', 'com.google.android.youtube')).rejects.toBeInstanceOf(PlatformError)
    })
  })

  describe('launchApp', () => {
    const PKG = 'com.example.app'
    const START_FIELDS = ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-f', '0x10200000']
    // Answers each adb call by what it runs, so a test names the device's replies rather than their order.
    const launcher = (replies: { resolve?: string | Error; start?: string | Error; monkey?: string | Error }): AdbRunner => ({
      exec: vi.fn(async (...args: string[]) => {
        const reply = args.includes('resolve-activity') ? replies.resolve
          : args.includes('am') ? replies.start
            : args.includes('monkey') ? replies.monkey : ''
        if (reply instanceof Error) throw reply
        return reply ?? ''
      }),
      execBinary: vi.fn(),
      listAvds: vi.fn(async () => []),
    })
    const ran = (runner: AdbRunner, what: string) => vi.mocked(runner.exec).mock.calls.filter((c) => c.includes(what))
    const RESOLVED = 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\ncom.example.app/.MainActivity\n'
    const STARTED = 'Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10200000 cmp=com.example.app/.MainActivity }\nStatus: ok\nLaunchState: COLD\nActivity: com.example.app/.MainActivity\nTotalTime: 485\nWaitTime: 495\nComplete\n'

    it('starts the resolved launcher activity and waits for its first frame, as the launcher would', async () => {
      const runner = launcher({ resolve: RESOLVED, start: STARTED })
      await new AdbWrapper(runner).launchApp('emulator-5554', PKG)
      expect(ran(runner, 'am')).toEqual([[
        '-s', 'emulator-5554', 'shell', 'timeout', '10', 'am', 'start', '-W', ...START_FIELDS, '-n', 'com.example.app/.MainActivity', '2>&1',
      ]])
      expect(ran(runner, 'resolve-activity')[0]!.slice(0, 5)).toEqual(['-s', 'emulator-5554', 'shell', 'timeout', '3'])
      expect(ran(runner, 'monkey')).toHaveLength(0)
    })

    it.each([
      ['the app was already running', 'Warning: Activity not started, its current task has been brought to the front\n'],
      ['the app was slow to draw', 'Starting: Intent { cmp=com.example.app/.MainActivity }\nStatus: timeout\nComplete\n'],
    ])('counts it launched when %s, and does not launch it a second time', async (_, start) => {
      const runner = launcher({ resolve: RESOLVED, start })
      await new AdbWrapper(runner).launchApp('emulator-5554', PKG)
      expect(ran(runner, 'monkey')).toHaveLength(0)
    })

    it('counts it launched when the device-side timeout ends the wait after the intent went out', async () => {
      const expired = Object.assign(new Error('Command failed: adb … exit 124'), { stdout: 'Starting: Intent { cmp=com.example.app/.MainActivity }\n' })
      const runner = launcher({ resolve: RESOLVED, start: expired })
      await new AdbWrapper(runner).launchApp('emulator-5554', PKG)
      expect(ran(runner, 'monkey')).toHaveLength(0)
    })

    it.each([
      ['am start reports an error', { resolve: RESOLVED, start: 'Starting: Intent { cmp=com.example.app/.MainActivity }\nError type 3\nError: Activity class {com.example.app/.MainActivity} does not exist.\n' }],
      ['am start fails before starting anything', { resolve: RESOLVED, start: new Error('adb: device offline') }],
      ['two launcher activities resolve to the system chooser', { resolve: 'priority=0\nandroid/com.android.internal.app.ResolverActivity\n' }],
      ['no launcher activity resolves', { resolve: 'No activity found\n' }],
      ['the image has no cmd package', { resolve: new Error('cmd: Can\'t find service: package') }],
      ['the class name would be expanded by the device shell', { resolve: 'com.example.app/.Main$Inner\n' }],
      ['another package answers', { resolve: 'com.example.app.evil/.MainActivity\n' }],
    ])('falls back to monkey when %s', async (_, replies) => {
      const runner = launcher(replies)
      await new AdbWrapper(runner).launchApp('emulator-5554', PKG)
      expect(ran(runner, 'monkey')).toEqual([[
        '-s', 'emulator-5554', 'shell', 'monkey', '--pct-syskeys', '0',
        '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1',
      ]])
    })

    // monkey gives 2% of its events to system keys by default, and on a device with no physical
    // system keys (an AVD with hw.mainKeys=no) it aborts with exit 251 before sending any event,
    // launch included. Asserted apart from the full argument list so a rewrite that drops it, or
    // moves it after the count where monkey no longer reads options, fails here.
    it('sets the system-key share to zero so monkey runs on a device with no physical keys', async () => {
      const runner = launcher({ resolve: 'No activity found\n' })
      await new AdbWrapper(runner).launchApp('emulator-5554', PKG)
      const args = ran(runner, 'monkey')[0]!
      const i = args.indexOf('--pct-syskeys')
      expect(i).toBeGreaterThan(args.indexOf('monkey'))
      expect(i).toBeLessThan(args.indexOf('-p'))
      expect(args[i + 1]).toBe('0')
    })

    // #1047. A launch carrying arguments restarts the app in the same command and never falls back to monkey, which
    // cannot carry extras; both warnings the plain launch counts as launched mean the extras were not delivered.
    describe('with launch arguments', () => {
      const ARGS = { FIRDebugEnabled: true, port: 8080, big: 3_000_000_000, host: "a'b; echo x", langs: ['en', 'ko'] }

      it('stops and starts the launcher activity with typed, shell-quoted extras', async () => {
        const runner = launcher({ resolve: RESOLVED, start: STARTED })
        await new AdbWrapper(runner).launchApp('emulator-5554', PKG, { arguments: ARGS })
        expect(ran(runner, 'am')).toEqual([[
          '-s', 'emulator-5554', 'shell', 'timeout', '10', 'am', 'start', '-S', '-W', ...START_FIELDS, '-n', 'com.example.app/.MainActivity',
          '--ez', "'FIRDebugEnabled'", 'true', '--ei', "'port'", '8080', '--el', "'big'", '3000000000',
          '--es', "'host'", "'a'\\''b; echo x'", '--esa', "'langs'", "'en,ko'", '2>&1',
        ]])
        expect(ran(runner, 'monkey')).toHaveLength(0)
      })

      it.each([
        ['the app was already running', 'Warning: Activity not started, its current task has been brought to the front\n'],
        ['the intent went to a running instance', 'Warning: Activity not started, intent has been delivered to currently running top-most instance.\n'],
        ['am start reports an error', 'Starting: Intent { cmp=com.example.app/.MainActivity }\nError: Activity class {com.example.app/.MainActivity} does not exist.\n'],
        ['am cannot parse an extra', '\nException occurred while executing \'start\':\njava.lang.NumberFormatException: For input string: "x"\n'],
      ])('fails when %s', async (_, start) => {
        const runner = launcher({ resolve: RESOLVED, start })
        await expect(new AdbWrapper(runner).launchApp('emulator-5554', PKG, { arguments: ARGS })).rejects.toThrow(/Activity not started|Error|Exception/)
        expect(ran(runner, 'monkey')).toHaveLength(0)
      })

      // The cause is what the agent logs. Node's exec error carries the whole argv in its message and `cmd`, and an
      // argument value can be a token.
      it('keeps argument values out of the cause when adb fails before the intent went out', async () => {
        const failed = Object.assign(new Error("Command failed: adb -s emulator-5554 shell … --es 'token' 'sekrit'"), { cmd: "adb … 'sekrit'", stderr: 'error: closed\n', stdout: '' })
        const runner = launcher({ resolve: RESOLVED, start: failed })
        const e = await new AdbWrapper(runner).launchApp('emulator-5554', PKG, { arguments: { token: 'sekrit' } }).catch((x: unknown) => x) as Error
        expect(e.message).toBe('adb did not finish the launch')
        expect(String((e.cause as Error).message)).toBe('error: closed')
        expect(JSON.stringify({ m: e.message, c: (e.cause as Error).message, k: (e.cause as { cmd?: string }).cmd })).not.toContain('sekrit')
      })

      it('fails instead of falling back to monkey when no single launcher activity resolves', async () => {
        const runner = launcher({ resolve: 'No activity found\n' })
        await expect(new AdbWrapper(runner).launchApp('emulator-5554', PKG, { arguments: ARGS })).rejects.toThrow(/launcher activity/)
        expect(ran(runner, 'monkey')).toHaveLength(0)
      })

      it('refuses env before running anything', async () => {
        const runner = launcher({ resolve: RESOLVED, start: STARTED })
        await expect(new AdbWrapper(runner).launchApp('emulator-5554', PKG, { env: { API_HOST: 'x' } })).rejects.toThrow(/env is iOS-only/)
        expect(runner.exec).not.toHaveBeenCalled()
      })

      // The relay's per-app defaults with no caller options (#1047, PR 2): a default written for automation must not
      // break the plain Launch on an app it does not fit, so what cannot be delivered is left out instead.
      describe('defaults only', () => {
        it('delivers them like a caller\'s, resolving the launcher activity once', async () => {
          const runner = launcher({ resolve: RESOLVED, start: STARTED })
          const applied = await new AdbWrapper(runner).launchApp('emulator-5554', PKG, { arguments: { flag: true } }, true)
          expect(applied).toEqual({ arguments: { flag: true } })
          expect(ran(runner, 'am')[0]).toContain('-S')
          expect(ran(runner, 'resolve-activity')).toHaveLength(1)
        })

        it('launches without them through monkey when no single launcher activity resolves', async () => {
          const runner = launcher({ resolve: 'android/com.android.internal.app.ResolverActivity\n' })
          const applied = await new AdbWrapper(runner).launchApp('emulator-5554', PKG, { arguments: { flag: true } }, true)
          expect(applied).toBeUndefined()
          expect(ran(runner, 'monkey')).toHaveLength(1)
          expect(ran(runner, 'resolve-activity')).toHaveLength(1)
        })

        it('leaves env out instead of refusing, and launches plainly when nothing else is left', async () => {
          const runner = launcher({ resolve: RESOLVED, start: STARTED })
          const applied = await new AdbWrapper(runner).launchApp('emulator-5554', PKG, { env: { A: '1' } }, true)
          expect(applied).toBeUndefined()
          expect(ran(runner, 'am')[0]).not.toContain('-S')
          expect(ran(runner, 'resolve-activity')).toHaveLength(1)
        })

        it('still fails when the app itself does not start', async () => {
          const runner = launcher({ resolve: RESOLVED, start: 'Starting: Intent { cmp=com.example.app/.MainActivity }\nError: Activity class {com.example.app/.MainActivity} does not exist.\n' })
          await expect(new AdbWrapper(runner).launchApp('emulator-5554', PKG, { arguments: { flag: true } }, true)).rejects.toThrow(/Error/)
        })
      })

      it('treats empty option maps as a plain launch', async () => {
        const runner = launcher({ resolve: RESOLVED, start: STARTED })
        await new AdbWrapper(runner).launchApp('emulator-5554', PKG, { arguments: {}, env: {} })
        expect(ran(runner, 'am')[0]).not.toContain('-S')
      })
    })
  })

  // The launch failure reaches a dashboard toast, and node's message for a failed adb call leads with the
  // argv — the host's SDK path, the serial, the package — followed by monkey echoing its own arguments on
  // stderr. Shapes below are the real ones, captured from a Pixel_9_tapflow emulator (API 34).
  describe('launchApp failure reason', () => {
    const ARGV = 'Command failed: /Users/someone/Library/Android/sdk/platform-tools/adb -s emulator-5554 shell monkey --pct-syskeys 0 -p com.example.app -c android.intent.category.LAUNCHER 1'
    const ECHO = 'args: [--pct-syskeys, 0, -p, com.example.app, -c, android.intent.category.LAUNCHER, 1]\n arg: "-p"\n arg: "com.example.app"\ndata="com.example.app"\ndata="android.intent.category.LAUNCHER"'
    const failing = (message: string): AdbRunner => ({
      exec: vi.fn(async () => { throw new Error(message) }),
      execBinary: vi.fn(),
      listAvds: vi.fn(async () => []),
    })
    const reasonFor = async (message: string): Promise<string> => {
      const e = await new AdbWrapper(failing(message)).launchApp('emulator-5554', 'com.example.app').catch((x: unknown) => x)
      expect(e).toBeInstanceOf(PlatformError)
      return (e as Error).message
    }

    it('names monkey\'s own diagnostic line', async () => {
      expect(await reasonFor(`${ARGV}\n${ECHO}\n** SYS_KEYS has no physical keys but with factor 2.0%.\n`))
        .toBe('SYS_KEYS has no physical keys but with factor 2.0%.')
    })

    it('names adb\'s own error line', async () => {
      expect(await reasonFor(`${ARGV}\nadb: device 'emulator-5554' not found\n`))
        .toBe("adb: device 'emulator-5554' not found")
    })

    // A package with no launchable activity: monkey prints its "No activities found" line to stdout, which
    // the error does not carry, so stderr holds nothing but the echo.
    it('says what it could not launch when stderr is only the argument echo', async () => {
      expect(await reasonFor(`${ARGV}\n${ECHO}\n`)).toBe('No launchable activity found for com.example.app')
    })

    // Without monkey's echo, monkey may never have run — adb killed mid-call, or adb not spawned at all —
    // so nothing says the app had nothing to launch.
    it('does not blame the app when there is no sign monkey ran', async () => {
      expect(await reasonFor(`${ARGV}\n`)).toBe('adb did not finish the launch')
      expect(await reasonFor('spawn /Users/someone/Library/Android/sdk/platform-tools/adb ENOENT')).toBe('adb did not finish the launch')
    })

    it('never carries the argv or the host path', async () => {
      for (const m of [`${ARGV}\n${ECHO}\n`, `${ARGV}\n`, 'spawn /Users/someone/Library/Android/sdk/platform-tools/adb ENOENT']) {
        const reason = await reasonFor(m)
        expect(reason).not.toContain('Command failed')
        expect(reason).not.toContain('/Users/')
      }
    })
  })

  describe('getScreenSize', () => {
    it('parses wm size output correctly', async () => {
      const wrapper = new AdbWrapper(mockRunner({ screenSize: '1080x2400' }))
      const size = await wrapper.getScreenSize('emulator-5554')
      expect(size).toEqual({ width: 1080, height: 2400 })
    })

    it('throws PlatformError when wm size output is malformed', async () => {
      const wrapper = new AdbWrapper(mockRunner({ screenSize: 'unknown' }))
      await expect(wrapper.getScreenSize('emulator-5554')).rejects.toBeInstanceOf(PlatformError)
    })
  })

  describe('serial map', () => {
    it('setSerial / getSerial / clearSerial work correctly', () => {
      const wrapper = new AdbWrapper(mockRunner())
      wrapper.setSerial('avd:Pixel_8', 'emulator-5554')
      expect(wrapper.getSerial('avd:Pixel_8')).toBe('emulator-5554')
      wrapper.clearSerial('avd:Pixel_8')
      expect(wrapper.getSerial('avd:Pixel_8')).toBeUndefined()
    })
  })

  describe('openUrl', () => {
    it('calls adb shell am start with VIEW intent and url', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.openUrl('emulator-5554', 'myapp://home')
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'am', 'start',
        '-a', 'android.intent.action.VIEW', '-d', 'myapp://home',
      )
    })
  })

  // The console's accelerometer, as `emu sensor get acceleration` printed it on Pixel_9_API_36 for each
  // `emu rotate` (measured): gravity +9.81 on the axis pointing up. Mutations: swap the landscapes; read an
  // axis below the threshold as a turn.
  describe('readBodyRotation', () => {
    const at = async (out: string) => {
      const runner = mockRunner()
      vi.mocked(runner.exec).mockResolvedValue(out)
      return new AdbWrapper(runner).readBodyRotation('emulator-5554')
    }
    it('reads the four quarters the emulator turns through', async () => {
      expect(await at('acceleration = 0:9.77631:0.812349\r\nOK')).toBe(0)
      expect(await at('acceleration = -9.81:-1.90735e-06:0')).toBe(90)
      expect(await at('acceleration = -8.57617e-07:-9.81:0')).toBe(180)
      expect(await at('acceleration = 9.81:-1.90735e-06:0')).toBe(270)
    })
    it('gives no answer lying flat, or for output it cannot read', async () => {
      expect(await at('acceleration = 0:0:9.81')).toBeNull()
      expect(await at('KO: unknown command')).toBeNull()
    })
  })

  describe('rotateBodyClockwise / freeRotation', () => {
    it('turns the body through the console and refuses a KO', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.rotateBodyClockwise('emulator-5554')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'emu', 'rotate')
      vi.mocked(runner.exec).mockResolvedValueOnce('KO: not an emulator')
      await expect(wrapper.rotateBodyClockwise('emulator-5554')).rejects.toThrow('emu rotate refused')
    })
    it('frees the rotation lock', async () => {
      const runner = mockRunner()
      await new AdbWrapper(runner).freeRotation('emulator-5554')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'wm', 'user-rotation', 'free')
    })
  })

  describe('setRotation', () => {
    it('locks display to landscape via wm user-rotation', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.setRotation('emulator-5554', 3)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'wm', 'user-rotation', 'lock', '3',
      )
    })

    it('locks display back to portrait via wm user-rotation', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.setRotation('emulator-5554', 0)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'wm', 'user-rotation', 'lock', '0',
      )
    })

    // Legacy `settings put system user_rotation` is silently ignored on newer Android
    // (API 37): the display does not rotate, only a rotation-suggestion appears. wm
    // user-rotation lock works on API 34 and 37, and locks regardless of auto-rotate,
    // so the legacy settings writes are dropped entirely.
    it('does not use legacy settings user_rotation / accelerometer_rotation', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.setRotation('emulator-5554', 3)
      const calls = (runner.exec as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.every((c) => !c.includes('user_rotation') && !c.includes('accelerometer_rotation'))).toBe(true)
    })
  })

  // Outputs measured on API 34 (`Pixel_9_tapflow`, 2026-10-02).
  //
  // Mutation: read anything unrecognised as `free`. The boot would then leave a landscape lock alone.
  describe('getUserRotation', () => {
    const reading = (out: string) => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockResolvedValue(out)
      return new AdbWrapper(runner).getUserRotation('emulator-5554')
    }

    it('reads free and each lock', async () => {
      await expect(reading('free\n')).resolves.toEqual({ mode: 'free' })
      await expect(reading('lock 3\n')).resolves.toEqual({ mode: 'lock', rotation: 3 })
      await expect(reading('lock 0')).resolves.toEqual({ mode: 'lock', rotation: 0 })
    })

    it('refuses an answer it cannot read', async () => {
      await expect(reading('Error: argument needs to be either -d, free or lock.')).rejects.toThrow(/rotation lock/)
      await expect(reading('')).rejects.toThrow(/rotation lock/)
    })
  })

  describe('inputText', () => {
    it('sends `input text` with spaces encoded as %s', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.inputText('emulator-5554', 'user@example.com pw')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'input', 'text', 'user@example.com%spw')
    })

    it('backslash-escapes shell metacharacters', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.inputText('emulator-5554', 'a(b)&c;d')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'input', 'text', 'a\\(b\\)\\&c\\;d')
    })

    it('escapes a literal % so it is not re-expanded as %s (space)', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await wrapper.inputText('emulator-5554', '50% off')
      // % → \% (literal), space → %s
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'input', 'text', '50\\%%soff')
    })

    it('rejects non-ASCII text instead of silently typing nothing', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.inputText('emulator-5554', '안녕')).rejects.toThrow(PlatformError)
      expect(runner.exec).not.toHaveBeenCalled()
    })
  })

  describe('sendKeyCombination', () => {
    it('presses the keys together with `input keycombination`, in order', async () => {
      const runner = mockRunner()
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.sendKeyCombination('emulator-5554', ['59', '21'])).resolves.toBe(true)
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'input', 'keycombination', '59', '21', '2>&1')
    })

    // Measured on an API 28 AVD: the command is unknown, `input` prints its usage to stderr, and the
    // shell still exits 0 — so the redirected output is the only thing that says nothing was pressed.
    it('answers false where `input` does not know the command, though adb exits 0', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockResolvedValue(
        'Error: Unknown command: keycombination\nUsage: input [<source>] <command> [<arg>...]\n',
      )
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.sendKeyCombination('emulator-5554', ['59', '21'])).resolves.toBe(false)
    })

    // Measured exit 0 on API 28 only. An `input` that exits non-zero rejects, with the usage text on
    // the error's stdout — still "cannot hold a modifier", not a dispatch that failed.
    it('answers false where the unknown command exits non-zero', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('Command failed'), { stdout: 'Error: Unknown command: keycombination\n' }),
      )
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.sendKeyCombination('emulator-5554', ['59', '21'])).resolves.toBe(false)
    })

    it('rejects when adb itself fails', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('device offline'))
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.sendKeyCombination('emulator-5554', ['59', '21'])).rejects.toThrow('device offline')
    })
  })

  // #607. Measured on Pixel_6_tapflow (API 34): `enable` exits 0, the state reads back as `enabled`
  // with no delay, and `dumpsys connectivity` reports "Active default network: none" — so the OS is
  // genuinely offline and the app's own connectivity callbacks fire without anything being faked.
  describe('airplane mode', () => {
    /** `cmd connectivity airplane-mode …` — set with an argument, read without one. */
    const connectivity = (state: string, opts: { setExit?: Error } = {}) => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockImplementation(async (...args: string[]) => {
        if (!args.includes('airplane-mode')) return ''
        const isSet = args.includes('enable') || args.includes('disable')
        if (isSet && opts.setExit) throw opts.setExit
        return isSet ? '' : `${state}
`
      })
      return runner
    }

    it('reads the state with no argument', async () => {
      const runner = connectivity('enabled')
      expect(await new AdbWrapper(runner).airplaneMode('emulator-5554')).toBe(true)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'cmd', 'connectivity', 'airplane-mode',
      )
    })

    it('reads disabled as false', async () => {
      expect(await new AdbWrapper(connectivity('disabled')).airplaneMode('emulator-5554')).toBe(false)
    })

    it('sets it on, then verifies by reading back', async () => {
      const runner = connectivity('enabled')
      await new AdbWrapper(runner).setAirplaneMode('emulator-5554', true)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'cmd', 'connectivity', 'airplane-mode', 'enable',
      )
      // The read-back is the point, not decoration — see the test below.
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'cmd', 'connectivity', 'airplane-mode',
      )
    })

    it('sets it off with disable', async () => {
      const runner = connectivity('disabled')
      await new AdbWrapper(runner).setAirplaneMode('emulator-5554', false)
      expect(runner.exec).toHaveBeenCalledWith(
        '-s', 'emulator-5554', 'shell', 'cmd', 'connectivity', 'airplane-mode', 'disable',
      )
    })

    it('confirms the state when the read agrees', async () => {
      const r = await new AdbWrapper(connectivity('enabled')).setAirplaneMode('emulator-5554', true)
      expect(r).toEqual({ confirmed: true, offline: true })
    })

    // **The reason the read-back exists.** An image whose `cmd connectivity` does not know
    // `airplane-mode` answers non-zero and throws from the write — but a command that succeeds and
    // does nothing would otherwise be reported as a device taken offline. tapflow is a QA tool: a
    // false "offline" gets signed off, and the bug it hides is filed against the app under test.
    // `clearAppData` above guards the same shape for `pm clear`.
    //
    // **Reports rather than throws**, and `offline` is what the *device* said, not what was asked
    // for. A caller that only learned "it failed" would have to guess which of the two states it is
    // looking at, and guessing wrong here is exactly the false "offline" above.
    it('reports unconfirmed, with the device state, when the write has no effect', async () => {
      const r = await new AdbWrapper(connectivity('disabled')).setAirplaneMode('emulator-5554', true)
      expect(r).toEqual({ confirmed: false, offline: false })
    })

    it('reports the same way when asked to turn it off and it stays on', async () => {
      const r = await new AdbWrapper(connectivity('enabled')).setAirplaneMode('emulator-5554', false)
      expect(r).toEqual({ confirmed: false, offline: true })
    })

    // **The write landed and the confirmation did not.** The device has probably already changed,
    // so the requested value is the best evidence there is — falling back to the old one would
    // report an offline device as online, the failure this whole path exists to prevent.
    it('reports the requested state when the read-back itself fails', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockImplementation(async (...args: string[]) => {
        if (!args.includes('airplane-mode')) return ''
        if (args.includes('enable') || args.includes('disable')) return ''   // write lands
        return 'Connectivity service commands:'                             // read is unreadable
      })
      const r = await new AdbWrapper(runner).setAirplaneMode('emulator-5554', true)
      expect(r).toEqual({ confirmed: false, offline: true })
    })

    // A write that fails is different: the device is unchanged, so the caller's own before-state is
    // still true and there is nothing to report back — it throws.
    it('throws when the write itself fails, leaving the caller its own state', async () => {
      const runner = connectivity('disabled', { setExit: new Error('exit 255') })
      await expect(new AdbWrapper(runner).setAirplaneMode('emulator-5554', true)).rejects.toThrow()
    })

    // Output tapflow cannot read is not "off" — reporting it as off is the same false negative the
    // read-back exists to prevent, arrived at from the other side.
    it('refuses to read an answer it does not recognise', async () => {
      const runner = connectivity('Connectivity service commands:')   // the help text
      await expect(new AdbWrapper(runner).airplaneMode('emulator-5554')).rejects.toThrow(PlatformError)
    })
  })

  describe('clearAppData', () => {
    it('runs pm clear and succeeds on "Success" output', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockImplementation(async (...args: string[]) =>
        args.includes('clear') ? 'Success\n' : '')
      const wrapper = new AdbWrapper(runner)
      await wrapper.clearAppData('emulator-5554', 'com.example.app')
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'shell', 'pm', 'clear', 'com.example.app')
    })

    it('throws PlatformError when pm clear reports Failed (exit code 0)', async () => {
      const runner = mockRunner()
      ;(runner.exec as ReturnType<typeof vi.fn>).mockImplementation(async (...args: string[]) =>
        args.includes('clear') ? 'Failed\n' : '')
      const wrapper = new AdbWrapper(runner)
      await expect(wrapper.clearAppData('emulator-5554', 'unknown.pkg')).rejects.toThrow(PlatformError)
    })
  })

  describe('dumpUiHierarchy', () => {
    const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation="0"><node bounds="[0,0][1080,2400]" /></hierarchy>`
    // Answers each adb call by what it runs: the push, the tree dump jar, or uiautomator dump.
    const dumper = (replies: { push?: string | Error; tree?: string | Error; stock?: string }): AdbRunner => ({
      exec: vi.fn(async (...args: string[]) => {
        const reply = args.includes('push') ? replies.push ?? ''
          : args.includes('app_process') ? replies.tree ?? ''
            : args.includes('uiautomator') ? replies.stock ?? '' : ''
        if (reply instanceof Error) throw reply
        return reply
      }),
      execBinary: vi.fn(),
      listAvds: vi.fn(async () => []),
    })
    const ran = (runner: AdbRunner, what: string) => vi.mocked(runner.exec).mock.calls.filter((c) => c.includes(what))
    const UNSUPPORTED = 'TAPFLOW_UIDUMP_UNSUPPORTED java.lang.ClassNotFoundException: com.android.uiautomator.core.UiAutomationShellWrapper\n'

    it('reads the tree with the dump jar, pushed once and named by its content', async () => {
      const runner = dumper({ tree: XML })
      const wrapper = new AdbWrapper(runner)
      expect(await wrapper.dumpUiHierarchy('emulator-5554')).toBe(XML)
      await wrapper.dumpUiHierarchy('emulator-5554')
      const pushes = ran(runner, 'push')
      expect(pushes).toHaveLength(1)
      const devicePath = pushes[0]!.at(-1)!
      expect(devicePath).toMatch(/^\/data\/local\/tmp\/tapflow-uidump-[0-9a-f]{12}\.jar$/)
      expect(ran(runner, 'app_process')[0]).toEqual([
        '-s', 'emulator-5554', 'exec-out', `CLASSPATH=${devicePath}:/system/framework/uiautomator.jar`,
        'timeout', '4', 'app_process', '/system/bin', 'dev.tapflow.uidump.TreeDump', '/dev/tty', '1000',
      ])
      expect(ran(runner, 'uiautomator')).toHaveLength(0)
    })

    it('pushes the jar to each device', async () => {
      const runner = dumper({ tree: XML })
      const wrapper = new AdbWrapper(runner)
      await wrapper.dumpUiHierarchy('emulator-5554')
      await wrapper.dumpUiHierarchy('emulator-5556')
      expect(ran(runner, 'push').map((c) => c[1])).toEqual(['emulator-5554', 'emulator-5556'])
    })

    it('keeps the XML of a dump that ended with a non-zero status', async () => {
      const runner = dumper({ tree: Object.assign(new Error('exit 124'), { stdout: XML }) })
      expect(await new AdbWrapper(runner).dumpUiHierarchy('emulator-5554')).toBe(XML)
    })

    it('uses uiautomator dump from then on for a device whose image lacks the classes', async () => {
      const runner = dumper({ tree: UNSUPPORTED, stock: XML })
      const wrapper = new AdbWrapper(runner)
      expect(await wrapper.dumpUiHierarchy('emulator-5554')).toBe(XML)
      expect(await wrapper.dumpUiHierarchy('emulator-5554')).toBe(XML)
      expect(ran(runner, 'app_process')).toHaveLength(1)
      expect(ran(runner, 'uiautomator')).toHaveLength(2)
    })

    it.each([
      ['a failure inside the classes', 'ERROR java.lang.IllegalStateException: UiAutomationService already registered!\n'],
      ['no window to read', 'ERROR: no active window to read\n'],
    ])('falls back for one dump on %s, and tries the jar again next time', async (_, tree) => {
      const runner = dumper({ tree, stock: XML })
      const wrapper = new AdbWrapper(runner)
      expect(await wrapper.dumpUiHierarchy('emulator-5554')).toBe(XML)
      await wrapper.dumpUiHierarchy('emulator-5554')
      expect(ran(runner, 'app_process')).toHaveLength(2)
    })

    it('runs one dump at a time on a device, since a second UiAutomation cannot connect', async () => {
      let running = 0
      let most = 0
      const runner: AdbRunner = {
        exec: vi.fn(async (...args: string[]) => {
          if (!args.includes('app_process')) return ''
          most = Math.max(most, ++running)
          await new Promise((r) => setTimeout(r, 5))
          running--
          return XML
        }),
        execBinary: vi.fn(),
        listAvds: vi.fn(async () => []),
      }
      const wrapper = new AdbWrapper(runner)
      const reads = await Promise.all([1, 2, 3].map(() => wrapper.dumpUiHierarchy('emulator-5554')))
      expect(reads).toEqual([XML, XML, XML])
      expect(most).toBe(1)
    })

    it('goes on with the next dump after one that failed', async () => {
      let trees = 0
      const runner: AdbRunner = {
        // The first read gets nothing from either dump; the one after it gets the tree.
        exec: vi.fn(async (...args: string[]) => (args.includes('app_process') && trees++ > 0 ? XML : '')),
        execBinary: vi.fn(),
        listAvds: vi.fn(async () => []),
      }
      const wrapper = new AdbWrapper(runner)
      const first = wrapper.dumpUiHierarchy('emulator-5554')
      const second = wrapper.dumpUiHierarchy('emulator-5554')
      await expect(first).rejects.toThrow(PlatformError)
      await expect(second).resolves.toBe(XML)
    })

    // A wiped emulator comes back on the same serial with an empty /data/local/tmp.
    it('pushes the jar again after a read that produced nothing it recognises', async () => {
      const runner = dumper({ tree: 'Error: Could not find or load main class dev.tapflow.uidump.TreeDump\n', stock: XML })
      const wrapper = new AdbWrapper(runner)
      await wrapper.dumpUiHierarchy('emulator-5554')
      await wrapper.dumpUiHierarchy('emulator-5554')
      expect(ran(runner, 'push')).toHaveLength(2)
    })

    // With uiautomator dump after it, both must fit the relay's 15 s tree deadline.
    it('gives the jar a shorter cap than the dump it falls back to', async () => {
      const runner = dumper({ tree: '', stock: XML })
      await new AdbWrapper(runner).dumpUiHierarchy('emulator-5554', 10)
      expect(ran(runner, 'app_process')[0]).toContain('4')
      expect(ran(runner, 'uiautomator')[0]).toContain('10')
    })

    it('falls back when the jar cannot be pushed', async () => {
      const runner = dumper({ push: new Error('adb: error: failed to copy'), stock: XML })
      expect(await new AdbWrapper(runner).dumpUiHierarchy('emulator-5554')).toBe(XML)
      expect(ran(runner, 'app_process')).toHaveLength(0)
    })

    it('runs uiautomator dump under the device-side timeout command', async () => {
      const runner = dumper({ tree: UNSUPPORTED, stock: XML })
      await new AdbWrapper(runner).dumpUiHierarchy('emulator-5554')
      expect(ran(runner, 'uiautomator')[0]).toEqual([
        '-s', 'emulator-5554', 'exec-out',
        'timeout', '10', 'uiautomator', 'dump', '/dev/tty',
      ])
    })

    it('strips the trailing status line and returns clean XML', async () => {
      const runner = dumper({ tree: UNSUPPORTED, stock: `${XML}UI hierarchy dumped to: /dev/tty\n` })
      expect(await new AdbWrapper(runner).dumpUiHierarchy('emulator-5554')).toBe(XML)
    })

    it('throws PlatformError when neither dump produced XML', async () => {
      const runner = dumper({ tree: '', stock: '' })
      await expect(new AdbWrapper(runner).dumpUiHierarchy('emulator-5554')).rejects.toThrow(PlatformError)
    })

    it('throws PlatformError on truncated XML (dump killed mid-write)', async () => {
      const cut = `<?xml version='1.0'?>\n<hierarchy rotation="0"><node `
      const runner = dumper({ tree: cut, stock: cut })
      await expect(new AdbWrapper(runner).dumpUiHierarchy('emulator-5554')).rejects.toThrow(PlatformError)
    })
  })

  describe('setPosture', () => {
    it('sends the posture to the emulator console', async () => {
      const runner = { exec: vi.fn().mockResolvedValue('OK'), execBinary: vi.fn(), listAvds: vi.fn() }
      await new AdbWrapper(runner as never).setPosture('emulator-5554', '1')
      // `emu`, not `shell cmd device_state`: the guest command moves the framework and leaves the
      // emulator rendering the screen it had, so the capture keeps streaming the unfolded panel.
      expect(runner.exec).toHaveBeenCalledWith('-s', 'emulator-5554', 'emu', 'posture', '1')
    })

    it('throws on a KO answer, which the console gives with a zero exit code', async () => {
      const runner = {
        exec: vi.fn().mockResolvedValue('KO: Usage: "posture <posture_id>"'),
        execBinary: vi.fn(), listAvds: vi.fn(),
      }
      // Without reading the text this refusal is invisible: adb exits 0 and the device does not move.
      await expect(new AdbWrapper(runner as never).setPosture('emulator-5554', '9'))
        .rejects.toThrow(/refused/)
    })
  })

  describe('Lean mode commands', () => {
    const recorder = (answers: Record<string, string> = {}) => {
      const calls: string[] = []
      const runner = {
        exec: vi.fn(async (...args: string[]) => {
          const cmd = args.slice(3).join(' ')
          calls.push(cmd)
          for (const [k, v] of Object.entries(answers)) if (cmd.includes(k)) return v
          return ''
        }),
        execBinary: vi.fn(), listAvds: vi.fn(),
      }
      return { calls, adb: new AdbWrapper(runner as never) }
    }

    it('reads disabled packages as every package minus the enabled ones', async () => {
      const { adb } = recorder({
        'packages -e': 'package:android\r\npackage:com.google.android.youtube\r\n',
        'list packages': 'package:android\npackage:com.google.android.youtube\npackage:com.google.android.apps.wellbeing\n',
      })
      const s = await adb.packageStates('emulator-5554')
      expect([...s.enabled]).toEqual(['android', 'com.google.android.youtube'])
      expect([...s.disabled]).toEqual(['com.google.android.apps.wellbeing'])
    })

    it('refuses a package list that cannot be real', async () => {
      // An empty answer right after boot would otherwise read as "nothing is installed".
      const { adb } = recorder({ 'packages -e': 'package:android\n' })
      await expect(adb.packageStates('emulator-5554')).rejects.toThrow(/package list/)
    })

    it('disables for user 0 and enables, and refuses a change pm did not report', async () => {
      const { adb, calls } = recorder({ 'disable-user': 'Package x new state: disabled-user', 'enable --user': 'Package x new state: enabled' })
      await adb.setPackageEnabled('emulator-5554', 'x', false)
      await adb.setPackageEnabled('emulator-5554', 'x', true)
      expect(calls).toEqual(['pm disable-user --user 0 x', 'pm enable --user 0 x'])
      // pm prints an error with exit 0 for an unknown package, like `pm clear`.
      const quiet = recorder()
      await expect(quiet.adb.setPackageEnabled('emulator-5554', 'x', false)).rejects.toThrow(/x/)
    })

    it('reads a device file, and tells a missing one from an empty one', async () => {
      const none = recorder({ 'cat': '__TAPFLOW_NO_FILE__\n' })
      expect(await none.adb.readDeviceFile('emulator-5554', '/data/local/tmp/f')).toBeNull()
      const some = recorder({ 'cat': '{"a":1}' })
      expect(await some.adb.readDeviceFile('emulator-5554', '/data/local/tmp/f')).toBe('{"a":1}')
    })

    it('writes through a temp file, renamed into place and synced', async () => {
      const { adb, calls } = recorder()
      await adb.writeDeviceFile('emulator-5554', '/data/local/tmp/f', '{"q":"it\'s"}')
      const b64 = Buffer.from('{"q":"it\'s"}').toString('base64')
      // base64, so a quote in the content cannot end the shell string.
      expect(calls).toEqual([`echo ${b64} | base64 -d > /data/local/tmp/f.tmp && mv /data/local/tmp/f.tmp /data/local/tmp/f && sync`])
    })
  })
})
