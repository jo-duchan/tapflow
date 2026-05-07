import type { Point } from '@tapflow/agent-core'

export class WdaClient {
  private readonly baseUrl: string
  private cachedSessionId: string | null = null

  constructor(baseUrl = 'http://localhost:8100') {
    this.baseUrl = baseUrl
  }

  async getSessionId(): Promise<string> {
    if (this.cachedSessionId) return this.cachedSessionId

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: {} }),
      })
    } catch {
      throw new Error('WDA is not running. Start WDA on localhost:8100 before launching the agent.')
    }

    const data = (await res.json()) as { sessionId: string }
    this.cachedSessionId = data.sessionId
    return this.cachedSessionId
  }

  async tap(x: number, y: number): Promise<void> {
    const sessionId = await this.getSessionId()
    await fetch(`${this.baseUrl}/session/${sessionId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actions: [{
          type: 'pointer',
          id: 'finger',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x, y },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 50 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      }),
    })
  }

  async swipe(from: Point, to: Point, duration = 300): Promise<void> {
    const sessionId = await this.getSessionId()
    await fetch(`${this.baseUrl}/session/${sessionId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actions: [{
          type: 'pointer',
          id: 'finger',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', duration, x: to.x, y: to.y },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      }),
    })
  }

  async type(text: string): Promise<void> {
    const sessionId = await this.getSessionId()
    await fetch(`${this.baseUrl}/session/${sessionId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actions: [{
          type: 'key',
          id: 'keyboard',
          actions: text.split('').flatMap((char) => [
            { type: 'keyDown', value: char },
            { type: 'keyUp', value: char },
          ]),
        }],
      }),
    })
  }
}
