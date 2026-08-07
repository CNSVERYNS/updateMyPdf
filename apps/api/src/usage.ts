import crypto from 'node:crypto'
import { Pool } from 'pg'

export type UsageEventInput = {
  id?: string
  jobId?: string | null
  provider: string
  service: string
  eventType: string
  idempotencyKey?: string
  externalId?: string | null
  inputUnits?: number | null
  outputUnits?: number | null
  unitName?: string | null
  estimatedCostUsd?: number | null
  actualCostUsd?: number | null
  currency?: string
  metadata?: Record<string, unknown>
  occurredAt?: string
}

export type UsageEvent = UsageEventInput & {
  id: string
  createdAt: string
  occurredAt: string
}

export type CostSnapshotInput = {
  provider: string
  service?: string | null
  periodStart: string
  periodEnd: string
  amount: number
  currency?: string
  source?: string
  idempotencyKey?: string
  metadata?: Record<string, unknown>
}

export type BusinessExpenseInput = {
  category: string
  vendor: string
  periodStart: string
  periodEnd: string
  amount: number
  currency?: string
  recurring?: boolean
  note?: string | null
  metadata?: Record<string, unknown>
}

export type UsageOverview = {
  period: { from: string; to: string }
  jobs: { completed: number; failed: number }
  usage: { eventCount: number; estimatedCostUsd: number }
  providerCosts: { total: number; byProvider: Record<string, number> }
  businessExpenses: { total: number; byCategory: Record<string, number> }
  reportedCostTotal: number
}

export interface UsageRepository {
  record(input: UsageEventInput): Promise<UsageEvent>
  list(from: Date, to: Date, limit?: number): Promise<UsageEvent[]>
  overview(from: Date, to: Date): Promise<UsageOverview>
  addCostSnapshot(input: CostSnapshotInput): Promise<void>
  addExpense(input: BusinessExpenseInput): Promise<void>
}

const iso = (value: Date) => value.toISOString()
const amount = (value: unknown) => Number(value || 0)
const emptyOverview = (from: Date, to: Date): UsageOverview => ({
  period: { from: iso(from), to: iso(to) },
  jobs: { completed: 0, failed: 0 },
  usage: { eventCount: 0, estimatedCostUsd: 0 },
  providerCosts: { total: 0, byProvider: {} },
  businessExpenses: { total: 0, byCategory: {} },
  reportedCostTotal: 0,
})

class MemoryUsageRepository implements UsageRepository {
  private readonly events: UsageEvent[] = []
  private readonly snapshots: Array<CostSnapshotInput & { createdAt: string }> = []
  private readonly expenses: Array<BusinessExpenseInput & { createdAt: string }> = []

  async record(input: UsageEventInput) {
    if (input.idempotencyKey) {
      const existing = this.events.find((event) => event.idempotencyKey === input.idempotencyKey)
      if (existing) return existing
    }
    const now = new Date().toISOString()
    const event: UsageEvent = { ...input, id: input.id || crypto.randomUUID(), metadata: input.metadata || {}, currency: input.currency || 'USD', createdAt: now, occurredAt: input.occurredAt || now }
    this.events.push(event)
    return event
  }

  async list(from: Date, to: Date, limit = 100) {
    return this.events.filter((event) => {
      const occurred = new Date(event.occurredAt).getTime()
      return occurred >= from.getTime() && occurred < to.getTime()
    }).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, Math.min(Math.max(limit, 1), 500))
  }

  async overview(from: Date, to: Date) {
    const result = emptyOverview(from, to)
    const events = this.events.filter((event) => {
      const occurred = new Date(event.occurredAt).getTime()
      return occurred >= from.getTime() && occurred < to.getTime()
    })
    result.usage.eventCount = events.length
    result.usage.estimatedCostUsd = events.reduce((total, event) => total + amount(event.actualCostUsd ?? event.estimatedCostUsd), 0)
    result.jobs.completed = events.filter((event) => event.eventType === 'document_translation_completed').length
    result.jobs.failed = events.filter((event) => event.eventType === 'document_translation_failed').length
    for (const snapshot of this.snapshots) {
      const start = new Date(snapshot.periodStart).getTime()
      const end = new Date(snapshot.periodEnd).getTime()
      if (start < to.getTime() && end >= from.getTime()) result.providerCosts.byProvider[snapshot.provider] = (result.providerCosts.byProvider[snapshot.provider] || 0) + amount(snapshot.amount)
    }
    result.providerCosts.total = Object.values(result.providerCosts.byProvider).reduce((total, value) => total + value, 0)
    for (const expense of this.expenses) {
      const start = new Date(expense.periodStart).getTime()
      const end = new Date(expense.periodEnd).getTime()
      if (start < to.getTime() && end >= from.getTime()) result.businessExpenses.byCategory[expense.category] = (result.businessExpenses.byCategory[expense.category] || 0) + amount(expense.amount)
    }
    result.businessExpenses.total = Object.values(result.businessExpenses.byCategory).reduce((total, value) => total + value, 0)
    result.reportedCostTotal = result.providerCosts.total + result.businessExpenses.total
    return result
  }

  async addCostSnapshot(input: CostSnapshotInput) {
    if (input.idempotencyKey && this.snapshots.some((item) => item.idempotencyKey === input.idempotencyKey)) return
    this.snapshots.push({ ...input, createdAt: new Date().toISOString() })
  }

  async addExpense(input: BusinessExpenseInput) {
    this.expenses.push({ ...input, createdAt: new Date().toISOString() })
  }
}

const toEvent = (row: Record<string, any>): UsageEvent => ({
  id: row.id,
  jobId: row.job_id,
  provider: row.provider,
  service: row.service,
  eventType: row.event_type,
  idempotencyKey: row.idempotency_key || undefined,
  externalId: row.external_id,
  inputUnits: row.input_units == null ? null : amount(row.input_units),
  outputUnits: row.output_units == null ? null : amount(row.output_units),
  unitName: row.unit_name,
  estimatedCostUsd: row.estimated_cost_usd == null ? null : amount(row.estimated_cost_usd),
  actualCostUsd: row.actual_cost_usd == null ? null : amount(row.actual_cost_usd),
  currency: row.currency,
  metadata: row.metadata || {},
  occurredAt: new Date(row.occurred_at).toISOString(),
  createdAt: new Date(row.created_at).toISOString(),
})

class PostgresUsageRepository implements UsageRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: UsageEventInput) {
    const { rows } = await this.pool.query(`
      INSERT INTO usage_events (id, job_id, provider, service, event_type, idempotency_key, external_id, input_units, output_units, unit_name, estimated_cost_usd, actual_cost_usd, currency, metadata, occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET id = usage_events.id
      RETURNING *
    `, [input.id || crypto.randomUUID(), input.jobId || null, input.provider, input.service, input.eventType, input.idempotencyKey || null, input.externalId || null, input.inputUnits ?? null, input.outputUnits ?? null, input.unitName || null, input.estimatedCostUsd ?? null, input.actualCostUsd ?? null, input.currency || 'USD', JSON.stringify(input.metadata || {}), input.occurredAt || new Date().toISOString()])
    return toEvent(rows[0])
  }

  async list(from: Date, to: Date, limit = 100) {
    const { rows } = await this.pool.query('SELECT * FROM usage_events WHERE occurred_at >= $1 AND occurred_at < $2 ORDER BY occurred_at DESC LIMIT $3', [from, to, Math.min(Math.max(limit, 1), 500)])
    return rows.map(toEvent)
  }

  async overview(from: Date, to: Date) {
    const result = emptyOverview(from, to)
    const [usage, jobs, providers, expenses] = await Promise.all([
      this.pool.query('SELECT count(*)::int AS event_count, COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)),0) AS estimated_cost FROM usage_events WHERE occurred_at >= $1 AND occurred_at < $2', [from, to]),
      this.pool.query("SELECT event_type, count(*)::int AS count FROM usage_events WHERE occurred_at >= $1 AND occurred_at < $2 AND event_type IN ('document_translation_completed','document_translation_failed') GROUP BY event_type", [from, to]),
      this.pool.query('SELECT provider, COALESCE(SUM(amount),0) AS amount FROM provider_cost_snapshots WHERE period_start < $2 AND period_end >= $1 GROUP BY provider', [from, to]),
      this.pool.query('SELECT category, COALESCE(SUM(amount),0) AS amount FROM business_expenses WHERE period_start < $2 AND period_end >= $1 GROUP BY category', [from, to]),
    ])
    result.usage.eventCount = Number(usage.rows[0]?.event_count || 0)
    result.usage.estimatedCostUsd = amount(usage.rows[0]?.estimated_cost)
    for (const row of jobs.rows) result.jobs[row.event_type === 'document_translation_completed' ? 'completed' : 'failed'] = Number(row.count || 0)
    for (const row of providers.rows) result.providerCosts.byProvider[row.provider] = amount(row.amount)
    result.providerCosts.total = Object.values(result.providerCosts.byProvider).reduce((total, value) => total + value, 0)
    for (const row of expenses.rows) result.businessExpenses.byCategory[row.category] = amount(row.amount)
    result.businessExpenses.total = Object.values(result.businessExpenses.byCategory).reduce((total, value) => total + value, 0)
    result.reportedCostTotal = result.providerCosts.total + result.businessExpenses.total
    return result
  }

  async addCostSnapshot(input: CostSnapshotInput) {
    await this.pool.query(`INSERT INTO provider_cost_snapshots (provider, service, period_start, period_end, amount, currency, source, idempotency_key, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`, [input.provider, input.service || null, input.periodStart, input.periodEnd, input.amount, input.currency || 'USD', input.source || 'manual', input.idempotencyKey || null, JSON.stringify(input.metadata || {})])
  }

  async addExpense(input: BusinessExpenseInput) {
    await this.pool.query(`INSERT INTO business_expenses (category, vendor, period_start, period_end, amount, currency, recurring, note, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.category, input.vendor, input.periodStart, input.periodEnd, input.amount, input.currency || 'USD', input.recurring ?? false, input.note || null, JSON.stringify(input.metadata || {})])
  }
}

export const createUsageRepository = (databaseUrl?: string): UsageRepository => databaseUrl ? new PostgresUsageRepository(new Pool({ connectionString: databaseUrl, max: 10 })) : new MemoryUsageRepository()
