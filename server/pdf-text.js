import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

const normalizeText = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .trim()

export async function extractTextPages(pdfBytes) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    disableFontFace: true,
    useSystemFonts: true,
  })
  const documentProxy = await loadingTask.promise
  const pages = []

  try {
    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      const page = await documentProxy.getPage(pageNumber)
      const content = await page.getTextContent()
      const textItems = content.items
        .filter((item) => typeof item.str === 'string')
      const lines = []
      textItems.forEach((item) => {
        const y = Number(item.transform?.[5] || 0)
        const tolerance = Math.max(2, Math.abs(Number(item.transform?.[3] || 10)) * 0.45)
        let line = lines.find((candidate) => Math.abs(candidate.y - y) <= tolerance)
        if (!line) {
          line = { y, items: [] }
          lines.push(line)
        }
        line.items.push(item)
        line.y = (line.y + y) / 2
      })
      const lineText = lines
        .sort((left, right) => right.y - left.y)
        .map((line) => line.items.sort((left, right) => (left.transform?.[4] || 0) - (right.transform?.[4] || 0)).map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      const text = textItems
        .map((item) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      pages.push({ page: pageNumber, text, lines: lineText, normalizedText: normalizeText(text) })
    }
  } finally {
    if (typeof documentProxy.cleanup === 'function') await documentProxy.cleanup()
  }

  return pages
}

const buildWordSet = (text) => new Set(normalizeText(text).toLocaleLowerCase('tr-TR').split(' ').filter(Boolean))

export async function comparePdfBuffers(leftBytes, rightBytes) {
  const [leftPages, rightPages] = await Promise.all([
    extractTextPages(leftBytes),
    extractTextPages(rightBytes),
  ])
  const maxPages = Math.max(leftPages.length, rightPages.length)
  const differences = []

  for (let index = 0; index < maxPages; index += 1) {
    const left = leftPages[index]?.text || ''
    const right = rightPages[index]?.text || ''
    if (normalizeText(left) === normalizeText(right)) continue

    const leftWords = buildWordSet(left)
    const rightWords = buildWordSet(right)
    const added = [...rightWords].filter((word) => !leftWords.has(word)).slice(0, 80)
    const removed = [...leftWords].filter((word) => !rightWords.has(word)).slice(0, 80)
    differences.push({
      page: index + 1,
      left: left.slice(0, 5000),
      right: right.slice(0, 5000),
      added,
      removed,
    })
  }

  return {
    same: differences.length === 0 && leftPages.length === rightPages.length,
    leftPageCount: leftPages.length,
    rightPageCount: rightPages.length,
    differences,
  }
}
