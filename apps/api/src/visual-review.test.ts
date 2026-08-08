import { describe, expect, it } from 'vitest'
import { normalizedVisualReview } from './visual-review.js'

describe('normalizedVisualReview', () => {
  it('normalizes page and rectangle evidence for every issue', () => {
    const result = normalizedVisualReview({
      pages: [{ page: 2, issues: [{ type: 'frame-overflow', severity: 'high', rect: [10.123, 20.456, 90.789, 100.111] }] }],
    }) as any

    expect(result.pages[0].issues[0]).toMatchObject({
      criterion: 'QC-GEO-004',
      evidence: { page: 2, rect: [10.12, 20.46, 90.79, 100.11] },
      evidenceStatus: 'valid',
      evidenceRequired: true,
    })
    expect(result.status).toBe('hard_fail')
  })

  it('marks missing and malformed evidence without inventing coordinates', () => {
    const result = normalizedVisualReview({
      pages: [{ page: 1, issues: [
        { type: 'font-readability', severity: 'minor', description: 'No rectangle supplied.' },
        { type: 'box-overflow', severity: 'high', evidence: { page: 1, rect: [10, 20, 10, 8] } },
      ] }],
    }) as any

    expect(result.pages[0].issues[0]).toMatchObject({ evidence: null, evidenceStatus: 'missing' })
    expect(result.pages[0].issues[1]).toMatchObject({ evidence: null, evidenceStatus: 'invalid' })
    expect(result.status).toBe('hard_fail')
  })
})
