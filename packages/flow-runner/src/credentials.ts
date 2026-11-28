import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Where a client's token comes from, and how a rotated one reaches a process that is already running (T1).
 *
 * The token used to be read once, from `TAPFLOW_TOKEN`, so replacing it meant re-registering the MCP server. Now a
 * client resolves it **explicit first** (`--token`, then a non-empty `TAPFLOW_TOKEN`) **and then a credentials
 * file**, and a request the relay refuses with 401 re-reads the file and is retried once — rotating a token is then
 * "write the file".
 *
 * - **The file is the user's, on the machine that runs the client** — `$XDG_CONFIG_HOME/tapflow/credentials.json`,
 *   else `~/.config/tapflow/credentials.json`, or `TAPFLOW_TOKEN_FILE`. Never the relay's `tapflow.config.json` or
 *   `<dataDir>/.env`: those belong to the relay host, and the person running an AI agent often has no relay.
 * - **Keyed by relay origin**, so a token minted on one relay is never sent to another. Loopback hosts on the same
 *   port share a key: `localhost`, `127.0.0.1` and `[::1]` reach the same listener.
 * - **An explicit token is never replaced by the file.** It is what the person asked for; a refusal says so and
 *   points at the file instead.
 * - **Opt-in.** Reading the file is `resolveToken`, never a side effect of constructing a client — a third party
 *   using `RelayClient` with its own token must not have a file's token sent on its behalf.
 */

export type TokenOrigin = 'flag' | 'env' | 'file' | 'none'

export interface TokenSource {
  /** The token to send now; empty when there is none. */
  readonly token: string
  /** The relay origin it is keyed by, for messages. */
  readonly origin: string
  readonly from: TokenOrigin
  /** The credentials file this source reads (whether or not it exists). */
  readonly path: string
  /** Re-reads the file. Does nothing for an explicit token. */
  refresh(): void
}

interface CredentialsFile {
  version: 1
  relays: Record<string, { token: string }>
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The key a relay URL is stored under: its HTTP origin, with loopback hosts folded into one. */
export function originOf(relayUrl: string): string {
  const u = new URL(relayUrl)
  const protocol = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:'
  const host = LOOPBACK.has(u.hostname) ? 'localhost' : u.hostname
  const port = u.port && !((protocol === 'http:' && u.port === '80') || (protocol === 'https:' && u.port === '443')) ? `:${u.port}` : ''
  return `${protocol}//${host}${port}`
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env['TAPFLOW_TOKEN_FILE']) return env['TAPFLOW_TOKEN_FILE']
  const base = env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config')
  return path.join(base, 'tapflow', 'credentials.json')
}

/** What the file says about one origin: its token, and the origins it has, for a message when this one misses. */
export function readCredential(file: string, origin: string, warn?: (line: string) => void): { token: string; origins: string[] } {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { token: '', origins: [] }
  }
  try {
    const mode = fs.statSync(file).mode
    // Not refused: refusing would break a working setup on upgrade. Said, because the file holds a credential.
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) warn?.(`${file} is readable by other users; run: chmod 600 ${file}`)
  } catch { /* the read above is what matters */ }
  let parsed: Partial<CredentialsFile>
  try {
    parsed = JSON.parse(raw) as Partial<CredentialsFile>
  } catch {
    warn?.(`${file} is not valid JSON; no token read from it`)
    return { token: '', origins: [] }
  }
  const relays = parsed.relays && typeof parsed.relays === 'object' ? parsed.relays : {}
  const keys = Object.keys(relays)
  // Keys are compared as origins, so a file written by hand with `ws://127.0.0.1:4000/` still matches.
  const hit = keys.find((k) => {
    try { return originOf(k) === origin } catch { return false }
  })
  const token = hit ? relays[hit]?.token : undefined
  return { token: typeof token === 'string' ? token.trim() : '', origins: keys }
}

/**
 * Resolves a client's token: `explicit` (a flag), then a non-empty `TAPFLOW_TOKEN`, then the credentials file.
 * `warn` hears about a file that is unreadable by JSON or by others' permissions, once per read.
 */
export function resolveToken(opts: { relayUrl: string; explicit?: string; env?: NodeJS.ProcessEnv; warn?: (line: string) => void }): TokenSource {
  const env = opts.env ?? process.env
  const origin = originOf(opts.relayUrl)
  const file = credentialsPath(env)
  const explicit = opts.explicit?.trim()
  if (explicit) return fixed(explicit, origin, 'flag', file)
  // Empty is unset: `TAPFLOW_TOKEN=` in an MCP registration must not hide the file.
  const envToken = env['TAPFLOW_TOKEN']?.trim()
  if (envToken) return fixed(envToken, origin, 'env', file)
  let token = readCredential(file, origin, opts.warn).token
  return {
    get token() { return token },
    origin,
    get from() { return token ? 'file' : 'none' },
    path: file,
    refresh() { token = readCredential(file, origin, opts.warn).token },
  }
}

/** A token given as a string, by a caller that resolves its own. Never re-read. */
export function fixedToken(token: string, relayUrl: string): TokenSource {
  return fixed(token, originOf(relayUrl), token ? 'flag' : 'none', credentialsPath())
}

function fixed(token: string, origin: string, from: TokenOrigin, file: string): TokenSource {
  return { token, origin, from, path: file, refresh() {} }
}

/** The bearer header for a source, or none when it has no token. */
export function authHeader(source: TokenSource): Record<string, string> {
  return source.token ? { Authorization: `Bearer ${source.token}` } : {}
}

/**
 * A fetch that carries the source's token and, on a 401, re-reads it and retries once **if the token changed since
 * this request was sent** — compared with the token the request carried, not with the last read, so requests in
 * flight together on an old token all retry. Every 401 from the relay comes from its auth middleware, before any
 * handler runs, so a retried POST has had no effect.
 */
export async function fetchWithToken(
  source: TokenSource,
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const used = source.token
  const res = await fetchImpl(url, { ...init, headers: { ...init.headers, ...authHeader(source) } })
  if (res.status !== 401) return res
  source.refresh()
  // Unchanged, or empty — a file read mid-write by a person editing it reads as no token, and a retry without one
  // can only be refused again. The next request reads the file afresh.
  if (source.token === used || !source.token) return res
  await res.body?.cancel().catch(() => {})
  return fetchImpl(url, { ...init, headers: { ...init.headers, ...authHeader(source) } })
}

/**
 * Why the relay refused, and the fix, by where the token came from. Every client's 401 says this, so a person sees
 * the same cause whichever tool met it.
 */
export function tokenRefusal(source: TokenSource): string {
  const store = `store one in ${source.path} under "${source.origin}"`
  switch (source.from) {
    case 'flag':
    case 'env': {
      const name = source.from === 'flag' ? '--token' : 'TAPFLOW_TOKEN'
      return `the relay at ${source.origin} did not accept the token from ${name} (unknown on this relay, revoked or expired): ` +
        `pass one minted on this relay, or remove ${name} and ${setIt(source.origin)} (or ${store})`
    }
    case 'file':
      return `the relay at ${source.origin} did not accept the token stored for it in ${source.path} ` +
        `(unknown on this relay, revoked or expired): ${setIt(source.origin)} with one minted on this relay, or replace it there`
    case 'none': {
      const others = readCredential(source.path, source.origin).origins
      return `no token for the relay at ${source.origin}: ${setIt(source.origin)}, or ${store}` +
        (others.length > 0 ? ` (the file has tokens for ${others.join(', ')})` : '')
    }
  }
}

/** The command that stores a token, for messages. The path stays beside it: an MCP-only machine has no CLI. */
function setIt(origin: string): string {
  return `run \`tapflow token set --relay ${origin}\``
}

/** A tapflow personal access token's shape (`api/tokens.ts`): checked before a token is sent anywhere. */
export const PAT_PATTERN = /^tflw_pat_[0-9a-f]{64}$/

/** Why the credentials file cannot be written as it is. Its message names the file and what to do. */
export class CredentialFileError extends Error {}

/** Every relay origin the file holds a token for, canonical, in file order. Unreadable or malformed: none. */
export function listCredentials(file: string): string[] {
  const parsed = readFileObject(file)
  const relays = parsed && typeof parsed.relays === 'object' && parsed.relays !== null ? Object.keys(parsed.relays) : []
  // Equivalent keys collapse to one origin: readers take the first match, so a second would only repeat it.
  return [...new Set(relays.flatMap((k) => { try { return [originOf(k)] } catch { return [] } }))]
}

function readFileObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Stores `token` for `relayUrl`'s origin, keeping every other relay's entry and any top-level key it does not know.
 *
 * - **Every key that resolves to the same origin is replaced**, not only the canonical one: the reader takes the
 *   first match, so a hand-written `ws://127.0.0.1:4000` left ahead of it would keep its old token in use.
 * - **Written whole or not at all**: a temp file in the same directory (so the rename is atomic, never across
 *   filesystems), created 0600, then renamed over the file. A reader never sees half a file. Two writers at once:
 *   the later rename wins.
 * - **Refused rather than repaired**: a file that is a symlink (a dotfiles tool may link it into a repository, one
 *   `git add` from a commit), one owned by another user (a `sudo` run would leave a file the user's own clients
 *   cannot read, which reads as "no token"), and one that is not a version-1 credentials file (a newer format would be
 *   downgraded; a broken one is the person's to look at).
 */
export function writeCredential(file: string, relayUrl: string, token: string): { origin: string } {
  const origin = originOf(relayUrl)
  const dir = path.dirname(file)
  let existing: Record<string, unknown> = { version: 1, relays: {} }
  let stat: fs.Stats | null = null
  try { stat = fs.lstatSync(file) } catch { /* no file yet */ }
  if (stat) {
    if (stat.isSymbolicLink()) throw new CredentialFileError(`${file} is a symlink; tapflow does not write through it. Point TAPFLOW_TOKEN_FILE at a regular file, or replace the link`)
    if (!stat.isFile()) throw new CredentialFileError(`${file} is not a regular file`)
    if (ownedByAnother(stat)) throw new CredentialFileError(`${file} belongs to another user, so tapflow will not write it (a file made with sudo cannot be read by your own clients)`)
    const parsed = readFileObject(file)
    if (!parsed) throw new CredentialFileError(`${file} is not valid JSON; fix or remove it, then run this again`)
    if (parsed.version !== 1 || typeof parsed.relays !== 'object' || parsed.relays === null || Array.isArray(parsed.relays)) {
      throw new CredentialFileError(`${file} is not a version 1 tapflow credentials file; this tapflow does not write it`)
    }
    existing = parsed
  }
  const relays: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(existing.relays as Record<string, unknown>)) {
    let same = false
    try { same = originOf(key) === origin } catch { /* a key that is not a URL is kept as it is */ }
    if (!same) relays[key] = value
  }
  relays[origin] = { token }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    const dirStat = fs.statSync(dir)
    if (ownedByAnother(dirStat)) throw new CredentialFileError(`${dir} belongs to another user, so tapflow will not write there`)
  } catch (e) {
    if (e instanceof CredentialFileError) throw e
  }
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  const fd = fs.openSync(temp, 'wx', 0o600)
  try {
    try {
      // writeFileSync on an fd loops until every byte is out; a single writeSync may return short on a full disk.
      fs.writeFileSync(fd, `${JSON.stringify({ ...existing, version: 1, relays }, null, 2)}\n`)
    } finally {
      fs.closeSync(fd)
    }
    renameOnce(temp, file)
  } catch (e) {
    fs.rmSync(temp, { force: true })
    throw e
  }
  return { origin }
}

function ownedByAnother(stat: fs.Stats): boolean {
  return typeof process.getuid === 'function' && stat.uid !== process.getuid()
}

/** Windows refuses a rename over a file another process has open (EPERM); one retry covers a reader in the way. */
function renameOnce(from: string, to: string): void {
  try {
    fs.renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e
    fs.renameSync(from, to)
  }
}

