CREATE TABLE IF NOT EXISTS workflow_usage (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  workflow_id text NOT NULL,
  context jsonb NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_usage_owner_idx ON workflow_usage(account_id, workflow_id);
