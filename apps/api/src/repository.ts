import crypto from 'node:crypto'
import { Pool } from 'pg'
import type { JobEvent, JobStatus, TranslationJob } from './domain.js'
import { assertTransition } from './domain.js'

export interface JobRepository {
  create(job: TranslationJob, idempotencyKey?: string): Promise<TranslationJob>
  get(id: string): Promise<TranslationJob | null>
  findByIdempotencyKey(key: string): Promise<TranslationJob | null>
  listActive(): Promise<TranslationJob[]>
  listExpired(now: Date): Promise<TranslationJob[]>
  update(id: string, patch: Partial<TranslationJob>): Promise<TranslationJob>
  transition(id: string, next: JobStatus, eventType: string, message: string, metadata?: Record<string, unknown>): Promise<TranslationJob>
  events(id: string): Promise<JobEvent[]>
  recordFile(input: { jobId: string; role: 'source' | 'target' | 'quarantine'; blobName: string; mimeType: string; sizeBytes: number; sha256?: string }): Promise<void>
}

const nowIso = () => new Date().toISOString()

class MemoryRepository implements JobRepository {
  private readonly jobs = new Map<string, TranslationJob>()
  private readonly keys = new Map<string, string>()
  private readonly log = new Map<string, JobEvent[]>()
  async create(job: TranslationJob, idempotencyKey?: string) {
    if (idempotencyKey && this.keys.has(idempotencyKey)) return this.jobs.get(this.keys.get(idempotencyKey)!)!
    this.jobs.set(job.id, job)
    if (idempotencyKey) this.keys.set(idempotencyKey, job.id)
    this.log.set(job.id, [])
    return job
  }
  async get(id: string) { return this.jobs.get(id) || null }
  async findByIdempotencyKey(key: string) { const id = this.keys.get(key); return id ? this.jobs.get(id) || null : null }
  async listActive() { return [...this.jobs.values()].filter((job) => !['completed', 'completed_with_warnings', 'failed', 'expired', 'deleted'].includes(job.status)) }
  async listExpired(now: Date) { return [...this.jobs.values()].filter((job) => new Date(job.expiresAt) <= now && !['expired', 'deleted'].includes(job.status)) }
  async update(id: string, patch: Partial<TranslationJob>) {
    const current = this.jobs.get(id)
    if (!current) throw new Error('JOB_NOT_FOUND')
    const next = { ...current, ...patch, updatedAt: nowIso() }
    this.jobs.set(id, next)
    return next
  }
  async transition(id: string, next: JobStatus, eventType: string, message: string, metadata = {}) {
    const current = await this.get(id)
    if (!current) throw new Error('JOB_NOT_FOUND')
    assertTransition(current.status, next)
    const updated = await this.update(id, { status: next, currentStage: next })
    const event: JobEvent = { id: crypto.randomUUID(), jobId: id, previousStatus: current.status, newStatus: next, eventType, message, metadata, createdAt: nowIso() }
    this.log.get(id)!.push(event)
    return updated
  }
  async events(id: string) { return this.log.get(id) || [] }
  async recordFile() { return undefined }
}

const toJob = (row: Record<string, any>): TranslationJob => ({
  id: row.id,
  originalFileName: row.original_file_name,
  sanitizedFileName: row.sanitized_file_name,
  sourceMimeType: row.source_mime_type,
  sourceExtension: row.source_extension,
  sourceLanguage: row.source_language,
  targetLanguage: row.target_language,
  translationMode: row.translation_mode,
  status: row.status,
  progress: row.progress,
  currentStage: row.current_stage,
  sourceBlobName: row.source_blob_name,
  targetBlobName: row.target_blob_name,
  azureOperationId: row.azure_operation_id,
  azureOperationUrl: row.azure_operation_url,
  sourceSizeBytes: Number(row.source_size_bytes),
  resultSizeBytes: row.result_size_bytes == null ? null : Number(row.result_size_bytes),
  sourcePageCount: row.source_page_count,
  resultPageCount: row.result_page_count,
  qualityScore: row.quality_score == null ? null : Number(row.quality_score),
  qualityWarnings: row.quality_warnings || [],
  qualityReport: row.quality_report || null,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  errorDetails: row.error_details,
  expiresAt: new Date(row.expires_at).toISOString(),
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
  completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
})

class PostgresRepository implements JobRepository {
  constructor(private readonly pool: Pool) {}
  async create(job: TranslationJob, idempotencyKey?: string) {
    const existing = idempotencyKey ? await this.findByIdempotencyKey(idempotencyKey) : null
    if (existing) return existing
    const metadata = idempotencyKey ? { idempotencyKey } : {}
    const { rows } = await this.pool.query(`INSERT INTO translation_jobs (id, original_file_name, sanitized_file_name, source_mime_type, source_extension, source_language, target_language, translation_mode, status, progress, current_stage, source_blob_name, target_blob_name, source_size_bytes, metadata, expires_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) RETURNING *`, [job.id, job.originalFileName, job.sanitizedFileName, job.sourceMimeType, job.sourceExtension, job.sourceLanguage, job.targetLanguage, job.translationMode, job.status, job.progress, job.currentStage, job.sourceBlobName, job.targetBlobName, job.sourceSizeBytes, metadata, job.expiresAt, job.createdAt])
    return toJob(rows[0])
  }
  async get(id: string) { const { rows } = await this.pool.query('SELECT * FROM translation_jobs WHERE id = $1', [id]); return rows[0] ? toJob(rows[0]) : null }
  async findByIdempotencyKey(key: string) { const { rows } = await this.pool.query('SELECT * FROM translation_jobs WHERE metadata->>\'idempotencyKey\' = $1', [key]); return rows[0] ? toJob(rows[0]) : null }
  async listActive() { const { rows } = await this.pool.query("SELECT * FROM translation_jobs WHERE status NOT IN ('completed','completed_with_warnings','failed','expired','deleted') ORDER BY created_at ASC"); return rows.map(toJob) }
  async listExpired(now: Date) { const { rows } = await this.pool.query("SELECT * FROM translation_jobs WHERE expires_at <= $1 AND status NOT IN ('expired','deleted')", [now]); return rows.map(toJob) }
  async update(id: string, patch: Partial<TranslationJob>) {
    const current = await this.get(id); if (!current) throw new Error('JOB_NOT_FOUND')
    const columnMap: Record<string, string> = { status: 'status', progress: 'progress', currentStage: 'current_stage', translationMode: 'translation_mode', sourceBlobName: 'source_blob_name', targetBlobName: 'target_blob_name', azureOperationId: 'azure_operation_id', azureOperationUrl: 'azure_operation_url', resultSizeBytes: 'result_size_bytes', sourcePageCount: 'source_page_count', resultPageCount: 'result_page_count', qualityScore: 'quality_score', qualityWarnings: 'quality_warnings', qualityReport: 'quality_report', errorCode: 'error_code', errorMessage: 'error_message', errorDetails: 'error_details', completedAt: 'completed_at' }
    const entries = Object.entries(patch).filter(([key]) => key in columnMap)
    if (!entries.length) return current
    const values: unknown[] = []
    const jsonColumns = new Set(['qualityWarnings', 'qualityReport', 'errorDetails'])
    const sets = entries.map(([key, value], index) => { values.push(jsonColumns.has(key) && value !== undefined ? JSON.stringify(value) : value); return `${columnMap[key]} = $${index + 1}` })
    values.push(id)
    const { rows } = await this.pool.query(`UPDATE translation_jobs SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values)
    return toJob(rows[0])
  }
  async transition(id: string, next: JobStatus, eventType: string, message: string, metadata = {}) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const currentResult = await client.query('SELECT * FROM translation_jobs WHERE id = $1 FOR UPDATE', [id])
      if (!currentResult.rows[0]) throw new Error('JOB_NOT_FOUND')
      const current = toJob(currentResult.rows[0]); assertTransition(current.status, next)
      const updateResult = await client.query('UPDATE translation_jobs SET status = $1, current_stage = $2, updated_at = now() WHERE id = $3 RETURNING *', [next, next, id])
      await client.query('INSERT INTO translation_job_events (job_id, previous_status, new_status, event_type, message, metadata) VALUES ($1,$2,$3,$4,$5,$6)', [id, current.status, next, eventType, message, metadata])
      await client.query('COMMIT')
      return toJob(updateResult.rows[0])
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async events(id: string) { const { rows } = await this.pool.query('SELECT * FROM translation_job_events WHERE job_id = $1 ORDER BY created_at ASC', [id]); return rows.map((row) => ({ id: row.id, jobId: row.job_id, previousStatus: row.previous_status, newStatus: row.new_status, eventType: row.event_type, message: row.message, metadata: row.metadata || {}, createdAt: new Date(row.created_at).toISOString() })) }
  async recordFile(input: { jobId: string; role: 'source' | 'target' | 'quarantine'; blobName: string; mimeType: string; sizeBytes: number; sha256?: string }) { await this.pool.query('INSERT INTO translation_files (job_id, role, blob_name, mime_type, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6)', [input.jobId, input.role, input.blobName, input.mimeType, input.sizeBytes, input.sha256 || null]) }
}

export const createRepository = (databaseUrl?: string): JobRepository => databaseUrl ? new PostgresRepository(new Pool({ connectionString: databaseUrl, max: 10 })) : new MemoryRepository()
