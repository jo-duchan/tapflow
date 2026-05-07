import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface SimctlRunner {
  exec(...args: string[]): Promise<string>
}

export const defaultRunner: SimctlRunner = {
  async exec(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('xcrun', ['simctl', ...args])
    return stdout
  },
}
