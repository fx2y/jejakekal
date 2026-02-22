---
description: API/workflow durability + DB invariants.
paths:
  - apps/api/src/**
  - apps/api/test/**
  - infra/sql/**
---

# Workflow/DB Rules

- DBOS tables are workflow truth: `dbos.workflow_status` + `dbos.operation_outputs`.
- Canonical sprint2 API surface is additive: `/runs*` + `/artifacts*` + `/healthz`; do not reintroduce `/api/*`.
- `run_id`/`workflowId` are security boundaries: raw-path parse, decode, allowlist validation, traversal rejection.
- Caller `workflowId` is strict dedup key: claim persisted payload hash; hash mismatch must return `409 workflow_id_payload_mismatch`.
- Payload contract keys are stable: `run_id,status,dbos_status,header,timeline`; export adds `artifacts,run_bundle_path`.
- Run start payload migration is explicit/time-boxed: legacy `{source}` accepts only via compat window, canonical target is `{intent,args}`, and default-source synthesis is banned.
- Step names/IDs are durable identifiers; renames require migration + proof.
- Server lifecycle contract: startup must fail-fast on bind errors; close paths must be idempotent/retryable and shutdown DBOS runtime cleanly.
- DB schema/projection changes require replay/idempotency proof updates in same PR.

# Determinism Rules

- Workflow tests touching behavior freeze `Date.now` + `Math.random`.
- Timeouts in frozen-clock suites must use monotonic clock (`performance.now`), never wall clock.
- Crash/resume tests must use real kill (`SIGKILL`) and prove no duplicate completed steps.
- Duplicate trigger/effect tests must prove exactly-once-effective side effect under concurrency.
- `callIdempotentEffect` usage is mandatory; implementation must serialize per key + lock (`pg_advisory_xact_lock`) before effect fn.

# Failure Recipes

- Replayed step ran twice: inspect `dbos.operation_outputs` order/count + workflow ID reuse.
- Duplicate external effect: inspect effect key composition, local serialization, advisory-lock path.
- Hostile ID probe gives false 404: retry with `curl --path-as-is` (avoid client normalization).
- Route-policy drift (`/runs*` vs `/artifacts*`): fix AGENTS + rules + learnings in the same change, never piecemeal.
- Timeline mismatch: verify projection mapping from DBOS `function_id/function_name` (0-based IDs, epoch-ms columns, serialized output envelope).
- DB suites failing/skipped: `mise run up && mise run reset`; ensure runtime shutdown in teardown for direct-DBOS tests.
