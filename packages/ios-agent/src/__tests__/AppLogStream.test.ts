import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { AppLogStream } from '../AppLogStream.js'

describe('iOS app log stream', () => {
  it('scopes native output to the launched process, preserves text, and stops its child', () => {
    const stdout = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    })
    const child = {
      stdout,
      exitCode: null,
      killed: false,
      once: vi.fn(),
      kill: vi.fn(function (this: { killed: boolean }) {
        this.killed = true
        return true
      }),
    } as unknown as ChildProcess
    const spawnProcess = vi.fn(() => child) as unknown as typeof import('child_process').spawn
    const onText = vi.fn()
    const stream = new AppLogStream('sim-1', 123, onText, vi.fn(), spawnProcess)

    expect(spawnProcess).toHaveBeenCalledWith(
      'xcrun',
      [
        'simctl',
        'spawn',
        'sim-1',
        'log',
        'stream',
        '--style',
        'compact',
        '--predicate',
        'processIdentifier == 123',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const text = `${'x'.repeat(8191)}🚀\nnext`
    stdout.emit('data', text)
    expect(onText.mock.calls.map(([chunk]) => chunk).join('')).toBe(text)
    expect(onText.mock.calls.every(([chunk]) => Buffer.byteLength(chunk, 'utf8') <= 8192)).toBe(
      true
    )

    stream.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
