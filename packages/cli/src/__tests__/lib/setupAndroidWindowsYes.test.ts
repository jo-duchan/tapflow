import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@clack/prompts', () => ({ confirm: vi.fn(async () => false), isCancel: vi.fn(() => false) }))
vi.mock('../../lib/interactive.js', () => ({ isInteractive: vi.fn(() => false) }))

import { confirm } from '@clack/prompts'
import { realWindowsDeps } from '../../lib/setup-android-windows.js'

describe('realWindowsDeps and --yes', () => {
  afterEach(() => vi.restoreAllMocks())

  it('without --yes keeps the terminal check and the prompt', async () => {
    const deps = realWindowsDeps()
    expect(deps.interactive()).toBe(false)
    expect(deps.unattended).toBe(false)
    expect(await deps.confirm('Install?')).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('with --yes proceeds without a terminal and answers its own prompts', async () => {
    vi.mocked(confirm).mockClear()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const deps = realWindowsDeps({ assumeYes: true })
    expect(deps.interactive()).toBe(true)
    expect(deps.unattended).toBe(true)
    expect(await deps.confirm('Install the SDK?')).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('Install the SDK? yes (--yes)')
  })
})
