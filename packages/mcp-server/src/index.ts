#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TapflowClient } from './client.js'
import { registerTools } from './tools.js'

const relayUrl = process.env['TAPFLOW_RELAY_URL'] ?? 'ws://localhost:4000'
const token = process.env['TAPFLOW_TOKEN'] ?? ''

if (!token) {
  process.stderr.write('TAPFLOW_TOKEN is required (create a Personal Access Token in the tapflow dashboard)\n')
  process.exit(1)
}

const client = new TapflowClient(relayUrl, token)

await client.connect().catch((e: Error) => {
  process.stderr.write(`Failed to connect to relay at ${relayUrl}: ${e.message}\n`)
  process.exit(1)
})

const server = new McpServer({
  name: 'tapflow',
  version: '0.2.2',
})

registerTools(server, client)

const transport = new StdioServerTransport()
await server.connect(transport)

process.on('SIGINT', () => { client.disconnect(); process.exit(0) })
process.on('SIGTERM', () => { client.disconnect(); process.exit(0) })
