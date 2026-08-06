import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createWorker } from 'tesseract.js'

const normalizeText = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase('tr-TR')

const imageOperatorCodes = new Set([
  pdfjsLib.OPS.paintImageMaskXObject,
  pdfjsLib.OPS.paintImageMaskXObjectGroup,
  pdfjsLib.OPS.paintImageXObject,
  pdfjsLib.OPS.paintInlineImageXObject,
  pdfjsLib.OPS.paintInlineImageXObjectGroup,
  pdfjsLib.OPS.paintImageXObjectRepeat,
  pdfjsLib.OPS.paintImageMaskXObjectRepeat,
  pdfjsLib.OPS.paintSolidColorImageMask,
])

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
      const operatorList = await page.getOperatorList()
      const renderedPage = {
        page: pageNumber,
        width: viewport.width / scale,
        height: viewport.height / scale,
        scale,
        png: canvas.toBuffer('image/png'),
        items: content.items.filter((item) => typeof item.str === 'string' && item.str.trim()),
        hasImages: operatorList.fnArray.some((operator) => imageOperatorCodes.has(operator)),
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

const groupOcrWords = (words, scale, pageHeight) => {
  const groups = []
  for (const word of words || []) {
    const text = String(word?.text || '').replace(/\s+/g, ' ').trim()
    const confidence = Number(word?.confidence)
    const bbox = word?.bbox || {}
    if (!text || (Number.isFinite(confidence) && confidence < 42) || !Number.isFinite(bbox.x0) || !Number.isFinite(bbox.y0)) continue
    const x = bbox.x0 / scale
    const top = bbox.y0 / scale
    const width = Math.max(2, (Number(bbox.x1) - bbox.x0) / scale)
    const height = Math.max(4, (Number(bbox.y1) - bbox.y0) / scale)
    const center = top + height / 2
    let group = groups.find((candidate) => Math.abs(candidate.center - center) <= Math.max(5, height * 0.65))
    if (!group) {
      group = { center, words: [] }
      groups.push(group)
    }
    group.words.push({ text, x, top, width, height })
    group.center = (group.center + center) / 2
  }
  return groups
    .sort((left, right) => left.center - right.center)
    .map((group) => {
      const wordsInLine = group.words.sort((left, right) => left.x - right.x)
      const left = Math.min(...wordsInLine.map((word) => word.x))
      const right = Math.max(...wordsInLine.map((word) => word.x + word.width))
      const top = Math.min(...wordsInLine.map((word) => word.top))
      const bottom = Math.max(...wordsInLine.map((word) => word.top + word.height))
      return {
        text: wordsInLine.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim(),
        x: left,
        y: pageHeight - bottom,
        width: Math.max(4, right - left),
        height: Math.max(4, bottom - top),
        size: Math.max(5, bottom - top),
      }
    })
    .filter((line) => line.text)
}

const wordOverlap = (left, right) => {
  const leftWords = new Set(normalizeText(left).split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  const rightWords = new Set(normalizeText(right).split(/[^\p{L}\p{N}]+/u).filter(Boolean))
  if (!leftWords.size || !rightWords.size) return 0
  let common = 0
  for (const word of leftWords) if (rightWords.has(word)) common += 1
  return common / Math.min(leftWords.size, rightWords.size)
}

export async function ocrImageText(pdfBytes, language = 'spa+eng') {
  const pages = await renderPdfPages(pdfBytes, 1.5)
  const imagePages = pages.filter((page) => page.hasImages)
  if (!imagePages.length) return []
  const worker = await createWorker(language)
  const recognizedPages = []
  try {
    for (const page of imagePages) {
      const result = await worker.recognize(page.png, {}, { blocks: true })
      const words = (result.data?.blocks || []).flatMap((block) => (block.paragraphs || []).flatMap((paragraph) => (paragraph.lines || []).flatMap((line) => line.words || [])))
      const lines = groupOcrWords(words, page.scale, page.height)
      const pageText = page.items.map((item) => item.str).join(' ')
      const uniqueLines = lines.filter((line) => {
        const normalizedLine = normalizeText(line.text)
        if (!normalizedLine) return false
        if (normalizeText(pageText).includes(normalizedLine)) return false
        return wordOverlap(pageText, line.text) < 0.82
      })
      if (uniqueLines.length) recognizedPages.push({ page: page.page, lines: uniqueLines })
    }
  } finally {
    await worker.terminate()
  }
  return recognizedPages
}
