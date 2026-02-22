---
description: Pipeline determinism + run-bundle/golden contracts.
paths:
  - packages/pipeline/**
  - packages/core/src/run-bundle.mjs
  - packages/core/test/run-bundle.unit.test.mjs
  - scripts/golden-*.mjs
  - golden/**
---

# Pipeline/Bundle Rules

- Pipeline output quartet is fixed: `raw`, `docir`, `chunk-index`, `memo`.
- Artifact ID vocabulary is canonical: `chunk-index` only (never `chunks`).
- Chunk IDs/order are deterministic (`chunk-###` from source order).
- Low-confidence routing rules must be deterministic (same input => same OCR flag/path).
- Run-bundle base files are fixed: `manifest,timeline,tool-io,artifacts,citations`; DBOS snapshots are additive (`workflow_status`,`operation_outputs`).
- Bundle JSON is canonical/stable/newline-terminated; diff noise is a bug.
- Normalize machine-variant fields (`createdAt`, bundle root/path context) before structural diff.
- Export must fail explicitly on unrecoverable source (`422 source_unrecoverable`), never synthesize fallback content.
- Bundle temp roots should be cleaned on server close by default; retention must be explicit opt-in.
- Golden updates are review events (`record` then `diff`), never blind regenerate.

# Failure Recipes

- Golden diff noisy on time/path only: fix normalization; do not loosen assertions.
- Cross-machine drift: enforce locale/timezone/path neutrality end-to-end.
- Missing/renamed artifact: preserve canonical IDs (`raw,docir,chunk-index,memo`) and update all consuming contracts in one change.
