---
description: Pipeline outputs, artifact provenance, export/bundle determinism.
paths:
  - packages/pipeline/**
  - packages/core/src/**
  - apps/api/src/export-run.mjs
  - apps/api/src/runs-bundle-zip.mjs
  - golden/**
---

# Pipeline/Bundle Rules

- Canonical artifact set is fixed: `raw`,`docir`,`chunk-index`,`memo`.
- Artifact IDs are immutable vocabulary (`chunk-index` only; no aliases).
- Pipeline/output ordering and IDs must be deterministic for identical input.
- Provenance is IDs+hashes only; raw source/content must not cross provenance boundary.
- Export and bundle are persisted-artifact-first readers; avoid recomputation when rows exist.
- All persisted-blob readers (detail/download/export/bundle) must read by `uri` and verify stored `sha256`; mismatch/unreadable => opaque `5xx`.
- JSON artifact content decode is strict; corrupt JSON is invariant break (opaque `5xx`).
- Bundle endpoints `/runs/:id/bundle` and `/runs/:id/bundle.zip` must remain byte-identical deterministic aliases.
- Bundle JSON/files are canonical (stable structure/newline); manifest time pins to run header `created_at` when present.
- Blob root defaults to stable repo cache (`.cache/run-bundles`); cleanup is explicit opt-in, never default.
- Golden changes are review events: inspect intent before record/diff updates.

# Failure Recipes

- Cross-machine hash drift: audit path/time/env normalization and entry ordering.
- Export false-green suspicion: verify blob preflight read+sha checks are enforced.
- Vocabulary drift: restore canonical IDs across pipeline, API, UI, and tests in one change.
