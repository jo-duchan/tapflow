import { describe, it, expect, vi } from 'vitest'
import { getMachineId } from '../utils/machineId'

const IOREG = `+-o IOPlatformExpertDevice  <class IOPlatformExpertDevice>
    {
      "IOPlatformUUID" = "ABCD1234-5678-90EF-FEDC-BA0987654321"
      "IOPolledInterface" = "AppleARMWatchdogTimerHibernateHandler is not serializable"
    }`

describe('getMachineId', () => {
  it('extracts IOPlatformUUID from ioreg output (macOS)', () => {
    const execFn = vi.fn(() => IOREG)
    expect(getMachineId('darwin', execFn as never)).toBe('ABCD1234-5678-90EF-FEDC-BA0987654321')
    expect(execFn).toHaveBeenCalledWith('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' })
  })

  it('returns undefined off macOS without running ioreg', () => {
    const execFn = vi.fn(() => IOREG)
    expect(getMachineId('linux', execFn as never)).toBeUndefined()
    expect(execFn).not.toHaveBeenCalled()
  })

  it('returns undefined when ioreg throws', () => {
    const execFn = vi.fn(() => { throw new Error('not found') })
    expect(getMachineId('darwin', execFn as never)).toBeUndefined()
  })

  it('returns undefined when the UUID is absent from the output', () => {
    const execFn = vi.fn(() => '+-o IOPlatformExpertDevice\n  { "Foo" = "bar" }')
    expect(getMachineId('darwin', execFn as never)).toBeUndefined()
  })
})
