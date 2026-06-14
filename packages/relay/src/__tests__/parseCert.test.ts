import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseCertNotAfter } from '../lib/cert/parseCert.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const certPem = fs.readFileSync(path.join(here, 'fixtures/tls-cert.pem'), 'utf-8')

describe('parseCertNotAfter', () => {
  it('PEM에서 만료일을 Date로 파싱한다', () => {
    const exp = parseCertNotAfter(certPem)
    expect(exp).toBeInstanceOf(Date)
    expect(exp.getTime()).not.toBeNaN()
  })

  it('잘못된 PEM이면 throw', () => {
    expect(() => parseCertNotAfter('not a certificate')).toThrow()
  })
})
