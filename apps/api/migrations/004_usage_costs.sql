CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES translation_jobs(id) ON DELETE SET NULL,
  provider text NOT NULL,
  service text NOT NULL,
  event_type text NOT NULL,
  idempotency_key text,
  external_id text,
  input_units numeric,
  output_units numeric,
  unit_name text,
  estimated_cost_usd numeric(20,8),
  actual_cost_usd numeric(20,8),
  currency char(3) NOT NULL DEFAULT 'USD',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_events_idempotency_idx
  ON usage_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_events_occurred_idx
  ON usage_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_provider_idx
  ON usage_events (provider, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_job_idx
  ON usage_events (job_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS provider_cost_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  service text,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  amount numeric(20,8) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  source text NOT NULL DEFAULT 'manual',
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_cost_snapshots_idempotency_idx
  ON provider_cost_snapshots (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_cost_snapshots_period_idx
  ON provider_cost_snapshots (period_start, period_end);

CREATE TABLE IF NOT EXISTS business_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  vendor text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  amount numeric(20,8) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  recurring boolean NOT NULL DEFAULT false,
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS business_expenses_period_idx
  ON business_expenses (period_start, period_end);
