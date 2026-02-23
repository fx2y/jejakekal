# Jejakekal Policy SoT

Repo constitution for humans+agents. Default posture: deterministic, fail-closed, additive.

## Memory SoT (hard)

- Exactly one git-tracked repo-root memory file: `AGENTS.md`.
- `CONTRIBUTING.md`/`HARNESS.md` are summaries only.
- Private/operator prefs live in untracked `AGENTS.local.md`.

## Command SoT (hard)

- Bootstrap: `mise install`.
- Inner loop: `mise watch verify` (or narrower watch task).
- Dev gate: `mise run verify` (`lint`,`typecheck`,`test:unit`,`test:workflow`).
- Release verdict: `mise run ci` only.
- Stack ops: `mise run up|down|reset|psql`.
- Readiness gate: `mise run wait:health -- <url> [timeoutMs intervalMs]` before first probes.
- Golden discipline: `mise run golden:record && mise run golden:diff`.
- UI behavior gate: `mise run ui:e2e`.
- Perf gate: `mise run bench:check`.
- CI parity: GH Action executes `mise run ci` only.

## Product Laws (hard)

- Runtime truth is DBOS tables: `dbos.workflow_status`, `dbos.operation_outputs`.
- Canonical API surface: `/runs*` + `/artifacts*` + `/healthz`; forbid `/api/*` resurrection.
- `/runs*` removal forbidden before **2026-06-30**; any later removal requires explicit migration proof.
- Start payload migration is explicit/time-boxed: canonical `{intent,args}`; compat `{source}` allowed only during window (target sunset **2026-06-30**); no default-source synthesis.
- `POST /runs` also accepts slash `cmd` parser; invalid/malformed inputs are typed `4xx`.
- `workflowId` is strict dedup key: payload-hash mismatch => `409 workflow_id_payload_mismatch`.
- Run projection frozen keys: `run_id,status,dbos_status,header,timeline`; additive fields only (e.g. `artifacts`).
- Artifact vocabulary is fixed: `raw,docir,chunk-index,memo` (`chunk-index` only spelling).
- Chat is control-plane ledger only (`cmd,args,run_id`); storing/rendering answer text is contract violation.

## Correctness Doctrine (hard)

- Determinism > convenience.
- Core pure; effects at boundaries.
- Required pipeline shape: `parse -> validate -> normalize -> pure transform -> effect adapter -> canonical projection`.
- Fail closed: broken invariants return typed client errors (`4xx`) or opaque server error (`internal_error`), never silent fallback synthesis.
- Exactly-once-effective side effects only via `callIdempotentEffect(effect_key, ...)` (per-key serialization + advisory lock).
- Durability mandatory: checkpointed steps, replay-safe recovery, crash-resume from last completed step.
- Security boundaries mandatory: raw-path hostile handling, decode+allowlist IDs, resolve-under-root exports.
- Perf budgets are correctness caps.

## Artifact/Bundle Law (hard)

- Artifact truth is persisted rows; export/bundle/detail/download are persisted-first readers.
- Artifact table is append-only; UPDATE/DELETE forbidden by policy (supersede via new row).
- Workflow success requires persisted artifacts (`FAILED_NO_ARTIFACT` on zero).
- Provenance payload is IDs+hashes only; no raw source/content text.
- Persisted blob consumers must read from `uri` and verify stored `sha256`; unreadable/mismatch => opaque `5xx`.
- JSON artifact detail decode is strict; parse failure => opaque `5xx`.
- Bundle transport is additive deterministic `/runs/:id/bundle` + `/runs/:id/bundle.zip` (byte-stable).
- Bundle manifest time pins to run header `created_at` when present.
- Default blob root is stable repo cache (`.cache/run-bundles`); cleanup-on-close is explicit opt-in, never default.

## UI/Host Law (hard)

- Plane IDs are product API: `#conversation-plane`, `#execution-plane`, `#artifact-plane`.
- Additive aliases `#conv/#exec/#artifacts` are wrappers only.
- Run-status FSM is strict: `#run-status[data-state]=idle|running|done|error`; unknown backend status => terminal `error`.
- API host (`/runs/:id`,`/artifacts/:id`) returns JSON truth; UI host returns HTML documents/fragments.
- Non-HX or HX-history-restore on UI host must render full shell.
- Poll truth path is `/ui/runs/:id/poll`; response carries OOB updates for `#exec,#artifacts,#run-status` atomically.
- Resume control is explicit/fail-closed: show+allow only for `CANCELLED|RETRIES_EXCEEDED`.
- UI startup mode is explicit: embedded API default; external split mode uses `UI_EMBED_API=0` with shared `API_PORT` proxy (no double-bind).
- UI boundary parity: typed API errors pass through; no internal-string leaks; invalid/not-found run routes never mask as idle.

## Living-Spec Loop (mandatory per behavior delta)

- Ship proof with change (test and/or golden and/or perf).
- Append durable decision/constraint to `spec-*/00-learnings.jsonl`.
- Append execution evidence to active tasks log (`spec-*/01-tasks.jsonl` or cycle file, e.g. `spec-0/03-tasks.jsonl`).
- Update operator tutorial log when UX/ops flow changes (e.g. `spec-0/03-tutorial.jsonl`).
- New failure mode => new/updated `.codex/rules/*` entry in same change.
- Behavior-changing PR without proof+log updates is incomplete.

## Triage First Moves

- PG unavailable: `mise run up && mise run reset`.
- Stack health unclear: `docker compose -f infra/compose/docker-compose.yml ps --format json | jq -s` (verify PG mount `/var/lib/postgresql`).
- Early boot probe noise: gate with `mise run wait:health -- <url>` before API/UI checks.
- Replay/idempotency flake: audit freeze (`Date.now`,`Math.random`), checkpointing, effect-key composition/lock path.
- Hostile-path false negatives: use `curl --path-as-is`.
- Export anomaly triage: missing/tampered blob => expected opaque `5xx`; missing `prepare` source with persisted rows => export still `200`.
- Golden drift: inspect structural intent; never blind re-record.
- CI/local mismatch: rerun only `mise run ci`; remove shadow command graphs.

## Imported Scoped Rules

@.codex/rules/00-global.md
@.codex/rules/10-tasking-ci.md
@.codex/rules/20-api-workflow-db.md
@.codex/rules/30-pipeline-bundle.md
@.codex/rules/40-sandbox.md
@.codex/rules/50-ui.md
@.codex/rules/60-tests-perf.md
