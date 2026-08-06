import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import OpenAI from 'openai'
import fontkit from '@pdf-lib/fontkit'
import { Document, HeadingLevel, PageBreak, Paragraph, Packer } from 'docx'
import ExcelJS from 'exceljs'
import PptxGenJS from 'pptxgenjs'
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib'
import { createClient } from '@supabase/supabase-js'
import { applyEditPlan } from './pdf-editor.js'
import { getCapabilitySummary } from './capabilities.js'
import { getEmailStatus, sendResendEmail } from './email.js'
import { comparePdfBuffers, extractTextPages } from './pdf-text.js'
import { ocrImageText, ocrPdfBuffer, renderPdfPages } from './pdf-render.js'
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
  const dailyLimit = request.path === '/assistant' ? 5 : 1
  const now = Date.now()
  const current = guestAiUsage.get(clientKey)
  if (current && now - current.startedAt < guestAiWindowMs && current.count >= dailyLimit) {
    return response.status(429).json({ error: dailyLimit > 1 ? 'Ücretsiz belge asistanı limitine ulaştın. Devam etmek için hesap oluştur.' : 'İlk ücretsiz AI önizlemeni kullandın. Devam etmek için hesap oluştur.' })
  }
  if (!current || now - current.startedAt >= guestAiWindowMs) guestAiUsage.set(clientKey, { startedAt: now, count: 1 })
  else current.count += 1
  return next()
}

const aiTokenPlans = {
  basic: { name: 'Basic', price: '9.99', tokens: 100 },
  pro: { name: 'Pro', price: '24.99', tokens: 500 },
  ultimate: { name: 'Ultimate', price: '59.99', tokens: 2000 },
}
const aiTokenCost = 5

const getAiTokenPlan = (user) => {
  // Subscription state is server-controlled; user metadata must not allow a
  // client to promote itself to a higher token plan.
  const planId = String(user?.app_metadata?.plan || 'basic').toLowerCase()
  return { id: aiTokenPlans[planId] ? planId : 'basic', ...(aiTokenPlans[planId] || aiTokenPlans.basic) }
}

const nextTokenPeriod = () => {
  const next = new Date()
  next.setMonth(next.getMonth() + 1)
  return next.toISOString()
}

const toAiTokenUsage = (state) => ({
  plan: state.plan.id,
  planName: state.plan.name,
  remaining: state.remaining,
  limit: state.plan.tokens,
  percentage: Math.min(100, Math.round((state.remaining / state.plan.tokens) * 100)),
  low: state.remaining < state.plan.tokens * 0.2,
  reloadTokens: state.plan.tokens,
  reloadPrice: state.plan.price,
  periodEndsAt: state.periodEndsAt,
  costPerOperation: aiTokenCost,
})

const ensureAiTokenState = async (admin, user) => {
  const plan = getAiTokenPlan(user)
  const metadata = user.app_metadata || {}
  const existingPlan = String(metadata.ai_tokens_plan || '')
  const existingRemaining = Number(metadata.ai_tokens_remaining)
  const existingPeriodEndsAt = String(metadata.ai_tokens_period_ends_at || '')
  const periodExpired = !existingPeriodEndsAt || Date.parse(existingPeriodEndsAt) <= Date.now()
  const planChanged = existingPlan !== plan.id
  const needsInitialization = !Number.isFinite(existingRemaining) || periodExpired || planChanged
  const state = {
    plan,
    remaining: needsInitialization ? plan.tokens : Math.max(0, existingRemaining),
    periodEndsAt: needsInitialization ? nextTokenPeriod() : existingPeriodEndsAt,
  }
  if (!needsInitialization) return { user, state }
  const nextAppMetadata = {
    ...metadata,
    ai_tokens_plan: plan.id,
    ai_tokens_remaining: state.remaining,
    ai_tokens_period_ends_at: state.periodEndsAt,
  }
  const updated = await admin.auth.admin.updateUserById(user.id, { app_metadata: nextAppMetadata })
  if (updated.error) throw updated.error
  return { user: updated.data.user || { ...user, app_metadata: nextAppMetadata }, state }
}

const prepareAiTokenUse = async (request) => {
  if (!request.headers.authorization?.startsWith('Bearer ')) return null
  const { admin, user } = await getSupabaseUser(request)
  const ensured = await ensureAiTokenState(admin, user)
  if (ensured.state.remaining < aiTokenCost) {
    const error = new Error(`AI token bakiyen yetersiz. ${aiTokenCost} tokenlık işlem için önce tokenlarını yenilemelisin.`)
    error.status = 402
    error.tokenUsage = toAiTokenUsage(ensured.state)
    throw error
  }
  return { admin, user: ensured.user, state: ensured.state }
}

const consumeAiTokens = async (context) => {
  if (!context) return null
  const nextRemaining = Math.max(0, context.state.remaining - aiTokenCost)
  const nextAppMetadata = {
    ...(context.user.app_metadata || {}),
    ai_tokens_plan: context.state.plan.id,
    ai_tokens_remaining: nextRemaining,
    ai_tokens_period_ends_at: context.state.periodEndsAt,
  }
  const updated = await context.admin.auth.admin.updateUserById(context.user.id, { app_metadata: nextAppMetadata })
  if (updated.error) throw updated.error
  return toAiTokenUsage({ ...context.state, remaining: nextRemaining })
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

const stripeRequest = async (endpoint, params = {}) => {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim()
  if (!secretKey) {
    const error = new Error('Stripe ödeme yönetimi henüz yapılandırılmadı.')
    error.status = 503
    throw error
  }
  const stripeResponse = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  })
  const payload = await stripeResponse.json().catch(() => ({}))
  if (!stripeResponse.ok) {
    const error = new Error(payload?.error?.message || 'Stripe isteği başarısız oldu.')
    error.status = stripeResponse.status >= 400 && stripeResponse.status < 500 ? 400 : 502
    throw error
  }
  return payload
}

const ensureStripeCustomer = async (admin, user) => {
  const existingCustomerId = String(user.user_metadata?.stripe_customer_id || '').trim()
  if (existingCustomerId) return existingCustomerId
  const customer = await stripeRequest('customers', {
    email: user.email || '',
    name: user.user_metadata?.full_name || user.email || 'updateMyPDF customer',
    'metadata[supabase_user_id]': user.id,
  })
  const { error } = await admin.auth.admin.updateUserById(user.id, {
    user_metadata: { ...(user.user_metadata || {}), stripe_customer_id: customer.id },
  })
  if (error) throw error
  return customer.id
}

const stripePriceForPlan = (plan) => {
  const prices = {
    basic: process.env.STRIPE_PRICE_BASIC,
    pro: process.env.STRIPE_PRICE_PRO,
    ultimate: process.env.STRIPE_PRICE_ULTIMATE,
  }
  return String(prices[String(plan || '').toLowerCase()] || '').trim()
}

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

const normalizeSignatureStyle = (value) => ['elegant', 'classic', 'bold'].includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : 'elegant'

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

const sendSignatureInviteEmail = async ({ recipientEmail, recipientName, senderName, documentName, workflowType, message, reviewUrl, expiresAt, signerIndex, signerCount }) => {
  const greeting = `Hello ${escapeHtml(recipientName || recipientEmail)},`
  const bodyText = message ? `<p>${escapeHtml(message)}</p>` : ''
  const sequenceNote = signerCount > 1 ? `<p>You are signer ${signerIndex + 1} of ${signerCount}. The next signer will receive the PDF after your signature is completed.</p>` : ''
  const emailResult = await sendResendEmail({
    to: recipientEmail,
    subject: `${workflowType === 'review' ? 'PDF review request' : 'PDF signature request'}: ${documentName}`,
    replyTo: process.env.EMAIL_FROM,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#182238"><p>${greeting}</p>${bodyText}<p><strong>${escapeHtml(senderName)}</strong> asked you to ${workflowType === 'review' ? 'review' : 'sign'} <strong>${escapeHtml(documentName)}</strong>.</p>${sequenceNote}<p><a href="${escapeHtml(reviewUrl)}" style="display:inline-block;padding:12px 18px;background:#e45235;color:#fff;text-decoration:none;border-radius:8px">Open PDF</a></p><p>This link expires on ${escapeHtml(expiresAt)}.</p></div>`,
    text: `${greeting.replaceAll('&lt;', '<').replaceAll('&gt;', '>')}\n\n${senderName} asked you to ${workflowType === 'review' ? 'review' : 'sign'} ${documentName}.\n${message || ''}\n\n${signerCount > 1 ? `You are signer ${signerIndex + 1} of ${signerCount}. The next signer will receive the PDF after your signature is completed.\n\n` : ''}Open PDF: ${reviewUrl}\nExpires: ${expiresAt}`,
  })
  return emailResult
}

const notifyFinalSignedCopy = async ({ admin, ownerId, documentName, signerRows, signedPdfBytes, signedCopyUrl }) => {
  let ownerEmail = ''
  try {
    const owner = await admin.auth.admin.getUserById(ownerId)
    ownerEmail = owner.data?.user?.email || ''
  } catch (ownerLookupError) {
    console.error('[signature-owner-lookup]', ownerLookupError?.message || ownerLookupError)
  }
  const signedFileName = `${safeFileName(documentName).replace(/\.pdf$/i, '')}-signed.pdf`
  const canAttach = signedPdfBytes.length <= 29 * 1024 * 1024
  const attachments = canAttach ? [{ content: Buffer.from(signedPdfBytes).toString('base64'), filename: signedFileName }] : []
  const signerEmails = signerRows.map((row) => row.recipient_email).filter((email) => email && email.includes('@'))
  const notificationRecipients = [...new Set([ownerEmail, ...signerEmails].filter((email) => email && email.includes('@')))]
  const notifiedEmails = []
  const signerNames = signerRows.map((row) => row.recipient_name || row.recipient_email).filter(Boolean).join(', ')
  for (const recipient of notificationRecipients) {
    try {
      const emailResult = await sendResendEmail({
        to: recipient,
        subject: `Signed PDF: ${documentName}`,
        replyTo: process.env.EMAIL_FROM,
        text: `${documentName} was signed by ${signerNames}.${signedCopyUrl ? ` Download link (valid for 7 days): ${signedCopyUrl}` : ''}${canAttach ? ' The signed PDF is attached.' : ' The PDF is available from your updateMyPDF workspace.'}`,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#182238"><p><strong>${escapeHtml(documentName)}</strong> was fully signed by ${escapeHtml(signerNames)}.</p>${signedCopyUrl ? `<p><a href="${escapeHtml(signedCopyUrl)}">Download the final signed PDF</a> (link valid for 7 days).</p>` : ''}${canAttach ? '<p>The final signed PDF is also attached to this email.</p>' : ''}</div>`,
        attachments,
      })
      notifiedEmails.push(recipient)
      try {
        await addAuditEvent(admin, { ownerId, requestId: signerRows[0]?.id || null, eventType: 'signed_copy_emailed', actorEmail: recipient, details: { provider: 'resend', providerMessageId: emailResult.id || null, attached: canAttach, signerCount: signerRows.length } })
      } catch (auditError) {
        console.error('[signature-email-audit]', auditError?.message || auditError)
      }
    } catch (notificationError) {
      console.error('[signature-copy-notification]', recipient, notificationError?.message || notificationError)
    }
  }
  return { notifiedEmails, canAttach }
}

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

const exportHtmlBuffer = async (pdfBuffer, documentName = 'document.pdf') => {
  const pages = await extractTextPages(pdfBuffer)
  const sections = pages.map((page) => `<section data-page="${page.page}"><h2>Page ${page.page}</h2><p>${escapeHtml(page.text || '').replaceAll('\n', '<br />')}</p></section>`).join('\n')
  return Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtml(documentName)}</title><style>body{font-family:Arial,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#182238}section{margin:0 0 32px;padding:24px;border:1px solid #d9deea;border-radius:8px}h2{font-size:14px;color:#687590}p{line-height:1.6;white-space:normal}</style></head><body>${sections}</body></html>`)
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

const pdfSafeText = (value) => String(value || '')
  .replace(/[—–]/g, '-')
  .replace(/[“”]/g, '"')
  .replace(/[‘’]/g, "'")
  .replace(/…/g, '...')
  .replace(/•/g, '-')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')

const wrapPdfText = (text, font, size, maxWidth) => {
  const words = pdfSafeText(text).split(/\s+/).filter(Boolean)
  if (!words.length) return ['']
  const lines = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate
    else {
      if (line) {
        lines.push(line)
        line = word
      } else {
        let chunk = ''
        for (const character of word) {
          const next = `${chunk}${character}`
          if (font.widthOfTextAtSize(next, size) > maxWidth && chunk) {
            lines.push(chunk)
            chunk = character
          } else chunk = next
        }
        line = chunk
      }
    }
  }
  if (line) lines.push(line)
  return lines
}

const pdfFontPath = (kind) => {
  const configured = process.env[`PDFMANIAC_${kind.toUpperCase()}_FONT_PATH`]
  const candidates = {
    regular: [configured, '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'C:\\Windows\\Fonts\\segoeui.ttf', 'C:\\Windows\\Fonts\\arial.ttf'],
    bold: [configured, '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:\\Windows\\Fonts\\segoeuib.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf'],
    italic: [configured, '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf', 'C:\\Windows\\Fonts\\segoeuii.ttf', 'C:\\Windows\\Fonts\\ariali.ttf'],
  }
  return (candidates[kind] || []).filter(Boolean).find((candidate) => existsSync(candidate)) || null
}

const embedPdfFont = async (document, kind, fallback) => {
  const filePath = pdfFontPath(kind)
  return filePath ? document.embedFont(readFileSync(filePath), { subset: true }) : document.embedFont(fallback)
}

const normalizeBlockHeading = (value) => pdfSafeText(value).replace(/^#{1,6}\s*/, '').replace(/\*\*(.*?)\*\*/g, '$1').trim()

const parseDocumentBlocks = (content, title) => {
  const blocks = []
  let paragraph = []
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ').replace(/\s+/g, ' ').trim() })
      paragraph = []
    }
  }
  for (const rawLine of String(content || '').replaceAll('\r', '').split('\n')) {
    const line = rawLine.trim()
    if (!line) {
      flushParagraph()
      continue
    }
    const markdownHeading = /^(#{1,6})\s+(.+)$/.exec(line)
    const numberedHeading = /^(\d+(?:\.\d+)*[.)])\s+(.{1,160})$/.exec(line)
    const uppercaseHeading = /^[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ\s&/,:-]{3,100}$/.test(line) && line.length < 110
    if (markdownHeading || numberedHeading || uppercaseHeading) {
      flushParagraph()
      const headingText = markdownHeading ? markdownHeading[2] : numberedHeading ? line : line
      const level = markdownHeading ? Math.min(markdownHeading[1].length, 3) : 2
      blocks.push({ type: 'heading', level, text: normalizeBlockHeading(headingText) })
      continue
    }
    const bullet = /^[-*•]\s+(.+)$/.exec(line)
    if (bullet) {
      flushParagraph()
      blocks.push({ type: 'bullet', text: bullet[1].replace(/\*\*(.*?)\*\*/g, '$1').trim() })
      continue
    }
    paragraph.push(line.replace(/\*\*(.*?)\*\*/g, '$1').trim())
  }
  flushParagraph()
  const cleanTitle = normalizeBlockHeading(title || '')
  if (blocks[0]?.type === 'heading' && cleanTitle && blocks[0].text.toLowerCase() === cleanTitle.toLowerCase()) blocks.shift()
  return blocks
}

const signatureHeading = (text) => /^(signatures?|signature blocks?|imzalar?|imza bölümü|signing)$/i.test(text.trim())

const createTextPdfBuffer = async (title, content, metadata = {}) => {
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  document.setTitle(pdfSafeText(title || 'Generated document'))
  document.setAuthor('updateMyPDF')
  document.setSubject('Professional document')
  const regular = await embedPdfFont(document, 'regular', StandardFonts.Helvetica)
  const bold = await embedPdfFont(document, 'bold', StandardFonts.HelveticaBold)
  const italic = await embedPdfFont(document, 'italic', StandardFonts.HelveticaOblique)
  const pageSize = [612, 792]
  const margin = 60
  const contentWidth = pageSize[0] - margin * 2
  const colors = {
    ink: rgb(0.12, 0.15, 0.2),
    muted: rgb(0.38, 0.42, 0.48),
    accent: rgb(0.87, 0.25, 0.16),
    rule: rgb(0.86, 0.87, 0.89),
    panel: rgb(0.97, 0.97, 0.96),
  }
  let page
  let y
  const pages = []
  const headerFooter = (currentPage, index) => {
    if (index > 0) {
      currentPage.drawText(pdfSafeText(title || 'Document draft'), { x: margin, y: 754, size: 8, font: bold, color: colors.muted })
      currentPage.drawLine({ start: { x: margin, y: 744 }, end: { x: pageSize[0] - margin, y: 744 }, thickness: 0.7, color: colors.rule })
    }
    currentPage.drawLine({ start: { x: margin, y: 38 }, end: { x: pageSize[0] - margin, y: 38 }, thickness: 0.7, color: colors.rule })
    currentPage.drawText(`updateMyPDF · ${index + 1}/${pages.length}`, { x: margin, y: 24, size: 8, font: regular, color: colors.muted })
  }
  const newPage = (first = false) => {
    page = document.addPage(pageSize)
    pages.push(page)
    y = first ? 720 : 724
    return page
  }
  const ensureSpace = (height) => {
    if (y - height < 58) newPage(false)
  }
  const drawWrapped = (text, font, size, lineHeight, x, width, color = colors.ink) => {
    const lines = wrapPdfText(text, font, size, width)
    for (const line of lines) {
      ensureSpace(lineHeight)
      page.drawText(line, { x, y, size, font, color })
      y -= lineHeight
    }
  }
  const drawHeading = (text, level = 2) => {
    const size = level === 1 ? 16 : level === 2 ? 12.5 : 11
    const lineHeight = size + 5
    ensureSpace(lineHeight + 24)
    y -= level === 1 ? 12 : 9
    page.drawRectangle({ x: margin, y: y - 3, width: 4, height: lineHeight + 3, color: colors.accent })
    drawWrapped(text, bold, size, lineHeight, margin + 13, contentWidth - 13, colors.ink)
    y -= 8
  }
  const drawParagraph = (text) => {
    drawWrapped(text, regular, 10.5, 15, margin, contentWidth)
    y -= 8
  }
  const drawBullet = (text) => {
    ensureSpace(22)
    page.drawCircle({ x: margin + 5, y: y + 4, size: 2.2, color: colors.accent })
    drawWrapped(text, regular, 10.5, 15, margin + 16, contentWidth - 16)
    y -= 4
  }
  const drawSignatureGrid = (labels = []) => {
    const names = labels.length ? labels.slice(0, 4) : ['Party 1', 'Party 2']
    const cardGap = 14
    const cardWidth = (contentWidth - cardGap) / 2
    for (let row = 0; row < Math.ceil(names.length / 2); row += 1) {
      ensureSpace(118)
      const top = y
      names.slice(row * 2, row * 2 + 2).forEach((name, column) => {
        const x = margin + column * (cardWidth + cardGap)
        page.drawRectangle({ x, y: top - 104, width: cardWidth, height: 104, color: colors.panel, borderColor: colors.rule, borderWidth: 0.8 })
        page.drawText(pdfSafeText(name), { x: x + 12, y: top - 21, size: 10.5, font: bold, color: colors.ink })
        page.drawLine({ start: { x: x + 12, y: top - 60 }, end: { x: x + cardWidth - 12, y: top - 60 }, thickness: 0.7, color: colors.muted })
        page.drawText('Signature', { x: x + 12, y: top - 73, size: 8, font: italic, color: colors.muted })
        page.drawLine({ start: { x: x + 12, y: top - 88 }, end: { x: x + cardWidth - 12, y: top - 88 }, thickness: 0.7, color: colors.muted })
        page.drawText('Date', { x: x + 12, y: top - 100, size: 8, font: italic, color: colors.muted })
      })
      y -= 118
    }
  }

  newPage(true)
  page.drawText('UPDATEMYPDF', { x: margin, y, size: 8.5, font: bold, color: colors.accent })
  y -= 28
  drawWrapped(title || 'Generated document', bold, 24, 29, margin, contentWidth, colors.ink)
  y -= 5
  page.drawLine({ start: { x: margin, y }, end: { x: pageSize[0] - margin, y }, thickness: 1.5, color: colors.accent })
  y -= 20
  y -= 12
  const blocks = parseDocumentBlocks(content, title)
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.type === 'heading' && signatureHeading(block.text)) {
      drawHeading(block.text, 2)
      const signatureLabels = []
      let nextIndex = index + 1
      while (nextIndex < blocks.length && blocks[nextIndex].type !== 'heading') {
        if (signatureLabels.length < 4 && blocks[nextIndex].text) signatureLabels.push(blocks[nextIndex].text.split(':')[0].slice(0, 80))
        nextIndex += 1
      }
      drawSignatureGrid(signatureLabels)
      index = nextIndex - 1
    } else if (block.type === 'heading') drawHeading(block.text, block.level)
    else if (block.type === 'bullet') drawBullet(block.text)
    else drawParagraph(block.text)
  }
  pages.forEach(headerFooter)
  return Buffer.from(await document.save())
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
  const configuredTimeout = Number(process.env.OPENAI_TIMEOUT_MS || 180000)
  const timeout = Math.min(Math.max(Number.isFinite(configuredTimeout) ? configuredTimeout : 180000, 30000), 300000)
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout, maxRetries: 0 })
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
            enum: ['highlight', 'underline', 'style_text', 'strikethrough', 'squiggly', 'redact', 'ocr_scan', 'set_title', 'edit_metadata', 'remove_hidden_data', 'delete_page', 'rotate_page', 'reorder_pages', 'duplicate_page', 'add_text', 'add_image', 'resize_image', 'replace_image', 'set_alt_text', 'add_link', 'delete_text', 'replace_text', 'rewrite_text', 'insert_blank_page', 'insert_page', 'crop_page', 'resize_page', 'extract_pages', 'flatten_form', 'flatten_pdf', 'add_text_field', 'add_checkbox', 'add_dropdown', 'add_radio', 'add_signature_field', 'fill_field', 'fill_form', 'detect_form_fields', 'export_form_data', 'measure', 'accessibility_check', 'tag_pdf', 'reading_order', 'watermark', 'header_footer', 'bates_numbering', 'sticky_note', 'comment', 'freehand', 'shape', 'stamp', 'add_signature', 'fill_and_sign', 'optimize_pdf', 'compress_pdf', 'password_protect', 'remove_password', 'set_permissions', 'pdfa_convert', 'pdfx_preflight', 'print_production', 'portfolio', 'audio_overview', 'export_word', 'export_excel', 'export_powerpoint', 'export_html', 'export_image', 'extract_text', 'extract_data', 'extract_table', 'document_citations', 'summarize', 'translate', 'none'],
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
          format: { anyOf: [{ type: 'string', enum: ['docx', 'xlsx', 'pptx', 'html', 'png'] }, { type: 'null' }] },
        },
        required: ['type', 'page', 'text', 'replacement', 'url', 'angle', 'title', 'author', 'subject', 'keywords', 'color', 'fontFamily', 'fontWeight', 'fontStyle', 'align', 'opacity', 'x', 'y', 'size', 'targetPage', 'pages', 'width', 'height', 'imageIndex', 'fieldName', 'fieldType', 'value', 'options', 'language', 'position', 'script', 'password', 'permissions', 'format'],
      },
    },
  },
  required: ['assistantMessage', 'summary', 'actions'],
}

const translationPlanSchema = {
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
          type: { type: 'string', enum: ['translate'] },
          page: { type: 'integer' },
          text: { type: 'string' },
          replacement: { type: 'string' },
        },
        required: ['type', 'page', 'text', 'replacement'],
      },
    },
  },
  required: ['assistantMessage', 'summary', 'actions'],
}

const imageTranslationPlanSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          line: { type: 'integer' },
          replacement: { type: 'string' },
        },
        required: ['line', 'replacement'],
      },
    },
  },
  required: ['actions'],
}

const documentAssistantSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['answer', 'needs_info', 'draft_ready'] },
    reply: { type: 'string', maxLength: 1800 },
    documentType: { anyOf: [{ type: 'string', maxLength: 180 }, { type: 'null' }] },
    documentTitle: { anyOf: [{ type: 'string', maxLength: 180 }, { type: 'null' }] },
    documentLanguage: { anyOf: [{ type: 'string', maxLength: 80 }, { type: 'null' }] },
    jurisdiction: { anyOf: [{ type: 'string', maxLength: 240 }, { type: 'null' }] },
    questions: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', maxLength: 80 },
          label: { type: 'string', maxLength: 100 },
          question: { type: 'string', maxLength: 500 },
          kind: { type: 'string', enum: ['text', 'textarea', 'date', 'number', 'email', 'select'] },
          required: { type: 'boolean' },
          options: { anyOf: [{ type: 'array', maxItems: 12, items: { type: 'string', maxLength: 120 } }, { type: 'null' }] },
          help: { anyOf: [{ type: 'string', maxLength: 240 }, { type: 'null' }] },
        },
        required: ['id', 'label', 'question', 'kind', 'required', 'options', 'help'],
      },
    },
    facts: {
      type: 'array',
      maxItems: 80,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string', maxLength: 100 }, value: { type: 'string', maxLength: 1200 } },
        required: ['key', 'value'],
      },
    },
    researchNeeded: { type: 'boolean' },
    researchQuery: { anyOf: [{ type: 'string', maxLength: 500 }, { type: 'null' }] },
    researchSources: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', maxLength: 180 },
          url: { type: 'string', maxLength: 1000 },
          why: { type: 'string', maxLength: 240 },
        },
        required: ['title', 'url', 'why'],
      },
    },
    documentContent: { anyOf: [{ type: 'string', maxLength: 60000 }, { type: 'null' }] },
    complianceNotes: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 500 } },
  },
  required: ['status', 'reply', 'documentType', 'documentTitle', 'documentLanguage', 'jurisdiction', 'questions', 'facts', 'researchNeeded', 'researchQuery', 'researchSources', 'documentContent', 'complianceNotes'],
}

const documentAssistantInstructions = `You are updateMyPDF's general-purpose document concierge: a natural, thoughtful ChatGPT-style assistant who understands the whole conversation, combines facts, and then turns the finished request into a professional PDF. This is not a fixed list of lease, vehicle, or business templates. Support any reasonable request: contracts, policies, letters, applications, reports, invoices, proposals, forms, checklists, notices, plans, translations, and custom documents in any language.
Conversation style is essential: speak like a calm, capable human assistant, not like an API, legal form, database, or technical checklist. Reply in the user's language and match their tone. Start by acknowledging what you understood in one natural sentence. Explain only why a missing detail matters, then ask the smallest useful set of questions. Never expose status names, schema fields, internal reasoning, token/model details, or phrases such as "I need to identify the document type". Do not dump a generic questionnaire. When the user gives scattered facts, silently merge them into one coherent understanding and do not make them repeat themselves.
Use the newest user message, the compact profile, and only the recent conversation. Preserve and reconcile facts already collected. Never invent material facts, names, addresses, dates, prices, legal choices, or obligations. Do not ask again for facts already in the profile. Ask no more than four high-value questions per turn; group related details into one question and give a short example. If the user is only asking for advice or explanation, answer directly with status answer and do not force document creation.
For a document request, first identify the user's outcome, audience, document type, language, tone, jurisdiction, and required format. Ask for jurisdiction at the right level (country, state/province/region, city/municipality, district, or governing law) whenever the document has legal, tax, employment, immigration, financial, medical, safety, or regulatory consequences. Language policy is strict: if the user explicitly asks for a language, use that language even when it differs from the jurisdiction. Otherwise, for a legal or official document, use the primary official/business language of the selected jurisdiction (for the United States, default to English); do not infer Turkish only because the chat is Turkish. Ask a language question only when the jurisdiction has multiple meaningful official languages or the user's intent is genuinely ambiguous. If the location is unknown, ask for it instead of assuming Chicago, the United States, or any other place. Adapt the intake to the request; never expose a long generic checklist.
Research policy: do not use web search during routine intake or for purely creative/personal documents. When the user asks for research, or when current/local rules materially affect a document, set researchNeeded true and use the web_search tool before drafting. Search only after enough facts and jurisdiction are known. Prefer primary government, regulator, court, official standards, or authoritative institutional sources; use current sources and compare sources when rules conflict. Never imply that a search result alone makes the document legally compliant. Put the most useful source URLs in researchSources and explain their role in why. If a source cannot be verified, say so and leave a review note.
When the required facts are complete, return status draft_ready and write documentContent as a complete, polished, standalone document in the requested language. Harmonize the facts into natural clauses; never paste a raw fact list into the document. Use sensible headings, definitions, dates, payment or performance terms, responsibilities, exceptions, termination, dispute or governing-law terms only when relevant, signature blocks, and appendices when useful. For documents intended to be signed, always finish with a ## Signatures section; the PDF renderer will turn it into aligned signature cards. Do not include markdown fences. Use placeholders only for genuinely optional facts; list every placeholder in complianceNotes. Keep the chat reply warm and concise, for example: "Bilgileri birleştirdim; taslağı hazırladım." For documents with legal or regulated effect, complianceNotes must say that this is a draft, not legal advice, current rules and source applicability must be checked, and a qualified local professional should review it before reliance or signature. Never claim enforceability or guaranteed compliance.`

const assistantModel = () => process.env.OPENAI_ASSISTANT_MODEL || 'gpt-5.6-luna'
const pdfEditorModel = () => {
  const configuredModel = String(process.env.OPENAI_MODEL || '').trim()
  // Migrate the previous default automatically so an older Render env does not
  // silently keep the expensive general model after the Luna rollout.
  return !configuredModel || configuredModel === 'gpt-5.6' ? 'gpt-5.6-luna' : configuredModel
}
const translationModel = () => process.env.OPENAI_TRANSLATION_MODEL || pdfEditorModel()
const assistantReasoning = () => process.env.OPENAI_ASSISTANT_REASONING || 'low'
const normalizeAssistantSources = (sources) => (Array.isArray(sources) ? sources : [])
  .filter((source) => source && typeof source.url === 'string' && /^https?:\/\//i.test(source.url))
  .map((source) => ({ title: String(source.title || source.url).slice(0, 180), url: source.url.slice(0, 1000), why: String(source.why || 'Kaynak olarak kullanıldı.').slice(0, 240) }))
  .filter((source, index, list) => list.findIndex((candidate) => candidate.url === source.url) === index)
  .slice(0, 8)

const extractResponseSources = (result) => {
  const sources = []
  for (const item of Array.isArray(result?.output) ? result.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
        const citation = annotation?.url_citation || annotation
        if (citation?.url) sources.push({ title: citation.title || citation.url, url: citation.url, why: 'AI web araştırmasında kullanıldı.' })
      }
    }
    const action = item?.action
    for (const source of Array.isArray(action?.sources) ? action.sources : []) {
      if (source?.url) sources.push({ title: source.title || source.url, url: source.url, why: 'AI web araştırmasında kullanıldı.' })
    }
  }
  return normalizeAssistantSources(sources)
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
For insert_blank_page or insert_page, use page as the insertion position and width/height when provided.
For crop_page, use page, x, y, width, and height in PDF points.
For resize_page, use page when one page is named, otherwise apply to all pages; use width and height in PDF points.
For extract_pages, put the requested 1-based page numbers in pages.
For reorder_pages, put the desired 1-based page order in pages.
For duplicate_page, use page for the source and targetPage for the insertion position.
For add_text_field, add_checkbox, or add_dropdown, include fieldName, page, x, y, width, height, and options when needed.
For add_radio, include fieldName, page, x, y, width, height, options, and value when needed.
For add_signature_field, include fieldName, page, x, y, width, and height; this creates an interactive unsigned signature field, not a certificate signature.
For fill_field or fill_form, include fieldName, fieldType, and value.
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
For export_html, export the extracted text as a self-contained HTML document and set format to html. For export_image, set format to png and use page when a specific page is requested; otherwise export the rendered pages. These exports are downloaded separately and do not replace the PDF.
For extract_text, return the document text grouped by page without inventing or changing content.
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
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
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
    const requestedPath = String(request.body?.path || '').trim()
    const canUpdateExisting = requestedPath.startsWith(`${user.id}/`) && requestedPath.length > user.id.length + 1
    const path = canUpdateExisting ? requestedPath : `${user.id}/${Date.now()}-${safeFileName(request.file.originalname)}`
    const { error } = await admin.storage.from('pdfs').upload(path, request.file.buffer, {
      contentType: 'application/pdf',
      upsert: canUpdateExisting,
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

app.get('/api/workspace', async (request, response) => {
  try {
    const { admin, user } = await getSupabaseUser(request)
    const { data: files, error: filesError } = await admin.storage.from('pdfs').list(user.id, {
      limit: 100,
      sortBy: { column: 'created_at', order: 'desc' },
    })
    if (filesError) throw filesError
    const allFiles = await Promise.all((files || []).filter((file) => file.name !== '.emptyFolderPlaceholder').map(async (file) => {
      const path = `${user.id}/${file.name}`
      const signed = await admin.storage.from('pdfs').createSignedUrl(path, 3600)
      return {
        name: file.name,
        path,
        size: file.metadata?.size || 0,
        createdAt: file.created_at,
        signedUrl: signed.data?.signedUrl || null,
        isSignedCopy: /-signed(?:-|\.)/i.test(file.name),
      }
    }))
    let requestRows = []
    let signatureTableConfigured = true
    const { data: loadedRequestRows, error: requestsError } = await admin.from('signature_requests').select('id,document_path,document_name,workflow_type,recipient_email,recipient_name,status,expires_at,created_at,sent_at,viewed_at,signed_at,message,metadata').eq('owner_id', user.id).order('created_at', { ascending: false })
    if (requestsError && signatureRequestError(requestsError)) {
      signatureTableConfigured = false
      console.warn('[workspace-list] signature_requests migration is not available yet')
    } else if (requestsError) {
      throw requestsError
    } else {
      requestRows = loadedRequestRows || []
    }
    const requests = await Promise.all((requestRows || []).map(async (item) => {
      const signedDocumentPath = item.metadata?.signedDocumentPath || null
      const signed = signedDocumentPath ? await admin.storage.from('pdfs').createSignedUrl(signedDocumentPath, 3600) : null
      return { ...item, signedDocumentPath, signedDocumentUrl: signed?.data?.signedUrl || null }
    }))
    response.json({
      files: allFiles,
      signedFiles: allFiles.filter((item) => item.isSignedCopy),
      signedSignatureRequests: requests.filter((item) => item.status === 'signed'),
      pendingSignatures: requests.filter((item) => ['pending', 'viewed'].includes(item.status)),
      signatureRequests: requests,
      signatureTableConfigured,
    })
  } catch (error) {
    console.error('[workspace-list]', error?.message || error)
    response.status(signatureRequestError(error) ? 503 : error?.status || 500).json({ error: signatureRequestError(error) ? 'İmza tabloları henüz Supabase içinde oluşturulmamış.' : error?.status === 401 ? error.message : 'Workspace dosyaları listelenemedi.' })
  }
})

app.post('/api/billing/portal', requireAuth, async (request, response) => {
  try {
    const { admin, user } = request.supabaseContext
    const customerId = await ensureStripeCustomer(admin, user)
    const requestedReturnUrl = String(request.body?.returnUrl || '')
    const safeReturnUrl = requestedReturnUrl.startsWith(publicAppOrigin) ? requestedReturnUrl : publicAppOrigin
    const portal = await stripeRequest('billing_portal/sessions', {
      customer: customerId,
      return_url: safeReturnUrl,
    })
    response.json({ url: portal.url })
  } catch (error) {
    console.error('[billing-portal]', error?.message || error)
    response.status(error.status || 500).json({ error: error.status === 503 ? error.message : 'Ödeme yönetim ekranı açılamadı.' })
  }
})

app.post('/api/billing/checkout', requireAuth, async (request, response) => {
  try {
    const plan = String(request.body?.plan || '').toLowerCase()
    const price = stripePriceForPlan(plan)
    if (!price) return response.status(503).json({ error: 'Bu plan için Stripe fiyatı henüz yapılandırılmadı.' })
    const { admin, user } = request.supabaseContext
    const customerId = await ensureStripeCustomer(admin, user)
    const checkout = await stripeRequest('checkout/sessions', {
      customer: customerId,
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      success_url: `${publicAppOrigin}/?billing=success`,
      cancel_url: `${publicAppOrigin}/?billing=cancelled`,
      allow_promotion_codes: 'true',
      'metadata[supabase_user_id]': user.id,
      'subscription_data[metadata][supabase_user_id]': user.id,
    })
    response.json({ url: checkout.url })
  } catch (error) {
    console.error('[billing-checkout]', error?.message || error)
    response.status(error.status || 500).json({ error: error.status === 503 ? error.message : 'Ödeme ekranı açılamadı.' })
  }
})

app.get('/api/account/tokens', requireAuth, async (request, response) => {
  try {
    const { admin, user } = request.supabaseContext
    const ensured = await ensureAiTokenState(admin, user)
    response.json(toAiTokenUsage(ensured.state))
  } catch (error) {
    console.error('[account-tokens]', error?.message || error)
    response.status(error.status || 500).json({ error: 'AI token bakiyesi okunamadı.' })
  }
})

app.post('/api/account/email/request', requireAuth, async (request, response) => {
  try {
    const { admin, user } = request.supabaseContext
    const email = String(request.body?.email || '').trim().toLowerCase()
    if (!email || !email.includes('@')) return response.status(400).json({ error: 'Geçerli bir e-posta adresi yaz.' })
    if (email === String(user.email || '').toLowerCase()) return response.status(400).json({ error: 'Yeni e-posta mevcut adresinden farklı olmalı.' })
    const code = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000))
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    const metadata = {
      ...(user.user_metadata || {}),
      pending_email_change: { email, codeHash: hashAccessToken(`${user.id}:${email}:${code}`), expiresAt },
    }
    const { error: metadataError } = await admin.auth.admin.updateUserById(user.id, { user_metadata: metadata })
    if (metadataError) throw metadataError
    try {
      await sendResendEmail({
        to: email,
        subject: 'updateMyPDF e-posta doğrulama kodun',
        replyTo: process.env.EMAIL_FROM,
        text: `updateMyPDF hesabının e-posta adresini değiştirmek için doğrulama kodun: ${code}\n\nBu kod 10 dakika geçerlidir. Bu isteği sen başlatmadıysan bu e-postayı yok sayabilirsin.`,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#182238"><p>updateMyPDF hesabının e-posta adresini değiştirmek için doğrulama kodun:</p><p style="font-size:28px;font-weight:700;letter-spacing:7px;color:#d04a32">${code}</p><p>Bu kod 10 dakika geçerlidir. Bu isteği sen başlatmadıysan bu e-postayı yok sayabilirsin.</p></div>`,
      })
    } catch (emailError) {
      await admin.auth.admin.updateUserById(user.id, { user_metadata: { ...(user.user_metadata || {}), pending_email_change: null } }).catch(() => {})
      throw emailError
    }
    response.json({ ok: true, expiresIn: 600 })
  } catch (error) {
    console.error('[account-email-request]', error?.message || error)
    const status = error?.code === 'EMAIL_NOT_CONFIGURED' ? 503 : error?.code === 'EMAIL_PROVIDER_ERROR' ? 502 : error?.status || 500
    response.status(status).json({ error: status === 503 ? 'E-posta servisi henüz yapılandırılmadı.' : status === 502 ? 'Doğrulama e-postası gönderilemedi.' : 'E-posta doğrulama kodu oluşturulamadı.' })
  }
})

app.post('/api/account/email/verify', requireAuth, async (request, response) => {
  try {
    const { admin, user } = request.supabaseContext
    const code = String(request.body?.code || '').replace(/\D/g, '').slice(0, 6)
    if (code.length !== 6) return response.status(400).json({ error: '6 haneli doğrulama kodunu yaz.' })
    const freshUserResult = await admin.auth.admin.getUserById(user.id)
    if (freshUserResult.error || !freshUserResult.data?.user) throw freshUserResult.error || new Error('User not found.')
    const freshUser = freshUserResult.data.user
    const pending = freshUser.user_metadata?.pending_email_change
    if (!pending?.email || !pending?.codeHash || new Date(pending.expiresAt).getTime() <= Date.now()) return response.status(410).json({ error: 'Doğrulama kodunun süresi dolmuş. Yeni kod iste.' })
    if (hashAccessToken(`${user.id}:${pending.email}:${code}`) !== pending.codeHash) return response.status(400).json({ error: 'Doğrulama kodu hatalı.' })
    const nextMetadata = { ...(freshUser.user_metadata || {}) }
    delete nextMetadata.pending_email_change
    const updated = await admin.auth.admin.updateUserById(user.id, { email: pending.email, email_confirm: true, user_metadata: nextMetadata })
    if (updated.error) throw updated.error
    response.json({ ok: true, email: pending.email })
  } catch (error) {
    console.error('[account-email-verify]', error?.message || error)
    response.status(error?.status || 500).json({ error: 'E-posta adresi doğrulanamadı.' })
  }
})

app.post('/api/signatures/request', async (request, response) => {
  try {
    const { admin, user } = await getSupabaseUser(request)
    const documentPath = String(request.body?.documentPath || request.body?.path || '')
    const senderName = String(user.user_metadata?.full_name || user.email || '').trim().slice(0, 160)
    const documentName = safeFileName(request.body?.documentName || 'document.pdf')
    const message = String(request.body?.message || '').trim().slice(0, 2000)
    const workflowType = request.body?.workflowType === 'review' ? 'review' : 'signature'
    const documentLanguage = String(request.body?.documentLanguage || '').trim().slice(0, 80)
    const requestedExpiry = Number(request.body?.expiresIn || 604800)
    const expiresIn = Math.min(Math.max(Number.isFinite(requestedExpiry) ? requestedExpiry : 604800, 3600), 2592000)
    const rawSignerList = Array.isArray(request.body?.signers) && request.body.signers.length ? request.body.signers : [{ name: request.body?.recipientName, email: request.body?.recipientEmail, id: 'signer-1' }]
    const signerList = rawSignerList.slice(0, 8).map((signer, index) => ({
      id: String(signer?.id || `signer-${index + 1}`).slice(0, 120),
      name: String(signer?.name || signer?.fullName || '').trim().slice(0, 160),
      email: String(signer?.email || signer?.recipientEmail || '').trim().toLowerCase().slice(0, 320),
    }))
    const signaturePlacements = request.body?.signaturePlacements && typeof request.body.signaturePlacements === 'object' ? request.body.signaturePlacements : {}
    const signerEntries = signerList.map((signer, index) => ({
      ...signer,
      signaturePlacement: normalizeSignaturePlacement(signaturePlacements[signer.id] || (Array.isArray(request.body?.signaturePlacements) ? request.body.signaturePlacements[index] : null) || request.body?.signaturePlacement),
    }))
    if (!documentPath.startsWith(`${user.id}/`)) return response.status(403).json({ error: 'Bu PDF için imza isteği oluşturma iznin yok.' })
    if (!signerEntries.length) return response.status(400).json({ error: 'En az bir signer gerekli.' })
    if (workflowType === 'review' && signerEntries.length > 1) return response.status(400).json({ error: 'İnceleme akışında yalnızca bir kişi seçilebilir.' })
    if (signerEntries.some((signer) => !signer.email || !signer.email.includes('@'))) return response.status(400).json({ error: 'Her signer için geçerli bir e-posta adresi gerekli.' })
    if (signerEntries.some((signer) => !signer.name)) return response.status(400).json({ error: 'Her signer için ad soyad gerekli.' })
    if (new Set(signerEntries.map((signer) => signer.email)).size !== signerEntries.length) return response.status(400).json({ error: 'Aynı e-posta adresi birden fazla signer olarak eklenemez.' })
    const signedSource = await admin.storage.from('pdfs').createSignedUrl(documentPath, 3600)
    if (signedSource.error || !signedSource.data?.signedUrl) return response.status(404).json({ error: 'İmza istenen PDF cloud storage içinde bulunamadı.' })

    const batchId = signerEntries.length > 1 ? randomBytes(16).toString('hex') : null
    const firstRawToken = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
    const batchSigners = signerEntries.map((signer, index) => ({ name: signer.name, email: signer.email, index }))
    const rows = signerEntries.map((signer, index) => ({
      owner_id: user.id,
      document_path: documentPath,
      document_name: documentName,
      workflow_type: workflowType,
      recipient_email: signer.email,
      recipient_name: signer.name,
      message: message || null,
      token_hash: hashAccessToken(index === 0 ? firstRawToken : randomBytes(32).toString('hex')),
      expires_at: expiresAt,
      metadata: { senderName, senderEmail: user.email, signaturePlacement: signer.signaturePlacement, documentLanguage: documentLanguage || null, batchId, signerIndex: index, signerCount: signerEntries.length, signers: batchSigners, expiresIn },
    }))
    const { data: insertedRows, error: insertError } = await admin.from('signature_requests').insert(rows).select('id,recipient_email,recipient_name')
    if (insertError) throw insertError

    const firstSigner = signerEntries[0]
    const firstInserted = insertedRows?.[0]
    const reviewUrl = `${publicAppOrigin}/review/${firstRawToken}`
    const title = workflowType === 'review' ? 'PDF review request' : 'PDF signature request'
    const greeting = `Hello ${escapeHtml(firstSigner.name)},`
    const bodyText = message ? `<p>${escapeHtml(message)}</p>` : ''
    const workflowNote = signerEntries.length > 1 ? `<p>This is a sequential signing workflow for ${signerEntries.length} people. You are signer 1 of ${signerEntries.length}; the next signer will receive the document after you complete your signature.</p>` : ''
    const emailResult = await sendResendEmail({
      to: firstSigner.email,
      subject: `${title}: ${documentName}`,
      replyTo: process.env.EMAIL_FROM,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#182238"><p>${greeting}</p>${bodyText}<p><strong>${escapeHtml(senderName)}</strong> asked you to ${workflowType === 'review' ? 'review' : 'sign'} <strong>${escapeHtml(documentName)}</strong>.</p>${workflowNote}<p><a href="${escapeHtml(reviewUrl)}" style="display:inline-block;padding:12px 18px;background:#e45235;color:#fff;text-decoration:none;border-radius:8px">Open PDF</a></p><p>This link expires on ${escapeHtml(expiresAt)}.</p></div>`,
      text: `${greeting.replaceAll('&lt;', '<').replaceAll('&gt;', '>')}\n\n${senderName} asked you to ${workflowType === 'review' ? 'review' : 'sign'} ${documentName}.\n${message}\n${signerEntries.length > 1 ? `\nYou are signer 1 of ${signerEntries.length}. The next signer will receive the PDF after you complete your signature.\n` : ''}\nOpen PDF: ${reviewUrl}\nExpires: ${expiresAt}`,
    })
    await admin.from('signature_requests').update({ sent_at: new Date().toISOString() }).eq('id', firstInserted.id)
    await addAuditEvent(admin, { ownerId: user.id, requestId: firstInserted.id, eventType: 'request_created', actorEmail: user.email, details: { workflowType, recipientEmail: firstSigner.email, documentName, signerCount: signerEntries.length, batchId } })
    await addAuditEvent(admin, { ownerId: user.id, requestId: firstInserted.id, eventType: 'email_sent', actorEmail: user.email, details: { provider: 'resend', providerMessageId: emailResult.id || null, signerCount: signerEntries.length } })
    response.json({ id: firstInserted.id, requestIds: (insertedRows || []).map((row) => row.id), status: 'pending', workflowType, expiresAt, reviewUrl, emailId: emailResult.id || null, signerCount: signerEntries.length, signers: batchSigners })
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

app.post('/api/signatures/:id/resend', requireAuth, async (request, response) => {
  try {
    const { admin, user } = request.supabaseContext
    const { data, error } = await admin.from('signature_requests').select('id,owner_id,document_path,document_name,workflow_type,recipient_email,recipient_name,message,status,expires_at,metadata').eq('id', request.params.id).eq('owner_id', user.id).maybeSingle()
    if (error) throw error
    if (!data) return response.status(404).json({ error: 'İmza isteği bulunamadı.' })
    if (['signed', 'declined', 'cancelled'].includes(data.status)) return response.status(409).json({ error: 'Bu istek tekrar gönderilemez.' })
    if (data.metadata?.batchId && Number(data.metadata?.signerIndex) > 0) {
      const { data: previousSigner, error: previousError } = await admin.from('signature_requests').select('status').eq('owner_id', user.id).contains('metadata', { batchId: data.metadata.batchId }).eq('metadata->>signerIndex', String(Number(data.metadata.signerIndex) - 1)).maybeSingle()
      if (previousError) throw previousError
      if (!previousSigner || previousSigner.status !== 'signed') return response.status(409).json({ error: 'Bu signer’ın sırası henüz gelmedi.' })
    }
    const signedSource = await admin.storage.from('pdfs').createSignedUrl(data.document_path, 3600)
    if (signedSource.error || !signedSource.data?.signedUrl) return response.status(404).json({ error: 'İmza istenen PDF cloud storage içinde bulunamadı.' })
    const requestedExpiry = Number(request.body?.expiresIn || 604800)
    const expiresIn = Math.min(Math.max(Number.isFinite(requestedExpiry) ? requestedExpiry : 604800, 3600), 2592000)
    const rawToken = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
    const reviewUrl = `${publicAppOrigin}/review/${rawToken}`
    const title = data.workflow_type === 'review' ? 'PDF review request' : 'PDF signature request'
    const greeting = `Hello ${escapeHtml(data.recipient_name || data.recipient_email)},`
    const bodyText = data.message ? `<p>${escapeHtml(data.message)}</p>` : ''
    const sentAt = new Date().toISOString()
    const { error: updateError } = await admin.from('signature_requests').update({ token_hash: hashAccessToken(rawToken), status: 'pending', expires_at: expiresAt, sent_at: sentAt, viewed_at: null }).eq('id', data.id).eq('owner_id', user.id)
    if (updateError) throw updateError
    const emailResult = await sendResendEmail({
      to: data.recipient_email,
      subject: `${title}: ${data.document_name}`,
      replyTo: process.env.EMAIL_FROM,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#182238"><p>${greeting}</p>${bodyText}<p><strong>${escapeHtml(user.user_metadata?.full_name || user.email || '')}</strong> sent you a new ${data.workflow_type === 'review' ? 'review' : 'signature'} request for <strong>${escapeHtml(data.document_name)}</strong>.</p><p><a href="${escapeHtml(reviewUrl)}" style="display:inline-block;padding:12px 18px;background:#e45235;color:#fff;text-decoration:none;border-radius:8px">Open PDF</a></p><p>This link expires on ${escapeHtml(expiresAt)}.</p></div>`,
      text: `${greeting.replaceAll('&lt;', '<').replaceAll('&gt;', '>')}\n\n${user.user_metadata?.full_name || user.email || 'The sender'} sent you a new ${data.workflow_type === 'review' ? 'review' : 'signature'} request for ${data.document_name}.\n${data.message || ''}\n\nOpen PDF: ${reviewUrl}\nExpires: ${expiresAt}`,
    })
    try {
      await addAuditEvent(admin, { ownerId: user.id, requestId: data.id, eventType: 'request_resent', actorEmail: user.email, details: { recipientEmail: data.recipient_email, provider: 'resend', providerMessageId: emailResult.id || null, expiresAt } })
    } catch (auditError) {
      console.error('[signature-resend-audit]', auditError?.message || auditError)
    }
    response.json({ id: data.id, status: 'pending', expiresAt, reviewUrl, emailId: emailResult.id || null })
  } catch (error) {
    console.error('[signature-resend]', error?.message || error)
    const status = error?.status || (signatureRequestError(error) ? 503 : error?.code === 'EMAIL_PROVIDER_ERROR' ? 502 : 500)
    const message = signatureRequestError(error)
      ? 'İmza tablosu henüz Supabase içinde oluşturulmamış.'
      : error?.code === 'EMAIL_NOT_CONFIGURED'
        ? 'Resend e-posta ayarları eksik.'
        : error?.code === 'EMAIL_PROVIDER_ERROR'
          ? 'Resend e-posta gönderimini reddetti; domain ve sender ayarlarını kontrol et.'
          : 'İmza isteği tekrar gönderilemedi.'
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

app.get('/api/signatures/:id/document', requireAuth, async (request, response) => {
  try {
    const { admin, user } = request.supabaseContext
    const { data, error } = await admin.from('signature_requests').select('id,owner_id,document_name,workflow_type,recipient_email,recipient_name,status,created_at,signed_at,message,metadata').eq('id', request.params.id).eq('owner_id', user.id).maybeSingle()
    if (error) throw error
    if (!data) return response.status(404).json({ error: 'İmzalı belge bulunamadı.' })
    if (data.status !== 'signed') return response.status(409).json({ error: 'Bu belge henüz imzalanmış değil.' })
    const signedDocumentPath = data.metadata?.signedDocumentPath || null
    if (!signedDocumentPath) return response.status(404).json({ error: 'İmzalı PDF kaydı bulunamadı.' })
    const signed = await admin.storage.from('pdfs').createSignedUrl(signedDocumentPath, 604800)
    if (signed.error || !signed.data?.signedUrl) return response.status(404).json({ error: 'İmzalı PDF artık erişilebilir değil.' })
    response.json({
      document: {
        id: data.id,
        documentName: data.document_name,
        workflowType: data.workflow_type,
        recipientEmail: data.recipient_email,
        recipientName: data.recipient_name,
        status: data.status,
        createdAt: data.created_at,
        signedAt: data.signed_at,
        message: data.message,
        signedDocumentUrl: signed.data.signedUrl,
        senderName: user.user_metadata?.full_name || user.email || 'updateMyPDF kullanıcısı',
        senderEmail: user.email || '',
      },
    })
  } catch (error) {
    console.error('[signature-document]', error?.message || error)
    response.status(signatureRequestError(error) ? 503 : error?.status || 500).json({ error: signatureRequestError(error) ? 'İmza tabloları henüz Supabase içinde oluşturulmamış.' : error?.status === 401 ? error.message : 'İmzalı belge açılamadı.' })
  }
})

app.post('/api/signatures/:id/email', requireAuth, async (request, response) => {
  try {
    const { admin, user } = request.supabaseContext
    const recipient = String(request.body?.to || '').trim().slice(0, 320)
    const message = String(request.body?.message || '').trim().slice(0, 2000)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return response.status(400).json({ error: 'Geçerli bir alıcı e-posta adresi yaz.' })
    const { data, error } = await admin.from('signature_requests').select('id,owner_id,document_name,recipient_email,recipient_name,status,signed_at,metadata').eq('id', request.params.id).eq('owner_id', user.id).maybeSingle()
    if (error) throw error
    if (!data) return response.status(404).json({ error: 'İmzalı belge bulunamadı.' })
    if (data.status !== 'signed') return response.status(409).json({ error: 'Yalnızca imzalanmış belgeler e-posta ile gönderilebilir.' })
    const signedDocumentPath = data.metadata?.signedDocumentPath || null
    if (!signedDocumentPath) return response.status(404).json({ error: 'İmzalı PDF kaydı bulunamadı.' })
    const signed = await admin.storage.from('pdfs').createSignedUrl(signedDocumentPath, 604800)
    if (signed.error || !signed.data?.signedUrl) return response.status(404).json({ error: 'İmzalı PDF artık erişilebilir değil.' })
    const signedFile = await admin.storage.from('pdfs').download(signedDocumentPath)
    if (signedFile.error || !signedFile.data) throw signedFile.error || new Error('Signed PDF could not be downloaded.')
    const signedPdfBytes = Buffer.from(await signedFile.data.arrayBuffer())
    const signedFileName = `${safeFileName(data.document_name).replace(/\.pdf$/i, '')}-signed.pdf`
    const canAttach = signedPdfBytes.length <= 29 * 1024 * 1024
    const attachments = canAttach ? [{ content: signedPdfBytes.toString('base64'), filename: signedFileName }] : []
    const senderName = String(user.user_metadata?.full_name || user.email || 'updateMyPDF kullanıcısı').trim()
    const emailResult = await sendResendEmail({
      to: recipient,
      subject: `İmzalı PDF: ${data.document_name}`,
      replyTo: process.env.EMAIL_FROM,
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#30343a"><p><strong>${escapeHtml(senderName)}</strong> seninle imzalı bir PDF paylaştı.</p>${message ? `<p>${escapeHtml(message)}</p>` : ''}<p><strong>${escapeHtml(data.document_name)}</strong></p><p><a href="${escapeHtml(signed.data.signedUrl)}" style="display:inline-block;padding:12px 18px;background:#e45235;color:#fff;text-decoration:none;border-radius:8px">İmzalı PDF’i aç</a></p><p>${canAttach ? 'PDF ayrıca e-postaya eklenmiştir.' : 'Dosya boyutu nedeniyle PDF, güvenli bağlantı üzerinden açılabilir.'}</p></div>`,
      text: `${senderName} seninle imzalı bir PDF paylaştı.\n\n${message ? `${message}\n\n` : ''}${data.document_name}\n\nİmzalı PDF’i aç: ${signed.data.signedUrl}${canAttach ? '\n\nPDF ayrıca e-postaya eklenmiştir.' : ''}`,
      attachments,
    })
    try {
      await addAuditEvent(admin, { ownerId: user.id, requestId: data.id, eventType: 'signed_copy_emailed', actorEmail: user.email, details: { recipient, provider: 'resend', providerMessageId: emailResult.id || null, attached: canAttach } })
    } catch (auditError) {
      console.error('[signature-document-email-audit]', auditError?.message || auditError)
    }
    response.json({ ok: true, emailId: emailResult.id || null, attached: canAttach })
  } catch (error) {
    console.error('[signature-document-email]', error?.message || error)
    const status = error?.status || (signatureRequestError(error) ? 503 : error?.code === 'EMAIL_PROVIDER_ERROR' ? 502 : 500)
    const message = signatureRequestError(error)
      ? 'İmza tabloları henüz Supabase içinde oluşturulmamış.'
      : error?.code === 'EMAIL_NOT_CONFIGURED'
        ? 'Resend e-posta ayarları eksik.'
        : error?.code === 'EMAIL_PROVIDER_ERROR'
          ? 'E-posta sağlayıcısı gönderimi reddetti; Resend ayarlarını kontrol et.'
          : error?.status === 401
            ? error.message
            : 'İmzalı PDF e-posta ile gönderilemedi.'
    response.status(status).json({ error: message })
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
    const signatureStyle = normalizeSignatureStyle(request.body?.signatureStyle)
    if (!signatureText) return response.status(400).json({ error: 'İmza metni gerekli.' })
    const { data, error } = await admin.from('signature_requests').select('id,owner_id,recipient_email,recipient_name,document_path,document_name,workflow_type,status,expires_at,message,metadata').eq('token_hash', hashAccessToken(request.params.token)).maybeSingle()
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
    const language = String(data.metadata?.documentLanguage || '').toLowerCase()
    const signatureLabels = language.includes('turk') || language.includes('türk') || language.startsWith('tr')
      ? { name: 'İmzalayan adı:', signature: 'İmza:' }
      : language.includes('span') || language.startsWith('es')
        ? { name: 'Nombre del firmante:', signature: 'Firma:' }
        : language.includes('fren') || language.startsWith('fr')
          ? { name: 'Nom du signataire:', signature: 'Signature:' }
          : language.includes('germ') || language.startsWith('de')
            ? { name: 'Name des Unterzeichners:', signature: 'Unterschrift:' }
            : { name: 'Signer name:', signature: 'Signature:' }
    const signatureSize = Math.max(12, Math.min(18, fieldHeight * 0.24))
    const labelSize = Math.max(7, Math.min(10, fieldHeight * 0.12))
    const nameSize = Math.max(8, Math.min(12, fieldHeight * 0.14))
    const signatureY = Math.min(pageHeight - 24, fieldBottom + 10)
    const signatureLabelY = Math.min(pageHeight - 18, signatureY + signatureSize + 8)
    const nameValueY = Math.min(pageHeight - 18, signatureLabelY + labelSize + 8)
    const nameLabelY = Math.min(pageHeight - 18, nameValueY + nameSize + 6)
    const signedActions = [
      { type: 'add_text', page: pageNumber, text: signatureLabels.name, x: fieldX, y: nameLabelY, size: labelSize, fontWeight: 'bold', color: 'black' },
      { type: 'add_text', page: pageNumber, text: data.recipient_name || '', x: fieldX, y: nameValueY, size: nameSize, color: 'black' },
      { type: 'add_text', page: pageNumber, text: signatureLabels.signature, x: fieldX, y: signatureLabelY, size: labelSize, fontWeight: 'bold', color: 'black' },
      {
        type: 'fill_and_sign',
        page: pageNumber,
        text: signatureText,
        signatureStyle,
        x: fieldX,
        y: signatureY,
        width: fieldWidth,
        height: fieldHeight,
        size: signatureSize,
        color: 'blue',
      },
    ]
    const signedPdf = await applyEditPlan(sourceBuffer, signedActions)
    const signedPdfSha256 = createHash('sha256').update(signedPdf.pdfBytes).digest('hex')
    signatureStage = 'upload-signed-pdf'
    const signedPath = `${data.owner_id}/${Date.now()}-signed-${safeFileName(data.document_name)}`
    const { error: uploadError } = await admin.storage.from('pdfs').upload(signedPath, signedPdf.pdfBytes, { contentType: 'application/pdf', upsert: false })
    if (uploadError) throw uploadError
    const signedAt = new Date().toISOString()
    const batchId = data.metadata?.batchId || null
    const signerIndex = Number.isFinite(Number(data.metadata?.signerIndex)) ? Number(data.metadata.signerIndex) : 0
    const signerCount = Math.max(1, Number(data.metadata?.signerCount) || 1)
    const metadata = { ...(data.metadata || {}), signatureStyle, signedDocumentPath: signedPath, signedAt, signedDocumentSha256: signedPdfSha256 }
    signatureStage = 'save-signature-record'
    const { error: updateError } = await admin.from('signature_requests').update({ status: 'signed', signed_at: signedAt, signature_text: signatureText, metadata }).eq('id', data.id)
    if (updateError) throw updateError
    try {
      await addAuditEvent(admin, { ownerId: data.owner_id, requestId: data.id, eventType: 'request_signed', actorEmail: data.recipient_email, details: { signatureTextLength: signatureText.length, signatureStyle, signedDocumentPath: signedPath, signedDocumentSha256: signedPdfSha256, ip: request.ip || null, userAgent: request.headers['user-agent'] || null } })
    } catch (auditError) {
      console.error('[signature-audit-after-sign]', auditError?.message || auditError)
    }
    let batchRows = [data]
    if (batchId) {
      const { data: loadedBatchRows, error: batchError } = await admin.from('signature_requests').select('id,owner_id,document_path,document_name,recipient_email,recipient_name,status,signed_at,metadata').eq('owner_id', data.owner_id).contains('metadata', { batchId })
      if (batchError) throw batchError
      batchRows = (loadedBatchRows || []).sort((left, right) => (Number(left.metadata?.signerIndex) || 0) - (Number(right.metadata?.signerIndex) || 0))
    }
    const signedCopy = await admin.storage.from('pdfs').createSignedUrl(signedPath, 604800)
    const signedCopyUrl = signedCopy.data?.signedUrl || null
    const nextSigner = batchRows.find((row) => Number(row.metadata?.signerIndex) === signerIndex + 1 && !['signed', 'declined', 'cancelled'].includes(row.status))
    if (nextSigner) {
      const nextRawToken = randomBytes(32).toString('hex')
      const nextExpiresAt = new Date(Date.now() + Math.max(3600, Number(data.metadata?.expiresIn) || 604800) * 1000).toISOString()
      const nextMetadata = { ...(nextSigner.metadata || {}), previousSignedDocumentPath: signedPath, previousSignedAt: signedAt }
      const { error: nextUpdateError } = await admin.from('signature_requests').update({ document_path: signedPath, token_hash: hashAccessToken(nextRawToken), status: 'pending', expires_at: nextExpiresAt, sent_at: new Date().toISOString(), viewed_at: null, metadata: nextMetadata }).eq('id', nextSigner.id).eq('owner_id', data.owner_id)
      if (nextUpdateError) throw nextUpdateError
      const nextReviewUrl = `${publicAppOrigin}/review/${nextRawToken}`
      let nextEmailId = null
      let nextEmailError = null
      try {
        const nextEmail = await sendSignatureInviteEmail({ recipientEmail: nextSigner.recipient_email, recipientName: nextSigner.recipient_name, senderName: data.metadata?.senderName || data.owner_id, documentName: data.document_name, workflowType: data.workflow_type, message: data.message, reviewUrl: nextReviewUrl, expiresAt: nextExpiresAt, signerIndex: signerIndex + 1, signerCount })
        nextEmailId = nextEmail.id || null
        await addAuditEvent(admin, { ownerId: data.owner_id, requestId: nextSigner.id, eventType: 'email_sent', actorEmail: data.recipient_email, details: { provider: 'resend', providerMessageId: nextEmail.id || null, signerIndex: signerIndex + 1, batchId } })
      } catch (inviteError) {
        nextEmailError = inviteError.message || 'Sıradaki signer’a e-posta gönderilemedi.'
        console.error('[signature-next-invite]', inviteError?.message || inviteError)
      }
      response.json({ ok: true, status: 'signed', signedAt, signedDocumentPath: signedPath, signedCopyUrl, final: false, signerIndex, signerCount, nextSigner: { name: nextSigner.recipient_name, email: nextSigner.recipient_email, index: signerIndex + 1 }, nextReviewUrl, nextEmailId, nextEmailError })
      return
    }
    const finalMetadata = { finalSignedDocumentPath: signedPath, finalSignedAt: signedAt, finalSignedDocumentSha256: signedPdfSha256 }
    if (batchId) {
      for (const row of batchRows) {
        const rowMetadata = { ...(row.metadata || {}), ...finalMetadata, signedDocumentPath: signedPath }
        const { error: finalUpdateError } = await admin.from('signature_requests').update({ metadata: rowMetadata }).eq('id', row.id).eq('owner_id', data.owner_id)
        if (finalUpdateError) throw finalUpdateError
      }
    }
    const finalNotification = await notifyFinalSignedCopy({ admin, ownerId: data.owner_id, documentName: data.document_name, signerRows: batchRows, signedPdfBytes: signedPdf.pdfBytes, signedCopyUrl })
    response.json({ ok: true, status: 'signed', signedAt, signedDocumentPath: signedPath, signedCopyUrl, final: true, signerIndex, signerCount, notifiedEmails: finalNotification.notifiedEmails, attached: finalNotification.canAttach })
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

app.post('/api/signatures/:token/decline', async (request, response) => {
  try {
    const admin = getSupabaseAdmin()
    const reason = String(request.body?.reason || '').trim().slice(0, 1000)
    const { data, error } = await admin.from('signature_requests').select('id,owner_id,recipient_email,recipient_name,document_name,status,expires_at,metadata').eq('token_hash', hashAccessToken(request.params.token)).maybeSingle()
    if (error) throw error
    if (!data) return response.status(404).json({ error: 'İmza bağlantısı bulunamadı.' })
    if (new Date(data.expires_at).getTime() <= Date.now()) return response.status(410).json({ error: 'İmza bağlantısının süresi dolmuş.' })
    if (['signed', 'declined', 'cancelled'].includes(data.status)) return response.status(409).json({ error: 'Bu istek artık değiştirilemez.' })

    const declinedAt = new Date().toISOString()
    const metadata = { ...(data.metadata || {}), declinedAt, declineReason: reason || null }
    const { error: updateError } = await admin.from('signature_requests').update({ status: 'declined', metadata }).eq('id', data.id)
    if (updateError) throw updateError
    if (data.metadata?.batchId) {
      const { error: batchCancelError } = await admin.from('signature_requests').update({ status: 'cancelled', metadata: { declinedAt, batchStoppedBy: data.recipient_email } }).eq('owner_id', data.owner_id).contains('metadata', { batchId: data.metadata.batchId }).in('status', ['pending', 'viewed'])
      if (batchCancelError) throw batchCancelError
    }
    try {
      await addAuditEvent(admin, { ownerId: data.owner_id, requestId: data.id, eventType: 'request_declined', actorEmail: data.recipient_email, details: { reason: reason || null, ip: request.ip || null, userAgent: request.headers['user-agent'] || null } })
    } catch (auditError) {
      console.error('[signature-decline-audit]', auditError?.message || auditError)
    }

    const notifiedEmails = []
    try {
      const owner = await admin.auth.admin.getUserById(data.owner_id)
      const ownerEmail = owner.data?.user?.email || ''
      if (ownerEmail) {
        await sendResendEmail({
          to: ownerEmail,
          subject: `Signature request declined: ${data.document_name}`,
          replyTo: process.env.EMAIL_FROM,
          text: `${data.recipient_email} declined the request for ${data.document_name}.${reason ? ` Reason: ${reason}` : ''}`,
          html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#182238"><p><strong>${escapeHtml(data.recipient_email)}</strong> declined the request for <strong>${escapeHtml(data.document_name)}</strong>.</p>${reason ? `<p>Reason: ${escapeHtml(reason)}</p>` : ''}</div>`,
        })
        notifiedEmails.push(ownerEmail)
      }
    } catch (notificationError) {
      console.error('[signature-decline-notification]', notificationError?.message || notificationError)
    }
    response.json({ ok: true, status: 'declined', declinedAt, notifiedEmails })
  } catch (error) {
    console.error('[signature-decline]', error?.message || error)
    response.status(signatureRequestError(error) ? 503 : error?.status || 500).json({ error: signatureRequestError(error) ? 'İmza tabloları henüz Supabase içinde oluşturulmamış.' : 'İmza isteği reddedilemedi.' })
  }
})

app.post('/api/signatures/:id/cancel', requireAuth, async (request, response) => {
  try {
    const { admin, user } = request.supabaseContext
    const { data, error } = await admin.from('signature_requests').select('id,owner_id,document_name,recipient_email,status,metadata').eq('id', request.params.id).eq('owner_id', user.id).maybeSingle()
    if (error) throw error
    if (!data) return response.status(404).json({ error: 'İmza isteği bulunamadı.' })
    if (['signed', 'declined', 'cancelled', 'expired'].includes(data.status)) return response.status(409).json({ error: 'Bu istek artık iptal edilemez.' })
    const cancelledAt = new Date().toISOString()
    const updatePayload = { status: 'cancelled', metadata: { ...(data.metadata || {}), cancelledAt } }
    const { error: updateError } = data.metadata?.batchId
      ? await admin.from('signature_requests').update(updatePayload).eq('owner_id', user.id).contains('metadata', { batchId: data.metadata.batchId }).in('status', ['pending', 'viewed'])
      : await admin.from('signature_requests').update(updatePayload).eq('id', data.id).eq('owner_id', user.id)
    if (updateError) throw updateError
    try {
      await addAuditEvent(admin, { ownerId: user.id, requestId: data.id, eventType: 'request_cancelled', actorEmail: user.email, details: { recipientEmail: data.recipient_email } })
    } catch (auditError) {
      console.error('[signature-cancel-audit]', auditError?.message || auditError)
    }
    response.json({ ok: true, status: 'cancelled', cancelledAt })
  } catch (error) {
    console.error('[signature-cancel]', error?.message || error)
    response.status(signatureRequestError(error) ? 503 : error?.status || 500).json({ error: signatureRequestError(error) ? 'İmza tabloları henüz Supabase içinde oluşturulmamış.' : 'İmza isteği iptal edilemedi.' })
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

app.post('/api/ai/assistant', async (request, response) => {
  const message = String(request.body?.message || '').trim().slice(0, 8000)
  const phase = String(request.body?.phase || 'intake').slice(0, 32)
  const conversation = Array.isArray(request.body?.conversation)
    ? request.body.conversation.filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').slice(-8)
    : []
  const sourceProfile = request.body?.profile && typeof request.body.profile === 'object' ? request.body.profile : {}
  const profile = {
    documentType: typeof sourceProfile.documentType === 'string' ? sourceProfile.documentType.slice(0, 180) : null,
    documentTitle: typeof sourceProfile.documentTitle === 'string' ? sourceProfile.documentTitle.slice(0, 180) : null,
    documentLanguage: typeof sourceProfile.documentLanguage === 'string' ? sourceProfile.documentLanguage.slice(0, 80) : null,
    jurisdiction: typeof sourceProfile.jurisdiction === 'string' ? sourceProfile.jurisdiction.slice(0, 240) : null,
    facts: Array.isArray(sourceProfile.facts) ? sourceProfile.facts.filter((fact) => fact && typeof fact.key === 'string' && typeof fact.value === 'string').slice(-50).map((fact) => ({ key: fact.key.slice(0, 100), value: fact.value.slice(0, 1200) })) : [],
  }
  if (!message) return response.status(400).json({ error: 'Mesaj gerekli.' })
  let tokenContext = null
  try {
    tokenContext = await prepareAiTokenUse(request)
  } catch (error) {
    return response.status(error.status || 500).json({ error: error.message || 'AI token bakiyesi kullanılamıyor.', tokenUsage: error.tokenUsage || null })
  }
  try {
    const client = getClient()
    const likelyDraft = phase === 'draft' || profile.facts.length >= 6 || message.length >= 320
    const profileContext = JSON.stringify(profile)
    const input = [
      ...conversation.map((item) => ({ role: item.role, content: [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.content.slice(0, 8000) }] })),
      { role: 'user', content: [{ type: 'input_text', text: `Current user message:\n${message}\n\nCompact structured profile from earlier turns:\n${profileContext}` }] },
    ]
    const result = await client.responses.create({
      model: assistantModel(),
      reasoning: { effort: likelyDraft ? (process.env.OPENAI_ASSISTANT_DRAFT_REASONING || 'medium') : assistantReasoning() },
      store: false,
      instructions: documentAssistantInstructions,
      input,
      tools: [{ type: 'web_search', search_context_size: likelyDraft ? 'medium' : 'low' }],
      max_output_tokens: likelyDraft ? 12000 : 1800,
      text: {
        verbosity: likelyDraft ? 'medium' : 'low',
        format: {
          type: 'json_schema',
          name: 'document_assistant_response',
          strict: true,
          schema: documentAssistantSchema,
        },
      },
    })
    if (!result.output_text?.trim()) throw new Error('The document assistant returned an empty response.')
    const assistantResult = JSON.parse(result.output_text)
    const extractedSources = extractResponseSources(result)
    assistantResult.researchSources = extractedSources.length ? extractedSources : normalizeAssistantSources(assistantResult.researchSources)
    let generatedPdf = null
    let generatedFileName = null
    if (assistantResult.status === 'draft_ready' && assistantResult.documentContent?.trim()) {
      const title = assistantResult.documentTitle || 'updateMyPDF document draft'
      const pdfBytes = await createTextPdfBuffer(title, assistantResult.documentContent, { documentLanguage: assistantResult.documentLanguage, jurisdiction: assistantResult.jurisdiction })
      generatedPdf = pdfBytes.toString('base64')
      generatedFileName = `${safeFileName(title).replace(/\.pdf$/i, '') || 'document-draft'}.pdf`
    }
    const tokenUsage = await consumeAiTokens(tokenContext)
    response.json({ ...assistantResult, generatedPdf, generatedFileName, model: assistantModel(), reasoningEffort: likelyDraft ? (process.env.OPENAI_ASSISTANT_DRAFT_REASONING || 'medium') : assistantReasoning(), tokenUsage })
  } catch (error) {
    console.error('[ai-assistant]', error?.message || error)
    const status = error?.status === 401 ? 401 : error?.status === 402 ? 402 : 500
    response.status(status).json({ error: status === 401 ? 'OpenAI API anahtarı geçersiz veya yetkisiz.' : status === 402 ? error.message : `Belge asistanı yanıt veremedi${process.env.NODE_ENV === 'production' ? '.' : ` (${error?.message || 'unknown error'})`}` })
  }
})

app.post('/api/ai/command', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (request, response) => {
  const prompt = String(request.body?.prompt || '').trim()
  const sourceFile = request.files?.file?.[0]
  const imageFile = request.files?.image?.[0]
  if (!prompt) return response.status(400).json({ error: 'Prompt is required.' })
  if (!sourceFile) return response.status(400).json({ error: 'A PDF file is required.' })
  if (sourceFile.mimetype !== 'application/pdf') return response.status(400).json({ error: 'Only PDF files are supported.' })
  if (imageFile && !['image/png', 'image/jpeg'].includes(imageFile.mimetype)) return response.status(400).json({ error: 'Only PNG or JPEG images are supported.' })

  let tokenContext = null
  try {
    tokenContext = await prepareAiTokenUse(request)
  } catch (error) {
    return response.status(error.status || 500).json({ error: error.message || 'AI token bakiyesi kullanılamıyor.', tokenUsage: error.tokenUsage || null })
  }

  try {
    const client = getClient()
    const translationMode = /(?:çevir|çeviri|translate|translation|traduc|traduce|ingilizce|english|ispanyolca|spanish|español)/i.test(prompt)
    const targetLanguageHint = /(?:ingilizce|english)/i.test(prompt) ? 'English' : /(?:türkçe|turkish|turkce)/i.test(prompt) ? 'Turkish' : /(?:ispanyolca|spanish|español)/i.test(prompt) ? 'Spanish' : 'the language explicitly requested by the user'
    let extractedTranslationText = ''
    let extractedTranslationPages = []
    let extractedImageTextPages = []
    if (translationMode) {
      const extractedPages = await extractTextPages(sourceFile.buffer)
      extractedTranslationPages = extractedPages.filter((page) => page.text)
      extractedTranslationText = extractedTranslationPages
        .map((page) => `[Page ${page.page}]\n${(page.lines?.length ? page.lines : [page.text]).join('\n')}`)
        .join('\n\n')
        .slice(0, 120000)
      try {
        extractedImageTextPages = await ocrImageText(sourceFile.buffer, 'spa+eng')
      } catch (ocrError) {
        console.error('[translation-image-ocr]', ocrError?.message || ocrError)
      }
    }
    const content = []
    if (translationMode && extractedTranslationText) {
      content.push({
        type: 'input_text',
        text: `The PDF text was extracted locally to make this translation fast and exact. Preserve the page numbers and create replacement actions for the identifiable source text blocks.\n\n${extractedTranslationText}`,
      })
    } else {
      const base64Pdf = sourceFile.buffer.toString('base64')
      content.push({
        type: 'input_file',
        filename: sourceFile.originalname || 'document.pdf',
        file_data: `data:application/pdf;base64,${base64Pdf}`,
        detail: 'low',
      })
    }
    if (imageFile) content.push({
      type: 'input_image',
      image_url: `data:${imageFile.mimetype};base64,${imageFile.buffer.toString('base64')}`,
    })
    content.push({ type: 'input_text', text: prompt })
    const commandInstructions = translationMode
      ? `You are a professional document translator inside a PDF editor. The user explicitly requested a complete translation into ${targetLanguageHint}.
Automatically identify the source language from the extracted PDF text; the user must never be required to name the source language. Detect mixed-language pages independently and translate every non-target portion. Translate every piece of prose on every page. Never summarize, shorten, paraphrase, omit sentences, omit paragraphs, or say that translation is unnecessary. Preserve names, numbers, dates, headings, labels, punctuation, and the order of the content. Treat mixed-language text, Lorem Ipsum, pseudo-Latin, filler text, and placeholder prose as non-target content; do not leave it unchanged just because it is not normal modern prose. Translate or rewrite that content into coherent ${targetLanguageHint} while keeping its sentence and paragraph coverage. The source text is grouped by page and its line breaks represent the original visual layout. For each page, return exactly one translate action. The replacement must contain the COMPLETE translation of that page and must preserve the same line-break structure as the source as closely as possible. If a page is already partly in ${targetLanguageHint}, keep the existing target-language text but translate all other text. Never skip the final page. Return only the compact translation JSON schema fields; do not return explanations, summaries, or null fields.`
      : systemInstructions
    const planRequest = {
      model: translationMode ? translationModel() : pdfEditorModel(),
      instructions: commandInstructions,
      input: [{
        role: 'user',
        content,
      }],
      text: {
        format: {
          type: 'json_schema',
          name: translationMode ? 'pdf_translation_plan' : 'pdf_edit_plan',
          strict: true,
          schema: translationMode ? translationPlanSchema : editPlanSchema,
        },
      },
      max_output_tokens: translationMode ? 24000 : 8000,
      reasoning: { effort: translationMode ? 'medium' : 'low' },
    }
    const largeTranslation = translationMode && (extractedTranslationPages.length > 12 || extractedTranslationText.length >= 90000)
    let result = null
    if (!largeTranslation) {
      result = await client.responses.create(planRequest, { timeout: 180000 })
      if (!result.output_text?.trim()) throw new Error('The model returned an empty response.')
    }
    const normalizeTranslationPlan = (candidate) => {
      if (!translationMode || !extractedTranslationPages.length) return candidate
      const actionsByPage = new Map((Array.isArray(candidate.actions) ? candidate.actions : []).filter((action) => action?.type === 'translate' && Number.isInteger(action.page)).map((action) => [action.page, action]))
      const actions = extractedTranslationPages.map((page) => {
        const action = actionsByPage.get(page.page)
        if (!action) return null
        return { ...action, type: 'translate', page: page.page, text: page.text }
      }).filter(Boolean)
      return { ...candidate, actions }
    }
    let plan = largeTranslation
      ? { assistantMessage: '', summary: '', actions: [] }
      : normalizeTranslationPlan(JSON.parse(result.output_text))
    const comparableTranslationText = (value) => String(value || '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('en-US')
    const translationWordOverlap = (left, right) => {
      const leftWords = new Set(comparableTranslationText(left).split(/[^\p{L}\p{N}]+/u).filter(Boolean))
      const rightWords = new Set(comparableTranslationText(right).split(/[^\p{L}\p{N}]+/u).filter(Boolean))
      if (!leftWords.size || !rightWords.size) return 0
      let common = 0
      for (const word of leftWords) if (rightWords.has(word)) common += 1
      return common / Math.min(leftWords.size, rightWords.size)
    }
    const translationPlanNeedsRetry = (candidate) => {
      if (!translationMode) return false
      const expectedPages = extractedTranslationPages.map((page) => page.page)
      const actions = Array.isArray(candidate.actions) ? candidate.actions.filter((action) => action?.type === 'translate' && String(action.text || '').trim() && String(action.replacement || '').trim()) : []
      const hasAllPages = !expectedPages.length || expectedPages.every((page) => actions.some((action) => action.page === page))
      const hasLikelyUntranslatedPage = extractedTranslationPages.some((page) => {
        const action = actions.find((candidateAction) => candidateAction.page === page.page)
        if (!action) return false
        const replacement = String(action.replacement || '')
        return comparableTranslationText(page.text) === comparableTranslationText(replacement)
          || (page.text.length > 240 && page.text.split(/\s+/).length > 25 && translationWordOverlap(page.text, replacement) > 0.88)
      })
      const isNoOp = !actions.length || actions.every((action) => {
        const page = extractedTranslationPages.find((candidatePage) => candidatePage.page === action.page)
        return page && comparableTranslationText(page.text) === comparableTranslationText(action.replacement)
      })
      const isIncomplete = extractedTranslationPages.some((page) => {
        const action = actions.find((candidateAction) => candidateAction.page === page.page)
        if (!action) return false
        const replacement = String(action.replacement || '').trim()
        const sourceLineCount = Array.isArray(page.lines) ? page.lines.length : 0
        const replacementLineCount = replacement.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length
        const lineStructureLost = sourceLineCount > 6 && replacementLineCount < Math.max(2, Math.floor(sourceLineCount * 0.55))
        const sourceSentenceCount = (page.text.match(/[.!?。！？]+/g) || []).length
        const replacementSentenceCount = (replacement.match(/[.!?。！？]+/g) || []).length
        const sentenceStructureLost = sourceSentenceCount > 5 && replacementSentenceCount < Math.max(2, Math.floor(sourceSentenceCount * 0.45))
        return (page.text.length > 160 && replacement.length < page.text.length * 0.45) || lineStructureLost || sentenceStructureLost
      })
      return !hasAllPages || hasLikelyUntranslatedPage || isNoOp || isIncomplete
    }
    if (translationPlanNeedsRetry(plan)) {
      const pagePlans = new Array(extractedTranslationPages.length)
      let nextPageIndex = 0
      const translatePage = async (page) => {
        const pageSource = (page.lines?.length ? page.lines : [page.text]).join('\n')
        const pageResult = await client.responses.create({
          ...planRequest,
          instructions: `You are translating exactly one PDF page for a production document editor. Automatically detect the source language from the page; the user does not need to provide it. Translate the complete source page into ${targetLanguageHint}. Never summarize, shorten, omit, or rewrite away content. Keep every heading, label, paragraph, sentence, name, number, date, and punctuation. Lorem Ipsum, pseudo-Latin, filler text, and mixed-language text are not already translated; convert them into coherent ${targetLanguageHint}. Preserve the source line breaks and return the same number of non-empty lines whenever possible. Return exactly one translate action for page ${page.page}; its text must be the source page and its replacement must be the complete translation. Return no other action and no explanation.\n\nSOURCE PAGE ${page.page}:\n${pageSource}`,
          input: [{
            role: 'user',
            content: [{ type: 'input_text', text: `Translate this complete page into ${targetLanguageHint}.\n\n${pageSource}` }],
          }],
          max_output_tokens: 16000,
        }, { timeout: 180000 })
        if (!pageResult.output_text?.trim()) throw new Error(`Translation for page ${page.page} was empty.`)
        const pagePlan = JSON.parse(pageResult.output_text)
        const action = Array.isArray(pagePlan.actions) ? pagePlan.actions.find((candidate) => candidate?.type === 'translate') : null
        if (!action?.replacement?.trim()) throw new Error(`Translation for page ${page.page} was incomplete.`)
        return { ...action, type: 'translate', page: page.page, text: page.text }
      }
      const workerCount = Math.min(3, extractedTranslationPages.length)
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
          const pageIndex = nextPageIndex
          nextPageIndex += 1
          if (pageIndex >= extractedTranslationPages.length) return
          pagePlans[pageIndex] = await translatePage(extractedTranslationPages[pageIndex])
        }
      }))
      plan = {
        assistantMessage: 'Belgenin tüm sayfaları çevrildi.',
        summary: 'Tam çeviri; sayfa düzeni ve satır yapısı korunarak uygulandı.',
        actions: pagePlans,
      }
    }
    if (translationPlanNeedsRetry(plan)) throw new Error('Tam çeviri planı eksik döndü; belge değiştirilmedi. Lütfen aynı isteği tekrar dene.')
    if (translationMode && extractedImageTextPages.length) {
      const imageActions = []
      let nextImagePageIndex = 0
      const translateImagePage = async (imagePage) => {
        const sourceLines = imagePage.lines.map((line, index) => `${index + 1}. ${line.text}`).join('\n')
        const imageResult = await client.responses.create({
          model: translationModel(),
          instructions: `You are translating text detected inside PDF images. Automatically identify the source language. Translate every OCR line into ${targetLanguageHint}. Keep names, numbers, dates, labels, and order. Do not summarize or skip a line. If OCR contains minor recognition noise, correct it while preserving the visible meaning. Return exactly one action for every numbered line, using the same line number and only the translated replacement text. Do not return explanations.\n\nIMAGE TEXT LINES FROM PAGE ${imagePage.page}:\n${sourceLines}`,
          input: [{
            role: 'user',
            content: [{ type: 'input_text', text: `Translate these image text lines into ${targetLanguageHint}.\n\n${sourceLines}` }],
          }],
          text: { format: { type: 'json_schema', name: 'pdf_image_translation_plan', strict: true, schema: imageTranslationPlanSchema } },
          max_output_tokens: 8000,
          reasoning: { effort: 'medium' },
        }, { timeout: 180000 })
        if (!imageResult.output_text?.trim()) return []
        const parsed = JSON.parse(imageResult.output_text)
        const actionsByLine = new Map((Array.isArray(parsed.actions) ? parsed.actions : []).filter((action) => Number.isInteger(action.line) && String(action.replacement || '').trim()).map((action) => [action.line, action]))
        return imagePage.lines.map((line, index) => {
          const translated = actionsByLine.get(index + 1)?.replacement
          if (!translated || comparableTranslationText(line.text) === comparableTranslationText(translated)) return null
          return {
            type: 'translate_image_text',
            page: imagePage.page,
            line: index + 1,
            text: line.text,
            replacement: String(translated).replace(/\s+/g, ' ').trim(),
            x: line.x,
            y: line.y,
            width: line.width,
            height: line.height,
            size: line.size,
          }
        }).filter(Boolean)
      }
      const imageWorkerCount = Math.min(3, extractedImageTextPages.length)
      const imagePageResults = await Promise.all(Array.from({ length: imageWorkerCount }, async () => {
        const results = []
        while (true) {
          const pageIndex = nextImagePageIndex
          nextImagePageIndex += 1
          if (pageIndex >= extractedImageTextPages.length) return results
          results.push(...await translateImagePage(extractedImageTextPages[pageIndex]))
        }
      }))
      imagePageResults.flat().forEach((action) => imageActions.push(action))
      plan.actions = [...plan.actions, ...imageActions]
    }
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
    const htmlActions = plan.actions.filter((action) => action.type === 'export_html')
    const htmlExports = await Promise.all(htmlActions.map(async (action) => {
      const htmlBytes = await exportHtmlBuffer(finalPdfBytes, sourceFile.originalname || 'document.pdf')
      const sourceBaseName = safeFileName((sourceFile.originalname || 'document.pdf').replace(/\.pdf$/i, ''))
      return { type: action.type, format: 'html', fileName: `${sourceBaseName}.html`, data: htmlBytes.toString('base64') }
    }))
    const imageActions = plan.actions.filter((action) => action.type === 'export_image')
    const imageExports = []
    if (imageActions.length) {
      const renderedPages = await renderPdfPages(finalPdfBytes, 2)
      const requestedPages = imageActions.flatMap((action) => Number.isInteger(action.page) && action.page > 0 ? [action.page] : renderedPages.map((page) => page.page))
      const uniquePages = [...new Set(requestedPages)].filter((page) => page > 0 && page <= renderedPages.length).slice(0, 20)
      const sourceBaseName = safeFileName((sourceFile.originalname || 'document.pdf').replace(/\.pdf$/i, ''))
      uniquePages.forEach((pageNumber) => {
        const renderedPage = renderedPages[pageNumber - 1]
        imageExports.push({ type: 'export_image', format: 'png', page: pageNumber, fileName: `${sourceBaseName}-page-${pageNumber}.png`, data: renderedPage.png.toString('base64') })
      })
    }
    const extractTextAction = plan.actions.find((action) => action.type === 'extract_text')
    const extractedText = extractTextAction ? await extractTextPages(finalPdfBytes) : null
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
    const tokenUsage = await consumeAiTokens(tokenContext)
    return response.json({
      ...plan,
      editedPdf: Buffer.from(finalPdfBytes).toString('base64'),
      appliedActions,
      warnings,
      analysis: appliedActions.filter((action) => action.fields || action.measurements || action.report || action.data || action.table || action.citations),
      officeExports: [...officeExports, ...htmlExports],
      imageExports,
      extractedText,
      audioOverview,
      ocrPages,
      model: pdfEditorModel(),
      sourceFile: sourceFile.originalname || 'document.pdf',
      tokenUsage,
    })
  } catch (error) {
    console.error('[ai-command]', error?.message || error)
    const timedOut = error?.name === 'APIConnectionTimeoutError' || error?.name === 'AbortError' || error?.code === 'ETIMEDOUT'
    const status = error?.status === 401 ? 401 : error?.status === 402 ? 402 : timedOut ? 504 : 500
    const developmentDetails = process.env.NODE_ENV === 'production' ? '' : ` (${error?.message || 'unknown error'})`
    return response.status(status).json({
      error: status === 401
        ? 'OpenAI API anahtarı geçersiz veya yetkisiz.'
        : status === 402
          ? error.message
          : timedOut
            ? 'AI işlemi 3 dakika içinde tamamlanamadı. Çeviriyi daha küçük sayfa aralıklarıyla denemelisin.'
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
