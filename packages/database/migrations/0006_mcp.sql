CREATE TABLE IF NOT EXISTS mcp_connections (
  account_id text NOT NULL, provider text NOT NULL,
  version integer NOT NULL, status text NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY(account_id,provider)
);
CREATE TABLE IF NOT EXISTS mcp_dispatches (
  account_id text NOT NULL, request_key text NOT NULL,
  request_hash text NOT NULL, object_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,request_key)
);
