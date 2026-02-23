# 004 - Live Ingest Value Scenarios (C0-C7, Opinionated)

## Why
Run this as contract+value proof, not demo. Outcome: live ingest value (`raw->docir->chunk-index->memo`), deterministic recovery, auditable exports, strict fail-closed boundaries, release-safe gates.

## Laws (hard)
- Date baseline: `2026-02-23`.
- Compat window: `/runs*` stays through `2026-06-30`; `{source}` compat expires after `ALLOW_SOURCE_COMPAT_UNTIL` (default `2026-06-30`).
- API SoT: `/runs*` + `/artifacts*` + `/healthz` only.
- Truth SoT: `dbos.workflow_status` + `dbos.operation_outputs` + persisted `artifact` rows.
- Frozen artifact vocab: `raw,docir,chunk-index,memo`.
- UI contract IDs: `#conversation-plane,#execution-plane,#artifact-plane` (+ aliases only).
- Status FSM: `idle|running|done|error` only.
- Ext IO law: `callIdempotentEffect(effect_key,...)` or it is wrong.
- Release verdict: `mise run ci` only.

## 0) Preflight (always)
```bash
mise install
if ss -ltn | rg -q ':8888\b'; then
  export SEAWEED_FILER_PORT=18888
  export BLOB_FILER_ENDPOINT=http://127.0.0.1:18888
fi
mise run up
mise run reset
mise run wait:health -- http://127.0.0.1:9333/cluster/status 20000 200
mise run wait:health -- ${BLOB_FILER_ENDPOINT:-http://127.0.0.1:8888}/ 20000 200
```
Pass:
- Stack healthy.
- Filer probe hits actual endpoint.
- If override used, it is paired (`SEAWEED_FILER_PORT` + `BLOB_FILER_ENDPOINT`) for all later gate commands.

## 1) Start mode matrix (pick one)
```bash
# API-only (QA/FDE)
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
```
```bash
# UI embedded API (PO)
API_PORT=4010 UI_PORT=4110 mise x node@24.13.1 -- node apps/ui/src/server.mjs
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```
```bash
# UI split mode (safe when API already external)
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
API_PORT=4010 UI_PORT=4110 UI_EMBED_API=0 mise x node@24.13.1 -- node apps/ui/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```
Rule: never run standalone API on same `API_PORT` as embedded UI.

## 2) Scenario Deck (run top-down; stop on first break)

### S01: 5-min PO value loop
```bash
xdg-open 'http://127.0.0.1:4110/?sleepMs=250' || open 'http://127.0.0.1:4110/?sleepMs=250' || true
```
UI action: submit `/doc alpha beta gamma`.
Pass:
- `#run-status`: `idle->running->done`.
- Timeline contains: `reserve-doc,store-raw,DBOS.sleep,marker-convert,store-parse-outputs,normalize-docir,index-fts,emit-exec-memo,artifact-count`.
- Artifacts exactly `raw,docir,chunk-index,memo`.
- Memo renders markdown with block refs.

### S02: Start payload matrix (accept/reject)
```bash
API=http://127.0.0.1:4010
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"source":"alpha","sleepMs":50}'
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"alpha"},"sleepMs":50}'
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/doc alpha","sleepMs":50}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"run","args":{"source":"alpha"}}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/run alpha"}'
```
Pass:
- First 3 => `202`.
- Canonical non-source intent => `400 invalid_run_payload`.
- Slash non-source command => `400 invalid_command`.

### S03: `workflowId` strict dedup scope
```bash
WF=wf-$RANDOM
curl -sS -X POST $API/runs -H 'content-type: application/json' \
  -d "{\"intent\":\"doc\",\"args\":{\"source\":\"one\"},\"workflowId\":\"$WF\",\"sleepMs\":5,\"useLlm\":false}" >/dev/null
curl -sS -i -X POST $API/runs -H 'content-type: application/json' \
  -d "{\"intent\":\"doc\",\"args\":{\"source\":\"two\"},\"workflowId\":\"$WF\",\"sleepMs\":999,\"useLlm\":true}"
```
Pass: `409 workflow_id_payload_mismatch`. Note: claim hash scope is canonical `{intent,args}` only.

### S04: Run projection freeze + timeline order
```bash
RID=$(curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/doc alpha beta","sleepMs":80}' | jq -r '.run_id')
while :; do RUN=$(curl -sS "$API/runs/$RID"); ST=$(jq -r '.status' <<<"$RUN"); [[ "$ST" == done || "$ST" == error || "$ST" == unknown ]] && break; sleep 0.05; done
echo "$RUN" | jq '{run_id,status,dbos_status,header,timeline,keys:(keys|sort)}'
```
Pass:
- Frozen keys present: `run_id,status,dbos_status,header,timeline`.
- Additive keys allowed only additive.
- Timeline monotonic by step/function order.

### S05: Artifact list/detail/download digest parity
```bash
curl -sS "$API/artifacts?type=raw&visibility=user" | jq '.[0] | {id,run_id,type,sha256}'
curl -sS "$API/artifacts/${RID}:raw" | jq '{meta,prov_sha:.prov.artifact_sha256}'
curl -sS -D /tmp/h -o /tmp/raw.out "$API/artifacts/${RID}:raw/download" && head -c 80 /tmp/raw.out; echo; grep -i '^content-type:' /tmp/h
```
Pass:
- List `sha256` non-null for persisted rows.
- List/detail/provenance digests match.
- Download returns bytes; verifier path remains sha-strict.

### S06: Export + deterministic bundle transport
```bash
EXP=$(curl -sS "$API/runs/$RID/export")
echo "$EXP" | jq '{run_id,status,dbos_status,artifact_ids:(.artifacts|map(.id)),run_bundle_path}'
BUNDLE=$(echo "$EXP" | jq -r '.run_bundle_path')
jq '.ingest' "$BUNDLE/manifest.json"
curl -sS "$API/runs/$RID/bundle" -o /tmp/a.zip
curl -sS "$API/runs/$RID/bundle.zip" -o /tmp/b.zip
sha256sum /tmp/a.zip /tmp/b.zip
```
Pass:
- Artifact IDs exactly `raw,docir,chunk-index,memo`.
- Manifest has ingest envelope: `doc_id,ver,raw_sha,keys,counts,timing_ms,stderr_ref`.
- `/bundle` and `/bundle.zip` are hash-identical.

### S07: DB truth correlation (DBOS + doc ledger)
```bash
mise run psql -- -c "select workflow_uuid,status from dbos.workflow_status where workflow_uuid='${RID}';"
mise run psql -- -c "select function_id,function_name from dbos.operation_outputs where workflow_uuid='${RID}' order by function_id;"
mise run psql -- -c "select doc_id,latest_ver from doc order by created_at desc limit 1;"
mise run psql -- -c "select doc_id,ver,raw_sha from doc_ver order by created_at desc limit 3;"
mise run psql -- -c "select count(*) blocks, bool_and(block_sha ~ '^[a-f0-9]{64}$') all_sha from block;"
```
Pass: API timeline == DBOS order; doc/doc_ver/block rows durable and hashed.

### S08: FTS internal correctness (no public API creep)
```bash
mise run psql -- -tAc "select case when to_regclass('public.block_tsv_gin') is null then 0 else 1 end"
mise run psql -- -c "select doc_id,ver,block_id,ts_rank(tsv,q) r from block,to_tsquery('english','alpha') q where tsv @@ q order by r desc limit 5;"
```
Pass: GIN exists; ranked deterministic query returns expected rows.

### S09: Hostile client drills (typed 4xx)
```bash
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"foo":"bar"}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"source":"x","sleepMs":0}'
curl --path-as-is -sS -i $API/runs/%2E%2E
curl --path-as-is -sS -i $API/runs/..%2Fx/export
curl --path-as-is -sS -i $API/artifacts/%2E%2E
```
Pass: typed `400` family (`invalid_json`,`invalid_run_payload`,`invalid_run_id`,`invalid_artifact_id`).

### S10: Persisted invariant drills (opaque 5xx)
```bash
mise run test:workflow -- --grep 'P0 persisted malformed artifact uri fails closed as opaque 500 across readers'
mise run test:workflow -- --grep 'artifact sha256 DB invariant rejects empty digest rows'
mise run test:unit -- --grep 'missing or invalid persisted sha fails closed'
```
Pass: all targeted tests green; persisted-row trust-domain faults stay opaque server errors.

### S11: UI host/HX/OOB boundary
```bash
UI=http://127.0.0.1:4110
curl -sS $UI/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' $UI/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' -H 'HX-History-Restore-Request:true' $UI/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' $UI/ui/runs/$RID/poll
mise run ui:e2e -- --grep 'C7 UI host unexpected errors render HTML shell/fragment instead of JSON'
```
Pass:
- full/fragment/full split holds.
- Poll payload carries OOB updates for `#exec,#artifacts,#run-status`.
- UI top-level opaque errors render HTML; JSON `internal_error` reserved for proxied API paths.

### S12: Replay durability (kill/restart)
```bash
mise run test:replay
mise run test:replay -- --grep 'C4 kill9: SIGKILL during DBOS.sleep resumes from last completed step'
```
Pass: resume from last completed step, deterministic terminal convergence, no duplicate completed effects.

### S13: Live idempotent ext-effect law
```bash
mise run test:idempotency
mise run test:idempotency -- --grep 'store-raw retry after post-effect failure replays idempotent effect response'
mise run test:idempotency -- --grep 'workflow external write steps execute via idempotent effect-key registry'
```
Pass: S1/S2/S3/S6 ext writes use effect keys; forced retry replays cached response.

### S14: Vertical smoke (storage+parser+fts)
```bash
mise run smoke:ingest
```
Pass:
- S3 PUT/HEAD/GET roundtrip.
- Marker output sanity.
- `block_tsv_gin` present.

### S15: Perf/golden/release gates
```bash
mise run verify
mise run ui:e2e
mise run golden:record && mise run golden:diff
mise run bench:check
mise run ci
```
Pass:
- `ci` green (sole release verdict).
- Bench keys include real-path metrics incl. `fts_query_p95_ms`,`fts_ingest_ms`.

### S16: Machine signoff
```bash
mise run showcase:002:signoff
cat .cache/showcase-002-signoff.json | jq '{ok,failed_step_ids}'
SHOWCASE_ENFORCE_CI=1 mise run showcase:002:signoff
```
Pass: default signoff green (may skip `release.ci` by design); enforced mode runs full CI.

### S17: Chat-plane ledger law
```bash
mise run psql -- -c "select cmd,args,run_id from chat_event order by created_at desc limit 5;"
mise run psql -- -c "select count(*) from chat_event where args ? 'assistantAnswer';"
```
Pass: control ledger rows only; answer-text field count is `0`.

### S18: `{source}` sunset enforcement
```bash
mise run test:workflow -- --grep 'P1 source compat sunset matrix: pre-window accepts `{source}`, post-window rejects typed 400'
```
Pass: compat is date-gated; post-window rejection typed (`source_compat_expired`).

### S19: Resume semantics (fail-closed)
```bash
RIDR=$(curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/doc resume-drill","sleepMs":2500}' | jq -r '.run_id')
while :; do R=$(curl -sS "$API/runs/$RIDR"); [[ $(jq -r '.status' <<<"$R") == running ]] && break; sleep 0.05; done
pnpm --filter @jejakekal/api exec dbos workflow cancel -s "$DBOS_SYSTEM_DATABASE_URL" "$RIDR"
while :; do R=$(curl -sS "$API/runs/$RIDR"); [[ $(jq -r '.dbos_status' <<<"$R") == CANCELLED ]] && break; sleep 0.1; done
curl -sS -X POST "$API/runs/$RIDR/resume" | jq
curl -sS -i -X POST "$API/runs/$RID/resume" | head -n 1
```
Pass:
- Cancelled run resume => `202`.
- Completed run resume => `409 run_not_resumable`.
- UI must expose resume only for `CANCELLED|RETRIES_EXCEEDED`.

## 3) High-yield tacit shortcuts
- Health-gate before first probe. Always.
- `HEAD/GET > LIST` for object truth.
- Persisted-first readers: export/detail/download trust rows+sha, not recomputation.
- `curl --path-as-is` for hostile-path tests; browser path normalization hides bugs.
- For host `:8888` collision, use paired filer override across `up|reset|verify|ci`; never one-sided.
- Unknown backend status in UI is terminal `error`, not spinner.
- Resume allowed only for `CANCELLED|RETRIES_EXCEEDED`.

## 4) Fast triage map
- PG/stack weird: `mise run up && mise run reset`.
- Port collision: set `SEAWEED_FILER_PORT` + `BLOB_FILER_ENDPOINT`, rerun setup.
- Seaweed `InvalidAccessKeyId|AccessDenied`:
```bash
docker exec jejakekal-blob weed shell -master=localhost:9333 <<< $'s3.configure -user=local -actions=Read,Write,List,Tagging,Admin -access_key=any -secret_key=any -apply'
mise run reset
```
- Export anomaly: missing/tampered persisted blob => opaque `5xx` is correct.
- If embedded startup ever reports `dbos_migrations_pkey`: inspect DBOS startup lock path first, then retry.

## 5) Done criteria
- S01..S19 pass.
- B1..B5 proof intent satisfied (durability, Seaweed correctness, Marker correctness, DocIR correctness, FTS correctness).
- If behavior changed: same-change updates to `spec-0/00-learnings.jsonl`, `spec-0/04-tasks.jsonl`, `spec-0/04-tutorial.jsonl` (+ `.codex/rules/*` for new failure mode).
