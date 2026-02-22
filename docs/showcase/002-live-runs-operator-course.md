# 002 - Live `/runs` + `/artifacts` Operator Course (Sprint2 UX)

## Why this exists
You are not validating "a demo". You are validating a kernel contract: durable async runs, DBOS truth projection, deterministic export, strict typed failures, and release-gated proof.

## Non-negotiables
- API surface: `/runs*` + `/artifacts*` + `/healthz` (additive; `/runs*` compat remains mandatory).
- Truth tables: `dbos.workflow_status`, `dbos.operation_outputs`.
- Side effects: only `callIdempotentEffect(effect_key, ...)`.
- UI contract: `#conversation-plane #execution-plane #artifact-plane #run-status[data-state]`.
- Artifact IDs: `raw,docir,chunk-index,memo`.
- Release verdict: `mise run ci` only.

## 0. Setup once
```bash
mise install
mise run up
mise run reset
```

## 1. 5-minute value demo (PO loop, live UI+API)
1. Start UI in embedded mode (default; it starts API internally):
```bash
API_PORT=4010 UI_PORT=4110 mise x node@24.13.1 -- node apps/ui/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```
Important: do not run standalone API on the same `API_PORT` while UI is in embedded mode, or startup fails with `EADDRINUSE`.

Split-process alternative (UI proxies to external API, no embedded bind):
```bash
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
API_PORT=4010 UI_PORT=4110 UI_EMBED_API=0 mise x node@24.13.1 -- node apps/ui/src/server.mjs
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```
2. Open UI:
```bash
xdg-open 'http://127.0.0.1:4110/?sleepMs=250' || open 'http://127.0.0.1:4110/?sleepMs=250' || true
```
3. Submit command `/doc alpha beta gamma` once.
4. Validate:
- `#run-status[data-state]`: `idle -> running -> done`.
- `#timeline` has `prepare`, `DBOS.sleep`, `side-effect`, `finalize`.
- `#artifacts` has `raw,docir,chunk-index,memo`.
- Execution pane polls with htmx (`hx-trigger="every 1s"`) while running.
- Direct artifact links (`/artifacts/:id`) and run links (`/runs/:id`) open full page shell in new tab.

## 2. API happy path (QA loop)
1. Start API:
```bash
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
```
2. Start run:
```bash
RID=$(curl -sS -X POST http://127.0.0.1:4010/runs \
  -H 'content-type: application/json' \
  -d '{"source":"alpha\nbeta [low]\ngamma","sleepMs":500}' | jq -r '.run_id')
echo "$RID"
```
3. Poll to terminal:
```bash
while :; do
  RUN=$(curl -sS "http://127.0.0.1:4010/runs/$RID")
  ST=$(jq -r '.status' <<<"$RUN")
  [[ "$ST" == done || "$ST" == error || "$ST" == unknown ]] && break
  sleep 0.05
done
echo "$RUN" | jq '{run_id,status,dbos_status,timeline_len:(.timeline|length)}'
```
4. Artifact surfaces (list/detail/download):
```bash
curl -sS "http://127.0.0.1:4010/artifacts?type=raw&visibility=user" | jq '.[0] | {id,run_id,type,status}'
curl -sS "http://127.0.0.1:4010/artifacts/${RID}:raw" | jq '{meta,prov,content_preview:(.content|tostring|.[0:40])}'
curl -sS "http://127.0.0.1:4010/artifacts/${RID}:raw/download" | head -c 80; echo
```
5. Export:
```bash
EXP=$(curl -sS "http://127.0.0.1:4010/runs/$RID/export")
echo "$EXP" | jq '{run_id,status,dbos_status,artifact_ids:(.artifacts|map(.id)),run_bundle_path}'
```
6. Assert:
- POST is `202` async durable-start.
- Terminal normally `done` + `dbos_status=SUCCESS`.
- `timeline` ordered by `function_id` asc.
- `artifact_ids` exactly `["raw","docir","chunk-index","memo"]`.
- `/artifacts/:id` detail returns `meta+content+prov`.
- `/artifacts/:id/download` preserves raw payload bytes/content-type.

## 3. DB truth correlation (QA loop)
```bash
mise run psql -- -c "select workflow_uuid,status,name,recovery_attempts,executor_id from dbos.workflow_status where workflow_uuid='${RID}';"
mise run psql -- -c "select function_id,function_name,started_at_epoch_ms,completed_at_epoch_ms from dbos.operation_outputs where workflow_uuid='${RID}' order by function_id asc;"
```
Assert:
- Same `RID` appears in DB + API.
- `function_id` monotonic, 0-based.
- Step order equals API timeline order.

## 4. Hostile contract drills (must pass)
### 4.1 Invalid JSON -> typed 400
```bash
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{'
```
Expect: `400 {"error":"invalid_json"}`.

### 4.2 Encoded traversal IDs -> typed 400
```bash
curl --path-as-is -sS -i http://127.0.0.1:4010/runs/%2E%2E
curl --path-as-is -sS -i http://127.0.0.1:4010/runs/..%2Fx/export
```
Expect: `400 {"error":"invalid_run_id","field":"run_id"}`.

### 4.3 Dedup payload mismatch -> typed 409
```bash
WF=wf-dedup-$RANDOM
curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' \
  -d "{\"source\":\"one\",\"workflowId\":\"$WF\",\"sleepMs\":5}" >/dev/null
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' \
  -d "{\"source\":\"two\",\"workflowId\":\"$WF\",\"sleepMs\":5}"
```
Expect: `409 {"error":"workflow_id_payload_mismatch","workflow_id":"..."}`.

### 4.4 Export source unrecoverable timeline field -> persisted-artifact fallback still exports
```bash
RID2=$(curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' \
  -d '{"source":"will-be-removed","sleepMs":10}' | jq -r '.run_id')
while :; do
  S=$(curl -sS "http://127.0.0.1:4010/runs/$RID2" | jq -r '.status')
  [[ "$S" == done || "$S" == error || "$S" == unknown ]] && break
  sleep 0.05
done
mise run psql -- -c "update dbos.operation_outputs set output='{\"json\":{\"prepared\":\"MISSING_SOURCE\"}}'::jsonb where workflow_uuid='${RID2}' and function_name='prepare';"
curl -sS -i "http://127.0.0.1:4010/runs/$RID2/export"
```
Expect: `200` and canonical artifact IDs still present (export reads persisted artifact rows first).

## 5. Durability + correctness proofs (FDE loop)
### 5.1 Canonical automated proof lanes
```bash
mise run test:workflow
mise run test:replay
mise run test:idempotency
```
What these prove:
- durable-start semantics (`POST /runs` returns after durable start, not after completion).
- SIGKILL mid-run resumes from last completed step.
- retry/backoff comes from DBOS step config.
- CLI/API parity (`dbos workflow get/steps` vs `/runs/:id`).
- exactly-once-effective side effects under concurrency.

### 5.2 Manual kill9 drill (live show)
```bash
API_PORT=4301 mise x node@24.13.1 -- node apps/api/src/server.mjs & APID=$!
RID=$(curl -sS -X POST http://127.0.0.1:4301/runs -H 'content-type: application/json' -d '{"source":"kill9-demo","sleepMs":800}' | jq -r '.run_id')
while ! curl -sS "http://127.0.0.1:4301/runs/$RID" | jq -e '.timeline[]?|select(.function_name=="prepare")' >/dev/null; do sleep 0.05; done
kill -9 "$APID"
API_PORT=4301 mise x node@24.13.1 -- node apps/api/src/server.mjs &
until curl -sS http://127.0.0.1:4301/healthz | jq -e '.ok == true' >/dev/null; do sleep 0.05; done
while :; do
  R=$(curl -sS "http://127.0.0.1:4301/runs/$RID")
  [[ $(jq -r '.status' <<<"$R") == done ]] && break
  sleep 0.05
done
echo "$R" | jq '{status,dbos_status,steps:(.timeline|map(.function_name))}'
```
Assert: `prepare` once, `DBOS.sleep` once, terminal `done/SUCCESS`.
Note: post-restart connection-refused during the boot window is expected noise; gate on `/healthz` before polling `/runs/:id`.

### 5.3 CLI/API parity spot-check
```bash
mise run dbos:workflow:get -- "$RID" | jq '{workflowID,status,workflowName,recoveryAttempts}'
mise run dbos:workflow:steps -- "$RID" | jq 'map({functionID,name})'
curl -sS "http://127.0.0.1:4010/runs/$RID" | jq '{run_id,dbos_status,name:.header.name,recovery_attempts:.header.recovery_attempts,steps:(.timeline|map({function_id,function_name}))}'
```
Assert: same semantics for id/status/name/recovery/step order.

## 6. UI contract + live e2e
### 6.1 Manual UI contract checklist
- IDs exist: `#conversation-plane #execution-plane #artifact-plane #run-status #timeline #artifacts`.
- FSM only: `idle|running|done|error`.
- `unknown` backend status must not spin forever; UI escalates to error path.
- HX contract: `HX-Request` => fragment, `HX-History-Restore-Request` => full-page shell fallback.
- Artifact viewer deep-link `/artifacts/:id` renders full shell and can navigate to `/runs/:id?step=<producer_function_id>`.

### 6.2 Automated e2e
```bash
mise run ui:e2e
```
Includes:
- 3-plane promise path.
- status FSM transitions.
- HX history-restore full-page fallback + OOB poll updates (`#exec/#artifacts/#run-status`).
- long-run polling stability via `pollTimeoutMs,pollIntervalMs,pollMaxIntervalMs`.

### 6.3 Manual resume endpoint drill
```bash
RIDR=$(curl -sS -X POST http://127.0.0.1:4010/runs \
  -H 'content-type: application/json' \
  -d '{"cmd":"/doc resume-drill","sleepMs":2500}' | jq -r '.run_id')
while :; do
  R=$(curl -sS "http://127.0.0.1:4010/runs/$RIDR")
  [[ $(jq -r '.status' <<<"$R") == running ]] && break
  sleep 0.05
done
pnpm --filter @jejakekal/api exec dbos workflow cancel -s "$DBOS_SYSTEM_DATABASE_URL" "$RIDR"
while :; do
  R=$(curl -sS "http://127.0.0.1:4010/runs/$RIDR")
  [[ $(jq -r '.dbos_status' <<<"$R") == CANCELLED ]] && break
  sleep 0.1
done
curl -sS -X POST "http://127.0.0.1:4010/runs/$RIDR/resume" | jq
```
Expect: `202 {"run_id":"...","status":"running"}` then terminal `done/SUCCESS` without duplicated completed steps.

## 7. Export/run-bundle audit loop
1. Get bundle path from export:
```bash
BUNDLE=$(curl -sS "http://127.0.0.1:4010/runs/$RID/export" | jq -r '.run_bundle_path')
echo "$BUNDLE"
```
2. Inspect file set:
```bash
ls -1 "$BUNDLE"
```
3. Must contain:
- `manifest.json`
- `timeline.json`
- `tool-io.json`
- `artifacts.json`
- `citations.json`
- `workflow_status.json`
- `operation_outputs.json`
4. Must hold:
- canonical JSON + newline.
- `manifest.root` normalized token `<run-bundle-root>`.

## 8. Golden + perf discipline
### 8.1 Golden
```bash
mise run golden:record
mise run golden:diff
```
Rule: never blind re-record; review structural intent first.

### 8.2 Perf budgets (correctness caps)
```bash
mise run bench:ingest
mise run bench:query
mise run bench:ui
mise run bench:resume
mise run bench:check
```
Current caps (`spec-0/budgets.json`):
- `ingest_p50_ms<=50`
- `ingest_p95_ms<=120`
- `query_p50_ms<=20`
- `query_p95_ms<=70`
- `ui_load_ms<=500`
- `resume_latency_ms<=80`

## 9. Release gate (single SoT)
```bash
mise run verify
mise run ci
```
Interpretation:
- `verify` = quick dev loop.
- `ci` = release verdict. If red, do not ship.
- GH CI must run only `mise run ci`.

## 10. Triage map (failure-first)
- PG unavailable: `mise run up && mise run reset`.
- Stack unhealthy: `docker compose -f infra/compose/docker-compose.yml ps --format json | jq -s`.
- Hostile probe false-negative: use `curl --path-as-is`.
- Artifact route 4xx confusion: verify raw-path hostile probe vs decoded ID; retry with `curl --path-as-is` on `/artifacts/%2E%2E`.
- Resume stuck/non-visible: confirm `dbos_status` is `CANCELLED|RETRIES_EXCEEDED`; UI intentionally hides resume button otherwise.
- Browser back/history glitch: verify history restore path returns full shell (htmx `historyRestoreAsHxRequest=false`).
- Replay/idempotency flake: inspect determinism freeze + effect-key path + DB row ordering.
- Golden drift: inspect diff intent; then re-record if intentional.
- CI/local mismatch: rerun only `mise run ci`; remove shadow command paths.

## 13. One-command operator signoff
```bash
mise run showcase:002:signoff
```
Outputs `.cache/showcase-002-signoff.json` with machine-checkable verdict (`ok`, failed step IDs, and per-step evidence).

## 11. Scenario deck (run these repeatedly)
1. Happy async start/poll/export.
2. UI 3-plane value demo with `sleepMs`.
3. Invalid JSON 400.
4. Encoded traversal 400.
5. workflowId payload mismatch 409.
6. Export source unrecoverable timeline field still yields persisted-artifact export.
7. SIGKILL mid-sleep resume.
8. Durable-start post-response kill + restart.
9. Retry/backoff flaky workflow proof.
10. CLI/API parity check.
11. e2e selector/state proof.
12. golden diff cleanliness.
13. perf budget pass.
14. full `mise run ci` pass.

## 12. Operator posture
- Treat every run as an auditable contract object, not transient logs.
- Prefer DB row evidence over inferred behavior.
- Prefer typed failures over hidden fallback.
- If it is not reproducible through commands above, it is not ready.
