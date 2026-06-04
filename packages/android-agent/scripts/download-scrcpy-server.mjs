#!/usr/bin/env node
/**
 * Downloads scrcpy-server.jar from GitHub releases.
 * Run: npm run download-scrcpy-server
 */
import { createWriteStream, existsSync } from 'fs'
import { pipeline } from 'stream/promises'
import { fileURLToPath } from 'url'
import path from 'path'
import https from 'https'

const VERSION = '3.3'
const URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`
const DEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/scrcpy-server.jar')

if (existsSync(DEST)) {
  console.log(`scrcpy-server.jar already present at ${DEST}`)
  process.exit(0)
}

console.log(`Downloading scrcpy-server v${VERSION}…`)

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        get(res.headers.location).then(resolve).catch(reject)
      } else if (res.statusCode === 200) {
        resolve(res)
      } else {
        reject(new Error(`HTTP ${res.statusCode}`))
      }
    }).on('error', reject)
  })
}

const res = await get(URL)
await pipeline(res, createWriteStream(DEST))
console.log(`Saved to ${DEST}`)
