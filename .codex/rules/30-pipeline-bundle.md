---
description: Pipeline outputs, blob persistence, provenance, and bundle/export determinism.
paths:
  - packages/pipeline/**
  - packages/core/src/**
  - apps/api/src/blob/**
  - apps/api/src/export-run.mjs
  - apps/api/src/runs-bundle-zip.mjs
  - golden/**
---

# Pipeline / Blob / Bundle Rules

- Canonical artifact vocab is fixed: `raw`,`docir`,`chunk-index`,`memo` (exact spellings only).
- Artifact IDs/types/order for identical input must be deterministic.
- Persisted artifacts are truth; export/detail/download/bundle read persisted rows first, not recompute paths.
- Unknown persisted artifact type is contract violation: fail closed (server error), never silently skip/reorder.

# Blob / URI Contracts

- Allowed artifact URI schemes are `bundle://` and `s3://` only.
- URI dispatch is allowlist+strict: missing resolver for supported scheme => hard fail (`artifact_uri_scheme_not_supported`-class), not fallback.
- Persisted-blob readers must read by `uri` and verify stored `sha256` (hex64); unreadable/mismatch/bad sha => opaque `5xx`.
- S3 writes are effect-adapted and verified (`put -> head` length check); size mismatch is hard fail (`blob_size_mismatch`).
- Runtime code must not reintroduce direct volume/fid upload primitives (`assign`/fid/volume-upload paths); lint bans apply outside tests.
- Blob root default for bundle-backed storage is stable repo cache (`.cache/run-bundles`); cleanup is explicit opt-in.

# Key Grammar / Provenance

- Object-key grammar is explicit+fail-closed: prefixes `raw|parse|asset|run`; sha segments lowercase hex64; parse filenames fixed (`marker.json`,`marker.md`,`chunks.json`).
- Raw blobs persist at `raw/sha256/<sha>`; parse outputs at `parse/<doc>/<ver>/...`; extracted assets at `asset/sha256/<sha>`.
- Provenance carries IDs/hashes/keys only (`*_sha`, object keys, parser cfg refs, stdout/stderr hashes); no raw content text across boundary.
- JSON artifact content decode is strict; corrupt JSON is invariant break (opaque `5xx`).

# Parser / DocIR / Memo Contracts

- Marker runner is adapter-owned (argv/env normalization, required-output contract, timing/io hashes); deterministic default path, explicit hybrid opt-in only.
- Required parse outputs (`marker.json`,`marker.md`,`chunks.json` + declared assets) are contract surfaces; missing outputs are hard failure.
- DocIR normalization is pure + deterministic; stable payload hashing drives stable block identities.
- `memo` artifact is execution summary synthesized from persisted block ledger; `marker.md` is parse evidence, not memo source.

# Export / Bundle Determinism

- Bundle endpoints `/runs/:id/bundle` and `/runs/:id/bundle.zip` remain deterministic aliases (byte-stable across re-downloads).
- Bundle JSON/paths are canonicalized (stable order/newline); manifest timestamps pin to run header `created_at` when present.
- Manifest may grow additively (e.g. ingest summary), but values must derive from persisted timeline outputs only.
- Golden diffs are review events: inspect structural intent before `golden:record`.

# Failure Recipes

- Cross-machine hash drift: audit env/time/path normalization and entry ordering.
- Export false-green suspicion: verify blob preflight read+sha checks and persisted-first read path.
- Vocabulary/key drift: restore canonical IDs/keys across pipeline, API, UI, tests in one change.
