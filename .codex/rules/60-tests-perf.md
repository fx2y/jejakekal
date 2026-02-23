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
- Behavior delta must ship proof delta in the relevant lanes; tutorial/signoff is contract test, not demo theater.
- Replay/idempotency lanes are release-contract lanes, never optional.
- Freeze `Date.now` + `Math.random` in deterministic workflow suites; timeout math uses monotonic clock.
- DB-reset shared lanes (workflow/replay/idempotency and similar mutable integration suites) are not parallel-safe; run with `--test-concurrency=1` unless isolation model changes.
- Perf budgets are correctness caps; bench outputs must be stable machine-readable artifacts.
- Perf gates measure real paths (not synthetic sleep/no-op stand-ins) and expose metric provenance/breakdown.
- Benchmark fixtures/setup must be deterministic (reset scratch dirs, fixed corpus, warmup discipline) before timing loops.
- FTS metrics must reflect real normalize+index/query work (`fts_ingest_ms`, `fts_query_p95_ms`), not parser timing proxies.
- Golden drift is a review event; no blind re-record.
- Truth-leak guardrails (e.g. answer-text token bans) target production surfaces, not tests/docs/specs.

# Living-Spec Enforcement

- New failure mode: reproduce with failing test first.
- After fix: append durable law/constraint to `spec-*/00-learnings.jsonl`.
- After fix: append execution/proof evidence to active task log (`spec-*/01-tasks.jsonl` or cycle task file like `spec-0/04-tasks.jsonl`).
- After fix: update tutorial log when operator flow/triage/signoff changes (`spec-*/**/*tutorial.jsonl`).
- After fix: update `AGENTS.md` and/or scoped rules when policy changed or generalized.
- Stop on first invariant break during signoff/tutorial runs; continue only after triage path is recorded.

# Failure Recipes

- Flake: usually missing freeze, hidden env dependency, or shared mutable state.
- Bench check missing keys: bench producer/schema drift; fix emitter before threshold tuning.
- Bench false-red: calibrate to stable real-path baseline, not transient warm/cold outliers.
- Tests pass but regression escaped: contract assertions too weak; strengthen invariants, not snapshots.
