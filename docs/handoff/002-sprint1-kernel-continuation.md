# 002 - Sprint1 Kernel Continuation (DBOS `/runs`)

## 0. Read This First (non-negotiable)
- Source of truth: `AGENTS.md` + `.codex/rules/*.md` + `spec-0/00-learnings.jsonl` + `spec-0/02-*.jsonl` + `spec-0/02/*.jsonl`.
- Release verdict path is single-command only: `mise run ci`.
- Canonical API is `/runs*` + `/healthz`; no `/api/*` resurrection.
- Workflow truth is DBOS tables only: `dbos.workflow_status`, `dbos.operation_outputs`.
- Side effects only via `callIdempotentEffect(effect_key, ...)`.
- Run bundle contract frozen: base v0 files + additive `workflow_status.json` + `operation_outputs.json`.
- UI contract frozen: `#conversation-plane #execution-plane #artifact-plane #run-status[data-state]`.

## 1. Current System Snapshot (as implemented)
- API boot: `apps/api/src/server.mjs`.
- DBOS runtime singleton: `apps/api/src/dbos-runtime.mjs`.
- DBOS workflow defs: `apps/api/src/dbos-workflows.mjs`.
- Canonical runs routes: `apps/api/src/runs-routes.mjs`.
- Start/payload/dedup service: `apps/api/src/runs-service.mjs`.
- DBOS->API projection/mapping: `apps/api/src/runs-projections.mjs`.
- Export assembler: `apps/api/src/export-run.mjs`.
- ID boundary guard: `apps/api/src/run-id.mjs`.
- Typed client errors: `apps/api/src/request-errors.mjs`.
- UI fetch/poll client: `apps/ui/src/api-client.mjs`.
- UI render FSM/timeline/artifacts: `apps/ui/src/render-execution.mjs`, `apps/ui/src/app.mjs`.
- UI+API co-run server/proxy: `apps/ui/src/server.mjs`.
- Determinism helper: `packages/core/src/determinism.mjs`.
- Close-once helper: `packages/core/src/once-async.mjs`.
- Run bundle canonicalizer: `packages/core/src/run-bundle.mjs`.
- Sandbox contract: `packages/core/src/sandbox-runner.mjs`.
- Pipeline quartet producer: `packages/pipeline/src/ingest.mjs`.

## 2. What Is Already Closed (from learnings/tasks/tutorial)
- P0 hostile run-id/path traversal closed (`invalid_run_id` 400).
- P0 exactly-once-effect race closed (per-key serialize + advisory lock).
- P0 malformed JSON contract closed (`invalid_json` 400).
- P0 workflowId mismatch aliasing closed (`workflow_id_payload_mismatch` 409).
- P1 source fallback removed; export hard-fails 422 `source_unrecoverable`.
- P1 UI long-poll cap fixed (adaptive timeout/backoff knobs).
- P1 ui:e2e port-collision fixed (ephemeral ports + fail-fast bind errors).
- P1 hostile probe determinism documented (`curl --path-as-is`).
- C5 compat prune done: `/api/*` removed from runtime surface.
- CI parity done: GH action runs `mise run ci` only.

## 3. Immutable Contracts You Must Preserve
### API contract
- `POST /runs` => `202` and `{run_id,status,dbos_status}`.
- `GET /runs/:id` => `200|404` and `{run_id,status,dbos_status,header,timeline}`.
- `GET /runs/:id/export` => `200|404|422` and previous keys + `artifacts` + `run_bundle_path`.
- `GET /healthz` => `{ok:true}`.

### Error contract
- Client faults are typed 4xx (`invalid_json`,`invalid_run_id`,`workflow_id_payload_mismatch`,`source_unrecoverable`).
- 500 is opaque/stable: `{error:"internal_error"}`.

### UI contract
- IDs fixed: `conversation-plane execution-plane artifact-plane run-status timeline artifacts`.
- FSM fixed: `idle|running|done|error` only.
- Terminal unknown backend status must surface as error, not infinite running.

### Artifact/bundle contract
- Artifact IDs fixed: `raw docir chunk-index memo`.
- Bundle files fixed:
  - `manifest.json`
  - `timeline.json`
  - `tool-io.json`
  - `artifacts.json`
  - `citations.json`
  - `workflow_status.json`
  - `operation_outputs.json`
- JSON canonicalized/newline-terminated; normalized root/time for diff.

## 4. Operational Loop (copy/paste)
### Bootstrap
```bash
mise install
mise run up
mise run reset
```

### Fast inner loop
```bash
mise watch verify
# or one-shot:
mise run verify
```

### Full release gate
```bash
mise run ci
```

### Stack triage
```bash
# health shape
docker compose -f infra/compose/docker-compose.yml ps --format json | jq -s
# db shell (containerized only)
mise run psql -- -c "select now();"
```

## 5. API Walkthroughs (high-signal)
### A. Happy path `/runs -> poll -> export`
```bash
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
RID=$(curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{"source":"alpha\nbeta [low]\ngamma","sleepMs":300}' | jq -r '.run_id')
while :; do R=$(curl -sS http://127.0.0.1:4010/runs/$RID); S=$(jq -r '.status'<<<"$R"); [[ "$S" == done || "$S" == error || "$S" == unknown ]] && break; sleep 0.05; done
curl -sS http://127.0.0.1:4010/runs/$RID/export | jq '{run_id,status,dbos_status,artifacts:(.artifacts|map(.id)),run_bundle_path}'
```
Expect:
- terminal typically `done/SUCCESS`.
- artifact IDs exact `["raw","docir","chunk-index","memo"]`.

### B. Hostile path probes (must use raw path)
```bash
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{'
curl --path-as-is -sS -i http://127.0.0.1:4010/runs/%2E%2E
curl --path-as-is -sS -i http://127.0.0.1:4010/runs/..%2Fx/export
```
Expect:
- first => `400 invalid_json`
- others => `400 invalid_run_id`

### C. Dedup mismatch guard
```bash
WF=wf-dedup-$RANDOM
curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d "{\"source\":\"one\",\"workflowId\":\"$WF\",\"sleepMs\":5}" >/dev/null
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d "{\"source\":\"two\",\"workflowId\":\"$WF\",\"sleepMs\":5}"
```
Expect `409 workflow_id_payload_mismatch`.

### D. DB truth proof
```bash
mise run psql -- -c "select workflow_uuid,status,name,recovery_attempts,executor_id from dbos.workflow_status where workflow_uuid='${RID}';"
mise run psql -- -c "select function_id,function_name,started_at_epoch_ms,completed_at_epoch_ms from dbos.operation_outputs where workflow_uuid='${RID}' order by function_id asc;"
```

## 6. Durability/Idempotency Walkthroughs
### Kill9 resume (automated proof lane)
```bash
mise run test:replay
```
Asserts:
- SIGKILL mid-run, restart, run reaches terminal.
- completed steps not duplicated (`prepare` once, `DBOS.sleep` once).

### Durable-start semantics
Included in `apps/api/test/replay.integration.test.mjs`:
- kill immediately after POST response.
- restart.
- run still completes.

### Effect exactly-once under concurrency
```bash
mise run test:idempotency
```
Asserts:
- two concurrent same key calls execute effect fn once.
- one side_effects row for effect key.

### Retry/backoff provenance
In replay suite:
- `flakyRetryWorkflow` uses DBOS retry config in step options.
- no manual retry loop.

## 7. UI Walkthroughs
### Manual showcase (PO loop)
```bash
API_PORT=4010 UI_PORT=4110 mise x node@24.13.1 -- node apps/ui/src/server.mjs
# open http://127.0.0.1:4110/?sleepMs=250
```
Check:
- 3 planes visible.
- run-status transitions `idle -> running -> done`.
- timeline shows DBOS function rows (`prepare`,`DBOS.sleep`,`side-effect`,`finalize`).
- artifacts list canonical IDs.

### E2E lane
```bash
mise run ui:e2e
```
Current assertions in `apps/ui/test/e2e.spec.mjs`:
- selectors + state machine only.
- no screenshot/pixel coupling.
- long-run poll stability via URL params.

## 8. Where To Extend (safe seams)
### Add new workflow step
1. Implement step fn in `apps/api/src/dbos-workflows.mjs`.
2. Keep nondeterminism/I-O inside step fn, never workflow body.
3. Name step explicitly (`{ name: '...' }`), treat name as durable ID.
4. If external side effect: wrap with `callIdempotentEffect`.
5. Add proof in `apps/api/test/workflow.integration.test.mjs` and possibly replay/idempotency suite.

### Add run payload field
1. Parse/normalize in `normalizeRunStartPayload` (`apps/api/src/runs-service.mjs`).
2. Include in payload-hash if dedup semantics should bind it.
3. Keep backward compatible defaults.
4. Add negative/contract tests (bad type, mismatch conflict behavior).

### Add export field/file
1. Keep existing file names stable.
2. Add only additive file under `extraJsonFiles` in `apps/api/src/export-run.mjs`.
3. Preserve canonical JSON via `writeRunBundle`.
4. Add export reconstruction test.

### Add UI data
1. Fetch from API payload only.
2. Keep IDs/FSM unchanged.
3. Update `render-execution.mjs` only; avoid side-channel inference.
4. Update Playwright assertions minimally.

## 9. Failure-First Triage Map
- PG unavailable:
  - `mise run up && mise run reset`
- Health timeout:
  - `docker compose -f infra/compose/docker-compose.yml ps --format json | jq -s`
  - verify PG volume mount is `/var/lib/postgresql`.
- Hostile traversal appears 404:
  - use `curl --path-as-is`.
- Replay flake:
  - confirm deterministic freeze in test.
  - confirm unique workflow IDs in helpers.
  - inspect `dbos.operation_outputs` ordering.
- Duplicate side effect:
  - inspect effect key composition and lock path in `apps/api/src/effects.mjs`.
- ui:e2e startup timeout:
  - check bind errors surfaced by `listenLocal`; ensure no custom hardcoded port in test.
- Golden drift:
  - run `mise run golden:diff`.
  - review structural intent before `golden:record`.

## 10. Known Sharp Edges / Debt
- `infra/sql/seed.sql` references `workflow_events` (legacy table removed). Do not run blindly until aligned.
- `runs-service` default source fallback (`'default doc'`) still exists for missing/non-string source. Policy bias is fail-closed; evaluate if this should become typed 4xx in next change.
- `readJsonRequest` returns `{}` for empty body; currently tolerated. If contract should require explicit fields, enforce in service validator with typed 4xx.
- Perf scripts are synthetic micro-bench scaffolds; keep contract keys stable if replacing with realistic probes.

## 11. Spec-Loop Discipline For Any Behavior Delta
In same PR/change:
1. proof delta (test and/or golden and/or perf).
2. append durable decision/constraint in `spec-0/00-learnings.jsonl`.
3. append/update execution line in `spec-0/02-tasks.jsonl`.
4. if operator flow changed, update `spec-0/02-tutorial.jsonl`.
5. if new failure mode emerged, add rule in `.codex/rules/*`.

## 12. Minimal Command Deck (daily)
```bash
# start day
mise install && mise run up && mise run reset

# dev loop
mise watch verify

# targeted proofs
mise run test:workflow
mise run test:replay
mise run test:idempotency
mise run ui:e2e

# release verdict
mise run ci
```

## 13. File Map (when debugging fast)
- route parse + id validation: `apps/api/src/runs-routes.mjs`, `apps/api/src/run-id.mjs`
- typed request errors: `apps/api/src/request-errors.mjs`
- payload normalization/dedup claim: `apps/api/src/runs-service.mjs`
- dbos workflow step config: `apps/api/src/dbos-workflows.mjs`
- projection mismatch/status mapping: `apps/api/src/runs-projections.mjs`
- bundle/export mismatch: `apps/api/src/export-run.mjs`, `packages/core/src/run-bundle.mjs`
- close/lifecycle hangs: `apps/api/src/server.mjs`, `apps/ui/src/server.mjs`, `packages/core/src/once-async.mjs`
- replay/kill harness: `apps/api/test/helpers.mjs`, `apps/api/test/replay.integration.test.mjs`
- ui contract break: `apps/ui/src/index.html`, `apps/ui/src/render-execution.mjs`, `apps/ui/test/e2e.spec.mjs`

## 14. Bottom Line
Treat this repo as contract-first kernel, not feature playground. If a change cannot be proven through DBOS truth, typed API semantics, deterministic export diff, and `mise run ci` parity, it is not done.
