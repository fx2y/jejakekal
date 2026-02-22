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

- Ingest contract stays explicit: emit raw text, DocIR, chunk index, memo every run.
- Low-confidence routing (`[low]`/threshold) must deterministically trigger OCR-required flag.
- Chunk IDs/order are deterministic (`chunk-###` from page index); no random ordering.
- Run Bundle v0 file set is fixed: `manifest`, `timeline`, `tool-io`, `artifacts`, `citations`.
- Bundle JSON must be stable/canonical; diffs should represent behavior, not serialization noise.
- `manifest.createdAt` and machine-variant fields are normalized before structural diff.
- Golden baseline updates (`golden:record`) are intentional review events, never blind regen.

# Failure Recipes

- Golden diff noisy only on time/path: fix normalization, do not relax assertion scope.
- Cross-machine golden drift: enforce locale/timezone/path neutrality in manifest/payloads.
- Missing artifact in bundle: keep artifact IDs stable (`raw`, `docir`, `chunks`/`chunk-index`, `memo`) and update e2e/test contracts together.
