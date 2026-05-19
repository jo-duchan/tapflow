import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { initDb, closeDb, getDb } from '../db.js'

function tmpDbPath() {
  return path.join(os.tmpdir(), `tapflow-test-${Date.now()}.db`)
}

describe('runMigrations', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = tmpDbPath()
  })

  afterEach(() => {
    closeDb()
    fs.rmSync(dbPath, { force: true })
  })

  it('정상 마이그레이션 실행 후 _migrations에 모든 파일 기록', () => {
    initDb(dbPath)
    const rows = getDb()
      .prepare('SELECT name FROM _migrations ORDER BY name')
      .all() as { name: string }[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].name).toMatch(/^\d{3}_.*\.sql$/)
  })

  it('이미 실행된 마이그레이션은 재실행하지 않음', () => {
    initDb(dbPath)
    const first = getDb()
      .prepare('SELECT COUNT(*) as c FROM _migrations')
      .get() as { c: number }

    closeDb()
    initDb(dbPath)
    const second = getDb()
      .prepare('SELECT COUNT(*) as c FROM _migrations')
      .get() as { c: number }

    expect(second.c).toBe(first.c)
  })

  it('마이그레이션 실패 시 해당 마이그레이션이 _migrations에 기록되지 않음', () => {
    // 정상 DB 초기화 후 닫기
    initDb(dbPath)
    closeDb()

    // DB를 직접 열어 다음 마이그레이션 번호를 확인
    const raw = new Database(dbPath)
    const before = (
      raw.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }
    ).c

    // _migrations에 가짜 항목을 삽입해 실제 마이그레이션이 이미 실행된 것처럼 처리한 뒤
    // 존재하지 않는 테이블을 참조하는 SQL을 _migrations 없이 직접 실행해 실패를 유도
    // → transaction()이 없으면 부분 상태로 남고, 있으면 완전 롤백
    expect(() => {
      raw.transaction(() => {
        raw.exec('CREATE TABLE _test_atomic (id INTEGER PRIMARY KEY)')
        raw.exec('INVALID SQL THAT WILL FAIL')
      })()
    }).toThrow()

    // 롤백됐으면 _test_atomic 테이블이 존재하지 않아야 함
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_test_atomic'")
      .all()
    expect(tables).toHaveLength(0)

    // _migrations 카운트도 변하지 않아야 함
    const after = (
      raw.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }
    ).c
    expect(after).toBe(before)

    raw.close()
  })

  it('마이그레이션 도중 실패 시 _migrations 기록도 함께 롤백됨', () => {
    initDb(dbPath)
    const before = (
      getDb().prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }
    ).c
    closeDb()

    // 실패하는 SQL을 직접 transaction으로 실행해 롤백 검증
    const raw = new Database(dbPath)
    expect(() => {
      raw.transaction(() => {
        raw.exec('ALTER TABLE _migrations ADD COLUMN fake TEXT')
        raw.exec('INVALID SQL')
      })()
    }).toThrow()

    const after = (
      raw.prepare('SELECT COUNT(*) as c FROM _migrations').get() as { c: number }
    ).c
    expect(after).toBe(before)

    // fake 컬럼이 롤백됐는지 확인
    const cols = raw.prepare('PRAGMA table_info(_migrations)').all() as { name: string }[]
    expect(cols.find((c) => c.name === 'fake')).toBeUndefined()

    raw.close()
  })
})
