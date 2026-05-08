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
  WDA_PID_FILE,
} from '../lib/tapflow-dir'
import { checkWdaProcess } from '../lib/doctor'

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
    console.error(`Auto-clone failed: ${(e as Error).message}`)
    const rl = readline.createInterface({ input, output })
    const manual = await rl.question('Enter path to your WebDriverAgent source directory: ')
    rl.close()
    sourcePath = manual.trim()
    if (!sourcePath || !existsSync(sourcePath)) {
      console.error('Path not found.')
      process.exit(1)
    }
  }

  await buildWda(sourcePath)
}

async function cloneWda(): Promise<string> {
  if (existsSync(join(WDA_SOURCE_DIR, 'WebDriverAgent.xcodeproj'))) {
    console.log('WebDriverAgent source already cloned. Updating…')
    execSync('git pull --ff-only', { cwd: WDA_SOURCE_DIR, stdio: 'inherit' })
  } else {
    console.log(`Cloning WebDriverAgent from ${WDA_REPO}…`)
    execSync(`git clone --depth 1 ${WDA_REPO} ${WDA_SOURCE_DIR}`, { stdio: 'inherit' })
  }
  return WDA_SOURCE_DIR
}

async function buildWda(sourcePath: string): Promise<void> {
  const xcodeproj = join(sourcePath, 'WebDriverAgent.xcodeproj')
  if (!existsSync(xcodeproj)) {
    console.error(`WebDriverAgent.xcodeproj not found in ${sourcePath}`)
    process.exit(1)
  }

  console.log('Building WebDriverAgent (this may take a few minutes)…')
  execSync(
    [
      'xcodebuild build-for-testing',
      `-project ${xcodeproj}`,
      '-scheme WebDriverAgentRunner',
      '-destination "platform=iOS Simulator,name=iPhone 16"',
      `-derivedDataPath ${WDA_BUILD_DIR}`,
      'CODE_SIGN_IDENTITY=""',
      'CODE_SIGNING_REQUIRED=NO',
      'GCC_TREAT_WARNINGS_AS_ERRORS=0',
    ].join(' '),
    { stdio: 'inherit' },
  )

  const productsDir = join(WDA_BUILD_DIR, 'Build', 'Products')
  const xctestrunFiles = readdirSync(productsDir).filter((f) => f.endsWith('.xctestrun'))
  if (xctestrunFiles.length === 0) {
    console.error('Build succeeded but no .xctestrun file found.')
    process.exit(1)
  }

  const src = join(productsDir, xctestrunFiles[0]!)
  copyFileSync(src, WDA_XCTESTRUN_CACHE)
  console.log(`\nWebDriverAgent installed → ${WDA_XCTESTRUN_CACHE}`)
  console.log('Run `tapflow wda start` or `tapflow start` to use it.')
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
  console.log(`Starting WDA for ${booted.name}…`)
  await launcher.ensureRunning()
  console.log('WDA running on :8100')
}

function wdaStop(): void {
  const { running, pid } = checkWdaProcess()
  if (!running) {
    console.log('WDA is not running.')
    return
  }
  try {
    process.kill(pid!, 'SIGTERM')
    console.log('WDA stopped.')
  } catch {
    console.error('Failed to stop WDA.')
  }
}

function wdaStatus(): void {
  const { running, pid } = checkWdaProcess()
  const installed = existsSync(WDA_XCTESTRUN_CACHE)
  console.log(`Installed : ${installed ? '✓' : '✗'}`)
  console.log(`Running   : ${running ? `✓ (PID ${pid})` : '✗'}`)
  if (running && pid) process.exit(0)
  if (!running) process.exit(1)
}
