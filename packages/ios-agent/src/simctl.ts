import { execFile } from 'child_process'
import { promisify } from 'util'
import { createLogger } from '@tapflow/agent-core'

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

export const defaultRunner: SimctlRunner = {
  async exec(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('xcrun', ['simctl', ...args])
      return stdout
    } catch (err) {
      if (!isCoreSimulatorVersionMismatch(err)) throw err
      logger.warn('CoreSimulatorService version mismatch — restarting service and retrying')
      await restartCoreSimulatorService()
      try {
        const { stdout } = await execFileAsync('xcrun', ['simctl', ...args])
        return stdout
      } catch {
        throw coreSimServiceError()
      }
    }
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
