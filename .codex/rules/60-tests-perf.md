---
description: Test layering, determinism discipline, perf budgets, learning capture.
paths:
  - "**/*.test.mjs"
  - scripts/bench-*.mjs
  - scripts/bench-check.mjs
  - spec-*/budgets.json
  - spec-*/00-learnings.jsonl
  - spec-*/01-tasks.jsonl
---

# Test/Perf Rules

- Proof ladder is mandatory: `unit -> workflow/replay/idempotency -> pipeline/sandbox/ui -> golden -> perf`.
- Behavior delta in workflow/pipeline/sandbox/UI must ship matching proof delta.
- Replay/idempotency suites are contract lanes, never optional slow tests.
- Workflow tests that depend on time/random must freeze `Date.now` + `Math.random`; wait logic uses `performance.now`.
- Keep correctness fixtures minimal; large corpora belong to perf-only lanes.
- Perf budgets in `spec-*/budgets.json` are hard correctness caps.
- Bench producers must write stable metrics to `.cache/bench/*.json`.
- Shared DB reset path means replay/idempotency lanes must not run in parallel unless isolation model is redesigned.

# Living-Spec Enforcement (process)

- New bug pattern: reproduce with failing test first, then fix.
- After fix: log durable decision/constraint in `spec-*/00-learnings.jsonl`.
- Update execution ledger in `spec-*/01-tasks.jsonl` or active cycle task log (`spec-*/02-tasks.jsonl`).
- If operator flow changed, update tutorial/runbook log (`spec-*/02-tutorial.jsonl` when present).
- Policy/process deltas must land in `AGENTS.md` or scoped `.codex/rules/*` in same PR.

# Failure Recipes

- Flaky workflow tests: missing freeze or hidden nondeterministic dependency.
- Bench check missing metric: upstream `bench:*` task failed to emit expected keys.
- Golden passes but behavior regressed: assertions/schema too weak; tighten contract.
