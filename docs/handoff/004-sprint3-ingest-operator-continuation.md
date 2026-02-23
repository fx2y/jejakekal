# 004 Sprint3 Ingest Continuation (Operator-First, Fail-Closed)

Date baseline: `2026-02-23`.
Audience: senior dev continuing sprint3/4 work with zero re-discovery.
Mode: contract-test operator, not feature theater.

## 0. Non-Negotiables (Read Once, Enforce Always)

1. Command SoT only:
`mise install` -> `mise run up` -> `mise run reset` -> `mise run verify` -> `mise run ci`.
No shadow command graph.
2. Runtime truth only:
`dbos.workflow_status` + `dbos.operation_outputs` + persisted `artifact` rows.
No in-memory/app shadow truth.
3. Public API frozen:
`/runs*`, `/artifacts*`, `/healthz`; no `/api/*`.
4. Projection freeze:
`run_id,status,dbos_status,header,timeline` immutable keys; additive fields only.
5. Artifact vocab freeze:
`raw,docir,chunk-index,memo` only.
6. External effects law:
all ext writes through `callIdempotentEffect(effect_key, ...)`.
7. Security law:
raw-path hostile; decode+allowlist IDs; fail-closed typed `4xx` for client faults, opaque `5xx` for invariants.
8. Temporal law:
`/runs*` removal forbidden before `2026-06-30`.
`{source}` compat sunset default `2026-06-30` via `ALLOW_SOURCE_COMPAT_UNTIL`.

## 1. Current State Snapshot (What Is Actually Shipped)

1. Workflow shape is live S0..S8 in `apps/api/src/dbos-workflows.mjs`.
`reserve-doc -> store-raw -> sleep -> marker-convert -> store-parse-outputs -> normalize-docir -> index-fts -> emit-exec-memo -> artifact-count`.
2. DBOS startup race hardening shipped:
PG advisory lock + duplicate migration retry in `apps/api/src/dbos-runtime.mjs`.
3. Seaweed substrate is canonical:
compose maps `9000:8333`; filer default `8888`; override via paired `SEAWEED_FILER_PORT` + `BLOB_FILER_ENDPOINT`.
4. Persisted artifact reads are strict:
`parsePersistedArtifactUri` trust-domain split + mandatory sha verify in `apps/api/src/artifact-blobs.mjs`.
5. Doc ledger + FTS shipped:
`doc`, `doc_ver`, `block.tsv`, `block_tsv_gin` in `infra/sql/schema.sql`.
6. UI contract shipped:
plane IDs `#conversation-plane,#execution-plane,#artifact-plane`; aliases `#conv,#exec,#artifacts`; OOB poll on `/ui/runs/:id/poll`.
7. Compat behavior now explicit:
canonical non-source `intent=run` => `400 invalid_run_payload`; slash `/run` => `400 invalid_command`.
8. Artifact list hash gap fixed:
`/artifacts` list now carries `sha256` from persisted rows.

## 2. Repo Topology (Where To Touch For What)

1. Ingest orchestration:
`apps/api/src/dbos-workflows.mjs`.
2. Payload policy + dedup claim hash:
`apps/api/src/runs-service.mjs`, `apps/api/src/commands/parse-command.mjs`.
3. Date-gated source compat:
`apps/api/src/source-compat.mjs`.
4. Artifact persistence/provenance/readback:
`apps/api/src/artifacts/repository.mjs`, `apps/api/src/artifacts/provenance.mjs`, `apps/api/src/artifact-blobs.mjs`, `apps/api/src/artifact-uri.mjs`.
5. Blob/key seams:
`apps/api/src/blob/s3-store.mjs`, `apps/api/src/ingest/keys.mjs`, `apps/api/src/ingest/effect-key.mjs`.
6. DocIR/Parser seams:
`packages/pipeline/src/ingest.mjs`, `packages/pipeline/src/marker/runner.mjs`, `packages/pipeline/src/docir/normalize-marker.mjs`.
7. FTS seam:
`apps/api/src/search/block-repository.mjs`.
8. Export/bundle determinism:
`apps/api/src/export-run.mjs`, `apps/api/src/runs-bundle-zip.mjs`, `packages/core/src/run-bundle.mjs`, `packages/core/src/deterministic-zip.mjs`.
9. UI boundary:
`apps/ui/src/server.mjs`, `apps/ui/src/ui-render.mjs`, `apps/ui/src/ui-view-model.mjs`.
10. Task graph:
`.mise.toml`, `mise-tasks/*`, `scripts/*`.

## 3. Fast Start (Battle-Tested)

1. Bootstrap:
```bash
mise install
ss -ltn | rg ':8888\b' || true
```
2. If `:8888` occupied, stick to paired override for every gate command:
```bash
SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888 mise run up
SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888 mise run reset
SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888 mise run verify
SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888 mise run ci
```
3. Default path if `:8888` free:
```bash
mise run up
mise run reset
mise run wait:health -- http://127.0.0.1:9333/cluster/status 20000 200
mise run wait:health -- ${BLOB_FILER_ENDPOINT:-http://127.0.0.1:8888}/ 20000 200
```
4. Start modes:
```bash
# API only
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
# UI embedded API (default)
API_PORT=4010 UI_PORT=4110 mise x node@24.13.1 -- node apps/ui/src/server.mjs
# UI split
API_PORT=4010 UI_PORT=4110 UI_EMBED_API=0 mise x node@24.13.1 -- node apps/ui/src/server.mjs
```

## 4. Canonical Operator Walkthroughs

### A. PO Value Loop (5 min)

1. Open UI `http://127.0.0.1:4110/?sleepMs=250`.
2. Submit `/doc alpha beta gamma`.
3. Assert:
`#run-status[data-state]` transitions `idle -> running -> done`.
4. Assert timeline contains:
`reserve-doc,store-raw,DBOS.sleep,marker-convert,store-parse-outputs,normalize-docir,index-fts,emit-exec-memo,artifact-count`.
5. Assert artifacts exactly:
`raw,docir,chunk-index,memo`.
6. Open memo; confirm markdown + block refs, not answer-text chat storage.

### B. QA API Loop (Contract)

1. Payload matrix:
```bash
API=http://127.0.0.1:4010
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"source":"alpha","sleepMs":50}'
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"alpha"},"sleepMs":50}'
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/doc alpha","sleepMs":50}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"run","args":{"source":"alpha"}}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/run alpha"}'
```
2. Expected:
first 3 => `202`; `intent=run` => `400 invalid_run_payload`; `/run` => `400 invalid_command`.
3. Poll projection freeze:
```bash
RID=<run_id>
while :; do RUN=$(curl -sS "$API/runs/$RID"); ST=$(jq -r '.status' <<<"$RUN"); [[ "$ST" == done || "$ST" == error || "$ST" == unknown ]] && break; sleep 0.05; done
echo "$RUN" | jq '{run_id,status,dbos_status,keys:(keys|sort),timeline:(.timeline|map(.function_name))}'
```
4. Artifact/readback/provenance:
```bash
curl -sS "$API/artifacts?type=raw&visibility=user" | jq '.[0] | {id,run_id,type,sha256}'
curl -sS "$API/artifacts/${RID}:raw" | jq '{meta,prov_keys:(.prov|keys)}'
curl -sS "$API/artifacts/${RID}:raw/download" -o /tmp/raw.out
```
5. Export/bundle determinism:
```bash
EXP=$(curl -sS "$API/runs/$RID/export")
BUNDLE=$(echo "$EXP" | jq -r '.run_bundle_path')
jq '.ingest' "$BUNDLE/manifest.json"
curl -sS "$API/runs/$RID/bundle" -o /tmp/a.zip
curl -sS "$API/runs/$RID/bundle.zip" -o /tmp/b.zip
sha256sum /tmp/a.zip /tmp/b.zip
```
6. DB correlation:
```bash
mise run psql -- -c "select workflow_uuid,status from dbos.workflow_status where workflow_uuid='${RID}';"
mise run psql -- -c "select function_id,function_name from dbos.operation_outputs where workflow_uuid='${RID}' order by function_id;"
mise run psql -- -c "select doc_id,latest_ver from doc order by created_at desc limit 1;"
mise run psql -- -c "select count(*) as blocks, bool_and(block_sha ~ '^[a-f0-9]{64}$') as all_sha from block;"
```

### C. Hostile Drills (Fail-Closed)

1. Invalid JSON:
```bash
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{'
```
Expect `400 invalid_json`.
2. Path traversal probes (must use raw path):
```bash
curl --path-as-is -sS -i $API/runs/%2E%2E
curl --path-as-is -sS -i $API/runs/..%2Fx/export
curl --path-as-is -sS -i $API/artifacts/%2E%2E
```
Expect typed ID errors.
3. workflowId mismatch:
same workflowId + changed `{intent,args}` => `409 workflow_id_payload_mismatch` even if controls differ.
4. Persisted malformed URI or bad sha:
must fail opaque `500` (server invariant), never typed `4xx`.

### D. UI Boundary Loop

1. Selector/FSM:
IDs exist; status states limited to `idle|running|done|error`.
2. HX split:
`/runs/:id` non-HX => full shell; HX => fragment; HX-history-restore => full shell.
3. Poll OOB:
`/ui/runs/:id/poll` must atomically update `#exec,#artifacts,#run-status`.
4. Resume gate:
show/allow only `CANCELLED|RETRIES_EXCEEDED`.

### E. FDE Resilience Loop

1. Vertical smoke:
```bash
mise run smoke:ingest
```
2. Replay + kill9:
```bash
mise run test:replay
mise run test:replay -- --grep 'C4 kill9: SIGKILL during DBOS.sleep resumes from last completed step'
```
3. Idempotency:
```bash
mise run test:idempotency
mise run test:idempotency -- --grep 'store-raw retry after post-effect failure replays idempotent effect response'
```
4. Proof ladder:
`mise run verify` -> `mise run ui:e2e` -> `mise run golden:record && mise run golden:diff` -> `mise run bench:check` -> `mise run ci`.

## 5. Extension Recipes (How To Add Without Breaking Laws)

### Recipe 1: Add New Ingest Step `Sx`

1. Add pure step fn near existing S* in `apps/api/src/dbos-workflows.mjs`.
2. If ext IO exists, wrap with deterministic effect key via `buildIngestEffectKey` + `callIdempotentEffect`.
3. Register DBOS step name `kebab-case`, retries explicit.
4. Thread output additively into final workflow return; never mutate frozen projection keys.
5. Add/adjust timeline assertions in:
`apps/api/test/workflow.integration.test.mjs`, `apps/api/test/replay.integration.test.mjs`, `apps/ui/test/e2e.spec.mjs`.
6. If new artifact emitted:
must still stay inside frozen vocab or fail. If truly new vocab needed, this is a contract migration, not feature patch.

### Recipe 2: Add New Persisted Blob Reader/Writer Mode

1. Extend `apps/api/src/artifact-uri.mjs` allowlist with explicit scheme parser.
2. Keep trust split:
request parse errors => typed `4xx`; persisted-row parse errors => opaque `5xx`.
3. Ensure `readVerifiedArtifactBlob` path still enforces sha64 hex + checksum match.
4. Add roundtrip tests in `apps/api/test/artifact-uri.unit.test.mjs` + workflow integration invariants.

### Recipe 3: Change Dedup/Payload Semantics Safely

1. Modify only `normalizeRunStartPayload` and `makeInputHash` in `apps/api/src/runs-service.mjs`.
2. Preserve canonical hash scope `{intent,args}` unless explicitly migrating.
3. Keep `/run` and `/open` rejected on ingest lane.
4. Update unit + integration matrix tests first; then tutorial/tasks/learnings logs same change.

### Recipe 4: Extend Manifest Additively

1. Add fields in `apps/api/src/export/ingest-summary.mjs` and/or `apps/api/src/export-run.mjs`.
2. Keep `manifest.createdAt` pinned to run header when present.
3. Re-run deterministic zip checks and golden diff.

### Recipe 5: UI Enhancements Without Contract Drift

1. Never rename/remove `UI_PLANE_IDS`/aliases.
2. Keep `#run-status[data-state]` strict finite set.
3. Any new status from backend must map to terminal `error` until explicitly modeled.
4. Preserve host split:
UI route errors render HTML; proxied API retains JSON `internal_error`.

## 6. Known Sharp Edges + Fast Triage

1. `:8888` busy:
use paired override vars everywhere (`up/reset/verify/ci`), never one-only.
2. Seaweed S3 `InvalidAccessKeyId|AccessDenied`:
```bash
docker exec jejakekal-blob weed shell -master=localhost:9333 <<< $'s3.configure -user=local -actions=Read,Write,List,Tagging,Admin -access_key=any -secret_key=any -apply'
mise run reset
```
3. Embedded startup collision symptoms (`dbos_migrations_pkey`):
current code serializes DBOS launch with advisory lock; if resurfaced, inspect `apps/api/src/dbos-runtime.mjs` first.
4. Export 500 on persisted blob read:
usually malformed persisted URI or sha mismatch by design.
5. Hostile-path false green:
you forgot `curl --path-as-is`.
6. Golden drift:
inspect structural intent; do not blind re-record.

## 7. High-Signal Tests To Run First

1. `mise run test:workflow -- --grep 'C2 payload guards: no default source fallback and invalid command typed 400'`
2. `mise run test:workflow -- --grep 'P1 source compat sunset matrix: pre-window accepts `{source}`, post-window rejects typed 400'`
3. `mise run test:workflow -- --grep 'C4 fts correctness: block ledger persists and @@ ranked query is deterministic'`
4. `mise run test:idempotency -- --grep 'workflow external write steps execute via idempotent effect-key registry'`
5. `mise run ui:e2e -- --grep 'C7 UI host unexpected errors render HTML shell/fragment instead of JSON'`

## 8. Living-Spec Update Contract (Mandatory When Behavior Changes)

1. Append durable law only to `spec-0/00-learnings.jsonl`.
2. Append execution/proof evidence to `spec-0/04-tasks.jsonl`.
3. Update operator walkthrough in `spec-0/04-tutorial.jsonl`.
4. If new failure mode discovered, patch `.codex/rules/*` in same change.
5. No behavior-changing PR is complete without proof + log updates.

## 9. Release Ritual (Strict)

1. `mise run verify`
2. `mise run test:replay`
3. `mise run test:idempotency`
4. `mise run ui:e2e`
5. `mise run golden:diff`
6. `mise run bench:check`
7. `mise run ci` (only release verdict)

If any step red: stop, triage invariant first, patch fail-closed, rerun from earliest broken gate.
