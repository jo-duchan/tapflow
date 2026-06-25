import { execFile } from 'child_process'
import { promisify } from 'util'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:simctl')

const execFileAsync = promisify(execFile)

function isCoreSimulatorVersionMismatch(err: unknown): boolean {
  const msg = (err as { stderr?: string; message?: string }).stderr
    ?? (err as { message?: string }).message ?? ''
  return msg.includes('CoreSimulator.framework was changed') ||
    msg.includes('Service version') && msg.includes('does not match expected service version')
}

async function restartCoreSimulatorService(): Promise<void> {
  // SIGKILL (-9) guarantees the process dies even if it ignores SIGTERM
  await execFileAsync('killall', ['-9', 'com.apple.CoreSimulator.CoreSimulatorService']).catch(() => {})
  await new Promise<void>((r) => setTimeout(r, 3000))
}

export interface SimctlRunner {
  exec(...args: string[]): Promise<string>
  // Like exec, but merges extra child env vars in — used to pass SIMCTL_CHILD_* (e.g. the audio-tap
  // dylib injection) through `simctl launch` to the launched app.
  execEnv(env: Record<string, string>, ...args: string[]): Promise<string>
  execBinary(...args: string[]): Promise<Buffer>
}

const CORE_SIM_DOCS_URL = 'https://tapflow.dev/guide/troubleshooting#ios-simulator-service-version-mismatch'

function coreSimServiceError(): Error {
  return new Error(
    'CoreSimulatorService version mismatch — the service could not be recovered automatically.\n' +
    'Run the following command and try again:\n\n' +
    '  killall -9 com.apple.CoreSimulator.CoreSimulatorService\n\n' +
    `See ${CORE_SIM_DOCS_URL}`,
  )
}

// Run `xcrun simctl <args>` with one retry across a CoreSimulatorService version mismatch. `childEnv`,
// when given, is merged onto process.env for the child (carries SIMCTL_CHILD_* into `simctl launch`).
async function runSimctl(args: string[], childEnv?: Record<string, string>): Promise<string> {
  const opts: { encoding: 'utf8'; env?: NodeJS.ProcessEnv } = { encoding: 'utf8' }
  if (childEnv) opts.env = { ...process.env, ...childEnv }
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], opts)
    return stdout
  } catch (err) {
    if (!isCoreSimulatorVersionMismatch(err)) throw err
    logger.warn('CoreSimulatorService version mismatch — restarting service and retrying')
    await restartCoreSimulatorService()
    try {
      const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], opts)
      return stdout
    } catch {
      throw coreSimServiceError()
    }
  }
}

export const defaultRunner: SimctlRunner = {
  exec(...args: string[]): Promise<string> {
    return runSimctl(args)
  },
  execEnv(env: Record<string, string>, ...args: string[]): Promise<string> {
    return runSimctl(args, env)
  },
  async execBinary(...args: string[]): Promise<Buffer> {
    try {
      const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], { encoding: 'buffer' })
      return stdout
    } catch (err) {
      if (!isCoreSimulatorVersionMismatch(err)) throw err
      logger.warn('CoreSimulatorService version mismatch — restarting service and retrying')
      await restartCoreSimulatorService()
      try {
        const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], { encoding: 'buffer' })
        return stdout
      } catch {
        throw coreSimServiceError()
      }
    }
  },
}
