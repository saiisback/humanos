CREATE TABLE IF NOT EXISTS workflows (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id),
  root_id text REFERENCES roots(id), mission_id text REFERENCES missions(id),
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_versions (
  id text PRIMARY KEY, workflow_id text NOT NULL REFERENCES workflows(id),
  version integer NOT NULL, graph_hash text NOT NULL, data jsonb NOT NULL,
  UNIQUE(workflow_id,version), UNIQUE(id,workflow_id)
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id text PRIMARY KEY, workflow_id text NOT NULL REFERENCES workflows(id),
  version_id text NOT NULL, status text NOT NULL, revision integer NOT NULL,
  lease_expires_at timestamptz, next_resume_at timestamptz, data jsonb NOT NULL,
  FOREIGN KEY(version_id,workflow_id) REFERENCES workflow_versions(id,workflow_id)
);
CREATE INDEX IF NOT EXISTS workflow_claims ON workflow_runs(status,lease_expires_at,next_resume_at);
CREATE TABLE IF NOT EXISTS workflow_steps (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES workflow_runs(id),
  block_id text NOT NULL, idempotency_key text NOT NULL UNIQUE, data jsonb NOT NULL,
  UNIQUE(run_id,block_id), UNIQUE(id,run_id)
);
CREATE TABLE IF NOT EXISTS workflow_attempts (
  id text PRIMARY KEY, step_id text NOT NULL REFERENCES workflow_steps(id),
  attempt_number integer NOT NULL, data jsonb NOT NULL, UNIQUE(step_id,attempt_number)
);
CREATE TABLE IF NOT EXISTS workflow_events (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES workflow_runs(id),
  sequence bigint NOT NULL, data jsonb NOT NULL, UNIQUE(run_id,sequence)
);
CREATE TABLE IF NOT EXISTS workflow_confirmations (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES workflow_runs(id),
  step_id text NOT NULL, data jsonb NOT NULL,
  FOREIGN KEY(step_id,run_id) REFERENCES workflow_steps(id,run_id)
);
CREATE TABLE IF NOT EXISTS workflow_schedules (
  id text PRIMARY KEY, workflow_id text NOT NULL REFERENCES workflows(id),
  version_id text NOT NULL, status text NOT NULL, next_fire_at timestamptz, data jsonb NOT NULL,
  FOREIGN KEY(version_id,workflow_id) REFERENCES workflow_versions(id,workflow_id)
);
CREATE INDEX IF NOT EXISTS workflow_due ON workflow_schedules(status,next_fire_at);
CREATE TABLE IF NOT EXISTS workflow_occurrences (
  schedule_id text NOT NULL REFERENCES workflow_schedules(id), occurrence_at timestamptz NOT NULL,
  run_id text UNIQUE REFERENCES workflow_runs(id), status text NOT NULL CHECK(status IN ('CREATED','SKIPPED')),
  PRIMARY KEY(schedule_id,occurrence_at)
);
CREATE TABLE IF NOT EXISTS workflow_receipts (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES workflow_runs(id), step_id text NOT NULL,
  data jsonb NOT NULL, FOREIGN KEY(step_id,run_id) REFERENCES workflow_steps(id,run_id)
);
CREATE TABLE IF NOT EXISTS workflow_values (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES workflow_runs(id),
  value_hash text NOT NULL, data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_dispatch_claims (
  step_id text PRIMARY KEY REFERENCES workflow_steps(id),
  confirmation_id text NOT NULL REFERENCES workflow_confirmations(id),
  claimed_at timestamptz NOT NULL
);
