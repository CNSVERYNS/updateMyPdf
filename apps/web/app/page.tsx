'use client'

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react'

type QualityIssue = { message?: string; severity?: string; type?: string }
type QualityLayer = { score?: number; status?: string; engine?: string; issues?: QualityIssue[] }
type Job = { jobId: string; status: string; progress: number; stage: string; originalFileName?: string; qualityScore?: number | null; qualityWarnings?: string[]; qualityReport?: Record<string, QualityLayer>; error?: { code: string; message: string } | null }
const apiUrl = (process.env.NEXT_PUBLIC_TRANSLATION_API_URL || '/api/translation').replace(/\/$/, '')
const languages = [['tr', 'Türkçe'], ['en', 'İngilizce'], ['de', 'Almanca'], ['fr', 'Fransızca'], ['es', 'İspanyolca'], ['it', 'İtalyanca'], ['ar', 'Arapça'], ['zh', 'Çince'], ['ja', 'Japonca']]
const stages: Record<string, string> = { received: 'Dosya kontrol ediliyor', validating: 'Dosya kontrol ediliyor', uploaded: 'Dosya güvenli depolamaya yükleniyor', submitted: 'Çeviri başlatıldı', translating: 'Belge çevriliyor', downloading: 'Sonuç hazırlanıyor', quality_check: 'Sayfa düzeni kontrol ediliyor', completed: 'Çeviri tamamlandı', completed_with_warnings: 'Kontrol edilmesi gereken bazı yerleşim uyarıları var', failed: 'İşlem tamamlanamadı' }

export default function TranslationPage() {
  const [file, setFile] = useState<File | null>(null)
  const [sourceLanguage, setSourceLanguage] = useState('auto')
  const [targetLanguage, setTargetLanguage] = useState('tr')
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pollStartedAt = useRef<number>(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const terminal = job && ['completed', 'completed_with_warnings', 'failed', 'expired', 'deleted'].includes(job.status)
  const stageText = useMemo(() => stages[job?.status || ''] || 'Çeviri hazırlanıyor', [job?.status])

  useEffect(() => {
    const saved = window.localStorage.getItem('updatemypdf-translation-job')
    if (!saved) return
    fetch(`${apiUrl}/jobs/${encodeURIComponent(saved)}`).then(async (response) => { if (!response.ok) throw new Error(); setJob(await response.json()) }).catch(() => window.localStorage.removeItem('updatemypdf-translation-job'))
  }, [])

  useEffect(() => {
    if (!job?.jobId || terminal || !['submitted', 'translating', 'downloading', 'quality_check'].includes(job.status)) return
    pollStartedAt.current ||= Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = true
    const poll = async () => {
      try {
        const response = await fetch(`${apiUrl}/jobs/${encodeURIComponent(job.jobId)}`)
        const next = await response.json()
        if (active) setJob(next)
        if (active && !['completed', 'completed_with_warnings', 'failed', 'expired', 'deleted'].includes(next.status)) {
          const elapsed = Date.now() - pollStartedAt.current
          timer = setTimeout(poll, elapsed < 30000 ? 3000 : elapsed < 600000 ? 8000 : 20000)
        }
      } catch { if (active) setError('İşlem durumu alınamadı. İnternet bağlantısını kontrol edin.') }
    }
    timer = setTimeout(poll, 1000)
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [job?.jobId, job?.status, terminal])

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => { const next = event.target.files?.[0]; if (next) { setFile(next); setError(''); setJob(null) } }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!file) return setError('Önce bir PDF veya DOCX seçin.'); setBusy(true); setError(''); setJob(null)
    try {
      const form = new FormData(); form.append('file', file); form.append('sourceLanguage', sourceLanguage); form.append('targetLanguage', targetLanguage); form.append('preserveLayout', 'true')
      const upload = await fetch(`${apiUrl}/uploads`, { method: 'POST', body: form }); const uploadData = await upload.json(); if (!upload.ok) throw new Error(uploadData.error?.message || 'Dosya yüklenemedi.')
      const start = await fetch(`${apiUrl}/jobs/${uploadData.jobId}/start`, { method: 'POST' }); const startData = await start.json(); if (!start.ok) throw new Error(startData.error?.message || 'Çeviri başlatılamadı.')
      const current = await fetch(`${apiUrl}/jobs/${encodeURIComponent(uploadData.jobId)}`)
      const currentData = current.ok ? await current.json() : { jobId: uploadData.jobId, status: startData.status, progress: startData.status === 'completed' || startData.status === 'completed_with_warnings' ? 100 : 15, stage: startData.status }
      setJob(currentData); window.localStorage.setItem('updatemypdf-translation-job', uploadData.jobId)
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : 'Çeviri başlatılamadı.') } finally { setBusy(false) }
  }
  const download = async () => {
    if (!job?.jobId) return
    try {
      const linkResponse = await fetch(`${apiUrl}/jobs/${encodeURIComponent(job.jobId)}/download-link`)
      const linkData = await linkResponse.json()
      if (!linkResponse.ok) return setError(linkData.error?.message || 'İndirme bağlantısı oluşturulamadı.')
      const signed = new URL(linkData.downloadUrl)
      const directUrl = `${apiUrl}${signed.pathname.replace('/api/v1', '')}${signed.search}`
      const link = document.createElement('a')
      link.href = directUrl
      link.download = `translated-${job.originalFileName || 'document.pdf'}`
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch {
      setError('Sonuç dosyası indirilemedi. Lütfen tekrar deneyin.')
    }
  }

  return <main className="page-shell">
    <nav className="nav"><div className="brand"><span className="brand-mark">✦</span> update<span>MyPDF</span></div><a href={process.env.NEXT_PUBLIC_EDITOR_URL || 'http://localhost:5173'}>PDF editörüne dön</a></nav>
    <section className="hero"><div><p className="eyebrow">DOCUMENT TRANSLATION</p><h1>Belgenin dilini değiştir.<br /><em>Düzenini koru.</em></h1><p className="lede">PDF ve DOCX dosyalarını profesyonel yerleşimi, tabloları ve sayfa yapısı korunarak çevir.</p></div><div className="trust-card"><span>✓</span><div><strong>Orijinal düzen korunur</strong><small>Azure Document Translation + otomatik kalite kontrolü</small></div></div></section>
    <form className="workspace" onSubmit={submit}>
      <div className="card upload-card" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const next = event.dataTransfer.files?.[0]; if (next) { setFile(next); setError('') } }}>
        <div className="card-heading"><div><p className="eyebrow">01 · DOCUMENT</p><h2>Belgeni yükle</h2></div><span className="format-pill">PDF · DOCX</span></div>
        <input ref={inputRef} hidden type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={chooseFile} />
        <button type="button" className={`dropzone ${file ? 'has-file' : ''}`} onClick={() => inputRef.current?.click()}><span className="upload-symbol">{file ? '✓' : '↑'}</span><strong>{file ? file.name : 'Dosyanı buraya bırak'}</strong><small>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · yeni dosya seçmek için tıkla` : 'veya cihazından seç · maksimum 20 MB'}</small></button>
      </div>
      <div className="card settings-card"><div className="card-heading"><div><p className="eyebrow">02 · LANGUAGE</p><h2>Çeviri ayarları</h2></div><span className="locked">🔒 Düzen koruma açık</span></div><div className="language-grid"><label>Kaynak dil<select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)}><option value="auto">Otomatik algıla</option>{languages.map(([code, label]) => <option value={code} key={code}>{label}</option>)}</select></label><span className="swap">→</span><label>Hedef dil<select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}>{languages.map(([code, label]) => <option value={code} key={code}>{label}</option>)}</select></label></div><button className="translate-button" disabled={busy || !file}>{busy ? 'Hazırlanıyor…' : 'Belgeyi çevir →'}</button></div>
    </form>
    {error && <div className="alert error">{error}</div>}
    {job && <section className="card progress-card"><div className="progress-top"><div><p className="eyebrow">03 · STATUS</p><h2>{stageText}</h2><small>{job.originalFileName} · {job.progress}%</small></div>{terminal && job.status !== 'failed' ? <button className="download-button" onClick={download}>↓ İndir</button> : <span className="progress-percent">{job.progress}%</span>}</div><div className="progress-track"><span style={{ width: `${Math.max(4, job.progress)}%` }} /></div>{job.qualityWarnings?.length ? <div className="warnings">{job.qualityWarnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}</div> : null}{job.qualityReport && <details className="quality-details"><summary>Katmanlı kalite analizi</summary>{Object.entries(job.qualityReport).map(([name, layer]) => <p key={name}>{name}: {layer.score ?? '—'}/100 · {layer.status === 'pass' ? 'Uygun' : 'Kontrol gerekli'}</p>)}</details>}{job.error && <div className="alert error">{job.error.message}</div>}</section>}
    <footer>Dosyaların geçici olarak işlenir ve retention süresi sonunda silinir. <span>Güvenli belge işleme</span></footer>
    {job?.qualityReport?.visualReview?.issues?.length ? <div className="alert visual-review"><strong>Görsel inceleme notları</strong>{job.qualityReport.visualReview.issues.slice(0, 5).map((issue, index) => <p key={`${issue.type || 'issue'}-${index}`}>{issue.message}</p>)}</div> : null}
  </main>
}
