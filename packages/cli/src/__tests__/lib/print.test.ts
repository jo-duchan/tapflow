import { describe, expect, it } from 'vitest'
import { wrap } from '../../lib/print.js'

describe('wrap', () => {
  it('returns short lines unchanged', () => {
    expect(wrap('tapflow doctor', 72)).toEqual(['tapflow doctor'])
  })

  it('wraps at word boundaries before the maximum width', () => {
    expect(wrap('Fix the issues above before running `tapflow start`.', 24)).toEqual([
      'Fix the issues above',
      'before running `tapflow',
      'start`.',
    ])
  })

  it('hard-cuts only when a single word is longer than the width', () => {
    expect(wrap('supercalifragilistic', 8)).toEqual(['supercal', 'ifragili', 'stic'])
  })
})
