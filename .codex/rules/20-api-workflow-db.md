---
description: API/workflow/DB truth, security, durability contracts.
paths:
  - apps/api/src/**
  - apps/api/test/**
  - infra/sql/**
---

# API/Workflow/DB Rules

- Workflow truth is DBOS tables (`dbos.workflow_status`,`dbos.operation_outputs`); projections must honor DBOS quirks (`function_id` 0-based, serialized envelopes).
- Canonical API is `/runs*` + `/artifacts*` + `/healthz`; forbid `/api/*` resurrection.
- `/runs*` removal blocked before `2026-06-30`; later removal requires explicit migration proof.
- `run_id`/`artifact_id`/`workflowId` are security boundaries: parse raw pathname, decode+allowlist validate, reject traversal.
- `workflowId` dedup is strict: persist normalized payload hash claim; mismatch => `409 workflow_id_payload_mismatch`.
- Start payload normalize order: canonical `{intent,args}` -> optional slash `cmd` -> compat `{source}` (time-boxed); never default-source synthesis.
- Run projection keeps frozen keys (`run_id,status,dbos_status,header,timeline`); additive fields only.
- Typed `4xx` for client faults; opaque `internal_error` for server faults; never leak internals.
- External effects must go through `callIdempotentEffect(effect_key, ...)` with per-key serialization + PG advisory xact lock.
- DB/schema/projection behavior deltas must ship replay/idempotency proofs in same change.

# Runtime/State Invariants

- Artifact rows are append-only; no UPDATE/DELETE mutation path.
- Workflow terminal success requires persisted artifact count `>=1`.
- Chat ledger stores command envelope only (`cmd,args,run_id`); deterministic dedup key (`run_id`,`cmd`,sorted `args`) with conflict-ignore semantics.
- Resume endpoint is fail-closed: non-resumable statuses return typed `409 run_not_resumable`.

# Failure Recipes

- Hostile ID probe false-negative: retry with `curl --path-as-is`.
- Duplicate effect observed: audit effect-key composition + lock path.
- Timeline/order mismatch: compare API projection to DBOS `function_id` order.
- `store-raw` S3 `InvalidAccessKeyId|AccessDenied`: bootstrap Seaweed IAM key via `weed shell ... s3.configure -access_key=any -secret_key=any -apply`, then rerun `mise run reset` before proofs.
