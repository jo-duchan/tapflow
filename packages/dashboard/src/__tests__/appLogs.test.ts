import { describe, expect, it } from 'vitest'
import { APP_LOG_BUFFER_LIMIT, appendAppLogText } from '@/lib/appLogs'

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
