import { describe, expect, it } from 'vitest'
import { secretPieces, selectorHoldsSecret, stepHoldsSecret } from '../capture/secrets.js'

describe('capture secrets', () => {
  it('looks for each typed secret whole and in its pieces between a Tab or a Return', () => {
    expect(secretPieces(['a@b.c\thunter2', '', 'x\r\ny'])).toEqual(['a@b.c\thunter2', 'a@b.c', 'hunter2', 'x\r\ny', 'x', 'y'])
  })

  it('reads every string of a selector, a bare one included', () => {
    for (const sel of [{ text: 'tok-1' }, { id: 'copy-tok-1' }, { label: 'Copy tok-1' }]) {
      expect(selectorHoldsSecret(sel, ['tok-1'])).toBe(true)
    }
    expect(selectorHoldsSecret({ label: 'Copy', index: 1 }, ['1'])).toBe(false)
  })

  it('reads a step\'s nested strings as they are held, not serialized', () => {
    expect(stepHoldsSecret({ type: 'pinch', on: { label: 'map p"ass' }, scale: 2, durationMs: 300 }, ['p"ass'])).toBe(true)
    expect(stepHoldsSecret({ type: 'openUrl', url: 'app://x?k=a\\b' }, ['a\\b'])).toBe(true)
    expect(stepHoldsSecret({ type: 'tapOn', selector: { id: 'ok' }, expect: { appear: [{ text: 'Hi 4826' }] } }, ['4826'])).toBe(true)
  })

  // Review of #1248's follow-up: a one-character secret matched every key code, button and role.
  it('never reads the flow\'s or the platform\'s own words', () => {
    const o = ['o']
    expect(stepHoldsSecret({ type: 'pressKey', code: 'Tab' }, ['T'])).toBe(false)
    expect(stepHoldsSecret({ type: 'pressButton', name: 'home' }, o)).toBe(false)
    expect(stepHoldsSecret({ type: 'setOrientation', orientation: 'portrait' }, o)).toBe(false)
    expect(stepHoldsSecret({ type: 'clearState', appId: 'com.example.app' }, o)).toBe(false)
    expect(stepHoldsSecret({ type: 'scroll', direction: 'down', until: { role: 'button', id: 'next' } }, o)).toBe(false)
    expect(selectorHoldsSecret({ role: 'button', label: 'Go' }, o)).toBe(true)
    expect(stepHoldsSecret({ type: 'openUrl', url: 'app://home' }, o)).toBe(true)
    // CodeRabbit on #1253: a launch's env and arguments are maps, whose keys can be any of those words.
    expect(stepHoldsSecret({ type: 'launchApp', options: { env: { direction: 'tok-9' }, arguments: { type: 'tok-9' } } }, ['tok-9'])).toBe(true)
    expect(stepHoldsSecret({ type: 'launchApp' }, o)).toBe(false)
  })

  it('never reads a step\'s type, or the name an inputSecret is given', () => {
    expect(stepHoldsSecret({ type: 'tapOn', selector: { id: 'ok' } }, ['tap'])).toBe(false)
    expect(stepHoldsSecret({ type: 'inputSecret', name: 'PASSWORD' }, ['PASS'])).toBe(false)
  })
})
