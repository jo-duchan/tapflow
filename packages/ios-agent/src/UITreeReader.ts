import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { UIElement, UIElementRole } from '@tapflowio/agent-core'
import { createLogger, PlatformError } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:ui-tree')
const execFileAsync = promisify(execFile)

const SWIFT_SRC = join(import.meta.dirname, '..', 'src', 'accessibility-helper.swift')
const BINARY = join(import.meta.dirname, '..', 'bin', 'accessibility-helper')

// Compiles asynchronously: read() sits on the live request path of an agent
// that is also pumping video frames, so a synchronous swiftc run would stall
// every connected session's streaming for the duration of the compile.
async function ensureCompiled(): Promise<void> {
  if (existsSync(BINARY)) {
    // Swift source is not included in the published package — skip recompilation check
    if (!existsSync(SWIFT_SRC)) return
    const srcMtime = statSync(SWIFT_SRC).mtimeMs
    const binMtime = statSync(BINARY).mtimeMs
    if (binMtime >= srcMtime) return
    logger.info('Swift source changed, recompiling...')
    unlinkSync(BINARY)
  }
  if (!existsSync(SWIFT_SRC)) {
    throw new PlatformError('accessibility-helper binary missing and Swift source not found — reinstall @tapflowio/ios-agent')
  }
  logger.info('compiling accessibility-helper...')
  await execFileAsync('swiftc', [SWIFT_SRC, '-o', BINARY])
  logger.info('compiled OK')
}

// Raw node as emitted by accessibility-helper (frames already normalized 0-1).
export interface AxNode {
  role: string
  subrole?: string
  label?: string
  identifier?: string
  value?: string
  enabled?: boolean
  frame: { x: number; y: number; width: number; height: number }
}

// macOS AX role/subrole → unified vocabulary. UISwitch bridges as
// AXCheckBox/AXSwitch, tab bar items as AXRadioButton/AXTabButton.
function toRole(role: string, subrole?: string): UIElementRole {
  if (role === 'AXCheckBox') return subrole === 'AXSwitch' ? 'switch' : 'checkbox'
  if (role === 'AXRadioButton') return subrole === 'AXTabButton' ? 'tab' : 'checkbox'
  switch (role) {
    case 'AXButton': return 'button'
    case 'AXTextField':
    case 'AXTextArea':
    case 'AXSearchField':
    case 'AXComboBox': return 'input'
    case 'AXStaticText':
    case 'AXHeading':
    case 'AXGenericElement': return 'text'
    case 'AXImage': return 'image'
    case 'AXSlider':
    case 'AXIncrementor': return 'slider'
    case 'AXTable':
    case 'AXList':
    case 'AXOutline':
    case 'AXScrollArea': return 'list'
    case 'AXCell':
    case 'AXRow': return 'cell'
    case 'AXTabGroup': return 'tab'
    default: return 'other'
  }
}

const ACTIONABLE = new Set<UIElementRole>(['button', 'input', 'checkbox', 'switch', 'slider', 'tab', 'cell'])
const round4 = (n: number): number => Math.round(n * 10000) / 10000

export function mapAxNodes(nodes: AxNode[]): UIElement[] {
  const elements: UIElement[] = []
  for (const node of nodes) {
    if (!node.frame || node.frame.width <= 0 || node.frame.height <= 0) continue
    const role = toRole(node.role, node.subrole)
    const label = node.label ?? ''
    if (!ACTIONABLE.has(role) && label === '') continue

    const element: UIElement = {
      role,
      label,
      frame: {
        x: round4(node.frame.x),
        y: round4(node.frame.y),
        width: round4(node.frame.width),
        height: round4(node.frame.height),
      },
      enabled: node.enabled !== false,
    }
    if (node.identifier) element.identifier = node.identifier
    element.rawRole = node.subrole ? `${node.role}/${node.subrole}` : node.role
    elements.push(element)
  }
  return elements
}

export type HelperRunner = (deviceName: string) => Promise<string>

const defaultRunner: HelperRunner = async (deviceName) => {
  await ensureCompiled()
  const { stdout } = await execFileAsync(BINARY, [deviceName], {
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout
}

export class UITreeReader {
  constructor(private readonly runner: HelperRunner = defaultRunner) {}

  async read(deviceName: string): Promise<UIElement[]> {
    let stdout: string
    try {
      stdout = await this.runner(deviceName)
    } catch (e) {
      const err = e as { code?: number | string; stderr?: string; killed?: boolean; message?: string }
      if (err.code === 2) {
        throw new PlatformError(
          'macOS Accessibility permission is required for UI tree queries — in System Settings > Privacy & Security > Accessibility, allow the app that runs the tapflow agent (your terminal), then restart the agent',
        )
      }
      if (err.code === 3 || err.code === 4) {
        throw new PlatformError(
          `Simulator window not available for UI tree query: ${err.stderr?.trim() || 'unknown'} — Simulator.app must be running with the device window open`,
        )
      }
      if (err.killed) {
        throw new PlatformError('accessibility-helper timed out reading the UI tree')
      }
      throw new PlatformError(`accessibility-helper failed: ${err.stderr?.trim() || err.message || String(e)}`)
    }

    let parsed: { elements?: AxNode[] }
    try {
      parsed = JSON.parse(stdout) as { elements?: AxNode[] }
    } catch {
      throw new PlatformError('accessibility-helper returned malformed JSON')
    }
    return mapAxNodes(parsed.elements ?? [])
  }
}
