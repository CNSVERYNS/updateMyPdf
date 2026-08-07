import path from 'node:path'
import crypto from 'node:crypto'

const allowedFiles = new Map([
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.txt', 'text/plain'],
])

export const SUPPORTED_EXTENSIONS = new Set(allowedFiles.keys())

export const sanitizeFileName = (value: string) => {
  const base = path.basename(String(value || 'document'))
  const normalized = base.normalize('NFKC').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\s+/g, ' ').trim()
  return (normalized || 'document').slice(0, 180)
}

export const extensionOf = (fileName: string) => path.extname(fileName).toLowerCase()

export const expectedMimeType = (fileName: string) => allowedFiles.get(extensionOf(fileName)) || null

export const detectMimeType = (bytes: Buffer, fileName: string, declaredMime = '') => {
  const extension = extensionOf(fileName)
  const expected = expectedMimeType(fileName)
  if (!expected || !SUPPORTED_EXTENSIONS.has(extension)) throw new Error('UNSUPPORTED_FILE_TYPE')
  if (declaredMime && declaredMime !== expected && !(extension === '.txt' && declaredMime === 'application/octet-stream')) throw new Error('UNSUPPORTED_FILE_TYPE')
  if (extension === '.pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF_MALFORMED')
  if (['.docx', '.pptx', '.xlsx'].includes(extension) && bytes.subarray(0, 2).toString('ascii') !== 'PK') throw new Error('UNSUPPORTED_FILE_TYPE')
  return expected
}

export const isEncryptedPdf = (bytes: Buffer) => bytes.toString('latin1').includes('/Encrypt')

export const idempotencyKey = (value: string | undefined, bytes: Buffer) => String(value || crypto.createHash('sha256').update(bytes).digest('hex')).slice(0, 180)

export const safeStorageName = (jobId: string, fileName: string) => `${jobId}/${sanitizeFileName(fileName)}`

export const hashBytes = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

export const createDownloadToken = (jobId: string, expiresAt: number, secret: string) => crypto.createHmac('sha256', secret).update(`${jobId}.${expiresAt}`).digest('hex')
export const verifyDownloadToken = (jobId: string, expiresAt: number, token: string, secret: string) => {
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !/^[a-f0-9]{64}$/i.test(token)) return false
  const expected = Buffer.from(createDownloadToken(jobId, expiresAt, secret), 'hex')
  const actual = Buffer.from(token, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}
