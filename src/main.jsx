import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowLeft,
  ArrowUp,
  Bell,
  Bot,
  Check,
  ChevronDown,
  Cloud,
  CreditCard,
  Download,
  ExternalLink,
  FilePlus2,
  FileText,
  History,
  Highlighter,
  ImagePlus,
  Link2,
  LoaderCircle,
  KeyRound,
  LogIn,
  LogOut,
  MessageSquareText,
  Mail,
  PanelRight,
  PenLine,
  RotateCcw,
  Search,
  Sparkles,
  Split,
  ShieldCheck,
  Trash2,
  Upload,
  UserRound,
  WalletCards,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { supabase, supabaseConfigured } from './supabase'
import './styles.css'

const apiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
let supabaseRefreshPromise = null
const refreshSupabaseSession = async () => {
  if (!supabase) return null
  if (!supabaseRefreshPromise) {
    supabaseRefreshPromise = supabase.auth.refreshSession()
      .then(({ data, error }) => {
        if (error) throw error
        return data?.session || null
      })
      .catch(() => null)
      .finally(() => { supabaseRefreshPromise = null })
  }
  return supabaseRefreshPromise
}
const apiFetch = async (path, options = {}) => {
  const requestHeaders = new Headers(options.headers || {})
  const hasAuthorization = requestHeaders.has('Authorization')
  let requestOptions = options
  if (supabase && hasAuthorization) {
    const current = await supabase.auth.getSession().then(({ data }) => data?.session || null).catch(() => null)
    const expiresSoon = !current?.expires_at || current.expires_at * 1000 < Date.now() + 60_000
    const nextSession = expiresSoon ? await refreshSupabaseSession() : current
    if (nextSession?.access_token) {
      requestHeaders.set('Authorization', `Bearer ${nextSession.access_token}`)
      requestOptions = { ...options, headers: requestHeaders }
    }
  }
  const result = await fetch(`${apiBaseUrl}${path}`, requestOptions)
  if (result.status !== 401 || !supabase || !hasAuthorization) return result
  const nextSession = await refreshSupabaseSession()
  if (!nextSession?.access_token) return result
  const retryHeaders = new Headers(requestOptions.headers || {})
  retryHeaders.set('Authorization', `Bearer ${nextSession.access_token}`)
  return fetch(`${apiBaseUrl}${path}`, { ...requestOptions, headers: retryHeaders })
}

const starterPrompts = [
  { icon: Sparkles, label: 'Belge oluştur', prompt: 'İstediğim bir belgeyi sıfırdan oluşturmama yardım et.' },
  { icon: Highlighter, label: 'Önemli yerleri işaretle', prompt: 'Önemli cümleleri sarı renkle işaretle.' },
  { icon: FileText, label: 'Özet çıkar', prompt: 'Bu PDF için kısa bir özet hazırla.' },
  { icon: Split, label: 'Sayfaları düzenle', prompt: 'Son sayfayı sil.' },
]

const initialMessages = [
  {
    id: 1,
    role: 'assistant',
    text: 'Merhaba! Bir PDF düzenleyebilir veya istediğin herhangi bir belgeyi sıfırdan oluşturabilirim. Ne yapmak istersin?',
  },
]

const assistantPersistenceKey = 'updatemypdf-assistant-state-v2'
const readAssistantPersistence = () => {
  try {
    if (typeof localStorage === 'undefined') return {}
    const parsed = JSON.parse(localStorage.getItem(assistantPersistenceKey) || '{}')
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages.filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.text === 'string').slice(-40) : [],
      profile: parsed.profile && typeof parsed.profile === 'object' ? parsed.profile : null,
      document: parsed.document && typeof parsed.document.base64 === 'string' && parsed.document.base64.length <= 3200000 ? parsed.document : null,
    }
  } catch {
    return {}
  }
}

const pricingPlans = [
  {
    id: 'basic',
    name: 'Basic',
    price: '9.99',
    description: 'PDF düzenlemeye yeni başlayanlar için.',
    features: ['100 AI kredisi / ay · ≈ 50 sayfa düzenleme', '50 sayfaya kadar tek PDF', '1 GB güvenli cloud', 'Standart işlem kuyruğu'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '24.99',
    description: 'Düzenli PDF kullanan profesyoneller için.',
    features: ['500 AI kredisi / ay · ≈ 250 sayfa düzenleme', '250 sayfaya kadar tek PDF', '10 GB güvenli cloud', 'Öncelikli işlem kuyruğu'],
    featured: true,
  },
  {
    id: 'ultimate',
    name: 'Ultimate',
    price: '59.99',
    description: 'Yoğun belge ve ekip iş akışları için.',
    features: ['2.000 AI kredisi / ay · ≈ 1.000 sayfa düzenleme', '1.000 sayfaya kadar tek PDF', '50 GB güvenli cloud', 'En yüksek işlem önceliği'],
  },
]

const signatureStyles = [
  { id: 'elegant', label: 'Elegant', description: 'Zarif ve akışkan' },
  { id: 'classic', label: 'Classic', description: 'Temiz ve profesyonel' },
  { id: 'bold', label: 'Bold', description: 'Belirgin ve güçlü' },
]

const decodePdfFile = (base64, filename) => {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], filename, { type: 'application/pdf' })
}

const mergeAssistantFacts = (previous = [], next = []) => {
  const merged = new Map()
  ;[...(Array.isArray(previous) ? previous : []), ...(Array.isArray(next) ? next : [])].forEach((fact) => {
    if (!fact?.key || !fact?.value) return
    merged.set(String(fact.key), { key: String(fact.key), value: String(fact.value) })
  })
  return Array.from(merged.values()).slice(-80)
}

let pdfJsPromise = null
const loadPdfJs = () => {
  if (!pdfJsPromise) {
    pdfJsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    })
  }
  return pdfJsPromise
}

const validatePdfFile = async (sourceFile) => {
  const { getDocument } = await loadPdfJs()
  const loadingTask = getDocument({ data: new Uint8Array(await sourceFile.arrayBuffer()) })
  const pdfDocument = await loadingTask.promise
  try {
    if (!pdfDocument.numPages) throw new Error('PDF dosyasında görüntülenebilir sayfa bulunamadı.')
    await pdfDocument.getPage(1)
    return pdfDocument.numPages
  } finally {
    if (typeof pdfDocument.cleanup === 'function') await pdfDocument.cleanup()
    if (typeof pdfDocument.destroy === 'function') await pdfDocument.destroy()
    if (typeof loadingTask.destroy === 'function') await loadingTask.destroy()
  }
}

const downloadBase64File = (base64, filename, mimeType) => {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const exportMimeTypes = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html',
  png: 'image/png',
}

function App() {
  const [persistedAssistantState] = useState(readAssistantPersistence)
  const [file, setFile] = useState(null)
  const [originalFile, setOriginalFile] = useState(null)
  const [pdfTitle, setPdfTitle] = useState('')
  const [fileUrl, setFileUrl] = useState('')
  const [messages, setMessages] = useState(() => persistedAssistantState.messages?.length ? persistedAssistantState.messages : initialMessages)
  const [input, setInput] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [longTaskProgress, setLongTaskProgress] = useState(null)
  const [aiStatus, setAiStatus] = useState('idle')
  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [activeTool, setActiveTool] = useState('select')
  const [changes, setChanges] = useState([])
  const [showHistory, setShowHistory] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [readNotificationIds, setReadNotificationIds] = useState([])
  const [comparison, setComparison] = useState(null)
  const [showComparison, setShowComparison] = useState(false)
  const [isComparing, setIsComparing] = useState(false)
  const [isMerging, setIsMerging] = useState(false)
  const [session, setSession] = useState(null)
  const [showAuth, setShowAuth] = useState(false)
  const [authMode, setAuthMode] = useState('login')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [showPricing, setShowPricing] = useState(false)
  const [showAccountNudge, setShowAccountNudge] = useState(false)
  const [guestPromptCount, setGuestPromptCount] = useState(0)
  const [showAccount, setShowAccount] = useState(false)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [toast, setToast] = useState(null)
  const [cloudFiles, setCloudFiles] = useState([])
  const [workspaceRequests, setWorkspaceRequests] = useState([])
  const [showCloudFiles, setShowCloudFiles] = useState(false)
  const [currentCloudPath, setCurrentCloudPath] = useState('')
  const [saveState, setSaveState] = useState('idle')
  const [tokenUsage, setTokenUsage] = useState(null)
  const [showTokenReloadNudge, setShowTokenReloadNudge] = useState(false)
  const [assistantQuestions, setAssistantQuestions] = useState([])
  const [assistantProfile, setAssistantProfile] = useState(() => persistedAssistantState.profile || null)
  const [cachedDocument, setCachedDocument] = useState(() => persistedAssistantState.document || null)
  const [showSignatureRequest, setShowSignatureRequest] = useState(false)
  const [showSignatureRequests, setShowSignatureRequests] = useState(false)
  const [signatureRequestBusy, setSignatureRequestBusy] = useState(false)
  const [signatureRequestError, setSignatureRequestError] = useState('')
  const [signatureRequestResult, setSignatureRequestResult] = useState(null)
  const [imageFile, setImageFile] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef(null)
  const compareInputRef = useRef(null)
  const mergeInputRef = useRef(null)
  const imageInputRef = useRef(null)
  const chatEndRef = useRef(null)
  const restoredDocumentRef = useRef(false)
  const tokenReloadPromptedRef = useRef(false)
  const autoSaveRequestRef = useRef(0)
  const notificationStateReadyRef = useRef(false)
  const knownNotificationIdsRef = useRef(new Set())
  const skipNotificationPersistRef = useRef(false)

  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl)
    }
  }, [fileUrl])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  useEffect(() => {
    try {
      localStorage.setItem(assistantPersistenceKey, JSON.stringify({ messages: messages.slice(-40), profile: assistantProfile, document: cachedDocument }))
    } catch {
      // Local persistence is best effort; cloud storage remains the durable copy for signed-in users.
    }
  }, [messages, assistantProfile, cachedDocument])

  useEffect(() => {
    if (restoredDocumentRef.current || !cachedDocument?.base64) return
    restoredDocumentRef.current = true
    try {
      const restoredFile = decodePdfFile(cachedDocument.base64, cachedDocument.name || 'document.pdf')
      setFile(restoredFile)
      setOriginalFile(restoredFile)
      setPdfTitle(cachedDocument.title || restoredFile.name)
      setCurrentCloudPath(cachedDocument.cloudPath || '')
      setSaveState(cachedDocument.cloudPath ? 'saved' : 'idle')
      setFileUrl(URL.createObjectURL(restoredFile))
      setPageCount(0)
      const infoFormData = new FormData()
      infoFormData.append('file', restoredFile)
      apiFetch('/api/pdf/info', { method: 'POST', headers: authHeaders(), body: infoFormData }).then((infoResponse) => infoResponse.ok ? infoResponse.json() : null).then((info) => { if (info?.pageCount) setPageCount(info.pageCount) }).catch(() => {})
    } catch {
      setCachedDocument(null)
    }
  }, [cachedDocument])

  useEffect(() => {
    if (!supabase) return undefined
    let mounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (mounted) setSession(data.session)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })
    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!session?.user?.id) {
      setNotifications([])
      setReadNotificationIds([])
      notificationStateReadyRef.current = false
      knownNotificationIdsRef.current = new Set()
      return undefined
    }
    const storageKey = `updatemypdf-notifications-${session.user.id}`
    let stored = {}
    try { stored = JSON.parse(localStorage.getItem(storageKey) || '{}') } catch { stored = {} }
    const storedNotifications = Array.isArray(stored.notifications) ? stored.notifications : []
    const storedReadIds = Array.isArray(stored.readIds) ? stored.readIds : []
    setNotifications(storedNotifications)
    setReadNotificationIds(storedReadIds)
    knownNotificationIdsRef.current = new Set(storedNotifications.map((item) => item.id))
    notificationStateReadyRef.current = false
    skipNotificationPersistRef.current = true
    return undefined
  }, [session?.user?.id])

  useEffect(() => {
    if (!session?.user?.id) return undefined
    if (skipNotificationPersistRef.current) {
      skipNotificationPersistRef.current = false
      return undefined
    }
    try {
      localStorage.setItem(`updatemypdf-notifications-${session.user.id}`, JSON.stringify({ notifications, readIds: readNotificationIds }))
    } catch {
      // Notification history remains available for the current session if storage is unavailable.
    }
    return undefined
  }, [session?.user?.id, notifications, readNotificationIds])

  useEffect(() => {
    if (!session || !file || currentCloudPath) return undefined
    let cancelled = false
    uploadFileToCloud(file, '')
      .then(() => { if (!cancelled) return loadCloudFiles() })
      .catch((error) => { if (!cancelled) setToast({ tone: 'error', text: error.message || 'PDF otomatik kaydedilemedi.' }) })
    return () => { cancelled = true }
  }, [session, file, currentCloudPath])

  useEffect(() => {
    if (!session) {
      setTokenUsage(null)
      setShowTokenReloadNudge(false)
      tokenReloadPromptedRef.current = false
      return undefined
    }
    let cancelled = false
    apiFetch('/api/account/tokens', { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then((response) => response.ok ? response.json() : null)
      .then((usage) => { if (!cancelled && usage) setTokenUsage(usage) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [session])

  useEffect(() => {
    if (!tokenUsage) return
    if (!tokenUsage.low) {
      tokenReloadPromptedRef.current = false
      setShowTokenReloadNudge(false)
      return
    }
    if (tokenReloadPromptedRef.current) return
    tokenReloadPromptedRef.current = true
    setShowTokenReloadNudge(true)
    setToast({ tone: 'error', text: `AI token bakiyen %20'nin altına indi. ${tokenUsage.reloadTokens} tokenlık yenileme paketi hazır.` })
  }, [tokenUsage?.low, tokenUsage?.remaining])

  useEffect(() => {
    try {
      setGuestPromptCount(Number(window.sessionStorage.getItem('pdfmaniac_guest_prompt_count') || 0))
    } catch {
      setGuestPromptCount(0)
    }
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timeout = window.setTimeout(() => setToast(null), 4500)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const authHeaders = () => session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}

  const loadCloudFiles = async () => {
    if (!session) return
    const result = await apiFetch('/api/workspace', { headers: authHeaders() })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'Workspace dosyaları okunamadı.')
    setCloudFiles(data.files || [])
    const nextRequests = data.signatureRequests || []
    setWorkspaceRequests(nextRequests)
    const signedRequestGroups = [...nextRequests.reduce((groups, request) => {
      if (request.status !== 'signed' || !request.signedDocumentUrl) return groups
      const groupKey = request.metadata?.batchId || request.id
      const current = groups.get(groupKey) || []
      current.push(request)
      groups.set(groupKey, current)
      return groups
    }, new Map()).values()]
    const signedNotifications = signedRequestGroups.map((group) => {
        const request = group[0]
        const review = request.workflow_type === 'review'
        const actorName = group.length > 1 ? `${group.length} signer` : request.recipient_name || request.recipient_email || 'Bir kullanıcı'
        const signedAt = group.reduce((latest, item) => new Date(item.signed_at || item.created_at).getTime() > new Date(latest).getTime() ? (item.signed_at || item.created_at) : latest, request.signed_at || request.created_at || new Date().toISOString())
        return {
          id: `signature-signed:${request.metadata?.batchId || request.id}`,
          type: 'signature_signed',
          requestId: request.id,
          title: review ? `${actorName} dosyanı inceledi` : group.length > 1 ? `${actorName} dosyanı imzaladı` : `${actorName} dosyanı imzaladı`,
          detail: `${request.document_name} · ${new Date(signedAt).toLocaleString()}`,
          signedDocumentUrl: request.signedDocumentUrl,
          createdAt: signedAt,
        }
      })
    const newNotifications = signedNotifications.filter((notification) => !knownNotificationIdsRef.current.has(notification.id))
    signedNotifications.forEach((notification) => knownNotificationIdsRef.current.add(notification.id))
    if (signedNotifications.length) {
      setNotifications((current) => {
        const merged = new Map(current.map((notification) => [notification.id, notification]))
        signedNotifications.forEach((notification) => merged.set(notification.id, { ...merged.get(notification.id), ...notification }))
        return [...merged.values()].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      })
    }
    if (notificationStateReadyRef.current && newNotifications.length) {
      const latest = newNotifications[newNotifications.length - 1]
      setToast({ tone: 'success', text: latest.title })
    }
    notificationStateReadyRef.current = true
  }

  useEffect(() => {
    if (!session) return undefined
    const refreshWorkspace = () => loadCloudFiles().catch(() => {})
    refreshWorkspace()
    const interval = window.setInterval(refreshWorkspace, 15000)
    window.addEventListener('focus', refreshWorkspace)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshWorkspace)
    }
  }, [session?.user?.id])

  const openAuthPrompt = () => {
    setAuthMode('signup')
    setAuthError('')
    setShowAuth(true)
  }

  const requireAccount = () => {
    if (session) return true
    openAuthPrompt()
    return false
  }

  const recordGuestPrompt = () => {
    if (session) return
    setGuestPromptCount(1)
    try {
      window.sessionStorage.setItem('pdfmaniac_guest_prompt_count', '1')
    } catch {
      // Session storage can be unavailable in private browsing modes.
    }
    setShowAccountNudge(true)
  }

  const handleAuthSubmit = async ({ email, password, fullName, marketingOptIn }) => {
    if (!supabase) return
    setAuthBusy(true)
    setAuthError('')
    try {
      const result = authMode === 'signup'
        ? await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName?.trim() || email, plan: 'basic', marketing_consent: Boolean(marketingOptIn), marketing_consent_at: marketingOptIn ? new Date().toISOString() : null }, emailRedirectTo: window.location.origin } })
        : await supabase.auth.signInWithPassword({ email, password })
      if (result.error) throw result.error
      if (authMode === 'signup' && !result.data.session) {
        setShowAuth(false)
        setToast({ tone: 'success', text: 'Hesabın oluşturuldu. E-posta kutunu kontrol edip doğrulama bağlantısına tıkla.' })
        return
      }
      setShowAuth(false)
      setAuthError('')
      setToast({ tone: 'success', text: 'Cloud hesabına başarıyla giriş yaptın.' })
      setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: 'Cloud hesabına giriş yaptın. PDF’lerini güvenli bucket’a kaydedebilirsin.' }])
    } catch (error) {
      setAuthError(error.message || 'Giriş işlemi başarısız oldu.')
    } finally {
      setAuthBusy(false)
    }
  }

  const handleProfileSave = async ({ fullName, password, marketingConsent }) => {
    if (!supabase) return
    setProfileBusy(true)
    setProfileError('')
    try {
      const updates = { data: { full_name: fullName.trim(), marketing_consent: Boolean(marketingConsent), marketing_consent_at: marketingConsent ? (session.user.user_metadata?.marketing_consent_at || new Date().toISOString()) : null } }
      if (password.trim()) updates.password = password.trim()
      const result = await supabase.auth.updateUser(updates)
      if (result.error) throw result.error
      setSession(result.data.user ? { ...session, user: result.data.user } : session)
      setToast({ tone: 'success', text: 'Hesap bilgilerin güncellendi.' })
    } catch (error) {
      setProfileError(error.message || 'Hesap bilgileri güncellenemedi.')
    } finally {
      setProfileBusy(false)
    }
  }

  const requestPasswordVerification = async () => {
    if (!supabase || !session?.user?.email) throw new Error('Hesabında doğrulanmış bir e-posta bulunamadı.')
    const result = await supabase.auth.signInWithOtp({ email: session.user.email, options: { shouldCreateUser: false } })
    if (result.error) throw result.error
  }

  const confirmPasswordChange = async ({ code, password }) => {
    if (!supabase || !session?.user?.email) throw new Error('Hesap oturumu bulunamadı.')
    const verification = await supabase.auth.verifyOtp({ email: session.user.email, token: code, type: 'email' })
    if (verification.error) throw verification.error
    const result = await supabase.auth.updateUser({ password })
    if (result.error) throw result.error
    const currentSession = await supabase.auth.getSession()
    if (currentSession.data.session) setSession(currentSession.data.session)
  }

  const requestEmailChange = async (email) => {
    const result = await apiFetch('/api/account/email/request', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim() }) })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'E-posta doğrulama kodu gönderilemedi.')
  }

  const confirmEmailChange = async (code) => {
    const result = await apiFetch('/api/account/email/verify', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'E-posta adresi doğrulanamadı.')
    const currentSession = await supabase?.auth.refreshSession()
    if (currentSession?.data?.session) setSession(currentSession.data.session)
  }

  const openBillingPortal = async () => {
    const result = await apiFetch('/api/billing/portal', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ returnUrl: window.location.href }) })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'Ödeme yönetim ekranı açılamadı.')
    if (data.url) window.location.assign(data.url)
  }

  const startCheckout = async (plan) => {
    if (!session) {
      openAuthPrompt()
      return
    }
    const result = await apiFetch('/api/billing/checkout', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'Ödeme ekranı açılamadı.')
    if (data.url) window.location.assign(data.url)
  }

  const signOut = async () => {
    await supabase?.auth.signOut()
    if (fileUrl) URL.revokeObjectURL(fileUrl)
    setFile(null)
    setOriginalFile(null)
    setFileUrl('')
    setPdfTitle('')
    setCloudFiles([])
    setShowCloudFiles(false)
    setCurrentCloudPath('')
    setSaveState('idle')
    setShowAccount(false)
    setMessages(initialMessages)
    setAssistantProfile(null)
    setCachedDocument(null)
    try { localStorage.removeItem(assistantPersistenceKey) } catch {}
  }

  const uploadFileToCloud = async (sourceFile, existingPath = '') => {
    if (!sourceFile) throw new Error('Önce bir PDF yüklemelisin.')
    if (!session) {
      openAuthPrompt()
      throw new Error('Önce Cloud hesabına giriş yapmalısın.')
    }
    const requestId = ++autoSaveRequestRef.current
    setSaveState('saving')
    const formData = new FormData()
    formData.append('file', sourceFile)
    if (existingPath) formData.append('path', existingPath)
    try {
      const result = await apiFetch('/api/storage/upload', { method: 'POST', headers: authHeaders(), body: formData })
      const data = await result.json().catch(() => ({}))
      if (!result.ok) throw new Error(data.error || 'PDF cloud’a yüklenemedi.')
      if (requestId === autoSaveRequestRef.current) {
        setCurrentCloudPath(data.path || existingPath)
        setSaveState('saved')
      }
      if (data.path) setCachedDocument((current) => current ? { ...current, cloudPath: data.path } : current)
      return data
    } catch (error) {
      if (requestId === autoSaveRequestRef.current) setSaveState('error')
      throw error
    }
  }

  const uploadCurrentToCloud = async () => {
    if (!file) throw new Error('Önce bir PDF yüklemelisin.')
    return uploadFileToCloud(file, currentCloudPath)
  }

  const openSignatureRequest = () => {
    if (!file) {
      setToast({ tone: 'error', text: 'İmza talebi göndermek için önce bir PDF yükle.' })
      return
    }
    if (!session) {
      setAuthMode('login')
      openAuthPrompt()
      return
    }
    setSignatureRequestError('')
    setSignatureRequestResult(null)
    setShowSignatureRequest(true)
  }

  const createSignatureRequest = async (details) => {
    if (!file || !session) return
    setSignatureRequestBusy(true)
    setSignatureRequestError('')
    try {
      const documentPath = (await uploadCurrentToCloud()).path
      const result = await apiFetch('/api/signatures/request', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentPath,
          documentName: file.name,
          recipientEmail: details.recipientEmail,
          recipientName: details.recipientName,
          signers: details.signers,
          message: details.message,
          workflowType: details.workflowType,
          expiresIn: details.expiresIn,
          signaturePlacement: details.signaturePlacement,
          signaturePlacements: details.signaturePlacements,
          documentLanguage: assistantProfile?.documentLanguage || '',
        }),
      })
      const data = await result.json().catch(() => ({}))
      if (!result.ok) throw new Error(data.error || 'İmza isteği oluşturulamadı.')
      setSignatureRequestResult(data)
      setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: `${details.workflowType === 'review' ? 'İnceleme' : 'İmza'} isteği e-posta ile gönderildi.` }])
      await loadCloudFiles()
    } catch (error) {
      setSignatureRequestError(error.message || 'İmza isteği oluşturulamadı.')
    } finally {
      setSignatureRequestBusy(false)
    }
  }

  const cancelSignatureRequest = async (requestId) => {
    const result = await apiFetch(`/api/signatures/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', headers: authHeaders() })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'İmza isteği iptal edilemedi.')
    setToast({ tone: 'success', text: 'İmza isteği iptal edildi.' })
    setWorkspaceRequests((current) => current.map((item) => item.id === requestId ? { ...item, status: 'cancelled' } : item))
  }

  const resendSignatureRequest = async (requestId) => {
    const result = await apiFetch(`/api/signatures/${encodeURIComponent(requestId)}/resend`, { method: 'POST', headers: authHeaders() })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'İmza isteği tekrar gönderilemedi.')
    setWorkspaceRequests((current) => current.map((item) => item.id === requestId ? { ...item, status: 'pending', expires_at: data.expiresAt, sent_at: new Date().toISOString() } : item))
    setToast({ tone: 'success', text: 'Yeni e-imza bağlantısı gönderildi.' })
  }

  const openCloudFiles = async () => {
    if (!session) {
      openAuthPrompt()
      return
    }
    try {
      await loadCloudFiles()
      setShowCloudFiles(true)
    } catch (error) {
      setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: error.message || 'Cloud dosyaları okunamadı.' }])
    }
  }

  const downloadCloudFile = async (cloudFile) => {
    if (!cloudFile.signedUrl) return
    const result = await fetch(cloudFile.signedUrl)
    const blob = await result.blob()
    setPdf(new File([blob], cloudFile.name, { type: 'application/pdf' }))
    setCurrentCloudPath(cloudFile.path)
    setSaveState('saved')
    setShowCloudFiles(false)
  }

  const deleteCloudFile = async (cloudFile) => {
    const result = await apiFetch('/api/storage/files', { method: 'DELETE', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ path: cloudFile.path }) })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'Cloud dosyası silinemedi.')
    setCloudFiles((current) => current.filter((fileItem) => fileItem.path !== cloudFile.path))
  }

  const shareCloudFile = async (cloudFile) => {
    const result = await apiFetch('/api/storage/share', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ path: cloudFile.path, expiresIn: 86400 }) })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'Payla\u015f\u0131m ba\u011flant\u0131s\u0131 olu\u015fturulamad\u0131.')
    await navigator.clipboard?.writeText(data.signedUrl)
    setToast({ tone: 'success', text: '24 saatlik g\u00fcvenli payla\u015f\u0131m ba\u011flant\u0131s\u0131 panoya kopyaland\u0131.' })
  }

  const unreadNotificationCount = notifications.filter((notification) => !readNotificationIds.includes(notification.id)).length

  const openNotification = async (notification) => {
    const documentId = encodeURIComponent(notification.requestId || '')
    if (!documentId) return
    window.open(`/document/${documentId}`, '_blank', 'noopener,noreferrer')
    setReadNotificationIds((current) => current.includes(notification.id) ? current : [...current, notification.id])
  }

  const activeChange = changes[changes.length - 1]
  const documentTitle = file?.name || pdfTitle || 'Untitled document'
  const visiblePageNumbers = useMemo(() => {
    const totalPages = pageCount || 1
    const visibleCount = Math.min(totalPages, 8)
    const startPage = totalPages <= 8 ? 1 : Math.min(Math.max(currentPage - 3, 1), totalPages - visibleCount + 1)
    return Array.from({ length: visibleCount }, (_item, index) => startPage + index)
  }, [currentPage, pageCount])

  const setPdf = (selectedFile) => {
    if (!selectedFile || selectedFile.type !== 'application/pdf') return
    if (fileUrl) URL.revokeObjectURL(fileUrl)
    setFile(selectedFile)
    setOriginalFile(selectedFile)
    setPdfTitle(selectedFile.name)
    setFileUrl(URL.createObjectURL(selectedFile))
    setPageCount(0)
    setCurrentPage(1)
    const infoFormData = new FormData()
    infoFormData.append('file', selectedFile)
    apiFetch('/api/pdf/info', { method: 'POST', headers: authHeaders(), body: infoFormData })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (data?.pageCount) setPageCount(data.pageCount); if (data?.title) setPdfTitle(data.title) })
      .catch(() => {})
    setMessages([
      ...initialMessages,
      {
        id: Date.now(),
        role: 'assistant',
        text: `${selectedFile.name} hazır. Bu dosya üzerinde nasıl bir değişiklik yapmamı istersin?`,
      },
    ])
    setChanges([])
    setAssistantQuestions([])
    setAssistantProfile(null)
    setCachedDocument(null)
    setCurrentCloudPath('')
    setSaveState('idle')
  }

  const handleFileChange = (event) => {
    setPdf(event.target.files?.[0])
    event.target.value = ''
  }

  const handleImageChange = (event) => {
    const selectedImage = event.target.files?.[0]
    event.target.value = ''
    if (!selectedImage || !['image/png', 'image/jpeg'].includes(selectedImage.type)) return
    setImageFile(selectedImage)
    setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: `${selectedImage.name} eklendi. Görseli PDF’e nereye ve nasıl ekleyeceğini yazabilirsin.` }])
  }

  const handleCompareFile = async (event) => {
    const secondFile = event.target.files?.[0]
    event.target.value = ''
    if (!secondFile || secondFile.type !== 'application/pdf') return
    if (!file) {
      setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: 'Karşılaştırma için önce ana PDF’i yüklemelisin.' }])
      return
    }
    setIsComparing(true)
    try {
      const formData = new FormData()
      formData.append('files', file)
      formData.append('files', secondFile)
      const result = await apiFetch('/api/pdf/compare', { method: 'POST', headers: authHeaders(), body: formData })
      const rawResponse = await result.text()
      const data = rawResponse ? JSON.parse(rawResponse) : {}
      if (!result.ok) throw new Error(data.error || 'PDF karşılaştırılamadı.')
      setComparison({ fileName: secondFile.name, ...data })
      setShowComparison(true)
    } catch (error) {
      setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: error.message || 'PDF karşılaştırılamadı.' }])
    } finally {
      setIsComparing(false)
    }
  }

  const handleMergeFiles = async (event) => {
    const selectedFiles = Array.from(event.target.files || []).filter((item) => item.type === 'application/pdf')
    event.target.value = ''
    if (!file) {
      setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: 'Birleştirme için önce ana PDF’i yüklemelisin.' }])
      return
    }
    if (!selectedFiles.length) return
    setIsMerging(true)
    try {
      const formData = new FormData()
      formData.append('files', file)
      selectedFiles.forEach((selectedFile) => formData.append('files', selectedFile))
      const result = await apiFetch('/api/pdf/merge', { method: 'POST', headers: authHeaders(), body: formData })
      if (!result.ok) {
        const data = await result.json().catch(() => ({}))
        throw new Error(data.error || 'PDF’ler birleştirilemedi.')
      }
      const mergedBlob = await result.blob()
      const mergedFile = new File([mergedBlob], `${file.name.replace(/\.pdf$/i, '')}-merged.pdf`, { type: 'application/pdf' })
      setPdf(mergedFile)
      setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: `${selectedFiles.length + 1} PDF tek dosyada birleştirildi.` }])
    } catch (error) {
      setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: error.message || 'PDF’ler birleştirilemedi.' }])
    } finally {
      setIsMerging(false)
    }
  }

  const processPrompt = (prompt) => {
    const normalized = prompt.toLocaleLowerCase('tr-TR')
    if (normalized.includes('özet')) {
      return {
        title: 'PDF özeti hazırlandı',
        description: 'Belgenin ana noktaları sağdaki önizleme alanına eklendi.',
        badge: 'Özet',
        detail: 'Belge; amaç, kapsam ve sonraki adımlar başlıkları altında özetlendi.',
      }
    }
    if (normalized.includes('işaret') || normalized.includes('vurgula') || normalized.includes('sarı')) {
      return {
        title: 'Önemli bölümler işaretlendi',
        description: 'Önemli cümleler sarı renkle vurgulandı.',
        badge: 'Highlight',
        detail: '3 önemli bölüm bulundu ve sarı highlight olarak eklendi.',
      }
    }
    if (normalized.includes('sil') || normalized.includes('kaldır')) {
      return {
        title: 'Sayfa değişikliği hazır',
        description: 'İstediğin sayfa değişikliği preview için hazırlandı.',
        badge: 'Sayfa düzeni',
        detail: 'Son sayfa kaldırılmak üzere işaretlendi.',
      }
    }
    if (normalized.includes('çevir') || normalized.includes('ingiliz')) {
      return {
        title: 'Çeviri taslağı hazırlandı',
        description: 'Metin çevirisi preview üzerinde gösteriliyor.',
        badge: 'Çeviri',
        detail: 'Belgenin dili algılandı ve çeviri taslağı oluşturuldu.',
      }
    }
    return {
      title: 'Değişiklik önerisi hazır',
      description: 'İsteğin analiz edildi ve düzenleme preview’e uygulandı.',
      badge: 'AI düzenlemesi',
      detail: 'Bu komut için güvenli bir düzenleme akışı oluşturuldu.',
    }
  }

  const submitPrompt = async (prompt = input) => {
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt || isThinking) return
    if (!session && guestPromptCount >= 1 && file) {
      setShowAccountNudge(true)
      return
    }
    const nextUserMessage = { id: Date.now(), role: 'user', text: cleanPrompt }
    setMessages((current) => [...current, nextUserMessage])
    setInput('')
    setIsThinking(true)
    setLongTaskProgress(null)

    try {
      if (!file) {
        const assistantResponse = await apiFetch('/api/ai/assistant', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({
          message: cleanPrompt,
          phase: assistantProfile?.facts?.length >= 6 ? 'draft' : 'intake',
          profile: assistantProfile,
          conversation: messages.slice(-8).map((item) => ({ role: item.role, content: item.text })),
        }) })
        const assistantRaw = await assistantResponse.text()
        let assistantData = {}
        try {
          assistantData = assistantRaw ? JSON.parse(assistantRaw) : {}
        } catch {
          throw new Error(`Belge asistanı geçerli bir JSON cevabı döndürmedi (${assistantResponse.status}).`)
        }
        if (assistantData.tokenUsage) setTokenUsage(assistantData.tokenUsage)
        if (!assistantResponse.ok) throw new Error(assistantData.error || 'Belge asistanı yanıt veremedi.')
        setAssistantQuestions(assistantData.questions || [])
        setAssistantProfile({
          documentType: assistantData.documentType || assistantProfile?.documentType || null,
          documentTitle: assistantData.documentTitle || assistantProfile?.documentTitle || null,
          documentLanguage: assistantData.documentLanguage || assistantProfile?.documentLanguage || null,
          jurisdiction: assistantData.jurisdiction || assistantProfile?.jurisdiction || null,
          facts: mergeAssistantFacts(assistantProfile?.facts, assistantData.facts),
          researchSources: assistantData.researchSources?.length ? assistantData.researchSources : (assistantProfile?.researchSources || []),
        })
        let assistantText = assistantData.reply || 'Belge akışını hazırlıyorum.'
        if (assistantData.researchSources?.length) assistantText += `\n\nAraştırma kaynakları:\n${assistantData.researchSources.slice(0, 4).map((source) => `• ${source.title}: ${source.url}`).join('\n')}`
        if (assistantData.generatedPdf) {
          setAssistantQuestions([])
          const generatedFile = decodePdfFile(assistantData.generatedPdf, assistantData.generatedFileName || 'document-draft.pdf')
          setFile(generatedFile)
          setOriginalFile(generatedFile)
          setFileUrl(URL.createObjectURL(generatedFile))
          setPdfTitle(assistantData.documentTitle || generatedFile.name)
          setPageCount(0)
          if (assistantData.generatedPdf.length <= 3200000) setCachedDocument({ base64: assistantData.generatedPdf, name: generatedFile.name, title: assistantData.documentTitle || generatedFile.name })
          const infoFormData = new FormData()
          infoFormData.append('file', generatedFile)
          apiFetch('/api/pdf/info', { method: 'POST', headers: authHeaders(), body: infoFormData }).then((infoResponse) => infoResponse.ok ? infoResponse.json() : null).then((info) => { if (info?.pageCount) setPageCount(info.pageCount) }).catch(() => {})
          assistantText += '\n\nPDF belgesini oluşturdum. İstersen şimdi düzenleyebilir, cloud’a kaydedebilir veya imzaya gönderebilirsin.'
          if (session) {
            try {
              await uploadFileToCloud(generatedFile, '')
              assistantText += '\n\nHesabına bağlı cloud alanına da kaydettim.'
              try { await loadCloudFiles() } catch { /* The upload itself succeeded; workspace refresh can retry. */ }
            } catch (cloudError) {
              assistantText += `\n\nPDF oluşturuldu ancak cloud kaydı yapılamadı: ${cloudError.message || 'tekrar deneyebilirsin.'}`
            }
          }
          if (assistantData.complianceNotes?.length) assistantText += `\n\nNotlar:\n${assistantData.complianceNotes.join('\n')}`
          if (!session) recordGuestPrompt()
        }
        setMessages((current) => [...current, { id: Date.now() + 1, role: 'assistant', text: assistantText }])
        setAiStatus('live')
        return
      }
      const formData = new FormData()
      formData.append('prompt', cleanPrompt)
      formData.append('file', file)
      if (imageFile) formData.append('image', imageFile)
      let result = await apiFetch('/api/ai/command', { method: 'POST', headers: authHeaders(), body: formData })
      if (result.status === 202) {
        const queued = await result.json().catch(() => ({}))
        setLongTaskProgress(queued.progress || { phase: 'translation', completedPages: 0, totalPages: queued.pageCount || 0, percent: 0 })
        if (!queued.jobId || !queued.jobToken) throw new Error('Uzun PDF i\u015flemi ba\u015flat\u0131lamad\u0131.')
        setToast({ tone: 'info', text: `${queued.pageCount || 'Uzun'} sayfal\u0131k PDF \u00e7evirisi arka planda s\u00fcr\u00fcyor.` })
        const deadline = Date.now() + 15 * 60 * 1000
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 2500))
          const polled = await apiFetch(`/api/ai/command/${encodeURIComponent(queued.jobId)}`, { headers: { ...authHeaders(), 'X-AI-Job-Token': queued.jobToken } })
          if (polled.status === 202) {
            const progressData = await polled.json().catch(() => ({}))
            if (progressData.progress) setLongTaskProgress(progressData.progress)
            continue
          }
          result = polled
          setLongTaskProgress((current) => current ? { ...current, phase: 'complete', percent: 100 } : current)
          break
        }
        if (result.status === 202) throw new Error('Uzun PDF \u00e7evirisi beklenen s\u00fcrede tamamlanmad\u0131. \u0130\u015flemi daha k\u00fc\u00e7\u00fck sayfa aral\u0131klar\u0131yla deneyebilirsin.')
      }
      const rawResponse = await result.text()
      let data = {}
      try {
        data = rawResponse ? JSON.parse(rawResponse) : {}
      } catch {
        throw new Error(`Backend geçerli bir JSON cevabı döndürmedi (${result.status}). API sunucusunun çalıştığından emin ol.`)
      }
      if (data.tokenUsage) setTokenUsage(data.tokenUsage)
      if (!result.ok) throw new Error(data.error || 'AI isteği başarısız oldu.')

      const firstAction = data.actions?.[0]
      const actionLabel = firstAction?.type ? firstAction.type.replaceAll('_', ' ') : 'AI planı'
      const editedFile = data.editedPdf ? decodePdfFile(data.editedPdf, file.name) : null
      let cloudSaveWarning = ''
      if (editedFile) {
        const editedPageCount = await validatePdfFile(editedFile)
        if (fileUrl) URL.revokeObjectURL(fileUrl)
        setFile(editedFile)
        setFileUrl(URL.createObjectURL(editedFile))
        const titleAction = data.actions?.find((action) => action.type === 'set_title' && action.title)
        if (titleAction?.title) setPdfTitle(titleAction.title)
        setPageCount(editedPageCount)
        const infoFormData = new FormData()
        infoFormData.append('file', editedFile)
        apiFetch('/api/pdf/info', { method: 'POST', headers: authHeaders(), body: infoFormData })
          .then((response) => response.ok ? response.json() : null)
          .then((info) => { if (info?.pageCount) { setPageCount(info.pageCount); setCurrentPage((current) => Math.min(current, info.pageCount)) }; if (info?.title) setPdfTitle(info.title) })
          .catch(() => {})
        if (session) {
          try {
            await uploadFileToCloud(editedFile, currentCloudPath)
            await loadCloudFiles()
          } catch (error) {
            cloudSaveWarning = ` PDF güncellendi ancak otomatik kaydedilemedi: ${error.message || 'daha sonra tekrar dene.'}`
          }
        }
      }
      if (imageFile) setImageFile(null)
      setAssistantQuestions([])
      const officeExports = data.officeExports || []
      officeExports.forEach((officeFile) => downloadBase64File(officeFile.data, officeFile.fileName, exportMimeTypes[officeFile.format] || 'application/octet-stream'))
      const imageExports = data.imageExports || []
      imageExports.forEach((imageFileExport) => downloadBase64File(imageFileExport.data, imageFileExport.fileName, exportMimeTypes[imageFileExport.format] || 'image/png'))
      if (data.audioOverview?.data) downloadBase64File(data.audioOverview.data, data.audioOverview.fileName || 'audio-overview.mp3', 'audio/mpeg')
      const appliedCount = data.appliedActions?.filter((action) => action.applied && !['detect_form_fields', 'export_form_data', 'measure', 'accessibility_check', 'extract_data', 'extract_table', 'document_citations'].includes(action.type)).length || 0
      const analysisNotice = data.analysis?.length
        ? `\n\n${data.analysis.map((item) => item.fields ? `Form alanları: ${item.fields.map((field) => `${field.name}=${field.value ?? ''}`).join(', ') || 'bulunamadı'}` : item.measurements ? `Ölçüm: ${item.measurements.map((measurement) => `S${measurement.page} ${measurement.width}×${measurement.height}pt`).join(', ')}` : item.report ? `Erişilebilirlik: ${item.report.textPages}/${item.report.pageCount} sayfada metin var; başlık ${item.report.titlePresent ? 'mevcut' : 'eksik'}.` : item.data ? `Çıkarılan veri: ${JSON.stringify(item.data.data).slice(0, 3000)}` : item.table ? `Tablo: ${item.table.rowCount} satır\n${item.table.rows.slice(0, 30).map((row) => `S${row.page}: ${row.cells.join(' | ')}`).join('\n')}` : item.citations ? `Kaynak sayfaları:\n${item.citations.citations.map((citation) => `Sayfa ${citation.page}: ${citation.quote}`).join('\n')}` : '').filter(Boolean).join('\n')}`
        : ''
      const officeNotice = officeExports.length ? `\nOffice çıktısı indirildi: ${officeExports.map((officeFile) => officeFile.fileName).join(', ')}` : ''
      const imageNotice = imageExports.length ? `\nGörsel çıktıları indirildi: ${imageExports.map((imageFileExport) => imageFileExport.fileName).join(', ')}` : ''
      const audioNotice = data.audioOverview?.data ? '\nAudio overview indirildi.' : ''
      const warningText = `${data.warnings?.length ? ` ${data.warnings.join(' ')}` : ''}${analysisNotice}${officeNotice}${imageNotice}${audioNotice}${cloudSaveWarning}`
      const ocrText = data.ocrPages?.length
        ? data.ocrPages.map((page) => `Sayfa ${page.page}: ${page.text || '(metin bulunamadı)'}`).join('\n')
        : ''
      const extractedText = data.extractedText?.length
        ? data.extractedText.map((page) => `Sayfa ${page.page}: ${page.text || '(metin bulunamadı)'}`).join('\n')
        : ''
      const responseText = ocrText
        ? `Yerel OCR tamamlandı:\n\n${ocrText.slice(0, 6000)}`
        : extractedText
        ? `PDF metni çıkarıldı:\n\n${extractedText.slice(0, 6000)}${extractedText.length > 6000 ? '\n\n…devamı export edilen dosyada.' : ''}`
        : appliedCount
        ? `Düzenlemeyi PDF'e uyguladım. ${appliedCount} değişiklik preview'a yansıtıldı.${warningText}`
        : `${data.assistantMessage}${warningText}`
      const change = {
        id: Date.now(),
        title: appliedCount ? 'PDF düzenlemesi uygulandı' : 'AI düzenleme planı hazır',
        description: responseText,
        badge: actionLabel,
        detail: `${appliedCount} değişiklik uygulandı. ${data.summary}`,
      }
      setChanges((current) => [...current, change])
      setMessages((current) => [
        ...current,
        { id: Date.now() + 1, role: 'assistant', text: responseText },
      ])
      setAiStatus('live')
      if (!session) recordGuestPrompt()
    } catch (error) {
      setAiStatus('error')
      setMessages((current) => [
        ...current,
        { id: Date.now() + 1, role: 'assistant', text: error.message || 'AI bağlantısı kurulamadı.' },
      ])
    } finally {
      setIsThinking(false)
      setLongTaskProgress(null)
    }
  }

  const resetChanges = () => {
    if (fileUrl && originalFile && file !== originalFile) URL.revokeObjectURL(fileUrl)
    if (originalFile && file !== originalFile) {
      setFile(originalFile)
      setFileUrl(URL.createObjectURL(originalFile))
      setCurrentPage(1)
      const infoFormData = new FormData()
      infoFormData.append('file', originalFile)
      apiFetch('/api/pdf/info', { method: 'POST', headers: authHeaders(), body: infoFormData })
        .then((response) => response.ok ? response.json() : null)
        .then((info) => { if (info?.pageCount) setPageCount(info.pageCount); if (info?.title) setPdfTitle(info.title) })
        .catch(() => {})
    }
    setChanges([])
    setMessages((current) => [
      ...current,
      { id: Date.now(), role: 'assistant', text: 'Son düzenlemeleri geri aldım. Belge ilk haline döndü.' },
    ])
  }

  const downloadCurrentPdf = () => {
    if (!requireAccount()) return
    if (!fileUrl || !file) return
    const link = document.createElement('a')
    link.href = fileUrl
    link.download = `${file.name.replace(/\.pdf$/i, '')}-edited.pdf`
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const previewScale = useMemo(() => ({ transform: `scale(${zoom / 100})` }), [zoom])
  const pdfPreviewSize = useMemo(() => ({ width: `${Math.round(620 * zoom / 100)}px` }), [zoom])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Sparkles size={17} strokeWidth={2.5} /></div>
          <span className="brand-name">update<span>MyPDF</span></span>
          <span className="beta-pill">BETA</span>
        </div>

        {session && file && <div className="document-name">
          <FileText size={15} />
          <span>{documentTitle}</span>
          <span className={`saved-state ${saveState === 'saving' ? 'saving' : saveState === 'error' ? 'error' : ''}`}>{saveState === 'saving' ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />} {saveState === 'saving' ? 'Saving...' : saveState === 'error' ? 'Save failed' : 'Saved'}</span>
        </div>}

        <div className="top-actions">
          {session ? <>
            {tokenUsage && <button className={`token-balance ${tokenUsage.low ? 'low' : ''}`} title={`${tokenUsage.planName} planı · ${tokenUsage.remaining} AI tokenı kaldı`} onClick={() => tokenUsage.low ? setShowTokenReloadNudge(true) : setShowAccount(true)}>
              <span className="token-balance-icon" aria-hidden="true">⚡</span>
              <span><strong>{tokenUsage.remaining}</strong><small>token kaldı</small></span>
            </button>}
            <span className="history-button-wrap">
              <button className="icon-button" title="Bildirimleri göster" aria-label="Bildirimleri göster" onClick={() => setShowHistory((value) => !value)}>
                <span className="topbar-emoji" aria-hidden="true">🕘</span>
              </button>
              {unreadNotificationCount > 0 && <span className="notification-badge">{unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}</span>}
            </span>
            <button className="icon-button" title="İki PDF’i karşılaştır" aria-label="İki PDF’i karşılaştır" onClick={() => compareInputRef.current?.click()}>
              {isComparing ? <LoaderCircle className="spin" size={17} /> : <span className="topbar-emoji" aria-hidden="true">🔎</span>}
            </button>
            <button className="icon-button" title="PDF’leri birleştir" aria-label="PDF’leri birleştir" onClick={() => mergeInputRef.current?.click()}>
              {isMerging ? <LoaderCircle className="spin" size={17} /> : <span className="topbar-emoji" aria-hidden="true">🧩</span>}
            </button>
            <button className="icon-button" title="Planları gör" aria-label="Planları gör" onClick={() => setShowPricing(true)}><span className="topbar-emoji" aria-hidden="true">💳</span></button>
            <button className="icon-button" title="İmza taleplerini takip et" aria-label="İmza taleplerini takip et" onClick={() => setShowSignatureRequests(true)}><span className="topbar-emoji" aria-hidden="true">✅</span></button>
            <button className="icon-button" title="İmza veya inceleme talebi oluştur" aria-label="İmza veya inceleme talebi oluştur" onClick={openSignatureRequest}><span className="topbar-emoji" aria-hidden="true">✍️</span></button>
            {supabaseConfigured && <>
              <button className="icon-button cloud-menu-button" title="Dosyaları göster" aria-label="Dosyaları göster" onClick={openCloudFiles}><span className="topbar-emoji" aria-hidden="true">📁</span></button>
            </>}
            <button className="export-button" onClick={downloadCurrentPdf}>
              <span className="topbar-emoji" aria-hidden="true">⬇️</span> Export
            </button>
            <button className="avatar" title="Hesap ayarları" onClick={() => { setProfileError(''); setShowAccount(true) }}>{session.user.user_metadata?.full_name?.[0]?.toUpperCase() || session.user.email?.[0]?.toUpperCase() || 'C'}</button>
          </> : supabaseConfigured && <>
            <button className="cloud-login-button" onClick={() => { setAuthMode('login'); setAuthError(''); setShowAuth(true) }}><LogIn size={14} /> Giriş yap</button>
            <button className="account-create-button" onClick={() => { setAuthMode('signup'); setAuthError(''); setShowAuth(true) }}>Hesap oluştur</button>
          </>}
          <input ref={compareInputRef} type="file" accept="application/pdf" hidden onChange={handleCompareFile} />
          <input ref={mergeInputRef} type="file" accept="application/pdf" multiple hidden onChange={handleMergeFiles} />
        </div>
      </header>

      <main className="workspace">
        <section className="viewer-panel">
          <div className="viewer-toolbar">
            <div className="tool-group">
              <button className={`tool-button ${activeTool === 'select' ? 'active' : ''}`} onClick={() => setActiveTool('select')} title="Seçim aracı">
                <PanelRight size={16} />
              </button>
              <button className={`tool-button ${activeTool === 'highlight' ? 'active' : ''}`} onClick={() => setActiveTool('highlight')} title="Highlight aracı">
                <Highlighter size={16} />
              </button>
              <span className="toolbar-divider" />
              <button className="tool-button" onClick={() => setZoom((value) => Math.max(70, value - 10))} title="Uzaklaştır"><ZoomOut size={16} /></button>
              <span className="zoom-label">{zoom}%</span>
              <button className="tool-button" onClick={() => setZoom((value) => Math.min(140, value + 10))} title="Yakınlaştır"><ZoomIn size={16} /></button>
            </div>
            <div className="page-indicator"><span>{currentPage}</span> / {pageCount || '—'}</div>
            <button className="tool-button" title="Geri al" onClick={resetChanges}><RotateCcw size={16} /></button>
          </div>

          <div
            className={`viewer-stage ${isDragging ? 'dragging' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => { event.preventDefault(); setIsDragging(false); setPdf(event.dataTransfer.files?.[0]) }}
          >
            {fileUrl ? (
              <div className="pdf-viewer-scroll">
                <div className="pdf-viewer-scroll-inner">
                  <div className="uploaded-pdf" style={pdfPreviewSize}>
                    <PdfPreview src={fileUrl} page={currentPage} onPageCount={setPageCount} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty-viewer">
                <div className="empty-viewer-copy">
                  <div className="upload-icon"><Upload size={22} /></div>
                  <h2>PDF’ini buraya bırak</h2>
                  <p>veya cihazından bir dosya seçerek başla</p>
                  <button className="choose-file-button" onClick={() => fileInputRef.current?.click()}>
                    <FilePlus2 size={16} /> PDF seç
                  </button>
                  <span className="drop-hint">PDF dosyaları · Maks. 50 MB</span>
                </div>
                <DemoDocument change={activeChange} style={previewScale} />
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="application/pdf" hidden onChange={handleFileChange} />
          </div>

          <div className="viewer-footer">
            <button className="page-nav" title="Önceki sayfa" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage <= 1}>‹</button>
            <div className="page-dots">{visiblePageNumbers.map((page) => <button className={`page-dot ${page === currentPage ? 'current' : ''}`} onClick={() => setCurrentPage(page)} key={page} aria-label={`Sayfa ${page}`} />)}</div>
            <button className="page-nav" title="Sonraki sayfa" onClick={() => setCurrentPage((page) => Math.min(pageCount || 1, page + 1))} disabled={currentPage >= (pageCount || 1)}>›</button>
            <span className="footer-separator" />
            <span className="fit-label">Fit to width</span>
          </div>
        </section>

        <section className="chat-panel">
          <div className="chat-header">
            <div className="chat-title-wrap">
              <div className="ai-avatar"><Sparkles size={16} /></div>
              <div><h1>AI assistant</h1><p><span className={`online-dot ${aiStatus === 'error' ? 'error' : ''}`} /> {aiStatus === 'live' ? 'Live AI connected' : aiStatus === 'error' ? 'Connection issue' : 'Ready to edit'}</p></div>
            </div>
            <button className="icon-button light" title="Sohbeti temizle" onClick={() => { setMessages(initialMessages); setAssistantQuestions([]); setAssistantProfile(null) }}><Trash2 size={16} /></button>
          </div>

          <div className="chat-body">
            {messages.map((message) => (
              <div className={`message-row ${message.role}`} key={message.id}>
                {message.role === 'assistant' && <div className="mini-ai-avatar"><Sparkles size={12} /></div>}
                <div className="message-bubble">{message.text}</div>
              </div>
            ))}
            {isThinking && (
              <div className="message-row assistant">
                <div className="mini-ai-avatar"><Sparkles size={12} /></div>
                <div className="message-bubble thinking"><span /><span /><span /></div>
              </div>
            )}
            {isThinking && longTaskProgress && <AiProgressCard progress={longTaskProgress} />}
            {!file && assistantQuestions.length > 0 && <AssistantQuestionsCard questions={assistantQuestions} onSubmit={(answers) => submitPrompt(answers)} disabled={isThinking} />}
            <div ref={chatEndRef} />
          </div>

          <div className="suggestions">
            <span className="suggestions-label">Try asking</span>
            {starterPrompts.map(({ icon: Icon, label, prompt }) => (
              <button key={label} className="suggestion-chip" onClick={() => submitPrompt(prompt)}><Icon size={14} /> {label}</button>
            ))}
          </div>

          <div className="composer-wrap">
            <div className="composer">
              {imageFile && <div className="image-attachment"><ImagePlus size={13} /><span>{imageFile.name}</span><button type="button" onClick={() => setImageFile(null)} aria-label="Görseli kaldır"><X size={13} /></button></div>}
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitPrompt() } }}
                placeholder="Ask AI to edit your PDF..."
                rows={2}
              />
              <button className={`send-button ${input.trim() ? 'ready' : ''}`} onClick={() => submitPrompt()} disabled={!input.trim() || isThinking} title="Gönder">
                {isThinking ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
              </button>
            </div>
            <div className="composer-meta">
              <button className="attach-image-button" type="button" onClick={() => imageInputRef.current?.click()}><ImagePlus size={12} /> {imageFile ? 'Görsel hazır' : 'Görsel ekle'}</button>
              <span><MessageSquareText size={12} /> Enter to send</span><span>AI can make mistakes</span>
            </div>
            <input ref={imageInputRef} type="file" accept="image/png,image/jpeg" hidden onChange={handleImageChange} />
          </div>
        </section>
      </main>

      {showHistory && <HistoryDrawer notifications={notifications} readNotificationIds={readNotificationIds} unreadCount={unreadNotificationCount} changes={changes} onNotificationOpen={openNotification} onClose={() => setShowHistory(false)} />}
      {showComparison && <ComparisonDrawer comparison={comparison} onClose={() => setShowComparison(false)} />}
      {showCloudFiles && <CloudFilesDrawer files={cloudFiles} signatureRequests={workspaceRequests} onClose={() => setShowCloudFiles(false)} onOpen={downloadCloudFile} onDelete={deleteCloudFile} onShare={shareCloudFile} onResend={resendSignatureRequest} onCancel={cancelSignatureRequest} />}
      {showSignatureRequest && <SignatureRequestModal busy={signatureRequestBusy} error={signatureRequestError} result={signatureRequestResult} documentName={file?.name} fileUrl={fileUrl} senderName={session?.user?.user_metadata?.full_name || session?.user?.email} senderEmail={session?.user?.email} pageCount={pageCount} currentPage={currentPage} onClose={() => setShowSignatureRequest(false)} onSubmit={createSignatureRequest} onOpenRequests={() => { setShowSignatureRequest(false); setShowSignatureRequests(true) }} />}
      {showSignatureRequests && <SignatureRequestsDrawer session={session} authHeaders={authHeaders} onClose={() => setShowSignatureRequests(false)} onCancel={cancelSignatureRequest} onResend={resendSignatureRequest} />}
      {showAuth && <AuthModal mode={authMode} busy={authBusy} error={authError} onModeChange={(mode) => { setAuthMode(mode); setAuthError('') }} onClose={() => setShowAuth(false)} onSubmit={handleAuthSubmit} />}
      {showAccount && session && <AccountManagementModal session={session} busy={profileBusy} error={profileError} onClose={() => setShowAccount(false)} onProfileSave={handleProfileSave} onChangeEmail={requestEmailChange} onConfirmEmailChange={confirmEmailChange} onRequestPasswordCode={requestPasswordVerification} onConfirmPasswordChange={confirmPasswordChange} onOpenPricing={() => { setShowAccount(false); setShowPricing(true) }} onOpenBilling={openBillingPortal} onSignOut={signOut} />}
      {showAccountNudge && !session && <AccountNudge onClose={() => setShowAccountNudge(false)} onSignup={openAuthPrompt} onPricing={() => setShowPricing(true)} />}
      {showTokenReloadNudge && session && tokenUsage && <TokenReloadNudge usage={tokenUsage} onClose={() => setShowTokenReloadNudge(false)} onOpenPricing={() => { setShowTokenReloadNudge(false); setShowPricing(true) }} />}
      {showPricing && <PricingModal currentPlan={session?.user?.user_metadata?.plan || 'basic'} onClose={() => setShowPricing(false)} onSelect={async (plan) => { try { await startCheckout(plan) } catch (checkoutError) { setToast({ tone: 'error', text: checkoutError.message || 'Ödeme ekranı açılamadı.' }) } }} />}
      {toast && <ToastNotice notification={toast} onClose={() => setToast(null)} />}
    </div>
  )
}

function DemoDocument({ change, style }) {
  const highlighted = change?.badge === 'Highlight'
  return (
    <div className="demo-document" style={style}>
      <div className="demo-page-label">LIVE PREVIEW</div>
      <div className="doc-topline"><span>ACME / PRODUCT BRIEF</span><span>2024 — 04</span></div>
      <div className="doc-accent" />
      <h3>Designing products<br /><em>people remember.</em></h3>
      <p className="doc-lede">A practical guide to building clear, useful and memorable digital experiences.</p>
      <div className="doc-rule" />
      <div className="doc-grid">
        <div><span className="doc-number">01</span><strong>Start with the user</strong><p className={highlighted ? 'highlighted' : ''}>Great products begin with a clear understanding of the people they serve.</p></div>
        <div><span className="doc-number">02</span><strong>Make it obvious</strong><p className={highlighted ? 'highlighted' : ''}>Every interaction should feel simple, intentional and easy to understand.</p></div>
      </div>
      {change?.badge === 'Özet' && <div className="summary-card"><Sparkles size={13} /><span><b>AI summary</b> Product clarity and user needs are the central themes of this document.</span></div>}
      <div className="doc-footer"><span>ACME STUDIO</span><span>01</span></div>
    </div>
  )
}

function PdfPreview({ src, page, onPageCount }) {
  const canvasRef = useRef(null)
  const pdfDocumentRef = useRef(null)
  const loadingTaskRef = useRef(null)
  const renderTaskRef = useRef(null)
  const [pdfDocument, setPdfDocument] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setPdfDocument(null)
    renderTaskRef.current?.cancel()
    loadingTaskRef.current?.destroy?.()
    pdfDocumentRef.current?.destroy?.()
    renderTaskRef.current = null
    loadingTaskRef.current = null
    pdfDocumentRef.current = null

    const loadPdf = async () => {
      try {
        const { getDocument } = await loadPdfJs()
        const loadingTask = getDocument({ url: src })
        loadingTaskRef.current = loadingTask
        const document = await loadingTask.promise
        if (cancelled) {
          if (typeof document.destroy === 'function') await document.destroy()
          return
        }
        pdfDocumentRef.current = document
        onPageCount(document.numPages)
        setPdfDocument(document)
      } catch (loadError) {
        if (!cancelled && loadError?.name !== 'RenderingCancelledException') {
          setError('PDF preview bu belgeyi görüntüleyemedi. İndirme yine kullanılabilir.')
          setLoading(false)
        }
      }
    }
    loadPdf()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      loadingTaskRef.current?.destroy?.()
      pdfDocumentRef.current?.destroy?.()
      renderTaskRef.current = null
      loadingTaskRef.current = null
      pdfDocumentRef.current = null
    }
  }, [src, onPageCount])

  useEffect(() => {
    if (!pdfDocument) return undefined
    let cancelled = false
    setLoading(true)
    setError('')
    renderTaskRef.current?.cancel()

    const renderPage = async () => {
      let renderTask = null
      try {
        const pdfPage = await pdfDocument.getPage(Math.min(Math.max(1, page), pdfDocument.numPages))
        if (cancelled) return
        const viewport = pdfPage.getViewport({ scale: 1.35 })
        const canvas = canvasRef.current
        if (!canvas) return
        const context = canvas.getContext('2d', { alpha: false })
        const deviceScale = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * deviceScale)
        canvas.height = Math.floor(viewport.height * deviceScale)
        canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`
        renderTask = pdfPage.render({ canvasContext: context, viewport, transform: deviceScale !== 1 ? [deviceScale, 0, 0, deviceScale, 0, 0] : null })
        renderTaskRef.current = renderTask
        await renderTask.promise
        if (!cancelled && renderTaskRef.current === renderTask) {
          renderTaskRef.current = null
          setLoading(false)
        }
      } catch (renderError) {
        if (!cancelled && renderError?.name !== 'RenderingCancelledException' && renderTaskRef.current === renderTask) {
          renderTaskRef.current = null
          setError('PDF preview bu belgeyi görüntüleyemedi. İndirme yine kullanılabilir.')
          setLoading(false)
        }
      }
    }
    renderPage()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [pdfDocument, page])

  return <div className="pdf-preview-canvas-wrap">{error ? <div className="pdf-preview-state error">{error}</div> : <canvas ref={canvasRef} className={`pdf-preview-canvas ${loading ? 'loading' : ''}`} aria-label="PDF preview" />}{loading && !error && <div className="pdf-preview-state">PDF preview hazırlanıyor...</div>}</div>
}

function AssistantQuestionsCard({ questions, onSubmit, disabled }) {
  const [values, setValues] = useState({})
  const [error, setError] = useState('')
  const questionKey = questions.map((question) => question.id).join('|')

  useEffect(() => {
    setValues({})
    setError('')
  }, [questionKey])

  const submit = (event) => {
    event.preventDefault()
    const missing = questions.find((question) => question.required && !String(values[question.id] || '').trim())
    if (missing) {
      setError(`${missing.label} alanını doldurmalısın.`)
      return
    }
    setError('')
    onSubmit(questions.map((question) => `${question.label}: ${String(values[question.id] || '').trim() || 'Belirtilmedi'}`).join('\n'))
  }

  return (
    <form className="assistant-question-card" onSubmit={submit}>
      <div className="assistant-question-heading"><Sparkles size={13} /><strong>Belge bilgileri</strong><span>Belgenin doğru hazırlanması için</span></div>
      {questions.map((question) => <label key={question.id}>{question.label}{question.required && <sup>*</sup>}{question.kind === 'select' ? <select value={values[question.id] || ''} onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))}><option value="">Seç</option>{(question.options || []).map((option) => <option value={option} key={option}>{option}</option>)}</select> : question.kind === 'textarea' ? <textarea value={values[question.id] || ''} onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))} placeholder={question.question} rows={2} /> : <input type={question.kind === 'date' || question.kind === 'number' || question.kind === 'email' ? question.kind : 'text'} value={values[question.id] || ''} onChange={(event) => setValues((current) => ({ ...current, [question.id]: event.target.value }))} placeholder={question.question} />}{question.help && <small>{question.help}</small>}</label>)}
      {error && <div className="assistant-question-error">{error}</div>}
      <button type="submit" className="assistant-question-submit" disabled={disabled}>{disabled ? <LoaderCircle className="spin" size={14} /> : <ArrowUp size={14} />} Yanıtları gönder</button>
    </form>
  )
}

function HistoryDrawer({ notifications, readNotificationIds, unreadCount, changes, onNotificationOpen, onClose }) {
  return (
    <aside className="history-drawer">
      <div className="history-heading"><div><span>ACTIVITY LOG</span><h2>Bildirimler {unreadCount > 0 && <em className="history-unread-label">{unreadCount} yeni</em>}</h2></div><button className="icon-button light" onClick={onClose}><X size={17} /></button></div>
      {notifications.length === 0 ? <div className="history-empty"><History size={20} /><p>Henüz bir bildirim yok.</p></div> : <div className="notification-list">{notifications.map((notification) => {
        const isRead = readNotificationIds.includes(notification.id)
        return <button type="button" className={`notification-item ${isRead ? 'read' : 'unread'}`} key={notification.id} onClick={() => onNotificationOpen(notification)}>
          <span className="notification-dot">{isRead ? <Check size={12} /> : '•'}</span>
          <span className="notification-copy"><strong>{notification.title}</strong><small>{notification.detail}</small><em>İmzalı PDF’i aç ↗</em></span>
        </button>
      })}</div>}
      {changes.length > 0 && <div className="change-log-section"><div className="change-log-label">PDF DÜZENLEME KAYITLARI</div><div className="history-list">{[...changes].reverse().map((change, index) => <div className="history-item" key={change.id}><div className="history-dot">{index === 0 ? <Check size={12} /> : index + 1}</div><div><strong>{change.title}</strong><p>{change.detail}</p></div></div>)}</div></div>}
    </aside>
  )
}

function CapabilitiesDrawer({ summary, onClose }) {
  const categories = summary?.categories || []
  const capabilities = summary?.capabilities || []
  const counts = summary?.counts || {}

  return (
    <aside className="history-drawer capability-drawer">
      <div className="history-heading">
        <div><span>UPDATEMYPDF</span><h2>Yetenekler</h2></div>
        <button className="icon-button light" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="capability-summary">
        <div><strong>{counts.implemented || 0}</strong><span>hazır</span></div>
        <div><strong>{counts.planned || 0}</strong><span>planlı</span></div>
        <div><strong>{counts.external || 0}</strong><span>servis</span></div>
      </div>
      <div className="capability-list">
        {categories.map((category) => {
          const items = capabilities.filter((capability) => capability.category === category.id)
          return (
            <div className="capability-group" key={category.id}>
              <div className="capability-group-title">{category.label}<span>{items.length}</span></div>
              {items.map((capability) => (
                <div className="capability-item" key={capability.id}>
                  <span>{capability.label}</span>
                  <small className={`capability-status ${capability.status}`}>{capability.status === 'implemented' ? 'Hazır' : capability.status === 'planned' ? 'Planlı' : 'Servis'}</small>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function ComparisonDrawer({ comparison, onClose }) {
  if (!comparison) return null
  return (
    <aside className="history-drawer comparison-drawer">
      <div className="history-heading">
        <div><span>PDF ANALİZİ</span><h2>Karşılaştırma</h2></div>
        <button className="icon-button light" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="comparison-overview">
        <strong>{comparison.same ? 'PDF’ler aynı görünüyor' : `${comparison.differences?.length || 0} sayfada fark bulundu`}</strong>
        <p>İkinci dosya: {comparison.fileName}</p>
        <div className="comparison-stats"><span>Sol: {comparison.left?.pages || 0} sayfa</span><span>Sağ: {comparison.right?.pages || 0} sayfa</span></div>
      </div>
      {comparison.differences?.length ? (
        <div className="comparison-diffs">
          {comparison.differences.map((difference) => (
            <div className="compare-diff" key={difference.page}>
              <strong>Sayfa {difference.page}</strong>
              <span>{difference.added?.length || 0} eklenen · {difference.removed?.length || 0} çıkarılan kelime</span>
              {difference.added?.length > 0 && <p className="compare-words added">+ {difference.added.slice(0, 18).join(' ')}</p>}
              {difference.removed?.length > 0 && <p className="compare-words removed">− {difference.removed.slice(0, 18).join(' ')}</p>}
            </div>
          ))}
        </div>
      ) : <div className="history-empty"><Check size={20} /><p>Metin farkı bulunamadı.</p></div>}
    </aside>
  )
}

function CloudFilesDrawer({ files, signatureRequests, onClose, onOpen, onDelete, onShare, onResend, onCancel }) {
  const [error, setError] = useState('')
  const [tab, setTab] = useState('all')
  const [busyId, setBusyId] = useState('')
  const allFiles = files || []
  const allRequests = signatureRequests || []
  const signedFiles = allFiles.filter((file) => file.isSignedCopy)
  const signedRequests = allRequests.filter((request) => request.status === 'signed' && !request.signedDocumentPath)
  const pendingRequests = allRequests.filter((request) => ['pending', 'viewed'].includes(request.status))
  const pendingPaths = new Set(pendingRequests.map((request) => request.document_path).filter(Boolean))

  const runRequestAction = async (request, action) => {
    setBusyId(request.id)
    setError('')
    try {
      await action(request.id)
      if (tab === 'pending') setTab('pending')
    } catch (actionError) {
      setError(actionError.message || 'İşlem tamamlanamadı.')
    } finally {
      setBusyId('')
    }
  }

  return (
    <aside className="history-drawer cloud-files-drawer">
      <div className="history-heading">
        <div><span>UPDATEMYPDF WORKSPACE</span><h2>Dosya merkezi</h2></div>
        <button className="icon-button light" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="workspace-tabs">
        <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>Tüm dosyalar <span>{allFiles.length}</span></button>
        <button className={tab === 'signed' ? 'active' : ''} onClick={() => setTab('signed')}>İmzalanan <span>{signedFiles.length + signedRequests.length}</span></button>
        <button className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>İmza bekleyen <span>{pendingRequests.length}</span></button>
      </div>
      {error && <div className="auth-error inline-error">{error}</div>}
      {tab === 'all' && (allFiles.length === 0 ? <div className="history-empty"><Cloud size={20} /><p>Henüz kayıtlı dosyan yok.</p></div> : <div className="cloud-file-list">
        {allFiles.map((file) => (
          <div className="cloud-file-item" key={file.path}>
            <FileText size={16} />
            <div className="cloud-file-copy"><strong>{file.name}</strong><span>{file.size ? `${Math.ceil(file.size / 1024)} KB` : 'PDF'}</span></div>
            {file.isSignedCopy ? <em className="request-status signed">signed</em> : pendingPaths.has(file.path) ? <em className="request-status pending">pending signature</em> : null}
            <button className="icon-button light" title="PDF’i aç" onClick={() => onOpen(file)}><Download size={15} /></button>
            <button className="icon-button light" title="Süreli paylaşım bağlantısı oluştur" onClick={async () => { try { await onShare(file) } catch (shareError) { setError(shareError.message || 'Bağlantı oluşturulamadı.') } }}><Link2 size={15} /></button>
            <button className="icon-button light" title="Dosyayı sil" onClick={async () => { try { await onDelete(file) } catch (deleteError) { setError(deleteError.message || 'Dosya silinemedi.') } }}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>)}
      {tab === 'signed' && (signedFiles.length + signedRequests.length === 0 ? <div className="history-empty"><Check size={20} /><p>Henüz imzalanmış bir dosya yok.</p></div> : <div className="cloud-file-list workspace-request-list">
        {signedFiles.map((file) => <div className="cloud-file-item workspace-request-item" key={file.path}><FileText size={16} /><div className="cloud-file-copy"><strong>{file.name}</strong><span>İmzalı kopya · {new Date(file.createdAt).toLocaleString()}</span><button type="button" className="signed-document-link signed-document-button" onClick={() => onOpen(file)}>İmzalı PDF’i aç</button></div><em className="request-status signed">signed</em></div>)}
        {signedRequests.map((request) => <div className="cloud-file-item workspace-request-item" key={request.id}><FileText size={16} /><div className="cloud-file-copy"><strong>{request.document_name}</strong><span>{request.recipient_name || request.recipient_email} · {new Date(request.signed_at || request.created_at).toLocaleString()}</span>{request.signedDocumentUrl && <a className="signed-document-link" href={request.signedDocumentUrl} target="_blank" rel="noreferrer">İmzalı PDF’i aç</a>}</div><em className="request-status signed">signed</em></div>)}
      </div>)}
      {tab === 'pending' && (pendingRequests.length === 0 ? <div className="history-empty"><PenLine size={20} /><p>Bekleyen imza talebi yok.</p></div> : <div className="cloud-file-list workspace-request-list">
        {pendingRequests.map((request) => <div className="cloud-file-item workspace-request-item" key={request.id}><FileText size={16} /><div className="cloud-file-copy"><strong>{request.document_name}</strong><span>{request.recipient_name || request.recipient_email} · {request.status}</span><small>Son geçerlilik: {new Date(request.expires_at).toLocaleString()}</small></div><div className="workspace-request-actions"><button type="button" className="signature-resend-button" onClick={() => runRequestAction(request, onResend)} disabled={busyId === request.id}>{busyId === request.id ? <LoaderCircle className="spin" size={12} /> : 'Resend'}</button><button type="button" className="signature-cancel-button" onClick={() => { if (window.confirm('Bu imza isteğini iptal etmek istediğine emin misin?')) runRequestAction(request, onCancel) }} disabled={busyId === request.id}>İptal</button></div></div>)}
      </div>)}
    </aside>
  )
}

function SignatureRequestModal({ busy, error, result, documentName, fileUrl, senderName, senderEmail, pageCount, currentPage, onClose, onSubmit, onOpenRequests }) {
  const createSigner = (index = 0) => ({ id: `signer-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`, name: '', email: '' })
  const [signers, setSigners] = useState(() => [createSigner(0)])
  const [activeSignerId, setActiveSignerId] = useState('')
  const [message, setMessage] = useState('')
  const [workflowType, setWorkflowType] = useState('signature')
  const [expiresIn, setExpiresIn] = useState('604800')
  const [placements, setPlacements] = useState({})
  const [draftPlacement, setDraftPlacement] = useState(null)
  const [copied, setCopied] = useState(false)
  const [formError, setFormError] = useState('')
  const previewPageCount = Math.max(1, pageCount || 1)
  const handlePreviewPageCount = useCallback(() => {}, [])

  useEffect(() => {
    if (!activeSignerId && signers[0]) setActiveSignerId(signers[0].id)
  }, [activeSignerId, signers])

  const activeSigner = signers.find((signer) => signer.id === activeSignerId) || signers[0]
  const getPlacement = (signer, index = 0) => placements[signer?.id] || { page: Math.max(1, currentPage || 1), left: 0.1, top: Math.min(0.78, 0.58 + index * 0.11), width: 0.42, height: 0.14, placed: false }
  const activeSignerIndex = Math.max(0, signers.findIndex((signer) => signer.id === activeSigner?.id))
  const activePlacement = getPlacement(activeSigner, activeSignerIndex)

  const updateSigner = (id, key, value) => setSigners((current) => current.map((signer) => signer.id === id ? { ...signer, [key]: value } : signer))
  const addSigner = () => {
    if (signers.length >= 8) return
    const signer = createSigner(signers.length)
    setSigners((current) => [...current, signer])
    setActiveSignerId(signer.id)
    setFormError('')
  }
  const removeSigner = (id) => {
    if (signers.length <= 1) return
    const next = signers.filter((signer) => signer.id !== id)
    setSigners(next)
    if (activeSignerId === id) setActiveSignerId(next[0]?.id || '')
    setPlacements((current) => { const nextPlacements = { ...current }; delete nextPlacements[id]; return nextPlacements })
  }

  const relativePointer = (event) => {
    const paper = event.currentTarget.getBoundingClientRect()
    const paperWidth = Math.max(1, paper.width)
    const paperHeight = Math.max(1, paper.height)
    const pointerX = Number.isFinite(event.clientX) ? event.clientX : paper.left
    const pointerY = Number.isFinite(event.clientY) ? event.clientY : paper.top
    return { left: Math.min(.97, Math.max(.03, (pointerX - paper.left) / paperWidth)), top: Math.min(.97, Math.max(.03, (pointerY - paper.top) / paperHeight)) }
  }
  const startPlacement = (event) => {
    if (!activeSigner) return
    event.preventDefault()
    const point = relativePointer(event)
    setDraftPlacement({ left: point.left, top: point.top, width: 0, height: 0 })
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch (_error) {}
    setFormError('')
  }
  const movePlacement = (event) => {
    if (!draftPlacement) return
    const point = relativePointer(event)
    const left = Math.min(draftPlacement.left, point.left)
    const top = Math.min(draftPlacement.top, point.top)
    const width = Math.min(Math.abs(point.left - draftPlacement.left), .92 - left)
    const height = Math.min(Math.abs(point.top - draftPlacement.top), .92 - top)
    setDraftPlacement((current) => current ? { ...current, left, top, width, height } : current)
  }
  const finishPlacement = (event) => {
    if (!draftPlacement || !activeSigner) return
    event.preventDefault()
    const point = relativePointer(event)
    const left = Math.min(draftPlacement.left, point.left)
    const top = Math.min(draftPlacement.top, point.top)
    const width = Math.min(Math.abs(point.left - draftPlacement.left), .92 - left)
    const height = Math.min(Math.abs(point.top - draftPlacement.top), .92 - top)
    setDraftPlacement(null)
    try { if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) } catch (_error) {}
    if (width < .08 || height < .05) {
      setFormError('İmza alanını oluşturmak için PDF üzerinde basılı tutup sürükleyerek bir kutu çiz.')
      return
    }
    setPlacements((current) => ({ ...current, [activeSigner.id]: { ...activePlacement, left, top, width, height, placed: true } }))
    setFormError('')
  }
  const selectWorkflow = (value) => {
    setWorkflowType(value)
    if (value === 'review' && signers.length > 1) {
      setSigners((current) => current.slice(0, 1))
      setActiveSignerId(signers[0]?.id || '')
    }
  }

  const submit = (event) => {
    event.preventDefault()
    const normalizedSigners = signers.map((signer) => ({ name: signer.name.trim(), email: signer.email.trim().toLowerCase(), id: signer.id }))
    if (normalizedSigners.some((signer) => !signer.name)) return setFormError('Her signer için ad soyad gerekli.')
    if (normalizedSigners.some((signer) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signer.email))) return setFormError('Her signer için geçerli bir e-posta adresi yaz.')
    if (new Set(normalizedSigners.map((signer) => signer.email)).size !== normalizedSigners.length) return setFormError('Aynı e-posta adresi birden fazla signer olarak eklenemez.')
    if (workflowType === 'signature' && normalizedSigners.some((signer) => !placements[signer.id]?.placed)) return setFormError('Her signer’ı seçip PDF üzerinde imza alanını yerleştir.')
    setFormError('')
    onSubmit({ signers: normalizedSigners, recipientEmail: normalizedSigners[0].email, recipientName: normalizedSigners[0].name, message: message.trim(), workflowType, expiresIn: Number(expiresIn), signaturePlacement: placements[normalizedSigners[0].id] || activePlacement, signaturePlacements: Object.fromEntries(normalizedSigners.map((signer) => [signer.id, placements[signer.id] || getPlacement(signer)])) })
  }

  const copyLink = async () => {
    if (!result?.reviewUrl) return
    await navigator.clipboard?.writeText(result.reviewUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div className="auth-modal signature-modal">
        <div className="auth-modal-heading"><div><span>PDF WORKFLOW</span><h2>{result ? 'Talep gönderildi' : 'İmza veya inceleme isteği'}</h2></div><button className="icon-button light" onClick={onClose} disabled={busy}><X size={17} /></button></div>
        {result ? (
          <div className="signature-success">
            <div className="signature-success-icon"><Check size={19} /></div>
            <strong>{result.workflowType === 'review' ? 'İnceleme linki hazır.' : `${result.signerCount || 1} signer için imza akışı başlatıldı.`}</strong>
            <p>{documentName} için ilk signer’a güvenli bağlantı gönderildi. Her signer tamamladıkça sıradaki kişiye yeni bağlantı gönderilecek; son imzadan sonra final PDF tüm taraflara iletilecek.</p>
            <div className="signature-link-box"><span>{result.reviewUrl}</span><button type="button" className="auth-submit" onClick={copyLink}>{copied ? 'Kopyalandı' : 'İlk linki kopyala'}</button></div>
            <div className="signature-modal-actions"><button type="button" className="auth-switch" onClick={onOpenRequests}>Talepleri takip et</button><button type="button" className="auth-submit" onClick={onClose}>Kapat</button></div>
          </div>
        ) : (
          <>
            <p className="auth-description"><strong>{documentName}</strong> dosyasını bir veya daha fazla kişiye sırayla imzalat.</p>
            <form onSubmit={submit}>
              <div className="signature-sender-card"><span>Gönderen hesap</span><strong>{senderName}</strong><small>{senderEmail}</small></div>
              <div className="signer-list-heading"><div><strong>Signer’lar</strong><span>{signers.length}/8 kişi</span></div><button type="button" className="signer-add-button" onClick={addSigner} disabled={workflowType === 'review' || signers.length >= 8}><span>+</span> Add signer</button></div>
              <div className="signer-list">{signers.map((signer, index) => { const selected = activeSigner?.id === signer.id; return <div className={`signer-card ${selected ? 'selected' : ''}`} key={signer.id} onClick={() => setActiveSignerId(signer.id)}><div className="signer-card-top"><button type="button" className="signer-select-button" onClick={() => setActiveSignerId(signer.id)}><span>{index + 1}</span><strong>{signer.name || `Signer ${index + 1}`}</strong></button>{signers.length > 1 && <button type="button" className="signer-remove-button" onClick={(event) => { event.stopPropagation(); removeSigner(signer.id) }} aria-label="Signer’ı kaldır"><X size={13} /></button>}</div><input value={signer.name} onClick={() => setActiveSignerId(signer.id)} onChange={(event) => updateSigner(signer.id, 'name', event.target.value)} required placeholder="Full name" autoComplete="name" /><input type="email" value={signer.email} onClick={() => setActiveSignerId(signer.id)} onChange={(event) => updateSigner(signer.id, 'email', event.target.value)} required placeholder="email@example.com" autoComplete="email" /><small>{selected ? 'Şimdi PDF üzerinde bu signer için alanı seç.' : placements[signer.id]?.placed ? 'İmza alanı yerleştirildi' : 'Alan seçmek için tıkla'}</small></div> })}</div>
              <div className="signature-placement-field"><div className="signature-placement-heading"><label>{activeSigner ? `${activeSigner.name || `Signer ${activeSignerIndex + 1}`} için imza alanı` : 'İmza alanı'}</label><span>Signer’ı seç, basılı tut ve PDF üzerinde kutu çiz</span></div><div className="signature-placement-paper" onPointerDown={startPlacement} onPointerMove={movePlacement} onPointerUp={finishPlacement} onPointerCancel={finishPlacement} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setFormError('İmza alanını PDF üzerinde basılı tutup sürükleyerek çizmelisin.') }}><PdfPreview src={fileUrl} page={activePlacement.page} onPageCount={handlePreviewPageCount} />{signers.map((signer, index) => { const placement = getPlacement(signer, index); if (!placement.placed || placement.page !== activePlacement.page) return null; return <div className={`signature-placement-marker ${signer.id === activeSigner?.id ? 'active' : ''}`} style={{ left: `${placement.left * 100}%`, top: `${placement.top * 100}%`, width: `${placement.width * 100}%`, height: `${placement.height * 100}%` }} key={signer.id}><PenLine size={11} /><div className="signature-placement-preview"><strong>{signer.name || `Signer ${index + 1}`}</strong><span>İmza</span></div></div> })}{draftPlacement && activeSigner && <div className="signature-placement-marker ghost" style={{ left: `${draftPlacement.left * 100}%`, top: `${draftPlacement.top * 100}%`, width: `${draftPlacement.width * 100}%`, height: `${draftPlacement.height * 100}%` }}><PenLine size={11} /><div className="signature-placement-preview"><strong>{activeSigner.name || `Signer ${activeSignerIndex + 1}`}</strong><span>Çiziliyor...</span></div></div>}<div className="signature-placement-help">{activeSigner?.name || `Signer ${activeSignerIndex + 1}`} için basılı tutup imza kutusu çiz</div></div><div className="signature-placement-controls"><label>Sayfa<select value={activePlacement.page} onChange={(event) => setPlacements((current) => ({ ...current, [activeSigner.id]: { ...activePlacement, page: Number(event.target.value) } }))}>{Array.from({ length: previewPageCount }, (_item, index) => <option value={index + 1} key={index + 1}>{index + 1}</option>)}</select></label><span>Her signer’ın adı üstte, imza alanı altında ayrı ayrı yazdırılacak.</span></div></div>
              <label>Akış türü<select value={workflowType} onChange={(event) => selectWorkflow(event.target.value)}><option value="signature">E-imza akışı</option><option value="review">İnceleme iste</option></select></label>
              <label>Mesaj (opsiyonel)<textarea className="signature-message-input" value={message} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder="Kısa bir not ekle..." /></label>
              <label>Link geçerliliği<select value={expiresIn} onChange={(event) => setExpiresIn(event.target.value)}><option value="86400">24 saat</option><option value="604800">7 gün</option><option value="2592000">30 gün</option></select></label>
              {(error || formError) && <div className="auth-error">{error || formError}</div>}
              <button className="auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <PenLine size={16} />} {busy ? 'Gönderiliyor...' : `${signers.length} signer’a güvenli link gönder`}</button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

function SignatureRequestsDrawer({ session, authHeaders, onClose, onCancel, onResend }) {
  const [requests, setRequests] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [cancellingId, setCancellingId] = useState('')
  const [resendingId, setResendingId] = useState('')

  useEffect(() => {
    if (!session) return undefined
    let active = true
    apiFetch('/api/signatures', { headers: authHeaders() })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'İmza talepleri okunamadı.')
        if (active) setRequests(data.requests || [])
      })
      .catch((requestError) => { if (active) setError(requestError.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [session])

  const cancelRequest = async (request) => {
    if (!window.confirm('Bu imza isteğini iptal etmek istediğine emin misin?')) return
    setCancellingId(request.id)
    setError('')
    try {
      await onCancel(request.id)
      setRequests((current) => current.map((item) => item.id === request.id ? { ...item, status: 'cancelled' } : item))
    } catch (cancelError) {
      setError(cancelError.message || 'İmza isteği iptal edilemedi.')
    } finally {
      setCancellingId('')
    }
  }

  const resendRequest = async (request) => {
    setResendingId(request.id)
    setError('')
    try {
      await onResend(request.id)
      setRequests((current) => current.map((item) => item.id === request.id ? { ...item, status: 'pending' } : item))
    } catch (resendError) {
      setError(resendError.message || 'İmza isteği tekrar gönderilemedi.')
    } finally {
      setResendingId('')
    }
  }

  return (
    <aside className="history-drawer signature-requests-drawer">
      <div className="history-heading"><div><span>PDF WORKFLOW</span><h2>İmza talepleri</h2></div><button className="icon-button light" onClick={onClose}><X size={17} /></button></div>
      {error && <div className="auth-error inline-error">{error}</div>}
      {loading ? <div className="history-empty"><LoaderCircle className="spin" size={20} /><p>Talepler yükleniyor...</p></div> : requests.length === 0 ? <div className="history-empty"><PenLine size={20} /><p>Henüz bir imza talebi yok.</p></div> : <div className="signature-request-list">
        {requests.map((request) => <div className="signature-request-item" key={request.id}><div className="signature-request-main"><strong>{request.document_name}</strong><span>{request.recipient_name || request.recipient_email}</span><small>{request.workflow_type === 'review' ? 'İnceleme' : 'İmza'} · {new Date(request.created_at).toLocaleString()}</small>{request.signedDocumentUrl && <a className="signed-document-link" href={request.signedDocumentUrl} target="_blank" rel="noreferrer">İmzalı PDF’i aç</a>}</div><div className="signature-request-actions"><em className={`request-status ${request.status}`}>{request.status}</em>{['pending', 'viewed'].includes(request.status) && <><button className="signature-resend-button" type="button" onClick={() => resendRequest(request)} disabled={resendingId === request.id}>{resendingId === request.id ? <LoaderCircle className="spin" size={12} /> : 'Resend'}</button><button className="signature-cancel-button" type="button" onClick={() => cancelRequest(request)} disabled={cancellingId === request.id}>İptal et</button></>}</div></div>)}
      </div>}
    </aside>
  )
}

function AccountModal({ session, busy, error, onClose, onSubmit, onOpenPricing }) {
  const [fullName, setFullName] = useState(session.user.user_metadata?.full_name || '')
  const [password, setPassword] = useState('')
  const [marketingConsent, setMarketingConsent] = useState(Boolean(session.user.user_metadata?.marketing_consent))

  const submit = (event) => {
    event.preventDefault()
    onSubmit({ fullName: fullName.trim(), password, marketingConsent })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div className="auth-modal account-modal">
        <div className="auth-modal-heading"><div><span>UPDATEMYPDF CLOUD</span><h2>Hesap bilgileri</h2></div><button className="icon-button light" onClick={onClose} disabled={busy}><X size={17} /></button></div>
        <p className="auth-description">Gönderdiğin imza taleplerinde bu ad ve kayıtlı e-posta otomatik gönderen bilgisi olarak kullanılır.</p>
        <div className="account-plan-card"><div><span>Mevcut plan</span><strong>{(session.user.user_metadata?.plan || 'basic').toUpperCase()}</strong></div><button type="button" onClick={onOpenPricing}>Planları gör</button></div>
        <form onSubmit={submit}>
          <label>Ad soyad<input value={fullName} onChange={(event) => setFullName(event.target.value)} required autoComplete="name" /></label>
          <label>Kayıtlı e-posta<input value={session.user.email || ''} readOnly disabled /></label>
          <label>Yeni şifre (opsiyonel)<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} autoComplete="new-password" placeholder="Değiştirmek istemiyorsan boş bırak" /></label>
          <label className="auth-checkbox"><input type="checkbox" checked={marketingConsent} onChange={(event) => setMarketingConsent(event.target.checked)} /><span>Ürün güncellemeleri ve fırsatları hakkında e-posta almak istiyorum.</span></label>
          {error && <div className="auth-error">{error}</div>}
          <button className="auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Kaydet</button>
        </form>
      </div>
    </div>
  )
}

function AccountManagementModal({ session, busy, error, onClose, onProfileSave, onChangeEmail, onConfirmEmailChange, onRequestPasswordCode, onConfirmPasswordChange, onOpenPricing, onOpenBilling, onSignOut }) {
  const [section, setSection] = useState('overview')
  const [fullName, setFullName] = useState(session.user.user_metadata?.full_name || '')
  const [marketingConsent, setMarketingConsent] = useState(Boolean(session.user.user_metadata?.marketing_consent))
  const [newEmail, setNewEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailCodeSent, setEmailCodeSent] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [passwordCodeSent, setPasswordCodeSent] = useState(false)
  const [localBusy, setLocalBusy] = useState(false)
  const [localError, setLocalError] = useState('')
  const [notice, setNotice] = useState('')

  const displayName = fullName || session.user.email || 'updateMyPDF user'
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U'
  const currentPlan = String(session.user.user_metadata?.plan || 'basic').toUpperCase()
  const sectionTitles = {
    overview: ['Hesap özeti', 'Hesabını, güvenliğini ve planını tek merkezden yönet.'],
    profile: ['Profil bilgileri', 'Gönderen kimliğini ve iletişim tercihlerini güncel tut.'],
    security: ['Güvenlik ve erişim', 'E-posta ve şifre değişiklikleri doğrulama adımıyla korunur.'],
    billing: ['Ödeme ve plan', 'Planını ve ödeme yöntemini güvenli Stripe ekranından yönet.'],
    notifications: ['Bildirim tercihleri', 'updateMyPDF’den almak istediğin iletişimleri seç.'],
  }
  const navItems = [
    { id: 'overview', label: 'Hesap özeti', icon: UserRound },
    { id: 'profile', label: 'Profil bilgileri', icon: UserRound },
    { id: 'security', label: 'Güvenlik ve erişim', icon: ShieldCheck },
    { id: 'billing', label: 'Ödeme ve plan', icon: CreditCard },
    { id: 'notifications', label: 'Bildirim tercihleri', icon: Bell },
  ]

  const clearFeedback = () => {
    setLocalError('')
    setNotice('')
  }

  const submitProfile = async (event) => {
    event.preventDefault()
    clearFeedback()
    await onProfileSave({ fullName: fullName.trim(), marketingConsent })
    setNotice('Profil bilgilerin güncellendi.')
  }

  const submitEmail = async (event) => {
    event.preventDefault()
    clearFeedback()
    if (!newEmail.trim() || !newEmail.includes('@')) {
      setLocalError('Geçerli bir yeni e-posta adresi yaz.')
      return
    }
    if (newEmail.trim().toLowerCase() === String(session.user.email || '').toLowerCase()) {
      setLocalError('Yeni e-posta mevcut adresinden farklı olmalı.')
      return
    }
    setLocalBusy(true)
    try {
      if (!emailCodeSent) {
        await onChangeEmail(newEmail.trim())
        setEmailCodeSent(true)
        setNotice('6 haneli doğrulama kodu yeni e-posta adresine gönderildi.')
      } else {
        if (emailCode.length !== 6) {
          setLocalError('6 haneli doğrulama kodunu yaz.')
          return
        }
        await onConfirmEmailChange(emailCode)
        setNewEmail('')
        setEmailCode('')
        setEmailCodeSent(false)
        setNotice('E-posta adresin güvenli şekilde güncellendi.')
      }
    } catch (changeError) {
      setLocalError(changeError.message || 'E-posta adresi güncellenemedi.')
    } finally {
      setLocalBusy(false)
    }
  }

  const sendPasswordCode = async () => {
    clearFeedback()
    setLocalBusy(true)
    try {
      await onRequestPasswordCode()
      setPasswordCodeSent(true)
      setNotice('Doğrulama kodu kayıtlı e-posta adresine gönderildi.')
    } catch (codeError) {
      setLocalError(codeError.message || 'Doğrulama kodu gönderilemedi.')
    } finally {
      setLocalBusy(false)
    }
  }

  const submitPassword = async (event) => {
    event.preventDefault()
    clearFeedback()
    if (!passwordCodeSent) {
      setLocalError('Önce doğrulama kodu istemelisin.')
      return
    }
    if (newPassword.length < 8) {
      setLocalError('Yeni şifre en az 8 karakter olmalı.')
      return
    }
    if (newPassword !== passwordConfirmation) {
      setLocalError('Yeni şifre tekrarı eşleşmiyor.')
      return
    }
    setLocalBusy(true)
    try {
      await onConfirmPasswordChange({ code: verificationCode.trim(), password: newPassword })
      setNewPassword('')
      setPasswordConfirmation('')
      setVerificationCode('')
      setPasswordCodeSent(false)
      setNotice('Şifren güncellendi.')
    } catch (passwordError) {
      setLocalError(passwordError.message || 'Şifre güncellenemedi.')
    } finally {
      setLocalBusy(false)
    }
  }

  const openBilling = async () => {
    clearFeedback()
    setLocalBusy(true)
    try {
      await onOpenBilling()
    } catch (billingError) {
      setLocalError(billingError.message || 'Ödeme yönetim ekranı açılamadı.')
    } finally {
      setLocalBusy(false)
    }
  }

  const renderOverview = () => (
    <>
      <section className="account-welcome-card">
        <div className="account-welcome-icon"><Sparkles size={20} /></div>
        <div><span>UPDATE MYPDF ACCOUNT CENTER</span><h3>Belgelerin için güvenli çalışma alanın hazır.</h3><p>Dosyaların, imza akışların ve AI kredilerin bu hesaba bağlı olarak korunur.</p></div>
      </section>
      <div className="account-stat-grid">
        <div className="account-stat-card"><span>AKTİF PLAN</span><strong>{currentPlan}</strong><small>Planını ve kullanımını yönet</small></div>
        <div className="account-stat-card"><span>HESAP E-POSTASI</span><strong>{session.user.email || '—'}</strong><small>Doğrulanmış iletişim adresi</small></div>
        <div className="account-stat-card"><span>GÜVENLİK</span><strong><ShieldCheck size={15} /> Korumalı</strong><small>E-posta doğrulaması aktif</small></div>
      </div>
      <div className="account-card-grid">
        <article className="account-card"><div className="account-card-icon"><UserRound size={17} /></div><div><h3>Profil bilgileri</h3><p>{displayName}<br />{session.user.email}</p></div><button type="button" className="account-card-link" onClick={() => { clearFeedback(); setSection('profile') }}>Düzenle <ChevronDown size={13} /></button></article>
        <article className="account-card"><div className="account-card-icon"><KeyRound size={17} /></div><div><h3>Güvenlik</h3><p>Şifre değişikliği ve e-posta güncellemesi doğrulama koduyla korunur.</p></div><button type="button" className="account-card-link" onClick={() => { clearFeedback(); setSection('security') }}>Yönet <ChevronDown size={13} /></button></article>
        <article className="account-card"><div className="account-card-icon"><WalletCards size={17} /></div><div><h3>Ödeme yöntemi</h3><p>Kart bilgilerin Stripe’ın güvenli ödeme ekranında tutulur.</p></div><button type="button" className="account-card-link" onClick={() => { clearFeedback(); setSection('billing') }}>Aç <ChevronDown size={13} /></button></article>
      </div>
    </>
  )

  const renderProfile = () => (
    <form className="account-form" onSubmit={submitProfile}>
      <div className="account-form-grid">
        <label>Ad soyad<input value={fullName} onChange={(event) => setFullName(event.target.value)} required autoComplete="name" /></label>
        <label>Hesap e-postası<input value={session.user.email || ''} readOnly disabled /></label>
      </div>
      <div className="account-info-panel"><Mail size={16} /><div><strong>E-posta adresini değiştirmek mi istiyorsun?</strong><span>Yeni adrese tek kullanımlık doğrulama kodu gönderilir.</span></div><button type="button" className="account-card-link" onClick={() => setSection('security')}>Güvenliğe git</button></div>
      <label className="auth-checkbox"><input type="checkbox" checked={marketingConsent} onChange={(event) => setMarketingConsent(event.target.checked)} /><span>Ürün güncellemeleri, yeni özellikler ve fırsatlar hakkında e-posta almak istiyorum.</span></label>
      {error && <div className="auth-error">{error}</div>}
      {notice && <div className="account-success"><Check size={14} /> {notice}</div>}
      <button className="auth-submit account-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Değişiklikleri kaydet</button>
    </form>
  )

  const renderSecurity = () => (
    <div className="account-security-stack">
      <section className="account-panel-card">
        <div className="account-panel-heading"><div className="account-card-icon"><Mail size={17} /></div><div><h3>E-posta adresi</h3><p>Mevcut adresin: <strong>{session.user.email}</strong></p></div></div>
        <form className="account-form" onSubmit={submitEmail}><label>Yeni e-posta adresi<input type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} placeholder="yeni-adres@example.com" autoComplete="email" disabled={emailCodeSent} /></label>{emailCodeSent && <label>Doğrulama kodu<input value={emailCode} onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="6 haneli kod" autoComplete="one-time-code" /></label>}<button className="account-outline-button" type="submit" disabled={localBusy}>{emailCodeSent ? 'E-posta adresini doğrula' : 'Doğrulama kodu gönder'}</button></form>
      </section>
      <section className="account-panel-card">
        <div className="account-panel-heading"><div className="account-card-icon"><KeyRound size={17} /></div><div><h3>Şifre değiştir</h3><p>İşleme başlamadan önce kayıtlı e-posta adresine tek kullanımlık kod gönderilir.</p></div></div>
        <form className="account-form" onSubmit={submitPassword}><div className="account-form-grid"><label>Yeni şifre<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} autoComplete="new-password" placeholder="En az 8 karakter" /></label><label>Yeni şifre tekrarı<input type="password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} minLength={8} autoComplete="new-password" /></label></div><div className="account-code-row"><input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="6 haneli kod" disabled={!passwordCodeSent} /><button className="account-outline-button" type="button" onClick={sendPasswordCode} disabled={localBusy}>{passwordCodeSent ? 'Kodu tekrar gönder' : 'Kod gönder'}</button></div><button className="auth-submit account-submit" type="submit" disabled={localBusy || !passwordCodeSent || verificationCode.length < 6}>{localBusy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} Şifreyi güncelle</button></form>
      </section>
    </div>
  )

  const renderBilling = () => (
    <div className="account-security-stack">
      <section className="account-billing-hero"><div><span>MEVCUT PLAN</span><h3>{currentPlan} plan</h3><p>AI kredileri, cloud depolama ve imza akışlarını tek yerden yönet.</p></div><button type="button" className="auth-submit" onClick={onOpenPricing}>Planları karşılaştır</button></section>
      <section className="account-panel-card"><div className="account-panel-heading"><div className="account-card-icon"><CreditCard size={17} /></div><div><h3>Ödeme yöntemi</h3><p>Kart bilgilerin updateMyPDF sunucularında tutulmaz. Stripe’ın PCI uyumlu Customer Portal ekranında güvenle güncellenir.</p></div></div><button type="button" className="account-outline-button account-wide-button" onClick={openBilling} disabled={localBusy}>{localBusy ? <LoaderCircle className="spin" size={14} /> : <WalletCards size={14} />} Ödeme yöntemini yönet</button></section>
      <section className="account-panel-card account-feature-list"><div className="account-panel-heading"><div className="account-card-icon"><ShieldCheck size={17} /></div><div><h3>Güvenli ödeme akışı</h3><p>Abonelik, fatura ve kart değişiklikleri Stripe tarafında işlenir.</p></div></div><ul><li><Check size={14} /> Kart bilgisi uygulamaya kaydedilmez.</li><li><Check size={14} /> Fatura geçmişi Stripe Portal’da erişilebilir.</li><li><Check size={14} /> İstediğin zaman planını ve ödeme yöntemini değiştirebilirsin.</li></ul></section>
    </div>
  )

  const renderNotifications = () => (
    <section className="account-panel-card"><div className="account-panel-heading"><div className="account-card-icon"><Bell size={17} /></div><div><h3>İletişim tercihleri</h3><p>Ürün duyuruları ve faydalı güncellemeler için tercihlerini buradan yönet.</p></div></div><label className="auth-checkbox account-notification-row"><input type="checkbox" checked={marketingConsent} onChange={(event) => setMarketingConsent(event.target.checked)} /><span><strong>Ürün güncellemeleri</strong><small>Yeni özellikler, güvenlik duyuruları ve önemli platform haberleri.</small></span></label><button type="button" className="account-outline-button" onClick={submitProfile} disabled={busy}>{busy ? 'Kaydediliyor...' : 'Tercihleri kaydet'}</button></section>
  )

  const content = section === 'overview' ? renderOverview() : section === 'profile' ? renderProfile() : section === 'security' ? renderSecurity() : section === 'billing' ? renderBilling() : renderNotifications()

  return (
    <div className="modal-backdrop account-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !localBusy && !busy) onClose() }}>
      <div className="account-management">
        <aside className="account-sidebar">
          <div className="account-sidebar-brand"><div className="brand-mark"><Sparkles size={16} /></div><div><strong>updateMyPDF</strong><span>ACCOUNT CENTER</span></div><button className="icon-button light account-close" onClick={onClose}><X size={17} /></button></div>
          <div className="account-identity"><div className="account-avatar-large">{initials}</div><div><strong>{displayName}</strong><span>{session.user.email}</span></div><em><Check size={11} /> verified</em></div>
          <nav className="account-nav">{navItems.map(({ id, label, icon: Icon }) => <button type="button" key={id} className={section === id ? 'active' : ''} onClick={() => { clearFeedback(); setSection(id) }}><Icon size={16} /><span>{label}</span><ChevronDown className="account-nav-chevron" size={14} /></button>)}</nav>
          <div className="account-sidebar-footer"><p><ShieldCheck size={14} /> Belgelerin ve hesabın güvenli bağlantıyla korunur.</p><button type="button" onClick={onSignOut}><LogOut size={14} /> Çıkış yap</button></div>
        </aside>
        <main className="account-content"><header className="account-content-heading"><div><span>ACCOUNT MANAGEMENT</span><h2>{sectionTitles[section][0]}</h2><p>{sectionTitles[section][1]}</p></div><div className="account-heading-badge"><ShieldCheck size={13} /> Secure account</div></header>{(localError || (section !== 'profile' && error)) && <div className="auth-error account-inline-error">{localError || error}</div>}{notice && section !== 'profile' && <div className="account-success"><Check size={14} /> {notice}</div>}<div className="account-content-body">{content}</div></main>
      </div>
    </div>
  )
}

function AuthModal({ mode, busy, error, onModeChange, onClose, onSubmit }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [marketingOptIn, setMarketingOptIn] = useState(false)

  const submit = (event) => {
    event.preventDefault()
    onSubmit({ email: email.trim(), password, fullName: fullName.trim(), marketingOptIn })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="auth-modal">
        <div className="auth-modal-heading"><div><span>UPDATEMYPDF CLOUD</span><h2>{mode === 'login' ? 'Hesabına giriş yap' : 'Hesap oluştur'}</h2></div><button className="icon-button light" onClick={onClose}><X size={17} /></button></div>
        <p className="auth-description">PDF yüklemek, AI ile düzenlemek ve dışa aktarmak için ücretsiz hesabınla giriş yap veya hesap oluştur.</p>
        <form onSubmit={submit}>
          {mode === 'signup' && <label>Ad soyad<input value={fullName} onChange={(event) => setFullName(event.target.value)} required autoComplete="name" placeholder="Ad Soyad" /></label>}
          <label>E-posta<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label>
          <label>Şifre<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
          {mode === 'signup' && <label className="auth-checkbox"><input type="checkbox" checked={marketingOptIn} onChange={(event) => setMarketingOptIn(event.target.checked)} /><span>Ürün güncellemeleri ve fırsatları hakkında e-posta almak istiyorum.</span></label>}
          {error && <div className="auth-error">{error}</div>}
          <button className="auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />} {mode === 'login' ? 'Giriş yap' : 'Kayıt ol'}</button>
        </form>
        <button className="auth-switch" onClick={() => onModeChange(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'Hesabın yok mu? Kayıt ol' : 'Zaten hesabın var mı? Giriş yap'}</button>
      </div>
    </div>
  )
}

function AccountNudge({ onClose, onSignup, onPricing }) {
  return (
    <aside className="account-nudge" role="status">
      <div className="account-nudge-icon"><Sparkles size={15} /></div>
      <div className="account-nudge-copy"><strong>İlk AI önizlemen hazır</strong><span>Devam etmek ve dosyanı kaydetmek için ücretsiz hesap oluştur.</span></div>
      <button type="button" className="account-nudge-primary" onClick={onSignup}>Hesap oluştur</button>
      <button type="button" className="account-nudge-secondary" onClick={onPricing}>Planlar</button>
      <button type="button" className="toast-close" onClick={onClose} aria-label="Bildirimi kapat"><X size={14} /></button>
    </aside>
  )
}

function TokenReloadNudge({ usage, onClose, onOpenPricing }) {
  return (
    <div className="modal-backdrop token-reload-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="token-reload-modal" role="alertdialog" aria-modal="true">
        <div className="token-reload-icon" aria-hidden="true">⚡</div>
        <span className="token-reload-eyebrow">AI TOKEN BAKİYESİ</span>
        <h2>Tokenlarını yenileme zamanı</h2>
        <p>{usage.planName} planında kalan AI tokenın %20’nin altına indi. İşlerine ara vermemek için yenileme paketini şimdi inceleyebilirsin.</p>
        <div className="token-reload-summary"><strong>{usage.remaining}</strong><span>token kaldı</span></div>
        <div className="token-reload-offer"><span>Önerilen yenileme</span><strong>+{usage.reloadTokens} token · ${usage.reloadPrice}</strong></div>
        <div className="token-reload-actions"><button type="button" className="auth-submit" onClick={onOpenPricing}>Yenileme seçeneklerini gör</button><button type="button" className="auth-switch" onClick={onClose}>Daha sonra</button></div>
        <small>Ödeme bağlantısı Stripe entegrasyonu aktif olduğunda kullanılabilir olacak.</small>
        <button type="button" className="icon-button light token-reload-close" onClick={onClose} aria-label="Uyarıyı kapat"><X size={17} /></button>
      </section>
    </div>
  )
}

function PricingModal({ currentPlan, onClose, onSelect }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="pricing-modal">
        <div className="auth-modal-heading"><div><span>UPDATEMYPDF PLANS</span><h2>İhtiyacına uygun planı seç</h2></div><button className="icon-button light" onClick={onClose}><X size={17} /></button></div>
        <p className="auth-description">Planlar AI kullanım kredisi ve cloud kapasitesine göre hazırlanmıştır. Stripe ödeme bağlantısı bir sonraki adımda aktifleşecek.</p>
        <div className="pricing-grid">
          {pricingPlans.map((plan) => <article className={`pricing-card ${plan.featured ? 'featured' : ''}`} key={plan.id}>
            {plan.featured && <span className="pricing-popular">EN POPÜLER</span>}
            <div className="pricing-card-heading"><h3>{plan.name}</h3>{currentPlan === plan.id && <span className="pricing-current">MEVCUT</span>}</div>
            <p>{plan.description}</p>
            <div className="pricing-price"><strong>${plan.price}</strong><span>/ ay</span></div>
            <ul>{plan.features.map((feature) => <li key={feature}><Check size={13} /> {feature}</li>)}</ul>
            <button type="button" className={plan.featured ? 'auth-submit pricing-cta' : 'auth-switch pricing-cta'} onClick={() => onSelect(plan.id)}>{currentPlan === plan.id ? 'Planı yönet' : `${plan.name} planını seç`}</button>
          </article>)}
        </div>
        <p className="pricing-footnote">AI kredileri belge uzunluğu ve kullanılan modele göre hesaplanır. Kullanılmayan krediler devretmez.</p>
      </div>
    </div>
  )
}

function AiProgressCard({ progress }) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0)))
  const totalPages = Number(progress?.totalPages) || 0
  const completedPages = Math.min(totalPages, Number(progress?.completedPages) || 0)
  const detail = progress?.phase === 'translation'
    ? `${completedPages}/${totalPages || '—'} sayfa çevrildi`
    : progress?.phase === 'pdf'
      ? 'PDF düzenleniyor ve preview hazırlanıyor'
      : 'İşlem tamamlanıyor'
  return (
    <div className="ai-progress-card" role="status" aria-live="polite">
      <div className="ai-progress-heading"><span>Uzun PDF işleniyor</span><strong>%{percent}</strong></div>
      <div className="ai-progress-track" aria-label={`İşlem yüzde ${percent} tamamlandı`}><span style={{ width: `${percent}%` }} /></div>
      <div className="ai-progress-meta"><span>{detail}</span><span>Devam ediyor</span></div>
    </div>
  )
}

function ToastNotice({ notification, onClose }) {
  return (
    <div className={`toast-notice ${notification.tone || 'success'}`} role="status">
      <div className="toast-icon"><Check size={15} /></div>
      <span>{notification.text}</span>
      <button className="toast-close" onClick={onClose} aria-label="Bildirimi kapat"><X size={14} /></button>
    </div>
  )
}

function SignedDocumentPage({ requestId }) {
  const [session, setSession] = useState(null)
  const [document, setDocument] = useState(null)
  const [emailTo, setEmailTo] = useState('')
  const [emailMessage, setEmailMessage] = useState('')
  const [showEmail, setShowEmail] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    const loadDocument = async () => {
      if (!supabase) {
        if (active) {
          setError('Güvenli belge görüntüleme için Supabase ayarları eksik.')
          setLoading(false)
        }
        return
      }
      const { data: authData } = await supabase.auth.getSession()
      const currentSession = authData?.session || null
      if (!active) return
      setSession(currentSession)
      if (!currentSession) {
        setError('Bu imzalı belgeyi görmek için updateMyPDF hesabına giriş yapmalısın.')
        setLoading(false)
        return
      }
      try {
        const response = await apiFetch(`/api/signatures/${encodeURIComponent(requestId)}/document`, { headers: { Authorization: `Bearer ${currentSession.access_token}` } })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'İmzalı belge açılamadı.')
        if (!active) return
        setDocument(data.document)
        setEmailTo(data.document?.recipientEmail || currentSession.user?.email || '')
      } catch (loadError) {
        if (active) setError(loadError.message || 'İmzalı belge açılamadı.')
      } finally {
        if (active) setLoading(false)
      }
    }
    loadDocument()
    return () => { active = false }
  }, [requestId])

  const downloadDocument = async () => {
    if (!document?.signedDocumentUrl || downloading) return
    setDownloading(true)
    setNotice('')
    try {
      const response = await fetch(document.signedDocumentUrl)
      if (!response.ok) throw new Error('PDF indirilemedi.')
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const link = window.document.createElement('a')
      link.href = objectUrl
      link.download = `${document.documentName.replace(/\.pdf$/i, '')}-signed.pdf`
      window.document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(objectUrl)
      setNotice('İmzalı PDF indirilmeye hazır.')
    } catch (_error) {
      window.open(document.signedDocumentUrl, '_blank', 'noopener,noreferrer')
      setNotice('PDF yeni sekmede açıldı; buradan indirebilirsin.')
    } finally {
      setDownloading(false)
    }
  }

  const sendDocumentEmail = async (event) => {
    event.preventDefault()
    if (!session || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await apiFetch(`/api/signatures/${encodeURIComponent(requestId)}/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ to: emailTo.trim(), message: emailMessage.trim() }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'E-posta gönderilemedi.')
      setNotice(data.attached ? 'İmzalı PDF e-posta eki olarak gönderildi.' : 'İmzalı PDF güvenli bağlantıyla gönderildi.')
      setShowEmail(false)
      setEmailMessage('')
    } catch (sendError) {
      setError(sendError.message || 'E-posta gönderilemedi.')
    } finally {
      setBusy(false)
    }
  }

  const goToApp = () => { window.location.href = '/' }
  const dateLabel = document?.signedAt ? new Date(document.signedAt).toLocaleString('tr-TR') : '—'

  return (
    <div className="signed-document-shell">
      <header className="signed-document-header">
        <button type="button" className="signed-back-button" onClick={goToApp}><ArrowLeft size={16} /> Ana çalışma alanı</button>
        <div className="brand-lockup"><div className="brand-mark"><Sparkles size={17} strokeWidth={2.5} /></div><span className="brand-name">update<span>MyPDF</span></span></div>
        <span className="signed-secure-label"><ShieldCheck size={14} /> Güvenli imzalı belge</span>
      </header>
      {loading ? <div className="signed-document-state"><LoaderCircle className="spin" size={27} /><p>İmzalı PDF hazırlanıyor...</p></div> : error && !document ? <div className="signed-document-state signed-document-error"><X size={27} /><h1>Belge açılamadı</h1><p>{error}</p><button type="button" className="auth-submit" onClick={goToApp}>{session ? 'Çalışma alanına dön' : 'Giriş yap'}</button></div> : document && <main className="signed-document-layout">
        <section className="signed-document-viewer">
          <div className="signed-viewer-heading"><div><FileText size={16} /><strong>{document.documentName}</strong></div><span><Check size={12} /> İmzalandı</span></div>
          <div className="signed-viewer-frame"><iframe title="İmzalı PDF önizlemesi" src={`${document.signedDocumentUrl}#toolbar=1&navpanes=0&view=FitH`} /></div>
        </section>
        <aside className="signed-document-sidebar">
          <div className="signed-sidebar-icon"><Check size={21} /></div>
          <span className="signed-eyebrow">SIGNED DOCUMENT</span>
          <h1>{document.documentName}</h1>
          <p className="signed-sidebar-intro">Belge başarıyla imzalandı. PDF’i bu sayfada inceleyebilir, indirebilir veya istediğin kişiye gönderebilirsin.</p>
          <div className="signed-status-card"><span><Check size={13} /> Tamamlandı</span><small>{dateLabel}</small></div>
          <div className="signed-detail-list"><div><span>İmzalayan</span><strong>{document.recipientName || 'Belirtilmedi'}</strong><small>{document.recipientEmail}</small></div><div><span>Belge sahibi</span><strong>{document.senderName}</strong><small>{document.senderEmail}</small></div></div>
          {notice && <div className="signed-notice"><Check size={14} /> {notice}</div>}
          {error && document && <div className="signed-inline-error"><X size={14} /> {error}</div>}
          <div className="signed-action-stack"><button type="button" className="signed-primary-action" onClick={downloadDocument} disabled={downloading}>{downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} {downloading ? 'Hazırlanıyor...' : 'PDF’i indir'}</button><button type="button" className="signed-secondary-action" onClick={() => { setError(''); setShowEmail((current) => !current) }}><Mail size={16} /> E-posta gönder</button><button type="button" className="signed-secondary-action" onClick={() => window.open(document.signedDocumentUrl, '_blank', 'noopener,noreferrer')}><ExternalLink size={16} /> PDF’i yeni sekmede aç</button></div>
          {showEmail && <form className="signed-email-form" onSubmit={sendDocumentEmail}><div className="signed-email-heading"><Mail size={15} /><div><strong>İmzalı kopyayı gönder</strong><span>PDF ek olarak paylaşılacak.</span></div></div><label>Alıcı e-posta<input type="email" value={emailTo} onChange={(event) => setEmailTo(event.target.value)} placeholder="ornek@email.com" required /></label><label>Mesaj <span>(opsiyonel)</span><textarea value={emailMessage} onChange={(event) => setEmailMessage(event.target.value)} rows={3} maxLength={2000} placeholder="Kısa bir not ekle" /></label><button type="submit" className="signed-primary-action" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Mail size={15} />} {busy ? 'Gönderiliyor...' : 'E-postayı gönder'}</button></form>}
          <button type="button" className="signed-return-link" onClick={goToApp}><ArrowLeft size={14} /> Ana çalışma alanına dön</button>
        </aside>
      </main>}
    </div>
  )
}

function ReviewPage({ token }) {
  const [request, setRequest] = useState(null)
  const [signatureText, setSignatureText] = useState('')
  const [signatureStyle, setSignatureStyle] = useState('elegant')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [done, setDone] = useState(false)
  const [notifiedEmails, setNotifiedEmails] = useState([])
  const [nextSigner, setNextSigner] = useState(null)
  const [resultStatus, setResultStatus] = useState('')
  const [showDecline, setShowDecline] = useState(false)
  const [declineReason, setDeclineReason] = useState('')
  const [declineBusy, setDeclineBusy] = useState(false)

  useEffect(() => {
    let active = true
    apiFetch(`/api/signatures/${encodeURIComponent(token)}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'İmza bağlantısı açılamadı.')
        if (active) {
          setRequest(data.request)
          setDone(['signed', 'declined', 'cancelled', 'expired'].includes(data.request?.status))
          setResultStatus(data.request?.status || '')
        }
      })
      .catch((requestError) => { if (active) setLoadError(requestError.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [token])

  const submitSignature = async (event) => {
    event.preventDefault()
    if (!signatureText.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch(`/api/signatures/${encodeURIComponent(token)}/sign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signatureText: signatureText.trim(), signatureStyle }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'İmza kaydedilemedi.')
      setDone(true)
      setResultStatus('signed')
      setNotifiedEmails(data.notifiedEmails || [])
      setNextSigner(data.nextSigner || null)
      setRequest((current) => current ? { ...current, status: 'signed', signedAt: data.signedAt } : current)
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setBusy(false)
    }
  }

  const submitDecline = async (event) => {
    event.preventDefault()
    if (declineBusy) return
    setDeclineBusy(true)
    setError('')
    try {
      const response = await apiFetch(`/api/signatures/${encodeURIComponent(token)}/decline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: declineReason.trim() }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'İmza isteği reddedilemedi.')
      setDone(true)
      setResultStatus('declined')
      setRequest((current) => current ? { ...current, status: 'declined' } : current)
    } catch (declineError) {
      setError(declineError.message)
    } finally {
      setDeclineBusy(false)
    }
  }

  return (
    <div className="review-shell">
      <header className="review-header"><div className="brand-lockup"><div className="brand-mark"><Sparkles size={17} strokeWidth={2.5} /></div><span className="brand-name">update<span>MyPDF</span></span></div><span className="review-secure"><Check size={13} /> Güvenli PDF workflow</span></header>
      {loading ? <div className="review-state"><LoaderCircle className="spin" size={25} /><p>PDF hazırlanıyor...</p></div> : loadError ? <div className="review-state review-error"><X size={25} /><h1>Bağlantı açılamadı</h1><p>{loadError}</p></div> : request && <main className="review-layout"><section className="review-viewer"><div className="review-viewer-heading"><FileText size={16} /><strong>{request.documentName}</strong></div><iframe title="İmzalanacak PDF" src={`${request.signedUrl}#toolbar=0&navpanes=0`} /></section><section className="review-card"><div className="review-card-icon"><PenLine size={19} /></div><span className="review-eyebrow">{request.workflowType === 'review' ? 'PDF inceleme isteği' : 'PDF imza isteği'}</span><h1>{request.workflowType === 'review' ? 'Belgeyi incele ve onayla' : 'Belgeyi imzala'}</h1>{request.recipientName && <p className="review-greeting">Merhaba {request.recipientName},</p>}{request.message && <p className="review-message">{request.message}</p>}<p className="review-expiry">Bu bağlantı {new Date(request.expiresAt).toLocaleString()} tarihine kadar geçerli.</p>{done ? <div className={`review-complete ${resultStatus === 'declined' ? 'review-declined' : ''}`}><Check size={20} /><strong>{resultStatus === 'declined' ? 'İstek reddedildi' : nextSigner ? 'İmzan kaydedildi' : 'İşlem tamamlandı'}</strong><p>{resultStatus === 'declined' ? 'Belge sahibine bilgi verildi. Bu bağlantı artık kullanılamaz.' : nextSigner ? `${nextSigner.name} sıradaki signer olarak davet edildi. Onun işlemi tamamlandıktan sonra final PDF tüm taraflara gönderilecek.` : notifiedEmails.length >= 2 ? 'İmzalı PDF, belge sahibine ve imzalayan kişiye e-posta ile gönderildi.' : notifiedEmails.length === 1 ? 'İmza kaydedildi ve imzalı PDF e-posta ile gönderildi.' : 'Yanıtın kaydedildi. E-posta gönderimi daha sonra tekrar denenecek.'}</p></div> : <form className="review-form" onSubmit={submitSignature}><label>{request.workflowType === 'review' ? 'Onay adı' : 'İmza metni'}<input value={signatureText} onChange={(event) => setSignatureText(event.target.value)} required maxLength={500} placeholder="Adını ve soyadını yaz" /></label>{request.workflowType !== 'review' && <fieldset className="signature-style-field"><legend>İmza stilini seç</legend><div className="signature-style-grid">{signatureStyles.map((style) => <button type="button" className={`signature-style-option ${signatureStyle === style.id ? 'selected' : ''}`} onClick={() => setSignatureStyle(style.id)} key={style.id}><span className={`signature-style-sample ${style.id}`}>{signatureText || 'Ad Soyad'}</span><small>{style.label}</small><em>{style.description}</em></button>)}</div></fieldset>}{error && <div className="auth-error">{error}</div>}<button className="auth-submit" type="submit" disabled={busy || !signatureText.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {busy ? 'Kaydediliyor...' : request.workflowType === 'review' ? 'İncelemeyi tamamla' : 'PDF’i imzala'}</button>{request.workflowType !== 'review' && !showDecline && <button className="review-decline-link" type="button" onClick={() => setShowDecline(true)}>İmzalamak istemiyorum</button>}{showDecline && request.workflowType !== 'review' && <div className="review-decline-box"><label>Reddetme nedeni (opsiyonel)<textarea value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} rows={3} maxLength={1000} placeholder="Kısa bir neden yazabilirsin" /></label><div className="review-decline-actions"><button className="review-decline-cancel" type="button" onClick={() => setShowDecline(false)} disabled={declineBusy}>Vazgeç</button><button className="review-decline-confirm" type="button" onClick={submitDecline} disabled={declineBusy}>{declineBusy ? <LoaderCircle className="spin" size={14} /> : null} İsteği reddet</button></div></div>}</form>}<p className="review-disclaimer">Bu işlem, belge sahibinin gönderdiği PDF üzerinde elektronik onay kaydı oluşturur.</p></section></main>}
    </div>
  )
}

const reviewToken = window.location.pathname.startsWith('/review/') ? decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '') : ''
const signedDocumentId = window.location.pathname.startsWith('/document/') ? decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '') : ''

class AppErrorBoundary extends React.Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[app-render-error]', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <div className="app-error-state"><div className="app-error-card"><div className="app-error-icon"><X size={20} /></div><h1>Bu görünüm yüklenemedi</h1><p>PDF’i koruduk. Sayfayı yenileyip tekrar deneyebilirsin.</p><button type="button" onClick={() => window.location.reload()}>Sayfayı yenile</button></div></div>
  }
}

createRoot(document.getElementById('root')).render(<AppErrorBoundary>{reviewToken ? <ReviewPage token={reviewToken} /> : signedDocumentId ? <SignedDocumentPage requestId={signedDocumentId} /> : <App />}</AppErrorBoundary>)
