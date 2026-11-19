import fs from 'fs'
import { describe, it, expect, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ReachResult, UIElement } from '@tapflowio/protocol'
import { registerTools } from '../tools.js'
import type { TapflowClient } from '../client.js'

type ToolResult = { content: unknown[]; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

function tapTool(client: TapflowClient): Handler {
  const handlers = new Map<string, Handler>()
  const server = { registerTool: (name: string, _config: unknown, handler: Handler) => { handlers.set(name, handler) } }
  registerTools(server as unknown as McpServer, client)
  return handlers.get('tap')!
}
const text = (res: ToolResult) => (res.content[0] as { text: string }).text

// #1147: a row partly under the tab bar. Its frame's centre is the tab; the device reaches the row at its top left.
const ROW: UIElement = { role: 'cell', label: 'Row 13', identifier: 'list.row.13', enabled: true, frame: { x: 0, y: 0.879, width: 1, height: 0.06 } }

function client(reach: (target: UIElement) => ReachResult, tree: UIElement[] = [ROW]): TapflowClient {
  return {
    queryUITreeWithTurn: vi.fn(async () => ({ elements: tree })),
    queryUITree: vi.fn(async () => tree),
    reach: vi.fn(async (_s: string, targets: UIElement[]) => targets.map(reach)),
    tap: vi.fn(async () => {}),
    longPress: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from('png')),
    reconnectIfRotated: vi.fn(async () => {}),
    releasedByReconnect: vi.fn(() => undefined),
    activity: vi.fn(),
  } as unknown as TapflowClient
}

describe('tap — an element', () => {
  it('taps where the device reaches it, not its frame centre', async () => {
    const c = client((t) => ({ state: 'reachable', point: [0.1, 0.885], atCentre: false, frame: t.frame }))
    const res = await tapTool(c)({ sessionId: 's1', element: { id: 'list.row.13' } })
    expect(res.isError).toBeFalsy()
    expect(vi.mocked(c.tap).mock.calls).toEqual([['s1', 0.1, 0.885]])
    expect(JSON.parse(text(res))).toMatchObject({ tapped: true, reach: 'verified' })
  })

  it('fails naming what covers it, and touches nothing', async () => {
    const c = client(() => ({ state: 'occluded', by: 'Button "Hard"' }))
    const res = await tapTool(c)({ sessionId: 's1', element: { label: 'Row 13' } })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('Hard')
    expect(c.tap).not.toHaveBeenCalled()
    // As run_flow reports the same failure: the product's, and the screen it failed on.
    const body = JSON.parse(text(res))
    expect(body.failureKind).toBe('product')
    expect(fs.existsSync(body.failureScreenshotPath)).toBe(true)
  }, 15_000)

  it('taps the centre where the device cannot judge, and says the tap was not checked', async () => {
    const c = client(() => ({ state: 'unknown', reason: 'old agent' }))
    const res = await tapTool(c)({ sessionId: 's1', element: { id: 'list.row.13' } })
    expect(res.isError).toBeFalsy()
    expect(vi.mocked(c.tap).mock.calls).toEqual([['s1', 0.5, 0.909]])
    expect(JSON.parse(text(res))).toMatchObject({ tapped: true, reach: 'unchecked' })
    expect(JSON.parse(text(res)).reachNote).toContain('old agent')
  })

  it('holds an element with holdMs, at the point the device reaches', async () => {
    const c = client((t) => ({ state: 'reachable', point: [0.1, 0.885], atCentre: false, frame: t.frame }))
    const res = await tapTool(c)({ sessionId: 's1', element: { id: 'list.row.13' }, holdMs: 800 })
    expect(res.isError).toBeFalsy()
    expect(vi.mocked(c.longPress).mock.calls).toEqual([['s1', 0.1, 0.885, 800]])
    expect(c.tap).not.toHaveBeenCalled()
  })

  it('takes a point or an element, not both and not neither', async () => {
    const c = client(() => ({ state: 'unknown', reason: 'x' }))
    const point = { x: 10, y: 20, screenshotWidth: 100, screenshotHeight: 200 }
    for (const args of [{ sessionId: 's1' }, { sessionId: 's1', ...point, element: { id: 'list.row.13' } }, { sessionId: 's1', element: {} }]) {
      const res = await tapTool(c)(args)
      expect(res.isError, JSON.stringify(args)).toBe(true)
    }
    expect(c.tap).not.toHaveBeenCalled()
    expect(c.queryUITreeWithTurn).not.toHaveBeenCalled()
  })

  it('still taps a point as before', async () => {
    const c = client(() => ({ state: 'unknown', reason: 'x' }))
    const res = await tapTool(c)({ sessionId: 's1', x: 10, y: 20, screenshotWidth: 100, screenshotHeight: 200 })
    expect(res.isError).toBeFalsy()
    expect(vi.mocked(c.tap).mock.calls).toEqual([['s1', 0.1, 0.1]])
    expect(c.reach).not.toHaveBeenCalled()
  })
})
