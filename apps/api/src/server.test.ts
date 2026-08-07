import { afterEach, describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { loadConfig } from './config.js'
import { buildApp } from './server.js'

const testConfig = loadConfig({ ...process.env, NODE_ENV: 'test', TRANSLATION_MOCK: 'true', SYNC_TRANSLATION_ENABLED: 'false', INTERNAL_API_SECRET: '', DOWNLOAD_LINK_SECRET: '', ADMIN_API_SECRET: 'test-admin-secret-32-chars', STORAGE_ROOT: `${process.cwd()}/.test-translation-data` })
const makePdf = async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([300, 400]); return Buffer.from(await pdf.save())
}

describe('translation API mock flow', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null
  afterEach(async () => { if (app) await app.close(); app = null })

  it('uploads, starts, polls, quality-checks and downloads a batch job', async () => {
    app = await buildApp({ config: testConfig })
    const pdf = await makePdf()
    const form = new FormData()
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'sample.pdf')
    form.append('sourceLanguage', 'auto')
    form.append('targetLanguage', 'tr')
    const upload = await app.inject({ method: 'POST', url: '/api/v1/uploads', payload: form })
    expect(upload.statusCode).toBe(201)
    const jobId = upload.json().jobId
    const start = await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/start` })
    expect(start.statusCode).toBe(200)
    const firstPoll = await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/poll` })
    expect(firstPoll.json().status).toBe('translating')
    const secondPoll = await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/poll` })
    expect(['completed', 'completed_with_warnings']).toContain(secondPoll.json().status)
    const download = await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}/download` })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-type']).toContain('application/pdf')
  })

  it('returns a safe error for a mismatched MIME/signature', async () => {
    app = await buildApp({ config: testConfig })
    const form = new FormData(); form.append('file', new Blob(['plain text'], { type: 'application/pdf' }), 'bad.pdf')
    const response = await app.inject({ method: 'POST', url: '/api/v1/uploads', payload: form })
    expect(response.statusCode).toBe(422)
    expect(response.json().error.code).toBe('PDF_MALFORMED')
  })

  it('creates a new job when the same file is uploaded again without an explicit idempotency key', async () => {
    app = await buildApp({ config: testConfig })
    const pdf = await makePdf()
    const upload = () => {
      const form = new FormData()
      form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'repeat.pdf')
      form.append('sourceLanguage', 'auto')
      form.append('targetLanguage', 'tr')
      return app!.inject({ method: 'POST', url: '/api/v1/uploads', payload: form })
    }
    const first = await upload()
    const second = await upload()
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.json().jobId).not.toBe(first.json().jobId)
  })

  it('protects and serves the first admin cost overview', async () => {
    app = await buildApp({ config: testConfig })
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/admin/overview' })
    expect(unauthorized.statusCode).toBe(401)

    const cost = await app.inject({ method: 'POST', url: '/api/v1/admin/cost-snapshots', headers: { 'x-admin-api-secret': 'test-admin-secret-32-chars' }, payload: { provider: 'azure', service: 'translator', periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z', amount: 12.5, idempotencyKey: 'test-azure-august' } })
    expect(cost.statusCode).toBe(201)
    const expense = await app.inject({ method: 'POST', url: '/api/v1/admin/expenses', headers: { 'x-admin-api-secret': 'test-admin-secret-32-chars' }, payload: { category: 'domain', vendor: 'domain.com', periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z', amount: 2 } })
    expect(expense.statusCode).toBe(201)
    const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/overview?from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z', headers: { 'x-admin-api-secret': 'test-admin-secret-32-chars' } })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().providerCosts.total).toBe(12.5)
    expect(overview.json().businessExpenses.total).toBe(2)
    expect(overview.json().reportedCostTotal).toBe(14.5)
  })
})
