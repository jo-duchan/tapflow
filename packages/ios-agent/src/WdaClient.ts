export class WdaClient {
  private static readonly BUTTON_MAP: Record<string, string> = {
    'volume-up':   'volumeUp',
    'volume-down': 'volumeDown',
    'power':       'power',
    'home':        'home',
  }

  private readonly baseUrl: string
  private cachedSessionId: string | null = null
  private cachedWindowSize: { width: number; height: number } | null = null

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

  async getWindowSize(): Promise<{ width: number; height: number }> {
    if (this.cachedWindowSize) return this.cachedWindowSize
    const sessionId = await this.getSessionId()
    const res = await fetch(`${this.baseUrl}/session/${sessionId}/window/size`)
    const data = (await res.json()) as { value: { width: number; height: number } }
    this.cachedWindowSize = data.value
    return this.cachedWindowSize
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

  async pressButton(chromeName: string): Promise<void> {
    const sessionId = await this.getSessionId()
    const name = WdaClient.BUTTON_MAP[chromeName] ?? chromeName
    await fetch(`${this.baseUrl}/session/${sessionId}/wda/pressButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  }
}
