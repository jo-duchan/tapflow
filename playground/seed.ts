import path from 'path'
import crypto from 'crypto'
import { initDb, getDb } from '@tapflowio/relay'

const dataDir = path.join(import.meta.dirname, '.tapflow-data')
initDb(path.join(dataDir, 'tapflow.db'))

function makePasswordHash(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex')
  return `${salt}:${hash}`
}

const email = process.argv[2] ?? 'admin@tapflow.local'
const password = process.argv[3] ?? 'admin1234'

const db = getDb()
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
if (existing) {
  console.log(`User ${email} already exists.`)
  process.exit(0)
}

db.prepare(
  'INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)'
).run(email, 'Admin', 'Admin', makePasswordHash(password))

console.log(`✓ Created admin user: ${email} / ${password}`)
