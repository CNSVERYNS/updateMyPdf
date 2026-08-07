import { cookies } from 'next/headers'
import { cookieName, validSession } from '../../lib/admin-session'

type Overview = {
  period?: { from: string; to: string }
  jobs?: { completed: number; failed: number }
  usage?: { eventCount: number; estimatedCostUsd: number }
  providerCosts?: { total: number; byProvider: Record<string, number> }
  businessExpenses?: { total: number; byCategory: Record<string, number> }
  reportedCostTotal?: number
}

const money = (value: unknown) => `$${Number(value || 0).toFixed(2)}`
const apiBase = (process.env.TRANSLATION_API_URL || 'http://localhost:4000').replace(/\/$/, '')

async function getOverview(): Promise<{ data: Overview | null; error: string }> {
  if (!process.env.ADMIN_API_SECRET) return { data: null, error: 'ADMIN_API_SECRET henüz yapılandırılmamış.' }
  try {
    const response = await fetch(`${apiBase}/api/v1/admin/overview`, { headers: { 'x-admin-api-secret': process.env.ADMIN_API_SECRET }, cache: 'no-store' })
    if (!response.ok) return { data: null, error: `Admin API ${response.status} döndürdü.` }
    return { data: await response.json() as Overview, error: '' }
  } catch {
    return { data: null, error: 'Admin API’ye ulaşılamadı.' }
  }
}

export default async function AdminPage({ searchParams }: { searchParams?: Promise<{ error?: string }> }) {
  const session = (await cookies()).get(cookieName)?.value
  if (!validSession(session)) {
    const params = await searchParams
    return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f6f7f9', fontFamily: 'Arial, sans-serif' }}>
      <form method="post" action="/api/admin/session" style={{ width: 'min(380px, calc(100% - 40px))', padding: 28, border: '1px solid #e1e5ea', borderRadius: 16, background: '#fff', boxShadow: '0 16px 40px rgba(16,24,40,.08)' }}>
        <p style={{ margin: 0, color: '#e65a3d', fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>UPDATEMYPDF ADMIN</p>
        <h1 style={{ margin: '10px 0 8px', color: '#20252c', fontSize: 28 }}>Yönetim paneli</h1>
        <p style={{ color: '#68717e', fontSize: 14, lineHeight: 1.5 }}>Admin secret ile güvenli oturum aç.</p>
        {params?.error && <p style={{ color: '#b42318', fontSize: 13 }}>Secret geçersiz veya admin ayarı eksik.</p>}
        <label style={{ display: 'grid', gap: 8, color: '#454b54', fontSize: 13 }}>Admin secret<input name="secret" type="password" required autoFocus style={{ padding: 12, border: '1px solid #cfd5dc', borderRadius: 8, fontSize: 15 }} /></label>
        <button type="submit" style={{ width: '100%', marginTop: 18, padding: 12, border: 0, borderRadius: 8, color: '#fff', background: '#e65a3d', fontWeight: 700, cursor: 'pointer' }}>Giriş yap</button>
      </form>
    </main>
  }

  const { data, error } = await getOverview()
  const providerCosts = data?.providerCosts?.byProvider || {}
  const expenses = data?.businessExpenses?.byCategory || {}
  return <main style={{ minHeight: '100vh', padding: '40px 24px', background: '#f6f7f9', color: '#20252c', fontFamily: 'Arial, sans-serif' }}>
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, marginBottom: 28 }}>
        <div><p style={{ margin: 0, color: '#e65a3d', fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>UPDATEMYPDF ADMIN</p><h1 style={{ margin: '8px 0 0', fontSize: 32 }}>Business overview</h1></div>
        <form method="post" action="/api/admin/session"><input type="hidden" name="_logout" value="true" /><button formAction="/api/admin/session" formMethod="post" type="submit" style={{ padding: '9px 13px', border: '1px solid #d7dce2', borderRadius: 8, background: '#fff', cursor: 'pointer' }}>Oturumu kapat</button></form>
      </header>
      {error && <div style={{ marginBottom: 20, padding: 14, borderRadius: 10, color: '#8a2c1c', background: '#fff1ed' }}>{error}</div>}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
        {[['Raporlanan toplam gider', money(data?.reportedCostTotal)], ['Provider maliyeti', money(data?.providerCosts?.total)], ['Sabit gider', money(data?.businessExpenses?.total)], ['Tahmini job kullanımı', money(data?.usage?.estimatedCostUsd)]].map(([label, value]) => <article key={label} style={{ padding: 20, border: '1px solid #e1e5ea', borderRadius: 14, background: '#fff' }}><small style={{ color: '#78818c' }}>{label}</small><strong style={{ display: 'block', marginTop: 8, fontSize: 26 }}>{value}</strong></article>)}
      </section>
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginTop: 14 }}>
        <article style={{ padding: 20, border: '1px solid #e1e5ea', borderRadius: 14, background: '#fff' }}><h2 style={{ marginTop: 0, fontSize: 18 }}>Çeviri işleri</h2><p>Tamamlanan: <strong>{data?.jobs?.completed || 0}</strong></p><p>Başarısız: <strong>{data?.jobs?.failed || 0}</strong></p><p>Usage event: <strong>{data?.usage?.eventCount || 0}</strong></p></article>
        <article style={{ padding: 20, border: '1px solid #e1e5ea', borderRadius: 14, background: '#fff' }}><h2 style={{ marginTop: 0, fontSize: 18 }}>Provider maliyetleri</h2>{Object.keys(providerCosts).length ? Object.entries(providerCosts).map(([provider, value]) => <p key={provider} style={{ display: 'flex', justifyContent: 'space-between', margin: '10px 0' }}><span>{provider}</span><strong>{money(value)}</strong></p>) : <p style={{ color: '#78818c' }}>Henüz provider cost snapshot girilmedi.</p>}</article>
        <article style={{ padding: 20, border: '1px solid #e1e5ea', borderRadius: 14, background: '#fff' }}><h2 style={{ marginTop: 0, fontSize: 18 }}>Sabit giderler</h2>{Object.keys(expenses).length ? Object.entries(expenses).map(([category, value]) => <p key={category} style={{ display: 'flex', justifyContent: 'space-between', margin: '10px 0' }}><span>{category}</span><strong>{money(value)}</strong></p>) : <p style={{ color: '#78818c' }}>Henüz sabit gider girilmedi.</p>}</article>
      </section>
      <p style={{ marginTop: 24, color: '#78818c', fontSize: 13 }}>Bu ilk dashboard tahmini job kullanımı ile provider’ın bildirilen maliyetlerini ayrı gösterir; aynı maliyeti iki kez toplamamak için gerçek faturalar cost snapshot olarak işlenecek.</p>
    </div>
  </main>
}
