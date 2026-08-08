import crypto from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import type { AppConfig } from './config.js'
import type { JobRepository } from './repository.js'
import type { TranslationJob } from './domain.js'
import type { StorageAdapter } from './storage.js'
import type { DocumentTranslator } from './translator.js'
import type { UsageRepository } from './usage.js'
import { inspectQuality, repairVisualAssets } from './quality.js'
import { profileVisualDocument, reviewTranslatedVisualDocument } from './visual-review.js'
import { assertTransition } from './domain.js'
import { hashBytes, isEncryptedPdf, safeStorageName } from './security.js'

const pageCount = async (bytes: Buffer, extension: string) => {
  if (extension !== '.pdf') return null
  if (isEncryptedPdf(bytes)) throw new Error('PDF_PASSWORD_PROTECTED')
  try { return (await PDFDocument.load(bytes)).getPageCount() } catch (error) { if (String(error).toLowerCase().includes('encrypted')) throw new Error('PDF_PASSWORD_PROTECTED'); throw new Error('PDF_MALFORMED') }
}

export class JobService {
  private readonly pollLocks = new Set<string>()
  private readonly preserveLocks = new Set<string>()
  private readonly visualProfiles = new Map<string, Record<string, unknown>>()
  constructor(private readonly config: AppConfig, private readonly repo: JobRepository, private readonly storage: StorageAdapter, private readonly translator: DocumentTranslator, private readonly usage?: UsageRepository) {}

  async create(input: { fileName: string; mimeType: string; extension: string; bytes: Buffer; sourceLanguage?: string | null; targetLanguage: string; idempotencyKey?: string }) {
    const id = crypto.randomUUID()
    const now = new Date()
    const sourceBlobName = safeStorageName(id, input.fileName)
    const targetBlobName = safeStorageName(id, `translated-${input.fileName}`)
    const job: TranslationJob = { id, originalFileName: input.fileName, sanitizedFileName: input.fileName, sourceMimeType: input.mimeType, sourceExtension: input.extension, sourceLanguage: input.sourceLanguage || null, targetLanguage: input.targetLanguage, translationMode: null, status: 'received', progress: 0, currentStage: 'received', sourceBlobName, targetBlobName, azureOperationId: null, azureOperationUrl: null, sourceSizeBytes: input.bytes.length, resultSizeBytes: null, sourcePageCount: null, resultPageCount: null, qualityScore: null, qualityWarnings: [], qualityReport: null, errorCode: null, errorMessage: null, errorDetails: null, expiresAt: new Date(now.getTime() + this.config.FILE_RETENTION_HOURS * 3600000).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), completedAt: null }
    const created = await this.repo.create(job, input.idempotencyKey)
    if (created.id !== id) return created
    try {
      await this.repo.transition(id, 'validating', 'validation_started', 'File validation started')
      const pages = await pageCount(input.bytes, input.extension)
      if (pages && pages > this.config.MAX_PDF_PAGES) throw new Error('FILE_TOO_MANY_PAGES')
      await this.storage.upload(this.config.AZURE_STORAGE_SOURCE_CONTAINER, sourceBlobName, input.bytes, input.mimeType)
      await this.repo.recordFile({ jobId: id, role: 'source', blobName: sourceBlobName, mimeType: input.mimeType, sizeBytes: input.bytes.length, sha256: hashBytes(input.bytes) })
      await this.repo.update(id, { sourcePageCount: pages })
      await this.repo.transition(id, 'uploaded', 'source_uploaded', 'Source document uploaded')
      return (await this.repo.get(id))!
    } catch (error) { await this.fail(id, error); throw error }
  }

  async start(id: string) {
    const job = await this.mustGet(id)
    if (['completed', 'completed_with_warnings'].includes(job.status)) return job
    if (job.status !== 'uploaded') throw new Error(`JOB_NOT_READY:${job.status}`)
    const usePreservePdf = this.translator.kind === 'azure' && job.sourceExtension === '.pdf'
    const useSync = this.config.SYNC_TRANSLATION_ENABLED && job.sourceSizeBytes <= this.config.SYNC_MAX_FILE_SIZE_MB * 1024 * 1024 && this.translator.kind === 'azure'
    await this.repo.update(id, { translationMode: usePreservePdf ? 'preserve_pdf' : useSync ? 'sync' : 'batch', progress: 10 })
    if (usePreservePdf) {
      await this.repo.transition(id, 'submitted', 'translation_submitted', 'Preserve-layout PDF translation submitted')
      await this.repo.update(id, { progress: 15 })
      void this.runPreservePdf(job)
      return (await this.repo.get(id))!
    }
    if (useSync) {
      await this.repo.transition(id, 'submitted', 'translation_submitted', 'Synchronous translation submitted')
      await this.repo.update(id, { progress: 15 })
      void this.runSync(job)
      return (await this.repo.get(id))!
    }
    const sourceUrl = await this.storage.createReadSas(this.config.AZURE_STORAGE_SOURCE_CONTAINER, job.sourceBlobName!, this.config.SOURCE_SAS_TTL_MINUTES)
    const targetUrl = await this.storage.createTargetSas(this.config.AZURE_STORAGE_TARGET_CONTAINER, job.targetBlobName!, this.config.TARGET_SAS_TTL_MINUTES)
    try {
      await this.repo.transition(id, 'submitted', 'translation_submitted', 'Batch translation submitted')
      const operation = await this.translator.submitBatch({ sourceUrl, targetUrl, sourceLanguage: job.sourceLanguage, targetLanguage: job.targetLanguage, sourceBlobName: job.sourceBlobName!, targetBlobName: job.targetBlobName!, sourceContainer: this.config.AZURE_STORAGE_SOURCE_CONTAINER, targetContainer: this.config.AZURE_STORAGE_TARGET_CONTAINER, mimeType: job.sourceMimeType })
      await this.repo.update(id, { azureOperationId: operation.operationId, azureOperationUrl: operation.operationUrl, progress: 15 })
      return (await this.repo.get(id))!
    } catch (error) { await this.fail(id, error); throw error }
  }

  private async runPreservePdf(job: TranslationJob) {
    if (this.preserveLocks.has(job.id)) return
    this.preserveLocks.add(job.id)
    try {
      await this.repo.transition(job.id, 'translating', 'translation_started', 'Preserve-layout PDF translation in progress')
      await this.repo.update(job.id, { progress: 22 })
      const source = await this.storage.download(this.config.AZURE_STORAGE_SOURCE_CONTAINER, job.sourceBlobName!)
      await this.repo.update(job.id, { currentStage: 'visual_review', progress: 30 })
      const visualProfile = await profileVisualDocument(this.config, source, job.sourceExtension, async (event) => { await this.usage?.record(event) })
      this.visualProfiles.set(job.id, visualProfile)
      await this.repo.update(job.id, { currentStage: 'translation_started', progress: 45 })
      const result = await this.translator.translatePdfPreservingLayout({ bytes: source, sourceLanguage: job.sourceLanguage, targetLanguage: job.targetLanguage })
      await this.repo.update(job.id, { currentStage: 'downloading', progress: 82 })
      const outputVisualComparison = await reviewTranslatedVisualDocument(this.config, source, result, async (event) => { await this.usage?.record(event) })
      this.visualProfiles.set(job.id, { ...visualProfile, outputComparison: outputVisualComparison })
      await this.storage.upload(this.config.AZURE_STORAGE_TARGET_CONTAINER, job.targetBlobName!, result, job.sourceMimeType)
      await this.repo.recordFile({ jobId: job.id, role: 'target', blobName: job.targetBlobName!, mimeType: job.sourceMimeType, sizeBytes: result.length, sha256: hashBytes(result) })
      await this.finish(job.id, source, result)
    } catch (error) { await this.fail(job.id, error)
    } finally { this.preserveLocks.delete(job.id) }
  }

  private async runSync(job: TranslationJob) {
    try {
      await this.repo.transition(job.id, 'translating', 'translation_started', 'Synchronous translation in progress')
      await this.repo.update(job.id, { progress: 35 })
      const source = await this.storage.download(this.config.AZURE_STORAGE_SOURCE_CONTAINER, job.sourceBlobName!)
      const translated = await this.translator.translateSync({ bytes: source, fileName: job.originalFileName, mimeType: job.sourceMimeType, sourceLanguage: job.sourceLanguage, targetLanguage: job.targetLanguage })
      const result = await repairVisualAssets(this.config, source, translated, job.sourceExtension)
      await this.repo.update(job.id, { currentStage: 'downloading', progress: 82 })
      await this.storage.upload(this.config.AZURE_STORAGE_TARGET_CONTAINER, job.targetBlobName!, result, job.sourceMimeType)
      await this.repo.recordFile({ jobId: job.id, role: 'target', blobName: job.targetBlobName!, mimeType: job.sourceMimeType, sizeBytes: result.length, sha256: hashBytes(result) })
      await this.finish(job.id, source, result)
    } catch (error) { await this.fail(job.id, error) }
  }

  async poll(id: string) {
    if (this.pollLocks.has(id)) return this.mustGet(id)
    this.pollLocks.add(id)
    try {
    const job = await this.mustGet(id)
    if (job.translationMode === 'preserve_pdf' && ['submitted', 'translating'].includes(job.status)) {
      void this.runPreservePdf(job)
      return job
    }
    if (!job.azureOperationId || !['submitted', 'translating'].includes(job.status)) return job
    try {
      if (job.status === 'submitted') {
        await this.repo.transition(id, 'translating', 'translation_started', 'Batch translation in progress')
        await this.repo.update(id, { progress: Math.max(job.progress, 22) })
      }
      const status = await this.translator.getStatus(job.azureOperationId)
      const providerProgress = Number(status.progress) || 0
      const translatingProgress = status.status === 'Succeeded' ? 84 : Math.max(25, providerProgress)
      await this.repo.update(id, { progress: Math.max(job.progress, translatingProgress) })
      if (status.status === 'Failed' || status.status === 'ValidationFailed' || status.status === 'Cancelled') throw Object.assign(new Error(status.errorMessage || 'Azure translation failed'), { code: status.errorCode || 'AZURE_TRANSLATION_FAILED' })
      if (status.status !== 'Succeeded') return (await this.repo.get(id))!
      await this.repo.transition(id, 'downloading', 'result_download_started', 'Translated result download started')
      await this.repo.update(id, { progress: 88 })
      const source = await this.storage.download(this.config.AZURE_STORAGE_SOURCE_CONTAINER, job.sourceBlobName!)
      const sourceUrl = await this.storage.createReadSas(this.config.AZURE_STORAGE_SOURCE_CONTAINER, job.sourceBlobName!, this.config.SOURCE_SAS_TTL_MINUTES)
      const targetUrl = await this.storage.createTargetSas(this.config.AZURE_STORAGE_TARGET_CONTAINER, job.targetBlobName!, this.config.TARGET_SAS_TTL_MINUTES)
      const translated = await this.translator.downloadResult({ sourceUrl, targetUrl, sourceLanguage: job.sourceLanguage, targetLanguage: job.targetLanguage, sourceBlobName: job.sourceBlobName!, targetBlobName: job.targetBlobName!, sourceContainer: this.config.AZURE_STORAGE_SOURCE_CONTAINER, targetContainer: this.config.AZURE_STORAGE_TARGET_CONTAINER, mimeType: job.sourceMimeType })
      const result = await repairVisualAssets(this.config, source, translated, job.sourceExtension)
      await this.repo.recordFile({ jobId: id, role: 'target', blobName: job.targetBlobName!, mimeType: job.sourceMimeType, sizeBytes: result.length, sha256: hashBytes(result) })
      await this.finish(id, source, result)
      return (await this.repo.get(id))!
    } catch (error) { await this.fail(id, error); throw error }
    } finally { this.pollLocks.delete(id) }
  }

  private async finish(id: string, source: Buffer, result: Buffer) {
    const job = await this.mustGet(id)
    if (job.status === 'translating') await this.repo.transition(id, 'downloading', 'result_download_started', 'Translated result stored')
    if ((await this.repo.get(id))?.status === 'downloading') await this.repo.transition(id, 'quality_check', 'quality_check_started', 'Quality check started')
    const quality = await inspectQuality(this.config, source, result, job.sourceExtension)
    // Translation is fail-closed: a readable-but-damaged PDF is worse than a
    // retryable error, so only a full quality-pass may become downloadable.
    const status = quality.score >= this.config.QUALITY_PASS_SCORE ? 'completed' : 'failed'
    const visualProfile = this.visualProfiles.get(id)
    const updates: Partial<TranslationJob> = { resultSizeBytes: result.length, resultPageCount: quality.resultPageCount, qualityScore: quality.score, qualityWarnings: quality.warnings, qualityReport: { ...quality.qualityLayers, visualReview: visualProfile || { status: 'not_run' } }, progress: 100, completedAt: new Date().toISOString(), ...(status === 'failed' ? { errorCode: 'QUALITY_CHECK_FAILED', errorMessage: 'Çıktı kalite kontrolünden geçemedi.' } : {}) }
    await this.repo.update(id, updates)
    this.visualProfiles.delete(id)
    await this.repo.transition(id, status, 'quality_check_completed', status === 'completed' ? 'Translation completed' : 'Quality check failed')
    try {
      await this.usage?.record({
        jobId: id,
        provider: this.translator.kind,
        service: 'document_translation',
        eventType: status === 'failed' ? 'document_translation_failed' : 'document_translation_completed',
        idempotencyKey: `${id}:document_translation`,
        inputUnits: job.sourcePageCount,
        outputUnits: quality.resultPageCount,
        unitName: 'pages',
        metadata: { status, mode: job.translationMode, sourceBytes: source.length, resultBytes: result.length, qualityScore: quality.score },
        occurredAt: new Date().toISOString(),
      })
    } catch {
      // Usage telemetry must never make an otherwise valid document unavailable.
    }
  }

  async download(id: string) { const job = await this.mustGet(id); if (!['completed', 'completed_with_warnings'].includes(job.status)) throw new Error('RESULT_NOT_READY'); const bytes = await this.storage.download(this.config.AZURE_STORAGE_TARGET_CONTAINER, job.targetBlobName!); return { job, bytes, fileName: `translated-${job.sanitizedFileName}` } }
  async expire(id: string) { const job = await this.mustGet(id); if (job.sourceBlobName) await this.storage.delete(this.config.AZURE_STORAGE_SOURCE_CONTAINER, job.sourceBlobName); if (job.targetBlobName) await this.storage.delete(this.config.AZURE_STORAGE_TARGET_CONTAINER, job.targetBlobName); if (!['expired', 'deleted'].includes(job.status)) await this.repo.transition(id, 'expired', 'retention_expired', 'Source and result files expired'); return (await this.repo.get(id))! }
  async delete(id: string) { const job = await this.mustGet(id); if (job.sourceBlobName) await this.storage.delete(this.config.AZURE_STORAGE_SOURCE_CONTAINER, job.sourceBlobName); if (job.targetBlobName) await this.storage.delete(this.config.AZURE_STORAGE_TARGET_CONTAINER, job.targetBlobName); if (job.status !== 'deleted') await this.repo.transition(id, 'deleted', 'job_deleted', 'Job and files deleted'); return (await this.repo.get(id))! }
  listActive() { return this.repo.listActive() }
  listExpired() { return this.repo.listExpired(new Date()) }
  events(id: string) { return this.repo.events(id) }
  private async mustGet(id: string) { const job = await this.repo.get(id); if (!job) throw new Error('JOB_NOT_FOUND'); return job }
  private async fail(id: string, error: unknown) { const job = await this.repo.get(id); if (!job || ['failed', 'deleted', 'expired'].includes(job.status)) return; const code = String((error as any)?.code || (error as any)?.message || 'INTERNAL_ERROR').split(':')[0]; const details = (error as any)?.details; await this.repo.update(id, { errorCode: code, errorMessage: this.userMessage(code), errorDetails: { status: (error as any)?.status || null, ...(details && typeof details === 'object' ? { details } : {}) } }); await this.repo.transition(id, 'failed', 'job_failed', this.userMessage(code), { code }) }
  private userMessage(code: string) {
    const specificMessages: Record<string, string> = {
      PDF_NO_EXTRACTABLE_TEXT: 'Bu PDF taranmış veya görüntü tabanlı; metin katmanı olmadığı için düzeni güvenli biçimde korunarak çevrilemedi.',
      PDF_PRESERVE_SERVICE_FAILED: 'PDF düzen kontrol servisine ulaşılamadı; bozuk çıktı teslim edilmedi. Lütfen tekrar deneyin.',
      PDF_TRANSLATION_QUALITY_GATE_FAILED: 'Çeviri düzen kontrolünden geçmedi; üst üste binmiş veya bozulmuş çıktı teslim edilmedi.',
    }
    if (specificMessages[code]) return specificMessages[code]
    const messages: Record<string, string> = { PDF_PASSWORD_PROTECTED: 'Bu PDF parola korumalı. Çeviri için parolasız bir kopya yükleyin.', PDF_MALFORMED: 'PDF dosyası açılamadı veya bozuk görünüyor.', FILE_TOO_MANY_PAGES: `PDF en fazla ${this.config.MAX_PDF_PAGES} sayfa olabilir.`, UNSUPPORTED_FILE_TYPE: 'Bu dosya türü desteklenmiyor.', QUALITY_CHECK_FAILED: 'Çeviri oluşturuldu ancak kalite kontrolünden geçemedi.', PDF_TRANSLATION_EMPTY_BLOCK: 'PDF çevirisinde boş metin bloğu oluştu; eksik çıktı teslim edilmedi.', PDF_TRANSLATION_INCOMPLETE: 'PDF çevirisi bazı metin bloklarını çevirmedi; eksik çıktı teslim edilmedi.', PDF_TRANSLATION_RENDER_INCOMPLETE: 'PDF çevirisi bazı metin bloklarını sayfaya yerleştiremedi; eksik çıktı teslim edilmedi.', RESULT_NOT_READY: 'Çeviri henüz hazır değil.' }; return messages[code] || 'Belge işlenirken beklenmeyen bir hata oluştu.' }
}
