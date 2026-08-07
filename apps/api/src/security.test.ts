import { describe, expect, it } from 'vitest'
import { createDownloadToken, detectMimeType, extensionOf, sanitizeFileName, verifyDownloadToken } from './security.js'
import { assertTransition, canTransition } from './domain.js'
import { retryDelayMs } from './retry.js'

describe('security helpers', () => {
  it('sanitizes path traversal and unsafe characters', () => {
    expect(sanitizeFileName('../../résumé?.pdf')).toBe('résumé_.pdf')
    expect(extensionOf('contract.PDF')).toBe('.pdf')
  })
  it('checks file signatures instead of trusting a MIME header', () => {
    expect(detectMimeType(Buffer.from('%PDF-1.7\n'), 'document.pdf', 'application/pdf')).toBe('application/pdf')
    expect(() => detectMimeType(Buffer.from('not a pdf'), 'document.pdf', 'application/pdf')).toThrow('PDF_MALFORMED')
  })
  it('creates short-lived signed download tokens', () => {
    const expires = Date.now() + 60_000
    const token = createDownloadToken('job-1', expires, 'test-secret')
    expect(verifyDownloadToken('job-1', expires, token, 'test-secret')).toBe(true)
    expect(verifyDownloadToken('job-2', expires, token, 'test-secret')).toBe(false)
  })
})

describe('job state machine', () => {
  it('rejects invalid transitions', () => {
    expect(canTransition('received', 'uploaded')).toBe(false)
    expect(() => assertTransition('received', 'completed')).toThrow('Invalid job state transition')
    expect(canTransition('quality_check', 'completed_with_warnings')).toBe(true)
  })
})

describe('retry policy', () => {
  it('uses the documented backoff and honors Retry-After', () => {
    expect(retryDelayMs(0)).toBe(5000)
    expect(retryDelayMs(4)).toBe(120000)
    expect(retryDelayMs(0, '15')).toBe(15000)
  })
})
