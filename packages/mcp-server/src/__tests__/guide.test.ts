import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { INSTRUCTIONS, TESTING_GUIDE } from '../guide.js'
import { registerTools } from '../tools.js'
import { SERVER_VERSION } from '../version.js'
import type { TapflowClient } from '../client.js'

// What an agent pays for, measured the way it pays: the initialize result and the tool list, as a client receives
// them. Every session carries these whether it tests anything or not, so they are held to a number.
async function connect(): Promise<{ client: Client; tools: { name: string }[]; listBytes: number }> {
  const server = new McpServer({ name: 'tapflow', version: SERVER_VERSION }, { instructions: INSTRUCTIONS })
  // Only what the register wrapper calls before every tool; the guide tool touches nothing else.
  registerTools(server, { reconnectIfRotated: async () => {}, releasedByReconnect: () => undefined } as unknown as TapflowClient)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  const { tools } = await client.listTools()
  return { client, tools, listBytes: JSON.stringify(tools).length }
}

// A word that reads as a tool name: snake_case, as every tool here is. Button names share the shape. A name
// misspelled out of that shape (installApp) is not seen at all; widening it would also catch flow steps (openUrl).
const NOT_TOOLS = new Set(['recent_apps', 'volume_up', 'volume_down'])
const toolNamesIn = (text: string) => [...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])].filter((w) => !NOT_TOOLS.has(w))

describe('agent guide', () => {
  it('reaches the client as the server instructions', async () => {
    const { client } = await connect()
    expect(client.getInstructions()).toBe(INSTRUCTIONS)
  })

  // Claude Code cuts instructions at 4,096 characters; Codex reads the first 512 as the namespace's description.
  it('keeps the instructions short, with the rules that matter first', () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2400)
    const head = INSTRUCTIONS.slice(0, 512)
    for (const rule of ['get_testing_guide', 'disconnect_device', 'query_ui_tree']) expect(head).toContain(rule)
  })

  it('holds what every session carries to a budget', async () => {
    const { listBytes } = await connect()
    // Measured at 13.2 KB of tool list plus 1.7 KB of instructions when this was written; the margin is for a sentence, not a tool.
    // 15,491 bytes by the time the flow input steps came, 9 short. They added `tap`'s `holdMs` and three step names to
    // `run_flow` (15,625) instead of a `long_press` and a `pinch` tool, which would have cost 2.6 KB.
    expect(listBytes + INSTRUCTIONS.length).toBeLessThanOrEqual(15_750)
  })

  it('returns the testing guide only when asked, and keeps it bounded', async () => {
    const { client } = await connect()
    const res = await client.callTool({ name: 'get_testing_guide', arguments: {} })
    expect((res.content as { type: string; text: string }[])[0].text).toBe(TESTING_GUIDE)
    expect(TESTING_GUIDE.length).toBeLessThanOrEqual(6000)
  })

  // A guide that sends the agent to a tool that does not exist costs a failed call and the agent's trust in the rest.
  it('names only tools that are registered', async () => {
    const { tools } = await connect()
    const registered = new Set(tools.map((t) => t.name))
    for (const text of [INSTRUCTIONS, TESTING_GUIDE]) {
      const named = toolNamesIn(text)
      expect(named.length).toBeGreaterThan(3)
      expect(named.filter((n) => !registered.has(n))).toEqual([])
    }
  })

  it("announces the package's own version", () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string }
    expect(SERVER_VERSION).toBe(pkg.version)
  })
})
