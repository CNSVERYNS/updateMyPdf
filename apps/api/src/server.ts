import 'dotenv/config'
import crypto from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { loadConfig, type AppConfig } from './config.js'
import { createRepository, type JobRepository } from './repository.js'
import { createStorage, type StorageAdapter } from './storage.js'
import { createTranslator, type DocumentTranslator } from './translator.js'
import { JobService } from './job-service.js'
import { createDownloadToken, detectMimeType, extensionOf, idempotencyKey, sanitizeFileName, verifyDownloadToken } from './security.js'
import { JOB_STATES } from './domain.js'
import { incrementMetric, prometheusMetrics } from './metrics.js'
import { profileVisualDocument } from './visual-review.js'
import { createUsageRepository, type UsageRepository } from './usage.js'

type Runtime = { config: AppConfig; repo: JobRepository; storage: StorageAdapter; translator: DocumentTranslator; usage: UsageRepository; jobs: JobService }

const errorCode = (error: unknown) => String((error as any)?.code || (error as any)?.message || 'INTERNAL_ERROR').split(':')[0]
const statusForCode = (code: string) => ({ JOB_NOT_FOUND: 404, RESULT_NOT_READY: 409, JOB_NOT_READY: 409, UNSUPPORTED_FILE_TYPE: 415, FILE_TOO_LARGE: 413, FILE_TOO_MANY_PAGES: 413, PDF_PASSWORD_PROTECTED: 422, PDF_MALFORMED: 422, INVALID_LANGUAGE: 400, INVALID_REQUEST: 400, AZURE_AUTHENTICATION_FAILED: 502, AZURE_AUTHORIZATION_FAILED: 502, AZURE_RATE_LIMITED: 429, QUALITY_CHECK_FAILED: 422 }[code] || 500)
const userError = (code: string, error: unknown) => {
  const messages: Record<string, string> = { UNSUPPORTED_FILE_TYPE: 'Bu dosya türü desteklenmiyor. PDF veya DOCX yükleyin.', FILE_TOO_LARGE: 'Dosya boyutu izin verilen sınırı aşıyor.', INVALID_LANGUAGE: 'Kaynak veya hedef dil kodu geçersiz.', INVALID_REQUEST: 'İstek bilgileri eksik veya geçersiz.', RESULT_NOT_READY: 'Çeviri henüz hazır değil.', JOB_NOT_FOUND: 'Çeviri işi bulunamadı.', JOB_NOT_READY: 'Çeviri bu aşamada başlatılamaz.', PDF_PASSWORD_PROTECTED: 'Bu PDF parola korumalı. Çeviri için parolasız bir kopya yükleyin.', PDF_MALFORMED: 'PDF dosyası açılamadı veya bozuk görünüyor.', FILE_TOO_MANY_PAGES: 'PDF sayfa sınırını aşıyor.', QUALITY_CHECK_FAILED: 'Çıktı kalite kontrolünden geçemedi.' }
  return messages[code] || ((error as any)?.message && process.env.NODE_ENV !== 'production' ? String((error as any).message) : 'Belge işlenirken beklenmeyen bir hata oluştu.')
}

const validLanguage = (value: unknown) => {
  const item = String(value || '').trim()
  return item === 'auto' || /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(item)
}

const requireInternal = (runtime: Runtime, request: FastifyRequest) => {
  if (!runtime.config.INTERNAL_API_SECRET) {
    if (runtime.config.NODE_ENV === 'production') throw Object.assign(new Error('INTERNAL_API_NOT_CONFIGURED'), { statusCode: 503 })
    return
  }
  const provided = String(request.headers['x-internal-api-secret'] || '')
  const expected = Buffer.from(runtime.config.INTERNAL_API_SECRET)
  const actual = Buffer.from(provided)
  if (!provided || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw Object.assign(new Error('INTERNAL_API_UNAUTHORIZED'), { statusCode: 401 })
}

const requireAdmin = (runtime: Runtime, request: FastifyRequest) => {
  const configured = runtime.config.ADMIN_API_SECRET
  if (!configured) throw Object.assign(new Error('ADMIN_NOT_CONFIGURED'), { statusCode: 503 })
  const provided = String(request.headers['x-admin-api-secret'] || '')
  const expected = Buffer.from(configured)
  const actual = Buffer.from(provided)
  if (!provided || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw Object.assign(new Error('ADMIN_UNAUTHORIZED'), { statusCode: 401 })
}

const adminPeriod = (query: { from?: string; to?: string }) => {
  const now = new Date()
  const from = query.from ? new Date(query.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = query.to ? new Date(query.to) : now
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw Object.assign(new Error('INVALID_ADMIN_PERIOD'), { statusCode: 400 })
  return { from, to }
}

const textField = (value: unknown, name: string) => {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw Object.assign(new Error(`INVALID_ADMIN_${name.toUpperCase()}`), { statusCode: 400 })
  return normalized
}

const moneyField = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw Object.assign(new Error('INVALID_ADMIN_AMOUNT'), { statusCode: 400 })
  return parsed
}

const dateField = (value: unknown, name: string) => {
  const normalized = textField(value, name)
  const parsed = new Date(normalized)
  if (!Number.isFinite(parsed.getTime())) throw Object.assign(new Error(`INVALID_ADMIN_${name.toUpperCase()}`), { statusCode: 400 })
  return parsed.toISOString()
}

const periodFields = (body: Record<string, unknown>) => {
  const periodStart = dateField(body?.periodStart, 'periodStart')
  const periodEnd = dateField(body?.periodEnd, 'periodEnd')
  if (new Date(periodEnd) <= new Date(periodStart)) throw Object.assign(new Error('INVALID_ADMIN_PERIOD'), { statusCode: 400 })
  return { periodStart, periodEnd }
}

const parseUpload = async (request: FastifyRequest, runtime: Runtime) => {
  const parts = request.parts({ limits: { fileSize: runtime.config.MAX_UPLOAD_SIZE_MB * 1024 * 1024, files: 1, fields: 6 } })
  let file: { filename: string; mimetype: string; bytes: Buffer } | null = null
  const fields: Record<string, string> = {}
  try {
    for await (const part of parts) {
      if (part.type === 'file') file = { filename: part.filename, mimetype: part.mimetype, bytes: await part.toBuffer() }
      else fields[part.fieldname] = String(part.value || '')
    }
  } catch (error) {
    if ((error as any)?.code === 'FST_REQ_FILE_TOO_LARGE') throw Object.assign(new Error('FILE_TOO_LARGE'), { statusCode: 413 })
    throw error
  }
  if (!file) throw Object.assign(new Error('INVALID_REQUEST'), { statusCode: 400 })
  const fileName = sanitizeFileName(file.filename)
  const extension = extensionOf(fileName)
  const mimeType = detectMimeType(file.bytes, fileName, file.mimetype)
  const sourceLanguage = String(fields.sourceLanguage || 'auto').trim() || 'auto'
  const targetLanguage = String(fields.targetLanguage || 'tr').trim()
  if (!validLanguage(sourceLanguage) || !validLanguage(targetLanguage) || targetLanguage === 'auto') throw Object.assign(new Error('INVALID_LANGUAGE'), { statusCode: 400 })
  return { fileName, extension, mimeType, bytes: file.bytes, sourceLanguage, targetLanguage, preserveLayout: fields.preserveLayout !== 'false', requestIdempotencyKey: String(request.headers['idempotency-key'] || '').trim() || undefined }
}

const jobJson = (job: any) => ({ jobId: job.id, status: job.status, progress: job.progress, stage: job.currentStage, originalFileName: job.originalFileName, detectedMimeType: job.sourceMimeType, targetLanguage: job.targetLanguage, translationMode: job.translationMode, qualityScore: job.qualityScore, qualityWarnings: job.qualityWarnings, qualityReport: job.qualityReport, error: job.errorCode ? { code: job.errorCode, message: job.errorMessage, retryable: ['AZURE_RATE_LIMITED', 'UPLOAD_FAILED', 'RESULT_DOWNLOAD_FAILED'].includes(job.errorCode) } : null, createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt })

export const buildApp = async (options: { config?: AppConfig; repo?: JobRepository; storage?: StorageAdapter; translator?: DocumentTranslator; usage?: UsageRepository } = {}) => {
  const appConfig = options.config || loadConfig()
  const repo = options.repo || createRepository(appConfig.DATABASE_URL)
  const storage = options.storage || createStorage(appConfig)
  const translator = options.translator || createTranslator(appConfig, storage)
  const usage = options.usage || createUsageRepository(appConfig.DATABASE_URL)
  const jobs = new JobService(appConfig, repo, storage, translator, usage)
  const runtime: Runtime = { config: appConfig, repo, storage, translator, usage, jobs }
  const app = Fastify({ logger: { level: appConfig.NODE_ENV === 'development' ? 'info' : 'info', redact: ['req.headers.authorization', 'req.headers.x-internal-api-secret'] } })
  await app.register(helmet)
  await app.register(cors, { origin: appConfig.CORS_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean), credentials: false })
  await app.register(rateLimit, { max: 60, timeWindow: '1 minute' })
  await app.register(multipart)
  app.addHook('onRequest', async (request, reply) => { request.headers['x-correlation-id'] = String(request.headers['x-correlation-id'] || crypto.randomUUID()); reply.header('x-correlation-id', request.headers['x-correlation-id']) })

  app.get('/health', async () => ({ ok: true, service: 'translation-api', translationMock: runtime.translator.kind === 'mock', storage: runtime.storage.kind, timestamp: new Date().toISOString() }))
  app.get('/ready', async (_request, reply) => { if (!runtime.config.TRANSLATION_MOCK && (!runtime.config.AZURE_TRANSLATOR_ENDPOINT || !runtime.config.AZURE_TRANSLATOR_KEY)) return reply.code(503).send({ ok: false, error: 'Azure Translator is not configured.' }); if (runtime.config.NODE_ENV === 'production' && (!runtime.config.INTERNAL_API_SECRET || !runtime.config.ADMIN_API_SECRET)) return reply.code(503).send({ ok: false, error: 'Production internal/admin secrets are not configured.' }); return { ok: true, database: Boolean(runtime.config.DATABASE_URL), storage: runtime.storage.kind, translator: runtime.translator.kind, adminConfigured: Boolean(runtime.config.ADMIN_API_SECRET) } })
  app.get('/metrics', async (_request, reply) => reply.type('text/plain; version=0.0.4').send(prometheusMetrics()))

  app.post('/api/v1/usage/events', async (request, reply) => {
    try {
      requireInternal(runtime, request)
      const body = request.body as Record<string, unknown>
      const numeric = (value: unknown) => value == null || value === '' ? null : moneyField(value)
      const event = await runtime.usage.record({
        jobId: body?.jobId ? String(body.jobId) : null,
        provider: textField(body?.provider, 'provider'),
        service: textField(body?.service, 'service'),
        eventType: textField(body?.eventType, 'eventType'),
        idempotencyKey: body?.idempotencyKey ? String(body.idempotencyKey) : undefined,
        externalId: body?.externalId ? String(body.externalId) : null,
        inputUnits: numeric(body?.inputUnits),
        outputUnits: numeric(body?.outputUnits),
        unitName: body?.unitName ? String(body.unitName) : null,
        estimatedCostUsd: numeric(body?.estimatedCostUsd),
        actualCostUsd: numeric(body?.actualCostUsd),
        currency: body?.currency ? String(body.currency).toUpperCase() : 'USD',
        metadata: typeof body?.metadata === 'object' && body.metadata ? body.metadata as Record<string, unknown> : {},
        occurredAt: body?.occurredAt ? dateField(body.occurredAt, 'occurredAt') : undefined,
      })
      return reply.code(201).send({ ok: true, eventId: event.id })
    } catch (error) {
      const code = errorCode(error)
      const status = (error as any)?.statusCode || (code === 'INTERNAL_API_NOT_CONFIGURED' ? 503 : code === 'INTERNAL_API_UNAUTHORIZED' ? 401 : 400)
      return reply.code(status).send({ error: { code, message: status === 401 ? 'Internal API authentication required.' : 'Usage event is invalid or unavailable.', retryable: false } })
    }
  })

  app.get('/api/v1/admin/overview', async (request, reply) => {
    try {
      requireAdmin(runtime, request)
      const period = adminPeriod(request.query as { from?: string; to?: string })
      return reply.send(await runtime.usage.overview(period.from, period.to))
    } catch (error) {
      const code = errorCode(error)
      return reply.code((error as any)?.statusCode || (code === 'ADMIN_UNAUTHORIZED' ? 401 : 400)).send({ error: { code, message: code === 'ADMIN_NOT_CONFIGURED' ? 'Admin erişimi yapılandırılmadı.' : code === 'ADMIN_UNAUTHORIZED' ? 'Admin erişimi reddedildi.' : 'Admin isteği geçersiz.', retryable: false } })
    }
  })

  app.get('/api/v1/admin/usage-events', async (request, reply) => {
    try {
      requireAdmin(runtime, request)
      const query = request.query as { from?: string; to?: string; limit?: string }
      const period = adminPeriod(query)
      const limit = query.limit ? Number(query.limit) : 100
      return reply.send({ events: await runtime.usage.list(period.from, period.to, Number.isFinite(limit) ? limit : 100) })
    } catch (error) {
      const code = errorCode(error)
      return reply.code((error as any)?.statusCode || (code === 'ADMIN_UNAUTHORIZED' ? 401 : 400)).send({ error: { code, message: code === 'ADMIN_NOT_CONFIGURED' ? 'Admin erişimi yapılandırılmadı.' : code === 'ADMIN_UNAUTHORIZED' ? 'Admin erişimi reddedildi.' : 'Admin isteği geçersiz.', retryable: false } })
    }
  })

  app.post('/api/v1/admin/cost-snapshots', async (request, reply) => {
    try {
      requireAdmin(runtime, request)
      const body = request.body as Record<string, unknown>
      const period = periodFields(body)
      await runtime.usage.addCostSnapshot({ provider: textField(body?.provider, 'provider'), service: body?.service == null ? null : String(body.service), ...period, amount: moneyField(body?.amount), currency: body?.currency ? String(body.currency).toUpperCase() : 'USD', source: body?.source ? String(body.source) : 'manual', idempotencyKey: body?.idempotencyKey ? String(body.idempotencyKey) : undefined, metadata: typeof body?.metadata === 'object' && body.metadata ? body.metadata as Record<string, unknown> : {} })
      return reply.code(201).send({ ok: true })
    } catch (error) {
      const code = errorCode(error)
      return reply.code((error as any)?.statusCode || (code === 'ADMIN_UNAUTHORIZED' ? 401 : 400)).send({ error: { code, message: code === 'ADMIN_NOT_CONFIGURED' ? 'Admin erişimi yapılandırılmadı.' : code === 'ADMIN_UNAUTHORIZED' ? 'Admin erişimi reddedildi.' : 'Admin maliyet kaydı geçersiz.', retryable: false } })
    }
  })

  app.post('/api/v1/admin/expenses', async (request, reply) => {
    try {
      requireAdmin(runtime, request)
      const body = request.body as Record<string, unknown>
      const period = periodFields(body)
      await runtime.usage.addExpense({ category: textField(body?.category, 'category'), vendor: textField(body?.vendor, 'vendor'), ...period, amount: moneyField(body?.amount), currency: body?.currency ? String(body.currency).toUpperCase() : 'USD', recurring: Boolean(body?.recurring), note: body?.note == null ? null : String(body.note), metadata: typeof body?.metadata === 'object' && body.metadata ? body.metadata as Record<string, unknown> : {} })
      return reply.code(201).send({ ok: true })
    } catch (error) {
      const code = errorCode(error)
      return reply.code((error as any)?.statusCode || (code === 'ADMIN_UNAUTHORIZED' ? 401 : 400)).send({ error: { code, message: code === 'ADMIN_NOT_CONFIGURED' ? 'Admin erişimi yapılandırılmadı.' : code === 'ADMIN_UNAUTHORIZED' ? 'Admin erişimi reddedildi.' : 'Admin gider kaydı geçersiz.', retryable: false } })
    }
  })

  app.post('/api/v1/visual-profile', async (request, reply) => {
    try {
      const part = await request.file({ limits: { fileSize: appConfig.MAX_UPLOAD_SIZE_MB * 1024 * 1024, files: 1 } })
      if (!part) throw Object.assign(new Error('INVALID_REQUEST'), { statusCode: 400 })
      const fileName = sanitizeFileName(part.filename)
      const extension = extensionOf(fileName)
      const bytes = await part.toBuffer()
      const mimeType = detectMimeType(bytes, fileName, part.mimetype)
      if (extension !== '.pdf' || mimeType !== 'application/pdf') throw Object.assign(new Error('UNSUPPORTED_FILE_TYPE'), { statusCode: 415 })
      return reply.send(await profileVisualDocument(appConfig, bytes, extension, (event) => runtime.usage.record(event)))
    } catch (error) {
      const code = errorCode(error)
      return reply.code((error as any)?.statusCode || statusForCode(code)).send({ error: { code, message: userError(code, error), retryable: false } })
    }
  })

  app.post('/api/v1/uploads', async (request, reply) => {
    try {
      const upload = await parseUpload(request, runtime)
      const requestFingerprint = upload.requestIdempotencyKey ? Buffer.concat([Buffer.from(`${upload.sourceLanguage}|${upload.targetLanguage}|`), upload.bytes]) : undefined
      const job = await jobs.create({ fileName: upload.fileName, mimeType: upload.mimeType, extension: upload.extension, bytes: upload.bytes, sourceLanguage: upload.sourceLanguage, targetLanguage: upload.targetLanguage, idempotencyKey: requestFingerprint ? idempotencyKey(upload.requestIdempotencyKey, requestFingerprint) : undefined })
      incrementMetric('jobs_total')
      return reply.code(201).send({ jobId: job.id, status: job.status === 'uploaded' ? 'uploaded' : job.status, originalFileName: job.originalFileName, detectedMimeType: job.sourceMimeType })
    } catch (error) { const code = errorCode(error); return reply.code((error as any)?.statusCode || statusForCode(code)).send({ error: { code, message: userError(code, error), retryable: false } }) }
  })

  app.post('/api/v1/jobs/:jobId/start', async (request, reply) => { try { const job = await jobs.start(String((request.params as any).jobId)); incrementMetric('jobs_submitted_total'); return reply.send({ jobId: job.id, status: job.status, translationMode: job.translationMode }) } catch (error) { const code = errorCode(error); return reply.code(statusForCode(code)).send({ error: { code, message: userError(code, error), retryable: false } }) } })
  app.get('/api/v1/jobs/:jobId', async (request, reply) => { try { let job = await repo.get(String((request.params as any).jobId)); if (!job) throw new Error('JOB_NOT_FOUND'); if (['submitted', 'translating'].includes(job.status) && (job.azureOperationId || job.translationMode === 'preserve_pdf')) { try { job = await jobs.poll(job.id) } catch { job = (await repo.get(job.id))! } } return reply.send(jobJson(job)) } catch (error) { const code = errorCode(error); return reply.code(statusForCode(code)).send({ error: { code, message: userError(code, error), retryable: false } }) } })
  app.post('/api/v1/jobs/:jobId/poll', async (request, reply) => { try { requireInternal(runtime, request); const job = await jobs.poll(String((request.params as any).jobId)); if (job.status === 'completed' || job.status === 'completed_with_warnings') incrementMetric('jobs_completed_total'); if (job.status === 'failed') incrementMetric('jobs_failed_total'); return reply.send(jobJson(job)) } catch (error) { const code = errorCode(error); return reply.code((error as any)?.statusCode || statusForCode(code)).send({ error: { code, message: userError(code, error), retryable: false } }) } })
  app.get('/api/v1/jobs', async (request, reply) => { try { requireInternal(runtime, request); const jobsList = await jobs.listActive(); return reply.send({ jobs: jobsList.map(jobJson) }) } catch (error) { return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Internal API authentication required.', retryable: false } }) } })
  app.get('/api/v1/jobs/:jobId/events', async (request, reply) => { try { const job = await repo.get(String((request.params as any).jobId)); if (!job) throw new Error('JOB_NOT_FOUND'); return reply.send({ events: await jobs.events(job.id) }) } catch (error) { const code = errorCode(error); return reply.code(statusForCode(code)).send({ error: { code, message: userError(code, error), retryable: false } }) } })
  app.get('/api/v1/jobs/:jobId/download-link', async (request, reply) => { try { const job = await repo.get(String((request.params as any).jobId)); if (!job) throw new Error('JOB_NOT_FOUND'); if (!['completed', 'completed_with_warnings'].includes(job.status)) throw new Error('RESULT_NOT_READY'); const expiresAt = Date.now() + runtime.config.DOWNLOAD_LINK_TTL_MINUTES * 60_000; const secret = runtime.config.DOWNLOAD_LINK_SECRET || runtime.config.INTERNAL_API_SECRET; const token = secret ? createDownloadToken(job.id, expiresAt, secret) : ''; const protocol = String(request.headers['x-forwarded-proto'] || request.protocol || 'http').split(',')[0]; const url = new URL(`/api/v1/jobs/${encodeURIComponent(job.id)}/download`, `${protocol}://${request.headers.host}`); if (secret) { url.searchParams.set('expires', String(expiresAt)); url.searchParams.set('token', token) } return reply.send({ jobId: job.id, downloadUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() }) } catch (error) { const code = errorCode(error); return reply.code(statusForCode(code)).send({ error: { code, message: userError(code, error), retryable: false } }) } })
  app.get('/api/v1/jobs/:jobId/download', async (request, reply) => { try { const jobId = String((request.params as any).jobId); const secret = runtime.config.DOWNLOAD_LINK_SECRET || runtime.config.INTERNAL_API_SECRET; const query = request.query as { expires?: string; token?: string }; if (secret && !verifyDownloadToken(jobId, Number(query.expires), String(query.token || ''), secret)) return reply.code(401).send({ error: { code: 'DOWNLOAD_LINK_EXPIRED', message: 'İndirme bağlantısı geçersiz veya süresi dolmuş.', retryable: false } }); const output = await jobs.download(jobId); return reply.header('Content-Disposition', `attachment; filename="${output.fileName.replace(/"/g, '')}"`).type(output.job.sourceMimeType).send(output.bytes) } catch (error) { const code = errorCode(error); return reply.code(statusForCode(code)).send({ error: { code, message: userError(code, error), retryable: false } }) } })
  app.delete('/api/v1/jobs/:jobId', async (request, reply) => { try { const job = await jobs.delete(String((request.params as any).jobId)); return reply.send(jobJson(job)) } catch (error) { const code = errorCode(error); return reply.code(statusForCode(code)).send({ error: { code, message: userError(code, error), retryable: false } }) } })
  app.post('/api/v1/cleanup', async (request, reply) => { try { requireInternal(runtime, request); const expired = await jobs.listExpired(); const deleted = []; for (const job of expired) { await jobs.expire(job.id); deleted.push(job.id) } return reply.send({ deleted }) } catch { return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Internal API authentication required.', retryable: false } }) } })
  app.get('/api/v1/states', async () => ({ states: JOB_STATES }))
  app.setErrorHandler((error, request, reply) => { request.log.error({ event: 'request_failed', code: errorCode(error), correlationId: request.headers['x-correlation-id'] }, String((error as any)?.message || error)); return reply.code((error as any).statusCode || 500).send({ error: { code: errorCode(error), message: userError(errorCode(error), error), retryable: false } }) })
  return app
}

if (process.env.NODE_ENV !== 'test') {
  const app = await buildApp()
  const appConfig = loadConfig()
  await app.listen({ port: appConfig.API_PORT, host: appConfig.API_HOST })
}
