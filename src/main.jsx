import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Cloud,
  CloudUpload,
  Download,
  FilePlus2,
  FileText,
  GitCompareArrows,
  History,
  Highlighter,
  ImagePlus,
  Link2,
  LoaderCircle,
  ListChecks,
  LogIn,
  LogOut,
  MessageSquareText,
  MoreHorizontal,
  PanelRight,
  PenLine,
  RotateCcw,
  Search,
  Sparkles,
  Split,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { supabase, supabaseConfigured } from './supabase'
import './styles.css'

const apiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const apiFetch = (path, options) => fetch(`${apiBaseUrl}${path}`, options)

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
  const [aiStatus, setAiStatus] = useState('idle')
  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [activeTool, setActiveTool] = useState('select')
  const [changes, setChanges] = useState([])
  const [showHistory, setShowHistory] = useState(false)
  const [showCapabilities, setShowCapabilities] = useState(false)
  const [capabilitySummary, setCapabilitySummary] = useState(null)
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
  const [isCloudSaving, setIsCloudSaving] = useState(false)
  const [currentCloudPath, setCurrentCloudPath] = useState('')
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
    apiFetch('/api/capabilities')
      .then((response) => response.ok ? response.json() : null)
      .then((data) => setCapabilitySummary(data))
      .catch(() => setCapabilitySummary(null))
  }, [])

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
    try {
      setGuestPromptCount(Number(window.sessionStorage.getItem('pdfmaniac_guest_prompt_count') || 0))
    } catch {
      setGuestPromptCount(0)
    }
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timeout = window.setTimeout(() => setToast(null), 5200)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const authHeaders = () => session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}

  const loadCloudFiles = async () => {
    if (!session) return
    const result = await apiFetch('/api/workspace', { headers: authHeaders() })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'Workspace dosyaları okunamadı.')
    setCloudFiles(data.files || [])
    setWorkspaceRequests(data.signatureRequests || [])
  }

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
      setShowAccount(false)
      setToast({ tone: 'success', text: 'Hesap bilgilerin güncellendi.' })
    } catch (error) {
      setProfileError(error.message || 'Hesap bilgileri güncellenemedi.')
    } finally {
      setProfileBusy(false)
    }
  }

  const signOut = async () => {
    await supabase?.auth.signOut()
    if (fileUrl) URL.revokeObjectURL(fileUrl)
    setFile(null)
    setOriginalFile(null)
    setFileUrl('')
    setPdfTitle('')
    setCloudFiles([])
    setCurrentCloudPath('')
    setShowCloudFiles(false)
    setMessages(initialMessages)
    setAssistantProfile(null)
    setCachedDocument(null)
    try { localStorage.removeItem(assistantPersistenceKey) } catch {}
  }

  const uploadCurrentToCloud = async () => {
    if (!file) throw new Error('Önce bir PDF yüklemelisin.')
    if (!session) {
      openAuthPrompt()
      throw new Error('Önce Cloud hesabına giriş yapmalısın.')
    }
    const formData = new FormData()
    formData.append('file', file)
    const result = await apiFetch('/api/storage/upload', { method: 'POST', headers: authHeaders(), body: formData })
    const data = await result.json().catch(() => ({}))
    if (!result.ok) throw new Error(data.error || 'PDF cloud’a yüklenemedi.')
    setCurrentCloudPath(data.path || '')
    return data
  }

  const saveCurrentToCloud = async () => {
    if (!file) return
    if (!session) {
      openAuthPrompt()
      return
    }
    setIsCloudSaving(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const result = await apiFetch('/api/storage/upload', { method: 'POST', headers: authHeaders(), body: formData })
      const data = await result.json().catch(() => ({}))
      if (!result.ok) throw new Error(data.error || 'PDF cloud’a yüklenemedi.')
      setCurrentCloudPath(data.path || '')
      setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: 'PDF private cloud storage’a kaydedildi.' }])
      await loadCloudFiles()
    } catch (error) {
      setMessages((current) => [...current, { id: Date.now(), role: 'assistant', text: error.message || 'Cloud kaydı başarısız oldu.' }])
    } finally {
      setIsCloudSaving(false)
    }
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
          message: details.message,
          workflowType: details.workflowType,
          expiresIn: details.expiresIn,
          signaturePlacement: details.signaturePlacement,
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
    if (!result.ok) throw new Error(data.error || 'PaylaÅŸÄ±m baÄŸlantÄ±sÄ± oluÅŸturulamadÄ±.')
    await navigator.clipboard?.writeText(data.signedUrl)
    setToast({ tone: 'success', text: '24 saatlik gÃ¼venli paylaÅŸÄ±m baÄŸlantÄ±sÄ± panoya kopyalandÄ±.' })
  }

  const activeChange = changes[changes.length - 1]
  const documentTitle = pdfTitle || file?.name || 'Untitled document'
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
              const cloudFormData = new FormData()
              cloudFormData.append('file', generatedFile)
              const cloudResponse = await apiFetch('/api/storage/upload', { method: 'POST', headers: authHeaders(), body: cloudFormData })
              const cloudData = await cloudResponse.json().catch(() => ({}))
              if (!cloudResponse.ok) throw new Error(cloudData.error || 'Cloud kaydı başarısız oldu.')
              setCurrentCloudPath(cloudData.path || '')
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
      const result = await apiFetch('/api/ai/command', { method: 'POST', headers: authHeaders(), body: formData })
      const rawResponse = await result.text()
      let data = {}
      try {
        data = rawResponse ? JSON.parse(rawResponse) : {}
      } catch {
        throw new Error(`Backend geçerli bir JSON cevabı döndürmedi (${result.status}). API sunucusunun çalıştığından emin ol.`)
      }
      if (!result.ok) throw new Error(data.error || 'AI isteği başarısız oldu.')

      const firstAction = data.actions?.[0]
      const actionLabel = firstAction?.type ? firstAction.type.replaceAll('_', ' ') : 'AI planı'
      const editedFile = data.editedPdf ? decodePdfFile(data.editedPdf, file.name) : null
      if (editedFile) {
        if (fileUrl) URL.revokeObjectURL(fileUrl)
        setFile(editedFile)
        setFileUrl(URL.createObjectURL(editedFile))
        const titleAction = data.actions?.find((action) => action.type === 'set_title' && action.title)
        if (titleAction?.title) setPdfTitle(titleAction.title)
        setPageCount(0)
        const infoFormData = new FormData()
        infoFormData.append('file', editedFile)
        apiFetch('/api/pdf/info', { method: 'POST', headers: authHeaders(), body: infoFormData })
          .then((response) => response.ok ? response.json() : null)
          .then((info) => { if (info?.pageCount) { setPageCount(info.pageCount); setCurrentPage((current) => Math.min(current, info.pageCount)) }; if (info?.title) setPdfTitle(info.title) })
          .catch(() => {})
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
      const warningText = `${data.warnings?.length ? ` ${data.warnings.join(' ')}` : ''}${analysisNotice}${officeNotice}${imageNotice}${audioNotice}`
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Sparkles size={17} strokeWidth={2.5} /></div>
          <span className="brand-name">update<span>MyPDF</span></span>
          <span className="beta-pill">BETA</span>
        </div>

        <div className="document-name">
          <FileText size={15} />
          <span>{documentTitle}</span>
          <span className="saved-state"><Check size={13} /> Saved</span>
        </div>

        <div className="top-actions">
          <button className="icon-button" title="Geçmişi göster" onClick={() => setShowHistory((value) => !value)}>
            <History size={17} />
          </button>
          <button className="icon-button" title="Yetenekleri göster" onClick={() => setShowCapabilities((value) => !value)}>
            <ListChecks size={17} />
          </button>
          <button className="icon-button" title="İki PDF’i karşılaştır" onClick={() => compareInputRef.current?.click()}>
            {isComparing ? <LoaderCircle className="spin" size={17} /> : <GitCompareArrows size={17} />}
          </button>
          <button className="icon-button" title="PDF’leri birleştir" onClick={() => mergeInputRef.current?.click()}>
            {isMerging ? <LoaderCircle className="spin" size={17} /> : <FilePlus2 size={17} />}
          </button>
          <button className="icon-button" title="Planları gör" onClick={() => setShowPricing(true)}><MoreHorizontal size={18} /></button>
          <button className="icon-button" title="İmza taleplerini takip et" onClick={() => { if (!session) openAuthPrompt(); else setShowSignatureRequests(true) }}><Check size={17} /></button>
          <button className="icon-button" title="İmza veya inceleme talebi oluştur" onClick={openSignatureRequest}><PenLine size={17} /></button>
          {supabaseConfigured && (session ? <>
            <button className="icon-button cloud-menu-button" title="Cloud dosyalarını aç" onClick={openCloudFiles}><Cloud size={17} /></button>
            <button className="icon-button cloud-menu-button" title="PDF’i cloud’a kaydet" onClick={saveCurrentToCloud}>
              {isCloudSaving ? <LoaderCircle className="spin" size={17} /> : <CloudUpload size={17} />}
            </button>
            <button className="icon-button cloud-menu-button" title="Cloud hesabından çıkış" onClick={signOut}><LogOut size={17} /></button>
          </> : <button className="cloud-login-button" onClick={() => { setAuthMode('login'); setShowAuth(true) }}><LogIn size={14} /> Giriş</button>)}
          <button className="export-button" onClick={downloadCurrentPdf}>
            <Download size={15} /> Export
          </button>
          <button className="avatar" title="Hesap ayarları" onClick={() => { if (!requireAccount()) return; setProfileError(''); setShowAccount(true) }}>{session?.user?.user_metadata?.full_name?.[0]?.toUpperCase() || session?.user?.email?.[0]?.toUpperCase() || 'C'}</button>
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
              <div className="uploaded-pdf" style={previewScale}>
                <PdfPreview src={fileUrl} page={currentPage} onPageCount={setPageCount} />
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

      {showHistory && <HistoryDrawer changes={changes} onClose={() => setShowHistory(false)} />}
      {showCapabilities && <CapabilitiesDrawer summary={capabilitySummary} onClose={() => setShowCapabilities(false)} />}
      {showComparison && <ComparisonDrawer comparison={comparison} onClose={() => setShowComparison(false)} />}
      {showCloudFiles && <CloudFilesDrawer files={cloudFiles} signatureRequests={workspaceRequests} onClose={() => setShowCloudFiles(false)} onOpen={downloadCloudFile} onDelete={deleteCloudFile} onShare={shareCloudFile} onResend={resendSignatureRequest} onCancel={cancelSignatureRequest} />}
      {showSignatureRequest && <SignatureRequestModal busy={signatureRequestBusy} error={signatureRequestError} result={signatureRequestResult} documentName={file?.name} senderName={session?.user?.user_metadata?.full_name || session?.user?.email} senderEmail={session?.user?.email} pageCount={pageCount} currentPage={currentPage} onClose={() => setShowSignatureRequest(false)} onSubmit={createSignatureRequest} onOpenRequests={() => { setShowSignatureRequest(false); setShowSignatureRequests(true) }} />}
      {showSignatureRequests && <SignatureRequestsDrawer session={session} authHeaders={authHeaders} onClose={() => setShowSignatureRequests(false)} onCancel={cancelSignatureRequest} onResend={resendSignatureRequest} />}
      {showAuth && <AuthModal mode={authMode} busy={authBusy} error={authError} onModeChange={(mode) => { setAuthMode(mode); setAuthError('') }} onClose={() => setShowAuth(false)} onSubmit={handleAuthSubmit} />}
      {showAccount && session && <AccountModal session={session} busy={profileBusy} error={profileError} onClose={() => setShowAccount(false)} onSubmit={handleProfileSave} onOpenPricing={() => { setShowAccount(false); setShowPricing(true) }} />}
      {showAccountNudge && !session && <AccountNudge onClose={() => setShowAccountNudge(false)} onSignup={openAuthPrompt} onPricing={() => setShowPricing(true)} />}
      {showPricing && <PricingModal currentPlan={session?.user?.user_metadata?.plan || 'basic'} onClose={() => setShowPricing(false)} onSelect={() => { setShowPricing(false); if (session) setToast({ tone: 'success', text: 'Stripe ödeme bağlantısı bir sonraki adımda aktifleşecek.' }); else openAuthPrompt() }} />}
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    let documentLoadingTask = null
    let pdfDocument = null
    let renderTask = null
    setLoading(true)
    setError('')

    const renderPage = async () => {
      try {
        const { getDocument } = await loadPdfJs()
        documentLoadingTask = getDocument({ url: src })
        pdfDocument = await documentLoadingTask.promise
        if (cancelled) return
        onPageCount(pdfDocument.numPages)
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
        await renderTask.promise
        if (!cancelled) setLoading(false)
      } catch (renderError) {
        if (!cancelled && renderError?.name !== 'RenderingCancelledException') {
          setError('PDF preview bu belgeyi görüntüleyemedi. İndirme yine kullanılabilir.')
          setLoading(false)
        }
      }
    }
    renderPage()
    return () => {
      cancelled = true
      renderTask?.cancel()
      documentLoadingTask?.destroy()
      pdfDocument?.destroy()
    }
  }, [src, page, onPageCount])

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

function HistoryDrawer({ changes, onClose }) {
  return (
    <aside className="history-drawer">
      <div className="history-heading"><div><span>DOCUMENT</span><h2>Change history</h2></div><button className="icon-button light" onClick={onClose}><X size={17} /></button></div>
      {changes.length === 0 ? <div className="history-empty"><History size={20} /><p>Henüz bir değişiklik yok.</p></div> : <div className="history-list">{[...changes].reverse().map((change, index) => <div className="history-item" key={change.id}><div className="history-dot">{index === 0 ? <Check size={12} /> : index + 1}</div><div><strong>{change.title}</strong><p>{change.detail}</p></div></div>)}</div>}
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
  const signedFiles = (files || []).filter((file) => file.isSignedCopy)
  const signedRequests = (signatureRequests || []).filter((request) => request.status === 'signed' && !request.signedDocumentPath)
  const pendingRequests = (signatureRequests || []).filter((request) => ['pending', 'viewed'].includes(request.status))

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
        <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>Tüm dosyalar <span>{files.length}</span></button>
        <button className={tab === 'signed' ? 'active' : ''} onClick={() => setTab('signed')}>İmzalanan <span>{signedFiles.length + signedRequests.length}</span></button>
        <button className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>İmza bekleyen <span>{pendingRequests.length}</span></button>
      </div>
      {error && <div className="auth-error inline-error">{error}</div>}
      {tab === 'all' && (files.length === 0 ? <div className="history-empty"><Cloud size={20} /><p>Henüz cloud dosyan yok.</p></div> : <div className="cloud-file-list">
        {files.map((file) => (
          <div className="cloud-file-item" key={file.path}>
            <FileText size={16} />
            <div className="cloud-file-copy"><strong>{file.name}</strong><span>{file.size ? `${Math.ceil(file.size / 1024)} KB` : 'PDF'}</span></div>
            <button className="icon-button light" title="PDF’i aç" onClick={() => onOpen(file)}><Download size={15} /></button>
            <button className="icon-button light" title="Süreli paylaşım bağlantısı oluştur" onClick={async () => { try { await onShare(file) } catch (shareError) { setError(shareError.message || 'Bağlantı oluşturulamadı.') } }}><Link2 size={15} /></button>
            <button className="icon-button light" title="Cloud’dan sil" onClick={async () => { try { await onDelete(file) } catch (deleteError) { setError(deleteError.message || 'Dosya silinemedi.') } }}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>)}
      {tab === 'signed' && (signedFiles.length + signedRequests.length === 0 ? <div className="history-empty"><Check size={20} /><p>Henüz imzalanmış bir dosya yok.</p></div> : <div className="cloud-file-list workspace-request-list">
        {signedFiles.map((file) => <div className="cloud-file-item workspace-request-item" key={file.path}><FileText size={16} /><div className="cloud-file-copy"><strong>{file.name}</strong><span>Cloud imzalı kopya · {new Date(file.createdAt).toLocaleString()}</span><button type="button" className="signed-document-link signed-document-button" onClick={() => onOpen(file)}>İmzalı PDF’i aç</button></div><em className="request-status signed">signed</em></div>)}
        {signedRequests.map((request) => <div className="cloud-file-item workspace-request-item" key={request.id}><FileText size={16} /><div className="cloud-file-copy"><strong>{request.document_name}</strong><span>{request.recipient_name || request.recipient_email} · {new Date(request.signed_at || request.created_at).toLocaleString()}</span>{request.signedDocumentUrl && <a className="signed-document-link" href={request.signedDocumentUrl} target="_blank" rel="noreferrer">İmzalı PDF’i aç</a>}</div><em className="request-status signed">signed</em></div>)}
      </div>)}
      {tab === 'pending' && (pendingRequests.length === 0 ? <div className="history-empty"><PenLine size={20} /><p>Bekleyen imza talebi yok.</p></div> : <div className="cloud-file-list workspace-request-list">
        {pendingRequests.map((request) => <div className="cloud-file-item workspace-request-item" key={request.id}><FileText size={16} /><div className="cloud-file-copy"><strong>{request.document_name}</strong><span>{request.recipient_name || request.recipient_email} · {request.status}</span><small>Son geçerlilik: {new Date(request.expires_at).toLocaleString()}</small></div><div className="workspace-request-actions"><button type="button" className="signature-resend-button" onClick={() => runRequestAction(request, onResend)} disabled={busyId === request.id}>{busyId === request.id ? <LoaderCircle className="spin" size={12} /> : 'Resend'}</button><button type="button" className="signature-cancel-button" onClick={() => { if (window.confirm('Bu imza isteğini iptal etmek istediğine emin misin?')) runRequestAction(request, onCancel) }} disabled={busyId === request.id}>İptal</button></div></div>)}
      </div>)}
    </aside>
  )
}

function SignatureRequestModal({ busy, error, result, documentName, senderName, senderEmail, pageCount, currentPage, onClose, onSubmit, onOpenRequests }) {
  const [recipientEmail, setRecipientEmail] = useState('')
  const [recipientName, setRecipientName] = useState('')
  const [message, setMessage] = useState('')
  const [workflowType, setWorkflowType] = useState('signature')
  const [expiresIn, setExpiresIn] = useState('604800')
  const [placement, setPlacement] = useState({ page: Math.max(1, currentPage || 1), left: 0.16, top: 0.72, width: 0.56, height: 0.11 })
  const [copied, setCopied] = useState(false)
  const [formError, setFormError] = useState('')

  const submit = (event) => {
    event.preventDefault()
    if (!recipientName.trim()) {
      setFormError('İmzalayacak kişinin adı gerekli.')
      return
    }
    setFormError('')
    onSubmit({ recipientEmail: recipientEmail.trim(), recipientName: recipientName.trim(), message: message.trim(), workflowType, expiresIn: Number(expiresIn), signaturePlacement: placement })
  }

  const choosePlacement = (event) => {
    const paper = event.currentTarget.getBoundingClientRect()
    const width = placement.width
    const height = placement.height
    const pointerX = Number.isFinite(event.clientX) ? event.clientX : paper.left + paper.width / 2
    const pointerY = Number.isFinite(event.clientY) ? event.clientY : paper.top + paper.height / 2
    const left = Math.min(1 - width - 0.03, Math.max(0.03, (pointerX - paper.left) / paper.width - width / 2))
    const top = Math.min(1 - height - 0.03, Math.max(0.03, (pointerY - paper.top) / paper.height - height / 2))
    setPlacement((current) => ({ ...current, left, top }))
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
            <strong>{result.workflowType === 'review' ? 'İnceleme linki hazır.' : 'İmza linki e-posta ile gönderildi.'}</strong>
            <p>{documentName} için güvenli bağlantı oluşturuldu. Alıcı linki açıp PDF’i görüntüleyebilir.</p>
            <div className="signature-link-box"><span>{result.reviewUrl}</span><button type="button" className="auth-submit" onClick={copyLink}>{copied ? 'Kopyalandı' : 'Linki kopyala'}</button></div>
            <div className="signature-modal-actions"><button type="button" className="auth-switch" onClick={onOpenRequests}>Talepleri takip et</button><button type="button" className="auth-submit" onClick={onClose}>Kapat</button></div>
          </div>
        ) : (
          <>
            <p className="auth-description"><strong>{documentName}</strong> dosyasını güvenli bir linkle başka bir kişiye gönder.</p>
            <form onSubmit={submit}>
              <div className="signature-sender-card"><span>Gönderen hesap</span><strong>{senderName}</strong><small>{senderEmail}</small></div>
              <div className="signature-placement-field"><div className="signature-placement-heading"><label>İmza alanı</label><span>PDF üzerinde tıklayarak konumu seç</span></div><div className="signature-paper" onClick={choosePlacement} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') choosePlacement(event) }}><div className="signature-paper-line one" /><div className="signature-paper-line two" /><div className="signature-paper-line three" /><div className="signature-placement-marker" style={{ left: `${placement.left * 100}%`, top: `${placement.top * 100}%`, width: `${placement.width * 100}%`, height: `${placement.height * 100}%` }}><PenLine size={12} /> İmza alanı</div></div><div className="signature-placement-controls"><label>Sayfa<select value={placement.page} onChange={(event) => setPlacement((current) => ({ ...current, page: Number(event.target.value) }))}>{Array.from({ length: Math.max(1, pageCount || 1) }, (_item, index) => <option value={index + 1} key={index + 1}>{index + 1}</option>)}</select></label><span>Seçilen alan imzalı PDF’e aynı konuma işlenecek.</span></div></div>
              <label>Akış türü<select value={workflowType} onChange={(event) => setWorkflowType(event.target.value)}><option value="signature">İmza iste</option><option value="review">İnceleme iste</option></select></label>
              <label>Alıcı e-posta<input type="email" value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} required autoComplete="email" placeholder="alici@example.com" /></label>
              <label>Alıcı adı (opsiyonel)<input value={recipientName} onChange={(event) => setRecipientName(event.target.value)} autoComplete="name" placeholder="Ali Yılmaz" /></label>
              <label>Mesaj (opsiyonel)<textarea className="signature-message-input" value={message} onChange={(event) => setMessage(event.target.value)} rows={3} placeholder="Kısa bir not ekle..." /></label>
              <label>Link geçerliliği<select value={expiresIn} onChange={(event) => setExpiresIn(event.target.value)}><option value="86400">24 saat</option><option value="604800">7 gün</option><option value="2592000">30 gün</option></select></label>
              {(error || formError) && <div className="auth-error">{error || formError}</div>}
              <button className="auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <PenLine size={16} />} {busy ? 'Gönderiliyor...' : 'Güvenli link gönder'}</button>
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
            <button type="button" className={plan.featured ? 'auth-submit pricing-cta' : 'auth-switch pricing-cta'} onClick={onSelect}>{currentPlan === plan.id ? 'Planı yönet' : `${plan.name} planını seç`}</button>
          </article>)}
        </div>
        <p className="pricing-footnote">AI kredileri belge uzunluğu ve kullanılan modele göre hesaplanır. Kullanılmayan krediler devretmez.</p>
      </div>
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
      {loading ? <div className="review-state"><LoaderCircle className="spin" size={25} /><p>PDF hazırlanıyor...</p></div> : loadError ? <div className="review-state review-error"><X size={25} /><h1>Bağlantı açılamadı</h1><p>{loadError}</p></div> : request && <main className="review-layout"><section className="review-viewer"><div className="review-viewer-heading"><FileText size={16} /><strong>{request.documentName}</strong></div><iframe title="İmzalanacak PDF" src={`${request.signedUrl}#toolbar=0&navpanes=0`} /></section><section className="review-card"><div className="review-card-icon"><PenLine size={19} /></div><span className="review-eyebrow">{request.workflowType === 'review' ? 'PDF inceleme isteği' : 'PDF imza isteği'}</span><h1>{request.workflowType === 'review' ? 'Belgeyi incele ve onayla' : 'Belgeyi imzala'}</h1>{request.recipientName && <p className="review-greeting">Merhaba {request.recipientName},</p>}{request.message && <p className="review-message">{request.message}</p>}<p className="review-expiry">Bu bağlantı {new Date(request.expiresAt).toLocaleString()} tarihine kadar geçerli.</p>{done ? <div className={`review-complete ${resultStatus === 'declined' ? 'review-declined' : ''}`}><Check size={20} /><strong>{resultStatus === 'declined' ? 'İstek reddedildi' : 'İşlem tamamlandı'}</strong><p>{resultStatus === 'declined' ? 'Belge sahibine bilgi verildi. Bu bağlantı artık kullanılamaz.' : notifiedEmails.length >= 2 ? 'İmzalı PDF, belge sahibine ve imzalayan kişiye e-posta ile gönderildi.' : notifiedEmails.length === 1 ? 'İmza kaydedildi ve imzalı PDF e-posta ile gönderildi.' : 'Yanıtın kaydedildi. E-posta gönderimi daha sonra tekrar denenecek.'}</p></div> : <form className="review-form" onSubmit={submitSignature}><label>{request.workflowType === 'review' ? 'Onay adı' : 'İmza metni'}<input value={signatureText} onChange={(event) => setSignatureText(event.target.value)} required maxLength={500} placeholder="Adını ve soyadını yaz" /></label>{request.workflowType !== 'review' && <fieldset className="signature-style-field"><legend>İmza stilini seç</legend><div className="signature-style-grid">{signatureStyles.map((style) => <button type="button" className={`signature-style-option ${signatureStyle === style.id ? 'selected' : ''}`} onClick={() => setSignatureStyle(style.id)} key={style.id}><span className={`signature-style-sample ${style.id}`}>{signatureText || 'Ad Soyad'}</span><small>{style.label}</small><em>{style.description}</em></button>)}</div></fieldset>}{error && <div className="auth-error">{error}</div>}<button className="auth-submit" type="submit" disabled={busy || !signatureText.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} {busy ? 'Kaydediliyor...' : request.workflowType === 'review' ? 'İncelemeyi tamamla' : 'PDF’i imzala'}</button>{request.workflowType !== 'review' && !showDecline && <button className="review-decline-link" type="button" onClick={() => setShowDecline(true)}>İmzalamak istemiyorum</button>}{showDecline && request.workflowType !== 'review' && <div className="review-decline-box"><label>Reddetme nedeni (opsiyonel)<textarea value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} rows={3} maxLength={1000} placeholder="Kısa bir neden yazabilirsin" /></label><div className="review-decline-actions"><button className="review-decline-cancel" type="button" onClick={() => setShowDecline(false)} disabled={declineBusy}>Vazgeç</button><button className="review-decline-confirm" type="button" onClick={submitDecline} disabled={declineBusy}>{declineBusy ? <LoaderCircle className="spin" size={14} /> : null} İsteği reddet</button></div></div>}</form>}<p className="review-disclaimer">Bu işlem, belge sahibinin gönderdiği PDF üzerinde elektronik onay kaydı oluşturur.</p></section></main>}
    </div>
  )
}

const reviewToken = window.location.pathname.startsWith('/review/') ? decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '') : ''
createRoot(document.getElementById('root')).render(reviewToken ? <ReviewPage token={reviewToken} /> : <App />)
