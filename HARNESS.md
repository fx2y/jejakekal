# Harness Task Tree

- `mise run verify`: lint + typecheck + unit + workflow tests.
- `mise run ci`: full parity gate (replay, idempotency, pipeline, sandbox, golden, bench).
- `mise run up/down/reset/psql`: local stack lifecycle.
- `mise run golden:record` then `mise run golden:diff`: artifact regression control.
- `mise run ui:e2e`: 3-plane product promise e2e.
- `mise run bench:check`: enforce perf/cost budgets from `spec-0/budgets.json`.
