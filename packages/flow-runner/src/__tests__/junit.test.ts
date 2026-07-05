import { describe, it, expect } from 'vitest'
import { toJUnitXml } from '../junit.js'
import type { FlowResult } from '../engine.js'

const passed: FlowResult = {
  name: 'login',
  file: '.tapflow/flows/login.yaml',
  status: 'passed',
  durationMs: 1234,
  steps: [
    { index: 0, name: 'launchApp', status: 'passed', durationMs: 1000 },
    { index: 1, name: 'tapOn("로그인")', status: 'passed', durationMs: 234 },
  ],
}

const failed: FlowResult = {
  name: 'checkout <fast> & "cheap"',
  file: '.tapflow/flows/checkout.yaml',
  status: 'failed',
  durationMs: 5000,
  failureMessage: 'tapOn("결제"): no element matched "결제" within 10s',
  steps: [
    { index: 0, name: 'launchApp', status: 'passed', durationMs: 1000 },
    { index: 1, name: 'tapOn("결제")', status: 'failed', durationMs: 4000, message: 'no element matched "결제" within 10s' },
    { index: 2, name: 'pressKey(Enter)', status: 'skipped', durationMs: 0 },
  ],
}

describe('toJUnitXml', () => {
  it('renders one testcase per flow with counts and times', () => {
    const xml = toJUnitXml([passed, failed])
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('tests="2"')
    expect(xml).toContain('failures="1"')
    expect(xml).toContain('name="login"')
    expect(xml).toContain('classname=".tapflow/flows/login.yaml"')
    expect(xml).toContain('time="1.234"')
  })

  it('embeds the failure message and step log, XML-escaped', () => {
    const xml = toJUnitXml([failed])
    expect(xml).toContain('name="checkout &lt;fast&gt; &amp; &quot;cheap&quot;"')
    expect(xml).toContain('<failure message="tapOn(&quot;결제&quot;): no element matched &quot;결제&quot; within 10s">')
    expect(xml).toContain('✗ tapOn(&quot;결제&quot;)')
    expect(xml).toContain('- pressKey(Enter) (skipped)')
  })

  it('produces no failure element for a passing flow', () => {
    const xml = toJUnitXml([passed])
    expect(xml).not.toContain('<failure')
  })

  it('strips XML-invalid control characters from messages', () => {
    const xml = toJUnitXml([{
      ...failed,
      failureMessage: 'boom\x07\x00 with bell',
    }])
    expect(xml).toContain('message="boom with bell"')
  })
})
