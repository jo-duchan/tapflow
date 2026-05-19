import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('child_process', () => {
  const mockStdin = {
    writable: true,
    write: vi.fn(),
  }
  const mockProc = {
    stdin: mockStdin,
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  }
  return {
    spawn: vi.fn(() => mockProc),
    __mockProc: mockProc,
  }
})

import { spawn } from 'child_process'
import { TouchHelper } from '../TouchHelper.js'

function capturedHex(): string {
  const mockStdin = (vi.mocked(spawn) as ReturnType<typeof vi.fn>)
    .mock.results[0]?.value.stdin as { write: ReturnType<typeof vi.fn> }
  const buf: Buffer = mockStdin.write.mock.calls[0]?.[0] as Buffer
  return buf.toString('hex').replace(/(.{2})/g, '$1 ').trimEnd()
}

describe('TouchHelper stdin byte protocol snapshots', () => {
  let helper: TouchHelper

  beforeEach(() => {
    vi.clearAllMocks()
    helper = new TouchHelper('booted')
    helper.start()
  })

  afterEach(() => vi.restoreAllMocks())

  // ── type 1: touchStart ───────────────────────────────────────────────────
  it('type 1 — touchStart(0.5, 0.5) → 9 bytes', () => {
    helper.touchStart(0.5, 0.5)
    expect(capturedHex()).toMatchInlineSnapshot(`"01 3f 00 00 00 3f 00 00 00"`)
  })

  // ── type 2: touchMove ────────────────────────────────────────────────────
  it('type 2 — touchMove(0.25, 0.75) → 9 bytes', () => {
    helper.touchMove(0.25, 0.75)
    expect(capturedHex()).toMatchInlineSnapshot(`"02 3e 80 00 00 3f 40 00 00"`)
  })

  // ── type 3: touchEnd ─────────────────────────────────────────────────────
  it('type 3 — touchEnd() carries lastX/lastY set by touchStart', () => {
    helper.touchStart(0.1, 0.2)
    vi.mocked(spawn).mock.results[0]!.value.stdin.write.mockClear()
    helper.touchEnd()
    expect(capturedHex()).toMatchInlineSnapshot(`"03 3d cc cc cd 3e 4c cc cd"`)
  })

  // ── type 4: pressButton ──────────────────────────────────────────────────
  it('type 4 — pressButton(usagePage=0x0C, usage=0xE9) → 9 bytes', () => {
    helper.pressButton(0x0c, 0xe9)
    expect(capturedHex()).toMatchInlineSnapshot(`"04 00 00 00 0c 00 00 00 e9"`)
  })

  // ── type 5: pressLegacyButton ────────────────────────────────────────────
  it('type 5 — pressLegacyButton(0) → 9 bytes, second u32 padded to 0', () => {
    helper.pressLegacyButton(0)
    expect(capturedHex()).toMatchInlineSnapshot(`"05 00 00 00 00 00 00 00 00"`)
  })

  // ── type 6: pinchStart ───────────────────────────────────────────────────
  it('type 6 — pinchStart(0.2, 0.3, 0.7, 0.8) → 17 bytes', () => {
    helper.pinchStart(0.2, 0.3, 0.7, 0.8)
    expect(capturedHex()).toMatchInlineSnapshot(
      `"06 3e 4c cc cd 3e 99 99 9a 3f 33 33 33 3f 4c cc cd"`,
    )
  })

  // ── type 7: pinchMove ────────────────────────────────────────────────────
  it('type 7 — pinchMove(0.3, 0.4, 0.6, 0.7) → 17 bytes', () => {
    helper.pinchMove(0.3, 0.4, 0.6, 0.7)
    expect(capturedHex()).toMatchInlineSnapshot(
      `"07 3e 99 99 9a 3e cc cc cd 3f 19 99 9a 3f 33 33 33"`,
    )
  })

  // ── type 8: pinchEnd ─────────────────────────────────────────────────────
  it('type 8 — pinchEnd() → 17 bytes all zero coords', () => {
    helper.pinchEnd()
    expect(capturedHex()).toMatchInlineSnapshot(
      `"08 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00"`,
    )
  })

  // ── type 9: sendKey ──────────────────────────────────────────────────────
  it('type 9 — sendKey(usage=0x04, modifiers=0x02) → 9 bytes', () => {
    helper.sendKey(0x04, 0x02)
    expect(capturedHex()).toMatchInlineSnapshot(`"09 02 00 00 00 00 00 00 04"`)
  })

  // ── stdin.writable guard ─────────────────────────────────────────────────
  it('stdin.writable === false 시 write 호출되지 않음', () => {
    const mockStdin = vi.mocked(spawn).mock.results[0]!.value.stdin as {
      writable: boolean
      write: ReturnType<typeof vi.fn>
    }
    mockStdin.writable = false
    helper.touchStart(0.5, 0.5)
    expect(mockStdin.write).not.toHaveBeenCalled()
  })
})
