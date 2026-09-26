CREATE TABLE IF NOT EXISTS workflow_agent_bindings (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  root_id text NOT NULL REFERENCES roots(id),
  workflow_id text NOT NULL REFERENCES workflows(id),
  version_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  derivation_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('PENDING_REGISTRATION','ACTIVE','REVOKING','REVOKED','FAILED','EXPIRED')),
  revision integer NOT NULL CHECK (revision >= 0),
  expires_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, generation),
  FOREIGN KEY (version_id, workflow_id) REFERENCES workflow_versions(id, workflow_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_agent_bindings_one_live ON workflow_agent_bindings(workflow_id)
  WHERE state IN ('PENDING_REGISTRATION','ACTIVE','REVOKING');
CREATE INDEX IF NOT EXISTS workflow_agent_bindings_account ON workflow_agent_bindings(account_id, workflow_id, generation);
CREATE INDEX IF NOT EXISTS workflow_runs_agent_binding ON workflow_runs((data->>'agentBindingId'))
  WHERE data->>'agentBindingId' IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_schedules_agent_binding ON workflow_schedules((data->>'agentBindingId'))
  WHERE data->>'agentBindingId' IS NOT NULL;
