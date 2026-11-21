import { describe, it, expect, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from '../tools.js'
import type { TapflowClient } from '../client.js'

type ToolResult = {
  content: Array<{ type: string; text?: string; mimeType?: string }>
  isError?: boolean
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

function captureTools(client: TapflowClient): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => { handlers.set(name, handler) },
  }
  registerTools(server as unknown as McpServer, client)
  return handlers
}

/** A 1×1 PNG header: signature, then IHDR with width and height at bytes 16–23. */
function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.write('IHDR', 12)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/** A JPEG whose SOF0 marker carries the dimensions, laid out the way the parser reads it. */
function jpegBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(64)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[20] = 0xff
  buf[21] = 0xc0
  buf.writeUInt16BE(height, 25)
  buf.writeUInt16BE(width, 27)
  return buf
}

function clientReturning(buf: Buffer): TapflowClient {
  return {
    screenshot: vi.fn(async () => buf),
    reconnectIfRotated: vi.fn(async () => {}),
    releasedByReconnect: vi.fn(() => undefined),
  } as unknown as TapflowClient
}

const text = (res: ToolResult) => res.content.find((c) => c.type === 'text')?.text ?? ''
const image = (res: ToolResult) => res.content.find((c) => c.type === 'image')

// #508. The request's `format` is a preference and the reply's is a claim, so neither can decide how
// to parse the bytes. Android produces PNG whatever is asked — `screencap -p` takes no format — and
// used to echo the request, so a JPEG request arrived as PNG bytes that the dimension parser scanned
// for a JPEG SOF0 marker. A stray `ff c0` in a few hundred KB of IDAT is close to certain, so the
// numbers were wrong, and they go into the text the LLM hands back as `tap`'s divisors.
describe('screenshot — the bytes decide the format, not the request', () => {
  const handler = (buf: Buffer) => captureTools(clientReturning(buf)).get('screenshot') as Handler

  it('reports PNG for PNG bytes even when jpeg was asked for', async () => {
    const res = await handler(pngBytes(1170, 2532))({ sessionId: 's1', format: 'jpeg' })
    expect(image(res)?.mimeType).toBe('image/png')
    expect(text(res)).toContain('.png')
    // The dimensions are the ones a PNG parser reads. Under the old code this asked a JPEG parser for
    // them, which is the half that reaches `tap`.
    expect(text(res)).toContain('1170×2532px')
    expect(text(res)).toContain('jpeg was requested but the device produced png')
  })

  it('still honours a JPEG that really is one', async () => {
    // The path that already worked gets mutated first (`contributing/test-and-guard-coverage.md` §4):
    // a sniffer that answered `png` for everything would break every JPEG a device really sends.
    const res = await handler(jpegBytes(828, 1792))({ sessionId: 's1', format: 'jpeg' })
    expect(image(res)?.mimeType).toBe('image/jpeg')
    expect(text(res)).toContain('.jpg')
    expect(text(res)).toContain('828×1792px')
    // Nothing to report when the request was met.
    expect(text(res)).not.toContain('but the device produced')
  })

  // What the Android agent now answers a JPEG request with: macOS `sips` output (30×60 here), which carries an EXIF
  // segment before its SOF0. The size read from it is what `tap` divides by, so it is read from the real thing, not a
  // hand-built header (design review: the reader takes the first SOF0 it finds).
  it('reads the size of a JPEG made by sips, as the Android agent makes them', async () => {
    const sips = Buffer.from('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', 'base64')
    const res = await handler(sips)({ sessionId: 's1', format: 'jpeg' })
    expect(image(res)?.mimeType).toBe('image/jpeg')
    expect(text(res)).toContain('30×60px')
  })

  it('leaves the ordinary png request quiet', async () => {
    const res = await handler(pngBytes(400, 800))({ sessionId: 's1' })
    expect(image(res)?.mimeType).toBe('image/png')
    expect(text(res)).toContain('400×800px')
    expect(text(res)).not.toContain('produced')
    expect(text(res)).not.toContain('unrecognised')
  })

  it('does not accept a PNG signature that only starts right', async () => {
    // The four-byte prefix is not the signature. `0d 0a 1a 0a` is there to catch a mangled transfer —
    // CRLF translation, a truncated read — and that is exactly the buffer that must not be measured as
    // a PNG, because `getImageDimensions` would read a width and height out of bytes 16-23 regardless.
    const mangled = pngBytes(1170, 2532)
    mangled[4] = 0x0a // the `0d` translated away, which is what a text-mode transfer does to it
    const res = await handler(mangled)({ sessionId: 's1', format: 'jpeg' })
    expect(text(res)).toContain('unrecognised format')
    expect(text(res)).not.toContain('1170×2532px')
  })

  it('says so when the bytes match neither signature', async () => {
    // Reachable only from a platform registered through `AgentRegistry` that produces something else
    // — `DeviceAgent.screenshot()` takes no format, so nothing constrains it. Falling back to the
    // request keeps the old behaviour; saying so is what stops it being presented as a reading, and
    // `tap` takes these dimensions as required arguments.
    const res = await handler(Buffer.from('RIFF....WEBPVP8 '))({ sessionId: 's1', format: 'jpeg' })
    expect(image(res)?.mimeType).toBe('image/jpeg')
    expect(text(res)).toContain('unrecognised format, read as jpeg')
  })
})
