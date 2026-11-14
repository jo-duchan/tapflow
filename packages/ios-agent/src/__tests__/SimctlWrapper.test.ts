import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SimctlWrapper, isDeviceMissingError } from '../SimctlWrapper'
import type { SimctlRunner, SimctlExecOpts } from '../simctl'

vi.mock('child_process', () => ({
  // The callback is last whether or not an options object comes before it.
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: null, stdout: string, stderr: string) => void
    cb(null, '', '')
    return { on: vi.fn() }
  }),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  }
})

const SIMCTL_LIST_OUTPUT = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
      { udid: 'device-1', name: 'iPhone 15', state: 'Booted', isAvailable: true },
      { udid: 'device-2', name: 'iPhone 15 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'device-3', name: 'iPhone 14', state: 'Shutdown', isAvailable: false },
    ],
  },
})

function mockRunner(outputs: Record<string, string> = {}): SimctlRunner {
  return {
    exec: vi.fn(async (...args: string[]) => outputs[args[0]] ?? ''),
    execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    execWithOpts: vi.fn(async (_opts: SimctlExecOpts, ...args: string[]) => outputs[args[0]] ?? ''),
  }
}

describe('SimctlWrapper', () => {
  // A multi-panel device (iPhone Duo) is told apart by its type's capabilities.plist, read once per connect
  // and only for the types present. Mutations: count every display (TVOut and CarPlay then make every
  // phone "multi-panel"); read every type; let one unreadable plist fail the whole lookup.
  describe('integratedPanelCounts', () => {
    const TYPES = JSON.stringify({ devicetypes: [
      { identifier: 'DUO', bundlePath: '/Types/iPhone Duo.simdevicetype' },
      { identifier: 'PRO', bundlePath: '/Types/iPhone 17 Pro.simdevicetype' },
      { identifier: 'UNUSED', bundlePath: '/Types/Unused.simdevicetype' },
      { identifier: 'BROKEN', bundlePath: '/Types/Broken.simdevicetype' },
    ] })
    const display = (displayType: string) => ({ displayType })
    const plists: Record<string, unknown> = {
      '/Types/iPhone Duo.simdevicetype/Contents/Resources/capabilities.plist':
        { capabilities: { displays: [display('integrated'), display('integrated'), display('tvOut'), display('carPlay'), display('scene')] } },
      '/Types/iPhone 17 Pro.simdevicetype/Contents/Resources/capabilities.plist':
        { capabilities: { displays: [display('integrated'), display('tvOut'), display('carPlay'), display('scene')] } },
    }

    it('counts integrated panels for the types asked about, and only those', async () => {
      const read = vi.fn(async (path: string) => {
        if (!(path in plists)) throw new Error('no such plist')
        return plists[path]
      })
      const counts = await new SimctlWrapper(mockRunner({ list: TYPES }), read).integratedPanelCounts(['DUO', 'PRO', 'BROKEN'])
      expect(Object.fromEntries(counts)).toEqual({ DUO: 2, PRO: 1, BROKEN: 1 })
      expect(read.mock.calls.map((c) => c[0])).not.toContain('/Types/Unused.simdevicetype/Contents/Resources/capabilities.plist')
    })

    it('asks nothing when there are no devices', async () => {
      const runner = mockRunner({ list: TYPES })
      expect((await new SimctlWrapper(runner, vi.fn()).integratedPanelCounts([])).size).toBe(0)
      expect(runner.execWithOpts).not.toHaveBeenCalled()
    })
  })

  // Mutation: catch the read failure into "no panels" — TypePanels keeps that for the life of the agent.
  describe('typePanels', () => {
    it('rejects when the plist cannot be read, so the answer is asked for again', async () => {
      const types = JSON.stringify({ devicetypes: [{ identifier: 'DUO', bundlePath: '/Types/iPhone Duo.simdevicetype' }] })
      const read = vi.fn(async () => { throw new Error('plutil timed out') })
      await expect(new SimctlWrapper(mockRunner({ list: types }), read).typePanels('DUO')).rejects.toThrow('plutil timed out')
      // A type that is not there is an answer, not a failure.
      await expect(new SimctlWrapper(mockRunner({ list: types }), read).typePanels('OTHER')).resolves.toEqual([])
    })
  })

  describe('integratedScreens', () => {
    it('reads the panels from `simctl io <udid> enumerate`, with a timeout', async () => {
      const text = 'Connected Screens:\n    (1) LCD:\n        Screen ID: 1\n        Unique ID: AAA\n        Device Name: primary\n        Screen Type: Integrated\n        Pixel Size: {1398, 2034}\n'
      const runner = mockRunner({ io: text })
      expect(await new SimctlWrapper(runner).integratedScreens('UDID')).toEqual([{ screenId: 1, uuid: 'AAA', deviceName: 'primary', width: 1398, height: 2034, scale: 1, chromeId: null }])
      const [opts, ...args] = vi.mocked(runner.execWithOpts).mock.calls[0]
      expect(args).toEqual(['io', 'UDID', 'enumerate'])
      expect(opts.timeoutMs).toBeGreaterThan(0)
    })
  })

  // `simctl list devices` carries no device family; `list devicetypes` does, as `productFamily`. The
  // map is read once per connect, never by `listDevices` — that one runs inside the boot poll, whose
  // per-call timeout is the only thing standing between it and a wedged CoreSimulatorService.
  describe('formFactorsByType', () => {
    const TYPES = JSON.stringify({ devicetypes: [
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15', productFamily: 'iPhone' },
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-mini-A17-Pro', productFamily: 'iPad' },
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-2-49mm', productFamily: 'Apple Watch' },
    ] })

    // Mutations: swap the two families; or map every family (the watch then answers something).
    it('maps iPhone to phone and iPad to tablet, and nothing else', async () => {
      const map = await new SimctlWrapper(mockRunner({ list: TYPES })).formFactorsByType()
      expect(map.get('com.apple.CoreSimulator.SimDeviceType.iPhone-15')).toBe('phone')
      expect(map.get('com.apple.CoreSimulator.SimDeviceType.iPad-mini-A17-Pro')).toBe('tablet')
      expect(map.has('com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-2-49mm')).toBe(false)
    })

    // Mutation: call it without a bound. A wedged service then holds `connect()` forever.
    it('reads devicetypes with a timeout', async () => {
      const runner = mockRunner({ list: TYPES })
      await new SimctlWrapper(runner).formFactorsByType()
      expect(runner.execWithOpts).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: expect.any(Number) }), 'list', 'devicetypes', '-j')
    })

    // Mutation: fold the lookup into `listDevices`.
    it('is never what listDevices runs', async () => {
      const runner = mockRunner({ list: SIMCTL_LIST_OUTPUT })
      await new SimctlWrapper(runner).listDevices(1000)
      const calls = [...(runner.exec as ReturnType<typeof vi.fn>).mock.calls, ...(runner.execWithOpts as ReturnType<typeof vi.fn>).mock.calls]
      expect(calls.flat().includes('devicetypes')).toBe(false)
    })
  })

  describe('listDevices', () => {
    it('returns only available devices', async () => {
      const runner = mockRunner({ list: SIMCTL_LIST_OUTPUT })
      const wrapper = new SimctlWrapper(runner)
      const devices = await wrapper.listDevices()
      expect(devices).toHaveLength(2)
    })

    it('maps state to DeviceStatus correctly', async () => {
      const runner = mockRunner({ list: SIMCTL_LIST_OUTPUT })
      const wrapper = new SimctlWrapper(runner)
      const devices = await wrapper.listDevices()
      expect(devices.find((d) => d.id === 'device-1')?.status).toBe('booted')
      expect(devices.find((d) => d.id === 'device-2')?.status).toBe('shutdown')
    })

    it('sets platform to ios', async () => {
      const runner = mockRunner({ list: SIMCTL_LIST_OUTPUT })
      const wrapper = new SimctlWrapper(runner)
      const [device] = await wrapper.listDevices()
      expect(device.platform).toBe('ios')
    })
  })

  describe('boot', () => {
    it('calls simctl boot with the deviceId', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.boot('device-1')
      expect(runner.exec).toHaveBeenCalledWith('boot', 'device-1')
    })

    it('does not throw if device is already booted', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn().mockRejectedValue(
          Object.assign(new Error(), { stderr: 'Unable to boot device in current state: Booted' })
        ),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      }
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.boot('device-1')).resolves.toBeUndefined()
    })

    it('rethrows unexpected errors', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn().mockRejectedValue(new Error('xcrun not found')),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      }
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.boot('device-1')).rejects.toThrow('xcrun not found')
    })
  })

  describe('waitUntilBooted', () => {
    // One `list` reading per call, walking the script in order and holding on the last — the shape a
    // real boot has. `mockRunner` answers every `list` identically, which cannot express a transition.
    // A step of `throw` is a failed reading, which is a different thing from a reading of a failure.
    //
    // `deviceTypeIdentifier` is in the fixture because it is the field a re-assembled return value
    // loses most quietly: `sendChromeData` falls back to `chromeLoader.load(device.name)` when
    // `typeId` is missing, which is the name-based lookup this package's AGENTS.md marks ❌, and the
    // only symptom is that every boot loses its device chrome.
    function transitioningRunner(script: Array<string | 'throw'>): SimctlRunner {
      let i = 0
      const listing = (state: string) => JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
            {
              udid: 'device-1',
              name: 'iPhone 15',
              state,
              isAvailable: true,
              deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
            },
          ],
        },
      })
      // Both entry points walk the same script. The poll reads through `execWithOpts` because it bounds
      // each reading, and a double that only scripted `exec` would answer it with `''` — `JSON.parse('')`
      // throwing on every poll, which the retry branch would then swallow into a deadline. Loud, but for
      // the wrong reason, and it would hide whatever the test was actually about.
      const next = (...args: string[]) => {
        if (args[0] !== 'list') return ''
        const step = script[Math.min(i++, script.length - 1)]
        if (step === 'throw') throw new Error('Command failed: xcrun simctl list devices --json\nservice invalidated')
        return listing(step)
      }
      return {
        exec: vi.fn(async (...args: string[]) => next(...args)),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn(async (_opts: SimctlExecOpts, ...args: string[]) => next(...args)),
      }
    }

    /** Readings taken, whichever entry point took them. */
    const reads = (runner: SimctlRunner) =>
      (runner.exec as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'list').length +
      (runner.execWithOpts as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1] === 'list').length

    it('polls until the device reaches Booted and returns the whole record it read', async () => {
      // `Shutdown` first on purpose: `simctl boot` has already returned by the time this runs, and the
      // list can still report the pre-boot state for a moment. The call count is what says neither
      // that reading nor `Booting` was accepted — three readings for three states.
      const runner = transitioningRunner(['Shutdown', 'Booting', 'Booted'])
      const device = await new SimctlWrapper(runner).waitUntilBooted('device-1', { timeoutMs: 5_000, pollIntervalMs: 0 })
      expect(device).toEqual({
        id: 'device-1',
        name: 'iPhone 15',
        platform: 'ios',
        status: 'booted',
        typeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
        osVersion: 'iOS 17.0',
      })
      expect(reads(runner)).toBe(3)
    })

    it('reads once when the device is already up, even at a zero deadline', async () => {
      // The deadline is checked after the read rather than before it. With the order reversed a device
      // that is already booted would still have to wait out a poll interval to be reported as up.
      const runner = transitioningRunner(['Booted'])
      const device = await new SimctlWrapper(runner).waitUntilBooted('device-1', { timeoutMs: 0, pollIntervalMs: 0 })
      expect(device.status).toBe('booted')
      expect(reads(runner)).toBe(1)
    })

    it('bounds each reading, so a wedged simctl cannot outlive the deadline', async () => {
      // `listDevices` is untimed everywhere else on purpose — a blanket timeout would fail a
      // legitimately slow call — but the poll is the one caller whose whole contract is a deadline, and a
      // wedged CoreSimulatorService would park it inside one `xcrun` where the clock is never consulted
      // again. Bounding the reading is what makes the deadline a deadline; swallowing the failure (the
      // test below) is what stops it ending a healthy boot.
      const runner = transitioningRunner(['Booted'])
      await new SimctlWrapper(runner).waitUntilBooted('device-1', { timeoutMs: 0, pollIntervalMs: 0 })
      expect(runner.execWithOpts).toHaveBeenCalledWith({ timeoutMs: 5_000 }, 'list', 'devices', '--json')
      expect(runner.exec).not.toHaveBeenCalledWith('list', 'devices', '--json')
    })

    it('sleeps between polls, at the default interval', async () => {
      // Both halves matter. Without the sleep this spawns `xcrun simctl list` as fast as the event
      // loop allows for the whole deadline, and deleting it changes no other assertion here — every
      // other test passes an interval of 0. And production calls this with no interval at all
      // (`IOSAgent.handleDeviceBoot`), so the default is the value that actually runs: at 500ms a
      // 1200ms deadline admits three readings, and a default of 0 would admit hundreds.
      const runner = transitioningRunner(['Booting'])
      const started = Date.now()
      await expect(new SimctlWrapper(runner).waitUntilBooted('device-1', { timeoutMs: 1_200 }))
        .rejects.toThrow(/did not finish booting within 1200ms/)
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
      expect(reads(runner)).toBeLessThanOrEqual(4)
    })

    it('gives up at the deadline and names the last status it saw', async () => {
      const runner = transitioningRunner(['Booting'])
      await expect(new SimctlWrapper(runner).waitUntilBooted('device-1', { timeoutMs: 20, pollIntervalMs: 5 }))
        .rejects.toThrow(/did not finish booting within 20ms \(last seen: unknown\)/)
    })

    it('keeps polling when a reading fails, and reports the failure if it runs out', async () => {
      // A failed `list` is not evidence about the device. This spawns a subprocess up to
      // `timeoutMs / pollIntervalMs` times during the window when CoreSimulator is busiest, and the
      // old code read the list once — so without this, one unlucky spawn kills a healthy boot and
      // reports a `Command failed: xcrun simctl …` line that says nothing about booting.
      const recovered = transitioningRunner(['throw', 'throw', 'Booted'])
      const device = await new SimctlWrapper(recovered).waitUntilBooted('device-1', { timeoutMs: 5_000, pollIntervalMs: 0 })
      expect(device.status).toBe('booted')
      expect(reads(recovered)).toBe(3)

      const persistent = transitioningRunner(['throw'])
      await expect(new SimctlWrapper(persistent).waitUntilBooted('device-1', { timeoutMs: 20, pollIntervalMs: 5 }))
        .rejects.toThrow(/last poll failed: service invalidated/)
    })

    it('reports a device that is not in the list at all', async () => {
      // Reached both by a deleted device and by one `listDevices` filtered out for
      // `isAvailable: false`. Neither self-heals, and neither gets its own early exit — for the same
      // reason `shutdown` does not, and it costs the deadline to say so.
      const runner = transitioningRunner(['Booted'])
      await expect(new SimctlWrapper(runner).waitUntilBooted('device-404', { timeoutMs: 0, pollIntervalMs: 0 }))
        .rejects.toThrow(/last seen: no longer listed/)
    })

    it('does not blame a recovered-from failure for the timeout', async () => {
      // The `lastError = null` on the success path. Without it a single failed poll makes every
      // later deadline report `last poll failed: …` — naming an error the wait recovered from, for a
      // device that was answering perfectly well and simply never finished booting. Deleting that
      // line passes every other test here, because none of them follow a `throw` with a
      // non-`Booted` reading.
      const runner = transitioningRunner(['throw', 'Booting'])
      await expect(new SimctlWrapper(runner).waitUntilBooted('device-1', { timeoutMs: 30, pollIntervalMs: 5 }))
        .rejects.toThrow(/did not finish booting within 30ms \(last seen: unknown\)/)
    })

    it('keeps waiting on shutdown, which is a transition it has not observed yet', async () => {
      // `boot` returning before CoreSimulator has left `Shutdown` is ordinary, and the handler
      // issues a boot on every path that reaches here — so this reading is never "nobody is booting
      // it". A draft gave `shutdown` a 3s grace and failed early on it; a slow machine's healthy
      // boot is not distinguishable from a dead one by that clock, so the deadline owns it instead.
      const runner = transitioningRunner(['Shutdown', 'Shutdown', 'Shutdown', 'Booting', 'Booted'])
      const device = await new SimctlWrapper(runner).waitUntilBooted('device-1', { timeoutMs: 5_000, pollIntervalMs: 0 })
      expect(device.status).toBe('booted')
      expect(reads(runner)).toBe(5)
    })

    it('abandons the poll as soon as the boot is superseded', async () => {
      // The handler is fire-and-forget and its `bootSeq` check runs only once this returns, so
      // without the signal a shutdown mid-wait leaves this spawning a process twice a second
      // against a device that is deliberately off and will never converge.
      const runner = transitioningRunner(['Booting'])
      let stale = false
      const wait = new SimctlWrapper(runner).waitUntilBooted('device-1', {
        timeoutMs: 60_000,
        pollIntervalMs: 5,
        isStale: () => stale,
      })
      await new Promise((r) => setTimeout(r, 30))
      stale = true
      await expect(wait).rejects.toThrow(/was superseded while waiting/)
      const callsAtRejection = reads(runner)
      await new Promise((r) => setTimeout(r, 40))
      expect(reads(runner)).toBe(callsAtRejection)
    })
  })

  describe('shutdown', () => {
    it('calls simctl shutdown with the deviceId', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.shutdown('device-1')
      expect(runner.exec).toHaveBeenCalledWith('shutdown', 'device-1')
    })

    it('does not throw if device is already shut down', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn().mockRejectedValue(
          Object.assign(new Error(), { stderr: 'Unable to shutdown device in current state: Shutdown' })
        ),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      }
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.shutdown('device-1')).resolves.toBeUndefined()
    })

    it('rethrows unexpected errors', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn().mockRejectedValue(new Error('xcrun not found')),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      }
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.shutdown('device-1')).rejects.toThrow('xcrun not found')
    })
  })

  describe('installApp', () => {
    it('calls simctl install booted with the app path', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.installApp('dev-1', '/path/to/App.app')
      expect(runner.exec).toHaveBeenCalledWith('install', 'dev-1', '/path/to/App.app')
    })
  })

  describe('launchApp', () => {
    it('calls simctl launch booted with the bundleId', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.launchApp('dev-1', 'com.example.app')
      expect(runner.exec).toHaveBeenCalledWith('launch', 'dev-1', 'com.example.app')
    })

    it('parses the launched host PID from simctl output (for the audiotap-helper)', async () => {
      const runner = mockRunner({ launch: 'com.example.app: 90210\n' })
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.launchApp('dev-1', 'com.example.app')).resolves.toBe(90210)
    })

    it('returns null when no PID can be parsed', async () => {
      const runner = mockRunner({ launch: '' })
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.launchApp('dev-1', 'com.example.app')).resolves.toBeNull()
    })

    // Without options a running app is only brought forward, as before #1047; with them it is restarted, because a
    // running process has already read its arguments.
    it('restarts the app and passes arguments as argv and env as SIMCTL_CHILD_ when given options', async () => {
      const runner = mockRunner({ launch: 'com.example.app: 4242\n' })
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.launchApp('dev-1', 'com.example.app', { arguments: { FIRDebugEnabled: true, offset: -1 }, env: { API_HOST: 's.example.com' } })).resolves.toBe(4242)
      expect(runner.exec).not.toHaveBeenCalled()
      expect(runner.execWithOpts).toHaveBeenCalledWith(
        { env: { SIMCTL_CHILD_API_HOST: 's.example.com' } },
        'launch', '--terminate-running-process', 'dev-1', 'com.example.app', '-FIRDebugEnabled', '"true"', '-offset', '"-1"',
      )
    })

    it('treats empty option maps as a plain launch', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.launchApp('dev-1', 'com.example.app', { arguments: {}, env: {} })
      expect(runner.exec).toHaveBeenCalledWith('launch', 'dev-1', 'com.example.app')
      expect(runner.execWithOpts).not.toHaveBeenCalled()
    })
  })

  describe('openUrl', () => {
    it('calls simctl openurl with the device udid and url', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.openUrl('device-1', 'myapp://home')
      expect(runner.exec).toHaveBeenCalledWith('openurl', 'device-1', 'myapp://home')
    })
  })

  describe('setStatusBarOffline', () => {
    it('overrides all three network indicators, not just one', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.setStatusBarOffline('device-1', true)
      // Hiding the data network alone leaves the wifi glyph up, which reads as connected.
      expect(runner.exec).toHaveBeenCalledWith(
        'status_bar', 'device-1', 'override',
        '--dataNetwork', 'hide',
        '--wifiMode', 'failed',
        '--cellularMode', 'notSupported',
      )
    })

    it('clears the override when the device comes back', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.setStatusBarOffline('device-1', false)
      expect(runner.exec).toHaveBeenCalledWith('status_bar', 'device-1', 'clear')
    })
  })

  describe('rotate', () => {
    it('calls rotation-helper with landscapeRight', async () => {
      const { execFile } = await import('child_process')
      const wrapper = new SimctlWrapper()
      await wrapper.rotate('device-1', 'landscapeRight')
      expect(vi.mocked(execFile)).toHaveBeenCalledWith(
        expect.stringContaining('rotation-helper'),
        ['landscapeRight', 'device-1'],
        { timeout: 5_000 },
        expect.any(Function),
      )
    })

    it('calls rotation-helper with portrait', async () => {
      const { execFile } = await import('child_process')
      const wrapper = new SimctlWrapper()
      await wrapper.rotate('device-1', 'portrait')
      expect(vi.mocked(execFile)).toHaveBeenCalledWith(
        expect.stringContaining('rotation-helper'),
        ['portrait', 'device-1'],
        { timeout: 5_000 },
        expect.any(Function),
      )
    })
  })

  describe('syncKeyboardsFromLanguages', () => {
    it('writes AppleKeyboards with hw=Automatic entries matching AppleLanguages', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn()
          .mockResolvedValueOnce('(\n    "ko-KR",\n    "en-US"\n)')  // defaults read
          .mockResolvedValue(''),                                       // write + kickstart
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      }
      const wrapper = new SimctlWrapper(runner)
      await wrapper.syncKeyboardsFromLanguages('device-1')

      expect(runner.exec).toHaveBeenCalledWith(
        'spawn', 'device-1', 'defaults', 'write', '-g', 'AppleKeyboards', '-array',
        'ko_KR@sw=Korean;hw=Automatic',
        'en_US@sw=QWERTY;hw=Automatic',
        'emoji@sw=Emoji',
      )
    })

    it('appends en_US fallback when English is not in AppleLanguages', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn()
          .mockResolvedValueOnce('(\n    "ko-KR"\n)')
          .mockResolvedValue(''),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      }
      const wrapper = new SimctlWrapper(runner)
      await wrapper.syncKeyboardsFromLanguages('device-1')

      const writeCall = (runner.exec as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: string[]) => c[2] === 'defaults' && c[3] === 'write',
      ) as string[]
      expect(writeCall).toContain('en_US@sw=QWERTY;hw=Automatic')
    })

    it('does nothing when AppleLanguages is empty or unset', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn().mockRejectedValue(new Error('Domain does not exist')),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      }
      const wrapper = new SimctlWrapper(runner)
      await wrapper.syncKeyboardsFromLanguages('device-1')

      // No write call should have been made
      expect(runner.exec).toHaveBeenCalledTimes(1)
    })

    it('ignores kickstart failure gracefully', async () => {
      const runner: SimctlRunner = {
        exec: vi.fn()
          .mockResolvedValueOnce('(\n    "en-US"\n)')  // read
          .mockResolvedValueOnce('')                    // write
          .mockRejectedValueOnce(new Error('kbd not found')), // kickstart fails
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      }
      const wrapper = new SimctlWrapper(runner)
      await expect(wrapper.syncKeyboardsFromLanguages('device-1')).resolves.toBeUndefined()
    })

    it('restarts the keyboard daemon by the name iOS 26 gives it', async () => {
      // `system/com.apple.kbd` does not exist on iOS 26.4: the kickstart failed in silence (#1134).
      const runner: SimctlRunner = {
        exec: vi.fn().mockResolvedValueOnce('(\n    "en-US"\n)').mockResolvedValue(''),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      }
      await new SimctlWrapper(runner).syncKeyboardsFromLanguages('device-1')
      expect(runner.exec).toHaveBeenLastCalledWith('spawn', 'device-1', 'launchctl', 'kickstart', '-k', 'user/foreground/com.apple.TextInput.kbd')
    })
  })

  // #1135: a replay starts from the keyboard the recording saw.
  describe('setKeyboardLanguage', () => {
    const LIST = '(\n    "en_US@sw=QWERTY;hw=Automatic",\n    "ko_KR@sw=Korean;hw=Automatic",\n    "emoji@sw=Emoji"\n)'
    const runnerReading = (keyboards: string) => ({
      exec: vi.fn().mockResolvedValueOnce(keyboards).mockResolvedValue(''),
      execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      execWithOpts: vi.fn().mockResolvedValue(''),
    }) satisfies SimctlRunner

    it('makes a named keyboard the one in use, the next one after it', async () => {
      const runner = runnerReading(LIST)
      expect(await new SimctlWrapper(runner).setKeyboardLanguage('device-1', 'ko_KR@sw=Korean;hw=Automatic')).toBe(true)
      expect(runner.exec.mock.calls.slice(1)).toEqual([
        ['spawn', 'device-1', 'defaults', 'write', 'com.apple.keyboard.preferences', 'KeyboardLastUsed', 'ko_KR@sw=Korean;hw=Automatic'],
        ['spawn', 'device-1', 'defaults', 'write', 'com.apple.keyboard.preferences', 'KeyboardsCurrentAndNext', '-array',
          'ko_KR@sw=Korean;hw=Automatic', 'ko_KR@sw=Korean;hw=Automatic', 'en_US@sw=QWERTY;hw=Automatic'],
        ['spawn', 'device-1', 'launchctl', 'kickstart', '-k', 'user/foreground/com.apple.TextInput.kbd'],
      ])
    })

    // Review of #1145: the budget is for the whole reset, so each call gets what the ones before it left. With the same
    // timeout for each, five calls could take five budgets while `device:ready` waited on them.
    it('bounds the calls together when given a timeout, each by what is left', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(0)
      // Each call takes a second.
      const after = (out: string) => async () => { vi.setSystemTime(Date.now() + 1_000); return out }
      const runner = {
        exec: vi.fn().mockResolvedValue(''),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockImplementationOnce(after(LIST)).mockImplementation(after('')),
      } satisfies SimctlRunner
      try {
        expect(await new SimctlWrapper(runner).setKeyboardLanguage('device-1', undefined, 5_000)).toBe(true)
      } finally { vi.useRealTimers() }
      expect(runner.exec).not.toHaveBeenCalled()
      expect(runner.execWithOpts.mock.calls.map(([opts]) => opts)).toEqual([{ timeoutMs: 5_000 }, { timeoutMs: 4_000 }, { timeoutMs: 3_000 }, { timeoutMs: 2_000 }])
    })

    it('writes nothing for a keyboard the device does not have', async () => {
      const runner = runnerReading(LIST)
      expect(await new SimctlWrapper(runner).setKeyboardLanguage('device-1', 'fr_FR@sw=AZERTY;hw=Automatic')).toBe(false)
      expect(runner.exec).toHaveBeenCalledTimes(1)
    })

    it('makes the first keyboard the one in use with none named', async () => {
      const runner = runnerReading(LIST)
      expect(await new SimctlWrapper(runner).setKeyboardLanguage('device-1')).toBe(true)
      expect(runner.exec.mock.calls[1]).toEqual(['spawn', 'device-1', 'defaults', 'write', 'com.apple.keyboard.preferences', 'KeyboardLastUsed', 'en_US@sw=QWERTY;hw=Automatic'])
    })
  })

  // #1139: what a run's fresh install leaves, without the build — clearing files keeps notification permission and
  // App Group containers.
  describe('reinstallAppInPlace', () => {
    it('copies the installed bundle aside, uninstalls, installs the copy, and removes it', async () => {
      const { mkdtemp, mkdir, writeFile, readdir, access } = await vi.importActual<typeof import('fs/promises')>('fs/promises')
      const { tmpdir } = await import('os')
      const { join } = await import('path')
      const root = await mkdtemp(join(tmpdir(), 'tapflow-test-bundle-'))
      const bundle = join(root, 'App.app')
      await mkdir(bundle)
      await writeFile(join(bundle, 'Info.plist'), 'plist')
      let installedFrom = ''
      let copyHeld: string[] = []
      const runner = mockRunner()
      vi.mocked(runner.execWithOpts).mockImplementation(async (_o, ...args: string[]) => {
        if (args[0] === 'get_app_container') return `${bundle}\n`
        if (args[0] === 'install') { installedFrom = args[2]!; copyHeld = await readdir(installedFrom) }
        return ''
      })
      await new SimctlWrapper(runner).reinstallAppInPlace('device-1', 'com.app')
      const order = vi.mocked(runner.execWithOpts).mock.calls.map(([, ...args]) => args[0])
      expect(order).toEqual(['get_app_container', 'uninstall', 'install'])
      expect(installedFrom).not.toBe(bundle)
      expect(installedFrom.endsWith('/App.app')).toBe(true)
      expect(copyHeld).toEqual(['Info.plist'])
      await expect(access(installedFrom)).rejects.toThrow()
    })

    // After the uninstall the copy is the only one, and the finally deletes it (pre-PR review of #1139).
    it('installs once more from the copy before giving up, and says the app is gone when that fails too', async () => {
      const { mkdtemp, mkdir } = await vi.importActual<typeof import('fs/promises')>('fs/promises')
      const { tmpdir } = await import('os')
      const { join } = await import('path')
      const bundle = join(await mkdtemp(join(tmpdir(), 'tapflow-test-bundle-')), 'App.app')
      await mkdir(bundle)
      const run = (installs: Array<'ok' | 'fail'>) => {
        const runner = mockRunner()
        vi.mocked(runner.execWithOpts).mockImplementation(async (_o, ...args: string[]) => {
          if (args[0] === 'get_app_container') return bundle
          if (args[0] === 'install' && installs.shift() === 'fail') throw new Error('install timed out\nCommand failed: xcrun simctl install')
          return ''
        })
        return { runner, wrapper: new SimctlWrapper(runner) }
      }
      const once = run(['fail', 'ok'])
      await once.wrapper.reinstallAppInPlace('device-1', 'com.app')
      expect(vi.mocked(once.runner.execWithOpts).mock.calls.filter(([, a]) => a === 'install')).toHaveLength(2)
      await expect(run(['fail', 'fail']).wrapper.reinstallAppInPlace('device-1', 'com.app'))
        .rejects.toThrow('com.app was uninstalled and could not be installed again: install timed out')
    })

    it('leaves an app that is not installed alone', async () => {
      const runner = mockRunner()
      vi.mocked(runner.execWithOpts).mockRejectedValue(Object.assign(new Error('failed'), { stderr: 'No such file or directory' }))
      await new SimctlWrapper(runner).reinstallAppInPlace('device-1', 'com.app')
      expect(runner.execWithOpts).toHaveBeenCalledTimes(1)
    })

    it('does not uninstall when the bundle cannot be copied', async () => {
      const runner = mockRunner()
      vi.mocked(runner.execWithOpts).mockImplementation(async (_o, ...args: string[]) => (args[0] === 'get_app_container' ? '/nonexistent/App.app\n' : ''))
      await expect(new SimctlWrapper(runner).reinstallAppInPlace('device-1', 'com.app')).rejects.toThrow()
      expect(vi.mocked(runner.execWithOpts).mock.calls.map(([, ...args]) => args[0])).toEqual(['get_app_container'])
    })
  })

  // The app observer asks this when no answer came, and every later read on the device queues behind it: unbounded, a
  // `launchctl` that never returned held them all (review finding).
  describe('appRunning', () => {
    it('reads the app\'s job from launchctl, within a bound', async () => {
      const runner = mockRunner({ spawn: '123\t0\tUIKitApplication:com.app[1a2b][rb-legacy]\n-\t0\tUIKitApplication:com.gone[3c][rb-legacy]\n' })
      const simctl = new SimctlWrapper(runner)
      expect(await simctl.appRunning('device-1', 'com.app')).toBe(true)
      expect(await simctl.appRunning('device-1', 'com.gone')).toBe(false)
      const [opts, ...args] = vi.mocked(runner.execWithOpts).mock.calls[0]!
      expect(args).toEqual(['spawn', 'device-1', 'launchctl', 'list'])
      expect(opts.timeoutMs).toBeGreaterThan(0)
      expect(runner.exec).not.toHaveBeenCalled()
    })
  })

  describe('keyboardLanguage', () => {
    it('reads the keyboard in use', async () => {
      const runner = {
        exec: vi.fn().mockResolvedValue(''),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue('ko_KR@sw=Korean;hw=Automatic\n'),
      } satisfies SimctlRunner
      expect(await new SimctlWrapper(runner).keyboardLanguage('device-1')).toBe('ko_KR@sw=Korean;hw=Automatic')
      expect(runner.execWithOpts).toHaveBeenCalledWith(
        { timeoutMs: 800 }, 'spawn', 'device-1', 'defaults', 'read', 'com.apple.keyboard.preferences', 'KeyboardLastUsed',
      )
    })

    it('is undefined before any keyboard was used', async () => {
      const runner = {
        exec: vi.fn().mockResolvedValue(''),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockRejectedValue(new Error('The domain/default pair does not exist')),
      } satisfies SimctlRunner
      expect(await new SimctlWrapper(runner).keyboardLanguage('device-1')).toBeUndefined()
    })

    // The runner retries after restarting CoreSimulatorService, past its own timeout: the read must not wait for it.
    it('is undefined after 800 ms whatever the runner does', async () => {
      vi.useFakeTimers()
      try {
        const runner = {
          exec: vi.fn().mockResolvedValue(''),
          execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
          execWithOpts: vi.fn().mockReturnValue(new Promise<string>(() => {})),
        } satisfies SimctlRunner
        const read = new SimctlWrapper(runner).keyboardLanguage('device-1')
        let settled = false
        void read.then(() => { settled = true })
        await vi.advanceTimersByTimeAsync(799)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(await read).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('resetKeyboardLanguage', () => {
    const runnerReading = (keyboards: string) => ({
      exec: vi.fn().mockResolvedValueOnce(keyboards).mockResolvedValue(''),
      execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      execWithOpts: vi.fn().mockResolvedValue(''),
    }) satisfies SimctlRunner

    it('makes the first keyboard the one in use, then restarts the keyboard daemon', async () => {
      // Where a Caps Lock press stores the language (measured, iOS 26.4), not AppleKeyboards' order.
      const runner = runnerReading('(\n    "ko_KR@sw=Korean;hw=Automatic",\n    "en_US@sw=QWERTY;hw=Automatic",\n    "emoji@sw=Emoji"\n)')
      await new SimctlWrapper(runner).resetKeyboardLanguage('device-1')
      expect(runner.exec.mock.calls.slice(1)).toEqual([
        ['spawn', 'device-1', 'defaults', 'write', 'com.apple.keyboard.preferences', 'KeyboardLastUsed', 'ko_KR@sw=Korean;hw=Automatic'],
        ['spawn', 'device-1', 'defaults', 'write', 'com.apple.keyboard.preferences', 'KeyboardsCurrentAndNext', '-array',
          'ko_KR@sw=Korean;hw=Automatic', 'ko_KR@sw=Korean;hw=Automatic', 'en_US@sw=QWERTY;hw=Automatic'],
        ['spawn', 'device-1', 'launchctl', 'kickstart', '-k', 'user/foreground/com.apple.TextInput.kbd'],
      ])
    })

    it('tries the daemon\'s old name when the new one fails, for a runtime nobody has measured', async () => {
      const runner = {
        exec: vi.fn()
          .mockResolvedValueOnce('(\n    "en_US@sw=QWERTY;hw=Automatic"\n)')
          .mockResolvedValueOnce('').mockResolvedValueOnce('')
          .mockRejectedValueOnce(new Error('Could not find service'))
          .mockResolvedValue(''),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      } satisfies SimctlRunner
      await new SimctlWrapper(runner).resetKeyboardLanguage('device-1')
      expect(runner.exec).toHaveBeenLastCalledWith('spawn', 'device-1', 'launchctl', 'kickstart', '-k', 'system/com.apple.kbd')
    })

    it('writes nothing when the device has no keyboards listed', async () => {
      const runner = runnerReading('(\n)')
      await new SimctlWrapper(runner).resetKeyboardLanguage('device-1')
      expect(runner.exec).toHaveBeenCalledTimes(1)
    })
  })

  describe('screenshot', () => {
    beforeEach(() => vi.clearAllMocks())

    it('saves to temp file and returns PNG buffer', async () => {
      const { promises: fsMock } = await import('fs')
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      vi.mocked(fsMock.readFile as (path: string) => Promise<Buffer>).mockResolvedValue(pngMagic)

      const runner: SimctlRunner = {
        exec: vi.fn().mockResolvedValue(''),
        execBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        execWithOpts: vi.fn().mockResolvedValue(''),
      }
      const wrapper = new SimctlWrapper(runner)
      const buf = await wrapper.screenshot('dev-1')

      expect(runner.exec).toHaveBeenCalledWith(
        'io', 'dev-1', 'screenshot', '--type', 'png',
        expect.stringMatching(/tapflow-.+\.png$/)
      )
      expect(buf).toEqual(pngMagic)
    })

    it('passes jpeg through to --type and names the temp file to match', async () => {
      // The default was the only branch covered, and `IOSAgent`'s note beside this pair says "the test
      // that scans exec arguments is what does" — true of `png`, and not of the branch that carries a
      // caller's choice. Everything that asks for JPEG (the MCP tool, and `MjpegStreamer` since it
      // stopped mislabelling its frames) goes through here, and asserting the *request* one layer up
      // proves nothing about what `simctl` was told.
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)
      await wrapper.screenshot('dev-1', 'jpeg')

      expect(runner.exec).toHaveBeenCalledWith(
        'io', 'dev-1', 'screenshot', '--type', 'jpeg',
        expect.stringMatching(/tapflow-.+\.jpg$/)
      )
    })
  })

  describe('isDeviceMissingError', () => {
    it('matches the "cannot be located on disk" signature', () => {
      expect(isDeviceMissingError(new Error(
        'Unable to boot device because it cannot be located on disk.',
      ))).toBe(true)
    })

    it('matches the "data is no longer present" signature', () => {
      expect(isDeviceMissingError(new Error(
        "The device's data is no longer present at /Users/x/.../data.",
      ))).toBe(true)
    })

    it('reads the signature from the error stderr field too', () => {
      expect(isDeviceMissingError(
        Object.assign(new Error('Command failed: xcrun simctl boot'), {
          stderr: 'Unable to boot device because it cannot be located on disk.',
        }),
      )).toBe(true)
    })

    it('does NOT match unrelated boot failures (guards against erasing healthy devices)', () => {
      expect(isDeviceMissingError(new Error('Unable to boot device in current state: Booted'))).toBe(false)
      expect(isDeviceMissingError(new Error('operation timed out'))).toBe(false)
      expect(isDeviceMissingError(new Error('xcrun: command not found'))).toBe(false)
    })

    it('returns false for non-error values', () => {
      expect(isDeviceMissingError(undefined)).toBe(false)
      expect(isDeviceMissingError(null)).toBe(false)
      expect(isDeviceMissingError('cannot be located on disk')).toBe(false)
    })
  })

  describe('clearAppData', () => {
    it('wipes Documents/Library/tmp contents but keeps the container structure', async () => {
      const os = await import('os')
      const path = await import('path')
      const realFs = (await vi.importActual<typeof import('fs')>('fs')).promises
      const container = await realFs.mkdtemp(path.join(os.tmpdir(), 'tapflow-container-'))
      await realFs.mkdir(path.join(container, 'Documents'))
      await realFs.mkdir(path.join(container, 'Library', 'Caches'), { recursive: true })
      await realFs.mkdir(path.join(container, 'tmp'))
      await realFs.writeFile(path.join(container, 'Documents', 'user.db'), 'data')
      await realFs.writeFile(path.join(container, 'Library', 'Caches', 'c.bin'), 'cache')
      await realFs.writeFile(path.join(container, 'tmp', 'scratch.dat'), 'tmp')
      await realFs.writeFile(path.join(container, '.metadata.plist'), 'meta')

      const runner = mockRunner({ get_app_container: `${container}\n` })
      const wrapper = new SimctlWrapper(runner)
      await wrapper.clearAppData('dev-1', 'com.example.app')

      expect(runner.exec).toHaveBeenCalledWith('terminate', 'dev-1', 'com.example.app')
      expect(await realFs.readdir(path.join(container, 'Documents'))).toEqual([])
      expect(await realFs.readdir(path.join(container, 'Library'))).toEqual([])
      expect(await realFs.readdir(path.join(container, 'tmp'))).toEqual([])
      // container root structure and metadata survive (unlike uninstall)
      expect(await realFs.readdir(container)).toContain('.metadata.plist')
      expect(await realFs.readdir(container)).toContain('Documents')

      await realFs.rm(container, { recursive: true, force: true })
    })

    it('throws PlatformError when the data container cannot be resolved', async () => {
      const runner = mockRunner({ get_app_container: 'No such file or directory\n' })
      const wrapper = new SimctlWrapper(runner)
      // Two arguments: this passed a single one, which silently became the *udid* while `bundleId`
      // went undefined.
      await expect(wrapper.clearAppData('dev-1', 'com.unknown')).rejects.toThrow(/data container/)
      // And the call, not only its outcome. `mockRunner` selects its answer from `args[0]`, so the
      // rejection above holds whatever the later arguments are — noting that in a comment while
      // asserting nothing about them is how the single-argument call survived in the first place.
      expect(runner.exec).toHaveBeenCalledWith('get_app_container', 'dev-1', 'com.unknown', 'data')
    })
  })

  // Routed through the runner (rather than spawning directly) so the clipboard gets the same
  // CoreSimulatorService recovery as every other simctl call — and so it is testable at all.
  describe('pasteboard', () => {
    it('reads through the runner, bounded by a timeout and a size ceiling', async () => {
      const runner = mockRunner({ pbpaste: 'on the device' })
      const wrapper = new SimctlWrapper(runner)

      await expect(wrapper.getPasteboard('dev-1')).resolves.toBe('on the device')
      const [opts, ...args] = vi.mocked(runner.execWithOpts).mock.calls[0]
      expect(args).toEqual(['pbpaste', 'dev-1'])
      expect(opts.timeoutMs).toBeGreaterThan(0)
      // The ceiling lives here, which is why callers do not re-check the length.
      expect(opts.maxBuffer).toBeGreaterThan(0)
    })

    it('writes the text on stdin — pbcopy cannot take it as an argument', async () => {
      const runner = mockRunner()
      const wrapper = new SimctlWrapper(runner)

      await wrapper.setPasteboard('dev-1', '한글 🎉\nline2')
      const [opts, ...args] = vi.mocked(runner.execWithOpts).mock.calls[0]
      expect(args).toEqual(['pbcopy', 'dev-1'])
      expect(opts.input).toBe('한글 🎉\nline2')
      expect(opts.timeoutMs).toBeGreaterThan(0)
    })

    it('returns the pasteboard verbatim — a trailing newline can be part of the copied text', async () => {
      const runner = mockRunner({ pbpaste: 'text\n' })
      await expect(new SimctlWrapper(runner).getPasteboard('dev-1')).resolves.toBe('text\n')
    })

    // These messages reach a user-facing toast, so they must not be Node's argv line.
    it('condenses a read failure and never surfaces the argv line', async () => {
      const runner = mockRunner()
      vi.mocked(runner.execWithOpts).mockRejectedValue(
        new Error('Command failed: xcrun simctl pbpaste UDID\nUnable to connect to device pasteboard.'),
      )
      await expect(new SimctlWrapper(runner).getPasteboard('dev-1'))
        .rejects.toThrow(/Unable to connect to device pasteboard/)
      await expect(new SimctlWrapper(runner).getPasteboard('dev-1'))
        .rejects.not.toThrow(/Command failed:/)
    })

    // The timeout path produces no stderr, which used to fall through to the argv line.
    it('condenses a bare failure with no usable line', async () => {
      const runner = mockRunner()
      vi.mocked(runner.execWithOpts).mockRejectedValue(new Error('Command failed: xcrun simctl pbcopy UDID'))
      await expect(new SimctlWrapper(runner).setPasteboard('dev-1', 'x'))
        .rejects.toThrow(/did not respond/)
    })

    it('wraps write failures too, not just reads', async () => {
      const runner = mockRunner()
      vi.mocked(runner.execWithOpts).mockRejectedValue(new Error('boom'))
      await expect(new SimctlWrapper(runner).setPasteboard('dev-1', 'x'))
        .rejects.toThrow(/Could not write the device clipboard/)
    })
  })
})

describe('SimctlWrapper run reset commands', () => {
  it('bounds each device-wide reset and names the device explicitly', async () => {
    const runner = mockRunner()
    const sw = new SimctlWrapper(runner)
    await sw.resetKeychain('dev-1')
    await sw.resetPrivacy('dev-1')
    await sw.clearLocation('dev-1')
    await sw.waitForBootStatus('dev-1')
    const calls = (runner.execWithOpts as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map((c) => c.slice(1))).toEqual([
      ['keychain', 'dev-1', 'reset'], ['privacy', 'dev-1', 'reset', 'all'], ['location', 'dev-1', 'clear'], ['bootstatus', 'dev-1'],
    ])
    for (const c of calls) expect((c[0] as SimctlExecOpts).timeoutMs).toBeGreaterThan(0)
  })

  it('treats an app that is not installed as nothing to clear, and anything else as a failure', async () => {
    const missing = Object.assign(new Error('Command failed'), { stderr: 'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):\nNo such file or directory' })
    const runner = mockRunner()
    vi.mocked(runner.execWithOpts).mockImplementation(async (_o: SimctlExecOpts, ...args: string[]) => { if (args[0] === 'get_app_container') throw missing; return '' })
    await expect(new SimctlWrapper(runner).clearAppDataIfInstalled('dev-1', 'com.example.app')).resolves.toBeUndefined()

    vi.mocked(runner.execWithOpts).mockImplementation(async (_o: SimctlExecOpts, ...args: string[]) => { if (args[0] === 'get_app_container') throw new Error('CoreSimulatorService connection interrupted'); return '' })
    await expect(new SimctlWrapper(runner).clearAppDataIfInstalled('dev-1', 'com.example.app')).rejects.toThrow('interrupted')
  })

  // These gate a boot's ready, so a wedged CoreSimulatorService must not hold it with nothing able to release it.
  it('bounds the app commands a run reset uses, and only those', async () => {
    const runner = mockRunner({ get_app_container: '/tmp/tapflow-no-such-container' })
    const sw = new SimctlWrapper(runner)
    await sw.uninstallAppForReset('dev-1', 'com.example.app')
    await sw.clearAppDataIfInstalled('dev-1', 'com.example.app')
    const bounded = vi.mocked(runner.execWithOpts).mock.calls
    expect(bounded.map((c) => c[1])).toEqual(['uninstall', 'terminate', 'get_app_container'])
    for (const c of bounded) expect(c[0].timeoutMs).toBeGreaterThan(0)
    expect(runner.exec).not.toHaveBeenCalled()
    await sw.uninstallApp('dev-1', 'com.example.app')
    expect(runner.exec).toHaveBeenCalledWith('uninstall', 'dev-1', 'com.example.app')
  })
})
