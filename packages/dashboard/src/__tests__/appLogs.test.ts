import { describe, expect, it } from 'vitest'
import { APP_LOG_BUFFER_LIMIT, appendAppLogText, endsShownLaunch } from '@/lib/appLogs'

describe('app log buffer', () => {
  it('retains the newest text within the session buffer limit', () => {
    const text = appendAppLogText('old', 'x'.repeat(APP_LOG_BUFFER_LIMIT))
    expect(text).toHaveLength(APP_LOG_BUFFER_LIMIT)
    expect(text.startsWith('x')).toBe(true)
    expect(text.includes('old')).toBe(false)
  })

  it('does not split a Unicode surrogate pair when dropping old text', () => {
    const prefix = 'x'.repeat(APP_LOG_BUFFER_LIMIT - 1)
    const text = appendAppLogText(prefix, '🚀')
    expect(text).toHaveLength(APP_LOG_BUFFER_LIMIT)
    expect(text.codePointAt(0)).not.toBe(0xde80)
    expect(text.endsWith('🚀')).toBe(true)
  })
})

// Flow Capture's replay sends these through the viewer's socket, and the relay forgets the shown launch on each.
describe('what ends the shown launch', () => {
  it('is a clear-state, an install, or a launch the viewer did not start', () => {
    expect(endsShownLaunch({ type: 'app:clear-state', sessionId: 's', requestId: 'r', payload: { bundleId: 'b' } }, 'shown')).toBe(true)
    expect(endsShownLaunch({ type: 'app:install', sessionId: 's', requestId: 'r', buildId: 1 }, 'shown')).toBe(true)
    expect(endsShownLaunch({ type: 'app:launch', sessionId: 's', requestId: 'replay', buildId: 1 }, 'shown')).toBe(true)
  })

  it("is not the viewer's own launch, nor an input", () => {
    expect(endsShownLaunch({ type: 'app:launch', sessionId: 's', requestId: 'shown', buildId: 1 }, 'shown')).toBe(false)
    expect(endsShownLaunch({ type: 'input:key', sessionId: 's', payload: { code: 'KeyA' } } as never, 'shown')).toBe(false)
  })
})
