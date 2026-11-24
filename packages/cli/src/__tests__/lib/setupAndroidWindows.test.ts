import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { win32 as p } from 'node:path'
import {
  ACCEL_GUIDANCE, REGISTER_ENV_SCRIPT, SDKMANAGER_INSTALL_ATTEMPTS, WINDOWS_ENV_WRITE_FAILED, WINGET_JDK_ID, adoptiumApiUrl,
  checkAccelWindows, checkAndFixAvdWindows, checkAndFixJdkWindows, cmdLine, missingSdkPackages,
  parseAdoptiumAssets, parseCmdlineToolsArchive, parseDeviceIds, parseJavaMajor, runSetupAndroidWindows,
  runTool, sdkToolEnv, windowsSdkDir, windowsSystemImage,
  type JdkFound, type RunOptions, type RunResult, type WindowsSetupDeps,
} from '../../lib/setup-android-windows.js'

const HOME = 'C:\\Users\\Isaac Obeng'
const LOCAL = `${HOME}\\AppData\\Local`
const SDK = `${LOCAL}\\Android\\Sdk`
const COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
const TAR = 'C:\\Windows\\System32\\tar.exe'
const JAVA17 = 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.18.8-hotspot\\bin\\java.exe'
const SDKMANAGER = p.join(SDK, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat')
const AVDMANAGER = p.join(SDK, 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat')
const EMULATOR = p.join(SDK, 'emulator', 'emulator.exe')
const IMAGE_DIR = p.join(SDK, 'system-images', 'android-35', 'google_apis', 'x86_64')
const CLT_SHA1 = '57d04f2d75eb8e8fffc5000a987e5de4b5a63e9d'

const REPO_XML = `<sdk:sdk-repository>
  <remotePackage path="cmdline-tools;latest">
    <revision><major>23</major><minor>0</minor></revision>
    <archives>
      <archive><complete><size>181052239</size><checksum type="sha1">e025545c62a8e64c7559119566a569fb1dec5f60</checksum>
        <url>commandlinetools-linux-16111833_latest.zip</url></complete><host-os>linux</host-os></archive>
      <archive><complete><size>154957218</size><checksum type="sha1">${CLT_SHA1}</checksum>
        <url>commandlinetools-win-16111833_latest.zip</url></complete><host-os>windows</host-os></archive>
    </archives>
  </remotePackage>
  <remotePackage path="cmdline-tools;2.0"><archives><archive><complete><checksum type="sha1">${'0'.repeat(40)}</checksum>
    <url>commandlinetools-win-old.zip</url></complete><host-os>windows</host-os></archive></archives></remotePackage>
</sdk:sdk-repository>`

const DEVICE_LIST = `id: 0 or "pixel"\n    Name: Pixel\n---------\nid: 1 or "pixel_5"\n---------\nid: 2 or "pixel_7"\n---------\nid: 3 or "pixel_7_pro"\n---------\nid: 4 or "pixel_tablet"\n`

interface Call { file: string; args: string[]; opts: RunOptions }

/** An in-memory Windows PC. `files` are paths that exist; `run` answers per command. */
function fakePc(opts: {
  files?: string[]
  env?: NodeJS.ProcessEnv
  interactive?: boolean
  answers?: boolean[]
  hashes?: Record<string, string>
  respond?: (c: Call, pc: { files: Set<string>; avds: string[] }) => RunResult | undefined
} = {}) {
  const files = new Set(opts.files ?? [])
  const avds: string[] = []
  const calls: Call[] = []
  const downloads: string[] = []
  const prompts: string[] = []
  const answers = [...(opts.answers ?? [])]
  const env: NodeJS.ProcessEnv = { LOCALAPPDATA: LOCAL, ComSpec: COMSPEC, SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32', ...opts.env }
  const ok = (stdout = '', stderr = ''): RunResult => ({ status: 0, stdout, stderr })
  const deps: WindowsSetupDeps = {
    env,
    arch: 'x64',
    home: HOME,
    exists: (f) => files.has(f) || [...files].some((x) => x.startsWith(`${f}\\`)),
    readdir: (dir) => [...new Set([...files].filter((x) => x.startsWith(`${dir}\\`)).map((x) => x.slice(dir.length + 1).split('\\')[0]!))],
    mkdirp: () => {},
    rename: (from, to) => {
      for (const f of [...files]) if (f.startsWith(`${from}\\`)) { files.delete(f); files.add(to + f.slice(from.length)) }
    },
    remove: (dir) => { for (const f of [...files]) if (f === dir || f.startsWith(`${dir}\\`)) files.delete(f) },
    tempDir: () => 'C:\\Temp\\tf',
    run: (file, args, o = {}) => {
      const call = { file, args, opts: o }
      calls.push(call)
      const custom = opts.respond?.(call, { files, avds })
      if (custom) return custom
      const line = args.join(' ')
      if (file.endsWith('java.exe') && args[0] === '-version') return ok('', 'openjdk version "17.0.18" 2026-01-20\n')
      if (file === TAR) {
        const dest = args[args.indexOf('-C') + 1]!
        if (args[1]!.endsWith('cmdline-tools.zip')) files.add(`${dest}\\cmdline-tools\\bin\\sdkmanager.bat`).add(`${dest}\\cmdline-tools\\bin\\avdmanager.bat`)
        return ok()
      }
      if (file === COMSPEC) {
        if (line.includes('sdkmanager.bat') && !line.includes('--licenses')) {
          if (line.includes('platform-tools')) files.add(p.join(SDK, 'platform-tools', 'adb.exe'))
          if (line.includes('"emulator"')) files.add(EMULATOR)
          if (line.includes('build-tools;35.0.0')) files.add(p.join(SDK, 'build-tools', '35.0.0', 'aapt.exe'))
          if (line.includes('platforms;android-35')) files.add(p.join(SDK, 'platforms', 'android-35', 'android.jar'))
          if (line.includes('system-images;android-35;google_apis;x86_64')) files.add(p.join(IMAGE_DIR, 'system.img'))
        }
        if (line.includes('avdmanager.bat') && line.includes('list') && line.includes('device')) return ok(DEVICE_LIST)
        const n = line.match(/"-n" "([^"]+)"/)?.[1]
        if (line.includes('avdmanager.bat') && n) avds.push(n)
        return ok()
      }
      if (file === EMULATOR && args[0] === '-list-avds') return ok(avds.map((a) => `${a}\r\n`).join(''))
      if (file === EMULATOR && args[0] === '-accel-check') return ok('accel:\r\n0\r\nWHPX(10.0.19045) is installed and usable.\r\naccel\r\n')
      if (file === 'powershell.exe') return ok('added\r\n')
      return ok()
    },
    which: (name) => (name === 'java' && files.has(JAVA17) ? JAVA17 : name === 'winget' && files.has('winget') ? 'C:\\WindowsApps\\winget.exe' : null),
    fetchText: async (url) => {
      if (url.includes('repository2-3.xml')) return REPO_XML
      if (url.includes('api.adoptium.net')) return JSON.stringify([{ binary: { package: { name: 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.13.1_2.zip', link: 'https://example.invalid/jdk.zip', checksum: 'abc123' } } }])
      throw new Error(`unexpected fetch ${url}`)
    },
    download: async (url, dest) => { downloads.push(url); files.add(dest) },
    fileHash: async (file) => opts.hashes?.[p.basename(file)] ?? (file.endsWith('cmdline-tools.zip') ? CLT_SHA1 : 'abc123'),
    interactive: () => opts.interactive ?? true,
    confirm: async (m) => { prompts.push(m); return answers.length ? answers.shift()! : true },
    log: () => {},
  }
  return { deps, files, calls, downloads, prompts, avds }
}

/** Isaac's PC: JDK 17 on PATH; an SDK left by Android Studio with platform-tools, emulator,
 *  build-tools and platforms, but no cmdline-tools, no system image and no AVD. */
const PARTIAL_SDK = [
  JAVA17,
  p.join(SDK, 'platform-tools', 'adb.exe'),
  EMULATOR,
  p.join(SDK, 'build-tools', '35.0.0', 'aapt.exe'),
  p.join(SDK, 'platforms', 'android-35', 'android.jar'),
  TAR,
]

describe('Windows setup android: a partial SDK without Android Studio pieces', () => {
  it('reuses the JDK and SDK, adds cmdline-tools, the system image and the AVD set', async () => {
    const pc = fakePc({ files: PARTIAL_SDK })
    const results = await runSetupAndroidWindows(pc.deps)

    expect(results.map((r) => [r.label.split(':')[0], r.ok])).toEqual([
      ['Java (JDK 17)', true],
      ['Android SDK installed', true],
      ['AVDs created', true],
      ['Hardware acceleration', true],
    ])
    // Downloaded from the manifest's Windows archive, nothing else.
    expect(pc.downloads).toEqual(['https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip'])
    expect(pc.files.has(SDKMANAGER)).toBe(true)
    // Only what was missing is installed, through cmd.exe, every argument quoted.
    const installs = pc.calls.filter((c) => c.file === COMSPEC && c.args.join(' ').includes('sdkmanager.bat') && !c.args.join(' ').includes('--licenses'))
    expect(installs).toHaveLength(1)
    expect(installs[0]!.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(installs[0]!.args[3]).toBe(`""${SDKMANAGER}" "--sdk_root=${SDK}" "system-images;android-35;google_apis;x86_64""`)
    expect(installs[0]!.opts.env?.['ANDROID_HOME']).toBe(SDK)
    // Licences are accepted with piped answers, not a prompt.
    const lic = pc.calls.find((c) => c.args.join(' ').includes('--licenses'))
    expect(lic?.opts.input?.startsWith('y\n')).toBe(true)
    // The same four AVDs as macOS, verified with -list-avds.
    expect(pc.avds).toEqual(['tapflow-compact', 'tapflow-phone', 'tapflow-large', 'tapflow-tablet'])
    expect(results[1]!.detail).toContain('open a new terminal')
  })

  it('does nothing but check when everything is already there', async () => {
    const pc = fakePc({ files: [...PARTIAL_SDK, SDKMANAGER, AVDMANAGER, p.join(IMAGE_DIR, 'system.img')] })
    pc.avds.push('Pixel_8')
    const results = await runSetupAndroidWindows(pc.deps)

    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => r.state)).toEqual(['found', 'found', 'found', 'found'])
    expect(pc.downloads).toEqual([])
    expect(pc.prompts).toEqual([])
    expect(pc.calls.some((c) => c.file === COMSPEC)).toBe(false)
  })

  it('asks before downloading, and installs nothing when declined', async () => {
    const pc = fakePc({ files: PARTIAL_SDK, answers: [false] })
    const results = await runSetupAndroidWindows(pc.deps)

    expect(pc.prompts[0]).toContain('cmdline-tools, system-images;android-35;google_apis;x86_64')
    expect(results[1]).toMatchObject({ ok: false, warn: true })
    expect(results[2]).toMatchObject({ label: 'AVD', ok: false })
    expect(pc.downloads).toEqual([])
  })

  it('only reports what is missing when it cannot ask', async () => {
    const pc = fakePc({ files: PARTIAL_SDK, interactive: false })
    const results = await runSetupAndroidWindows(pc.deps)

    expect(results[1]!.detail).toContain('non-interactive')
    expect(pc.downloads).toEqual([])
  })

  it('refuses a cmdline-tools download whose SHA-1 does not match the manifest', async () => {
    const pc = fakePc({ files: PARTIAL_SDK, hashes: { 'cmdline-tools.zip': 'f'.repeat(40) } })
    const results = await runSetupAndroidWindows(pc.deps)

    expect(results[1]).toMatchObject({ ok: false })
    expect(results[1]!.detail).toContain('checksum mismatch')
    expect(pc.files.has(SDKMANAGER)).toBe(false)
  })

  it('installs the whole SDK on a PC with none', async () => {
    const pc = fakePc({ files: [JAVA17, TAR] })
    const results = await runSetupAndroidWindows(pc.deps)

    expect(results.every((r) => r.ok)).toBe(true)
    const install = pc.calls.find((c) => c.file === COMSPEC && c.args.join(' ').includes('"platform-tools"'))!
    expect(install.args[3]).toContain('"platform-tools" "emulator" "build-tools;35.0.0" "platforms;android-35" "system-images;android-35;google_apis;x86_64"')
  })

  it('picks the arm64 image on ARM64 Windows', () => {
    expect(windowsSystemImage('arm64')).toBe('system-images;android-35;google_apis;arm64-v8a')
    const pc = fakePc({ files: PARTIAL_SDK })
    pc.deps.arch = 'arm64'
    expect(missingSdkPackages(pc.deps, SDK)).toEqual(['system-images;android-35;google_apis;arm64-v8a'])
  })

  it('retries sdkmanager when a package download drops, then finishes the install', async () => {
    let attempts = 0
    const pc = fakePc({
      files: PARTIAL_SDK,
      respond: (c) => {
        if (c.file === COMSPEC && c.args.join(' ').includes('sdkmanager.bat') && !c.args.join(' ').includes('--licenses')) {
          attempts += 1
          if (attempts === 1) {
            return { status: 1, stdout: '', stderr: 'Failed to download package archive for system-images/android-35/google_apis/x86_64: closed.' }
          }
        }
        return undefined
      },
    })
    const results = await runSetupAndroidWindows(pc.deps)

    expect(results.every((r) => r.ok)).toBe(true)
    const installs = pc.calls.filter((c) => c.file === COMSPEC && c.args.join(' ').includes('sdkmanager.bat') && !c.args.join(' ').includes('--licenses'))
    expect(installs).toHaveLength(2)
    expect(attempts).toBe(2)
  })

  it('gives up after the last sdkmanager attempt and reports the leftover packages', async () => {
    const pc = fakePc({
      files: PARTIAL_SDK,
      respond: (c) => {
        if (c.file === COMSPEC && c.args.join(' ').includes('sdkmanager.bat') && !c.args.join(' ').includes('--licenses')) {
          return { status: 1, stdout: '', stderr: 'Failed to download package archive for system-images/android-35/google_apis/x86_64: closed.' }
        }
        return undefined
      },
    })
    const results = await runSetupAndroidWindows(pc.deps)

    expect(results[1]).toMatchObject({ ok: false })
    expect(results[1]!.detail).toContain('sdkmanager failed installing: system-images;android-35;google_apis;x86_64')
    const installs = pc.calls.filter((c) => c.file === COMSPEC && c.args.join(' ').includes('sdkmanager.bat') && !c.args.join(' ').includes('--licenses'))
    expect(installs).toHaveLength(SDKMANAGER_INSTALL_ATTEMPTS)
  })
})

describe('Windows setup android: the JDK', () => {
  it('installs Temurin with winget when no JDK 17+ is found', async () => {
    const jdk21 = 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.13.11-hotspot'
    const pc = fakePc({
      files: ['winget', TAR],
      env: { ProgramFiles: 'C:\\Program Files' },
      respond: (c, state) => {
        if (c.file.endsWith('winget.exe')) { state.files.add(`${jdk21}\\bin\\java.exe`); return { status: 0, stdout: '', stderr: '' } }
        if (c.file.endsWith('java.exe')) return { status: 0, stdout: '', stderr: 'openjdk version "21.0.13" 2026-10-21\n' }
        return undefined
      },
    })
    const results = await runSetupAndroidWindows(pc.deps)

    const winget = pc.calls.find((c) => c.file.endsWith('winget.exe'))!
    expect(winget.args).toEqual(['install', '--id', WINGET_JDK_ID, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'])
    expect(results[0]).toMatchObject({ label: 'Java (JDK 21) installed', ok: true, state: 'created' })
    // The new JDK is handed to sdkmanager even though this process's PATH predates it.
    const sdkCall = pc.calls.find((c) => c.args.join(' ').includes('sdkmanager.bat'))!
    expect(sdkCall.opts.env?.['JAVA_HOME']).toBe(jdk21)
    expect(sdkCall.opts.env?.['Path']?.startsWith(`${jdk21}\\bin;`)).toBe(true)
  })

  it('falls back to the verified Temurin zip in the tapflow folder without winget', async () => {
    const managed = `${HOME}\\.tapflow\\tools\\jdk`
    const pc = fakePc({
      files: [TAR],
      respond: (c, state) => {
        if (c.file === TAR && c.args[1]!.endsWith('.zip') && c.args.includes(managed)) {
          state.files.add(`${managed}\\jdk-21.0.13.1+2\\bin\\java.exe`)
          return { status: 0, stdout: '', stderr: '' }
        }
        if (c.file.endsWith('java.exe')) return { status: 0, stdout: '', stderr: 'openjdk version "21.0.13"\n' }
        return undefined
      },
    })
    const results = await runSetupAndroidWindows(pc.deps)

    expect(pc.downloads[0]).toBe('https://example.invalid/jdk.zip')
    expect(results[0]).toMatchObject({ ok: true, state: 'created' })
    expect(results[0]!.detail).toContain(managed)
  })

  it('with --yes skips winget (it can raise UAC) and takes the per-user Temurin zip', async () => {
    const managed = `${HOME}\\.tapflow\\tools\\jdk`
    const pc = fakePc({
      files: ['winget', TAR],
      interactive: false,
      respond: (c, state) => {
        if (c.file === TAR && c.args[1]!.endsWith('.zip') && c.args.includes(managed)) {
          state.files.add(`${managed}\\jdk-21.0.13.1+2\\bin\\java.exe`)
          return { status: 0, stdout: '', stderr: '' }
        }
        if (c.file.endsWith('java.exe')) return { status: 0, stdout: '', stderr: 'openjdk version "21.0.13"\n' }
        return undefined
      },
    })
    const { result } = await checkAndFixJdkWindows({ ...pc.deps, interactive: () => true, unattended: true })

    expect(pc.calls.some((c) => c.file.endsWith('winget.exe'))).toBe(false)
    expect(pc.downloads[0]).toBe('https://example.invalid/jdk.zip')
    expect(result).toMatchObject({ ok: true, state: 'created' })
  })

  it('rejects a Temurin zip whose SHA-256 does not match', async () => {
    const pc = fakePc({ files: [TAR], hashes: { 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.13.1_2.zip': 'bad' } })
    const results = await runSetupAndroidWindows(pc.deps)

    expect(results[0]).toMatchObject({ ok: false })
    expect(results[0]!.detail).toContain('checksum mismatch')
    expect(results[1]).toMatchObject({ ok: false, detail: 'Install a JDK first (Android SDK tools need Java).' })
  })

  it('ignores a JDK older than 17', async () => {
    const pc = fakePc({
      files: [JAVA17],
      interactive: false,
      respond: (c) => (c.file.endsWith('java.exe') ? { status: 0, stdout: '', stderr: 'java version "1.8.0_402"\n' } : undefined),
    })
    const results = await runSetupAndroidWindows(pc.deps)
    expect(results[0]).toMatchObject({ ok: false, warn: true })
  })
})

describe('Windows setup android: hardware acceleration', () => {
  it('reports a missing hypervisor with guidance, and changes nothing', () => {
    const pc = fakePc({
      files: [EMULATOR],
      respond: (c) => (c.args[0] === '-accel-check'
        ? { status: 1, stdout: 'accel:\r\n11\r\nWHPX is not installed or not usable\r\naccel\r\n', stderr: '' }
        : undefined),
    })
    const r = checkAccelWindows(pc.deps, SDK)
    expect(r).toMatchObject({ ok: false, warn: true })
    expect(r.detail).toContain('WHPX is not installed or not usable')
    expect(r.detail).toContain(ACCEL_GUIDANCE)
    expect(pc.calls.map((c) => c.file)).toEqual([EMULATOR])
  })
})

describe('Windows setup android: helpers', () => {
  it('quotes every cmd.exe argument and refuses embedded quotes', () => {
    expect(cmdLine('C:\\Program Files\\sdk\\sdkmanager.bat', ['--sdk_root=C:\\Users\\Isaac Obeng\\Sdk', 'platforms;android-35']))
      .toBe('"C:\\Program Files\\sdk\\sdkmanager.bat" "--sdk_root=C:\\Users\\Isaac Obeng\\Sdk" "platforms;android-35"')
    expect(() => cmdLine('a.bat', ['x"y'])).toThrow(/double quote/)
    // cmd.exe expands %VAR% even inside quotes, so an argument holding % is refused too.
    expect(() => cmdLine('a.bat', ['C:\\dir%VAR%'])).toThrow(/%/)
  })

  it('runs .exe tools directly and .bat scripts through ComSpec', () => {
    const pc = fakePc()
    runTool(pc.deps, 'C:\\x\\emulator.exe', ['-list-avds'])
    runTool(pc.deps, 'C:\\x\\avdmanager.bat', ['list'])
    expect(pc.calls[0]!.file).toBe('C:\\x\\emulator.exe')
    expect(pc.calls[1]).toMatchObject({ file: COMSPEC, args: ['/d', '/s', '/c', '""C:\\x\\avdmanager.bat" "list""'] })
  })

  it('reads the Windows cmdline-tools archive from the manifest', () => {
    expect(parseCmdlineToolsArchive(REPO_XML)).toEqual({
      url: 'https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip',
      sha1: CLT_SHA1,
      size: 154957218,
      revision: '23.0',
    })
    expect(parseCmdlineToolsArchive('<sdk/>')).toBeNull()
  })

  it('parses java -version for modern and legacy numbering', () => {
    expect(parseJavaMajor('openjdk version "17.0.18" 2026-01-20')).toBe(17)
    expect(parseJavaMajor('openjdk version "21" 2023-09-19')).toBe(21)
    expect(parseJavaMajor('java version "1.8.0_402"')).toBe(8)
    expect(parseJavaMajor('nothing here')).toBeNull()
  })

  it('reads the zip package from the Adoptium API and builds the URL per architecture', () => {
    expect(parseAdoptiumAssets('[{"binary":{"package":{"name":"a.zip","link":"https://x/a.zip","checksum":"c"}}}]')).toEqual({ name: 'a.zip', link: 'https://x/a.zip', checksum: 'c' })
    expect(parseAdoptiumAssets('not json')).toBeNull()
    expect(adoptiumApiUrl('arm64')).toContain('architecture=aarch64')
    expect(adoptiumApiUrl('x64')).toContain('/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows')
  })

  it('finds device ids in avdmanager output', () => {
    expect(parseDeviceIds(DEVICE_LIST)).toEqual(['pixel', 'pixel_5', 'pixel_7', 'pixel_7_pro', 'pixel_tablet'])
  })

  it('uses ANDROID_HOME when set, else %LOCALAPPDATA%\\Android\\Sdk', () => {
    expect(windowsSdkDir({ env: { ANDROID_HOME: 'D:\\sdk' }, home: HOME })).toBe('D:\\sdk')
    expect(windowsSdkDir({ env: { LOCALAPPDATA: LOCAL }, home: HOME })).toBe(SDK)
    expect(windowsSdkDir({ env: {}, home: HOME })).toBe(SDK)
  })

  it('keeps a half-extracted system image in the missing set until it is complete', () => {
    const image = p.join(SDK, 'system-images', 'android-35', 'google_apis', 'x86_64')
    // The package directory exists but neither completeness marker does — a dropped extraction.
    const partial = fakePc({ files: [...PARTIAL_SDK, SDKMANAGER, p.join(image, 'x86_64.props')] })
    expect(missingSdkPackages(partial.deps, SDK)).toContain('system-images;android-35;google_apis;x86_64')
    // With system.img present the image counts as installed.
    const complete = fakePc({ files: [...PARTIAL_SDK, SDKMANAGER, p.join(image, 'system.img')] })
    expect(missingSdkPackages(complete.deps, SDK)).not.toContain('system-images;android-35;google_apis;x86_64')
    // source.properties without system.img is still a half-finished image: the emulator boots system.img.
    const marked = fakePc({ files: [...PARTIAL_SDK, SDKMANAGER, p.join(image, 'source.properties')] })
    expect(missingSdkPackages(marked.deps, SDK)).toContain('system-images;android-35;google_apis;x86_64')
  })

  it('does not run avdmanager without a JDK, and says to install one', async () => {
    const pc = fakePc({ files: [...PARTIAL_SDK, SDKMANAGER, AVDMANAGER, p.join(IMAGE_DIR, 'system.img')] })
    const r = await checkAndFixAvdWindows(pc.deps, SDK, true, null)
    expect(r).toMatchObject({ label: 'AVD', ok: false })
    expect(r.detail).toContain('Install a JDK 17+ first')
    expect(pc.prompts).toEqual([])
    expect(pc.calls.some((c) => c.args.join(' ').includes('avdmanager.bat'))).toBe(false)
  })

  it('says so when the user environment could not be written', async () => {
    const pc = fakePc({
      files: PARTIAL_SDK,
      respond: (c) => (c.file === 'powershell.exe' ? { status: 1, stdout: '', stderr: 'blocked by policy' } : undefined),
    })
    const results = await runSetupAndroidWindows(pc.deps)
    expect(results[1]).toMatchObject({ label: 'Android SDK installed', ok: true })
    expect(results[1]!.detail).toContain(WINDOWS_ENV_WRITE_FAILED)
  })

  it('reads and writes the user Path through the registry, keeping it expandable', () => {
    // [Environment]::Get/SetEnvironmentVariable on Windows PowerShell expand on read and store REG_SZ.
    expect(REGISTER_ENV_SCRIPT).toContain("'DoNotExpandEnvironmentNames'")
    expect(REGISTER_ENV_SCRIPT).toContain('[Microsoft.Win32.RegistryValueKind]::ExpandString')
    expect(REGISTER_ENV_SCRIPT).not.toContain("GetEnvironmentVariable('Path'")
    expect(REGISTER_ENV_SCRIPT).not.toContain("SetEnvironmentVariable('Path'")
  })
})

// The script above only means anything in PowerShell, so on a Windows host it is run for real —
// against a scratch key under HKCU\Software, never the user's Environment key, and deleted after.
describe.runIf(process.platform === 'win32')('REGISTER_ENV_SCRIPT on a real Windows registry', () => {
  const ps = (command: string, env: NodeJS.ProcessEnv) =>
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, ...env }, encoding: 'utf8' })

  it('keeps %VAR% entries and REG_EXPAND_SZ, appends the SDK folders once, and is idempotent', () => {
    const key = `Software\\tapflow-test-${process.pid}-${Date.now()}`
    const sdk = 'C:\\tapflow-test-sdk'
    try {
      // A one-entry Path, as REG_EXPAND_SZ, holding a variable: the shape Windows itself writes.
      const seed = ps("$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:K); $k.SetValue('Path', '%USERPROFILE%\\bin', [Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close()", { K: key })
      expect(seed.status, seed.stderr).toBe(0)

      const first = ps(REGISTER_ENV_SCRIPT, { TAPFLOW_ENV_KEY: key, TAPFLOW_SDK: sdk })
      expect(first.status, first.stderr).toBe(0)
      expect(first.stdout.trim()).toBe('added')

      const read = ps("$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:K); [string]$k.GetValueKind('Path'); $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $k.GetValue('ANDROID_HOME'); $k.Close()", { K: key })
      const [kind, raw, androidHome] = read.stdout.trim().split(/\r?\n/)
      expect(kind).toBe('ExpandString')
      expect(raw).toBe(`%USERPROFILE%\\bin;${sdk}\\platform-tools;${sdk}\\emulator`)
      expect(androidHome).toBe(sdk)

      const second = ps(REGISTER_ENV_SCRIPT, { TAPFLOW_ENV_KEY: key, TAPFLOW_SDK: sdk })
      expect(second.stdout.trim()).toBe('present')
    } finally {
      ps('[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:K, $false)', { K: key })
    }
  })
})

describe('Windows setup android: the JDK the SDK tools run on', () => {
  it('drops an older inherited JAVA_HOME when the accepted JDK came from PATH', () => {
    const pathJdk: JdkFound = { javaHome: null, javaExe: JAVA17, major: 17 }
    const pc = fakePc({ files: PARTIAL_SDK, env: { JAVA_HOME: 'C:\\Java\\jdk-8' } })
    const env = sdkToolEnv(pc.deps, SDK, pathJdk)
    // A Java 8 JAVA_HOME would make sdkmanager.bat run on the wrong Java; it must not survive.
    expect(env['JAVA_HOME']).toBeUndefined()
    // A JDK with its own home is still exported, and put on PATH ahead of the inherited one.
    const homeJdk: JdkFound = { javaHome: 'C:\\Java\\jdk-21', javaExe: 'C:\\Java\\jdk-21\\bin\\java.exe', major: 21 }
    const env2 = sdkToolEnv(pc.deps, SDK, homeJdk)
    expect(env2['JAVA_HOME']).toBe('C:\\Java\\jdk-21')
    expect(env2['Path']?.startsWith('C:\\Java\\jdk-21\\bin;')).toBe(true)
  })
})
