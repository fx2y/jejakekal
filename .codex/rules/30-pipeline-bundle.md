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

- Frozen artifact vocab: `raw`,`docir`,`chunk-index`,`memo` (exact spellings).
- Identical input must yield deterministic artifact IDs/types/order.
- Persisted artifact rows are truth; export/detail/download/bundle are persisted-first readers.
- Unknown artifact type is a hard contract break (fail closed), never skipped/reordered.

# Blob / URI Contracts

- Allowlisted URI schemes only: `bundle://`,`s3://`.
- URI parsing is strict and trust-domain aware; unsupported/malformed persisted URI is invariant `5xx`.
- Persisted readers load by stored `uri` and sha-verify (`sha256` hex64); unreadable/mismatch/bad sha => opaque `5xx`.
- S3 write contract is `put -> head(length verify)`; mismatch is hard fail (`blob_size_mismatch`).
- Direct fid/volume-upload primitives are forbidden in runtime paths.
- Bundle storage root default is `.cache/run-bundles`; cleanup is explicit opt-in.

# Key Grammar / Provenance

- Object-key grammar is fail-closed: prefixes `raw|parse|asset|run`; sha segments lowercase hex64; parse file names fixed (`marker.json`,`marker.md`,`chunks.json`).
- Canonical keyspaces: `raw/sha256/<sha>`, `parse/<doc>/<ver>/...`, `asset/sha256/<sha>`, OCR run assets under `run/<runId>/...`.
- Provenance boundary carries IDs/hashes/keys only; raw content/source text is forbidden.
- JSON artifact detail decode is strict; corruption is invariant `5xx`.

# Parser / DocIR / Memo Contracts

- Marker runner is adapter-owned (argv/env normalization, required outputs, timing/io hashes); default path deterministic.
- Required parse outputs (`marker.json`,`marker.md`,`chunks.json` + declared assets) are contract surfaces; missing outputs hard-fail.
- DocIR normalization is pure/deterministic; block identity/hash is stable and replay-safe.
- `memo` derives from persisted block ledger and step outputs, never from transient `marker.md`.

# Export / Bundle Determinism

- `/runs/:id/bundle` and `/runs/:id/bundle.zip` are deterministic aliases (byte-identical payloads).
- Bundle JSON/path ordering is canonical; manifest time pins to run header `created_at` when present.
- Manifest enrichment is additive-only and must derive from persisted rows/step outputs (no export-time recompute).
- OCR export sidecars are deterministic triad: `ocr_pages.json`,`ocr_report.md`,`diff_summary.md` (explicit no-diff payload allowed).
- `GET /runs/:id/export` carries additive `ingest.ocr` summary (`hard_pages,ocr_pages,ocr_failures,ocr_model,diff_sha`) aligned to manifest truth.
- Golden drift is review-required; no blind re-record.

# Failure Recipes

- Cross-machine hash drift: audit env/time/path normalization and deterministic ordering.
- Export false-green suspicion: verify persisted-first read path plus blob read+sha checks.
- Vocab/key drift: restore canonical IDs/keys across pipeline/API/UI/tests in one change.
