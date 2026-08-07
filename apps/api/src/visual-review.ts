import type { AppConfig } from './config.js'
import type { UsageEventInput } from './usage.js'

type VisualPage = {
  page: number
  strategy?: string
  issues?: Array<Record<string, unknown>>
  capture?: { mimeType: string; data: string; scale?: number; width?: number; height?: number }
  [key: string]: unknown
}

export type VisualProfile = {
  engine: string
  documentStrategy: string
  pageCount: number
  pages: VisualPage[]
  issueCount: number
  captureIncluded?: boolean
  aiReview?: Record<string, unknown>
  [key: string]: unknown
}

const jsonFromModelText = (value: string): Record<string, unknown> | null => {
  const cleaned = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1))
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
}

const modelOutputText = (response: any) => {
  if (typeof response?.output_text === 'string') return response.output_text
  return (response?.output || [])
    .flatMap((item: any) => item?.content || [])
    .map((content: any) => content?.text || '')
    .filter(Boolean)
    .join('\n')
}

const stripCaptures = (profile: VisualProfile): VisualProfile => ({
  ...profile,
  captureIncluded: false,
  pages: profile.pages.map(({ capture: _capture, ...page }) => page),
})

const runVisionReview = async (config: AppConfig, profile: VisualProfile, recordUsage?: (event: UsageEventInput) => Promise<unknown>): Promise<Record<string, unknown>> => {
  if (!config.AI_VISUAL_REVIEW_ENABLED || !config.OPENAI_API_KEY) return { status: 'not_configured', strategySource: 'deterministic-preflight' }
  const pages = profile.pages.slice(0, config.AI_VISUAL_REVIEW_MAX_PAGES).filter((page) => page.capture?.data)
  if (!pages.length) return { status: 'no-captures', strategySource: 'deterministic-preflight' }
  const content: Array<Record<string, string>> = [{
    type: 'input_text',
    text: [
      'You are a conservative PDF visual-layout reviewer.',
      'Inspect each page image for orphan bullets, sentences beginning in the middle of a line, clipped text, overlaps, unreadable font shrinkage, broken columns, and missing artwork.',
      'Return JSON only with documentStrategy, confidence, pages, and issues. Allowed strategies: preserve_canvas, reflow_text_columns, ocr_first, block_replace, manual_review.',
      'Do not invent missing text. If uncertain, use manual_review.',
    ].join(' '),
  }]
  for (const page of pages) {
    content.push({ type: 'input_text', text: `Page ${page.page}; deterministic strategy: ${page.strategy}; deterministic issues: ${JSON.stringify(page.issues || [])}` })
    content.push({ type: 'input_image', image_url: `data:${page.capture!.mimeType};base64,${page.capture!.data}`, detail: 'high' } as unknown as Record<string, string>)
  }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.OPENAI_MODEL, input: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(90000),
  })
  if (!response.ok) throw new Error(`OpenAI visual review returned ${response.status}`)
  const payload = await response.json() as Record<string, unknown>
  const modelUsage = payload.usage as Record<string, unknown> | undefined
  await recordUsage?.({ provider: 'openai', service: 'responses', eventType: 'visual_review', externalId: typeof payload.id === 'string' ? payload.id : null, idempotencyKey: typeof payload.id === 'string' ? `openai:${payload.id}` : undefined, inputUnits: modelUsage?.input_tokens == null ? null : Number(modelUsage.input_tokens), outputUnits: modelUsage?.output_tokens == null ? null : Number(modelUsage.output_tokens), unitName: 'tokens', metadata: { model: config.OPENAI_MODEL, reviewedPages: pages.length } })
  const parsed = jsonFromModelText(modelOutputText(payload))
  return { status: parsed ? 'completed' : 'invalid_model_output', model: config.OPENAI_MODEL, result: parsed, strategySource: 'openai-vision' }
}

export const profileVisualDocument = async (config: AppConfig, bytes: Buffer, extension: string, recordUsage?: (event: UsageEventInput) => Promise<unknown>): Promise<VisualProfile> => {
  if (extension !== '.pdf') {
    return { engine: 'not-applicable', documentStrategy: 'preserve_canvas', pageCount: 0, pages: [], issueCount: 0, aiReview: { status: 'not-applicable' } }
  }
  const form = new FormData()
  const sourcePart = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  form.append('source', new Blob([sourcePart], { type: 'application/pdf' }), 'source.pdf')
  form.append('include_captures', config.AI_VISUAL_REVIEW_ENABLED && Boolean(config.OPENAI_API_KEY) ? 'true' : 'false')
  let profile: VisualProfile
  try {
    const response = await fetch(`${config.PDF_QUALITY_SERVICE_URL.replace(/\/$/, '')}/visual-profile`, { method: 'POST', body: form, signal: AbortSignal.timeout(Math.min(config.AZURE_REQUEST_TIMEOUT_MS, 90000)) })
    if (!response.ok) throw new Error(`visual profile service ${response.status}`)
    profile = await response.json() as VisualProfile
  } catch {
    return { engine: 'unavailable', documentStrategy: 'manual_review', pageCount: 0, pages: [], issueCount: 0, aiReview: { status: 'preflight-unavailable' } }
  }
  try {
    const aiReview = await runVisionReview(config, profile, recordUsage)
    return { ...stripCaptures(profile), aiReview }
  } catch (error) {
    return { ...stripCaptures(profile), aiReview: { status: 'failed', strategySource: 'deterministic-preflight', warning: error instanceof Error ? error.message : 'AI visual review failed' } }
  }
}
