import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@tapflow/relay', () => ({
  RelayServer: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
  })),
}))

import { RelayServer } from '@tapflow/relay'
import { cmdRelayStart } from '../../commands/relay-start.js'

describe('cmdRelayStart', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(RelayServer).mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
    } as never))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process, 'on').mockImplementation(() => process)
  })

  afterEach(() => vi.restoreAllMocks())

  it('기본 포트 4000으로 RelayServer 기동', async () => {
    await cmdRelayStart({})
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4000 }))
    expect(vi.mocked(RelayServer).mock.results[0]?.value.start).toHaveBeenCalled()
  })

  it('--port 옵션으로 포트 변경', async () => {
    await cmdRelayStart({ port: 8080 })
    expect(RelayServer).toHaveBeenCalledWith(expect.objectContaining({ port: 8080 }))
  })

  it('SIGINT 핸들러 등록', async () => {
    const onSpy = vi.spyOn(process, 'on')
    await cmdRelayStart({})
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
  })
})
