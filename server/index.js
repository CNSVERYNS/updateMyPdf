import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import OpenAI from 'openai'
import { Document, HeadingLevel, PageBreak, Paragraph, Packer } from 'docx'
import ExcelJS from 'exceljs'
import PptxGenJS from 'pptxgenjs'
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib'
import { createClient } from '@supabase/supabase-js'
import { applyEditPlan } from './pdf-editor.js'
import { getCapabilitySummary } from './capabilities.js'
import { getEmailStatus, sendResendEmail } from './email.js'
import { comparePdfBuffers, extractTextPages } from './pdf-text.js'
import { ocrPdfBuffer, renderPdfPages } from './pdf-render.js'
import { getExternalToolStatus, getGhostscriptResources, runExternalTool, withTempDirectory } from './external-tools.js'

const app = express()
app.set('trust proxy', true)
const port = Number(process.env.PORT || 8787)
const normalizeOrigin = (value) => String(value || '').trim().replace(/\/$/, '')
const publicAppOrigin = normalizeOrigin(process.env.PUBLIC_APP_ORIGIN || String(process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(',')[0]) || 'http://localhost:5173'
const allowedFrontendOrigins = String(process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
})

const getSupabaseAdmin = () => {
  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) throw new Error('Supabase server credentials are missing.')
  return createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

const getSupabaseUser = async (request) => {
  const authorization = request.headers.authorization || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!token) {
    const error = new Error('Authentication required.')
    error.status = 401
    throw error
  }
  const admin = getSupabaseAdmin()
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) {
    const authError = new Error('Authentication token is invalid or expired.')
    authError.status = 401
    throw authError
  }
  return { admin, user: data.user }
}

const requireAuth = (request, response, next) => {
  getSupabaseUser(request)
    .then((context) => {
      request.supabaseContext = context
      next()
    })
    .catch((error) => {
      response.status(error.status || 401).json({ error: error.message || 'Authentication required.' })
    })
}

const guestAiUsage = new Map()
const guestAiWindowMs = 24 * 60 * 60 * 1000
const guestAiGuard = (request, response, next) => {
  if (request.headers.authorization?.startsWith('Bearer ')) return next()
  const clientKey = request.ip || request.headers['x-forwarded-for'] || 'anonymous'
  const now = Date.now()
  const current = guestAiUsage.get(clientKey)
  if (current && now - current.startedAt < guestAiWindowMs && current.count >= 1) {
    return response.status(429).json({ error: 'İlk ücretsiz AI önizlemeni kullandın. Devam etmek için hesap oluştur.' })
  }
  if (!current || now - current.startedAt >= guestAiWindowMs) guestAiUsage.set(clientKey, { startedAt: now, count: 1 })
  else current.count += 1
  return next()
}

const safeFileName = (value) => String(value || 'document.pdf')
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 120) || 'document.pdf'

const escapeHtml = (value) => String(value || '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;')

const hashAccessToken = (token) => createHash('sha256').update(String(token || '')).digest('hex')

const normalizeSignaturePlacement = (value) => {
  const source = value && typeof value === 'object' ? value : {}
  const clamp = (number, min, max) => Math.min(max, Math.max(min, Number.isFinite(number) ? number : min))
  return {
    page: Math.max(1, Math.floor(Number(source.page) || 1)),
    left: clamp(Number(source.left), 0.02, 0.9),
    top: clamp(Number(source.top), 0.02, 0.9),
    width: clamp(Number(source.width), 0.1, 0.8),
    height: clamp(Number(source.height), 0.06, 0.3),
  }
}

const addAuditEvent = async (admin, event) => {
  const { error } = await admin.from('pdf_audit_events').insert({
    owner_id: event.ownerId || null,
    request_id: event.requestId || null,
    event_type: event.eventType,
    actor_email: event.actorEmail || null,
    details: event.details || {},
  })
  if (error) throw error
}

const signatureRequestError = (error) => error?.code === 'PGRST205' || error?.code === '42P01' || String(error?.message || '').includes('signature_requests') || String(error?.message || '').includes('pdf_audit_events')

const runQpdfTransform = async (pdfBuffer, buildArguments) => withTempDirectory(async (directory) => {
  const input = path.join(directory, 'input.pdf')
  const output = path.join(directory, 'output.pdf')
  writeFileSync(input, pdfBuffer)
  await runExternalTool('qpdf', buildArguments(input, output), { timeout: 240000 })
  return readFileSync(output)
})

const compressPdfBuffer = (pdfBuffer) => runQpdfTransform(pdfBuffer, (input, output) => [
  '--stream-data=compress',
  '--object-streams=generate',
  '--compress-streams=y',
  '--compression-level=9',
  input,
  output,
])

const protectPdfBuffer = (pdfBuffer, password, permissions = []) => runQpdfTransform(pdfBuffer, (input, output) => {
  const allowed = new Set((Array.isArray(permissions) ? permissions : []).map((permission) => String(permission).toLowerCase()))
  const ownerPassword = String(password || '')
  const permissionFlags = [
    `--print=${allowed.has('print') ? 'full' : 'none'}`,
    `--modify=${allowed.has('modify') ? 'all' : 'none'}`,
    `--extract=${allowed.has('copy') ? 'y' : 'n'}`,
    `--annotate=${allowed.has('annotate') ? 'y' : 'n'}`,
    `--form=${allowed.has('form') ? 'y' : 'n'}`,
    `--assemble=${allowed.has('assemble') ? 'y' : 'n'}`,
    '--accessibility=y',
  ]
  return ['--encrypt', ownerPassword, ownerPassword, '256', ...permissionFlags, '--', input, output]
})

const decryptPdfBuffer = (pdfBuffer, password) => runQpdfTransform(pdfBuffer, (input, output) => [
  `--password=${String(password || '')}`,
  '--decrypt',
  input,
  output,
])

const runGhostscriptTransform = async (pdfBuffer, buildArguments) => withTempDirectory(async (directory) => {
  const input = path.join(directory, 'input.pdf')
  const output = path.join(directory, 'output.pdf')
  writeFileSync(input, pdfBuffer)
  await runExternalTool('ghostscript', buildArguments({ directory, input, output }), { timeout: 300000 })
  return readFileSync(output)
})

const writeGhostscriptDefinition = (directory, sourcePath, profileToken, profilePath) => {
  const definition = readFileSync(sourcePath, 'utf8')
    .replace(profileToken, `(${profilePath.replaceAll('\\', '/')})`)
  const target = path.join(directory, path.basename(sourcePath))
  writeFileSync(target, definition, 'ascii')
  return target
}

const convertPdfToPdfa = (pdfBuffer) => runGhostscriptTransform(pdfBuffer, ({ directory, input, output }) => {
  const resources = getGhostscriptResources()
  if (!resources || !existsSync(resources.pdfaDefinition) || !existsSync(resources.pdfaProfile)) {
    const error = new Error('Ghostscript PDF/A resources are missing.')
    error.code = 'TOOL_MISSING'
    throw error
  }
  const definition = writeGhostscriptDefinition(directory, resources.pdfaDefinition, '(srgb.icc)', resources.pdfaProfile)
  return [
    '-dSAFER',
    `--permit-file-read=${resources.pdfaProfile.replaceAll('\\', '/')}`,
    '-dBATCH',
    '-dNOPAUSE',
    '-dPDFA=2',
    '-dPDFACompatibilityPolicy=1',
    '-sDEVICE=pdfwrite',
    '-sColorConversionStrategy=RGB',
    '-sProcessColorModel=DeviceRGB',
    '-dCompatibilityLevel=1.7',
    `-sOutputFile=${output}`,
    `-I${directory}`,
    definition,
    input,
  ]
})

const prepareForPrint = (pdfBuffer) => runGhostscriptTransform(pdfBuffer, ({ input, output }) => [
  '-dSAFER',
  '-dBATCH',
  '-dNOPAUSE',
  '-sDEVICE=pdfwrite',
  '-dPDFSETTINGS=/prepress',
  '-dEmbedAllFonts=true',
  '-dSubsetFonts=true',
  '-dDetectDuplicateImages=true',
  '-dCompressFonts=true',
  '-dCompatibilityLevel=1.7',
  `-sOutputFile=${output}`,
  input,
])

const preflightPdf = (pdfBuffer) => withTempDirectory(async (directory) => {
  const input = path.join(directory, 'input.pdf')
  writeFileSync(input, pdfBuffer)
  const report = {
    syntax: { valid: false, message: '' },
    renderer: { valid: false, message: '' },
    pdfx: { valid: false, message: '' },
  }
  try {
    const result = await runExternalTool('qpdf', ['--check', input], { timeout: 120000 })
    report.syntax = { valid: true, message: `${result.stdout || ''}${result.stderr || ''}`.trim() || 'qpdf syntax check passed.' }
  } catch (error) {
    report.syntax = { valid: false, message: `${error.stdout || ''}${error.stderr || error.message || ''}`.trim() }
  }
  try {
    const result = await runExternalTool('ghostscript', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=nullpage', input], { timeout: 180000 })
    report.renderer = { valid: true, message: `${result.stdout || ''}${result.stderr || ''}`.trim() || 'Ghostscript renderer check passed.' }
  } catch (error) {
    report.renderer = { valid: false, message: `${error.stdout || ''}${error.stderr || error.message || ''}`.trim() }
  }
  const qdf = path.join(directory, 'input-qdf.pdf')
  try {
    await runExternalTool('qpdf', ['--qdf', '--object-streams=disable', input, qdf], { timeout: 120000 })
    const serialized = readFileSync(qdf, 'latin1')
    const hasPdfxVersion = serialized.includes('/GTS_PDFXVersion')
    const hasOutputIntent = serialized.includes('/OutputIntents') || serialized.includes('/GTS_PDFX')
    report.pdfx = {
      valid: hasPdfxVersion && hasOutputIntent,
      message: hasPdfxVersion && hasOutputIntent
        ? 'PDF/X identifier and output intent found.'
        : 'PDF/X identifier or output intent was not found; this file is marked as a general PDF.',
    }
  } catch (scanError) {
    report.pdfx = { valid: false, message: scanError?.message || 'PDF/X metadata scan failed.' }
  }
  return report
})

const exportOfficeBuffer = async (pdfBuffer, format) => {
  const pages = await extractTextPages(pdfBuffer)
  if (format === 'docx') {
    const children = []
    pages.forEach((page, pageIndex) => {
      children.push(new Paragraph({ text: `PDF Page ${page.page}`, heading: HeadingLevel.HEADING_1 }))
      for (const line of (page.text || '').split(/\s{2,}|\r?\n/).map((value) => value.trim()).filter(Boolean)) children.push(new Paragraph({ text: line }))
      if (pageIndex < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }))
    })
    const document = new Document({ sections: [{ children }] })
    return Buffer.from(await Packer.toBuffer(document))
  }
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'updateMyPDF'
    for (const page of pages) {
      const worksheet = workbook.addWorksheet(`Page ${page.page}`)
      worksheet.columns = [{ header: 'Page', key: 'page', width: 10 }, { header: 'Text', key: 'text', width: 120 }]
      for (const line of (page.text || '').split(/\s{2,}|\r?\n/).map((value) => value.trim()).filter(Boolean)) worksheet.addRow({ page: page.page, text: line })
      worksheet.getRow(1).font = { bold: true }
      worksheet.getColumn('text').alignment = { wrapText: true, vertical: 'top' }
    }
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }
  if (format === 'pptx') {
    const presentation = new PptxGenJS()
    presentation.layout = 'LAYOUT_WIDE'
    presentation.author = 'updateMyPDF'
    for (const page of pages) {
      const slide = presentation.addSlide()
      slide.addText(`PDF Page ${page.page}`, { x: 0.55, y: 0.35, w: 12, h: 0.4, fontSize: 22, bold: true, color: '182238' })
      slide.addText((page.text || '').slice(0, 9000), { x: 0.6, y: 1, w: 12, h: 5.8, fontSize: 14, color: '333333', breakLine: false, valign: 'top', fit: 'shrink' })
    }
    return Buffer.from(await presentation.write({ outputType: 'nodebuffer' }))
  }
  throw new Error(`Unsupported Office format: ${format}`)
}

const createPortfolioBuffer = async (files) => {
  const portfolio = await PDFDocument.create()
  portfolio.setTitle('updateMyPDF Portfolio')
  portfolio.setAuthor('updateMyPDF')
  const font = await portfolio.embedFont(StandardFonts.Helvetica)
  const page = portfolio.addPage([612, 792])
  page.drawText('PDF Portfolio', { x: 48, y: 720, size: 28, font, color: rgb(0.08, 0.13, 0.25) })
  page.drawText(`${files.length} attached file${files.length === 1 ? '' : 's'}`, { x: 48, y: 686, size: 13, font, color: rgb(0.28, 0.32, 0.4) })
  let y = 640
  for (const [index, file] of files.entries()) {
    const name = safeFileName(file.originalname || `document-${index + 1}.pdf`)
    await portfolio.attach(new Uint8Array(file.buffer), name, {
      mimeType: file.mimetype || 'application/pdf',
      description: `Portfolio attachment ${index + 1}: ${name}`,
      creationDate: new Date(),
      modificationDate: new Date(),
    })
    page.drawText(`${index + 1}. ${name}`, { x: 60, y, size: 12, font, color: rgb(0.12, 0.16, 0.24) })
    y -= 22
    if (y < 60 && index < files.length - 1) break
  }
  portfolio.catalog.set(PDFName.of('Collection'), portfolio.context.obj({ Type: PDFName.of('Collection') }))
  return Buffer.from(await portfolio.save({ useObjectStreams: true, addDefaultPage: false }))
}

const createAudioOverview = async (client, pdfBuffer) => {
  const pages = await extractTextPages(pdfBuffer)
  const sourceText = pages.map((page) => `Sayfa ${page.page}: ${page.text || ''}`).join('\n').slice(0, 3600)
  const input = `Bu PDF için kısa ve anlaşılır bir sesli özet oku. Belge metni:\n${sourceText}`
  const model = process.env.OPENAI_TTS_MODEL || 'tts-1'
  const speechOptions = {
    model,
    voice: process.env.OPENAI_TTS_VOICE || 'alloy',
    input: input.slice(0, 4096),
    response_format: 'mp3',
  }
  if (!['tts-1', 'tts-1-hd'].includes(model)) speechOptions.instructions = 'Speak clearly and naturally in Turkish. Keep the overview concise.'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45000)
  try {
    const speech = await client.audio.speech.create(speechOptions, { signal: controller.signal, timeout: 45000 })
    return Buffer.from(await speech.arrayBuffer())
  } finally {
    clearTimeout(timeout)
  }
}

const applyExternalPdfActions = async (pdfBuffer, actions) => {
  let outputBytes = pdfBuffer
  const appliedActions = []
  const warnings = []
  for (const action of actions) {
    if (action.type === 'compress_pdf') {
      const originalBytes = outputBytes.length
      outputBytes = await compressPdfBuffer(outputBytes)
      appliedActions.push({ type: action.type, applied: true, originalBytes, outputBytes: outputBytes.length, mode: 'qpdf-lossless' })
    }
    if (action.type === 'password_protect' || action.type === 'set_permissions') {
      if (!action.password) {
        appliedActions.push({ type: action.type, applied: false })
        warnings.push('PDF güvenliği için bir şifre gerekli.')
        continue
      }
      outputBytes = await protectPdfBuffer(outputBytes, action.password, action.permissions || [])
      appliedActions.push({ type: action.type, applied: true, permissions: action.permissions || [] })
    }
    if (action.type === 'pdfa_convert') {
      const originalBytes = outputBytes.length
      outputBytes = await convertPdfToPdfa(outputBytes)
      appliedActions.push({ type: action.type, applied: true, originalBytes, outputBytes: outputBytes.length, mode: 'ghostscript-pdfa-2b' })
    }
    if (action.type === 'print_production') {
      const originalBytes = outputBytes.length
      outputBytes = await prepareForPrint(outputBytes)
      appliedActions.push({ type: action.type, applied: true, originalBytes, outputBytes: outputBytes.length, mode: 'ghostscript-prepress' })
    }
    if (action.type === 'pdfx_preflight') {
      const report = await preflightPdf(outputBytes)
      const passed = report.syntax.valid && report.renderer.valid && report.pdfx.valid
      appliedActions.push({ type: action.type, applied: true, preflight: report })
      warnings.push(`PDF/X-4 ön kontrolü: ${passed ? 'sözdizimi, render ve PDF/X işaretleri başarılı.' : 'dosyada düzeltilmesi gereken noktalar bulundu.'}`)
    }
  }
  return { pdfBytes: outputBytes, appliedActions, warnings }
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedFrontendOrigins.includes(normalizeOrigin(origin))) return callback(null, true)
    return callback(new Error('This frontend origin is not allowed.'))
  },
}))
app.use(express.json({ limit: '1mb' }))

const getClient = () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing. Add it to the local .env file.')
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

const editPlanSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    assistantMessage: { type: 'string' },
    summary: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: {
            type: 'string',
            enum: ['highlight', 'underline', 'style_text', 'strikethrough', 'squiggly', 'redact', 'ocr_scan', 'set_title', 'edit_metadata', 'remove_hidden_data', 'delete_page', 'rotate_page', 'reorder_pages', 'duplicate_page', 'add_text', 'add_image', 'resize_image', 'replace_image', 'set_alt_text', 'add_link', 'delete_text', 'replace_text', 'rewrite_text', 'insert_blank_page', 'crop_page', 'resize_page', 'extract_pages', 'flatten_form', 'flatten_pdf', 'add_text_field', 'add_checkbox', 'add_dropdown', 'add_radio', 'add_signature_field', 'fill_field', 'detect_form_fields', 'export_form_data', 'measure', 'accessibility_check', 'tag_pdf', 'reading_order', 'watermark', 'header_footer', 'bates_numbering', 'sticky_note', 'comment', 'freehand', 'shape', 'stamp', 'add_signature', 'fill_and_sign', 'optimize_pdf', 'compress_pdf', 'password_protect', 'remove_password', 'set_permissions', 'pdfa_convert', 'pdfx_preflight', 'print_production', 'portfolio', 'audio_overview', 'export_word', 'export_excel', 'export_powerpoint', 'extract_data', 'extract_table', 'document_citations', 'summarize', 'translate', 'none'],
          },
          page: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          replacement: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          angle: { anyOf: [{ type: 'integer', enum: [90, 180, 270] }, { type: 'null' }] },
          title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          author: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          subject: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          keywords: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
          color: { anyOf: [{ type: 'string', enum: ['red', 'green', 'blue', 'black', 'yellow'] }, { type: 'null' }] },
          fontFamily: { anyOf: [{ type: 'string', enum: ['helvetica', 'times', 'courier'] }, { type: 'null' }] },
          fontWeight: { anyOf: [{ type: 'string', enum: ['normal', 'bold'] }, { type: 'null' }] },
          fontStyle: { anyOf: [{ type: 'string', enum: ['normal', 'italic'] }, { type: 'null' }] },
          align: { anyOf: [{ type: 'string', enum: ['left', 'center', 'right'] }, { type: 'null' }] },
          opacity: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          x: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          y: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          size: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          targetPage: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          pages: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }] },
          width: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          height: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          imageIndex: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          fieldName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          fieldType: { anyOf: [{ type: 'string', enum: ['text', 'checkbox', 'dropdown', 'radio'] }, { type: 'null' }] },
          value: { anyOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'null' }] },
          options: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
          language: { anyOf: [{ type: 'string', enum: ['eng', 'tur'] }, { type: 'null' }] },
          position: { anyOf: [{ type: 'string', enum: ['top', 'bottom', 'center'] }, { type: 'null' }] },
          script: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          password: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          permissions: { anyOf: [{ type: 'array', items: { type: 'string', enum: ['print', 'modify', 'copy', 'annotate', 'form', 'assemble'] } }, { type: 'null' }] },
          format: { anyOf: [{ type: 'string', enum: ['docx', 'xlsx', 'pptx'] }, { type: 'null' }] },
        },
        required: ['type', 'page', 'text', 'replacement', 'url', 'angle', 'title', 'author', 'subject', 'keywords', 'color', 'fontFamily', 'fontWeight', 'fontStyle', 'align', 'opacity', 'x', 'y', 'size', 'targetPage', 'pages', 'width', 'height', 'imageIndex', 'fieldName', 'fieldType', 'value', 'options', 'language', 'position', 'script', 'password', 'permissions', 'format'],
      },
    },
  },
  required: ['assistantMessage', 'summary', 'actions'],
}

const capabilityGuidance = getCapabilitySummary().capabilities
  .map((capability) => `${capability.id}: ${capability.status}`)
  .join(', ')

const systemInstructions = `You are the command planner for updateMyPDF, an AI PDF editor.
Understand the user's request in Turkish or English and return ONLY the requested JSON schema.
Do not claim that a PDF was edited. You are creating a safe, reviewable edit plan.
Use this capability registry as the source of truth: ${capabilityGuidance}
Only create executable edit actions for capabilities marked implemented. For planned or external capabilities, use type none and explain that the feature is not available in the local editor yet.
Use one or more actions from the allowed enum. Use page numbers starting at 1.
For highlight, include the exact text to find in the text field.
For underline, include the exact sentence to find in the text field and set color to red.
For style_text, include the exact existing text in the text field and the requested color in color. Use fontFamily helvetica, times, or courier; fontWeight normal or bold; fontStyle normal or italic; size for point size; and align left, center, or right when requested. Do not ask for a replacement value when the user only asks to change color or style.
For highlight, include the exact text in text and use yellow as color unless another color is requested.
For strikethrough or squiggly, include the exact text in text.
For delete_text, include the exact text to remove in text.
For add_text, include the new text in text and page/x/y when the user gives a location; otherwise use page 1 and null coordinates.
For insert_blank_page, use page as the insertion position and width/height when provided.
For crop_page, use page, x, y, width, and height in PDF points.
For resize_page, use page when one page is named, otherwise apply to all pages; use width and height in PDF points.
For extract_pages, put the requested 1-based page numbers in pages.
For reorder_pages, put the desired 1-based page order in pages.
For duplicate_page, use page for the source and targetPage for the insertion position.
For add_text_field, add_checkbox, or add_dropdown, include fieldName, page, x, y, width, height, and options when needed.
For add_radio, include fieldName, page, x, y, width, height, options, and value when needed.
For add_signature_field, include fieldName, page, x, y, width, and height; this creates an interactive unsigned signature field, not a certificate signature.
For fill_field, include fieldName, fieldType, and value.
For detect_form_fields or export_form_data, use page null and do not invent field values.
For measure, use page null unless one page is named.
For accessibility_check, use page null and return the document report without claiming that problems were fixed.
For tag_pdf, use language tur or eng when given and explain that basic language/marked metadata was applied; do not claim a full semantic structure tree was generated.
For javascript_action, only use it when the user explicitly asks to add PDF JavaScript. Put the JavaScript source in script, use fieldName as a short function name, and do not claim it runs in every viewer.
For redact, include the exact sensitive text in text and never claim it is safe unless the redaction was applied.
For ocr_scan, use language eng or tur.
For set_title, put the requested PDF title in the title field. When the user asks to change the PDF title, also add a replace_text action for the matching visible heading if one can be identified in the document, so both metadata and visible text are updated.
For edit_metadata, include author, subject, and/or keywords when requested.
For remove_hidden_data, remove metadata and hidden document information; do not claim that embedded JavaScript or attachments were removed unless the executor reports it.
For replace_text, put the original text in text and the new text in replacement.
For rewrite_text, put the exact original sentence in text and the rewritten sentence in replacement; do not invent a replacement when the source sentence is not identifiable.
For translate, put the exact source text in text and the translated text in replacement; use language to identify eng or tur. For a whole document, create one replacement action per identifiable text block only when safe.
For add_link, use url and optionally exact visible text in text; otherwise use page/x/y/width/height.
For add_text, put the text to add in text and use size, fontFamily, fontWeight, fontStyle, and align when requested.
For add_image, use the attached PNG/JPEG image and put page/x/y/width/height/opacity when the user gives placement or size.
For replace_image, use the attached PNG/JPEG image, page, and imageIndex when the target embedded image is identified; default to the first embedded image on the requested page.
For set_alt_text, use the exact accessibility description in text, page, and imageIndex; this writes basic alternate-text metadata on the selected embedded image.
For resize_image, require the attached PNG/JPEG plus page, x, y, width, and height; this places the uploaded image at those dimensions. Do not claim that an existing image was removed unless replace_image is used.
For watermark, use the watermark text in text and apply it to all pages unless a page is specified.
For header_footer, use text, position top or bottom, and page when specified.
For bates_numbering, use text as the short prefix and add numbering to every page unless a page is specified.
For sticky_note, comment, stamp, or add_signature, use text plus page/x/y/width/height when the user provides a location.
For fill_and_sign, use the signature text in text and page/x/y/size for the visible signature.
For shape or freehand, use page/x/y/width/height to describe the requested visual mark.
For optimize_pdf, preserve all visible content and rewrite the PDF with object streams when the user asks to optimize or clean up the file. Describe this as lossless optimization; do not promise aggressive file-size compression.
For compress_pdf, use qpdf-based lossless stream/object compression. Do not promise that every PDF becomes smaller.
For password_protect, use password from the user only; never repeat it in assistantMessage. Use permissions for any explicitly allowed operations; default to protected printing/copying/editing.
For remove_password, use password from the user only and never repeat it in assistantMessage.
For set_permissions, use password and permissions; never repeat the password.
For pdfa_convert, convert the PDF to PDF/A-2b using the local Ghostscript worker and report that it is a standards-oriented conversion, not a legal guarantee of archival conformance.
For pdfx_preflight, run the local syntax, renderer, and PDF/X-4 conversion checks and report the result; do not claim that the source was modified.
For print_production, prepare a prepress-oriented PDF with embedded/subset fonts and Ghostscript's /prepress settings; do not promise printer-specific color proofing.
For portfolio, wrap the current edited PDF as a PDF portfolio attachment when the user asks to create a portfolio; explain that additional files require the portfolio endpoint.
For audio_overview, create a concise Turkish spoken overview from the document text; do not claim that audio was made until the server returns the audio output.
For reading_order, use pages when a page order is explicitly requested and explain that basic Tabs/reading-order metadata was applied, not a full semantic structure tree.
For export_word, export_excel, or export_powerpoint, set format to docx, xlsx, or pptx. These exports preserve extracted text and page grouping, not perfect original PDF layout.
For extract_data, use text as the requested data type or field description and return the extracted result without inventing values.
For extract_table, use text for an optional table description and return rows/cells found in the PDF without inventing values.
For document_citations, use text as the user's question or topic and return page-numbered evidence snippets; cite pages in assistantMessage when answering document questions.
For summarize or translate, use an action with page null unless the user explicitly names a page.
If the request is unclear or cannot be represented safely, use type none and explain what is missing in assistantMessage.
Keep assistantMessage concise and in the user's language.`

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    emailConfigured: getEmailStatus().configured,
    emailFrom: getEmailStatus().from,
    tools: getExternalToolStatus(),
  })
})

app.get('/api/tools', (_request, response) => {
  response.json(getExternalToolStatus())
})

app.get('/api/storage/files', async (request, response) => {
  try {
    const { admin, user } = await getSupabaseUser(request)
    const { data: files, error } = await admin.storage.from('pdfs').list(user.id, {
      limit: 100,
      sortBy: { column: 'created_at', order: 'desc' },
    })
    if (error) throw error
    const entries = await Promise.all((files || []).filter((file) => file.name !== '.emptyFolderPlaceholder').map(async (file) => {
      const path = `${user.id}/${file.name}`
      const signed = await admin.storage.from('pdfs').createSignedUrl(path, 3600)
      return {
        name: file.name,
        path,
        size: file.metadata?.size || 0,
        createdAt: file.created_at,
        signedUrl: signed.data?.signedUrl || null,
      }
    }))
    response.json({ files: entries })
  } catch (error) {
    console.error('[storage-list]', error?.message || error)
    response.status(error?.status || 500).json({ error: error?.status === 401 ? error.message : 'Cloud dosyaları listelenemedi.' })
  }
})

app.post('/api/storage/upload', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Yüklenecek PDF gerekli.' })
  if (request.file.mimetype !== 'application/pdf') return response.status(400).json({ error: 'Yalnızca PDF yüklenebilir.' })
  try {
    const { admin, user } = await getSupabaseUser(request)
    const path = `${user.id}/${Date.now()}-${safeFileName(request.file.originalname)}`
    const { error } = await admin.storage.from('pdfs').upload(path, request.file.buffer, {
      contentType: 'application/pdf',
      upsert: false,
    })
    if (error) throw error
    const signed = await admin.storage.from('pdfs').createSignedUrl(path, 3600)
    response.json({
      path,
      name: request.file.originalname,
      size: request.file.size,
      signedUrl: signed.data?.signedUrl || null,
    })
  } catch (error) {
    console.error('[storage-upload]', error?.message || error)
    response.status(error?.status || 500).json({ error: error?.status === 401 ? error.message : 'PDF cloud’a yüklenemedi.' })
  }
})

app.delete('/api/storage/files', async (request, response) => {
  const path = String(request.body?.path || '')
  try {
    const { admin, user } = await getSupabaseUser(request)
    if (!path.startsWith(`${user.id}/`)) return response.status(403).json({ error: 'Bu dosyaya erişim iznin yok.' })
    const { error } = await admin.storage.from('pdfs').remove([path])
    if (error) throw error
    response.json({ ok: true, path })
  } catch (error) {
    console.error('[storage-delete]', error?.message || error)
    response.status(error?.status || 500).json({ error: error?.status === 401 ? error.message : 'Cloud dosyası silinemedi.' })
  }
})

app.post('/api/storage/share', async (request, response) => {
  const path = String(request.body?.path || '')
  const requestedExpiry = Number(request.body?.expiresIn || 86400)
  const expiresIn = Math.min(Math.max(Number.isFinite(requestedExpiry) ? requestedExpiry : 86400, 300), 604800)
  try {
    const { admin, user } = await getSupabaseUser(request)
    if (!path.startsWith(`${user.id}/`)) return response.status(403).json({ error: 'Bu dosyaya eriÅŸim iznin yok.' })
    const signed = await admin.storage.from('pdfs').createSignedUrl(path, expiresIn)
    if (signed.error || !signed.data?.signedUrl) throw signed.error || new Error('Signed URL could not be created.')
    response.json({ path, signedUrl: signed.data.signedUrl, expiresIn })
  } catch (error) {
    console.error('[storage-share]', error?.message || error)
    response.status(error?.status || 500).json({ error: error?.status === 401 ? error.message : 'PaylaÅŸÄ±m baÄŸlantÄ±sÄ± oluÅŸturulamadÄ±.' })
  }
})

app.post('/api/signatures/request', async (request, response) => {
  try {
    const { admin, user } = await getSupabaseUser(request)
    const documentPath = String(request.body?.documentPath || request.body?.path || '')
    const recipientEmail = String(request.body?.recipientEmail || '').trim().toLowerCase()
    const recipientName = String(request.body?.recipientName || '').trim().slice(0, 160)
    const senderName = String(user.user_metadata?.full_name || user.email || '').trim().slice(0, 160)
    const documentName = safeFileName(request.body?.documentName || 'document.pdf')
    const message = String(request.body?.message || '').trim().slice(0, 2000)
    const workflowType = request.body?.workflowType === 'review' ? 'review' : 'signature'
    const signaturePlacement = normalizeSignaturePlacement(request.body?.signaturePlacement)
    const requestedExpiry = Number(request.body?.expiresIn || 604800)
    const expiresIn = Math.min(Math.max(Number.isFinite(requestedExpiry) ? requestedExpiry : 604800, 3600), 2592000)
    if (!documentPath.startsWith(`${user.id}/`)) return response.status(403).json({ error: 'Bu PDF için imza isteği oluşturma iznin yok.' })
    if (!recipientEmail || !recipientEmail.includes('@')) return response.status(400).json({ error: 'Geçerli bir alıcı e-posta adresi gerekli.' })
    if (!recipientName) return response.status(400).json({ error: 'Alıcının adı gerekli.' })
    const signedSource = await admin.storage.from('pdfs').createSignedUrl(documentPath, 3600)
    if (signedSource.error || !signedSource.data?.signedUrl) return response.status(404).json({ error: 'İmza istenen PDF cloud storage içinde bulunamadı.' })

    const rawToken = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
    const { data: inserted, error: insertError } = await admin.from('signature_requests').insert({
      owner_id: user.id,
      document_path: documentPath,
      document_name: documentName,
      workflow_type: workflowType,
      recipient_email: recipientEmail,
      recipient_name: recipientName || null,
      message: message || null,
      token_hash: hashAccessToken(rawToken),
      expires_at: expiresAt,
      metadata: { senderName, senderEmail: user.email, signaturePlacement },
    }).select('id').single()
    if (insertError) throw insertError

    const reviewUrl = `${publicAppOrigin}/review/${rawToken}`
    const title = workflowType === 'review' ? 'PDF review request' : 'PDF signature request'
    const greeting = `Hello ${escapeHtml(recipientName)},`
    const bodyText = message ? `<p>${escapeHtml(message)}</p>` : ''
    const emailResult = await sendResendEmail({
      to: recipientEmail,
      subject: `${title}: ${documentName}`,
      replyTo: process.env.EMAIL_FROM,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#182238"><p>${greeting}</p>${bodyText}<p><strong>${escapeHtml(senderName)}</strong> asked you to ${workflowType === 'review' ? 'review' : 'sign'} <strong>${escapeHtml(documentName)}</strong>.</p><p><a href="${escapeHtml(reviewUrl)}" style="display:inline-block;padding:12px 18px;background:#536dff;color:#fff;text-decoration:none;border-radius:8px">Open PDF</a></p><p>This link expires on ${escapeHtml(expiresAt)}.</p></div>`,
      text: `${greeting.replaceAll('&lt;', '<').replaceAll('&gt;', '>')}\n\n${senderName} asked you to ${workflowType === 'review' ? 'review' : 'sign'} ${documentName}.\n${message}\n\nOpen PDF: ${reviewUrl}\nExpires: ${expiresAt}`,
    })
    await admin.from('signature_requests').update({ sent_at: new Date().toISOString() }).eq('id', inserted.id)
    await addAuditEvent(admin, { ownerId: user.id, requestId: inserted.id, eventType: 'request_created', actorEmail: user.email, details: { workflowType, recipientEmail, documentName } })
    await addAuditEvent(admin, { ownerId: user.id, requestId: inserted.id, eventType: 'email_sent', actorEmail: user.email, details: { provider: 'resend', providerMessageId: emailResult.id || null } })
    response.json({ id: inserted.id, status: 'pending', workflowType, expiresAt, reviewUrl, emailId: emailResult.id || null })
  } catch (error) {
    console.error('[signature-request]', error?.message || error)
    const status = error?.status || (signatureRequestError(error) ? 503 : error?.code === 'EMAIL_PROVIDER_ERROR' ? 502 : 500)
    const message = signatureRequestError(error)
      ? 'İmza tablosu henüz Supabase içinde oluşturulmamış. Migration SQL dosyasını çalıştır.'
      : error?.code === 'EMAIL_NOT_CONFIGURED'
        ? 'Resend e-posta ayarları eksik.'
        : error?.code === 'EMAIL_PROVIDER_ERROR'
          ? 'Resend e-posta gönderimini reddetti; domain ve sender ayarlarını kontrol et.'
          : 'İmza isteği oluşturulamadı.'
    response.status(status).json({ error: message })
  }
})

app.get('/api/signatures', async (request, response) => {
  try {
    const { admin, user } = await getSupabaseUser(request)
    const { data, error } = await admin.from('signature_requests').select('id,document_name,workflow_type,recipient_email,recipient_name,status,expires_at,created_at,sent_at,viewed_at,signed_at,message,metadata').eq('owner_id', user.id).order('created_at', { ascending: false })
    if (error) throw error
    const requests = await Promise.all((data || []).map(async (item) => {
      const signedDocumentPath = item.metadata?.signedDocumentPath || null
      const signed = signedDocumentPath ? await admin.storage.from('pdfs').createSignedUrl(signedDocumentPath, 3600) : null
      return { ...item, signedDocumentUrl: signed?.data?.signedUrl || null }
    }))
    response.json({ requests })
  } catch (error) {
    console.error('[signature-list]', error?.message || error)
    response.status(signatureRequestError(error) ? 503 : error?.status || 500).json({ error: signatureRequestError(error) ? 'İmza tablosu henüz Supabase içinde oluşturulmamış.' : 'İmza istekleri listelenemedi.' })
  }
})

app.get('/api/signatures/:token', async (request, response) => {
  try {
    const admin = getSupabaseAdmin()
    const { data, error } = await admin.from('signature_requests').select('id,owner_id,document_path,document_name,workflow_type,recipient_email,recipient_name,message,status,expires_at,created_at,viewed_at,signed_at,metadata').eq('token_hash', hashAccessToken(request.params.token)).maybeSingle()
    if (error) throw error
    if (!data) return response.status(404).json({ error: 'İmza bağlantısı bulunamadı veya geçersiz.' })
    if (new Date(data.expires_at).getTime() <= Date.now() && !['signed', 'declined', 'cancelled'].includes(data.status)) {
      await admin.from('signature_requests').update({ status: 'expired' }).eq('id', data.id)
      return response.status(410).json({ error: 'İmza bağlantısının süresi dolmuş.' })
    }
    if (data.status === 'pending') {
      await admin.from('signature_requests').update({ status: 'viewed', viewed_at: new Date().toISOString() }).eq('id', data.id)
      await addAuditEvent(admin, { ownerId: data.owner_id, requestId: data.id, eventType: 'request_viewed', actorEmail: data.recipient_email, details: { ip: request.ip || null, userAgent: request.headers['user-agent'] || null } })
      data.status = 'viewed'
    }
    const signed = await admin.storage.from('pdfs').createSignedUrl(data.document_path, 3600)
    if (signed.error || !signed.data?.signedUrl) return response.status(404).json({ error: 'İmzalanacak PDF artık erişilebilir değil.' })
    response.json({ request: { id: data.id, documentName: data.document_name, workflowType: data.workflow_type, senderName: data.metadata?.senderName || null, recipientName: data.recipient_name, message: data.message, status: data.status, expiresAt: data.expires_at, createdAt: data.created_at, signedAt: data.signed_at, signedUrl: signed.data.signedUrl } })
  } catch (error) {
    console.error('[signature-view]', error?.message || error)
    response.status(signatureRequestError(error) ? 503 : 500).json({ error: signatureRequestError(error) ? 'İmza tablosu henüz Supabase içinde oluşturulmamış.' : 'İmza bağlantısı açılamadı.' })
  }
})

app.post('/api/signatures/:token/sign', async (request, response) => {
  let signatureStage = 'lookup'
  try {
    const admin = getSupabaseAdmin()
    const signatureText = String(request.body?.signatureText || '').trim().slice(0, 500)
    if (!signatureText) return response.status(400).json({ error: 'İmza metni gerekli.' })
    const { data, error } = await admin.from('signature_requests').select('id,owner_id,recipient_email,recipient_name,document_path,document_name,workflow_type,status,expires_at,metadata').eq('token_hash', hashAccessToken(request.params.token)).maybeSingle()
    if (error) throw error
    if (!data) return response.status(404).json({ error: 'İmza bağlantısı bulunamadı.' })
    if (new Date(data.expires_at).getTime() <= Date.now()) return response.status(410).json({ error: 'İmza bağlantısının süresi dolmuş.' })
    if (['signed', 'declined', 'cancelled'].includes(data.status)) return response.status(409).json({ error: 'Bu imza isteği artık değiştirilemez.' })
    signatureStage = 'download-source'
    const sourceDownload = await admin.storage.from('pdfs').download(data.document_path)
    if (sourceDownload.error || !sourceDownload.data) throw sourceDownload.error || new Error('Source PDF could not be downloaded.')
    const sourceBuffer = Buffer.from(await sourceDownload.data.arrayBuffer())
    signatureStage = 'render-signature'
    const sourcePdf = await PDFDocument.load(sourceBuffer)
    const placement = normalizeSignaturePlacement(data.metadata?.signaturePlacement)
    const pageNumber = Math.min(placement.page, sourcePdf.getPageCount())
    const targetPage = sourcePdf.getPages()[pageNumber - 1]
    const pageWidth = targetPage.getWidth()
    const pageHeight = targetPage.getHeight()
    const fieldWidth = Math.min(pageWidth * placement.width, pageWidth - 40)
    const fieldHeight = Math.min(pageHeight * placement.height, pageHeight - 40)
    const fieldX = Math.min(Math.max(20, pageWidth * placement.left), pageWidth - fieldWidth - 20)
    const fieldBottom = Math.max(24, pageHeight - (pageHeight * placement.top) - fieldHeight)
    const signatureY = Math.min(pageHeight - 24, fieldBottom + Math.min(24, fieldHeight * 0.42))
    const signedActions = [{
      type: 'fill_and_sign',
      page: pageNumber,
      text: signatureText,
      x: fieldX,
      y: signatureY,
      width: fieldWidth,
      height: fieldHeight,
      size: Math.max(12, Math.min(18, fieldHeight * 0.32)),
      color: 'blue',
    }]
    if (data.recipient_name) signedActions.unshift({ type: 'add_text', page: pageNumber, text: data.recipient_name, x: fieldX, y: Math.min(pageHeight - 18, signatureY + Math.min(24, fieldHeight * 0.45)), size: Math.max(8, Math.min(12, fieldHeight * 0.2)), fontWeight: 'bold', color: 'black' })
    const signedPdf = await applyEditPlan(sourceBuffer, signedActions)
    const signedPdfSha256 = createHash('sha256').update(signedPdf.pdfBytes).digest('hex')
    signatureStage = 'upload-signed-pdf'
    const signedPath = `${data.owner_id}/${Date.now()}-signed-${safeFileName(data.document_name)}`
    const { error: uploadError } = await admin.storage.from('pdfs').upload(signedPath, signedPdf.pdfBytes, { contentType: 'application/pdf', upsert: false })
    if (uploadError) throw uploadError
    const signedAt = new Date().toISOString()
    const metadata = { ...(data.metadata || {}), signedDocumentPath: signedPath, signedAt, signedDocumentSha256: signedPdfSha256 }
    signatureStage = 'save-signature-record'
    const { error: updateError } = await admin.from('signature_requests').update({ status: 'signed', signed_at: signedAt, signature_text: signatureText, metadata }).eq('id', data.id)
    if (updateError) throw updateError
    try {
      await addAuditEvent(admin, { ownerId: data.owner_id, requestId: data.id, eventType: 'request_signed', actorEmail: data.recipient_email, details: { signatureTextLength: signatureText.length, signedDocumentPath: signedPath, signedDocumentSha256: signedPdfSha256, ip: request.ip || null, userAgent: request.headers['user-agent'] || null } })
    } catch (auditError) {
      console.error('[signature-audit-after-sign]', auditError?.message || auditError)
    }
    let ownerEmail = ''
    try {
      const owner = await admin.auth.admin.getUserById(data.owner_id)
      ownerEmail = owner.data?.user?.email || ''
    } catch (ownerLookupError) {
      console.error('[signature-owner-lookup]', ownerLookupError?.message || ownerLookupError)
    }
    const signedCopy = await admin.storage.from('pdfs').createSignedUrl(signedPath, 604800)
    const signedCopyUrl = signedCopy.data?.signedUrl || null
    const signedFileName = `${safeFileName(data.document_name).replace(/\.pdf$/i, '')}-signed.pdf`
    const canAttach = signedPdf.pdfBytes.length <= 29 * 1024 * 1024
    const attachments = canAttach ? [{ content: Buffer.from(signedPdf.pdfBytes).toString('base64'), filename: signedFileName }] : []
    const notificationRecipients = [...new Set([ownerEmail, data.recipient_email].filter((email) => email && email.includes('@')))]
    const notifiedEmails = []
    for (const recipient of notificationRecipients) {
      try {
        const emailResult = await sendResendEmail({
          to: recipient,
          subject: `Signed PDF: ${data.document_name}`,
          replyTo: process.env.EMAIL_FROM,
          text: `${data.document_name} was signed by ${data.recipient_email}.${signedCopyUrl ? ` Download link (valid for 7 days): ${signedCopyUrl}` : ''}${canAttach ? ' The signed PDF is attached.' : ' The PDF is available from your updateMyPDF cloud storage.'}`,
          html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#182238"><p><strong>${escapeHtml(data.document_name)}</strong> was signed by ${escapeHtml(data.recipient_email)}.</p>${signedCopyUrl ? `<p><a href="${escapeHtml(signedCopyUrl)}">Download the signed PDF</a> (link valid for 7 days).</p>` : ''}${canAttach ? '<p>The signed PDF is also attached to this email.</p>' : ''}</div>`,
          attachments,
        })
        notifiedEmails.push(recipient)
        try {
          await addAuditEvent(admin, { ownerId: data.owner_id, requestId: data.id, eventType: 'signed_copy_emailed', actorEmail: recipient, details: { provider: 'resend', providerMessageId: emailResult.id || null, attached: canAttach } })
        } catch (auditError) {
          console.error('[signature-email-audit]', auditError?.message || auditError)
        }
      } catch (notificationError) {
        console.error('[signature-copy-notification]', recipient, notificationError?.message || notificationError)
      }
    }
    response.json({ ok: true, status: 'signed', signedAt, signedDocumentPath: signedPath, signedCopyUrl, notifiedEmails })
  } catch (error) {
    console.error('[signature-sign]', signatureStage, error?.message || error)
    const publicMessage = signatureRequestError(error)
      ? 'İmza tablosu henüz Supabase içinde oluşturulmamış.'
      : signatureStage === 'download-source'
        ? 'Kaynak PDF cloud storage’dan indirilemedi.'
        : signatureStage === 'render-signature'
          ? 'PDF üzerine imza eklenemedi.'
          : signatureStage === 'upload-signed-pdf'
            ? 'İmzalı PDF cloud storage’a kaydedilemedi.'
            : signatureStage === 'save-signature-record'
              ? 'İmza kaydı veritabanına yazılamadı.'
              : 'İmza kaydedilemedi.'
    response.status(signatureRequestError(error) ? 503 : 500).json({ error: publicMessage, stage: signatureStage })
  }
})

app.get('/api/signatures/:id/audit', async (request, response) => {
  try {
    const { admin, user } = await getSupabaseUser(request)
    const { data: requestRow, error: requestError } = await admin.from('signature_requests').select('id').eq('id', request.params.id).eq('owner_id', user.id).maybeSingle()
    if (requestError) throw requestError
    if (!requestRow) return response.status(404).json({ error: 'İmza isteği bulunamadı.' })
    const { data, error } = await admin.from('pdf_audit_events').select('id,event_type,actor_email,details,created_at').eq('request_id', requestRow.id).order('created_at', { ascending: true })
    if (error) throw error
    response.json({ events: data || [] })
  } catch (error) {
    console.error('[signature-audit]', error?.message || error)
    response.status(signatureRequestError(error) ? 503 : error?.status || 500).json({ error: signatureRequestError(error) ? 'İmza tabloları henüz Supabase içinde oluşturulmamış.' : 'Audit kayıtları okunamadı.' })
  }
})

app.get('/api/capabilities', (_request, response) => {
  response.json(getCapabilitySummary())
})

app.use('/api/ai', guestAiGuard)

app.post('/api/ai/command', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (request, response) => {
  const prompt = String(request.body?.prompt || '').trim()
  const sourceFile = request.files?.file?.[0]
  const imageFile = request.files?.image?.[0]
  if (!prompt) return response.status(400).json({ error: 'Prompt is required.' })
  if (!sourceFile) return response.status(400).json({ error: 'A PDF file is required.' })
  if (sourceFile.mimetype !== 'application/pdf') return response.status(400).json({ error: 'Only PDF files are supported.' })
  if (imageFile && !['image/png', 'image/jpeg'].includes(imageFile.mimetype)) return response.status(400).json({ error: 'Only PNG or JPEG images are supported.' })

  try {
    const client = getClient()
    const base64Pdf = sourceFile.buffer.toString('base64')
    const content = [{
      type: 'input_file',
      filename: sourceFile.originalname || 'document.pdf',
      file_data: `data:application/pdf;base64,${base64Pdf}`,
      detail: 'low',
    }]
    if (imageFile) content.push({
      type: 'input_image',
      image_url: `data:${imageFile.mimetype};base64,${imageFile.buffer.toString('base64')}`,
    })
    content.push({ type: 'input_text', text: prompt })
    const result = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6',
      instructions: systemInstructions,
      input: [{
        role: 'user',
        content,
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'pdf_edit_plan',
          strict: true,
          schema: editPlanSchema,
        },
      },
    })

    if (!result.output_text?.trim()) throw new Error('The model returned an empty response.')
    const plan = JSON.parse(result.output_text)
    const removePasswordAction = plan.actions.find((action) => action.type === 'remove_password')
    const executorActions = removePasswordAction ? plan.actions.filter((action) => action.type !== 'remove_password') : plan.actions
    const editableSource = removePasswordAction ? await decryptPdfBuffer(sourceFile.buffer, removePasswordAction.password || '') : sourceFile.buffer
    const execution = await applyEditPlan(editableSource, executorActions, { imageBuffer: imageFile?.buffer })
    const externalExecution = await applyExternalPdfActions(execution.pdfBytes, plan.actions)
    let finalPdfBytes = externalExecution.pdfBytes
    const appliedActions = [...execution.appliedActions, ...(removePasswordAction ? [{ type: 'remove_password', applied: true }] : []), ...externalExecution.appliedActions]
    const warnings = [...execution.warnings, ...externalExecution.warnings]
    if (plan.actions.some((action) => action.type === 'portfolio')) {
      finalPdfBytes = await createPortfolioBuffer([{ buffer: finalPdfBytes, originalname: sourceFile.originalname || 'document.pdf', mimetype: 'application/pdf' }])
      appliedActions.push({ type: 'portfolio', applied: true, attachmentCount: 1 })
    }
    const officeActions = plan.actions.filter((action) => ['export_word', 'export_excel', 'export_powerpoint'].includes(action.type) && action.format)
    const officeExports = await Promise.all(officeActions.map(async (action) => {
      const format = action.format
      const officeBytes = await exportOfficeBuffer(finalPdfBytes, format)
      const sourceBaseName = safeFileName((sourceFile.originalname || 'document.pdf').replace(/\.pdf$/i, ''))
      return { type: action.type, format, fileName: `${sourceBaseName}.${format}`, data: officeBytes.toString('base64') }
    }))
    const audioAction = plan.actions.find((action) => action.type === 'audio_overview')
    let audioOverview = null
    if (audioAction) {
      try {
        audioOverview = { fileName: `${safeFileName((sourceFile.originalname || 'document.pdf').replace(/\.pdf$/i, ''))}-audio-overview.mp3`, data: (await createAudioOverview(client, editableSource)).toString('base64') }
        warnings.push('Sesli PDF özeti oluşturuldu ve indirilmeye hazır.')
      } catch (error) {
        warnings.push(`Sesli özet oluşturulamadı: ${error?.name === 'AbortError' ? 'işlem zaman aşımına uğradı.' : 'OpenAI ses servisi yanıt vermedi.'}`)
      }
    }
    const ocrAction = plan.actions.find((action) => action.type === 'ocr_scan')
    const ocrPages = ocrAction ? await ocrPdfBuffer(editableSource, ocrAction.language || 'eng') : null
    return response.json({
      ...plan,
      editedPdf: Buffer.from(finalPdfBytes).toString('base64'),
      appliedActions,
      warnings,
      analysis: appliedActions.filter((action) => action.fields || action.measurements || action.report || action.data || action.table || action.citations),
      officeExports,
      audioOverview,
      ocrPages,
      model: process.env.OPENAI_MODEL || 'gpt-5.6',
      sourceFile: sourceFile.originalname || 'document.pdf',
    })
  } catch (error) {
    console.error('[ai-command]', error?.message || error)
    const status = error?.status === 401 ? 401 : 500
    const developmentDetails = process.env.NODE_ENV === 'production' ? '' : ` (${error?.message || 'unknown error'})`
    return response.status(status).json({
      error: status === 401
        ? 'OpenAI API anahtarı geçersiz veya yetkisiz.'
        : `AI komutu işlenirken bir hata oluştu${developmentDetails}.`,
    })
  }
})

app.post('/api/pdf/merge', upload.array('files', 20), async (request, response) => {
  if (!request.files?.length || request.files.length < 2) return response.status(400).json({ error: 'En az iki PDF gerekli.' })
  try {
    const merged = await PDFDocument.create()
    for (const file of request.files) {
      const source = await PDFDocument.load(file.buffer)
      const pages = await merged.copyPages(source, source.getPageIndices())
      pages.forEach((page) => merged.addPage(page))
    }
    response.type('application/pdf').send(Buffer.from(await merged.save()))
  } catch (error) {
    console.error('[pdf-merge]', error?.message || error)
    response.status(400).json({ error: 'PDF dosyaları birleştirilemedi.' })
  }
})

app.post('/api/pdf/portfolio', upload.array('files', 20), async (request, response) => {
  if (!request.files?.length) return response.status(400).json({ error: 'Portföye eklenecek en az bir dosya gerekli.' })
  try {
    const output = await createPortfolioBuffer(request.files)
    response.type('application/pdf').set('Content-Disposition', 'attachment; filename="portfolio.pdf"').send(output)
  } catch (error) {
    console.error('[pdf-portfolio]', error?.message || error)
    response.status(400).json({ error: 'PDF portföyü oluşturulamadı.' })
  }
})

app.post('/api/pdf/split', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Bölünecek bir PDF gerekli.' })
  try {
    const source = await PDFDocument.load(request.file.buffer)
    const pageCount = source.getPageCount()
    const rawGroups = String(request.body?.pages || '').split(',').map((part) => part.trim()).filter(Boolean)
    const groups = rawGroups.length
      ? rawGroups.map((part) => {
        const [startValue, endValue] = part.split('-').map(Number)
        const start = Math.max(1, startValue || 1)
        const end = Math.min(pageCount, endValue || start)
        return Array.from({ length: Math.max(0, end - start + 1) }, (_item, index) => start + index)
      }).filter((group) => group.length)
      : Array.from({ length: pageCount }, (_item, index) => [index + 1])

    const parts = []
    for (const group of groups) {
      const output = await PDFDocument.create()
      const copiedPages = await output.copyPages(source, group.map((page) => page - 1))
      copiedPages.forEach((page) => output.addPage(page))
      parts.push({ pages: group, pdf: Buffer.from(await output.save()).toString('base64') })
    }
    response.json({ fileName: request.file.originalname, parts })
  } catch (error) {
    console.error('[pdf-split]', error?.message || error)
    response.status(400).json({ error: 'PDF bölünemedi.' })
  }
})

app.post('/api/pdf/create', async (request, response) => {
  const text = String(request.body?.text || '').trim()
  if (!text) return response.status(400).json({ error: 'PDF oluşturmak için metin gerekli.' })
  try {
    const output = await PDFDocument.create()
    output.setTitle(String(request.body?.title || 'updateMyPDF document'))
    const font = await output.embedFont(StandardFonts.Helvetica)
    const lines = text.split(/\r?\n/)
    let page = output.addPage([612, 792])
    let y = 742
    for (const line of lines) {
      if (y < 48) {
        page = output.addPage([612, 792])
        y = 742
      }
      page.drawText(line.slice(0, 140), { x: 48, y, size: 12, font, color: rgb(0.08, 0.08, 0.08) })
      y -= 20
    }
    response.type('application/pdf').send(Buffer.from(await output.save()))
  } catch (error) {
    console.error('[pdf-create]', error?.message || error)
    response.status(400).json({ error: 'PDF oluşturulamadı.' })
  }
})

app.post('/api/pdf/optimize', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Optimize edilecek bir PDF gerekli.' })
  try {
    const result = await applyEditPlan(request.file.buffer, [{ type: 'optimize_pdf' }])
    response.type('application/pdf').set({
      'Content-Disposition': `attachment; filename="${safeFileName(request.file.originalname.replace(/\.pdf$/i, ''))}-optimized.pdf"`,
      'X-PDF-Original-Bytes': String(request.file.size),
      'X-PDF-Optimized-Bytes': String(result.pdfBytes.length),
    }).send(Buffer.from(result.pdfBytes))
  } catch (error) {
    console.error('[pdf-optimize]', error?.message || error)
    response.status(400).json({ error: 'PDF optimize edilemedi.' })
  }
})

app.post('/api/pdf/compress', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Sıkıştırılacak bir PDF gerekli.' })
  try {
    const output = await compressPdfBuffer(request.file.buffer)
    response.type('application/pdf').set('Content-Disposition', `attachment; filename="${safeFileName(request.file.originalname.replace(/\.pdf$/i, ''))}-compressed.pdf"`).send(output)
  } catch (error) {
    console.error('[pdf-compress]', error?.message || error)
    response.status(error?.code === 'TOOL_MISSING' ? 503 : 400).json({ error: error?.code === 'TOOL_MISSING' ? 'qpdf kurulu değil.' : 'PDF sıkıştırılamadı.' })
  }
})

app.post('/api/pdf/pdfa', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'PDF/A dönüştürmek için bir PDF gerekli.' })
  try {
    const output = await convertPdfToPdfa(request.file.buffer)
    response.type('application/pdf').set('Content-Disposition', `attachment; filename="${safeFileName(request.file.originalname.replace(/\.pdf$/i, ''))}-pdfa.pdf"`).send(output)
  } catch (error) {
    console.error('[pdf-pdfa]', error?.message || error)
    response.status(error?.code === 'TOOL_MISSING' ? 503 : 400).json({ error: error?.code === 'TOOL_MISSING' ? 'Ghostscript PDF/A kaynakları bulunamadı.' : 'PDF/A dönüştürmesi başarısız.' })
  }
})

app.post('/api/pdf/preflight', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Ön kontrol için bir PDF gerekli.' })
  try {
    response.json({ report: await preflightPdf(request.file.buffer) })
  } catch (error) {
    console.error('[pdf-preflight]', error?.message || error)
    response.status(error?.code === 'TOOL_MISSING' ? 503 : 400).json({ error: error?.code === 'TOOL_MISSING' ? 'PDF ön kontrol araçları bulunamadı.' : 'PDF ön kontrolü başarısız.' })
  }
})

app.post('/api/pdf/print-production', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Baskı hazırlığı için bir PDF gerekli.' })
  try {
    const output = await prepareForPrint(request.file.buffer)
    response.type('application/pdf').set('Content-Disposition', `attachment; filename="${safeFileName(request.file.originalname.replace(/\.pdf$/i, ''))}-prepress.pdf"`).send(output)
  } catch (error) {
    console.error('[pdf-print-production]', error?.message || error)
    response.status(error?.code === 'TOOL_MISSING' ? 503 : 400).json({ error: error?.code === 'TOOL_MISSING' ? 'Ghostscript kurulu değil.' : 'PDF baskı hazırlığı başarısız.' })
  }
})

app.post('/api/pdf/protect', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Korunacak bir PDF gerekli.' })
  const password = String(request.body?.password || '')
  if (!password) return response.status(400).json({ error: 'PDF şifresi gerekli.' })
  let permissions = request.body?.permissions || []
  if (typeof permissions === 'string') {
    try { permissions = JSON.parse(permissions) } catch (_error) { permissions = permissions.split(',').map((item) => item.trim()).filter(Boolean) }
  }
  try {
    const output = await protectPdfBuffer(request.file.buffer, password, permissions)
    response.type('application/pdf').set('Content-Disposition', `attachment; filename="${safeFileName(request.file.originalname.replace(/\.pdf$/i, ''))}-protected.pdf"`).send(output)
  } catch (error) {
    console.error('[pdf-protect]', error?.message || error)
    response.status(error?.code === 'TOOL_MISSING' ? 503 : 400).json({ error: error?.code === 'TOOL_MISSING' ? 'qpdf kurulu değil.' : 'PDF şifrelenemedi.' })
  }
})

app.post('/api/pdf/decrypt', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Şifresi kaldırılacak bir PDF gerekli.' })
  try {
    const output = await decryptPdfBuffer(request.file.buffer, request.body?.password || '')
    response.type('application/pdf').set('Content-Disposition', `attachment; filename="${safeFileName(request.file.originalname.replace(/\.pdf$/i, ''))}-decrypted.pdf"`).send(output)
  } catch (error) {
    console.error('[pdf-decrypt]', error?.message || error)
    response.status(error?.code === 'TOOL_MISSING' ? 503 : 400).json({ error: error?.code === 'TOOL_MISSING' ? 'qpdf kurulu değil.' : 'PDF şifresi kaldırılamadı.' })
  }
})

app.post('/api/pdf/export-office', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Dönüştürülecek bir PDF gerekli.' })
  const format = String(request.body?.format || request.query?.format || '').toLowerCase()
  const mime = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }[format]
  if (!mime) return response.status(400).json({ error: 'format docx, xlsx veya pptx olmalı.' })
  try {
    const output = await exportOfficeBuffer(request.file.buffer, format)
    response.type(mime).set('Content-Disposition', `attachment; filename="${safeFileName(request.file.originalname.replace(/\.pdf$/i, ''))}.${format}"`).send(output)
  } catch (error) {
    console.error('[pdf-export-office]', error?.message || error)
    response.status(error?.code === 'TOOL_MISSING' ? 503 : 400).json({ error: error?.code === 'TOOL_MISSING' ? 'LibreOffice kurulu değil.' : `PDF ${format.toUpperCase()} formatına dönüştürülemedi.` })
  }
})

app.post('/api/pdf/export-html', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'HTML’e dönüştürülecek PDF gerekli.' })
  try {
    const pages = await extractTextPages(request.file.buffer)
    const sections = pages.map((page) => `<section data-page="${page.page}"><h2>Page ${page.page}</h2><p>${escapeHtml(page.text).replaceAll('\n', '<br />')}</p></section>`).join('\n')
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(request.file.originalname)}</title><style>body{font-family:Arial,sans-serif;max-width:900px;margin:40px auto;color:#182238}section{margin:0 0 32px;padding:24px;border:1px solid #d9deea;border-radius:8px}h2{font-size:14px;color:#687590}p{line-height:1.6;white-space:normal}</style></head><body>${sections}</body></html>`
    response.type('text/html').send(html)
  } catch (error) {
    console.error('[pdf-export-html]', error?.message || error)
    response.status(400).json({ error: 'PDF HTML’e dönüştürülemedi.' })
  }
})

app.post('/api/pdf/export-image', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Görüntülenecek bir PDF gerekli.' })
  const pageNumber = Math.max(1, Number(request.body?.page || request.query?.page || 1))
  try {
    const pages = await renderPdfPages(request.file.buffer, 2)
    const page = pages[pageNumber - 1]
    if (!page) return response.status(404).json({ error: 'İstenen sayfa bulunamadı.' })
    response.type('image/png').send(page.png)
  } catch (error) {
    console.error('[pdf-export-image]', error?.message || error)
    response.status(400).json({ error: 'PDF sayfası görüntüye dönüştürülemedi.' })
  }
})

app.post('/api/pdf/extract-text', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Bir PDF gerekli.' })
  try {
    response.json({ fileName: request.file.originalname, pages: await extractTextPages(request.file.buffer) })
  } catch (error) {
    console.error('[pdf-extract-text]', error?.message || error)
    response.status(400).json({ error: 'PDF metni çıkarılamadı.' })
  }
})

app.post('/api/pdf/export-form-data', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Form verisi çıkarılacak bir PDF gerekli.' })
  try {
    const document = await PDFDocument.load(request.file.buffer)
    const fields = document.getForm().getFields().map((field) => {
      let value = null
      try {
        if (field.constructor.name === 'PDFTextField') value = field.getText() || ''
        if (field.constructor.name === 'PDFCheckBox') value = field.isChecked()
        if (field.constructor.name === 'PDFDropdown') value = field.getSelected()
        if (field.constructor.name === 'PDFRadioGroup') value = field.getSelected()
      } catch (_error) {
        value = null
      }
      return { name: field.getName(), type: field.constructor.name, value }
    })
    response.json({ fileName: request.file.originalname, fields })
  } catch (error) {
    console.error('[pdf-export-form-data]', error?.message || error)
    response.status(400).json({ error: 'Form verisi dışa aktarılamadı.' })
  }
})

app.post('/api/pdf/info', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Bir PDF gerekli.' })
  try {
    const document = await PDFDocument.load(request.file.buffer)
    response.json({
      fileName: request.file.originalname,
      pageCount: document.getPageCount(),
      title: document.getTitle() || '',
      author: document.getAuthor() || '',
      subject: document.getSubject() || '',
    })
  } catch (error) {
    console.error('[pdf-info]', error?.message || error)
    response.status(400).json({ error: 'PDF bilgileri okunamadı.' })
  }
})

app.post('/api/pdf/compare', upload.array('files', 2), async (request, response) => {
  if (!request.files?.length || request.files.length !== 2) return response.status(400).json({ error: 'Karşılaştırma için iki PDF gerekli.' })
  try {
    response.json(await comparePdfBuffers(request.files[0].buffer, request.files[1].buffer))
  } catch (error) {
    console.error('[pdf-compare]', error?.message || error)
    response.status(400).json({ error: 'PDF dosyaları karşılaştırılamadı.' })
  }
})

app.post('/api/pdf/ocr', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Bir PDF gerekli.' })
  try {
    const language = request.body?.language === 'tur' ? 'tur' : 'eng'
    response.json({ fileName: request.file.originalname, language, pages: await ocrPdfBuffer(request.file.buffer, language) })
  } catch (error) {
    console.error('[pdf-ocr]', error?.message || error)
    response.status(400).json({ error: 'Yerel OCR çalıştırılamadı.' })
  }
})

const distDirectory = path.resolve(process.cwd(), 'dist')
const distIndex = path.join(distDirectory, 'index.html')
if (existsSync(distIndex)) {
  const sendClient = (_request, response) => {
    const html = readFileSync(distIndex, 'utf8')
      .replace('"__PDF_MANIAC_SUPABASE_URL__"', JSON.stringify(process.env.SUPABASE_URL || ''))
      .replace('"__PDF_MANIAC_SUPABASE_ANON_KEY__"', JSON.stringify(process.env.SUPABASE_ANON_KEY || ''))
    response.type('html').send(html)
  }
  app.get('/', sendClient)
  app.get('/review/:token', sendClient)
  app.use(express.static(distDirectory))
  app.use((request, response, next) => {
    if (request.path.startsWith('/api/')) return next()
    return sendClient(request, response)
  })
}

app.use((error, _request, response, _next) => {
  if (error?.code === 'LIMIT_FILE_SIZE') return response.status(413).json({ error: 'PDF dosyası 50 MB sınırını aşamaz.' })
  return response.status(500).json({ error: 'Beklenmeyen sunucu hatası.' })
})

app.listen(port, () => {
  console.log(`updateMyPDF API listening on http://localhost:${port}`)
})
