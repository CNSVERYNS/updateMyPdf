import { PDFDocument } from 'pdf-lib'
import type { AppConfig } from './config.js'

export interface QualityResult {
  passed: boolean
  score: number
  warnings: string[]
  sourcePageCount: number | null
  resultPageCount: number | null
  sourcePageSizes: Array<{ width: number; height: number }>
  resultPageSizes: Array<{ width: number; height: number }>
  textCoverage: Record<string, number>
  possibleOverflowPages: number[]
  blankPages: number[]
  qualityLayers: Record<string, unknown>
}

const localPdfCheck = async (source: Buffer, result: Buffer): Promise<QualityResult> => {
  const warnings: string[] = []
  try {
    const [sourcePdf, resultPdf] = await Promise.all([PDFDocument.load(source), PDFDocument.load(result)])
    const sourcePages = sourcePdf.getPages().map((page) => { const size = page.getSize(); return { width: size.width, height: size.height } })
    const resultPages = resultPdf.getPages().map((page) => { const size = page.getSize(); return { width: size.width, height: size.height } })
    if (sourcePages.length !== resultPages.length) warnings.push(`Sayfa sayısı değişti (${sourcePages.length} → ${resultPages.length}).`)
    if (result.length < Math.max(500, source.length * 0.08)) warnings.push('Çıktı dosyası olağan dışı küçük görünüyor.')
    const score = Math.max(0, 100 - warnings.length * 25)
    return { passed: score >= 70, score, warnings, sourcePageCount: sourcePages.length, resultPageCount: resultPages.length, sourcePageSizes: sourcePages, resultPageSizes: resultPages, textCoverage: {}, possibleOverflowPages: [], blankPages: [], qualityLayers: { fileIntegrity: { score: 100 }, pageStructure: { score }, text: { score }, typography: { score: 100 }, typographyConsistency: { score: 100, status: 'not_available' }, visualAssets: { score: 100 }, layout: { score: 100 } } }
  } catch { return { passed: false, score: 0, warnings: ['Çıktı PDF olarak açılamadı.'], sourcePageCount: null, resultPageCount: null, sourcePageSizes: [], resultPageSizes: [], textCoverage: {}, possibleOverflowPages: [], blankPages: [], qualityLayers: { fileIntegrity: { score: 0, status: 'fail' } } } }
}

export const inspectQuality = async (config: AppConfig, source: Buffer, result: Buffer, extension: string): Promise<QualityResult> => {
  if (extension !== '.pdf') return { passed: true, score: 100, warnings: ['PDF kalite denetimi yalnızca PDF çıktılarında uygulanır.'], sourcePageCount: null, resultPageCount: null, sourcePageSizes: [], resultPageSizes: [], textCoverage: {}, possibleOverflowPages: [], blankPages: [], qualityLayers: { fileIntegrity: { score: 100 }, formatSpecific: { score: 100, status: 'not_applicable' } } }
  try {
    const form = new FormData()
    const sourcePart = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
    const resultPart = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer
    form.append('source', new Blob([sourcePart], { type: 'application/pdf' }), 'source.pdf')
    form.append('translated', new Blob([resultPart], { type: 'application/pdf' }), 'translated.pdf')
    const response = await fetch(`${config.PDF_QUALITY_SERVICE_URL.replace(/\/$/, '')}/inspect`, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(config.PDF_QUALITY_REQUEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`quality service ${response.status}`)
    return await response.json() as QualityResult
  } catch {
    // A local shallow check cannot replace the required font/color/capture
    // review. Keep the output unavailable until the quality service responds.
    return {
      passed: false,
      score: 0,
      warnings: ['PDF kalite kontrol servisi kullanılamıyor; doğrulanmamış çıktı teslim edilmedi.'],
      sourcePageCount: null,
      resultPageCount: null,
      sourcePageSizes: [],
      resultPageSizes: [],
      textCoverage: {},
      possibleOverflowPages: [],
      blankPages: [],
      qualityLayers: { qualityService: { score: 0, status: 'unavailable' } },
    }
  }
}

export const repairVisualAssets = async (config: AppConfig, source: Buffer, result: Buffer, extension: string): Promise<Buffer> => {
  if (extension !== '.pdf') return result
  try {
    const form = new FormData()
    const sourcePart = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer
    const resultPart = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer
    form.append('source', new Blob([sourcePart], { type: 'application/pdf' }), 'source.pdf')
    form.append('translated', new Blob([resultPart], { type: 'application/pdf' }), 'translated.pdf')
    const response = await fetch(`${config.PDF_QUALITY_SERVICE_URL.replace(/\/$/, '')}/repair-visual-assets`, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(config.PDF_QUALITY_REQUEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`quality repair service ${response.status}`)
    const repaired = Buffer.from(await response.arrayBuffer())
    return repaired.length > 0 ? repaired : result
  } catch {
    return result
  }
}
