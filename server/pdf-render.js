import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createWorker } from 'tesseract.js'

const normalizeText = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase('tr-TR')

const getMatches = (items, target) => {
  const normalizedTarget = normalizeText(target)
  if (!normalizedTarget) return []
  const matches = []
  let combined = ''
  const ranges = items.map((item) => {
    const normalized = normalizeText(item.str)
    const start = combined.length
    combined += `${normalized} `
    return { item, start, end: combined.length }
  })
  const matchStart = combined.indexOf(normalizedTarget)
  if (matchStart < 0) return matches
  const matchEnd = matchStart + normalizedTarget.length
  for (const range of ranges) {
    if (range.end <= matchStart || range.start >= matchEnd) continue
    const item = range.item
    matches.push({
      x: item.transform?.[4] || 0,
      y: item.transform?.[5] || 0,
      width: item.width || 0,
      height: item.height || Math.abs(item.transform?.[3] || 10),
    })
  }
  return matches
}

export async function renderPdfPages(pdfBytes, scale = 1.5, onPage) {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes), disableFontFace: true, useSystemFonts: true })
  const sourcePdf = await loadingTask.promise
  const pages = []

  try {
    for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber += 1) {
      const page = await sourcePdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      await page.render({ canvasContext: context, viewport }).promise
      const content = await page.getTextContent()
      const renderedPage = {
        page: pageNumber,
        width: viewport.width / scale,
        height: viewport.height / scale,
        scale,
        png: canvas.toBuffer('image/png'),
        items: content.items.filter((item) => typeof item.str === 'string' && item.str.trim()),
        canvas,
        context,
      }
      if (onPage) await onPage(renderedPage)
      pages.push(renderedPage)
    }
  } finally {
    if (typeof sourcePdf.cleanup === 'function') await sourcePdf.cleanup()
  }

  return pages
}

export async function redactPdfBuffer(pdfBytes, actions = []) {
  const redactions = actions.filter((action) => action.type === 'redact' && action.text)
  const pages = await renderPdfPages(pdfBytes, 2, async (page) => {
    const pageActions = redactions.filter((action) => !action.page || action.page === page.page)
    for (const action of pageActions) {
      const matches = getMatches(page.items, action.text)
      for (const match of matches) {
        const x = Math.max(0, match.x * page.scale - 2)
        const y = Math.max(0, (page.height - match.y - match.height) * page.scale - 2)
        const width = Math.max(8, match.width * page.scale + 4)
        const height = Math.max(8, match.height * page.scale + 5)
        page.context.fillStyle = '#000000'
        page.context.fillRect(x, y, width, height)
      }
    }
  })
  const output = await PDFDocument.create()
  const appliedActions = []
  const warnings = []

  for (const page of pages) {
    const image = await output.embedPng(page.canvas.toBuffer('image/png'))
    const targetPage = output.addPage([page.width, page.height])
    targetPage.drawImage(image, { x: 0, y: 0, width: page.width, height: page.height })
    for (const action of redactions.filter((item) => !item.page || item.page === page.page)) {
      const matchCount = getMatches(page.items, action.text).length
      appliedActions.push({ type: action.type, page: page.page, text: action.text, applied: matchCount > 0, matchCount, secureRasterized: true })
      if (!matchCount) warnings.push(`Redact edilecek metin bulunamadı: “${action.text}”`)
    }
  }

  return { pdfBytes: await output.save(), appliedActions, warnings }
}

export async function ocrPdfBuffer(pdfBytes, language = 'eng') {
  const pages = await renderPdfPages(pdfBytes, 1.5)
  const worker = await createWorker(language)
  const recognizedPages = []
  try {
    for (const page of pages) {
      const result = await worker.recognize(page.png)
      recognizedPages.push({ page: page.page, text: result.data.text.trim() })
    }
  } finally {
    await worker.terminate()
  }
  return recognizedPages
}
