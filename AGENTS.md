# Jejakekal Policy SoT

Repo constitution for humans+agents. Default posture: deterministic, fail-closed, additive, replay-safe.

## Precedence (hard)

- `AGENTS.md` = repo policy SoT; `.codex/rules/*` = scoped enforcement; `spec-*` logs = durable decisions/evidence.
- If conflict: stricter rule wins; otherwise preserve stable public contract and fail closed.

## Memory SoT (hard)

- Exactly one git-tracked repo-root memory file: `AGENTS.md`.
- `CONTRIBUTING.md` / `HARNESS.md` are summaries only.
- Private/operator prefs live in untracked `AGENTS.local.md`.

## Command SoT (hard)

- Bootstrap: `mise install`.
- Dev loop: `mise watch verify` (or narrower watch task).
- Dev gate: `mise run verify`.
- Release verdict: `mise run ci` only (local + CI).
- Stack ops: `mise run up|down|reset|psql`.
- Readiness gate before first probes: `mise run wait:health -- <url> [timeoutMs intervalMs]`.
- Behavior gates: `mise run ui:e2e`, `mise run golden:record && mise run golden:diff`, `mise run bench:check`, `mise run smoke:ingest`.
- Seaweed filer host-port override is paired and sticky across gates: set both `SEAWEED_FILER_PORT` and `BLOB_FILER_ENDPOINT` (never one-only).

## Product/API Laws (hard)

- Runtime truth = DBOS tables (`dbos.workflow_status`,`dbos.operation_outputs`) + persisted artifact/doc-ledger rows; no shadow truth.
- Canonical public API = `/runs*` + `/artifacts*` + `/healthz`; `/api/*` resurrection forbidden.
- `/runs*` removal forbidden before `2026-06-30`; later removal requires explicit migration proof.
- Start payload migration is explicit/time-boxed: canonical `{intent,args}`; compat `{source}` only until `ALLOW_SOURCE_COMPAT_UNTIL` (default `2026-06-30`); no default-source synthesis.
- `POST /runs` may parse slash `cmd`, but non-source commands (e.g. `/run`,`/open`) are invalid on ingest lane.
- `workflowId` is strict dedup key; claim hash scope = canonical `{intent,args}` only (exclude exec controls like `sleepMs`,`useLlm`); mismatch => `409 workflow_id_payload_mismatch`.
- Run projection frozen keys: `run_id,status,dbos_status,header,timeline`; additive fields only.
- Artifact vocab frozen: `raw,docir,chunk-index,memo` (`chunk-index` spelling only).
- Chat plane is control ledger only (`cmd,args,run_id`); answer-text storage/rendering is contract violation.

## Correctness Doctrine (hard)

- Determinism > convenience > speed.
- Canonical pipeline shape: `parse -> validate -> normalize -> pure transform -> effect adapter -> canonical projection`.
- Core is pure/replayable; effects live at boundaries only.
- Fail closed: typed `4xx` for client faults; opaque `internal_error` / invariant `5xx` for server faults; never synthesize fallback truth.
- Exactly-once-effective ext IO only via `callIdempotentEffect(effect_key, ...)` (per-key serialization + PG advisory lock).
- Durability mandatory: checkpointed steps, replay-safe resume from last completed step.
- Startup concurrency is correctness: serialize DBOS init across processes (PG advisory lock around `DBOS.launch`).
- Security boundaries are hard: raw-path hostile parsing, decode+allowlist IDs, resolve-under-root exports.
- Perf budgets are correctness caps (not aspirational hints).

## Artifact/Blob/Bundle Laws (hard)

- Artifact truth is persisted rows; detail/download/export/bundle are persisted-first readers.
- Artifact rows append-only; supersede via new row (no UPDATE/DELETE mutation path).
- Workflow terminal success requires persisted artifact count `>=1` (`FAILED_NO_ARTIFACT` on zero).
- Provenance boundary = IDs/hashes only; no raw source/content text.
- Blob URI schemes are allowlisted (`bundle://`,`s3://`); request parsing vs persisted-row parsing use different trust domains (client error vs opaque invariant error).
- Persisted blob consumers must read from `uri` and verify stored `sha256`; unreadable/mismatch/bad sha => opaque `5xx`.
- JSON artifact detail decode is strict; parse failure => opaque `5xx`.
- Bundle transport is additive deterministic: `/runs/:id/bundle` + `/runs/:id/bundle.zip` byte-stable.
- Bundle manifest time pins to run header `created_at` when present; default blob root is stable repo cache (`.cache/run-bundles`); cleanup-on-close is explicit opt-in.

## UI/Host Laws (hard)

- Plane IDs are product API: `#conversation-plane`, `#execution-plane`, `#artifact-plane`; aliases `#conv/#exec/#artifacts` are wrappers only.
- Run-status FSM is strict: `#run-status[data-state]=idle|running|done|error`; unknown backend status => terminal `error`.
- API host returns JSON truth; UI host returns HTML docs/fragments; non-HX or HX-history-restore on UI host renders full shell.
- Poll truth path is `/ui/runs/:id/poll`; response carries atomic OOB updates for `#exec,#artifacts,#run-status`.
- Resume control is explicit/fail-closed: show+allow only for `CANCELLED|RETRIES_EXCEEDED`.
- UI startup mode is explicit: embedded API default; split mode=`UI_EMBED_API=0` with shared `API_PORT` proxy (no double-bind).
- UI error boundary preserves host split: UI routes render HTML on opaque errors; JSON `internal_error` is for proxied API paths only.

## Living-Spec Loop (mandatory per behavior delta)

- Ship proof with change (tests and/or golden and/or perf).
- Update `spec-*/00-learnings.jsonl` with durable laws only (not transient execution noise).
- Update active task log (`spec-*/01-tasks.jsonl` or cycle file e.g. `spec-0/04-tasks.jsonl`) with execution/proof evidence.
- Update tutorial log when UX/ops flow changes (e.g. `spec-0/04-tutorial.jsonl`).
- New failure mode => new/updated `.codex/rules/*` in same change.
- Treat tutorial/signoff as contract test, not demo; stop on first invariant break.
- Behavior-changing PR without proof + log updates is incomplete.

## Triage First Moves

- PG/stack unhealthy: `mise run up && mise run reset`.
- Stack state unclear: `docker compose -f infra/compose/docker-compose.yml ps --format json | jq -s` (verify PG mount `/var/lib/postgresql`).
- Early boot probe noise: gate with `mise run wait:health -- <url>` before API/UI checks.
- Host `:8888` busy: use paired `SEAWEED_FILER_PORT` + `BLOB_FILER_ENDPOINT` across `up|reset|verify|ci`.
- Seaweed S3 `InvalidAccessKeyId|AccessDenied`: bootstrap IAM keypair, then rerun `mise run reset`.
- Replay/idempotency flake: audit `Date.now`/`Math.random` freezes, checkpoint boundaries, effect-key composition, lock path.
- Hostile-path false negatives: use `curl --path-as-is`.
- Export anomaly: missing/tampered blob => expected opaque `5xx`; missing prepare source with persisted rows may still export `200`.
- Embedded/UI API startup `dbos_migrations_pkey` duplicate: inspect DBOS startup lock path before retrying.
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
