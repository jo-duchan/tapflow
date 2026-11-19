import { describe, it, expect } from 'vitest'
import type { UIElement } from '@tapflowio/agent-core'
import { matchSelector } from '../selector'

const el = (label: string, over: Partial<UIElement> = {}): UIElement => ({
  role: 'button', label, frame: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 }, enabled: true, ...over,
})
const field = (placeholder: string, over: Partial<UIElement> = {}): UIElement =>
  el('', { role: 'input', placeholder, ...over })

describe('matchSelector — placeholder', () => {
  it('finds a field by its placeholder when nothing has that label', () => {
    const nickname = field('Nickname')
    expect(matchSelector([el('Help'), nickname], { text: 'Nickname' })).toEqual([nickname])
  })

  // Strictly additive: a selector that resolved before the field existed resolves the same way after.
  it('lets an exact label win over a placeholder', () => {
    const button = el('Email')
    expect(matchSelector([field('Email'), button], { text: 'Email' })).toEqual([button])
  })

  it('lets a partial label win over a placeholder', () => {
    const header = el('Search results', { role: 'text' })
    expect(matchSelector([field('Search'), header], { text: 'Search' })).toEqual([header])
  })

  it('lets an identifier win over a placeholder', () => {
    const byId = el('', { identifier: 'Email' })
    expect(matchSelector([field('Email'), byId], { text: 'Email' })).toEqual([byId])
  })

  it('never matches a placeholder in part', () => {
    expect(matchSelector([field('Search the catalog')], { text: 'Search' })).toEqual([])
  })

  it('leaves an explicit label selector to labels', () => {
    expect(matchSelector([field('Nickname')], { label: 'Nickname' })).toEqual([])
  })

  it('narrows placeholder matches by role and index like any other', () => {
    const a = field('Name')
    const b = field('Name')
    expect(matchSelector([a, b], { text: 'Name' })).toEqual([a, b])
    expect(matchSelector([a, b], { text: 'Name', index: 1 })).toEqual([b])
    expect(matchSelector([a, b], { text: 'Name', role: 'button' })).toEqual([])
  })
})

// 1b-3c: a value a flow checks is wrong when it is only part of what is shown.
describe('matchSelector — exact', () => {
  it('takes the whole label only, never one that contains it', () => {
    const total = el('Total $12.50')
    expect(matchSelector([total], { label: 'Total $12' })).toEqual([total])
    expect(matchSelector([total], { label: 'Total $12', exact: true })).toEqual([])
    const twelve = el('Total $12')
    expect(matchSelector([total, twelve], { label: 'Total $12', exact: true })).toEqual([twelve])
  })
})
