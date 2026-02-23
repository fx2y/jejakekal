# 003 - Sprint2 Continuation Manual (Artifact-First, Fail-Closed)

## 0. Read Order (strict)
1. `AGENTS.md`
2. `spec-0/03-tutorial.jsonl`
3. `spec-0/03-tasks.jsonl`
4. `spec-0/00-learnings.jsonl`
5. `spec-0/03-htn.jsonl`
6. `spec-0/03/*.jsonl`

If your plan conflicts with those, your plan is wrong.

## 1. Contract Snapshot (current truth)
- Canonical API: `/runs*` + `/artifacts*` + `/healthz`.
- `/runs*` removal forbidden before **2026-06-30**.
- Start payload window: canonical `{intent,args}`; compat `{source}` allowed until target sunset **2026-06-30**.
- Chat is control plane only: `chat_event(cmd,args,run_id)`; no answer text.
- Runtime truth: DBOS tables `dbos.workflow_status`, `dbos.operation_outputs`.
- Run projection frozen keys: `run_id,status,dbos_status,header,timeline`; `artifacts` additive.
- Artifact vocabulary fixed: `raw,docir,chunk-index,memo`.
- Fail-closed: typed 4xx for client fault, opaque `500 {"error":"internal_error"}` otherwise.
- Release verdict: `mise run ci` only.

## 2. Code Map (where behavior actually lives)
- API boot/lifecycle: `apps/api/src/server.mjs`
- Start normalize/dedup: `apps/api/src/runs-service.mjs`
- Runs routes (`/runs`, `/export`, `/bundle`, `/resume`): `apps/api/src/runs-routes.mjs`
- Artifact routes (`/artifacts`, detail, download): `apps/api/src/artifacts-routes.mjs`
- DBOS workflow + persist-artifacts tail guard: `apps/api/src/dbos-workflows.mjs`
- DBOS->API projection: `apps/api/src/runs-projections.mjs`
- Export/bundle assembly: `apps/api/src/export-run.mjs`
- Blob verify + strict decode: `apps/api/src/artifact-blobs.mjs`
- Artifact repo schema seam: `apps/api/src/artifacts/repository.mjs`
- Chat ledger dedup key: `apps/api/src/chat-events/repository.mjs`
- UI server/proxy/HX branching: `apps/ui/src/server.mjs`
- UI render contract: `apps/ui/src/ui-render.mjs`
- UI FSM/view-model: `apps/ui/src/ui-view-model.mjs`
- UI startup mode contract: `apps/ui/src/ui-startup.mjs`
- Start-race seeding: `apps/ui/src/ui-command-start.mjs`
- Task graph SoT: `.mise.toml`
- DB app schema: `infra/sql/schema.sql`

## 3. Operating Modes (pick one, don’t mix blindly)
1. Embedded UI mode (default; UI boots API):
```bash
API_PORT=4010 UI_PORT=4110 mise x node@24.13.1 -- node apps/ui/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```
2. Split mode (external API + UI proxy, no double-bind):
```bash
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
API_PORT=4010 UI_PORT=4110 UI_EMBED_API=0 mise x node@24.13.1 -- node apps/ui/src/server.mjs
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```
Rule: embedded + standalone API on same `API_PORT` => `EADDRINUSE`.

## 4. Fast Command Deck (daily)
```bash
mise install
mise run up
mise run reset
mise watch verify
mise run ui:e2e
mise run ci
```

## 5. Walkthroughs (copy/paste; stop on first invariant break)
### 5.1 Start payload matrix (all valid forms must 202)
```bash
curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{"source":"alpha\nbeta","sleepMs":50}' | jq
curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"alpha"},"sleepMs":50}' | jq
curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{"cmd":"/doc alpha beta","sleepMs":50}' | jq
```

### 5.2 Poll to terminal + frozen/additive projection check
```bash
RID='<run_id>'
while :; do
  RUN=$(curl -sS "http://127.0.0.1:4010/runs/$RID")
  ST=$(jq -r '.status' <<<"$RUN")
  [[ "$ST" == done || "$ST" == error || "$ST" == unknown ]] && break
  sleep 0.05
done
echo "$RUN" | jq '{run_id,status,dbos_status,keys:(keys|sort),timeline_len:(.timeline|length),artifact_count:(.artifacts|length)}'
```
Expect frozen keys + additive `artifacts`.

### 5.3 Artifacts list/detail/download contract
```bash
curl -sS "http://127.0.0.1:4010/artifacts?type=raw&visibility=user" | jq '.[0] | {id,run_id,type,status,created_at,cost}'
curl -sS "http://127.0.0.1:4010/artifacts/${RID}:raw" | jq '{meta,prov,content_preview:(.content|tostring|.[0:80])}'
curl -sS -D /tmp/h -o /tmp/raw.out "http://127.0.0.1:4010/artifacts/${RID}:raw/download"
head -c 80 /tmp/raw.out; echo; grep -i '^content-type:' /tmp/h
```

### 5.4 Export + deterministic bundle transport
```bash
curl -sS "http://127.0.0.1:4010/runs/$RID/export" | jq '{run_id,status,dbos_status,artifact_ids:(.artifacts|map(.id)),run_bundle_path}'
curl -sS "http://127.0.0.1:4010/runs/$RID/bundle" -o /tmp/a.zip
curl -sS "http://127.0.0.1:4010/runs/$RID/bundle.zip" -o /tmp/b.zip
sha256sum /tmp/a.zip /tmp/b.zip
```
Expect identical hashes.

### 5.5 Bundle FS audit
```bash
BUNDLE=$(curl -sS "http://127.0.0.1:4010/runs/$RID/export" | jq -r '.run_bundle_path')
ls -1 "$BUNDLE" | sort
jq -r '.root,.manifest.createdAt?' "$BUNDLE/manifest.json" 2>/dev/null || jq -r '.root,.createdAt?' "$BUNDLE/manifest.json"
```
Must include `manifest.json,timeline.json,tool-io.json,artifacts.json,citations.json,workflow_status.json,operation_outputs.json`.

### 5.6 DB correlation (truth plane)
```bash
mise run psql -- -c "select workflow_uuid,status,name,recovery_attempts from dbos.workflow_status where workflow_uuid='${RID}';"
mise run psql -- -c "select function_id,function_name,started_at_epoch_ms,completed_at_epoch_ms from dbos.operation_outputs where workflow_uuid='${RID}' order by function_id asc;"
mise run dbos:workflow:get -- "$RID" | jq '{workflowID,status,workflowName,recoveryAttempts}'
mise run dbos:workflow:steps -- "$RID" | jq 'map({functionID,name})'
```

### 5.7 Chat ledger invariant
```bash
mise run psql -- -c "select cmd,args,run_id from chat_event order by created_at desc limit 5;"
mise run psql -- -c "select count(*) from chat_event where args ? 'assistantAnswer';"
```
Second query must be zero.

### 5.8 Hostile/fail-closed drills
```bash
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{'
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{"cmd":"/bogus nope"}'
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{"foo":"bar"}'
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{"source":"x","sleepMs":0}'
curl --path-as-is -sS -i http://127.0.0.1:4010/runs/%2E%2E
curl --path-as-is -sS -i http://127.0.0.1:4010/artifacts/%2E%2E
```

### 5.9 Strong dedup conflict
```bash
WF=wf-dedup-$RANDOM
curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d "{\"source\":\"one\",\"workflowId\":\"$WF\",\"sleepMs\":5}" >/dev/null
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d "{\"source\":\"two\",\"workflowId\":\"$WF\",\"sleepMs\":5}"
```
Expect `409 workflow_id_payload_mismatch`.

### 5.10 Persisted-first export bridge (tampered timeline still 200)
```bash
RID2=$(curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{"source":"will-be-removed","sleepMs":10}' | jq -r '.run_id')
while :; do S=$(curl -sS "http://127.0.0.1:4010/runs/$RID2" | jq -r '.status'); [[ "$S" == done || "$S" == error || "$S" == unknown ]] && break; sleep 0.05; done
mise run psql -- -c "update dbos.operation_outputs set output='{\"json\":{\"prepared\":\"MISSING_SOURCE\"}}'::jsonb where workflow_uuid='${RID2}' and function_name='prepare';"
curl -sS -i "http://127.0.0.1:4010/runs/$RID2/export"
```

### 5.11 UI HX/full/history contract
```bash
curl -sS http://127.0.0.1:4110/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' http://127.0.0.1:4110/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' -H 'HX-History-Restore-Request:true' http://127.0.0.1:4110/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' http://127.0.0.1:4110/ui/runs/$RID/poll
```

### 5.12 UI path-boundary parity
```bash
curl --path-as-is -sS -i http://127.0.0.1:4110/ui/runs/%2E%2E/poll
curl --path-as-is -sS -i http://127.0.0.1:4110/runs/%2E%2E
curl -sS -i http://127.0.0.1:4110/runs/nonexistent-run-id-zzz
```
No internal string leaks; missing/invalid must show error state, never idle mask.

### 5.13 Cancel/resume API + UI rule
```bash
RIDR=$(curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{"cmd":"/doc resume-drill","sleepMs":2500}' | jq -r '.run_id')
while :; do R=$(curl -sS "http://127.0.0.1:4010/runs/$RIDR"); [[ $(jq -r '.status' <<<"$R") == running ]] && break; sleep 0.05; done
pnpm --filter @jejakekal/api exec dbos workflow cancel -s "$DBOS_SYSTEM_DATABASE_URL" "$RIDR"
while :; do R=$(curl -sS "http://127.0.0.1:4010/runs/$RIDR"); [[ $(jq -r '.dbos_status' <<<"$R") == CANCELLED ]] && break; sleep 0.1; done
curl -sS -X POST "http://127.0.0.1:4010/runs/$RIDR/resume" | jq
```
Resume control is valid only for `CANCELLED|RETRIES_EXCEEDED`.

### 5.14 Kill9 replay-safe recovery
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

## 6. Extension Playbooks (opinionated)
### 6.1 Add new slash command
1. Update parser/normalizer in `apps/api/src/commands/parse-command.mjs`.
2. Keep output normalized `{intent,args}` only.
3. Ensure `normalizeRunStartPayload` in `apps/api/src/runs-service.mjs` stays strict; no fallback synthesis.
4. Add tests in `apps/api/test/parse-command.unit.test.mjs` + `apps/api/test/workflow.integration.test.mjs`.
5. Append learnings/tasks/tutorial updates.

### 6.2 Add new artifact type (high friction by design)
1. Decide if vocabulary expansion is contractual; if yes update `AGENTS.md` first.
2. Persist in workflow step (`persistArtifactsStep` in `apps/api/src/dbos-workflows.mjs`), not export synthesis.
3. Include provenance hashes only.
4. Update artifact list/detail/download tests.
5. Update bundle expectations/goldens and operator tutorial.

### 6.3 Add UI pane data
1. Source data from API projection, not client inference.
2. Transform in `apps/ui/src/ui-view-model.mjs`.
3. Render in `apps/ui/src/ui-render.mjs`.
4. Preserve IDs: `conversation-plane/execution-plane/artifact-plane`, aliases `conv/exec/artifacts`, FSM `idle|running|done|error`.
5. Add e2e asserting selector/state behavior.

### 6.4 Add run projection fields
1. Enrich in `apps/api/src/runs-projections.mjs`.
2. Keep frozen keys intact.
3. Additive only.
4. Ensure sort by `function_id` unchanged.
5. Verify UI unknown status still maps to error, not new state.

## 7. Triage (failure-first)
- PG unavailable: `mise run up && mise run reset`
- Compose health shape: `docker compose -f infra/compose/docker-compose.yml ps --format json | jq -s`
- Boot-noise false negatives: gate probes with `mise run wait:health -- <url> [timeoutMs intervalMs]`
- Hostile path probe false negatives: use `curl --path-as-is`
- Export/bundle inconsistency: check blob readability + sha mismatch behavior (must opaque 5xx)
- Accepted start flashes idle in UI: inspect `apps/ui/src/ui-command-start.mjs` flow
- Golden drift: inspect intent; never blind record

## 8. Proof Ladder (what counts)
1. `mise run verify`
2. `mise run test:replay`
3. `mise run test:idempotency`
4. `mise run ui:e2e`
5. `mise run golden:diff`
6. `mise run bench:check`
7. `mise run ci` (only verdict)

Optional single-command evidence: `mise run showcase:002:signoff` (includes `release.ci`).

## 9. Living-Spec Update Protocol (mandatory on behavior delta)
1. Ship proof (test/golden/perf).
2. Append durable decision/constraint to `spec-0/00-learnings.jsonl`.
3. Append execution evidence to `spec-0/03-tasks.jsonl`.
4. Update operator flow in `spec-0/03-tutorial.jsonl`.
5. Update `.codex/rules/*` if new failure mode.
6. Keep task graph in `.mise.toml`; no shadow command graphs.

## 10. Red Lines
- No `/api/*` resurrection.
- No chat answer text persistence/rendering.
- No `/runs*` removal before 2026-06-30.
- No silent payload fallback synthesis.
- No artifact update/delete path.
- No UI idle masking for invalid/not-found run routes.
- No bypass around `callIdempotentEffect` for external effects.

