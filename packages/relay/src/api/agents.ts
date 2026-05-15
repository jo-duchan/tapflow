import http from 'http'
import { requireAuth } from '../middleware/auth.js'
import { getDb } from '../db.js'
import { json } from '../router.js'

const RANGES: Record<string, string> = {
  '1h': '-1 hour',
  '6h': '-6 hours',
  '24h': '-24 hours',
  '7d': '-7 days',
}

export function handleListAgents(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!requireAuth(req, res)) return
  const rows = getDb()
    .prepare('SELECT DISTINCT agent_name FROM agent_resources ORDER BY agent_name')
    .all() as { agent_name: string }[]
  json(res, 200, rows.map((r) => r.agent_name))
}

export function handleGetAgentResources(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
): void {
  if (!requireAuth(req, res)) return
  const agentName = decodeURIComponent(params.name)
  const url = new URL(req.url ?? '/', 'http://x')
  const range = url.searchParams.get('range') ?? '1h'
  const interval = RANGES[range] ?? RANGES['1h']

  const rows = getDb()
    .prepare(`
      SELECT cpu_percent, mem_percent, recorded_at
      FROM agent_resources
      WHERE agent_name = ?
        AND recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
      ORDER BY recorded_at ASC
    `)
    .all(agentName, interval) as { cpu_percent: number; mem_percent: number; recorded_at: string }[]

  json(res, 200, rows)
}
