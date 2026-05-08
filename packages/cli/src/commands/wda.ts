import { execSync, spawn } from 'node:child_process'
import { existsSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  ensureTapflowDir,
  WDA_SOURCE_DIR,
  WDA_BUILD_DIR,
  WDA_XCTESTRUN_CACHE,
} from '../lib/tapflow-dir'
import { checkWdaProcess } from '../lib/doctor'
import { banner, createSpinner, step } from '../lib/print'

const WDA_REPO = 'https://github.com/appium/WebDriverAgent.git'

export async function cmdWda(action: string | undefined): Promise<void> {
  switch (action) {
    case 'install': return wdaInstall()
    case 'start':   return wdaStart()
    case 'stop':    return wdaStop()
    case 'status':  return wdaStatus()
    default:
      console.error('Usage: tapflow wda <install|start|stop|status>')
      process.exit(1)
  }
}

async function wdaInstall(): Promise<void> {
  ensureTapflowDir()

  if (existsSync(WDA_XCTESTRUN_CACHE)) {
    const rl = readline.createInterface({ input, output })
    const answer = await rl.question('WebDriverAgent is already installed. Reinstall? [y/N] ')
    rl.close()
    if (!answer.trim().toLowerCase().startsWith('y')) return
  }

  let sourcePath: string
  try {
    sourcePath = await cloneWda()
  } catch (e) {
    banner('error', 'CLONE FAILED', [(e as Error).message])
    const rl = readline.createInterface({ input, output })
    const manual = await rl.question('\nEnter path to your WebDriverAgent source directory: ')
    rl.close()
    sourcePath = manual.trim()
    if (!sourcePath || !existsSync(sourcePath)) {
      banner('error', 'PATH NOT FOUND', [sourcePath])
      process.exit(1)
    }
  }

  await buildWda(sourcePath)
}

async function cloneWda(): Promise<string> {
  const alreadyCloned = existsSync(join(WDA_SOURCE_DIR, 'WebDriverAgent.xcodeproj'))
  const msg = alreadyCloned ? 'Updating WebDriverAgent source…' : 'Cloning WebDriverAgent…'
  const spinner = createSpinner(msg)
  spinner.start()

  try {
    if (alreadyCloned) {
      execSync('git pull --ff-only', { cwd: WDA_SOURCE_DIR, stdio: 'pipe' })
    } else {
      execSync(`git clone --depth 1 ${WDA_REPO} ${WDA_SOURCE_DIR}`, { stdio: 'pipe' })
    }
    spinner.stop(true)
    step(`Source ready: ${WDA_SOURCE_DIR}`)
    return WDA_SOURCE_DIR
  } catch (e) {
    spinner.stop(false)
    throw e
  }
}

async function buildWda(sourcePath: string): Promise<void> {
  const xcodeproj = join(sourcePath, 'WebDriverAgent.xcodeproj')
  if (!existsSync(xcodeproj)) {
    banner('error', 'BUILD FAILED', [`WebDriverAgent.xcodeproj not found in ${sourcePath}`])
    process.exit(1)
  }

  const spinner = createSpinner('Building WebDriverAgent (this may take a few minutes)…')
  spinner.start()

  let stdout = ''
  let stderr = ''

  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(
      'xcodebuild',
      [
        'build-for-testing',
        '-project', xcodeproj,
        '-scheme', 'WebDriverAgentRunner',
        '-destination', 'platform=iOS Simulator,name=iPhone 16',
        '-derivedDataPath', WDA_BUILD_DIR,
        'CODE_SIGN_IDENTITY=',
        'CODE_SIGNING_REQUIRED=NO',
        'GCC_TREAT_WARNINGS_AS_ERRORS=0',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('exit', (code) => resolve(code ?? 1))
    proc.on('error', () => resolve(1))
  })

  const succeeded = stdout.includes('** TEST BUILD SUCCEEDED **') || exitCode === 0
  spinner.stop(succeeded)

  if (!succeeded) {
    const errorLines = extractKeyErrors(stdout + stderr)
    banner('error', 'BUILD FAILED', errorLines)
    process.exit(1)
  }

  const productsDir = join(WDA_BUILD_DIR, 'Build', 'Products')
  const xctestrunFiles = readdirSync(productsDir).filter((f) => f.endsWith('.xctestrun'))
  if (xctestrunFiles.length === 0) {
    banner('error', 'BUILD FAILED', ['Build reported success but no .xctestrun file was found.'])
    process.exit(1)
  }

  copyFileSync(join(productsDir, xctestrunFiles[0]!), WDA_XCTESTRUN_CACHE)
  banner('success', 'BUILD SUCCEEDED', [
    `Installed: ${WDA_XCTESTRUN_CACHE}`,
    'Run `tapflow start` to connect.',
  ])
}

function extractKeyErrors(output: string): string[] {
  return output
    .split('\n')
    .filter((l) => /error:|Code signing|No such scheme|BUILD FAILED/.test(l))
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
}

async function wdaStart(): Promise<void> {
  const { running } = checkWdaProcess()
  if (running) {
    console.log('WDA is already running.')
    return
  }

  if (!existsSync(WDA_XCTESTRUN_CACHE)) {
    console.error('WebDriverAgent not installed. Run `tapflow wda install` first.')
    process.exit(1)
  }

  const raw = execSync('xcrun simctl list devices --json', { encoding: 'utf8', stdio: 'pipe' })
  const data = JSON.parse(raw) as {
    devices: Record<string, Array<{ udid: string; name: string; state: string }>>
  }
  const booted = Object.values(data.devices).flat().find((d) => d.state === 'Booted')
  if (!booted) {
    console.error('No booted simulator. Run `tapflow boot <name>` first.')
    process.exit(1)
  }

  const { WdaLauncher } = require('@tapflow/ios-agent') as typeof import('@tapflow/ios-agent')
  const launcher = new WdaLauncher({ udid: booted.udid, xctestrunPath: WDA_XCTESTRUN_CACHE })
  const spinner = createSpinner(`Starting WDA for ${booted.name}…`)
  spinner.start()
  try {
    await launcher.ensureRunning()
    spinner.stop(true)
    banner('success', 'WDA STARTED', [`Running on http://localhost:${launcher.port}`])
  } catch (e) {
    spinner.stop(false)
    banner('error', 'WDA FAILED TO START', [(e as Error).message])
    process.exit(1)
  }
}

function wdaStop(): void {
  const { running, pid } = checkWdaProcess()
  if (!running) {
    console.log('WDA is not running.')
    return
  }
  try {
    process.kill(pid!, 'SIGTERM')
    banner('success', 'WDA STOPPED', [])
  } catch {
    banner('error', 'FAILED TO STOP WDA', [`PID ${pid} could not be terminated.`])
  }
}

function wdaStatus(): void {
  const { running, pid } = checkWdaProcess()
  const installed = existsSync(WDA_XCTESTRUN_CACHE)
  console.log(`  Installed : ${installed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}`)
  console.log(`  Running   : ${running ? `\x1b[32m✓\x1b[0m  (PID ${pid})` : '\x1b[31m✗\x1b[0m'}`)
  if (!running) process.exit(1)
}
