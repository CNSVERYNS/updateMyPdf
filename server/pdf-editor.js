import { readFileSync, existsSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { PDFArray, PDFBool, PDFDocument, PDFDict, PDFName, PDFNumber, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { redactPdfBuffer } from './pdf-render.js'

const normalizeText = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .trim()
  .toLocaleLowerCase('tr-TR')

const getTextItems = async (pdfBytes) => {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    disableFontFace: true,
    useSystemFonts: true,
  })
  const sourcePdf = await loadingTask.promise
  const pages = []

  try {
    for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber += 1) {
      const page = await sourcePdf.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push({
        pageNumber,
        items: content.items
          .filter((item) => typeof item.str === 'string' && item.str.trim())
          .map((item) => ({
            text: item.str,
            normalized: normalizeText(item.str),
            x: item.transform?.[4] || 0,
            y: item.transform?.[5] || 0,
            width: item.width || 0,
            height: item.height || Math.abs(item.transform?.[3] || 10),
          })),
      })
    }
  } finally {
    if (typeof sourcePdf.cleanup === 'function') await sourcePdf.cleanup()
  }

  return pages
}

const matchingItems = (page, target) => {
  const normalizedTarget = normalizeText(target)
  if (!normalizedTarget) return []

  const directMatches = []
  for (const item of page.items) {
    const start = item.normalized.indexOf(normalizedTarget)
    if (start >= 0) {
      const ratio = item.text.length ? item.width / item.text.length : item.width
      directMatches.push({
        ...item,
        startRatio: start * ratio,
        endRatio: (start + normalizedTarget.length) * ratio,
      })
    }
  }
  if (directMatches.length) return directMatches

  let combined = ''
  const ranges = page.items.map((item) => {
    const start = combined.length
    combined += `${item.normalized} `
    return { item, start, end: combined.length }
  })
  const matchStart = combined.indexOf(normalizedTarget)
  if (matchStart < 0) return []

  return ranges
    .filter(({ start, end }) => end > matchStart && start < matchStart + normalizedTarget.length)
    .map(({ item }) => ({ ...item, startRatio: 0, endRatio: item.width }))
}

const underlineText = async (pdfDocument, pdfBytes, action) => {
  const pagesWithText = await getTextItems(pdfBytes)
  const selectedPages = action.page ? pagesWithText.filter((page) => page.pageNumber === action.page) : pagesWithText
  let matchCount = 0

  for (const pageData of selectedPages) {
    const matches = matchingItems(pageData, action.text)
    if (!matches.length) continue
    const pdfPage = pdfDocument.getPages()[pageData.pageNumber - 1]
    if (!pdfPage) continue
    matchCount += matches.length

    for (const match of matches) {
      const startX = match.x + match.startRatio
      const endX = match.x + (match.endRatio || match.width)
      const underlineY = Math.max(2, match.y - Math.max(2, match.height * 0.12))
      pdfPage.drawLine({
        start: { x: startX, y: underlineY },
        end: { x: Math.max(startX + 1, endX), y: underlineY },
        thickness: Math.max(1, match.height * 0.08),
        color: rgb(0.92, 0.08, 0.1),
        opacity: 0.95,
      })
    }
  }

  return matchCount
}

const wrapText = (text, font, size, maxWidth) => {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (!words.length) return []
  const lines = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (!current || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

const translateTextBlock = async (pdfDocument, pagesWithText, action) => {
  const selectedPages = action.page ? pagesWithText.filter((page) => page.pageNumber === action.page) : pagesWithText
  const font = await getFont(pdfDocument, action)
  let matchCount = 0

  for (const pageData of selectedPages) {
    const matches = matchingItems(pageData, action.text)
    if (!matches.length) continue
    const pdfPage = pdfDocument.getPages()[pageData.pageNumber - 1]
    if (!pdfPage) continue
    matchCount += matches.length

    const pageWidth = pdfPage.getWidth()
    const pageHeight = pdfPage.getHeight()
    const left = Math.max(12, Math.min(...matches.map((match) => match.x + match.startRatio)) - 2)
    const right = Math.min(pageWidth - 12, Math.max(...matches.map((match) => match.x + (match.endRatio || match.width))) + 2)
    const bottom = Math.max(12, Math.min(...matches.map((match) => match.y - Math.max(2, match.height * 0.25))) - 2)
    const top = Math.min(pageHeight - 12, Math.max(...matches.map((match) => match.y + Math.max(6, match.height))) + 2)
    const width = Math.max(80, right - left)
    const sourceSize = matches.reduce((sum, match) => sum + Math.max(6, match.height), 0) / matches.length
    let fontSize = Math.max(6, Math.min(12, sourceSize))
    let lineHeight = fontSize * 1.28
    let lines = wrapText(action.replacement, font, fontSize, width)
    const availableHeight = Math.max(lineHeight, top - bottom)

    while (lines.length * lineHeight > availableHeight && fontSize > 5) {
      fontSize = Math.max(5, fontSize - 0.5)
      lineHeight = fontSize * 1.28
      lines = wrapText(action.replacement, font, fontSize, width)
    }

    const coverHeight = Math.max(12, top - bottom)
    pdfPage.drawRectangle({ x: Math.max(0, left - 3), y: Math.max(0, bottom - 3), width: Math.min(pageWidth - left + 3, width + 6), height: Math.min(pageHeight - bottom, coverHeight + 6), color: rgb(1, 1, 1), opacity: 1 })
    let drawY = Math.min(pageHeight - fontSize - 6, top - fontSize)
    for (const line of lines) {
      if (drawY < 5) break
      pdfPage.drawText(line, { x: left, y: drawY, size: fontSize, font, color: rgb(0.08, 0.08, 0.08) })
      drawY -= lineHeight
    }
  }

  return matchCount
}

const replaceText = async (pdfDocument, pdfBytes, action, cachedPages = null, cachedFont = null) => {
  const pagesWithText = cachedPages || await getTextItems(pdfBytes)
  const selectedPages = action.page ? pagesWithText.filter((page) => page.pageNumber === action.page) : pagesWithText
  const font = cachedFont || await getFont(pdfDocument, action)
  let matchCount = 0

  for (const pageData of selectedPages) {
    const matches = matchingItems(pageData, action.text)
    if (!matches.length) continue
    const pdfPage = pdfDocument.getPages()[pageData.pageNumber - 1]
    if (!pdfPage) continue
    matchCount += matches.length

    for (const match of matches) {
      const startX = match.x + match.startRatio
      const endX = match.x + (match.endRatio || match.width)
      const fontSize = Math.max(6, match.height)
      const coverHeight = Math.max(fontSize * 1.35, 9)
      const coverY = Math.max(0, match.y - fontSize * 0.28)
      pdfPage.drawRectangle({
        x: Math.max(0, startX - 1),
        y: coverY,
        width: Math.max(4, endX - startX + 2),
        height: coverHeight,
        color: rgb(1, 1, 1),
        opacity: 1,
      })
      pdfPage.drawText(action.replacement || '', {
        x: startX,
        y: match.y,
        size: fontSize,
        font,
        color: rgb(0.08, 0.08, 0.08),
      })
    }
  }

  return matchCount
}

const textColor = (color) => ({
  red: rgb(0.92, 0.08, 0.1),
  green: rgb(0.08, 0.55, 0.2),
  blue: rgb(0.08, 0.25, 0.85),
  yellow: rgb(0.78, 0.58, 0.02),
  black: rgb(0.08, 0.08, 0.08),
}[color] || rgb(0.08, 0.08, 0.08))

const embeddedFontCache = new WeakMap()
const embedCachedFont = (pdfDocument, key, bytes) => {
  let documentFonts = embeddedFontCache.get(pdfDocument)
  if (!documentFonts) {
    documentFonts = new Map()
    embeddedFontCache.set(pdfDocument, documentFonts)
  }
  if (!documentFonts.has(key)) documentFonts.set(key, pdfDocument.embedFont(bytes))
  return documentFonts.get(key)
}

const getFont = async (pdfDocument, action = {}) => {
  const actionText = `${String(action.text || '')} ${String(action.replacement || '')}`
  if (/[^\x00-\x7F]/.test(actionText)) {
    const fontPath = action.fontWeight === 'bold'
      ? (action.fontStyle === 'italic' ? 'C:\\Windows\\Fonts\\segoeubz.ttf' : 'C:\\Windows\\Fonts\\segoeuib.ttf')
      : (action.fontStyle === 'italic' ? 'C:\\Windows\\Fonts\\segoeuii.ttf' : 'C:\\Windows\\Fonts\\segoeui.ttf')
    const candidates = [fontPath, '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    const resolved = candidates.find((candidate) => existsSync(candidate))
    if (resolved) {
      pdfDocument.registerFontkit(fontkit)
      return embedCachedFont(pdfDocument, resolved, readFileSync(resolved))
    }
  }
  const family = action.fontFamily || 'helvetica'
  const weight = action.fontWeight || 'normal'
  const style = action.fontStyle || 'normal'
  const fontMap = {
    helvetica: {
      normal: { normal: StandardFonts.Helvetica, italic: StandardFonts.HelveticaOblique },
      bold: { normal: StandardFonts.HelveticaBold, italic: StandardFonts.HelveticaBoldOblique },
    },
    times: {
      normal: { normal: StandardFonts.TimesRoman, italic: StandardFonts.TimesRomanItalic },
      bold: { normal: StandardFonts.TimesRomanBold, italic: StandardFonts.TimesRomanBoldItalic },
    },
    courier: {
      normal: { normal: StandardFonts.Courier, italic: StandardFonts.CourierOblique },
      bold: { normal: StandardFonts.CourierBold, italic: StandardFonts.CourierBoldOblique },
    },
  }
  const familyMap = fontMap[family] || fontMap.helvetica
  return pdfDocument.embedFont(familyMap[weight === 'bold' ? 'bold' : 'normal'][style === 'italic' ? 'italic' : 'normal'])
}

const textX = (page, action, width, fallback = 48) => {
  if (Number.isFinite(action.x)) return action.x
  if (action.align === 'center') return Math.max(12, (page.getWidth() - width) / 2)
  if (action.align === 'right') return Math.max(12, page.getWidth() - width - 48)
  return fallback
}

const matchGeometry = (match) => {
  const startX = match.x + match.startRatio
  const endX = match.x + (match.endRatio || match.width)
  const fontSize = Math.max(6, match.height)
  return { startX, endX: Math.max(startX + 1, endX), fontSize }
}

const forEachTextMatch = async (pdfDocument, pdfBytes, action, callback) => {
  const pagesWithText = await getTextItems(pdfBytes)
  const selectedPages = action.page ? pagesWithText.filter((page) => page.pageNumber === action.page) : pagesWithText
  let matchCount = 0

  for (const pageData of selectedPages) {
    const matches = matchingItems(pageData, action.text)
    if (!matches.length) continue
    const pdfPage = pdfDocument.getPages()[pageData.pageNumber - 1]
    if (!pdfPage) continue
    matchCount += matches.length
    for (const match of matches) callback(pdfPage, match, pageData)
  }

  return matchCount
}

const styleText = async (pdfDocument, pdfBytes, action) => {
  const pagesWithText = await getTextItems(pdfBytes)
  const selectedPages = action.page ? pagesWithText.filter((page) => page.pageNumber === action.page) : pagesWithText
  const font = await getFont(pdfDocument, action)
  let matchCount = 0

  for (const pageData of selectedPages) {
    const matches = matchingItems(pageData, action.text)
    if (!matches.length) continue
    const pdfPage = pdfDocument.getPages()[pageData.pageNumber - 1]
    if (!pdfPage) continue
    matchCount += matches.length

    for (const match of matches) {
      const originalStartX = match.x + match.startRatio
      const originalEndX = match.x + (match.endRatio || match.width)
      const fontSize = Math.max(6, action.size || match.height)
      const styledText = action.text || ''
      const textWidth = font.widthOfTextAtSize(styledText, fontSize)
      const originalWidth = Math.max(4, originalEndX - originalStartX)
      const coverWidth = Math.max(originalWidth, textWidth) + 4
      const startX = textX(pdfPage, action, textWidth, originalStartX)
      const coverHeight = Math.max(fontSize * 1.35, 9)
      const coverY = Math.max(0, match.y - fontSize * 0.28)
      pdfPage.drawRectangle({
        x: Math.max(0, Math.min(originalStartX, startX) - 2),
        y: coverY,
        width: coverWidth + Math.abs(startX - originalStartX),
        height: coverHeight,
        color: rgb(1, 1, 1),
        opacity: 1,
      })
      pdfPage.drawText(styledText, {
        x: startX,
        y: match.y,
        size: fontSize,
        font,
        color: textColor(action.color),
      })
    }
  }

  return matchCount
}

const highlightText = async (pdfDocument, pdfBytes, action) => forEachTextMatch(pdfDocument, pdfBytes, action, (pdfPage, match) => {
  const { startX, endX, fontSize } = matchGeometry(match)
  pdfPage.drawRectangle({
    x: Math.max(0, startX - 1),
    y: Math.max(0, match.y - fontSize * 0.28),
    width: endX - startX + 2,
    height: Math.max(fontSize * 1.35, 9),
    color: textColor(action.color || 'yellow'),
    opacity: 0.38,
  })
})

const strikethroughText = async (pdfDocument, pdfBytes, action) => forEachTextMatch(pdfDocument, pdfBytes, action, (pdfPage, match) => {
  const { startX, endX, fontSize } = matchGeometry(match)
  const y = match.y + fontSize * 0.42
  pdfPage.drawLine({ start: { x: startX, y }, end: { x: endX, y }, thickness: Math.max(1, fontSize * 0.08), color: textColor(action.color || 'red') })
})

const squigglyText = async (pdfDocument, pdfBytes, action) => forEachTextMatch(pdfDocument, pdfBytes, action, (pdfPage, match) => {
  const { startX, endX, fontSize } = matchGeometry(match)
  const y = Math.max(2, match.y - fontSize * 0.15)
  const step = Math.max(3, fontSize * 0.25)
  for (let x = startX; x < endX; x += step) {
    const nextX = Math.min(endX, x + step)
    const middleX = x + (nextX - x) / 2
    pdfPage.drawLine({ start: { x, y }, end: { x: middleX, y: y + fontSize * 0.16 }, thickness: Math.max(0.8, fontSize * 0.06), color: textColor(action.color || 'red') })
    pdfPage.drawLine({ start: { x: middleX, y: y + fontSize * 0.16 }, end: { x: nextX, y }, thickness: Math.max(0.8, fontSize * 0.06), color: textColor(action.color || 'red') })
  }
})

const addText = async (pdfDocument, action) => {
  const pageIndex = Number.isInteger(action.page) && action.page > 0 ? action.page - 1 : 0
  const page = pdfDocument.getPages()[pageIndex]
  if (!page || !action.text) return false
  const font = await getFont(pdfDocument, action)
  const size = Math.max(6, action.size || 14)
  const textWidth = font.widthOfTextAtSize(action.text, size)
  page.drawText(action.text, {
    x: textX(page, action, textWidth),
    y: action.y ?? page.getHeight() - size * 2,
    size,
    font,
    color: textColor(action.color || 'black'),
  })
  return true
}

const addImage = async (pdfDocument, action, imageBuffer) => {
  if (!imageBuffer) return false
  const pageIndex = Number.isInteger(action.page) && action.page > 0 ? action.page - 1 : 0
  const page = pdfDocument.getPages()[pageIndex]
  if (!page) return false
  const bytes = Buffer.from(imageBuffer)
  const image = bytes[0] === 0xff && bytes[1] === 0xd8
    ? await pdfDocument.embedJpg(bytes)
    : await pdfDocument.embedPng(bytes)
  await image.embed()
  const width = Math.max(12, action.width || Math.min(240, image.width))
  const height = Math.max(12, action.height || width * (image.height / image.width))
  page.drawImage(image, {
    x: action.x ?? 48,
    y: action.y ?? page.getHeight() - height - 48,
    width,
    height,
    opacity: action.opacity ?? 1,
  })
  return true
}

const replaceImage = async (pdfDocument, action, imageBuffer) => {
  if (!imageBuffer) return 0
  const bytes = Buffer.from(imageBuffer)
  const image = bytes[0] === 0xff && bytes[1] === 0xd8
    ? await pdfDocument.embedJpg(bytes)
    : await pdfDocument.embedPng(bytes)
  await image.embed()
  const pages = selectedPages(pdfDocument, action)
  let replaced = 0
  for (const { page } of pages) {
    const resources = page.node.lookupMaybe(PDFName.of('Resources'), PDFDict)
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    if (!xObjects) continue
    const imageKeys = xObjects.keys().filter((key) => {
      const objectRef = xObjects.get(key)
      const object = xObjects.context.lookup(objectRef)
      return object?.dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Image'
    })
    const imageIndex = Math.max(0, Number.isInteger(action.imageIndex) ? action.imageIndex - 1 : 0)
    const target = imageKeys[imageIndex]
    if (!target) continue
    xObjects.set(target, image.ref)
    replaced += 1
  }
  return replaced
}

const setImageAltText = (pdfDocument, action) => {
  const altText = String(action.text || '').trim()
  if (!altText) return 0
  const pages = selectedPages(pdfDocument, action)
  let tagged = 0
  for (const { page } of pages) {
    const resources = page.node.lookupMaybe(PDFName.of('Resources'), PDFDict)
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    if (!xObjects) continue
    const imageKeys = xObjects.keys().filter((key) => {
      const objectRef = xObjects.get(key)
      const object = xObjects.context.lookup(objectRef)
      return object?.dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Image'
    })
    const imageIndex = Math.max(0, Number.isInteger(action.imageIndex) ? action.imageIndex - 1 : 0)
    const target = imageKeys[imageIndex]
    if (!target) continue
    const objectRef = xObjects.get(target)
    const imageStream = xObjects.context.lookup(objectRef)
    const imageObject = imageStream?.dict
    if (!imageObject) continue
    imageObject.set(PDFName.of('Alt'), PDFString.of(altText.slice(0, 1000)))
    tagged += 1
  }
  return tagged
}

const addLinkAnnotation = (pdfDocument, page, x, y, width, height, url) => {
  if (!url || !page) return false
  const annotation = pdfDocument.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: [x, y, x + width, y + height],
    Border: [0, 0, 0],
    A: {
      Type: PDFName.of('Action'),
      S: PDFName.of('URI'),
      URI: PDFString.of(url),
    },
  })
  page.node.addAnnot(pdfDocument.context.register(annotation))
  return true
}

const addLink = async (pdfDocument, pdfBytes, action) => {
  if (action.text) {
    return forEachTextMatch(pdfDocument, pdfBytes, action, (page, match) => {
      const { startX, endX, fontSize } = matchGeometry(match)
      addLinkAnnotation(pdfDocument, page, startX, Math.max(0, match.y - fontSize * 0.25), endX - startX, fontSize * 1.35, action.url)
    })
  }
  const pageIndex = Number.isInteger(action.page) && action.page > 0 ? action.page - 1 : 0
  const page = pdfDocument.getPages()[pageIndex]
  return addLinkAnnotation(pdfDocument, page, action.x || 48, action.y || page?.getHeight() - 48, action.width || 180, action.height || 24, action.url) ? 1 : 0
}

const selectedPages = (pdfDocument, action) => {
  if (Number.isInteger(action.page) && action.page > 0) {
    const page = pdfDocument.getPages()[action.page - 1]
    return page ? [{ page, pageNumber: action.page }] : []
  }
  return pdfDocument.getPages().map((page, index) => ({ page, pageNumber: index + 1 }))
}

const drawVisualAction = async (pdfDocument, action) => {
  const pages = selectedPages(pdfDocument, action)
  if (!pages.length || !action.type) return 0
  const text = String(action.text || action.replacement || '').trim()
  const font = ['add_signature', 'fill_and_sign'].includes(action.type)
    ? await getFont(pdfDocument, { text, fontWeight: action.signatureStyle === 'bold' ? 'bold' : 'normal', fontStyle: action.signatureStyle === 'bold' ? 'normal' : 'italic', fontFamily: action.signatureStyle === 'elegant' ? 'times' : 'helvetica' })
    : await pdfDocument.embedFont(StandardFonts.Helvetica)
  const size = Math.max(6, Number(action.size) || 12)
  let applied = 0

  for (const { page, pageNumber } of pages) {
    const pageWidth = page.getWidth()
    const pageHeight = page.getHeight()
    const x = action.x ?? 42
    const y = action.y ?? pageHeight - size * 2
    const width = Math.max(20, action.width || 180)
    const height = Math.max(16, action.height || 36)
    const color = textColor(action.color || (action.type === 'watermark' ? 'blue' : 'black'))

    if (action.type === 'watermark') {
      if (!text) continue
      page.drawText(text, { x: Math.max(10, (pageWidth - text.length * size * 0.52) / 2), y: Math.max(10, pageHeight / 2), size, font, color, opacity: 0.2, rotate: degrees(45) })
    } else if (action.type === 'header_footer') {
      if (!text) continue
      const isBottom = action.position === 'bottom'
      page.drawText(text, { x, y: action.y ?? (isBottom ? 24 : pageHeight - size - 24), size, font, color })
    } else if (action.type === 'bates_numbering') {
      const prefix = text || 'PDF'
      const number = String(pageNumber).padStart(4, '0')
      page.drawText(`${prefix}-${number}`, { x, y: action.y ?? 18, size: Math.min(size, 12), font, color })
    } else if (action.type === 'sticky_note' || action.type === 'comment') {
      page.drawRectangle({ x, y: Math.max(0, y - height), width, height, color: action.type === 'sticky_note' ? rgb(1, 0.92, 0.35) : rgb(0.78, 0.9, 1), opacity: 0.88, borderColor: rgb(0.18, 0.24, 0.35), borderWidth: 0.8 })
      if (text) page.drawText(text.slice(0, 240), { x: x + 7, y: Math.max(4, y - size - 7), size: Math.min(size, 12), font, color: rgb(0.08, 0.1, 0.16), maxWidth: width - 14, lineHeight: size * 1.25 })
    } else if (action.type === 'shape') {
      page.drawRectangle({ x, y: Math.max(0, y - height), width, height, borderColor: color, borderWidth: Math.max(1, size / 5), opacity: 0.9 })
    } else if (action.type === 'freehand') {
      page.drawLine({ start: { x, y }, end: { x: x + (action.width || 90), y: y - (action.height || 30) }, thickness: Math.max(1, size / 4), color })
    } else if (action.type === 'stamp') {
      page.drawRectangle({ x, y: Math.max(0, y - height), width, height, borderColor: color, borderWidth: 2, opacity: 0.9 })
      if (text) page.drawText(text.toUpperCase().slice(0, 48), { x: x + 8, y: Math.max(4, y - height / 2 - size / 3), size: Math.min(size, 18), font, color })
    } else if (action.type === 'add_signature' || action.type === 'fill_and_sign') {
      if (!text) continue
      page.drawText(text, { x, y, size: Math.max(10, size), font, color })
      page.drawLine({ start: { x, y: y - 3 }, end: { x: x + Math.max(80, text.length * size * 0.55), y: y - 3 }, thickness: 1, color })
    }
    applied += 1
  }

  return applied
}

const applyMetadataAction = (pdfDocument, action) => {
  if (action.title) pdfDocument.setTitle(action.title)
  if (action.author) pdfDocument.setAuthor(action.author)
  if (action.subject) pdfDocument.setSubject(action.subject)
  if (Array.isArray(action.keywords)) pdfDocument.setKeywords(action.keywords)
  return Boolean(action.title || action.author || action.subject || action.keywords?.length)
}

const removeHiddenData = (pdfDocument) => {
  pdfDocument.setTitle('')
  pdfDocument.setAuthor('')
  pdfDocument.setSubject('')
  pdfDocument.setKeywords([])
  pdfDocument.setCreator('updateMyPDF')
  pdfDocument.setProducer('updateMyPDF')
  const removedCatalogKeys = []
  for (const key of ['OpenAction', 'AA', 'Metadata', 'PieceInfo', 'Perms']) {
    const name = PDFName.of(key)
    if (pdfDocument.catalog.has(name)) {
      pdfDocument.catalog.delete(name)
      removedCatalogKeys.push(key)
    }
  }
  const removedNameEntries = []
  const names = pdfDocument.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  if (names) {
    for (const key of ['JavaScript', 'EmbeddedFiles']) {
      const name = PDFName.of(key)
      if (names.has(name)) {
        names.delete(name)
        removedNameEntries.push(key)
      }
    }
    if (!names.keys().length) pdfDocument.catalog.delete(PDFName.of('Names'))
  }
  let xfaRemoved = false
  try {
    const form = pdfDocument.getForm()
    xfaRemoved = form.hasXFA()
    if (xfaRemoved) form.deleteXFA()
  } catch (_error) {
    xfaRemoved = false
  }
  return { metadataCleared: true, removedCatalogKeys, removedNameEntries, xfaRemoved }
}

const tagPdf = (pdfDocument, action) => {
  const language = action.language === 'tur' ? 'tr-TR' : 'en-US'
  pdfDocument.catalog.set(PDFName.of('Lang'), PDFString.of(language))
  const markInfo = pdfDocument.catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict) || pdfDocument.context.obj({})
  markInfo.set(PDFName.of('Marked'), PDFBool.True)
  pdfDocument.catalog.set(PDFName.of('MarkInfo'), markInfo)
  return { language, marked: true, semanticStructure: false }
}

const inspectFormFields = (pdfDocument) => pdfDocument.getForm().getFields().map((field) => {
  const type = field.constructor.name
  let value = null
  try {
    if (type === 'PDFTextField') value = field.getText() || ''
    if (type === 'PDFCheckBox') value = field.isChecked()
    if (type === 'PDFDropdown' || type === 'PDFRadioGroup') value = type === 'PDFDropdown' ? field.getSelected() : field.getSelected()
  } catch (_error) {
    value = null
  }
  return { name: field.getName(), type, value }
})

const measureDocument = (pdfDocument) => pdfDocument.getPages().map((page, index) => ({
  page: index + 1,
  width: Number(page.getWidth().toFixed(2)),
  height: Number(page.getHeight().toFixed(2)),
}))

const groupTextLines = (pages) => pages.map((page) => {
  const lines = []
  const sortedItems = [...page.items].sort((left, right) => right.y - left.y || left.x - right.x)
  for (const item of sortedItems) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= Math.max(3, item.height * 0.45))
    if (line) line.items.push(item)
    else lines.push({ y: item.y, items: [item] })
  }
  return {
    page: page.pageNumber,
    lines: lines
      .sort((left, right) => right.y - left.y)
      .map((line) => ({
        y: Number(line.y.toFixed(2)),
        items: line.items.sort((left, right) => left.x - right.x).map((item) => ({
          text: item.text,
          x: Number(item.x.toFixed(2)),
          width: Number(item.width.toFixed(2)),
        })),
      })),
  }
})

const extractStructuredData = (pages, query = '') => {
  const lines = groupTextLines(pages)
  const allText = lines.flatMap((page) => page.lines.map((line) => line.items.map((item) => item.text).join(' '))).join('\n')
  const data = {}
  const addMatches = (key, expression) => {
    const matches = [...allText.matchAll(expression)].map((match) => match[0]).filter(Boolean)
    if (matches.length) data[key] = [...new Set(matches)].slice(0, 100)
  }

  addMatches('emails', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)
  addMatches('urls', /https?:\/\/[^\s<]+/gi)
  addMatches('phones', /(?:\+?\d[\d\s().-]{7,}\d)/g)
  addMatches('dates', /\b(?:\d{1,4}[./-]\d{1,2}[./-]\d{1,4}|\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]+\s+\d{2,4})\b/g)

  const fields = {}
  for (const line of lines.flatMap((page) => page.lines.map((item) => ({ ...item, page: page.page })))) {
    const value = line.items.map((item) => item.text).join(' ').trim()
    const match = value.match(/^([^:]{1,80}):\s*(.{1,500})$/)
    if (match) fields[match[1].trim()] = { value: match[2].trim(), page: line.page }
  }
  if (Object.keys(fields).length) data.fields = fields
  return { query, data, pages: lines.map((page) => ({ page: page.page, lineCount: page.lines.length })) }
}

const extractTableData = (pages, query = '') => {
  const lines = groupTextLines(pages)
  const rows = lines.flatMap((page) => page.lines
    .filter((line) => line.items.length >= 2)
    .map((line) => ({
      page: page.page,
      cells: line.items.map((item) => item.text.trim()).filter(Boolean),
    })))
    .filter((row) => row.cells.length >= 2)
    .slice(0, 200)
  return { query, rows, rowCount: rows.length }
}

const documentCitations = (pages, query = '') => {
  const terms = normalizeText(query).split(' ').filter((term) => term.length > 2)
  const lines = groupTextLines(pages)
  const scored = lines.flatMap((page) => page.lines.map((line) => {
    const text = line.items.map((item) => item.text).join(' ').trim()
    const normalized = normalizeText(text)
    const score = terms.reduce((total, term) => total + (normalized.includes(term) ? 1 : 0), 0)
    return { page: page.page, text, score }
  })).filter((line) => line.text && (line.score > 0 || !terms.length))
    .sort((left, right) => right.score - left.score || left.page - right.page)
    .slice(0, 8)
  return { query, citations: scored.map(({ page, text }) => ({ page, quote: text.slice(0, 500) })) }
}

const applyPageAction = (pdfDocument, action) => {
  if (action.type === 'insert_blank_page' || action.type === 'insert_page') {
    const insertionIndex = Math.min(Math.max((action.page || pdfDocument.getPageCount() + 1) - 1, 0), pdfDocument.getPageCount())
    pdfDocument.insertPage(insertionIndex, [action.width || 612, action.height || 792])
    return { type: action.type, page: insertionIndex + 1, applied: true }
  }

  if (action.type === 'crop_page' && Number.isInteger(action.page) && action.width && action.height) {
    const page = pdfDocument.getPages()[action.page - 1]
    if (!page) return { type: action.type, page: action.page, applied: false }
    page.setCropBox(action.x || 0, action.y || 0, action.width, action.height)
    return { type: action.type, page: action.page, applied: true }
  }

  if (action.type === 'resize_page' && action.width && action.height) {
    const pages = selectedPages(pdfDocument, action)
    pages.forEach(({ page }) => page.setSize(action.width, action.height))
    return { type: action.type, page: action.page, width: action.width, height: action.height, applied: pages.length > 0 }
  }

  if (action.type === 'extract_pages' && Array.isArray(action.pages) && action.pages.length) {
    const selected = new Set(action.pages.map((page) => page - 1))
    for (let index = pdfDocument.getPageCount() - 1; index >= 0; index -= 1) {
      if (!selected.has(index)) pdfDocument.removePage(index)
    }
    if (pdfDocument.getPageCount() === 0) pdfDocument.addPage([612, 792])
    return { type: action.type, pages: action.pages, applied: true }
  }

  return null
}

const applyFormAction = (pdfDocument, action) => {
  const form = pdfDocument.getForm()
  const pageIndex = Number.isInteger(action.page) && action.page > 0 ? action.page - 1 : 0
  const page = pdfDocument.getPages()[pageIndex]
  const fieldName = action.fieldName || `field_${Date.now()}`
  if (!page && action.type !== 'flatten_form') return { type: action.type, fieldName, applied: false }

  if (action.type === 'add_signature_field') {
    if (form.getFieldMaybe(fieldName)) return { type: action.type, fieldName, applied: false, reason: 'field_exists' }
    const acroFormRef = pdfDocument.catalog.get(PDFName.of('AcroForm'))
    const acroForm = pdfDocument.context.lookup(acroFormRef, PDFDict)
    const field = pdfDocument.context.obj({
      FT: PDFName.of('Sig'),
      T: PDFString.of(fieldName),
      F: PDFNumber.of(4),
      P: page.ref,
      Subtype: PDFName.of('Widget'),
      Rect: [action.x ?? 48, action.y ?? page.getHeight() - 90, (action.x ?? 48) + (action.width || 220), (action.y ?? page.getHeight() - 90) + (action.height || 42)],
      Border: [0, 0, 1],
      DA: PDFString.of('/Helv 10 Tf 0 g'),
    })
    const fieldRef = pdfDocument.context.register(field)
    const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray) || pdfDocument.context.obj([])
    if (!acroForm.has(PDFName.of('Fields'))) acroForm.set(PDFName.of('Fields'), fields)
    fields.push(fieldRef)
    page.node.addAnnot(fieldRef)
    return { type: action.type, fieldName, applied: true, interactive: true }
  }

  if (action.type === 'add_text_field') {
    const field = form.createTextField(fieldName)
    field.addToPage(page, { x: action.x || 48, y: action.y || page.getHeight() - 90, width: action.width || 180, height: action.height || 28 })
    if (action.value !== null && action.value !== undefined) field.setText(String(action.value))
    return { type: action.type, fieldName, applied: true }
  }

  if (action.type === 'add_checkbox') {
    const field = form.createCheckBox(fieldName)
    field.addToPage(page, { x: action.x || 48, y: action.y || page.getHeight() - 90, width: action.width || 18, height: action.height || 18 })
    if (action.value === true || action.value === 'true') field.check()
    return { type: action.type, fieldName, applied: true }
  }

  if (action.type === 'add_dropdown') {
    const field = form.createDropdown(fieldName)
    field.addOptions(action.options || [])
    field.addToPage(page, { x: action.x || 48, y: action.y || page.getHeight() - 90, width: action.width || 180, height: action.height || 28 })
    if (action.value !== null && action.value !== undefined) field.select(String(action.value))
    return { type: action.type, fieldName, applied: true }
  }

  if (action.type === 'add_radio') {
    const group = form.createRadioGroup(fieldName)
    const options = action.options?.length ? action.options : ['Option 1', 'Option 2']
    options.forEach((option, index) => group.addOptionToPage(option, page, {
      x: action.x || 48,
      y: (action.y || page.getHeight() - 90) - index * ((action.height || 18) + 8),
      width: action.width || 18,
      height: action.height || 18,
    }))
    if (action.value !== null && action.value !== undefined) group.select(String(action.value))
    return { type: action.type, fieldName, options, applied: true }
  }

  if (action.type === 'fill_field' || action.type === 'fill_form') {
    const value = action.value === null || action.value === undefined ? '' : String(action.value)
    if (action.fieldType === 'checkbox') {
      const field = form.getCheckBox(fieldName)
      if (action.value === true || action.value === 'true') field.check()
      else field.uncheck()
    } else if (action.fieldType === 'dropdown') {
      form.getDropdown(fieldName).select(value)
    } else if (action.fieldType === 'radio') {
      form.getRadioGroup(fieldName).select(value)
    } else {
      form.getTextField(fieldName).setText(value)
    }
    return { type: action.type, fieldName, applied: true }
  }

  if (action.type === 'flatten_form' || action.type === 'flatten_pdf') {
    form.flatten()
    return { type: action.type, applied: true }
  }

  return null
}

export async function applyEditPlan(pdfBuffer, actions = [], assets = {}) {
  const originalBytes = Buffer.from(pdfBuffer)
  const pdfDocument = await PDFDocument.load(originalBytes)
  const appliedActions = []
  const warnings = []

  for (const action of actions) {
    if (action.type === 'set_title' && action.title) {
      pdfDocument.setTitle(action.title)
      appliedActions.push({ type: action.type, title: action.title, applied: true })
    }
    if (action.type === 'edit_metadata') {
      const applied = applyMetadataAction(pdfDocument, action)
      appliedActions.push({ type: action.type, applied })
      if (!applied) warnings.push('Güncellenecek PDF metadata bilgisi bulunamadı.')
    }
    if (action.type === 'remove_hidden_data') {
      appliedActions.push({ type: action.type, applied: true, details: removeHiddenData(pdfDocument) })
    }
  }

  for (const action of actions.filter((item) => item.type === 'reorder_pages' && Array.isArray(item.pages) && item.pages.length)) {
    const sourceDocument = await PDFDocument.load(originalBytes)
    const pageIndexes = action.pages.filter((page) => Number.isInteger(page) && page > 0 && page <= sourceDocument.getPageCount()).map((page) => page - 1)
    const copiedPages = await pdfDocument.copyPages(sourceDocument, pageIndexes)
    while (pdfDocument.getPageCount()) pdfDocument.removePage(0)
    copiedPages.forEach((page) => pdfDocument.addPage(page))
    appliedActions.push({ type: action.type, pages: action.pages, applied: copiedPages.length > 0 })
    if (!copiedPages.length) warnings.push('Sayfa sırası uygulanamadı.')
  }

  for (const action of actions.filter((item) => item.type === 'duplicate_page' && Number.isInteger(item.page))) {
    const sourceDocument = await PDFDocument.load(originalBytes)
    const sourceIndex = action.page - 1
    if (sourceIndex < 0 || sourceIndex >= sourceDocument.getPageCount()) {
      warnings.push(`Kopyalanacak sayfa bulunamadı: ${action.page}`)
      continue
    }
    const [copiedPage] = await pdfDocument.copyPages(sourceDocument, [sourceIndex])
    const targetIndex = Math.min(Math.max((action.targetPage || pdfDocument.getPageCount() + 1) - 1, 0), pdfDocument.getPageCount())
    pdfDocument.insertPage(targetIndex, copiedPage)
    appliedActions.push({ type: action.type, page: action.page, targetPage: targetIndex + 1, applied: true })
  }

  for (const action of actions.filter((item) => item.type === 'underline' && item.text)) {
    const matchCount = await underlineText(pdfDocument, originalBytes, action)
    appliedActions.push({ type: action.type, page: action.page, text: action.text, color: 'red', applied: matchCount > 0, matchCount })
    if (!matchCount) warnings.push(`Metin bulunamadı: “${action.text}”`)
  }

  const replacementActions = actions.filter((item) => ['replace_text', 'rewrite_text', 'translate'].includes(item.type) && item.text && item.replacement !== null)
  const replacementPages = replacementActions.length ? await getTextItems(originalBytes) : null
  for (const action of replacementActions) {
    const matchCount = action.type === 'translate'
      ? await translateTextBlock(pdfDocument, replacementPages, action)
      : await replaceText(pdfDocument, originalBytes, action, replacementPages)
    appliedActions.push({ type: action.type, page: action.page, text: action.text, replacement: action.replacement, applied: matchCount > 0, matchCount })
    if (!matchCount) warnings.push(`Değiştirilecek metin bulunamadı: “${action.text}”`)
  }

  for (const action of actions.filter((item) => item.type === 'style_text' && item.text && item.color)) {
    const matchCount = await styleText(pdfDocument, originalBytes, action)
    appliedActions.push({ type: action.type, page: action.page, text: action.text, color: action.color, applied: matchCount > 0, matchCount })
    if (!matchCount) warnings.push(`Stili değiştirilecek metin bulunamadı: “${action.text}”`)
  }

  for (const action of actions.filter((item) => ['highlight', 'strikethrough', 'squiggly'].includes(item.type) && item.text)) {
    const executor = action.type === 'highlight' ? highlightText : action.type === 'strikethrough' ? strikethroughText : squigglyText
    const matchCount = await executor(pdfDocument, originalBytes, action)
    appliedActions.push({ type: action.type, page: action.page, text: action.text, color: action.color || (action.type === 'highlight' ? 'yellow' : 'red'), applied: matchCount > 0, matchCount })
    if (!matchCount) warnings.push(`İşaretlenecek metin bulunamadı: “${action.text}”`)
  }

  for (const action of actions.filter((item) => item.type === 'delete_text' && item.text)) {
    const matchCount = await replaceText(pdfDocument, originalBytes, { ...action, replacement: '' })
    appliedActions.push({ type: action.type, page: action.page, text: action.text, applied: matchCount > 0, matchCount })
    if (!matchCount) warnings.push(`Silinecek metin bulunamadı: “${action.text}”`)
  }

  for (const action of actions.filter((item) => item.type === 'add_text' && item.text)) {
    const applied = await addText(pdfDocument, action)
    appliedActions.push({ type: action.type, page: action.page || 1, text: action.text, applied })
    if (!applied) warnings.push('Metin eklenemedi; hedef sayfa bulunamadı.')
  }

  for (const action of actions.filter((item) => item.type === 'add_image')) {
    try {
      const applied = await addImage(pdfDocument, action, assets.imageBuffer)
      appliedActions.push({ type: action.type, page: action.page || 1, applied })
      if (!applied) warnings.push('Görsel eklenemedi; PNG/JPEG görseli ve geçerli hedef sayfa gerekli.')
    } catch (error) {
      appliedActions.push({ type: action.type, page: action.page || 1, applied: false })
      warnings.push('Görsel PDF’e eklenemedi.')
    }
  }

  for (const action of actions.filter((item) => item.type === 'resize_image')) {
    try {
      const applied = await addImage(pdfDocument, action, assets.imageBuffer)
      appliedActions.push({ type: action.type, page: action.page || 1, width: action.width, height: action.height, x: action.x, y: action.y, applied, mode: 'uploaded-image-placement' })
      if (!applied) warnings.push('Görseli yeniden boyutlandırmak için PNG/JPEG ve hedef ölçüler gerekli.')
    } catch (_error) {
      appliedActions.push({ type: action.type, page: action.page || 1, applied: false })
      warnings.push('Görsel yeniden boyutlandırılamadı.')
    }
  }

  for (const action of actions.filter((item) => item.type === 'replace_image')) {
    try {
      const replaced = await replaceImage(pdfDocument, action, assets.imageBuffer)
      appliedActions.push({ type: action.type, page: action.page || 1, imageIndex: action.imageIndex || 1, applied: replaced > 0, matchCount: replaced })
      if (!replaced) warnings.push('Değiştirilecek gömülü görsel bulunamadı; PNG/JPEG ve doğru sayfa gerekli.')
    } catch (_error) {
      appliedActions.push({ type: action.type, page: action.page || 1, applied: false })
      warnings.push('Gömülü görsel değiştirilemedi.')
    }
  }

  for (const action of actions.filter((item) => item.type === 'set_alt_text' && item.text)) {
    const tagged = setImageAltText(pdfDocument, action)
    appliedActions.push({ type: action.type, page: action.page || 1, imageIndex: action.imageIndex || 1, applied: tagged > 0, matchCount: tagged })
    if (!tagged) warnings.push('Alt metni eklenecek gÃ¶mÃ¼lÃ¼ gÃ¶rsel bulunamadÄ±.')
  }

  for (const action of actions.filter((item) => item.type === 'add_link' && item.url)) {
    const count = await addLink(pdfDocument, originalBytes, action)
    appliedActions.push({ type: action.type, page: action.page, text: action.text, url: action.url, applied: count > 0, matchCount: count })
    if (!count) warnings.push(`Link eklenecek alan bulunamadı: ${action.text || action.url}`)
  }

  for (const action of actions.filter((item) => ['insert_blank_page', 'insert_page', 'crop_page', 'resize_page', 'extract_pages'].includes(item.type))) {
    const result = applyPageAction(pdfDocument, action)
    if (!result) continue
    appliedActions.push(result)
    if (!result.applied) warnings.push(`Sayfa işlemi uygulanamadı: ${action.type}`)
  }

  for (const action of actions.filter((item) => ['add_text_field', 'add_checkbox', 'add_dropdown', 'add_radio', 'add_signature_field', 'fill_field', 'fill_form', 'flatten_form', 'flatten_pdf'].includes(item.type))) {
    try {
      const result = applyFormAction(pdfDocument, action)
      if (!result) continue
      appliedActions.push(result)
      if (!result.applied) warnings.push(`Form işlemi uygulanamadı: ${action.type}`)
    } catch (error) {
      warnings.push(`Form işlemi uygulanamadı: ${action.fieldName || action.type}`)
    }
  }

  for (const action of actions.filter((item) => ['detect_form_fields', 'export_form_data'].includes(item.type))) {
    const fields = inspectFormFields(pdfDocument)
    appliedActions.push({ type: action.type, applied: true, fields })
  }

  for (const action of actions.filter((item) => item.type === 'measure')) {
    appliedActions.push({ type: action.type, applied: true, measurements: measureDocument(pdfDocument) })
  }

  for (const action of actions.filter((item) => item.type === 'accessibility_check')) {
    const pagesWithText = await getTextItems(originalBytes)
    const emptyPages = pagesWithText.filter((page) => page.items.length === 0).map((page) => page.pageNumber)
    const markInfo = pdfDocument.catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict)
    const lang = pdfDocument.catalog.lookupMaybe(PDFName.of('Lang'), PDFString)?.decodeText() || ''
    const formFields = (() => {
      try { return pdfDocument.getForm().getFields().length } catch (_error) { return 0 }
    })()
    appliedActions.push({
      type: action.type,
      applied: true,
      report: {
        pageCount: pdfDocument.getPageCount(),
        titlePresent: Boolean(pdfDocument.getTitle()),
        language: lang,
        marked: Boolean(markInfo?.lookupMaybe(PDFName.of('Marked'), PDFBool)?.value),
        formFieldCount: formFields,
        emptyPages,
        textPages: pagesWithText.filter((page) => page.items.length > 0).length,
      },
    })
  }

  for (const action of actions.filter((item) => item.type === 'tag_pdf')) {
    appliedActions.push({ type: action.type, applied: true, report: tagPdf(pdfDocument, action) })
  }

  for (const action of actions.filter((item) => item.type === 'reading_order')) {
    const pages = selectedPages(pdfDocument, action)
    const pageNumbers = Array.isArray(action.pages) && action.pages.length
      ? action.pages.filter((page) => Number.isInteger(page) && page > 0 && page <= pdfDocument.getPageCount())
      : pages.map(({ pageNumber }) => pageNumber)
    pages.forEach(({ page }) => page.node.set(PDFName.of('Tabs'), PDFName.of('S')))
    const markInfo = pdfDocument.catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict) || pdfDocument.context.obj({})
    markInfo.set(PDFName.of('Marked'), PDFBool.True)
    pdfDocument.catalog.set(PDFName.of('MarkInfo'), markInfo)
    pdfDocument.catalog.set(PDFName.of('PDFManiacReadingOrder'), pdfDocument.context.obj(pageNumbers.map((page) => PDFNumber.of(page))))
    appliedActions.push({ type: action.type, applied: pageNumbers.length > 0, pages: pageNumbers, mode: 'tabs-s-metadata', semanticStructure: false })
    if (!pageNumbers.length) warnings.push('Okuma sırası için geçerli sayfa bulunamadı.')
  }

  for (const action of actions.filter((item) => item.type === 'javascript_action' && item.script)) {
    const script = String(action.script).slice(0, 20000)
    const name = String(action.fieldName || 'pdfManiacAction').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'pdfManiacAction'
    pdfDocument.addJavaScript(name, script)
    appliedActions.push({ type: action.type, applied: true, name, scriptLength: script.length })
  }

  const extractionActions = actions.filter((item) => ['extract_data', 'extract_table'].includes(item.type))
  if (extractionActions.length) {
    const textPages = await getTextItems(originalBytes)
    for (const action of extractionActions) {
      if (action.type === 'extract_data') {
        appliedActions.push({ type: action.type, applied: true, data: extractStructuredData(textPages, action.text || '') })
      } else {
        appliedActions.push({ type: action.type, applied: true, table: extractTableData(textPages, action.text || '') })
      }
    }
  }

  for (const action of actions.filter((item) => item.type === 'document_citations')) {
    const textPages = await getTextItems(originalBytes)
    appliedActions.push({ type: action.type, applied: true, citations: documentCitations(textPages, action.text || '') })
  }

  for (const action of actions.filter((item) => ['watermark', 'header_footer', 'bates_numbering', 'sticky_note', 'comment', 'freehand', 'shape', 'stamp', 'add_signature', 'fill_and_sign'].includes(item.type))) {
    const count = await drawVisualAction(pdfDocument, action)
    appliedActions.push({ type: action.type, page: action.page, text: action.text, applied: count > 0, pageCount: count })
    if (!count) warnings.push(`Görsel PDF işlemi uygulanamadı: ${action.type}`)
  }

  for (const action of actions) {
    if (action.type === 'delete_page' && Number.isInteger(action.page)) {
      const pageIndex = action.page - 1
      if (pageIndex >= 0 && pageIndex < pdfDocument.getPageCount()) {
        pdfDocument.removePage(pageIndex)
        appliedActions.push({ type: action.type, page: action.page, applied: true })
      } else {
        warnings.push(`Silinecek sayfa bulunamadı: ${action.page}`)
      }
    }

    if (action.type === 'rotate_page' && Number.isInteger(action.page) && [90, 180, 270].includes(action.angle)) {
      const page = pdfDocument.getPages()[action.page - 1]
      if (page) {
        const currentAngle = page.getRotation().angle || 0
        page.setRotation(degrees((currentAngle + action.angle) % 360))
        appliedActions.push({ type: action.type, page: action.page, angle: action.angle, applied: true })
      } else {
        warnings.push(`Döndürülecek sayfa bulunamadı: ${action.page}`)
      }
    }
  }

  const optimizeRequested = actions.some((action) => action.type === 'optimize_pdf')
  let outputBytes = await pdfDocument.save(optimizeRequested
    ? { useObjectStreams: true, addDefaultPage: false }
    : undefined)
  if (optimizeRequested) {
    appliedActions.push({
      type: 'optimize_pdf',
      applied: true,
      mode: 'lossless-rewrite',
      originalBytes: Buffer.byteLength(originalBytes),
      outputBytes: outputBytes.length,
    })
  }
  if (actions.some((action) => action.type === 'redact' && action.text)) {
    const secureResult = await redactPdfBuffer(outputBytes, actions)
    outputBytes = secureResult.pdfBytes
    appliedActions.push(...secureResult.appliedActions)
    warnings.push(...secureResult.warnings)
  }

  return { pdfBytes: outputBytes, appliedActions, warnings }
}
