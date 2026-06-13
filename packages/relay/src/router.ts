import type http from 'http'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('relay:router')

// 로그에 PAT가 새지 않도록 마스킹 (에러 메시지/스택에 토큰이 섞여 들어온 경우 대비).
function redactSecrets(s: string): string {
  return s.replace(/tflw_pat_[A-Za-z0-9_-]+/g, 'tflw_pat_***')
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => void | Promise<void>

interface Route {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: Handler
}

export class Router {
  private routes: Route[] = []

  on(method: string, path: string, handler: Handler): void {
    const paramNames: string[] = []
    const regexStr = path
      .replace(/:([^/]+)/g, (_, name) => { paramNames.push(name); return '([^/]+)' })
      .replace(/\//g, '\\/')
    this.routes.push({ method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler })
  }

  get(path: string, handler: Handler) { this.on('GET', path, handler) }
  post(path: string, handler: Handler) { this.on('POST', path, handler) }
  patch(path: string, handler: Handler) { this.on('PATCH', path, handler) }
  delete(path: string, handler: Handler) { this.on('DELETE', path, handler) }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'

    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url)
      if (!match) continue
      const params: Record<string, string> = {}
      route.paramNames.forEach((name, i) => { params[name] = match[i + 1] })
      try {
        await route.handler(req, res, params)
      } catch (err) {
        // 관측성: 스택을 삼키지 말고 기록한다. 단 응답 본문에는 상세를 노출하지 않는다.
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
        logger.error(`${method} ${url} — handler error: ${redactSecrets(detail)}`)
        json(res, 500, { error: 'Internal server error' })
      }
      return true
    }
    return false
  }
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

export function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function readJson<T = unknown>(req: http.IncomingMessage): Promise<T> {
  const buf = await readBody(req)
  return JSON.parse(buf.toString('utf-8')) as T
}
