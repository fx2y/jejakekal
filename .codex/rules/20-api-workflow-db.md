---
description: API/workflow/DB truth, durability, compat, and security contracts.
paths:
  - apps/api/src/**
  - apps/api/test/**
  - infra/sql/**
---

# API/Workflow/DB Rules

- Runtime truth is DBOS (`dbos.workflow_status`,`dbos.operation_outputs`) plus persisted tables (`artifact`,`doc`,`doc_ver`,`block`); projections must honor DBOS serialization quirks + `function_id` order (0-based).
- Canonical API surface: `/runs*` + `/artifacts*` + `/healthz`; no `/api/*` resurrection.
- `/runs*` removal blocked before `2026-06-30`; later requires migration proof.
- Security boundaries: parse raw pathname first; decode+allowlist validate `run_id`/`artifact_id`/`workflowId`; reject traversal/encoding tricks.
- Trust-domain split is mandatory: request parser faults are typed `4xx`; persisted-row parse faults are opaque invariant `5xx`.
- Start normalize order: canonical `{intent,args}` -> slash `cmd` parser -> compat `{source}`; never synthesize default source.
- Slash parser support is scoped to source ingestion; non-source commands (`/run`,`/open`, etc.) fail typed `invalid_command` on `/runs` lane.
- Legacy `{source}` is date-gated by `ALLOW_SOURCE_COMPAT_UNTIL` (default `2026-06-30`) with explicit compat telemetry; post-window => typed `source_compat_expired`.
- `workflowId` dedup claim stores normalized payload hash of canonical `{intent,args}` only; payload mismatch => `409 workflow_id_payload_mismatch`; exec controls (`sleepMs`,`useLlm`) must not perturb claim hash.
- Run projection keeps frozen keys (`run_id,status,dbos_status,header,timeline`); enrichment is additive only.
- Typed `4xx` for client faults; opaque server errors for invariant/runtime faults; never leak internals.

# Durability / Concurrency / Effects

- External effects must pass `callIdempotentEffect(effect_key, ...)` with per-key serialization + PG advisory xact lock.
- Ingest ext-effects (raw/parse/memo blob writes etc.) require deterministic effect-key composition (`workflow|step|doc|ver|sha`-class inputs) and replay cached response on forced retry.
- DBOS startup is serialized across processes: advisory lock around `DBOS.launch`; tolerate one retry on `dbos_migrations_pkey` duplicate-key race.
- DB/schema/projection behavior deltas ship replay/idempotency proofs in same change.

# Data/State Invariants

- Artifact rows are append-only; supersede via new row (`supersedes_id`), never UPDATE/DELETE.
- Workflow terminal success requires persisted artifact count `>=1` (`FAILED_NO_ARTIFACT`).
- Chat ledger stores command envelope only (`cmd,args,run_id`); deterministic key/hash + conflict-ignore semantics.
- Artifact list/detail/provenance digests must agree; additive `sha256` on list items must reflect persisted truth (never `null` when stored).
- `reserve-doc` / doc-ledger identity is deterministic (`raw_sha` -> stable `doc_id`; tx ver allocation); conflict mismatches are hard failures.
- FTS is internal-only: materialize `block.tsv` (`to_tsvector(...)`) + GIN index; no public route leak without explicit contract change.
- Resume endpoint is fail-closed: non-resumable statuses => typed `409 run_not_resumable`.

# Failure Recipes

- Hostile ID probe false-negative: retry with `curl --path-as-is`.
- Duplicate effect observed: audit effect-key composition + lock path + retry cache path.
- Embedded/UI API startup fails with `dbos_migrations_pkey`: verify cross-process startup lock path and no double boot on same DBOS DB.
- Timeline/order mismatch: compare projection order to DBOS `function_id` sequence.
- Seaweed `store-raw` auth failure: bootstrap S3 IAM keypair, then `mise run reset` before proofs.
