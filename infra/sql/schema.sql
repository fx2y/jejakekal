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

CREATE TABLE IF NOT EXISTS doc (
  doc_id TEXT PRIMARY KEY,
  raw_sha TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_len BIGINT NOT NULL CHECK (byte_len >= 0),
  latest_ver INTEGER NOT NULL DEFAULT 0 CHECK (latest_ver >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS doc_ver (
  doc_id TEXT NOT NULL REFERENCES doc (doc_id) ON DELETE CASCADE,
  ver INTEGER NOT NULL CHECK (ver >= 1),
  raw_sha TEXT NOT NULL,
  marker_config_sha TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (doc_id, ver)
);

CREATE TABLE IF NOT EXISTS block (
  doc_id TEXT NOT NULL,
  ver INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  type TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page >= 1),
  bbox JSONB,
  text TEXT,
  data JSONB,
  block_sha TEXT NOT NULL,
  tsv TSVECTOR,
  prov JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (doc_id, ver, block_id),
  FOREIGN KEY (doc_id, ver) REFERENCES doc_ver (doc_id, ver) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS block_tsv_gin ON block USING GIN (tsv);

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
