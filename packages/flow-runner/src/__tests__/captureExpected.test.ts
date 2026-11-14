import { describe, it, expect } from 'vitest'
import type { UIElement } from '@tapflowio/agent-core'
import { expectedFor, flowToYaml } from '../capture/index.js'
import { parseFlow } from '../schema.js'

// 1b-3c: what a person expects a touch to bring, picked on the screen after it.
const el = (label: string, over: Partial<UIElement> = {}): UIElement => ({
  role: 'text', label, frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 }, enabled: true, ...over,
})

describe('expectedFor', () => {
  it('checks the whole label, with a lasting id beside it, and refuses no number', () => {
    expect(expectedFor(el('Total ₩32,000', { identifier: 'cart.total' }), { secrets: [] }))
      .toEqual({ selector: { id: 'cart.total', label: 'Total ₩32,000', exact: true }, warnings: [] })
    // A minted id names nothing next time: left out.
    expect(expectedFor(el('Order 1042', { identifier: '3f9a2c7e1b' }), { secrets: [] }))
      .toEqual({ selector: { label: 'Order 1042', exact: true }, warnings: [] })
  })

  it('refuses what shows typing, a secret, and an element with nothing to check', () => {
    expect(expectedFor(el('alice@x.com', { role: 'input' }), { secrets: [] })).toEqual({ refused: 'typing' })
    expect(expectedFor(el('•••', { secure: true }), { secrets: [] })).toEqual({ refused: 'typing' })
    expect(expectedFor(el('a', { rawRole: 'Key' }), { secrets: [] })).toEqual({ refused: 'typing' })
    expect(expectedFor(el('Signed in as alice@x.com'), { secrets: ['alice@x.com'] })).toEqual({ refused: 'secret' })
    expect(expectedFor(el('', { identifier: 'logo' }), { secrets: [] })).toEqual({ refused: 'unnamed' })
  })

  it('warns of an element already there before the touch, and of a time', () => {
    const header = el('Orders')
    expect(expectedFor(header, { secrets: [], before: [el('Orders')] })).toMatchObject({ warnings: ['before'] })
    expect(expectedFor(el('Updated 10:42'), { secrets: [] })).toMatchObject({ warnings: ['time'] })
    // A price is a value to check, not a time.
    expect(expectedFor(el('₩32,000'), { secrets: [] })).toMatchObject({ warnings: [] })
  })

  it('writes a selector the flow reads back exact', () => {
    const verdict = expectedFor(el('Total $12'), { secrets: [] })
    if (!('selector' in verdict)) throw new Error('refused')
    const yaml = flowToYaml({ appId: 'a', steps: [{ type: 'assertVisible', selector: verdict.selector }] } as never)
    expect(yaml).toContain('exact: true')
    expect(parseFlow(yaml, 'f.yaml').steps[0]).toEqual({ type: 'assertVisible', selector: { label: 'Total $12', exact: true } })
  })
})
