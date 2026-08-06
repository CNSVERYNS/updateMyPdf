import { GoogleAuth } from 'google-auth-library'

const translationScope = 'https://www.googleapis.com/auth/cloud-translation'
const maxInlinePdfBytes = 20 * 1024 * 1024

const languageAliases = [
  ['tr', ['türkçe', 'turkce', 'turkish']],
  ['en', ['ingilizce', 'ingilizceye', 'english', 'ingiliz']],
  ['es', ['ispanyolca', 'ispanyolcaya', 'spanish', 'español', 'espanol']],
  ['fr', ['fransızca', 'fransizca', 'french', 'français', 'francais']],
  ['de', ['almanca', 'almancaya', 'german', 'deutsch']],
  ['it', ['italyanca', 'italyancaya', 'italian', 'italiano']],
  ['pt', ['portekizce', 'portuguese', 'português', 'portugues']],
  ['nl', ['flemenkçe', 'flemenkce', 'dutch', 'nederlands']],
  ['pl', ['lehçe', 'lehce', 'polish', 'polski']],
  ['ru', ['rusça', 'rusca', 'russian', 'русский']],
  ['uk', ['ukraynaca', 'ukrainian', 'українська']],
  ['ar', ['arapça', 'arapca', 'arabic', 'العربية']],
  ['fa', ['farsça', 'farsca', 'persian', 'فارسی']],
  ['he', ['ibranice', 'hebrew', 'עברית']],
  ['hi', ['hintçe', 'hintce', 'hindi', 'हिन्दी']],
  ['ur', ['urdu', 'اردو']],
  ['zh-CN', ['çince', 'cince', 'chinese', 'mandarin', '简体中文']],
  ['ja', ['japonca', 'japanese', '日本語']],
  ['ko', ['korece', 'korean', '한국어']],
  ['vi', ['vietnamca', 'vietnamese', 'tiếng việt']],
  ['id', ['endonezce', 'indonesian', 'bahasa indonesia']],
]

export const detectGoogleTargetLanguage = (prompt) => {
  const value = String(prompt || '').toLocaleLowerCase()
  const normalizedValue = value.normalize('NFKD').replace(/\p{Diacritic}/gu, '')
  for (const [code, aliases] of languageAliases) {
    if (aliases.some((alias) => value.includes(alias) || normalizedValue.includes(alias.normalize('NFKD').replace(/\p{Diacritic}/gu, '')))) return code
  }
  const languageCode = value.match(/(?:\bto\b|\biçin\b|\bicin\b)\s+([a-z]{2}(?:-[a-z]{2})?)/i)?.[1]
  return languageCode || null
}

const googleServiceAccountCredentials = () => {
  const encoded = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || '').trim()
  const raw = encoded
    ? Buffer.from(encoded, 'base64').toString('utf8')
    : String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    const error = new Error('Google servis hesabı JSON bilgisi okunamadı.')
    error.status = 503
    error.code = 'google_credentials_invalid'
    throw error
  }
}

const googleProjectId = () => {
  const credentials = googleServiceAccountCredentials()
  return String(process.env.GOOGLE_TRANSLATE_PROJECT_ID || credentials?.project_id || '').trim()
}

export const isGoogleDocumentTranslationConfigured = () => Boolean(
  googleProjectId() && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || process.env.GOOGLE_APPLICATION_CREDENTIALS),
)

const createGoogleError = (message, status = 502, code = 'google_translation_error') => {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.provider = 'google-document-translation'
  return error
}

export const translatePdfWithGoogle = async ({ pdfBytes, targetLanguageCode, sourceLanguageCode, nativePdfOnly = true }) => {
  const bytes = Buffer.from(pdfBytes)
  if (bytes.length > maxInlinePdfBytes) throw createGoogleError('Google Document Translation çevrimiçi PDF dosyalarında 20 MB sınırına sahip.', 413, 'google_pdf_too_large')
  const projectId = googleProjectId()
  if (!projectId) throw createGoogleError('Google Document Translation proje kimliği yapılandırılmamış.', 503, 'google_project_missing')
  if (!targetLanguageCode) throw createGoogleError('Google Document Translation hedef dili belirlenemedi.', 400, 'google_target_language_missing')

  const credentials = googleServiceAccountCredentials()
  const auth = new GoogleAuth({
    credentials,
    scopes: [translationScope],
    projectId,
  })
  const accessToken = await auth.getAccessToken()
  if (!accessToken) throw createGoogleError('Google Cloud erişim belirteci alınamadı.', 503, 'google_auth_failed')

  const location = String(process.env.GOOGLE_TRANSLATE_LOCATION || 'us-central1').trim()
  const endpoint = `https://translation.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}:translateDocument`
  const requestBody = {
    ...(sourceLanguageCode ? { sourceLanguageCode } : {}),
    targetLanguageCode,
    documentInputConfig: {
      mimeType: 'application/pdf',
      content: bytes.toString('base64'),
    },
    isTranslateNativePdfOnly: Boolean(nativePdfOnly),
  }
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(requestBody),
    })
  } catch (error) {
    const wrapped = createGoogleError('Google Document Translation servisine ulaşılamadı.', 502)
    wrapped.cause = error
    throw wrapped
  }

  const raw = await response.text()
  let data = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    throw createGoogleError(`Google Document Translation geçersiz yanıt döndürdü (${response.status}).`, 502)
  }
  if (!response.ok) {
    const message = data?.error?.message || `Google Document Translation isteği başarısız oldu (${response.status}).`
    throw createGoogleError(message, response.status >= 400 && response.status < 500 ? response.status : 502)
  }

  const output = data?.documentTranslation?.byteStreamOutputs?.[0]
  if (!output) throw createGoogleError('Google Document Translation PDF çıktısı döndürmedi.', 502, 'google_empty_output')
  return {
    pdfBytes: Buffer.from(output, 'base64'),
    detectedLanguageCode: data?.documentTranslation?.detectedLanguageCode || null,
    mimeType: data?.documentTranslation?.mimeType || 'application/pdf',
  }
}
