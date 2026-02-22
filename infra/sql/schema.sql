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

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  format TEXT NOT NULL,
  uri TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'final',
  visibility TEXT NOT NULL DEFAULT 'user',
  supersedes_id TEXT,
  prov JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS artifact_run_idx ON artifact (run_id);
CREATE INDEX IF NOT EXISTS artifact_type_idx ON artifact (type, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_event (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cmd TEXT NOT NULL,
  args JSONB NOT NULL,
  run_id TEXT
);

CREATE OR REPLACE FUNCTION deny_artifact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'artifact_immutable';
END
$$;

DROP TRIGGER IF EXISTS artifact_no_update ON artifact;
CREATE TRIGGER artifact_no_update
BEFORE UPDATE OR DELETE ON artifact
FOR EACH ROW
EXECUTE FUNCTION deny_artifact_mutation();
