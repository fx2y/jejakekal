CREATE TABLE IF NOT EXISTS side_effects (
  effect_key TEXT PRIMARY KEY,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_input_claims (
  workflow_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
