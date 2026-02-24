# 003 - Sprint2 Operator Tacit Field Manual (Zero-Fluff)

## Intent
Prove shipped behavior, not demo polish. Fast path to real value: run jobs, inspect truth, recover failures, ship safely.

## Contract Laws (read once)
- API SoT: `/runs*` + `/artifacts*` + `/healthz`.
- `/runs*` removal forbidden before **2026-06-30**.
- Start payload canonical: `{intent,args}`. Compat `{source}` is temporary (target sunset **2026-06-30**).
- Truth plane: persisted `artifact` rows + DBOS tables (`dbos.workflow_status`,`dbos.operation_outputs`).
- Chat plane: control ledger only (`cmd,args,run_id`), no answer text.
- UI plane IDs are API: `#conversation-plane #execution-plane #artifact-plane`; aliases `#conv #exec #artifacts` are additive only.
- Run FSM: `#run-status[data-state]=idle|running|done|error` only.
- Release verdict: `mise run ci` only.

## Operating Posture (opinionated)
- Probe readiness before first API/UI check. Always.
- Hit API host for JSON truth; hit UI host for HTML behavior.
- Hostile path tests must use `curl --path-as-is`.
- Accept typed 4xx for client faults; accept opaque 5xx for invariant breaks.
- If command path is not in `mise` task graph, it is non-authoritative.

## 0) Bootstrap
```bash
mise install
mise run up
mise run reset
```

## 1) Start Modes (pick exactly one)
### A. API only (QA/FDE default)
```bash
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
```

### B. UI with embedded API (PO default)
```bash
API_PORT=4010 UI_PORT=4110 mise x node@24.13.1 -- node apps/ui/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```
Rule: do **not** run standalone API on same `API_PORT` in embedded mode (`EADDRINUSE`).

### C. UI split mode + external API (multi-proc drills)
```bash
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
API_PORT=4010 UI_PORT=4110 UI_EMBED_API=0 mise x node@24.13.1 -- node apps/ui/src/server.mjs
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```

## 2) PO 5-Min Value Loop (live UI)
1. Open UI:
```bash
xdg-open 'http://127.0.0.1:4110/?sleepMs=250' || open 'http://127.0.0.1:4110/?sleepMs=250' || true
```
2. Submit `/doc alpha beta gamma`.
3. Validate in order:
- Conversation pane shows command/run link/status only (no generated answer text).
- `#run-status`: `idle -> running -> done`.
- Timeline includes `prepare`,`DBOS.sleep`,`side-effect`,`finalize`.
- Artifacts include exactly: `raw,docir,chunk-index,memo`.
- Running pane uses polling (`hx-trigger='every 1s'`).
4. Deep-link checks:
- Open `/runs/:id` in new tab => full shell.
- Open `/artifacts/:id` in new tab => full shell + viewer.
- Artifact "open run" link returns run page.
- Artifact step link (`?step=`) focuses producing step.

## 3) QA API Loop (3 payload modes + additive projection)
```bash
API=http://127.0.0.1:4010
```

### 3.1 Start runs (all accepted forms)
```bash
R1=$(curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"source":"alpha\nbeta [low]\ngamma","sleepMs":120}' | jq -r '.run_id')
R2=$(curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"alpha"},"sleepMs":80}' | jq -r '.run_id')
R3=$(curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/doc alpha beta","sleepMs":80}' | jq -r '.run_id')
printf '%s\n%s\n%s\n' "$R1" "$R2" "$R3"
```
Expect: each returns `202` start payload with `run_id`.

### 3.2 Poll one run to terminal + inspect keys
```bash
RID=$R3
while :; do RUN=$(curl -sS "$API/runs/$RID"); ST=$(jq -r '.status' <<<"$RUN"); [[ "$ST" == done || "$ST" == error || "$ST" == unknown ]] && break; sleep 0.05; done
echo "$RUN" | jq '{run_id,status,dbos_status,keys:(keys|sort),timeline_len:(.timeline|length),artifact_count:(.artifacts|length)}'
```
Must hold:
- Frozen keys preserved: `run_id,status,dbos_status,header,timeline`.
- `artifacts[]` present additively.
- Timeline order matches DBOS `function_id` asc.

## 4) Artifact Surfaces (list/detail/download)
```bash
RID=$R3
curl -sS "$API/artifacts?type=raw&visibility=user" | jq '.[0] | {id,run_id,type,status,created_at,cost}'
curl -sS "$API/artifacts/${RID}:raw" | jq '{meta,prov,content_preview:(.content|tostring|.[0:80])}'
curl -sS -D /tmp/hdr -o /tmp/raw.bin "$API/artifacts/${RID}:raw/download" && head -c 80 /tmp/raw.bin; echo; grep -i '^content-type:' /tmp/hdr
```
Must hold:
- List filters work + newest-first ordering.
- Detail returns `meta+content+prov`.
- Download is raw bytes + content-type passthrough.
- Provenance is IDs/hashes only (no raw source text blobs).

## 5) Export + Bundle Determinism
```bash
EXP=$(curl -sS "$API/runs/$RID/export")
echo "$EXP" | jq '{run_id,status,dbos_status,artifact_ids:(.artifacts|map(.id)),run_bundle_path}'
BUNDLE=$(echo "$EXP" | jq -r '.run_bundle_path')
ls -1 "$BUNDLE" | sort
curl -sS "$API/runs/$RID/bundle" -o /tmp/a.zip
curl -sS "$API/runs/$RID/bundle.zip" -o /tmp/b.zip
sha256sum /tmp/a.zip /tmp/b.zip
```
Must hold:
- Artifact IDs exactly `raw,docir,chunk-index,memo`.
- `/bundle` and `/bundle.zip` bytes hash-identical.
- Bundle set includes at least `manifest.json,timeline.json,tool-io.json,artifacts.json,citations.json,workflow_status.json,operation_outputs.json`.
- Manifest time is stable (pinned to run header `created_at` when present).

## 6) DB Truth Correlation
```bash
RID=$R3
mise run psql -- -c "select workflow_uuid,status,name,recovery_attempts from dbos.workflow_status where workflow_uuid='${RID}';"
mise run psql -- -c "select function_id,function_name,started_at_epoch_ms,completed_at_epoch_ms from dbos.operation_outputs where workflow_uuid='${RID}' order by function_id asc;"
mise run dbos:workflow:get -- "$RID" | jq '{workflowID,status,workflowName,recoveryAttempts}'
mise run dbos:workflow:steps -- "$RID" | jq 'map({functionID,name})'
```
Must hold: API timeline == DBOS step order; no shadow truth source needed.

### 6.1 OCR SQL kit (deterministic introspection)
```bash
RID=$R3
mise run psql -- -c "select function_id,function_name,output,error from dbos.operation_outputs where workflow_uuid='${RID}' and function_name like 'ocr-%' order by function_id asc;"
mise run psql -- -c "select job_id,doc_id,ver,gate_rev,policy,created_at from ocr_job where job_id='${RID}';"
mise run psql -- -c "select page_idx,status,gate_score,jsonb_array_length(gate_reasons) gate_reason_count,png_sha,raw_sha from ocr_page where job_id='${RID}' order by page_idx asc;"
mise run psql -- -c "select source_job_id,page_idx,changed_blocks,page_diff_sha,diff_sha from docir_page_diff where source_job_id='${RID}' order by page_idx asc,created_at desc;"
mise run psql -- -c "select function_name,coalesce((output->>'ocr_failures')::int,0) ocr_failures,output->>'ocr_model' ocr_model from dbos.operation_outputs where workflow_uuid='${RID}' and function_name='ocr-pages';"
```
Must hold:
- `ocr_job/ocr_page/docir_page_diff` rows are persisted truth for gate/page/diff lineage.
- `dbos.operation_outputs` exposes OCR step outputs for replay diagnostics (`ocr_failures`,`ocr_model`).

## 7) Chat Ledger Invariant
```bash
mise run psql -- -c "select cmd,args,run_id from chat_event order by created_at desc limit 5;"
mise run psql -- -c "select count(*) from chat_event where args ? 'assistantAnswer';"
```
Must hold:
- Rows store only command ledger fields.
- `assistantAnswer` count is `0`.

## 8) Hostile/Fail-Closed Drills
### 8.1 Invalid JSON -> typed 400
```bash
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{'
```
Expect: `400 invalid_json`.

### 8.2 Invalid command/body/sleepMs -> typed 400
```bash
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/bogus nope"}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"foo":"bar"}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"source":"x","sleepMs":0}'
```
Expect: `invalid_command` or `invalid_run_payload`.

### 8.3 Raw-path traversal -> typed 400
```bash
curl --path-as-is -sS -i $API/runs/%2E%2E
curl --path-as-is -sS -i $API/runs/..%2Fx/export
curl --path-as-is -sS -i $API/artifacts/%2E%2E
```
Expect: `invalid_run_id` / `invalid_artifact_id`.

### 8.4 Strong dedup mismatch -> typed 409
```bash
WF=wf-dedup-$RANDOM
curl -sS -X POST $API/runs -H 'content-type: application/json' -d "{\"source\":\"one\",\"workflowId\":\"$WF\",\"sleepMs\":5}" >/dev/null
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d "{\"source\":\"two\",\"workflowId\":\"$WF\",\"sleepMs\":5}"
```
Expect: `409 workflow_id_payload_mismatch`.

### 8.5 Non-resumable resume -> typed 409
```bash
curl -sS -i -X POST $API/runs/$RID/resume
```
Expect: `409 run_not_resumable` for completed run.

### 8.6 Source unrecoverable in timeline -> export still `200`
```bash
RID2=$(curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"source":"will-be-removed","sleepMs":10}' | jq -r '.run_id')
while :; do S=$(curl -sS "$API/runs/$RID2" | jq -r '.status'); [[ "$S" == done || "$S" == error || "$S" == unknown ]] && break; sleep 0.05; done
mise run psql -- -c "update dbos.operation_outputs set output='{\"json\":{\"prepared\":\"MISSING_SOURCE\"}}'::jsonb where workflow_uuid='${RID2}' and function_name='prepare';"
curl -sS -i "$API/runs/$RID2/export"
```
Expect: `200` (persisted-artifact-first export bridge).

## 9) UI/HTMX Contract Drills (live integration)
```bash
UI=http://127.0.0.1:4110
RID=$R3
```

### 9.1 Full vs fragment vs history-restore
```bash
curl -sS $UI/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' $UI/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' -H 'HX-History-Restore-Request:true' $UI/runs/$RID | head -n 5
```
Expect: full / fragment / full.

### 9.2 OOB poll atomics
```bash
curl -sS -H 'HX-Request:true' $UI/ui/runs/$RID/poll
```
Must contain OOB updates for `#exec`, `#artifacts`, `#run-status` in one payload.

### 9.3 UI raw-path + not-found parity
```bash
curl --path-as-is -sS -i $UI/ui/runs/%2E%2E/poll
curl --path-as-is -sS -i $UI/runs/%2E%2E
curl -sS -i $UI/runs/nonexistent-run-id-zzz
```
Must hold:
- Typed/parity-safe error responses (no internal string leak).
- Invalid/not-found poll does not mask to idle state.
- Missing run route renders full shell with error state.

## 10) Resume + Crash-Resume Drills (FDE)
### 10.1 Cancel -> resume API flow
```bash
RIDR=$(curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/doc resume-drill","sleepMs":2500}' | jq -r '.run_id')
while :; do R=$(curl -sS "$API/runs/$RIDR"); [[ $(jq -r '.status' <<<"$R") == running ]] && break; sleep 0.05; done
pnpm --filter @jejakekal/api exec dbos workflow cancel -s "$DBOS_SYSTEM_DATABASE_URL" "$RIDR"
while :; do R=$(curl -sS "$API/runs/$RIDR"); [[ $(jq -r '.dbos_status' <<<"$R") == CANCELLED ]] && break; sleep 0.1; done
curl -sS -X POST "$API/runs/$RIDR/resume" | jq
while :; do R=$(curl -sS "$API/runs/$RIDR"); [[ $(jq -r '.status' <<<"$R") == done ]] && break; sleep 0.05; done
echo "$R" | jq '{status,dbos_status}'
```
Expect: resume returns `202 running`; terminal `done/SUCCESS`; no duplicate completed step.

### 10.2 SIGKILL drill (health-gated)
```bash
API_PORT=4301 mise x node@24.13.1 -- node apps/api/src/server.mjs & APID=$!
RIDK=$(curl -sS -X POST http://127.0.0.1:4301/runs -H 'content-type: application/json' -d '{"source":"kill9-demo","sleepMs":800}' | jq -r '.run_id')
while ! curl -sS "http://127.0.0.1:4301/runs/$RIDK" | jq -e '.timeline[]?|select(.function_name=="prepare")' >/dev/null; do sleep 0.05; done
kill -9 "$APID"
API_PORT=4301 mise x node@24.13.1 -- node apps/api/src/server.mjs &
until curl -sS http://127.0.0.1:4301/healthz | jq -e '.ok == true' >/dev/null; do sleep 0.05; done
while :; do RK=$(curl -sS "http://127.0.0.1:4301/runs/$RIDK"); [[ $(jq -r '.status' <<<"$RK") == done ]] && break; sleep 0.05; done
echo "$RK" | jq '{status,dbos_status,steps:(.timeline|map(.function_name))}'
```
Expect: terminal `done/SUCCESS`; completed steps not replayed.

## 11) Live E2E + Proof Lanes
```bash
mise run test:workflow
mise run test:replay
mise run test:idempotency
mise run ui:e2e
mise run verify
```
Use grep-targeted hardening drills when needed:
```bash
mise run test:workflow -- --grep 'C6 export and bundle fail closed when persisted artifact blob is missing'
mise run test:workflow -- --grep 'C6 artifact detail fails closed for corrupt JSON blob'
mise run test:workflow -- --grep 'C6 chat ledger dedup: idempotent retry with same workflowId keeps one chat_event row'
mise run test:replay -- --grep 'C6 artifact blobs survive SIGKILL restart for detail/download'
```

## 12) Scenario Deck (run in this order, stop on first break)
1. Boot + readiness-gate.
2. UI PO run (`/doc ...`) reaches `done`.
3. Direct `/runs/:id` and `/artifacts/:id` full-shell rendering.
4. API run start via `{source}`.
5. API run start via `{intent,args}`.
6. API run start via `{cmd}`.
7. `/runs/:id` frozen keys + additive `artifacts[]`.
8. Artifact list/detail/download correctness.
9. DB truth correlation (`workflow_status`,`operation_outputs`).
10. Chat ledger no-answer invariant.
11. Invalid JSON typed 400.
12. Invalid command/body/sleepMs typed 400.
13. Raw-path traversal typed 400.
14. workflowId hash mismatch typed 409.
15. Non-resumable resume typed 409.
16. Source-unrecoverable timeline tamper still exports `200`.
17. Bundle `/bundle` vs `/bundle.zip` hash identity.
18. Cancel->resume terminal convergence.
19. SIGKILL->health-gate->resume convergence.
20. `mise run ui:e2e` green.
21. `mise run ci` green.

## 13) Release Closure
```bash
mise run showcase:002:signoff
mise run ci
```
Interpretation:
- `showcase:002:signoff` gives machine-checkable evidence (`.cache/showcase-002-signoff.json`).
- Only `mise run ci` is release verdict.

## 14) Fast Triage Map
- PG weirdness: `mise run up && mise run reset`.
- Seaweed filer port collision (`8888` busy): run with `SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888` for `mise run up|verify|ci`.
- Stack unknown: `docker compose -f infra/compose/docker-compose.yml ps --format json | jq -s`.
- Security probe looks false-green: rerun with `curl --path-as-is`.
- Export/bundle failure: missing/tampered blob should be opaque `5xx` (correct).
- Export expectation mismatch: missing timeline source with persisted rows should still be `200`.
- Resume button absent: confirm `dbos_status` is `CANCELLED|RETRIES_EXCEEDED`.
- UI idle mask suspicion: test `/ui/runs/:id/poll` invalid/not-found; must error, never idle fallback.
- Local/CI mismatch: rerun `mise run ci`, not custom command subsets.

## Done When
- B1 artifact invariants pass.
- B2 chat-as-ledger invariants pass.
- B3 DBOS/replay/resume invariants pass.
- B4 HTMX/full-vs-fragment/OOB invariants pass.
- C6 hardening regressions covered.
- `mise run ci` green.
