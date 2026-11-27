import { describe, it, expect, vi, afterEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TapflowClient } from '../client.js'
import { registerTools } from '../tools.js'

// B3: a failed run goes back to an agent through MCP, outside the run. These read the records `tapflow flow run`
// leaves; nothing here writes one.

const TOKEN = `tflw_pat_${'a'.repeat(64)}`
const RELAY = 'ws://relay.example.test:4000'

afterEach(() => vi.unstubAllGlobals())

/** The relay as the client sees it: every request it made, and an answer chosen by path. */
function stubRelay(answer: (url: URL) => Response) {
  const calls: { url: URL; auth: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    return answer(url)
  }))
  return calls
}

const summary = {
  id: 'run-1', status: 'failed', finishedBy: 'client', failureKind: 'product', errorMessage: null, exitCode: 1,
  isCi: true, ci: { provider: 'github', branch: 'main', commit: 'abcdef1234567', jobUrl: 'https://ci.example.test/1' },
  build: { id: 7, appName: 'Coffee', versionName: '1.2.0', buildNumber: '42', platform: 'ios' },
  createdBy: 'ci-bot', flowsTotal: 2, createdAt: '2026-10-14 01:00:00', finishedAt: '2026-10-14 01:01:00',
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function failedFlow(idx: number, hasScreenshot = true) {
  return {
    idx, name: `flow-${idx}`, file: `.tapflow/flows/flow-${idx}.yaml`, status: 'failed',
    device: { id: 'd', name: 'iPhone 16', platform: 'ios' }, failureKind: 'product',
    failureMessage: `tap "Pay ${idx}": no element`, durationMs: 900,
    steps: [{ index: 0, name: 'launchApp', status: 'passed', durationMs: 400 }, { index: 1, name: `tap "Pay ${idx}"`, status: 'failed', durationMs: 500 }],
    hasScreenshot, video: { ended: true, endReason: null, evicted: false, notRecorded: null, bytes: 10 },
  }
}

const passedFlow = {
  idx: 0, name: 'login', file: '.tapflow/flows/login.yaml', status: 'passed', device: null, failureKind: null,
  failureMessage: null, durationMs: 1200, steps: [], hasScreenshot: true, video: null,
}

describe('TapflowClient run records', () => {
  it('lists runs with the filters as the relay names them, summarised', async () => {
    const calls = stubRelay(() => Response.json({ items: [{ ...summary, flowsPassed: 1, flowsFailed: 1, flowsSkipped: 0 }], nextCursor: '5', prevCursor: null }))
    const client = new TapflowClient(RELAY, TOKEN)
    const { runs, nextCursor } = await client.listRuns({ status: 'failed', buildId: 7, flow: 'pay', ci: true, limit: 5 })
    expect(nextCursor).toBe('5')
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe('http://relay.example.test:4000/api/v1/runs')
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ status: 'failed', build: '7', flow: 'pay', ci: '1', limit: '5' })
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(runs).toEqual([{
      id: 'run-1', status: 'failed', failureKind: 'product', errorMessage: null, exitCode: 1,
      build: 'Coffee 1.2.0 (42)', buildId: 7, ci: { branch: 'main', commit: 'abcdef1234567', jobUrl: 'https://ci.example.test/1' },
      flows: { passed: 1, failed: 1, skipped: 0, total: 2 }, createdAt: '2026-10-14 01:00:00', finishedAt: '2026-10-14 01:01:00',
      url: 'http://relay.example.test:4000/automation/runs/run-1',
    }])
  })

  it('counts the flows a run skipped, and reads none from a relay that does not report them', async () => {
    stubRelay(() => Response.json({ items: [{ ...summary, flowsTotal: 3, flowsPassed: 1, flowsFailed: 0, flowsSkipped: 2 }, { ...summary, id: 'run-0', flowsPassed: 2, flowsFailed: 0 }], nextCursor: null, prevCursor: null }))
    const { runs } = await new TapflowClient(RELAY, TOKEN).listRuns({})
    expect(runs.map((r) => r.flows)).toEqual([{ passed: 1, failed: 0, skipped: 2, total: 3 }, { passed: 2, failed: 0, skipped: 0, total: 2 }])
  })

  it('sends no filter it was not given, and caps the limit at 50', async () => {
    const calls = stubRelay(() => Response.json({ items: [], nextCursor: null, prevCursor: null }))
    await new TapflowClient(RELAY, TOKEN).listRuns({ limit: 500 })
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ limit: '50' })
  })

  it('reads one run without the fields only the dashboard uses', async () => {
    stubRelay(() => Response.json({ ...summary, watchSessionId: null, flows: [passedFlow, failedFlow(1), { idx: 2, name: 'checkout', file: null, status: 'not-run', video: null }] }))
    const run = await new TapflowClient(RELAY, TOKEN).getRun('run-1')
    expect(run.url).toBe('http://relay.example.test:4000/automation/runs/run-1')
    expect(run.flows.map((f) => f.status)).toEqual(['passed', 'failed', 'not-run'])
    expect(run.flows[1]).toMatchObject({ file: '.tapflow/flows/flow-1.yaml', failureMessage: 'tap "Pay 1": no element', hasScreenshot: true })
    expect(JSON.stringify(run)).not.toMatch(/watchSessionId|"video"/)
  })

  // An agent reading a failed flow with no screenshot learns why, as the page says it. Mutation: drop the field.
  it('says why a flow has no screenshot', async () => {
    stubRelay(() => Response.json({ ...summary, watchSessionId: null, flows: [{ ...failedFlow(0, false), screenshotNote: 'too-large' }] }))
    const run = await new TapflowClient(RELAY, TOKEN).getRun('run-1')
    expect(run.flows[0]).toMatchObject({ hasScreenshot: false, screenshotNote: 'too-large' })
  })

  it('names the run that is missing, and the token the relay refused', async () => {
    stubRelay(() => Response.json({ error: 'Run not found' }, { status: 404 }))
    await expect(new TapflowClient(RELAY, TOKEN).getRun('nope')).rejects.toThrow('no run with id "nope" on this relay')
    stubRelay(() => new Response('{}', { status: 401 }))
    await expect(new TapflowClient(RELAY, TOKEN).listRuns({})).rejects.toThrow(/relay at http:\/\/relay\.example\.test:4000 did not accept the token/)
  })

  it('escapes the run id into the path', async () => {
    const calls = stubRelay(() => Response.json({ error: 'Run not found' }, { status: 404 }))
    await new TapflowClient(RELAY, TOKEN).getRun('../builds').catch(() => {})
    expect(calls[0]!.url.pathname).toBe('/api/v1/runs/..%2Fbuilds')
  })
})

type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

function tools(client: TapflowClient): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const server = { registerTool: (name: string, _c: unknown, h: Handler) => { handlers.set(name, h) } }
  registerTools(server as unknown as McpServer, client)
  return handlers
}

const text = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
const images = (r: ToolResult) => r.content.filter((c) => c.type === 'image')

describe('get_run / list_runs tools', () => {
  function runWith(flows: unknown[], shot: (url: URL) => Response = () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } })) {
    return stubRelay((url) => (url.pathname.endsWith('/screenshot') ? shot(url) : Response.json({ ...summary, watchSessionId: null, flows })))
  }

  it('returns a failed flow\'s screenshot as an image beside the record, and never fetches a passed one\'s', async () => {
    const calls = runWith([passedFlow, failedFlow(1)])
    const res = await tools(new TapflowClient(RELAY, TOKEN)).get('get_run')!({ runId: 'run-1' })
    expect(res.isError).toBeFalsy()
    expect(images(res)).toEqual([{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }])
    expect(calls.filter((c) => c.url.pathname.endsWith('/screenshot')).map((c) => c.url.pathname)).toEqual(['/api/v1/runs/run-1/flows/1/screenshot'])
    expect(text(res)).toContain('tap \\"Pay 1\\": no element')
    expect(text(res)).toContain('Screenshot of flow-1 (flow 1), where it failed')
  })

  it('says a failed flow\'s screenshot is gone instead of failing the call', async () => {
    runWith([failedFlow(0)], () => Response.json({ error: 'No screenshot' }, { status: 404 }))
    const res = await tools(new TapflowClient(RELAY, TOKEN)).get('get_run')!({ runId: 'run-1' })
    expect(res.isError).toBeFalsy()
    expect(images(res)).toHaveLength(0)
    expect(text(res)).toContain('no screenshot of flow-0 (flow 0) on the relay')
  })

  it('attaches at most 4 screenshots and says how many it left out', async () => {
    const calls = runWith([0, 1, 2, 3, 4, 5].map((i) => failedFlow(i)))
    const res = await tools(new TapflowClient(RELAY, TOKEN)).get('get_run')!({ runId: 'run-1' })
    expect(images(res)).toHaveLength(4)
    expect(calls.filter((c) => c.url.pathname.endsWith('/screenshot'))).toHaveLength(4)
    expect(text(res)).toContain('2 more failed flows have a screenshot')
  })

  it('counts a passed flow\'s steps instead of listing them, and lists a failed flow\'s', async () => {
    const passed = { ...passedFlow, steps: Array.from({ length: 30 }, (_, i) => ({ index: i, name: `step ${i}`, status: 'passed', durationMs: 10 })) }
    runWith([passed, failedFlow(1, false)])
    const res = await tools(new TapflowClient(RELAY, TOKEN)).get('get_run')!({ runId: 'run-1' })
    const body = JSON.parse(res.content[0]!.text!) as { flows: Array<{ steps?: unknown[]; stepCount?: number }> }
    expect(body.flows[0]).toMatchObject({ stepCount: 30 })
    expect(body.flows[0]!.steps).toBeUndefined()
    expect(body.flows[1]!.steps).toHaveLength(2)
  })

  it('keeps the record when a screenshot cannot be read, and says which', async () => {
    runWith([failedFlow(0), failedFlow(1)], (url) => (url.pathname.includes('/flows/0/') ? new Response('boom', { status: 500 }) : new Response(PNG, { headers: { 'Content-Type': 'image/png' } })))
    const res = await tools(new TapflowClient(RELAY, TOKEN)).get('get_run')!({ runId: 'run-1' })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toContain('Could not read the screenshot of flow-0 (flow 0)')
    expect(images(res)).toHaveLength(1)
  })

  it('leaves out a screenshot that would take the answer past its byte budget', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 1)
    runWith([failedFlow(0), failedFlow(1)], () => new Response(big, { headers: { 'Content-Type': 'image/png' } }))
    const res = await tools(new TapflowClient(RELAY, TOKEN)).get('get_run')!({ runId: 'run-1' })
    expect(images(res)).toHaveLength(1)
    expect(text(res)).toContain('The screenshot of flow-1 (flow 1) is left out to keep this answer small')
  })

  it('reports a missing run as an error', async () => {
    stubRelay(() => Response.json({ error: 'Run not found' }, { status: 404 }))
    const res = await tools(new TapflowClient(RELAY, TOKEN)).get('get_run')!({ runId: 'nope' })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('no run with id "nope"')
  })

  it('lists runs through the same filters, and pages back with the cursor it hands out', async () => {
    const calls = stubRelay(() => Response.json({ items: [{ ...summary, flowsPassed: 1, flowsFailed: 1 }], nextCursor: '41', prevCursor: null }))
    const list = tools(new TapflowClient(RELAY, TOKEN)).get('list_runs')!
    const first = JSON.parse(text(await list({ status: 'failed', ci: false }))) as { runs: { id: string }[]; nextCursor: string | null }
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ status: 'failed', ci: '0', limit: '10' })
    expect(first.runs[0]!.id).toBe('run-1')
    expect(first.nextCursor).toBe('41')
    await list({ status: 'failed', before: first.nextCursor })
    expect(calls[1]!.url.searchParams.get('before')).toBe('41')
  })

  it('fills the four places with screenshots that exist, skipping one that is gone', async () => {
    const calls = runWith([0, 1, 2, 3, 4].map((i) => failedFlow(i)), (url) => (url.pathname.includes('/flows/0/')
      ? Response.json({ error: 'No screenshot' }, { status: 404 })
      : new Response(PNG, { headers: { 'Content-Type': 'image/png' } })))
    const res = await tools(new TapflowClient(RELAY, TOKEN)).get('get_run')!({ runId: 'run-1' })
    expect(images(res)).toHaveLength(4)
    expect(calls.filter((c) => c.url.pathname.endsWith('/screenshot'))).toHaveLength(5)
    expect(text(res)).not.toContain('more failed flows have a screenshot')
  })
})
