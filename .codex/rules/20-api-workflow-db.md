---
description: API/workflow durability + DB invariants.
paths:
  - apps/api/src/**
  - apps/api/test/**
  - infra/sql/**
---

# Workflow/DB Rules

- Workflow state truth is DBOS system tables: `dbos.workflow_status` + `dbos.operation_outputs`.
- Step names are stable IDs; renaming is a data migration, not refactor trivia.
- Side effects must route through `callIdempotentEffect`; effect key schema: `workflowId:step:suffix`.
- API contract is canonical `/runs*`; avoid reintroducing legacy `/api/*` compatibility paths.
- DB schema changes require replay/idempotency test updates in same change.
- API payload keys are stable contracts (`run_id`, `status`, `dbos_status`, `header`, `timeline`, export `run_bundle_path` + `artifacts`).

# Determinism Rules

- Freeze clock/random in workflow tests whenever behavior depends on either.
- Crash/resume tests must force OS-signal kill and prove continuation without duplicate completed steps.
- Duplicate trigger tests must prove single side-effect row for same workflow key.

# Failure Recipes

- Replayed step executed twice: inspect `dbos.operation_outputs` ordering/counts and workflow ID reuse path.
- Duplicate external effect: inspect effect key composition; ensure wrapper call site used.
- Timeline count mismatch: inspect `/runs/:id` projection mapping from `function_id/function_name`.
- DB test skipped: stack not up; run `mise run up` + `mise run reset`.
