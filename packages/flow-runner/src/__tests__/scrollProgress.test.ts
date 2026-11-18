import { describe, expect, it } from 'vitest'
import type { UIElement } from '@tapflowio/agent-core'
import { changedTwice, progress, selfChange } from '../scrollProgress.js'

const el = (label: string, y: number, over: Partial<UIElement> = {}): UIElement =>
  ({ role: 'cell', label, enabled: true, frame: { x: 0, y, width: 1, height: 0.05 }, ...over })
// Scrolling down: the finger moves up, so content moves up (sign -1 on y).
const down = (before: UIElement[], after: UIElement[], volatile: UIElement['frame'][] = []) => progress(before, after, 'y', -1, volatile)

describe('progress — what one drag did to the list', () => {
  it('moved: a row both reads hold travelled the way the finger did', () => {
    expect(down([el('Row 1', 0.5), el('Row 2', 0.7)], [el('Row 2', 0.3), el('Row 3', 0.5)])).toBe('moved')
  })

  it('still: nothing changed', () => {
    expect(down([el('Row 1', 0.5)], [el('Row 1', 0.5)])).toBe('still')
  })

  // A read during a pager's snap-back, or a rubber band, sees content displaced against the finger: no progress.
  it('still: what travelled went against the finger', () => {
    expect(down([el('Page 1', 0.5)], [el('Page 1', 0.55)])).toBe('still')
  })

  // CodeRabbit on #1190: Android rows share a resource id, and a held drag moves exactly whole rows; with the label in
  // the identity the row that is still on screen is seen to travel.
  it('moved: rows sharing an identifier moved by exactly the gap between them', () => {
    const id = { identifier: 'com.app:id/title' }
    const before = [el('Row 5', 0.1, id), el('Row 6', 0.3, id), el('Row 7', 0.5, id), el('Row 8', 0.7, id)]
    const after = [el('Row 7', 0.1, id), el('Row 8', 0.3, id), el('Row 9', 0.5, id), el('Row 10', 0.7, id)]
    expect(down(before, after)).toBe('moved')
  })

  // CodeRabbit on #1190: a paged list reusing its rows and their places, every label replaced.
  it('ambiguous: content replaced in place, rows and positions reused', () => {
    const page = (n: number) => [0, 1, 2].map((i) => el(`Row ${n * 3 + i}`, 0.2 + i * 0.2, { identifier: `row.${i}` }))
    expect(down(page(0), page(1))).toBe('ambiguous')
  })

  // CodeRabbit on #1190: fixed chrome that outnumbers the rows replaced under it.
  it('ambiguous, not still: fixed chrome outnumbers the rows replaced under it', () => {
    const chrome = [el('Title', 0.02), el('Search', 0.08), el('Tab A', 0.95)]
    expect(down([...chrome, el('Row 1', 0.4)], [...chrome, el('Row 2', 0.4)])).toBe('ambiguous')
  })

  it('ambiguous until learned, then still: a countdown changes in place', () => {
    const before = [el('Page 1', 0.3), el('Ends in 9s', 0.5)]
    const after = [el('Page 1', 0.3), el('Ends in 8s', 0.5)]
    expect(down(before, after)).toBe('ambiguous')
    expect(down(before, after, [{ x: 0, y: 0.5, width: 1, height: 0.05 }])).toBe('still')
  })

  // Design review: a learned clock region overlaps a full-screen page, but does not contain it.
  it('ambiguous: a page swapped for the next is not explained by a clock it overlaps', () => {
    const clock = { x: 0, y: 0, width: 0.2, height: 0.03 }
    const photo = (n: number) => el(`Photo ${n}`, 0, { frame: { x: 0, y: 0, width: 1, height: 1 } })
    expect(down([photo(3)], [photo(4)], [clock])).toBe('ambiguous')
  })

  // Design review: one of three "2 min ago" turned "3 min ago"; a count change is a change, not a movement.
  it('ambiguous, not moved: a shared label lost one of its rows in place', () => {
    const before = [el('2 min ago', 0.2), el('2 min ago', 0.4), el('2 min ago', 0.6)]
    const after = [el('2 min ago', 0.2), el('2 min ago', 0.4), el('3 min ago', 0.6)]
    expect(down(before, after)).toBe('ambiguous')
  })

  it('ambiguous, not moved: a carousel slid across the axis of a vertical search', () => {
    const slide = (x: number) => el('Banner', 0.2, { frame: { x, y: 0.2, width: 1, height: 0.2 } })
    expect(down([slide(0), el('Row 1', 0.6)], [slide(-0.3), el('Row 1', 0.6)])).toBe('ambiguous')
  })

  // A slide moving diagonally (a carousel's transition read while it also shifted) is not the list following the finger.
  it('ambiguous, not moved: an element that travelled the finger\'s way and sideways too', () => {
    const card = (x: number, y: number) => el('Card', y, { frame: { x, y, width: 0.5, height: 0.2 } })
    expect(down([card(0.2, 0.5)], [card(-0.1, 0.4)])).toBe('ambiguous')
  })

  it('moved, horizontally: a search to the right reads x', () => {
    const card = (label: string, x: number) => el(label, 0.5, { frame: { x, y: 0.5, width: 0.3, height: 0.2 } })
    expect(progress([card('A', 0.4), card('B', 0.8)], [card('B', 0.2), card('C', 0.6)], 'x', -1, [])).toBe('moved')
  })
})

describe('selfChange and changedTwice — what changes with no gesture', () => {
  it('names the frames that changed by themselves', () => {
    expect(selfChange([el('Page 1', 0.3), el('9s', 0.5)], [el('Page 1', 0.3), el('8s', 0.5)]))
      .toEqual([{ x: 0, y: 0.5, width: 1, height: 0.05 }, { x: 0, y: 0.5, width: 1, height: 0.05 }])
  })

  it('names nothing on a screen still in motion', () => {
    expect(selfChange([el('Row 1', 0.5), el('9s', 0.9)], [el('Row 1', 0.45), el('8s', 0.9)])).toBeUndefined()
  })

  it('keeps only what changed in the same place both times', () => {
    const clock = { x: 0, y: 0.5, width: 1, height: 0.05 }
    const row = { x: 0, y: 0.7, width: 1, height: 0.05 }
    expect(changedTwice([clock, row], [clock])).toEqual([clock])
    expect(changedTwice([row], [clock])).toEqual([])
  })
})
