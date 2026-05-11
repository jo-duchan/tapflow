import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const mockProc = new EventEmitter() as ReturnType<typeof import('child_process').spawn>
Object.assign(mockProc, { kill: vi.fn() })

vi.mock('child_process', () => ({ spawn: vi.fn(() => mockProc) }))
vi.mock('fs', () => ({
  default: { mkdirSync: vi.fn(), unlinkSync: vi.fn() },
}))

import { spawn } from 'child_process'
import { SimctlRecorder } from '../SimctlRecorder'

const mockSpawn = spawn as ReturnType<typeof vi.fn>

describe('SimctlRecorder', () => {
  beforeEach(() => {
    mockSpawn.mockClear()
    ;(mockProc as { kill: ReturnType<typeof vi.fn> }).kill.mockClear()
    mockProc.removeAllListeners()
  })

  it('start() spawns xcrun simctl io recordVideo', () => {
    const rec = new SimctlRecorder()
    rec.start('dev-1')
    expect(mockSpawn).toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining(['simctl', 'io', 'dev-1', 'recordVideo']),
    )
  })

  it('start() throws if already recording', () => {
    const rec = new SimctlRecorder()
    rec.start('dev-1')
    expect(() => rec.start('dev-1')).toThrow('Recording already in progress')
  })

  it('isRecording() reflects state', () => {
    const rec = new SimctlRecorder()
    expect(rec.isRecording()).toBe(false)
    rec.start('dev-1')
    expect(rec.isRecording()).toBe(true)
  })

  it('stop() sends SIGINT and resolves with file path when process closes', async () => {
    const rec = new SimctlRecorder()
    rec.start('dev-1')
    const stopPromise = rec.stop()
    mockProc.emit('close', 0)
    const fp = await stopPromise
    expect((mockProc as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith('SIGINT')
    expect(fp).toMatch(/tapflow-recordings/)
    expect(fp).toMatch(/\.mov$/)
  })

  it('stop() rejects if not recording', async () => {
    const rec = new SimctlRecorder()
    await expect(rec.stop()).rejects.toThrow('No recording in progress')
  })

  it('cleanup() kills process and removes file', () => {
    const rec = new SimctlRecorder()
    rec.start('dev-1')
    rec.cleanup()
    expect((mockProc as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith('SIGKILL')
    expect(rec.isRecording()).toBe(false)
  })
})
