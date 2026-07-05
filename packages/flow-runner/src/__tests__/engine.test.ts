import { describe, it, expect, vi } from 'vitest'
import type { UIElement } from '@tapflowio/agent-core'
import { runFlow, type FlowDriver } from '../engine.js'
import { parseFlow } from '../schema.js'

const el = (over: Partial<UIElement>): UIElement => ({
  role: 'button',
  label: '',
  frame: { x: 0.25, y: 0.5, width: 0.5, height: 0.1 },
  enabled: true,
  ...over,
})

// trees: sequence of queryUITree results; the last one repeats.
function fakeDriver(trees: UIElement[][]): FlowDriver & { calls: Array<[string, ...unknown[]]> } {
  let i = 0
  const calls: Array<[string, ...unknown[]]> = []
  return {
    calls,
    queryUITree: vi.fn(async () => trees[Math.min(i++, trees.length - 1)]),
    tap: vi.fn(async (x: number, y: number) => { calls.push(['tap', x, y]) }),
    swipe: vi.fn(async (from: [number, number], to: [number, number], durationMs: number) => {
      calls.push(['swipe', from, to, durationMs])
    }),
    inputText: vi.fn(async (text: string) => { calls.push(['inputText', text]) }),
    pressKey: vi.fn(async (code: string) => { calls.push(['pressKey', code]) }),
    openUrl: vi.fn(async (url: string) => { calls.push(['openUrl', url]) }),
    launchApp: vi.fn(async () => { calls.push(['launchApp']) }),
    clearState: vi.fn(async (appId: string) => { calls.push(['clearState', appId]) }),
    screenshot: vi.fn(async () => Buffer.from('PNG')),
  }
}

const OPTS = { pollIntervalMs: 1, defaultTimeoutMs: 20 }

const flowOf = (yaml: string) => parseFlow(yaml, 'test.yaml')

describe('runFlow', () => {
  it('taps the center of the matched element frame', async () => {
    const driver = fakeDriver([[el({ label: '로그인', frame: { x: 0.2, y: 0.8, width: 0.6, height: 0.1 } })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "로그인"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.5, 0.85]])
  })

  it('resolves a bare-string selector as identifier before label', async () => {
    const driver = fakeDriver([[
      el({ label: 'login', identifier: 'other' }),
      el({ label: 'x', identifier: 'login', frame: { x: 0, y: 0, width: 0.2, height: 0.2 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "login"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.1, 0.1]])
  })

  it('prefers exact label matches over partial ones', async () => {
    const driver = fakeDriver([[
      el({ label: '로그인하기', frame: { x: 0, y: 0, width: 0.2, height: 0.2 } }),
      el({ label: '로그인', frame: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 } }),
    ]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "로그인"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['tap', 0.6, 0.6]])
  })

  it('falls back to partial label matches when no exact match exists', async () => {
    const driver = fakeDriver([[el({ label: '로그인하기', frame: { x: 0, y: 0, width: 0.2, height: 0.2 } })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "로그인"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
  })

  it('fails immediately on multiple matches instead of picking one implicitly', async () => {
    const driver = fakeDriver([[el({ label: '삭제' }), el({ label: '삭제' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "삭제"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toMatch(/2 elements match/)
    expect(driver.tap).not.toHaveBeenCalled()
  })

  it('polls the tree until the element appears', async () => {
    const driver = fakeDriver([[], [], [el({ label: 'OK' })]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "OK"\n'), driver, { ...OPTS, defaultTimeoutMs: 500 })
    expect(result.status).toBe('passed')
    expect(driver.queryUITree).toHaveBeenCalledTimes(3)
  })

  it('fails with a timeout, captures a screenshot, and skips remaining steps', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - tapOn: "없는버튼"\n  - pressKey: Enter\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toMatch(/없는버튼/)
    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'skipped'])
    expect(result.failureScreenshot).toEqual(Buffer.from('PNG'))
    expect(driver.pressKey).not.toHaveBeenCalled()
  })

  it('assertNotVisible passes once the element disappears', async () => {
    const driver = fakeDriver([[el({ label: '스피너' })], []])
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "스피너"\n'), driver, { ...OPTS, defaultTimeoutMs: 500 })
    expect(result.status).toBe('passed')
  })

  it('assertNotVisible fails when the element is still present at timeout', async () => {
    const driver = fakeDriver([[el({ label: '오류' })]])
    const result = await runFlow(flowOf('steps:\n  - assertNotVisible: "오류"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
  })

  it('assertVisible accepts multiple matches (presence only)', async () => {
    const driver = fakeDriver([[el({ label: '항목' }), el({ label: '항목' })]])
    const result = await runFlow(flowOf('steps:\n  - assertVisible: "항목"\n'), driver, OPTS)
    expect(result.status).toBe('passed')
  })

  it('maps scroll directions to swipes (direction = where to reveal content)', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf('steps:\n  - scroll\n  - scroll: up\n'), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([
      ['swipe', [0.5, 0.7], [0.5, 0.3], 300],
      ['swipe', [0.5, 0.3], [0.5, 0.7], 300],
    ])
  })

  it('clearState uses the flow appId, inline bundle id wins', async () => {
    const driver = fakeDriver([[]])
    const result = await runFlow(flowOf(`
appId: com.example.app
steps:
  - clearState
  - clearState: com.other.app
`), driver, OPTS)
    expect(result.status).toBe('passed')
    expect(driver.calls).toEqual([['clearState', 'com.example.app'], ['clearState', 'com.other.app']])
  })

  it('per-selector timeout overrides the default', async () => {
    const driver = fakeDriver([[]])
    const start = Date.now()
    const result = await runFlow(
      flowOf('steps:\n  - assertVisible:\n      label: x\n      timeout: 0.01\n'),
      driver,
      { pollIntervalMs: 1, defaultTimeoutMs: 5_000 },
    )
    expect(result.status).toBe('failed')
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('reports step names and durations in results', async () => {
    const driver = fakeDriver([[el({ label: 'OK' })]])
    const result = await runFlow(flowOf('steps:\n  - launchApp\n  - tapOn: "OK"\n'), driver, OPTS)
    expect(result.steps[0]).toMatchObject({ name: 'launchApp', status: 'passed' })
    expect(result.steps[1].name).toBe('tapOn("OK")')
    expect(result.steps.every((s) => typeof s.durationMs === 'number')).toBe(true)
  })

  it('a driver error on a step fails the flow with that error', async () => {
    const driver = fakeDriver([[]])
    driver.openUrl = vi.fn(async () => { throw new Error('agent offline') })
    const result = await runFlow(flowOf('steps:\n  - openUrl: "app://x"\n'), driver, OPTS)
    expect(result.status).toBe('failed')
    expect(result.failureMessage).toContain('agent offline')
  })
})
