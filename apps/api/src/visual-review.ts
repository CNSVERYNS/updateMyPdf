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
  outputComparison?: Record<string, unknown>
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

const criterionForIssue = (type: string): string => {
  const normalized = type.toLocaleLowerCase()
  if (normalized.includes('clip') || normalized.includes('overflow')) return 'QC-GEO-004'
  if (normalized.includes('overlap')) return 'QC-GEO-003'
  if (normalized.includes('vertical') || normalized.includes('y_axis') || normalized.includes('y-axis')) return 'QC-VIS-006'
  if (normalized.includes('horizontal') || normalized.includes('x_axis') || normalized.includes('x-axis')) return 'QC-VIS-007'
  if (normalized.includes('frame') || normalized.includes('box') || normalized.includes('padding')) return 'QC-GEO-010'
  if (normalized.includes('column') || normalized.includes('gutter')) return 'QC-GEO-025'
  if (normalized.includes('table') || normalized.includes('cell')) return 'QC-GEO-021'
  if (normalized.includes('heading') || normalized.includes('subheading')) return 'QC-TYP-014'
  if (normalized.includes('font') || normalized.includes('shrink') || normalized.includes('readab')) return 'QC-TYP-022'
  if (normalized.includes('color') || normalized.includes('colour') || normalized.includes('stroke') || normalized.includes('border')) return 'QC-COL-004'
  if (normalized.includes('image') || normalized.includes('logo') || normalized.includes('artwork')) return 'QC-VIS-014'
  if (normalized.includes('spacing') || normalized.includes('baseline')) return 'QC-TYP-011'
  if (normalized.includes('align') || normalized.includes('layout') || normalized.includes('shift')) return 'QC-GEO-001'
  return 'QC-VIS-021'
}

const numericRect = (value: unknown): [number, number, number, number] | null => {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? [
          (value as Record<string, unknown>).x0,
          (value as Record<string, unknown>).y0,
          (value as Record<string, unknown>).x1,
          (value as Record<string, unknown>).y1,
        ]
      : []
  if (values.length !== 4 || values.some((item) => typeof item !== 'number' || !Number.isFinite(item))) return null
  const rect = values as number[]
  if (rect[2] <= rect[0] || rect[3] <= rect[1]) return null
  return rect.map((item) => Math.round(item * 100) / 100) as [number, number, number, number]
}

const normalizeEvidence = (issue: Record<string, unknown>, pageFallback: unknown) => {
  const rawEvidence = issue.evidence ?? issue.rect ?? issue.bbox ?? null
  const evidenceObject = rawEvidence && typeof rawEvidence === 'object' && !Array.isArray(rawEvidence)
    ? rawEvidence as Record<string, unknown>
    : null
  const rawRect = Array.isArray(rawEvidence)
    ? rawEvidence
    : evidenceObject?.rect ?? evidenceObject?.bbox ?? evidenceObject
  const pageValue = evidenceObject?.page ?? issue.page ?? pageFallback
  const page = Number(pageValue)
  const rect = numericRect(rawRect)
  if (Number.isInteger(page) && page > 0 && rect) return { evidence: { page, rect }, evidenceStatus: 'valid' as const }
  return {
    evidence: null,
    evidenceStatus: rawEvidence == null ? 'missing' as const : 'invalid' as const,
  }
}

export const normalizedVisualReview = (parsed: Record<string, unknown> | null): Record<string, unknown> | null => {
  if (!parsed) return null
  const pages = Array.isArray(parsed.pages) ? parsed.pages : []
  const normalizedPages = pages.map((pageValue) => {
    const page = pageValue && typeof pageValue === 'object' ? pageValue as Record<string, unknown> : {}
    const issues = Array.isArray(page.issues) ? page.issues : []
    const normalizedIssues = issues.map((issueValue) => {
      const issue = issueValue && typeof issueValue === 'object' ? issueValue as Record<string, unknown> : { description: String(issueValue) }
      const type = typeof issue.type === 'string' ? issue.type : 'visual_difference'
      const requestedCriterion = typeof issue.criterion === 'string' && /^QC-[A-Z]+-\d{3}$/.test(issue.criterion) ? issue.criterion : null
      const severityValue = typeof issue.severity === 'string' ? issue.severity.toLocaleLowerCase() : ''
      const structural = /clip|overflow|overlap|missing|column|table|frame|box/i.test(type)
      const severity = ['critical', 'high', 'medium', 'minor'].includes(severityValue) ? severityValue : structural ? 'high' : 'minor'
      const evidence = normalizeEvidence(issue, page.page)
      return {
        ...issue,
        type,
        criterion: requestedCriterion || criterionForIssue(type),
        severity,
        evidence: evidence.evidence,
        evidenceStatus: evidence.evidenceStatus,
        evidenceRequired: true,
        page: issue.page ?? page.page ?? null,
      }
    })
    return { ...page, issues: normalizedIssues }
  })
  const allIssues = normalizedPages.flatMap((page) => Array.isArray(page.issues) ? page.issues as Array<Record<string, unknown>> : [])
  const hardFailure = allIssues.some((issue) => issue.severity === 'critical' || issue.severity === 'high')
  const status = hardFailure ? 'hard_fail' : allIssues.length ? 'manual_review' : 'pass'
  return { ...parsed, status, pages: normalizedPages, issues: allIssues }
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
      'Inspect these criteria independently: vertical/y-axis edge continuity, horizontal/x-axis edge continuity, frame/box borders and padding, text crossing lines, checkbox/radio labels, columns and gutters, tables/cells, heading/subheading hierarchy, font readability, colors, and missing artwork.',
      'Return JSON only with documentStrategy, confidence, pages, and issues. Each issue must include criterion (QC-* code), type, severity (critical/high/medium/minor), description, and evidence with page plus approximate rect when visible. Allowed statuses: pass, manual_review, hard_fail.',
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
  const normalized = normalizedVisualReview(parsed)
  return { status: normalized ? 'completed' : 'invalid_model_output', model: config.OPENAI_MODEL, result: normalized, strategySource: 'openai-vision' }
}

const fetchVisualProfileWithCaptures = async (config: AppConfig, bytes: Buffer): Promise<VisualProfile> => {
  const form = new FormData()
  const part = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  form.append('source', new Blob([part], { type: 'application/pdf' }), 'source.pdf')
  form.append('include_captures', 'true')
  const response = await fetch(`${config.PDF_QUALITY_SERVICE_URL.replace(/\/$/, '')}/visual-profile`, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(Math.min(config.PDF_QUALITY_REQUEST_TIMEOUT_MS, 90000)) })
  if (!response.ok) throw new Error(`visual profile service ${response.status}`)
  return await response.json() as VisualProfile
}

const runVisionComparison = async (config: AppConfig, source: VisualProfile, translated: VisualProfile, recordUsage?: (event: UsageEventInput) => Promise<unknown>): Promise<Record<string, unknown>> => {
  if (!config.AI_VISUAL_REVIEW_ENABLED || !config.OPENAI_API_KEY) return { status: 'not_configured', strategySource: 'deterministic-capture-comparison' }
  const pages = source.pages.slice(0, config.AI_VISUAL_REVIEW_MAX_PAGES).filter((page) => page.capture?.data && translated.pages.find((candidate) => candidate.page === page.page)?.capture?.data)
  if (!pages.length) return { status: 'no-captures', strategySource: 'deterministic-capture-comparison' }
  const content: Array<Record<string, string>> = [{
    type: 'input_text',
    text: [
      'You are a conservative PDF visual comparison reviewer.',
      'Compare each SOURCE page capture with its TRANSLATED page capture.',
      'Check independently: vertical/y-axis continuity, horizontal/x-axis continuity, frame/box edge continuity, inside-region padding, text-line overlap, checkbox/radio label overlap, columns and gutters, table cells, heading/subheading hierarchy, font size versus readability, line spacing, color/stroke changes, image/logo integrity, and page whole-structure preservation.',
      'Return JSON only with status, confidence, pages, and issues. Every issue must include criterion (QC-* code), type, severity (critical/high/medium/minor), description, and evidence with page plus approximate rect when visible. Use pass only when visually safe, manual_review for non-critical visible differences, and hard_fail for clipping, overlap, missing content/artwork, or unreadable output.',
      'Do not judge translation wording or invent missing text; report only visible layout and style defects.',
    ].join(' '),
  }]
  for (const page of pages) {
    const translatedPage = translated.pages.find((candidate) => candidate.page === page.page)!
    content.push({ type: 'input_text', text: `Page ${page.page}: SOURCE capture followed by TRANSLATED capture. Deterministic source strategy: ${page.strategy}.` })
    content.push({ type: 'input_image', image_url: `data:${page.capture!.mimeType};base64,${page.capture!.data}`, detail: 'high' } as unknown as Record<string, string>)
    content.push({ type: 'input_image', image_url: `data:${translatedPage.capture!.mimeType};base64,${translatedPage.capture!.data}`, detail: 'high' } as unknown as Record<string, string>)
  }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.OPENAI_MODEL, input: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(90000),
  })
  if (!response.ok) throw new Error(`OpenAI visual comparison returned ${response.status}`)
  const payload = await response.json() as Record<string, unknown>
  const modelUsage = payload.usage as Record<string, unknown> | undefined
  await recordUsage?.({ provider: 'openai', service: 'responses', eventType: 'visual_comparison', externalId: typeof payload.id === 'string' ? payload.id : null, idempotencyKey: typeof payload.id === 'string' ? `openai:${payload.id}` : undefined, inputUnits: modelUsage?.input_tokens == null ? null : Number(modelUsage.input_tokens), outputUnits: modelUsage?.output_tokens == null ? null : Number(modelUsage.output_tokens), unitName: 'tokens', metadata: { model: config.OPENAI_MODEL, comparedPages: pages.length } })
  const parsed = jsonFromModelText(modelOutputText(payload))
  const normalized = normalizedVisualReview(parsed)
  return { status: normalized ? 'completed' : 'invalid_model_output', model: config.OPENAI_MODEL, result: normalized, strategySource: 'openai-vision-source-translated-comparison' }
}

export const reviewTranslatedVisualDocument = async (config: AppConfig, sourceBytes: Buffer, translatedBytes: Buffer, recordUsage?: (event: UsageEventInput) => Promise<unknown>): Promise<Record<string, unknown>> => {
  if (!config.AI_VISUAL_REVIEW_ENABLED || !config.OPENAI_API_KEY) return { status: 'not_configured', strategySource: 'deterministic-capture-comparison' }
  try {
    const [sourceProfile, translatedProfile] = await Promise.all([
      fetchVisualProfileWithCaptures(config, sourceBytes),
      fetchVisualProfileWithCaptures(config, translatedBytes),
    ])
    return await runVisionComparison(config, sourceProfile, translatedProfile, recordUsage)
  } catch (error) {
    return { status: 'failed', strategySource: 'deterministic-capture-comparison', warning: error instanceof Error ? error.message : 'AI visual comparison failed' }
  }
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
    const response = await fetch(`${config.PDF_QUALITY_SERVICE_URL.replace(/\/$/, '')}/visual-profile`, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(Math.min(config.PDF_QUALITY_REQUEST_TIMEOUT_MS, 90000)) })
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
