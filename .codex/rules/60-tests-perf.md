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

- Test pyramid is enforced by tasks: `test:unit` -> `test:workflow/replay/idempotency` -> pipeline/sandbox/ui -> golden/perf.
- Any behavior change touching workflow/pipeline/sandbox/UI must update the nearest proving test.
- Replay/idempotency suites are contract tests, not optional slow tests.
- Keep fixtures tiny for correctness tests; large corpora belong in perf-only runs.
- Perf budgets in `spec-*/budgets.json` are hard caps; exceed == failure.
- Bench metrics must be written to `.cache/bench/*.json` with stable key names.

# Living-Spec Enforcement (process)

- If new bug pattern appears: add/adjust failing test first, then fix.
- After fix, capture durable lesson in `spec-*/00-learnings.jsonl` (decision/constraint only).
- Move execution status in `spec-*/01-tasks.jsonl` (done/partial + evidence).
- Policy changes go to `AGENTS.md` or scoped `.codex/rules/*`; no undocumented conventions.

# Failure Recipes

- Flaky workflow test: missing determinism freeze or hidden nondeterministic dependency.
- Bench check fails on missing metric: ensure upstream `bench:*` tasks wrote expected JSON keys.
- Golden passes but behavior regressed: assertions too weak; tighten test or artifact schema.
