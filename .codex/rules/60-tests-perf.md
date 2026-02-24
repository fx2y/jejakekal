---
description: Proof layering, determinism, perf/golden gates, and living-spec capture.
paths:
  - "**/*.test.mjs"
  - scripts/bench-*.mjs
  - scripts/lint.mjs
  - spec-*/00-learnings.jsonl
  - spec-*/01-tasks.jsonl
  - spec-*/**/*tasks.jsonl
  - spec-*/**/*tutorial.jsonl
---

# Test / Perf Rules

- Mandatory proof ladder: `unit -> workflow/replay/idempotency -> pipeline/sandbox/ui -> golden -> perf -> ci`.
- Behavior deltas must ship matching proof deltas in affected lanes.
- Replay/idempotency are release-contract lanes, never optional.
- Freeze deterministic clocks/random (`Date.now`,`Math.random`) in replay-sensitive suites; timeout math uses monotonic clocks.
- Shared DB-reset integration lanes are sequential (`--test-concurrency=1`) unless proven isolated.
- Perf budgets are correctness caps; benchmark outputs must be stable machine-readable artifacts.
- Perf lanes must measure real paths (no synthetic sleep/no-op stand-ins) with provenance.
- OCR perf metrics are required keys: `ocr_gate_ms`,`ocr_page_p95_ms`,`ocr_merge_ms`,`ocr_wall_ms` (missing key = fail).
- FTS metrics must reflect real normalize+index/query work (`fts_ingest_ms`,`fts_query_p95_ms`).
- Golden drift is review-required; no blind re-record.
- Signoff is machine-checked contract evidence, not demo theater.
- Truth-leak checks target prod surfaces (not tests/docs/specs).

# Living-Spec Enforcement

- New failure mode workflow: reproduce with failing test first.
- After fix: append durable law/constraint to `spec-*/00-learnings.jsonl`.
- After fix: append execution/proof evidence to active tasks log (`spec-*/01-tasks.jsonl` or cycle tasks file).
- After fix: update tutorial log for UX/ops/signoff flow deltas.
- Policy/generalization changes must update `AGENTS.md` and/or scoped rules in same patch.
- Tutorial/signoff runs stop at first invariant break; proceed only after triage path is recorded.

# Failure Recipes

- Flake root causes: missing freeze, hidden env dependency, shared mutable state.
- Bench missing keys: producer/schema drift; fix emitter before threshold tuning.
- Bench false-red: recalibrate against stable real-path baseline, not warm/cold outliers.
- Regression escaped with green tests: strengthen invariant assertions, not snapshot volume.
