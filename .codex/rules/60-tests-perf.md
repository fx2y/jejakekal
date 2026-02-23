---
description: Proof layering, determinism discipline, perf/golden gates, living-spec capture.
paths:
  - "**/*.test.mjs"
  - scripts/bench-*.mjs
  - scripts/lint.mjs
  - spec-*/00-learnings.jsonl
  - spec-*/01-tasks.jsonl
  - spec-*/02-tutorial.jsonl
  - spec-*/03-tasks.jsonl
  - spec-*/03-tutorial.jsonl
---

# Test/Perf Rules

- Mandatory proof ladder: `unit -> workflow/replay/idempotency -> pipeline/sandbox/ui -> golden -> perf -> ci`.
- Behavior delta must ship matching proof delta in relevant lanes.
- Replay/idempotency lanes are release-contract lanes, never optional.
- Freeze `Date.now` + `Math.random` in deterministic workflow suites; timeout math uses monotonic clock.
- DB-reset shared lanes (workflow/replay/idempotency) are not parallel-safe unless isolation model changes.
- Perf budgets are correctness caps; bench outputs must be stable machine-readable artifacts.
- Benchmark fixtures/setup must be deterministic (reset scratch dirs, fixed input corpus) before timing loops.
- Golden drift must be reviewed for structural intent; no blind re-record.
- Truth-leak guardrails (e.g. `assistantAnswer` token lint) must target production code surfaces, not tests/docs/specs.

# Living-Spec Enforcement

- New failure mode: reproduce with failing test first.
- After fix, update `spec-*/00-learnings.jsonl` (durable decisions/constraints).
- After fix, update active tasks log (`spec-*/01-tasks.jsonl` or cycle file like `spec-0/03-tasks.jsonl`).
- After fix, update tutorial log when operator flow changed (`spec-*/02-tutorial.jsonl` or `spec-0/03-tutorial.jsonl`).
- After fix, update `AGENTS.md` and/or scoped rules for policy deltas.

# Failure Recipes

- Flake: usually missing freeze or hidden nondeterministic dependency.
- Bench check missing keys: upstream bench producer failed to emit expected schema.
- Bench false-red on ingest p50: calibrate threshold to stable marker-subprocess baseline; avoid caps below measured steady-state median.
- Tests pass but regression escaped: contract assertions are weak; strengthen invariants.
