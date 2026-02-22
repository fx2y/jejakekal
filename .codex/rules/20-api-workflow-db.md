---
description: API/workflow durability + DB invariants.
paths:
  - apps/api/src/**
  - apps/api/test/**
  - infra/sql/**
---

# Workflow/DB Rules

- Workflow semantics are durability-first: checkpoint each completed step; resume emits `resume-skip` for completed steps.
- Step names are stable IDs; renaming is a data migration, not refactor trivia.
- Side effects must route through `callIdempotentEffect`; effect key schema: `workflowId:step:suffix`.
- Event log is append-only behavioral evidence (`start`, `completed`, `resume-skip`).
- DB schema changes require replay/idempotency test updates in same change.
- API `/api/run` must return machine-usable `workflowId`, `timeline`, `artifacts`; preserve contract keys.

# Determinism Rules

- Freeze clock/random in workflow tests whenever behavior depends on either.
- Crash/resume tests must force crash at named step, then prove continuation from checkpoint.
- Duplicate trigger tests must prove single side-effect row for same workflow key.

# Failure Recipes

- Replayed step executed twice: verify checkpoint query and conflict upsert keys.
- Duplicate external effect: inspect effect key composition; ensure wrapper call site used.
- Timeline count mismatch: inspect workflow_events insert order and resume-skip logging.
- DB test skipped: stack not up; run `mise run up` + `mise run reset`.
