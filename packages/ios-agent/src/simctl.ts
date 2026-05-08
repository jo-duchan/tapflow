import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface SimctlRunner {
  exec(...args: string[]): Promise<string>
  execBinary(...args: string[]): Promise<Buffer>
}

export const defaultRunner: SimctlRunner = {
  async exec(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('xcrun', ['simctl', ...args])
    return stdout
  },
  async execBinary(...args: string[]): Promise<Buffer> {
    const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], { encoding: 'buffer' })
    return stdout
  },
}
