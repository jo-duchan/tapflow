import { describe, it, expect } from 'vitest'
import { parseFlow } from '../schema.js'

describe('parseFlow', () => {
  it('parses the full step vocabulary', () => {
    const flow = parseFlow(`
name: Login smoke
appId: com.example.app
steps:
  - clearState
  - launchApp
  - tapOn: "로그인"
  - tapOn:
      id: com.example.app:id/email
  - tapOn:
      label: "로그인"
      timeout: 20
  - inputText: "user@example.com"
  - pressKey: Enter
  - swipe:
      from: [0.5, 0.8]
      to: [0.5, 0.2]
  - scroll
  - scroll: down
  - openUrl: "myapp://orders/1"
  - assertVisible: "주문 목록"
  - assertNotVisible:
      label: "오류"
      timeout: 3
`, 'login.yaml')

    expect(flow.name).toBe('Login smoke')
    expect(flow.appId).toBe('com.example.app')
    expect(flow.steps).toHaveLength(13)
    expect(flow.steps[0]).toEqual({ type: 'clearState' })
    expect(flow.steps[1]).toEqual({ type: 'launchApp' })
    expect(flow.steps[2]).toEqual({ type: 'tapOn', selector: { text: '로그인' } })
    expect(flow.steps[3]).toEqual({ type: 'tapOn', selector: { id: 'com.example.app:id/email' } })
    expect(flow.steps[4]).toEqual({ type: 'tapOn', selector: { label: '로그인', timeoutMs: 20_000 } })
    expect(flow.steps[5]).toEqual({ type: 'inputText', text: 'user@example.com' })
    expect(flow.steps[6]).toEqual({ type: 'pressKey', code: 'Enter' })
    expect(flow.steps[7]).toEqual({ type: 'swipe', from: [0.5, 0.8], to: [0.5, 0.2], durationMs: 300 })
    expect(flow.steps[8]).toEqual({ type: 'scroll', direction: 'down' })
    expect(flow.steps[9]).toEqual({ type: 'scroll', direction: 'down' })
    expect(flow.steps[10]).toEqual({ type: 'openUrl', url: 'myapp://orders/1' })
    expect(flow.steps[11]).toEqual({ type: 'assertVisible', selector: { text: '주문 목록' } })
    expect(flow.steps[12]).toEqual({ type: 'assertNotVisible', selector: { label: '오류', timeoutMs: 3_000 } })
  })

  it('defaults name to the file name when omitted', () => {
    const flow = parseFlow('steps:\n  - launchApp\n', '.tapflow/flows/checkout.yaml')
    expect(flow.name).toBe('checkout')
  })

  it('rejects a flow without steps', () => {
    expect(() => parseFlow('name: empty\n', 'x.yaml')).toThrow(/steps/)
  })

  it('rejects an unknown step keyword with the step index', () => {
    expect(() => parseFlow(`
steps:
  - launchApp
  - tapp: "로그인"
`, 'x.yaml')).toThrow(/steps\[1\]/)
  })

  it('rejects a selector with neither id nor label', () => {
    expect(() => parseFlow(`
steps:
  - tapOn:
      timeout: 5
`, 'x.yaml')).toThrow(/id.*label|label.*id/)
  })

  it('rejects clearState when no appId is available', () => {
    expect(() => parseFlow(`
steps:
  - clearState
`, 'x.yaml')).toThrow(/appId/)
  })

  it('allows clearState with an inline bundle id instead of appId', () => {
    const flow = parseFlow(`
steps:
  - clearState: com.other.app
`, 'x.yaml')
    expect(flow.steps[0]).toEqual({ type: 'clearState', appId: 'com.other.app' })
  })

  it('rejects non-finite swipe coordinates (.nan)', () => {
    expect(() => parseFlow(`
steps:
  - swipe:
      from: [.nan, 0.5]
      to: [0.5, 0.2]
`, 'x.yaml')).toThrow(/steps\[0\]/)
  })

  it('rejects swipe coordinates outside 0-1', () => {
    expect(() => parseFlow(`
steps:
  - swipe:
      from: [0.5, 1.8]
      to: [0.5, 0.2]
`, 'x.yaml')).toThrow(/steps\[0\]/)
  })

  it('rejects invalid scroll directions', () => {
    expect(() => parseFlow(`
steps:
  - scroll: sideways
`, 'x.yaml')).toThrow(/steps\[0\]/)
  })

  it('rejects non-YAML and non-object documents', () => {
    expect(() => parseFlow('just a string', 'x.yaml')).toThrow()
    expect(() => parseFlow('- a\n- b\n', 'x.yaml')).toThrow()
  })
})
