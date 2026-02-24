---
description: API/workflow/DB truth, durability, compat, and security contracts.
paths:
  - apps/api/src/**
  - apps/api/test/**
  - infra/sql/**
---

# API/Workflow/DB Rules

- Runtime truth is DBOS (`workflow_status`,`operation_outputs`) + persisted app rows; no shadow orchestration truth.
- Canonical API surface is `/runs*`,`/artifacts*`,`/healthz`; `/api/*` resurrection forbidden.
- `/runs*` removal blocked before `2026-06-30`; post-window removal needs explicit migration proof.
- Path/ID boundary is hostile-first: parse raw path, then decode+allowlist `run_id`/`artifact_id`/`workflowId`.
- Trust split is strict: request-parse/client faults => typed `4xx`; persisted-row/invariant faults => opaque `5xx`.
- Start normalization order is frozen: canonical `{intent,args}` -> slash `cmd` -> compat `{source}`.
- Default-source synthesis is forbidden.
- Slash parser on ingest lane accepts source commands only; non-source intents/commands are canonical `400 invalid_command`.
- Compat `{source}` is date-gated by `ALLOW_SOURCE_COMPAT_UNTIL` (default `2026-06-30`); post-window => `400 source_compat_expired`.
- `workflowId` dedup hash scope is canonical `{intent,args}` only; control fields (`sleepMs`,`useLlm`,timeouts) do not affect hash; mismatch => `409 workflow_id_payload_mismatch`.
- Run projection frozen keys: `run_id,status,dbos_status,header,timeline`; enrichment additive-only.
- Default text lane function map is frozen `0..8`; OCR work must be additive branch steps (never renumber baseline).
- OCR client policy is optional but wired end-to-end on `/runs`; invalid policy yields typed `400`.
- OCR engine surface is C3-frozen to `vllm`; non-vllm rejected at config/start boundary.
- OCR persisted truth is first-class (`ocr_job`,`ocr_page`,`ocr_patch`,`docir_page_version`,`docir_page_diff`); runtime consumers read rows, not transient payloads.
- Control plane must not expose raw source text in timeline outputs.

# Durability / Concurrency / Effects

- External IO must pass `callIdempotentEffect(effect_key, ...)` with per-key serialization + PG advisory xact lock.
- Effect keys are deterministic and replay-stable (`workflow|step|doc|ver|sha`-class inputs); forced retry must reuse cached response.
- OCR page effect-key contract is frozen: `workflow|ocr-page|doc|ver|p<idx>|model|gate_rev|png_sha`.
- DBOS startup is cross-process serialized (advisory lock around `DBOS.launch`), tolerating one duplicate-key migration race retry.
- DB/schema/projection deltas must ship replay + idempotency proofs in same change.

# Data/State Invariants

- Artifact rows are append-only; supersede via new row only (`supersedes_id`).
- Artifact vocab write guard lives at insert boundary; unknown type is immediate reject.
- Workflow terminal success requires persisted artifact count `>=1` (`FAILED_NO_ARTIFACT`).
- Chat ledger stores command envelope only (`cmd,args,run_id`) with deterministic id/hash and conflict-ignore semantics.
- `reserve-doc` identity is deterministic (`raw_sha -> doc_id`, tx-safe version allocation); conflicts are hard failures.
- OCR gate/page invariants: sparse-safe canonical `page_idx`; render requires valid 1:1 rows for hard pages; malformed rows hard-fail.
- OCR merge invariant: apply only patched+changed gated pages; patchless gated pages are no-op, never delete-only.
- FTS is internal-only (`block.tsv` + GIN); public exposure requires explicit contract change.
- Resume endpoint is fail-closed: non-resumable statuses => typed `409 run_not_resumable`.

# Failure Recipes

- Hostile probe false-negative: retry using `curl --path-as-is`.
- Duplicate effects: audit key composition, lock path, retry cache readback.
- `dbos_migrations_pkey` at boot: verify DBOS launch lock path and eliminate double boot.
- Timeline/order drift: compare projection sequence to DBOS `function_id` order.
- Seaweed `store-raw` auth failures: bootstrap S3 IAM keys, run `mise run reset`, then rerun proofs.
