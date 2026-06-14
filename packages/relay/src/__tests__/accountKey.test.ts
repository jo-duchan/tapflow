import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadOrCreateAccountKey } from '../lib/cert/accountKey.js'

describe('loadOrCreateAccountKey', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-acct-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('파일이 없으면 생성·0600으로 영속화하고, 있으면 재사용(재생성 안 함)', async () => {
    const fp = path.join(dir, 'tls', 'account.pem')
    let creates = 0
    const create = async () => {
      creates++
      return `ACCOUNT-KEY-${creates}`
    }

    const k1 = await loadOrCreateAccountKey(fp, create)
    expect(k1).toBe('ACCOUNT-KEY-1')
    expect(creates).toBe(1)
    expect(fs.statSync(fp).mode & 0o777).toBe(0o600)

    const k2 = await loadOrCreateAccountKey(fp, create)
    expect(k2).toBe('ACCOUNT-KEY-1') // 디스크에서 재사용
    expect(creates).toBe(1) // create 재호출 안 됨
  })
})
