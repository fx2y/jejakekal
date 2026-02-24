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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'artifact_sha256_hex64_chk'
      AND conrelid = 'artifact'::regclass
  ) THEN
    ALTER TABLE artifact
      ADD CONSTRAINT artifact_sha256_hex64_chk
      CHECK (sha256 ~ '^[a-f0-9]{64}$');
  END IF;
END
$$;

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

CREATE TABLE IF NOT EXISTS ocr_job (
  job_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  ver INTEGER NOT NULL CHECK (ver >= 1),
  gate_rev TEXT NOT NULL,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (doc_id, ver) REFERENCES doc_ver (doc_id, ver) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ocr_job_doc_ver_idx ON ocr_job (doc_id, ver, created_at DESC);

CREATE TABLE IF NOT EXISTS ocr_page (
  job_id TEXT NOT NULL REFERENCES ocr_job (job_id) ON DELETE CASCADE,
  page_idx INTEGER NOT NULL CHECK (page_idx >= 0),
  status TEXT NOT NULL,
  gate_score NUMERIC,
  gate_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  png_uri TEXT,
  png_sha TEXT CHECK (png_sha ~ '^[a-f0-9]{64}$'),
  raw_uri TEXT,
  raw_sha TEXT CHECK (raw_sha ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, page_idx)
);

CREATE INDEX IF NOT EXISTS ocr_page_status_idx ON ocr_page (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ocr_patch (
  doc_id TEXT NOT NULL,
  ver INTEGER NOT NULL CHECK (ver >= 1),
  page_idx INTEGER NOT NULL CHECK (page_idx >= 0),
  patch_sha TEXT NOT NULL CHECK (patch_sha ~ '^[a-f0-9]{64}$'),
  patch JSONB NOT NULL,
  source_job_id TEXT REFERENCES ocr_job (job_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (doc_id, ver, page_idx, patch_sha),
  FOREIGN KEY (doc_id, ver) REFERENCES doc_ver (doc_id, ver) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ocr_patch_doc_ver_idx ON ocr_patch (doc_id, ver, page_idx, created_at DESC);

CREATE TABLE IF NOT EXISTS docir_page_version (
  doc_id TEXT NOT NULL,
  ver INTEGER NOT NULL CHECK (ver >= 1),
  page_idx INTEGER NOT NULL CHECK (page_idx >= 0),
  page_sha TEXT NOT NULL CHECK (page_sha ~ '^[a-f0-9]{64}$'),
  source TEXT NOT NULL,
  source_ref_sha TEXT CHECK (source_ref_sha ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (doc_id, ver, page_idx, page_sha),
  FOREIGN KEY (doc_id, ver) REFERENCES doc_ver (doc_id, ver) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS docir_page_version_doc_ver_idx
  ON docir_page_version (doc_id, ver, page_idx, created_at DESC);

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
