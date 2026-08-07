CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS translation_jobs (
  id uuid PRIMARY KEY,
  original_file_name text NOT NULL,
  sanitized_file_name text NOT NULL,
  source_mime_type text NOT NULL,
  source_extension text NOT NULL,
  source_language text,
  target_language text NOT NULL,
  translation_mode text,
  status text NOT NULL,
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  current_stage text NOT NULL,
  source_blob_name text,
  target_blob_name text,
  azure_operation_id text,
  azure_operation_url text,
  source_size_bytes bigint NOT NULL,
  result_size_bytes bigint,
  source_page_count integer,
  result_page_count integer,
  quality_score numeric,
  quality_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  error_message text,
  error_details jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS translation_jobs_idempotency_idx ON translation_jobs ((metadata->>'idempotencyKey')) WHERE metadata ? 'idempotencyKey';
CREATE INDEX IF NOT EXISTS translation_jobs_active_idx ON translation_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS translation_jobs_expiry_idx ON translation_jobs (expires_at);

CREATE TABLE IF NOT EXISTS translation_job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
  previous_status text,
  new_status text NOT NULL,
  event_type text NOT NULL,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS translation_job_events_job_idx ON translation_job_events (job_id, created_at);

CREATE TABLE IF NOT EXISTS translation_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('source', 'target', 'quarantine')),
  blob_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint,
  sha256 text,
  created_at timestamptz NOT NULL DEFAULT now()
);
