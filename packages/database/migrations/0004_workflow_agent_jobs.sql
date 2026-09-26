CREATE TABLE IF NOT EXISTS workflow_agent_reviews (
  id text PRIMARY KEY,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_agent_receipt_jobs (
  id text PRIMARY KEY,
  binding_id text NOT NULL REFERENCES workflow_agent_bindings(id),
  run_id text NOT NULL REFERENCES workflow_runs(id),
  receipt_hash text NOT NULL,
  source_receipt_id text REFERENCES workflow_receipts(id),
  state text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  tx_hashes jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(binding_id,run_id,receipt_hash)
);
-- Upgrade an already-running development database as well as a fresh install.
ALTER TABLE workflow_agent_receipt_jobs ADD COLUMN IF NOT EXISTS source_receipt_id text REFERENCES workflow_receipts(id);
ALTER TABLE workflow_agent_receipt_jobs ADD COLUMN IF NOT EXISTS error_code text;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_agent_receipt_source ON workflow_agent_receipt_jobs(source_receipt_id) WHERE source_receipt_id IS NOT NULL;
