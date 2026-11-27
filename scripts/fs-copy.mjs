#!/usr/bin/env node
// Cross-platform stand-in for the `rm`/`cp`/`mkdir`/`chmod` calls in package scripts.
//
// Why: npm and pnpm run scripts through cmd.exe on Windows, which has none of those
// commands. The root `pnpm build` failed there at the dashboard's copy into
// `packages/relay/public`, the relay's copy of SQL migrations, and the MCP server's
// `chmod +x`. Linux and macOS behaviour is the same as the shell commands this replaces.
import { chmodSync, cpSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(message) {
  console.error(message)
  process.exit(1)
}

function usage() {
  fail('usage: fs-copy.mjs replace <src> <dest> | rm <path> | mkdir <path> | chmod-x <path>')
}

/**
 * Delete `dest` if it exists and copy `src` onto that path.
 * Matches `rm -rf dest && cp -r src dest` (when dest is missing, `cp -r` creates it).
 * `src` ending in `/.` copies the directory's contents, matching `cp -r src/. dest/`.
 */
export function replace(src, dest) {
  const from = resolve(src)
  const to = resolve(dest)
  // Existence is checked first so a typo in `src` does not already wipe `dest`.
  // The shell form `rm -rf dest && cp -r src dest` would delete dest first; failing
  // closed is the safer mismatch, and none of the call sites rely on the wipe.
  statSync(from)
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
}

export function rm(path) {
  rmSync(resolve(path), { recursive: true, force: true })
}

export function mkdir(path) {
  mkdirSync(resolve(path), { recursive: true })
}

/** `chmod +x`. On Windows the execute bit is not a file-system concept, so this is a no-op. */
export function chmodX(path) {
  if (process.platform === 'win32') return
  chmodSync(resolve(path), 0o755)
}

const COMMANDS = {
  replace: (args) => {
    if (args.length !== 2) usage()
    replace(args[0], args[1])
  },
  rm: (args) => {
    if (args.length !== 1) usage()
    rm(args[0])
  },
  mkdir: (args) => {
    if (args.length !== 1) usage()
    mkdir(args[0])
  },
  'chmod-x': (args) => {
    if (args.length !== 1) usage()
    chmodX(args[0])
  },
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...args] = argv
  const run = COMMANDS[cmd]
  if (!run) usage()
  run(args)
}

const invokedAs = process.argv[1] && resolve(process.argv[1])
if (invokedAs && invokedAs === fileURLToPath(import.meta.url)) {
  main()
}
