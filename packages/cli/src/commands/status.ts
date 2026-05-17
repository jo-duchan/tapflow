import { WebSocket } from 'ws'
import { DIM, BOLD, GREEN, YELLOW, RED, R } from '../lib/print.js'

export async function cmdStatus(opts: { relay?: string }): Promise<void> {
  const relayUrl = (opts.relay ?? 'ws://localhost:4000').replace(/^http/, 'ws')

  console.log(`\n  Connecting to ${relayUrl}…\n`)
  console.log(`  ${DIM}● agent  ◉ in use  ○ idle${R}\n`)

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(relayUrl)
    const timeout = setTimeout(() => {
      ws.terminate()
      reject(new Error(`Could not connect to relay at ${relayUrl} (5s timeout)`))
    }, 5000)

    ws.on('open', () => ws.send(JSON.stringify({ type: 'agents:list' })))

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type !== 'agents:listed') return

        clearTimeout(timeout)
        ws.close()

        const sessions: Array<{ agentName: string; devices: Array<{ name: string; status: string; joinedBy?: string }> }> = msg.sessions ?? []

        if (sessions.length === 0) {
          console.log(`  ${DIM}No agents connected.${R}\n`)
        } else {
          let totalDevices = 0
          let activeSessions = 0

          for (const session of sessions) {
            console.log(`  ${BOLD}${GREEN}●${R} ${BOLD}${session.agentName}${R}`)
            for (const device of session.devices ?? []) {
              const occupied = !!device.joinedBy
              const dot = occupied ? `${YELLOW}◉${R}` : `${DIM}○${R}`
              const who = occupied ? `  ${DIM}← ${device.joinedBy}${R}` : ''
              console.log(`      ${dot}  ${device.name}${who}`)
              totalDevices++
              if (occupied) activeSessions++
            }
            console.log()
          }

          console.log(`  ${DIM}${sessions.length} agent(s) · ${totalDevices} device(s) · ${activeSessions} active session(s)${R}\n`)
        }

        resolve()
      } catch { /* ignore non-agents:listed messages */ }
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  }).catch((err: Error) => {
    console.error(`\n  ${RED}✗${R}  ${err.message}\n`)
    process.exit(1)
  })
}
