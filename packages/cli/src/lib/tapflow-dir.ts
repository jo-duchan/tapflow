import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const TAPFLOW_DIR = join(homedir(), '.tapflow')

export function ensureTapflowDir(): void {
  mkdirSync(TAPFLOW_DIR, { recursive: true })
}
