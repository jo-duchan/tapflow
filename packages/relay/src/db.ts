import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized — call initDb() first')
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

export function initDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations()
}

function runMigrations(): void {
  const d = getDb()
  d.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT NOT NULL UNIQUE,
      run_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const migrationsDir = path.join(import.meta.dirname, 'migrations')
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()

  const ran = new Set(
    (d.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name)
  )

  for (const file of files) {
    if (ran.has(file)) continue
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
    d.exec(sql)
    d.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file)
  }
}
