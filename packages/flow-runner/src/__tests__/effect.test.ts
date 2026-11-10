import { describe, it, expect } from 'vitest'
import type { UIElement } from '@tapflowio/agent-core'
import { agreedEffect, effectPending, EffectWatch, judgeEffect, observeEffect } from '../effect.js'

const el = (over: Partial<UIElement>): UIElement => ({
  role: 'text', label: '', enabled: true, frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 }, ...over,
})
const at = (y: number) => ({ x: 0.1, y, width: 0.3, height: 0.05 })

// #1125: what a touch is seen to do, written into the flow and looked for again on every run.
describe('observeEffect', () => {
  it('names a switch a tap turned on by its state, on both sides', () => {
    const off = el({ role: 'switch', identifier: 'wifi', label: 'Wi-Fi' })
    const on = { ...off, checked: true }
    expect(observeEffect([off], [on], [on])).toEqual({
      appear: [{ id: 'wifi', text: 'Wi-Fi', checked: true }],
      gone: [{ id: 'wifi', text: 'Wi-Fi', checked: false }],
    })
  })

  it('names what a navigation brought and took away by what the elements say', () => {
    const list = [el({ label: 'Orders', frame: at(0.05) }), el({ role: 'cell', label: 'Order from Kim', frame: at(0.3) })]
    const detail = [el({ label: 'Order details', frame: at(0.05) }), el({ role: 'button', label: 'Cancel order', frame: at(0.8) })]
    expect(observeEffect(list, detail, detail)).toEqual({
      appear: [{ text: 'Order details', role: 'text' }, { text: 'Cancel order', role: 'button' }],
      gone: [{ text: 'Orders', role: 'text' }, { text: 'Order from Kim', role: 'cell' }],
    })
  })

  it('never anchors on what was typed, what hides it, a keyboard key, a secret, or text that changes by itself', () => {
    const after = [
      el({ role: 'input', label: 'kim@example.com' }),
      el({ role: 'other', label: '••••', secure: true }),
      el({ role: 'button', label: 'q', rawRole: 'Key' }),
      el({ label: 'Welcome back, swordfish' }),
      el({ label: '3분 전' }),
      el({ label: 'Updated 11:42' }),
      el({ label: 'Order 48213 placed' }),
      el({ label: '5 min ago' }),
      el({ label: '2026.11.11' }),
      el({ role: 'button', identifier: '9f8e7d6c5b4a', label: 'Updated 9:05' }),
    ]
    expect(observeEffect([], after, after, { hidden: ['swordfish'] })).toBeNull()
  })

  // Sample app E2E: a row tap changed only the status label's text, `tapped:list.row.2`, and an id-only key saw nothing.
  it('anchors on an identifier and its label, so a label that changed on an element that kept its id is seen', () => {
    const before = el({ identifier: 'status', label: 'tapped:none' })
    const after = el({ identifier: 'status', label: 'tapped:list.row.2' })
    expect(observeEffect([before], [after], [after])).toEqual({
      appear: [{ id: 'status', text: 'tapped:list.row.2' }],
      gone: [{ id: 'status', text: 'tapped:none' }],
    })
  })

  it('keeps a small count, and anchors on the identifier alone when the label changes by itself', () => {
    const badge = el({ identifier: 'cart.badge', label: '3 items' })
    expect(observeEffect([], [badge], [badge])).toEqual({ appear: [{ id: 'cart.badge', text: '3 items' }] })
    const clock = el({ identifier: 'saved.at', label: 'Saved 10:42' })
    expect(observeEffect([], [clock], [clock])).toEqual({ appear: [{ id: 'saved.at' }] })
  })

  // Research for #1125: no pattern catches a small number that changes by itself ("3 online"); a second look does.
  it('drops text whose number moved between the settled read and the confirming one', () => {
    const online = (n: number) => el({ identifier: 'presence', label: `${n} online`, frame: at(0.1) })
    const saved = el({ label: 'Saved', frame: at(0.5) })
    expect(observeEffect([], [online(3), saved], [online(4), saved])).toEqual({ appear: [{ id: 'presence' }, { text: 'Saved', role: 'text' }] })
  })

  it('drops count text whose number the touch moved (e2e\'s rule), and keeps any other label that changed in a number', () => {
    const before = [el({ label: '41 items', frame: at(0.1) }), el({ identifier: 'status', label: 'tapped:row.1', frame: at(0.2) })]
    const after = [el({ label: '42 items', frame: at(0.1) }), el({ identifier: 'status', label: 'tapped:row.2', frame: at(0.2) })]
    expect(observeEffect(before, after, after)).toEqual({
      appear: [{ id: 'status', text: 'tapped:row.2' }],
      gone: [{ id: 'status', text: 'tapped:row.1' }],
    })
  })

  it('drops a bare number with no id, a duration, and a generated key (e2e\'s rules)', () => {
    const after = [el({ label: '11' }), el({ label: 'took 250ms' }), el({ label: 'ref a1b2c3d4e5f6' })]
    expect(observeEffect([], after, after)).toBeNull()
    const badge = el({ identifier: 'unread', label: '11' })
    expect(observeEffect([], [badge], [badge])).toEqual({ appear: [{ id: 'unread', text: '11' }] })
    // A minted id names nothing, so it does not save a bare number either (review of #1125).
    const minted = el({ identifier: 'a3f9c2d1e4b5', label: '3' })
    expect(observeEffect([], [minted], [minted])).toBeNull()
  })

  it('leaves out what was gone again by the confirming read, and what came back', () => {
    const spinner = el({ label: 'Loading' })
    const title = el({ label: 'Saved' })
    expect(observeEffect([], [spinner, title], [title])).toEqual({ appear: [{ text: 'Saved', role: 'text' }] })
    const save = el({ role: 'button', label: 'Save' })
    expect(observeEffect([save], [], [save])).toBeNull()
  })

  it('does not take a label that moved to another element as gone', () => {
    const before = [el({ label: 'Total', frame: at(0.2) })]
    const after = [el({ label: 'Total', frame: at(0.7) })]
    expect(observeEffect(before, after, after)).toBeNull()
  })

  it('does not count the leaving of what the touch before brought beside a change of its own', () => {
    const toast = el({ label: 'Copied' })
    const title = el({ label: 'Details' })
    const previous = { appear: [{ text: 'Copied', role: 'text' }] }
    expect(observeEffect([toast], [title], [title], { previous })).toEqual({ appear: [{ text: 'Details', role: 'text' }] })
  })

  // Sample app E2E: Close on the scrim the touch before opened saw nothing while that leaving was never counted.
  it('counts it when the touch was on what went and nothing else changed, as Close on a dialog', () => {
    const scrim = el({ identifier: 'scrim', label: 'Scrim', frame: { x: 0, y: 0.2, width: 1, height: 0.6 } })
    const close = el({ role: 'button', identifier: 'scrim.close', label: 'Close', frame: { x: 0.4, y: 0.5, width: 0.2, height: 0.05 } })
    const previous = { appear: [{ id: 'scrim', text: 'Scrim' }, { id: 'scrim.close', text: 'Close' }] }
    expect(observeEffect([scrim, close], [], [], { previous, touched: close })).toEqual({
      gone: [{ id: 'scrim.close', text: 'Close' }, { id: 'scrim', text: 'Scrim' }],
    })
  })

  // Review of #1125: a toast that went on its own clock while an unrelated touch was watched became that touch's `gone`,
  // which a replay finds already gone, so the exported flow failed every run.
  it('does not count it when the touch was elsewhere, as a toast going on its own', () => {
    const toast = el({ identifier: 'toast', label: 'Saved', frame: at(0.8) })
    const row = el({ role: 'cell', identifier: 'row', label: 'Row', frame: at(0.3) })
    expect(observeEffect([toast, row], [row], [row], { previous: { appear: [{ id: 'toast', text: 'Saved' }] }, touched: row })).toBeNull()
  })

  it('keeps at most four of each, identifiers and the upper screen first', () => {
    const after = [
      el({ label: 'Low one', frame: at(0.9) }), el({ label: 'Low two', frame: at(0.85) }),
      el({ label: 'High one', frame: at(0.1) }), el({ label: 'High two', frame: at(0.2) }),
      el({ label: 'High three', frame: at(0.3) }), el({ identifier: 'footer', label: 'Footer', frame: at(0.95) }),
    ]
    expect(observeEffect([], after, after)?.appear).toEqual([
      { id: 'footer', text: 'Footer' }, { text: 'High one', role: 'text' }, { text: 'High two', role: 'text' }, { text: 'High three', role: 'text' },
    ])
  })
})

describe('agreedEffect', () => {
  // Research for #1125: a number that changes by itself slower than one look's confirming read reads differently in two
  // looks minutes apart; what both saw is what a run can be held to.
  it('keeps what both looks saw, and nothing when they share nothing', () => {
    const match = { appear: [{ id: 'status', text: 'tapped:row.2' }, { id: 'presence', text: '3 online' }], gone: [{ id: 'status', text: 'tapped:none' }] }
    const verify = { appear: [{ id: 'status', text: 'tapped:row.2' }, { id: 'presence', text: '5 online' }], gone: [{ id: 'status', text: 'tapped:none' }] }
    expect(agreedEffect(match, verify)).toEqual({ appear: [{ id: 'status', text: 'tapped:row.2' }], gone: [{ id: 'status', text: 'tapped:none' }] })
    expect(agreedEffect({ appear: [{ id: 'a' }] }, { appear: [{ id: 'b' }] })).toBeNull()
    expect(agreedEffect(null, verify)).toBeNull()
  })
})

describe('EffectWatch', () => {
  it('remembers what a touch brought across one that changed nothing', () => {
    const watch = new EffectWatch()
    const toast = el({ identifier: 'toast', label: 'Saved', frame: at(0.8) })
    const title = el({ label: 'Done', frame: at(0.1) })
    expect(watch.observe([], [toast], [toast])).toEqual({ appear: [{ id: 'toast', text: 'Saved' }] })
    expect(watch.observe([toast], [toast], [toast])).toBeNull()
    expect(watch.observe([toast], [title], [title])).toEqual({ appear: [{ text: 'Done', role: 'text' }] })
  })
})

// Review of #1125: a toast an `imeAction` showed went while the next tap was watched, and became that tap's `gone`.
describe('EffectWatch, between touches', () => {
  it('remembers what appeared between two watched touches, so its leaving is not the second one\'s', () => {
    const watch = new EffectWatch()
    const form = el({ role: 'button', label: 'Submit', frame: at(0.5) })
    const back = el({ role: 'button', label: 'Back', frame: at(0.05) })
    const toast = el({ identifier: 'toast', label: 'Saved', frame: at(0.8) })
    const home = el({ label: 'Home', frame: at(0.2) })
    watch.observe([form], [form, back], [form, back])
    expect(watch.observe([form, back, toast], [back, home], [back, home], { touched: back })).toEqual({
      appear: [{ text: 'Home', role: 'text' }],
      gone: [{ text: 'Submit', role: 'button' }],
    })
  })
})

describe('judgeEffect / effectPending', () => {
  const effect = { appear: [{ text: 'Saved' }], gone: [{ text: 'Save', role: 'button' }] }
  const save = el({ role: 'button', label: 'Save' })
  const saved = el({ label: 'Saved' })

  it('holds when every anchor appeared and every one went', () => {
    expect(judgeEffect(effect, [saved])).toEqual({ met: true })
  })

  it('names the first anchor that did not appear, or did not go', () => {
    expect(judgeEffect(effect, [save])).toEqual({ met: false, missing: { text: 'Saved' }, kind: 'appear' })
    expect(judgeEffect(effect, [save, saved])).toEqual({ met: false, missing: { text: 'Save', role: 'button' }, kind: 'gone' })
  })

  it('says a screen that already looks like the effect leaves the touch nothing to show', () => {
    expect(effectPending(effect, [save])).toBe(true)
    expect(effectPending(effect, [saved])).toBe(false)
  })
})
