# 005 - Hard-Doc OCR Live Operator Course (Sprint4)

## Why
Run this to extract real value (not demo theater): PDF hard-page gating -> page OCR -> deterministic merge/diff -> searchable/output-ready artifacts, with replay-safe external effects and strict contract freeze.

## Audience
PO, QA, FDE.

## Zero-debate laws
- Date baseline: 2026-02-24.
- API SoT: `/runs*`,`/artifacts*`,`/healthz` only; `/api/*` forbidden.
- `/runs*` removal blocked before 2026-06-30.
- Compat `{source}` accepted until `ALLOW_SOURCE_COMPAT_UNTIL` (default 2026-06-30), then `400 source_compat_expired`.
- Start normalize order: `{intent,args}` -> slash `cmd` -> compat `{source}`.
- Ingest rejects non-source intent/cmd as `400 invalid_command`.
- `workflowId` mismatch hash scope is `{intent,args}` only; mismatch => `409 workflow_id_payload_mismatch`.
- Text-lane step map frozen `0..8`; OCR steps additive only.
- Artifact vocab frozen: `raw,docir,chunk-index,memo`.
- UI IDs frozen: `#conversation-plane,#execution-plane,#artifact-plane`; FSM `idle|running|done|error`.
- OCR engine surface (ship lane): `vllm` only; non-vllm client policy => `400 invalid_run_payload field=ocrPolicy.engine`.
- Release verdict: `mise run ci` only.

## 0) Bootstrap substrate (always)
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
command -v pdftoppm
```
Checks:
- Paired filer override is sticky across `up|reset|verify|ci|showcase:002:signoff`.
- Missing poppler must fail with `missing pdftoppm (poppler-utils)`.

## 1) Process modes (pick one)
```bash
# API only (QA/FDE)
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
```
```bash
# UI embedded API (PO fast path)
API_PORT=4010 UI_PORT=4110 mise x node@24.13.1 -- node apps/ui/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```
```bash
# UI split mode (external API)
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
API_PORT=4010 UI_PORT=4110 UI_EMBED_API=0 mise x node@24.13.1 -- node apps/ui/src/server.mjs
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```
Rule: never double-bind `API_PORT` with embedded mode.

## 2) PO value walkthrough (7 min)
1. Open UI.
```bash
xdg-open 'http://127.0.0.1:4110/?sleepMs=250' || open 'http://127.0.0.1:4110/?sleepMs=250' || true
```
2. Run text lane: `/doc alpha beta gamma`.
3. Validate:
- `#run-status`: `idle->running->done`.
- Steps exactly `reserve-doc,store-raw,DBOS.sleep,marker-convert,store-parse-outputs,normalize-docir,index-fts,emit-exec-memo,artifact-count`.
- Artifacts exactly `raw,docir,chunk-index,memo`.
4. Gate OCR endpoint before hard-doc checks:
```bash
mise run wait:health -- ${OCR_BASE_URL:-http://127.0.0.1:8000}/health 30000 250
```
5. Run hard-doc lane: `/doc table|x.pdf`.
6. Validate additive OCR visibility (no contract churn): execution row text can include `hard_pages,gate_reason_count,ocr_pages,ocr_failures,ocr_model`.
7. Open artifact/run deep links; shell+planes remain intact.

## 3) QA API contract walkthroughs
```bash
API=http://127.0.0.1:4010
```

### A. Accept matrix (all must 202)
```bash
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"source":"alpha","sleepMs":50}'
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"alpha"},"sleepMs":50}'
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/doc alpha","sleepMs":50}'
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"table|x.pdf","mime":"application/pdf"},"sleepMs":50}'
```

### B. Reject matrix (must typed 4xx)
```bash
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"run","args":{"run_id":"x"}}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/run x"}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"x"},"ocrPolicy":{"engine":"ollama","model":"m","baseUrl":"http://127.0.0.1:1","timeoutMs":1,"maxPages":1}}'
```
Expect:
- first two: `400 invalid_command`
- third: `400 invalid_run_payload` + `field=ocrPolicy.engine`
- typed errors are string-envelope today: parse with `jq -r '.error'` (not `.error.code`)

### C. Dedup mismatch (`workflowId` scope drill)
```bash
WF=wf-$RANDOM
curl -sS -X POST $API/runs -H 'content-type: application/json' -d "{\"intent\":\"doc\",\"args\":{\"source\":\"one\"},\"workflowId\":\"$WF\",\"sleepMs\":5,\"useLlm\":false}" >/dev/null
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d "{\"intent\":\"doc\",\"args\":{\"source\":\"two\"},\"workflowId\":\"$WF\",\"sleepMs\":999,\"useLlm\":true}"
```
Expect: `409 workflow_id_payload_mismatch`.

### D. Projection freeze + text-lane IDs
```bash
RID_TXT=<text_run_id>
while :; do RUN=$(curl -sS "$API/runs/$RID_TXT"); ST=$(jq -r '.status' <<<"$RUN"); [[ "$ST" == done || "$ST" == error || "$ST" == unknown ]] && break; sleep 0.05; done
echo "$RUN" | jq '{run_id,status,dbos_status,keys:(keys|sort),steps:(.timeline|map({id:.function_id,name:.function_name}))}'
```
Must hold:
- keys include frozen `run_id,status,dbos_status,header,timeline`
- text lane IDs map `0..8` unchanged

### E. Hard-doc OCR step visibility
```bash
RID_PDF=<harddoc_run_id>
curl -sS "$API/runs/$RID_PDF" | jq '{status,dbos_status,steps:(.timeline|map(.function_name)),ocr:(.timeline|map(select(.function_name|test("^ocr-"))|{name:.function_name,output:.output}))}'
```
Must include OCR steps:
- `ocr-persist-gate`
- `ocr-render-store-pages`
- `ocr-pages`
- `ocr-merge-diff`

### F. Artifacts/provenance walkthrough
```bash
curl -sS "$API/artifacts?type=raw&visibility=user" | jq '.[0] | {id,run_id,type,sha256}'
curl -sS "$API/artifacts/<run_id>:raw" | jq '{meta,prov_keys:(.prov|keys)}'
curl -sS -D /tmp/h -o /tmp/raw.out "$API/artifacts/<run_id>:raw/download" && head -c 80 /tmp/raw.out; echo; rg -i '^content-type:' /tmp/h
```
Must hold:
- persisted-first list/detail/download
- provenance uses IDs/hashes/keys (no raw source leak)

### G. Export/bundle walkthrough
```bash
RID=<harddoc_run_id>
EXP=$(curl -sS "$API/runs/$RID/export")
echo "$EXP" | jq '{run_id,status,dbos_status,artifact_ids:(.artifacts|map(.id)),run_bundle_path,ocr:.ingest.ocr}'
B=$(echo "$EXP" | jq -r '.run_bundle_path')
ls -1 "$B" | sort | rg '^(ocr_pages\.json|ocr_report\.md|diff_summary\.md)$'
curl -sS "$API/runs/$RID/bundle" -o /tmp/r1.zip
curl -sS "$API/runs/$RID/bundle.zip" -o /tmp/r2.zip
sha256sum /tmp/r1.zip /tmp/r2.zip
```
Must hold:
- artifact IDs still frozen quartet
- `ingest.ocr` has `hard_pages,ocr_pages,ocr_failures,ocr_model,diff_sha`
- sidecar triad always present (no-diff allowed)
- `bundle` and `bundle.zip` byte-identical

### H. DB truth correlation walkthrough
```bash
RID=<harddoc_run_id>
mise run psql -- -c "select workflow_uuid,status,name,recovery_attempts from dbos.workflow_status where workflow_uuid='${RID}';"
mise run psql -- -c "select function_id,function_name,output,error from dbos.operation_outputs where workflow_uuid='${RID}' order by function_id asc;"
mise run psql -- -c "select job_id,doc_id,ver,gate_rev,policy from ocr_job where job_id='${RID}';"
mise run psql -- -c "select page_idx,status,gate_score,jsonb_array_length(gate_reasons) gate_reason_count,png_sha,raw_sha from ocr_page where job_id='${RID}' order by page_idx asc;"
mise run psql -- -c "select source_job_id,page_idx,changed_blocks,page_diff_sha,diff_sha from docir_page_diff where source_job_id='${RID}' order by page_idx asc;"
```
Must hold:
- API timeline order matches `function_id`
- OCR truth lives in persisted rows (`ocr_job`,`ocr_page`,`ocr_patch`,`docir_page_*`)

### I. Replay-once OCR side-effect walkthrough
```bash
RID=<harddoc_run_id>
mise run psql -- -c "select count(*) as n from side_effects where effect_key like '${RID}|ocr-page|%';"
mise run psql -- -c "select count(distinct effect_key) as d from side_effects where effect_key like '${RID}|ocr-page|%';"
```
Must hold: `n == d == ocr_pages`.

### J. Hostile/fail-closed walkthroughs
```bash
curl --path-as-is -sS -i $API/runs/%2E%2E
curl --path-as-is -sS -i $API/runs/..%2Fx/export
curl --path-as-is -sS -i $API/artifacts/%2E%2E
curl -sS -i -X POST $API/runs/<done_run_id>/resume
```
Expect:
- typed `invalid_run_id` / `invalid_artifact_id`
- non-resumable => `409 run_not_resumable`

## 4) UI host/HTMX walkthroughs
```bash
UI=http://127.0.0.1:4110
RID=<run_id>
```

### A. Full/fragment/history split
```bash
curl -sS $UI/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' $UI/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' -H 'HX-History-Restore-Request:true' $UI/runs/$RID | head -n 5
```
Expect order: `full / fragment / full`.

### B. Poll OOB atomicity
```bash
curl -sS -H 'HX-Request:true' $UI/ui/runs/$RID/poll
```
Must include one payload updating `#exec,#artifacts,#run-status` OOB.

### C. UI contract checks
- IDs fixed: `#conversation-plane,#execution-plane,#artifact-plane`.
- Unknown backend status maps terminal `error`.
- OCR telemetry is additive row text only; no new routes/selectors.

## 5) FDE proof walkthroughs

### A. Substrate/pipeline smoke
```bash
mise run smoke:ingest
mise run test:pipeline:smoke
mise run test:pipeline:ocr
```

### B. Replay/idempotency (sequential, DB-reset)
```bash
mise run test:workflow
mise run test:replay
mise run test:idempotency
```
Must prove:
- cancel/resume across OCR boundary
- retry after post-effect failure reuses cached effect response

### C. Signoff (machine-checked)
```bash
mise run showcase:002:signoff
jq '{ok,failed_step_ids,samples}' .cache/showcase-002-signoff.json
```
Must include OCR tuple proof `{hard_pages,ocr_pages,diff_sha}` and replay-once side-effect evidence.

### D. Perf budgets are correctness caps
```bash
mise run bench:check
```
Required OCR keys:
- `ocr_gate_ms`
- `ocr_page_p95_ms`
- `ocr_merge_ms`
- `ocr_wall_ms`

### E. Final release verdict
```bash
mise run verify
mise run ui:e2e
mise run golden:record && mise run golden:diff
mise run bench:check
mise run ci
```
Rule: stop on first red; only `ci` can declare release.

## 6) Scenario deck (strict order)
1. Bootstrap + health gates.
2. Poppler contract check.
3. UI text-lane value run.
4. Start accept matrix.
5. Start reject matrix (`invalid_command`, non-vllm policy).
6. `workflowId` mismatch 409.
7. Text-lane projection/step freeze.
8. Artifact list/detail/download.
9. UI full/fragment/history split.
10. Poll OOB atomicity drill.
11. OCR endpoint readiness gate (`wait:health -- ${OCR_BASE_URL}/health`).
12. UI hard-doc value run (`/doc table|x.pdf`).
13. Hard-doc OCR step visibility.
14. Export ingest OCR summary.
15. Bundle sidecar triad + zip identity.
16. DBOS + OCR SQL truth join.
17. OCR side-effect replay-once count.
18. Hostile raw-path drills.
19. Resume fail-closed drill.
20. `test:workflow`.
21. `test:replay`.
22. `test:idempotency`.
23. `showcase:002:signoff` proof JSON.
24. `bench:check` OCR caps.
25. `ui:e2e`.
26. `golden:diff`.
27. `ci`.

## 7) Fast triage (minutes, not hours)
- Stack unhealthy:
```bash
mise run up && mise run reset
docker compose -f infra/compose/docker-compose.yml ps --format json | jq -s
```
- Filer override drift:
```bash
bash mise-tasks/internal/require-filer-pair
```
- OCR endpoint unavailable:
```bash
mise run wait:health -- ${OCR_BASE_URL:-http://127.0.0.1:8000}/health 30000 250
mise run showcase:002:signoff
```
- Export anomaly interpretation:
- missing/tampered persisted blob => opaque 5xx is correct
- malformed persisted URI/sha => opaque 5xx is correct
- diff empty still emits `diff_summary.md` by contract

## 8) What not to do
- Don't invent shadow scripts/gates outside `mise` graph.
- Don't treat UI as source of truth over DBOS/persisted rows.
- Don't re-record golden blindly.
- Don't run DB-reset suites in parallel.
- Don't set one-sided filer override.
- Don't claim release without `mise run ci`.
