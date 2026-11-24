// The helper is what package `build` scripts call in place of `rm`/`cp`/`mkdir`/`chmod`,
// which cmd.exe does not have. These cases are the three call sites and the failure
// modes a typo would hit.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { chmodX, replace, rm, mkdir } from '../fs-copy.mjs'

const SCRIPT = fileURLToPath(new URL('../fs-copy.mjs', import.meta.url))
const REPO = fileURLToPath(new URL('../..', import.meta.url))

function scratch() {
  return mkdtempSync(join(tmpdir(), 'fs-copy-'))
}

function run(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
  })
}

describe('replace', () => {
  it('copies a directory onto a path, replacing whatever was there', () => {
    const dir = scratch()
    try {
      mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
      writeFileSync(join(dir, 'src', 'index.html'), 'hello')
      writeFileSync(join(dir, 'src', 'nested', 'app.js'), 'ok')
      mkdirSync(join(dir, 'dest'), { recursive: true })
      writeFileSync(join(dir, 'dest', 'stale.txt'), 'gone')

      replace(join(dir, 'src'), join(dir, 'dest'))

      expect(readFileSync(join(dir, 'dest', 'index.html'), 'utf8')).toBe('hello')
      expect(readFileSync(join(dir, 'dest', 'nested', 'app.js'), 'utf8')).toBe('ok')
      expect(existsSync(join(dir, 'dest', 'stale.txt'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a trailing "/." the way `cp -r src/. dest/` does — contents, not a "." folder', () => {
    const dir = scratch()
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'keep.txt'), 'yes')
      replace(join(dir, 'src') + '/.', join(dir, 'dest'))
      expect(readFileSync(join(dir, 'dest', 'keep.txt'), 'utf8')).toBe('yes')
      expect(existsSync(join(dir, 'dest', '.'))).toBe(true) // the dest directory itself
      expect(existsSync(join(dir, 'src-dot'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves dest alone when src does not exist', () => {
    const dir = scratch()
    try {
      mkdirSync(join(dir, 'dest'), { recursive: true })
      writeFileSync(join(dir, 'dest', 'kept.txt'), 'still here')
      expect(() => replace(join(dir, 'missing'), join(dir, 'dest'))).toThrow()
      expect(readFileSync(join(dir, 'dest', 'kept.txt'), 'utf8')).toBe('still here')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('rm and mkdir', () => {
  it('rm removes a tree and mkdir creates nested directories', () => {
    const dir = scratch()
    try {
      const nested = join(dir, 'a', 'b')
      mkdir(nested)
      writeFileSync(join(nested, 'f.txt'), 'x')
      expect(existsSync(join(nested, 'f.txt'))).toBe(true)
      rm(join(dir, 'a'))
      expect(existsSync(join(dir, 'a'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('chmod-x', () => {
  it('sets the executable bit on POSIX, and is a no-op on Windows', () => {
    const dir = scratch()
    try {
      const file = join(dir, 'tool.js')
      writeFileSync(file, '#!/usr/bin/env node\n')
      chmodSync(file, 0o644)
      chmodX(file)
      if (process.platform === 'win32') {
        expect(existsSync(file)).toBe(true)
      } else {
        expect(statSync(file).mode & 0o111).toBe(0o111)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CLI', () => {
  it('runs replace through the same entry package scripts invoke', () => {
    const dir = scratch()
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'a.txt'), 'A')
      const result = run(['replace', 'src', 'dest'], dir)
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(dir, 'dest', 'a.txt'), 'utf8')).toBe('A')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits non-zero on a missing command or a missing source', () => {
    const dir = scratch()
    try {
      expect(run([], dir).status).not.toBe(0)
      expect(run(['nope'], dir).status).not.toBe(0)
      const missing = run(['replace', 'no-such-src', 'dest'], dir)
      expect(missing.status).not.toBe(0)
      expect(existsSync(join(dir, 'dest'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('package build scripts call the helper, not Unix shell commands', () => {
  const UNIX = /(?:^|[\s;&])(?:rm|cp|mkdir|mv|chmod)\s/

  function script(pkg) {
    return JSON.parse(readFileSync(join(REPO, 'packages', pkg, 'package.json'), 'utf8')).scripts.build
  }

  it('dashboard, relay and mcp-server builds invoke fs-copy.mjs', () => {
    const dashboard = script('dashboard')
    const relay = script('relay')
    const mcp = script('mcp-server')

    expect(dashboard).toContain('node ../../scripts/fs-copy.mjs replace dist ../relay/public')
    expect(relay).toContain('node ../../scripts/fs-copy.mjs replace src/migrations dist/migrations')
    expect(mcp).toContain('node ../../scripts/fs-copy.mjs chmod-x dist/index.js')

    for (const [name, build] of [['dashboard', dashboard], ['relay', relay], ['mcp-server', mcp]]) {
      expect(build, `${name} build still contains a Unix-only command: ${build}`).not.toMatch(UNIX)
    }
  })
})
