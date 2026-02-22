CREATE TABLE IF NOT EXISTS workflow_steps (
  workflow_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  output_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workflow_id, step_name)
);

CREATE TABLE IF NOT EXISTS side_effects (
  effect_key TEXT PRIMARY KEY,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_events (
  workflow_id TEXT NOT NULL,
  event_index BIGSERIAL PRIMARY KEY,
  step_name TEXT NOT NULL,
  phase TEXT NOT NULL,
  payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
