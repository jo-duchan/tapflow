import { describe, it, expect } from 'vitest'
import type { UIElement } from '@tapflowio/agent-core'
import { parseFlow } from '../schema'
import { matchSelector } from '../selector'
import { suggestSelectors } from '../suggest'

// B2: when `tapOn` finds nothing (or too much), the tree the runner failed to match is the evidence for a fix. Every
// suggestion has to be one a person can paste into the flow and have it tap the element it names — nothing looser.

const el = (label: string, over: Partial<UIElement> = {}): UIElement => ({
  role: 'button', label, frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 }, enabled: true, ...over,
})

/** What the suggestion's YAML resolves to, read back through the flow parser exactly as a pasted line would be. */
function resolvesTo(tree: UIElement[], yaml: string): UIElement[] {
  const flow = parseFlow(`name: t\nsteps:\n  - ${yaml}\n`, 'suggestion.yaml')
  const step = flow.steps[0]!
  if (step.type !== 'tapOn') throw new Error(`not a tapOn: ${yaml}`)
  return matchSelector(tree, step.selector)
}

describe('suggestSelectors', () => {
  it('offers the label a misspelled one meant, as a bare string', () => {
    const tree = [el('Sign in'), el('Create account'), el('Forgot password?', { role: 'text' })]
    const s = suggestSelectors(tree, { text: 'Sign inn' })
    expect(s[0]).toEqual({ yaml: 'tapOn: "Sign in"', element: { role: 'button', label: 'Sign in' } })
  })

  // An Android password node of another class is secure without being an input: its label can be what was typed.
  it('never names a secure element by its label, in the line or beside it', () => {
    const tree = [el('hunter2', { role: 'other', secure: true, identifier: 'pw' }), el('Sign in')]
    const s = suggestSelectors(tree, { id: 'pw2' })
    expect(s[0]).toEqual({ yaml: 'tapOn: { id: "pw" }', element: { role: 'other', label: '', identifier: 'pw' } })
  })

  it('treats case, spacing and punctuation as the same label', () => {
    const tree = [el('Pay now'), el('Cancel')]
    expect(suggestSelectors(tree, { label: 'pay  now!' })[0]!.yaml).toBe('tapOn: "Pay now"')
  })

  // Food Truck: the "Donuts" card was below the fold, and the only near name on screen was an order row's donut icon.
  it('offers an image only by the same name — its label is an asset name, not text anyone sees', () => {
    const icon = el('donut', { role: 'image', frame: { x: 0.57, y: 0.7, width: 0.06, height: 0.02 } })
    expect(suggestSelectors([icon, el('Order#1234', { role: 'text' })], { text: 'Donuts' })).toEqual([])
    expect(suggestSelectors([icon], { text: 'Donut' })[0]!.element).toEqual({ role: 'image', label: 'donut' })
  })

  it('offers an id for an id selector with a typo', () => {
    const tree = [el('', { identifier: 'com.example.app:id/login_button' }), el('', { identifier: 'com.example.app:id/signup_button' })]
    expect(suggestSelectors(tree, { id: 'com.example.app:id/login_buton' })[0]!.yaml).toBe('tapOn: { id: "com.example.app:id/login_button" }')
  })

  it('never offers a bare string that an identifier equal to it would take first', () => {
    // iOS: a navigation bar's identifier is its title, and a bare string resolves by identifier first — so
    // `tapOn: "The App"` taps the bar, not the button labelled "The App".
    const bar = el('The App', { role: 'other', identifier: 'The App' })
    const button = el('The App')
    const tree = [bar, button]
    const s = suggestSelectors(tree, { text: 'The Ap' })
    const forButton = s.find((x) => x.element.role === 'button')!
    expect(forButton.yaml).not.toBe('tapOn: "The App"')
    expect(resolvesTo(tree, forButton.yaml)).toEqual([button])
  })

  it('disambiguates a selector that matched several, by role before index', () => {
    const tree = [el('Delete', { role: 'text' }), el('Delete'), el('Delete', { role: 'cell' })]
    const s = suggestSelectors(tree, { text: 'Delete' })
    expect(s.map((x) => x.yaml)).toContain('tapOn: { label: "Delete", role: "button" }')
    for (const x of s) expect(resolvesTo(tree, x.yaml)).toHaveLength(1)
  })

  it('falls back to an index only when nothing else tells the matches apart', () => {
    const tree = [el('Row'), el('Row')]
    const s = suggestSelectors(tree, { text: 'Row' })
    expect(s.map((x) => x.yaml)).toEqual(['tapOn: { label: "Row", role: "button", index: 0 }', 'tapOn: { label: "Row", role: "button", index: 1 }'])
  })

  it('drops a role that kept the right element out', () => {
    const tree = [el('Continue', { role: 'other' })]
    expect(suggestSelectors(tree, { label: 'Continue', role: 'button' })[0]!.yaml).toBe('tapOn: "Continue"')
  })

  it('keeps the original timeout, which only the object form can carry', () => {
    const tree = [el('Pay now')]
    expect(suggestSelectors(tree, { text: 'Pay nw', timeoutMs: 20_000 })[0]!.yaml).toBe('tapOn: { label: "Pay now", timeout: 20 }')
  })

  it('offers a placeholder-only field by its placeholder', () => {
    const nickname = el('', { role: 'input', placeholder: 'Nickname' })
    const tree = [el('Help'), nickname]
    const out = suggestSelectors(tree, { text: 'Nicknam' })
    expect(out.map((s) => s.yaml)).toEqual(['tapOn: "Nickname"'])
    expect(resolvesTo(tree, out[0]!.yaml)).toEqual([nickname])
  })

  it('suggests nothing when nothing on screen is close', () => {
    expect(suggestSelectors([el('Settings'), el('Profile')], { text: 'Checkout' })).toEqual([])
  })

  it('does not stretch a short label to a different word', () => {
    // Edit distance would rank these close; a person would not.
    expect(suggestSelectors([el('Day')], { text: 'Pay' })).toEqual([])
    expect(suggestSelectors([el('Text')], { text: 'Next' })).toEqual([])
    expect(suggestSelectors([el('Loading', { role: 'text' })], { text: 'Login' })).toEqual([])
    expect(suggestSelectors([el('다른')], { text: '다음' })).toEqual([])
    expect(suggestSelectors([el('결재')], { text: '결제' })).toEqual([])
  })

  it('finds a Korean label off by one letter', () => {
    expect(suggestSelectors([el('주문하기 완료')], { text: '주문하기 왼료' })[0]!.yaml).toBe('tapOn: "주문하기 완료"')
  })

  it('counts a Korean typo by the jamo that is wrong, not the whole syllable', () => {
    // Two one-jamo typos in six syllables: a third of the letters by syllable, a tenth by jamo.
    expect(suggestSelectors([el('결제완료하기')], { text: '결재완료햐기' })[0]?.yaml).toBe('tapOn: "결제완료하기"')
  })

  it('leaves out what is off the screen', () => {
    const below = el('Sign in', { frame: { x: 0.1, y: 1.4, width: 0.2, height: 0.05 } })
    expect(suggestSelectors([below], { text: 'Sign inn' })).toEqual([])
  })

  it('suggests an input field by its id, never by what is typed in it', () => {
    const typed = el('jane@example.test', { role: 'input', identifier: 'email' })
    const unnamed = el('jane@example.test', { role: 'input' })
    const s = suggestSelectors([typed, unnamed], { text: 'jane@example.tes' })
    expect(s.map((x) => x.yaml)).toEqual(['tapOn: { id: "email" }'])
    expect(JSON.stringify(s)).not.toContain('jane@')
  })

  it('quotes a label with quotes, colons and a newline so the line parses back to it', () => {
    const tricky = el('Say "hi": now\nplease')
    const tree = [tricky]
    const s = suggestSelectors(tree, { text: 'Say "hi": now\nplease!' })
    expect(resolvesTo(tree, s[0]!.yaml)).toEqual([tricky])
  })

  it('offers at most three, and each taps exactly the element it names', () => {
    const tree = ['Order now', 'Order note', 'Order nod', 'Ordering', 'Order more'].map((l) => el(l))
    const s = suggestSelectors(tree, { text: 'Order no' })
    expect(s.length).toBeLessThanOrEqual(3)
    for (const x of s) {
      const hit = resolvesTo(tree, x.yaml)
      expect(hit).toHaveLength(1)
      expect(hit[0]!.label).toBe(x.element.label)
    }
  })

  it('never offers a blank label as the line, even when the element is found by its id', () => {
    const s = suggestSelectors([el('   ', { identifier: 'pay-now-btn' })], { text: 'pay-now-btn-typo' })
    expect(s.map((x) => x.yaml)).toEqual(['tapOn: { id: "pay-now-btn" }'])
  })

  it('stays fast when the selector itself is a pasted paragraph', () => {
    const tree = Array.from({ length: 70 }, (_, i) => el(`Button ${i} with some label`))
    const t0 = performance.now()
    expect(suggestSelectors(tree, { text: 'x'.repeat(500_000) })).toEqual([])
    expect(performance.now() - t0).toBeLessThan(500)
  })

  it('stays fast on a large tree', () => {
    const tree = Array.from({ length: 5000 }, (_, i) => el(`Item number ${i} with a fairly long description text`))
    const t0 = performance.now()
    suggestSelectors(tree, { text: 'Item numbr 42' })
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})
