ALTER TABLE translation_jobs ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS translation_jobs_idempotency_idx ON translation_jobs ((metadata->>'idempotencyKey')) WHERE metadata ? 'idempotencyKey';
