import type { AppConfig } from './config.js'
import type { StorageAdapter } from './storage.js'
import { isRetryableStatus } from './retry.js'

export type TranslationStatus = 'NotStarted' | 'Running' | 'Succeeded' | 'Failed' | 'Cancelled' | 'ValidationFailed'

export interface SubmitInput {
  sourceUrl: string
  targetUrl: string
  sourceLanguage?: string | null
  targetLanguage: string
  sourceBlobName: string
  targetBlobName: string
  sourceContainer: string
  targetContainer: string
  mimeType: string
}

export interface TranslatorStatus {
  status: TranslationStatus
  progress: number
  errorCode?: string
  errorMessage?: string
}

type PdfLayoutBlock = { id: string; text: string }

export interface DocumentTranslator {
  readonly kind: 'azure' | 'mock'
  translateSync(input: { bytes: Buffer; fileName: string; mimeType: string; sourceLanguage?: string | null; targetLanguage: string }): Promise<Buffer>
  translatePdfPreservingLayout(input: { bytes: Buffer; sourceLanguage?: string | null; targetLanguage: string }): Promise<Buffer>
  submitBatch(input: SubmitInput): Promise<{ operationId: string; operationUrl: string }>
  getStatus(operationId: string): Promise<TranslatorStatus>
  downloadResult(input: SubmitInput): Promise<Buffer>
}

class AzureTranslator implements DocumentTranslator {
  readonly kind = 'azure' as const
  constructor(private readonly config: AppConfig) {}

  private endpoint(pathname: string, query = {}) {
    const base = String(this.config.AZURE_TRANSLATOR_ENDPOINT || '').replace(/\/$/, '')
    const url = new URL(`${base}${pathname}`)
    url.searchParams.set('api-version', this.config.AZURE_TRANSLATOR_API_VERSION)
    for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, String(value))
    return url
  }

  private async request(url: URL, init: RequestInit = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.AZURE_REQUEST_TIMEOUT_MS)
    try {
      const headers = new Headers(init.headers)
      headers.set('Ocp-Apim-Subscription-Key', this.config.AZURE_TRANSLATOR_KEY || '')
      if (this.config.AZURE_TRANSLATOR_REGION) headers.set('Ocp-Apim-Subscription-Region', this.config.AZURE_TRANSLATOR_REGION)
      const response = await fetch(url, { ...init, headers, signal: controller.signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const error = new Error(text.slice(0, 1000) || `Azure Translator request failed (${response.status})`) as Error & { status?: number; retryable?: boolean }
        error.status = response.status
        error.retryable = isRetryableStatus(response.status)
        throw error
      }
      return response
    } finally { clearTimeout(timer) }
  }

  async translateSync(input: { bytes: Buffer; fileName: string; mimeType: string; sourceLanguage?: string | null; targetLanguage: string }) {
    const form = new FormData()
    const documentPart = input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer
    form.append('document', new Blob([documentPart], { type: input.mimeType }), input.fileName)
    const response = await this.request(this.endpoint('/translator/document:translate', { targetLanguage: input.targetLanguage, ...(input.sourceLanguage && input.sourceLanguage !== 'auto' ? { sourceLanguage: input.sourceLanguage } : {}) }), { method: 'POST', body: form })
    return Buffer.from(await response.arrayBuffer())
  }

  private async qualityServiceRequest(pathname: string, form: FormData) {
    const url = `${this.config.PDF_QUALITY_SERVICE_URL.replace(/\/$/, '')}${pathname}`
    const startedAt = Date.now()
    try {
      const response = await fetch(url, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(this.config.PDF_QUALITY_REQUEST_TIMEOUT_MS) })
      if (!response.ok) throw Object.assign(new Error(`PDF preserve service ${response.status}`), { code: 'PDF_PRESERVE_SERVICE_FAILED', status: response.status })
      return response
    } catch (error) {
      console.error(JSON.stringify({ event: 'pdf_quality_request_failed', path: pathname, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }))
      if ((error as any)?.code === 'PDF_PRESERVE_SERVICE_FAILED') throw error
      throw Object.assign(new Error('PDF preserve service unavailable'), { code: 'PDF_PRESERVE_SERVICE_FAILED', cause: error })
    }
  }

  private async translateTextBatch(texts: string[], sourceLanguage: string | null | undefined, targetLanguage: string) {
    const url = new URL(`${String(this.config.AZURE_TRANSLATOR_ENDPOINT || '').replace(/\/$/, '')}/translator/text/v3.0/translate`)
    url.searchParams.set('api-version', '3.0')
    url.searchParams.set('to', targetLanguage)
    if (sourceLanguage && sourceLanguage !== 'auto') url.searchParams.set('from', sourceLanguage)
    const response = await this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(texts.map((Text) => ({ Text }))) })
    const data = await response.json() as Array<{ translations?: Array<{ text?: string }> }>
    return data.map((item) => item.translations?.[0]?.text || '')
  }

  async translatePdfPreservingLayout(input: { bytes: Buffer; sourceLanguage?: string | null; targetLanguage: string }) {
    const documentPart = input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer
    const extractForm = new FormData()
    extractForm.append('source', new Blob([documentPart], { type: 'application/pdf' }), 'source.pdf')
    const extracted = await this.qualityServiceRequest('/extract-layout', extractForm)
    const blocks = (await extracted.json() as { blocks?: PdfLayoutBlock[] }).blocks || []
    if (!blocks.length) throw new Error('PDF_NO_EXTRACTABLE_TEXT')
    const translations: Array<{ id: string; text: string }> = []
    let unchangedSubstantiveBlocks = 0
    for (let offset = 0; offset < blocks.length;) {
      const batch: PdfLayoutBlock[] = []
      let chars = 0
      while (offset < blocks.length && batch.length < 25) {
        const block = blocks[offset]
        const nextChars = chars + block.text.length
        if (batch.length > 0 && nextChars > 5000) break
        batch.push(block)
        chars = nextChars
        offset += 1
      }
      if (!batch.length) throw new Error('PDF text block exceeds Azure Text Translation limit')
      const translated = await this.translateTextBatch(batch.map((block) => block.text), input.sourceLanguage, input.targetLanguage)
      batch.forEach((block, index) => {
        const text = String(translated[index] || '').trim()
        if (!text) throw new Error('PDF_TRANSLATION_EMPTY_BLOCK')
        const sourceComparable = block.text.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
        const resultComparable = text.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
        const substantive = block.text.replace(/[^\p{L}\p{N}]+/gu, '').length >= 24 && block.text.trim().split(/\s+/).length >= 5
        if (substantive && sourceComparable === resultComparable) unchangedSubstantiveBlocks += 1
        translations.push({ id: block.id, text })
      })
    }
    if (unchangedSubstantiveBlocks > Math.max(3, Math.ceil(blocks.length * 0.25))) throw new Error('PDF_TRANSLATION_INCOMPLETE')
    const renderForm = new FormData()
    renderForm.append('source', new Blob([documentPart], { type: 'application/pdf' }), 'source.pdf')
    renderForm.append('translations', JSON.stringify(translations))
    const rendered = await this.qualityServiceRequest('/render-preserved-layout', renderForm)
    let renderDetails: { missingBlocks?: number; failedBlocks?: number; selectedQualityScore?: number; qualityGatePassed?: boolean } = {}
    try { renderDetails = JSON.parse(rendered.headers.get('x-render-preserved-layout') || '{}') } catch {}
    if ((renderDetails.missingBlocks || 0) > 0 || (renderDetails.failedBlocks || 0) > 0) throw new Error('PDF_TRANSLATION_RENDER_INCOMPLETE')
    if (renderDetails.qualityGatePassed !== true || Number(renderDetails.selectedQualityScore || 0) < this.config.QUALITY_PASS_SCORE) throw new Error('PDF_TRANSLATION_QUALITY_GATE_FAILED')
    return Buffer.from(await rendered.arrayBuffer())
  }

  async submitBatch(input: SubmitInput) {
    const translateTextWithinImage = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'].includes(input.mimeType)
    const payload = {
      inputs: [{
        storageType: 'File',
        source: { sourceUrl: input.sourceUrl, storageSource: 'AzureBlob', ...(input.sourceLanguage && input.sourceLanguage !== 'auto' ? { language: input.sourceLanguage } : {}) },
        targets: [{ targetUrl: input.targetUrl, storageSource: 'AzureBlob', category: 'general', language: input.targetLanguage }],
        ...(translateTextWithinImage ? { translateTextWithinImage: true } : {}),
      }],
    }
    const response = await this.request(this.endpoint('/translator/document/batches'), { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) })
    const operationUrl = response.headers.get('operation-location') || response.headers.get('operation-location'.toLowerCase())
    const operationId = operationUrl?.match(/\/batches\/([^?]+)/i)?.[1] || operationUrl?.match(/\/document\/([^?]+)/i)?.[1]
    if (!operationId) throw new Error('Azure did not return an operation ID')
    return { operationId, operationUrl: operationUrl || this.endpoint(`/translator/document/batches/${operationId}`).toString() }
  }

  async getStatus(operationId: string) {
    const response = await this.request(this.endpoint(`/translator/document/batches/${encodeURIComponent(operationId)}`))
    const data = await response.json() as any
    const summary = data?.summary || data
    const total = Number(summary?.total || summary?.totalDocuments || 1)
    const succeeded = Number(summary?.succeeded || summary?.success || 0)
    const failed = Number(summary?.failed || 0)
    const status = String(data?.status || summary?.status || 'Running') as TranslationStatus
    return { status, progress: status === 'Succeeded' ? 100 : status === 'Failed' || status === 'ValidationFailed' ? 0 : Math.min(95, Math.round((succeeded / Math.max(total, 1)) * 100)), ...(failed ? { errorCode: 'AZURE_TRANSLATION_FAILED', errorMessage: `${failed} document(s) failed` } : {}) }
  }

  async downloadResult(input: SubmitInput) {
    const response = await fetch(input.targetUrl)
    if (!response.ok) { const error = new Error(`Azure result download failed (${response.status}`) as Error & { status?: number }; error.status = response.status; throw error }
    return Buffer.from(await response.arrayBuffer())
  }
}

class MockTranslator implements DocumentTranslator {
  readonly kind = 'mock' as const
  private readonly jobs = new Map<string, { calls: number; input: SubmitInput }>()
  constructor(private readonly storage: StorageAdapter) {}
  async translateSync(input: { bytes: Buffer }) { return Buffer.from(input.bytes) }
  async translatePdfPreservingLayout(input: { bytes: Buffer }) { return Buffer.from(input.bytes) }
  async submitBatch(input: SubmitInput) { const operationId = `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`; this.jobs.set(operationId, { calls: 0, input }); return { operationId, operationUrl: `mock://${operationId}` } }
  async getStatus(operationId: string) {
    const job = this.jobs.get(operationId); if (!job) return { status: 'Failed' as const, progress: 0, errorCode: 'AZURE_TRANSLATION_FAILED', errorMessage: 'Mock operation not found' }
    job.calls += 1
    if (job.calls < 2) return { status: 'Running' as const, progress: 45 }
    const source = await this.storage.download(job.input.sourceContainer, job.input.sourceBlobName)
    await this.storage.upload(job.input.targetContainer, job.input.targetBlobName, source, job.input.mimeType)
    return { status: 'Succeeded' as const, progress: 100 }
  }
  downloadResult(input: SubmitInput) { return this.storage.download(input.targetContainer, input.targetBlobName) }
}

export const createTranslator = (appConfig: AppConfig, storage: StorageAdapter): DocumentTranslator => appConfig.TRANSLATION_MOCK || !appConfig.AZURE_TRANSLATOR_ENDPOINT || !appConfig.AZURE_TRANSLATOR_KEY ? new MockTranslator(storage) : new AzureTranslator(appConfig)
