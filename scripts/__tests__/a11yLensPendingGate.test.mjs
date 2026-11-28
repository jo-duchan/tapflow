// The Stop gate that asks for `a11y-lens check --pending` when a pre-commit check was skipped (#827).
//
// **The pending files are made by the installed CLI, not written here.** The gate counts files in a
// layout a11y-lens documents; a fixture typed by hand would keep passing after an upgrade moved that
// layout, with the gate silently off. So each case stages a UI file in a throwaway repo and lets the
// real `a11y-lens check --staged` time out against a fake agent — the same way a timeout records
// files in a real commit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')
const HOOK = path.join(REPO, '.claude/hooks/a11y-lens-pending-gate.sh')
const CLI = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@a11y-lens/cli/package.json')),
  'bin/a11y-lens.mjs',
)

/** A transcript line carrying one Bash call, stamped like the runtime stamps it (now, by default). */
const bash = (command, timestamp = new Date().toISOString()) =>
  JSON.stringify({ timestamp, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })

/** The transcript's opening line, which the gate reads as the session's start. */
const opening = (timestamp) => JSON.stringify({ type: 'user', timestamp, message: { content: 'hi' } })

// Stamped before the CLI writes its record in beforeAll, so by default the record is this session's.
let dir, repo, tx, sessionStart

function runGate(lines, { stopHookActive = false, projectDir = repo, start = sessionStart } = {}) {
  writeFileSync(tx, [...(start ? [opening(start)] : []), ...lines].join('\n') + '\n')
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ transcript_path: tx, stop_hook_active: stopHookActive }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.trim()
}
const blocked = (lines, opts) => {
  const out = runGate(lines, opts)
  return out !== '' && JSON.parse(out).decision === 'block'
}
const pendingCount = () => {
  try {
    return readdirSync(path.join(repo, '.git/a11y-lens/pending')).filter((n) => n.endsWith('.json')).length
  } catch {
    return 0
  }
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'a11y-pending-'))
  repo = path.join(dir, 'repo')
  tx = path.join(dir, 'transcript.jsonl')
  const bin = path.join(dir, 'bin')
  mkdirSync(repo)
  mkdirSync(bin)
  // An agent that never answers in time.
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ncat >/dev/null\nsleep 5\necho "[]"\n')
  chmodSync(path.join(bin, 'claude'), 0o755)
  const git = (...a) => execFileSync('git', a, { cwd: repo })
  git('init', '-q')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  mkdirSync(path.join(repo, 'src'))
  writeFileSync(path.join(repo, 'src/A.tsx'), 'export const A = () => <button>Go</button>\n')
  git('add', 'src/A.tsx')
  sessionStart = new Date(Date.now() - 1000).toISOString()
  const r = spawnSync(process.execPath, [CLI, 'check', '--staged'], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, A11Y_LENS_AGENT: 'claude', A11Y_LENS_TIMEOUT_MS: '300' },
  })
  expect(r.status, r.stderr).toBe(0)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('a skipped check the session has not followed up', () => {
  it('was recorded by the installed CLI', () => {
    // The floor under every case below: without a recorded file, "passes" would be vacuous.
    expect(pendingCount()).toBe(1)
  })

  it('blocks finishing and names the command', () => {
    const out = runGate([bash('git commit -m x')])
    expect(JSON.parse(out).decision).toBe('block')
    expect(JSON.parse(out).reason).toContain('a11y-lens check --pending')
  })

  it('passes on the second stop', () => {
    expect(blocked([], { stopHookActive: true })).toBe(false)
  })

  it('passes once --pending has run in this session, even if files are still recorded', () => {
    expect(blocked([bash('pnpm exec a11y-lens check --pending')])).toBe(false)
    expect(blocked([bash('A11Y_LENS_TIMEOUT_MS=600000 pnpm exec a11y-lens check --strict --pending')])).toBe(false)
  })

  it('is satisfied by a call split across lines', () => {
    expect(blocked([bash('pnpm exec a11y-lens check \\\n  --pending')])).toBe(false)
  })

  it('blocks again for a skip recorded after the session ran --pending', () => {
    // The record was written in beforeAll; a --pending call stamped before it did not see it.
    expect(blocked([bash('pnpm exec a11y-lens check --pending', '2000-01-01T00:00:00.000Z')])).toBe(true)
  })

  it('is satisfied by the forms a session actually runs it in', () => {
    for (const command of [
      'cd /repo && pnpm exec a11y-lens check --pending',
      'npx a11y-lens check --pending; echo done',
      'node node_modules/@a11y-lens/cli/bin/a11y-lens.mjs check --pending',
      'node_modules/.bin/a11y-lens check --pending 2>&1 | tail -5',
    ]) {
      expect(blocked([bash(command)]), command).toBe(false)
    }
  })

  it('is not satisfied by a command that only mentions it', () => {
    // Each of these would pass the gate with every recorded file still unreviewed.
    for (const command of [
      "echo 'run a11y-lens check --pending later'",
      'grep -n "a11y-lens check --pending" AGENTS.md',
      'git commit -m "document a11y-lens check --pending"',
    ]) {
      expect(blocked([bash(command)]), command).toBe(true)
    }
  })

  it('is not satisfied by a different a11y-lens command', () => {
    expect(blocked([bash('pnpm exec a11y-lens check --staged')])).toBe(true)
  })

  it('still blocks without a readable transcript', () => {
    writeFileSync(tx, '')
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: path.join(dir, 'missing.jsonl') }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    })
    expect(JSON.parse(r.stdout).decision).toBe('block')
  })

  it('still blocks when the transcript carries no timestamp to start from', () => {
    expect(blocked([JSON.stringify({ type: 'summary' })], { start: null })).toBe(true)
  })
})

describe('a record left by an earlier session', () => {
  // The same record as above; only the session's start moves past it. Paired with the blocking
  // cases there, so a gate that never blocks cannot pass this one.
  it('does not block a session that started after it was written', () => {
    expect(pendingCount()).toBe(1)
    expect(blocked([bash('git status')], { start: new Date(Date.now() + 1000).toISOString() })).toBe(false)
  })
})

describe('nothing to follow up', () => {
  it('passes in a repository with nothing recorded', () => {
    const clean = mkdtempSync(path.join(tmpdir(), 'a11y-clean-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: clean })
      expect(blocked([], { projectDir: clean })).toBe(false)
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  })

  it('passes outside a git repository', () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'a11y-plain-'))
    try {
      expect(blocked([], { projectDir: plain })).toBe(false)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('passes on a payload it cannot parse', () => {
    const r = spawnSync('bash', [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo } })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })
})
