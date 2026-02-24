# 005 Sprint4 Hard-Doc OCR Continuation (Ultra-Opinionated, Operator-First)

Date baseline: `2026-02-24`.
Audience: expert dev continuing sprint4 without rediscovery.
Mode: contracts + proofs + persisted truth; no guesswork.

## 0. Hard Laws (Never Negotiate)

1. Command SoT only: `mise install` -> `mise run up` -> `mise run reset` -> `mise run verify` -> `mise run ci`.
2. Release verdict only: `mise run ci`.
3. Public API freeze: `/runs*`, `/artifacts*`, `/healthz`; never `/api/*`.
4. `/runs*` removal forbidden before `2026-06-30`.
5. Start normalize order frozen: canonical `{intent,args}` -> slash `cmd` -> compat `{source}`.
6. Compat `{source}` gate: `ALLOW_SOURCE_COMPAT_UNTIL` default `2026-06-30`; after => typed `400 source_compat_expired`.
7. Ingest rejects non-source intents/cmd as canonical `400 invalid_command`.
8. `workflowId` claim hash scope frozen to canonical `{intent,args}` only; mismatch => `409 workflow_id_payload_mismatch`.
9. Runtime truth only: `dbos.workflow_status` + `dbos.operation_outputs` + persisted app rows (`artifact`,`ocr_job`,`ocr_page`,`ocr_patch`,`docir_page_version`,`docir_page_diff`).
10. Projection freeze keys: `run_id,status,dbos_status,header,timeline` (additive-only enrichment).
11. Artifact vocab freeze: `raw,docir,chunk-index,memo`; enforced at insert seam.
12. Text-lane step map frozen `0..8` (`reserve-doc`..`artifact-count`); OCR steps additive branch only.
13. OCR engine surface C3-frozen: `vllm` only (env + client policy).
14. Effects boundary: external IO via `callIdempotentEffect(effect_key, ...)`; replay must reuse cached side_effect.
15. Provenance boundary: IDs/hashes/keys only; no raw source text in control-plane outputs.
16. Filer override law: set `SEAWEED_FILER_PORT` and `BLOB_FILER_ENDPOINT` together or neither.

## 1. What Is Shipped (Code Reality)

1. Hard-doc route selection is live in [`runs-service.mjs`](/home/haris/projects/jejakekal/apps/api/src/runs-service.mjs): PDF signal via `mime=application/pdf` or `*.pdf` in `source|locator`.
2. Hard-doc workflow is additive hook in [`dbos-workflows.mjs`](/home/haris/projects/jejakekal/apps/api/src/dbos-workflows.mjs): `runS4xAfterNormalize` executes `ocr-persist-gate -> ocr-render-store-pages -> ocr-pages -> ocr-merge-diff`.
3. Gate scorer (`computeHardPages`) is pure, sparse-safe, deterministic in [`gate-core.mjs`](/home/haris/projects/jejakekal/apps/api/src/ocr/gate-core.mjs).
4. Render seam fail-closed (`hard_pages>0` requires source PDF + 1:1 valid rows) in [`render-seam.mjs`](/home/haris/projects/jejakekal/apps/api/src/ocr/render-seam.mjs).
5. OCR adapter strict IO contract + malformed-row hard-fail in [`contract.mjs`](/home/haris/projects/jejakekal/apps/api/src/ocr/contract.mjs) and [`engine-seam.mjs`](/home/haris/projects/jejakekal/apps/api/src/ocr/engine-seam.mjs).
6. Merge policy is patched+changed-only (no delete-only path) in [`merge-core.mjs`](/home/haris/projects/jejakekal/apps/api/src/ocr/merge-core.mjs).
7. Export includes additive `ingest.ocr` on `/runs/:id/export` in [`export-run.mjs`](/home/haris/projects/jejakekal/apps/api/src/export-run.mjs) + [`ingest-summary.mjs`](/home/haris/projects/jejakekal/apps/api/src/export/ingest-summary.mjs).
8. OCR sidecar triad deterministic (`ocr_pages.json`,`ocr_report.md`,`diff_summary.md`) in [`ocr-sidecars.mjs`](/home/haris/projects/jejakekal/apps/api/src/export/ocr-sidecars.mjs).
9. `reserve-doc` source-text leak is closed by sanitizer in [`runs-projections.mjs`](/home/haris/projects/jejakekal/apps/api/src/runs-projections.mjs).
10. UI contracts frozen; additive OCR telemetry appears in execution rows in [`ui-view-model.mjs`](/home/haris/projects/jejakekal/apps/ui/src/ui-view-model.mjs) and [`ui-render.mjs`](/home/haris/projects/jejakekal/apps/ui/src/ui-render.mjs).
11. Ops gates wired in [`.mise.toml`](/home/haris/projects/jejakekal/.mise.toml): `verify/ci` call filer pair guard; OCR env defaults are vllm-only.

## 2. First 10 Minutes (Do Exactly This)

```bash
mise install
ss -ltn | rg ':8888\b' || true
```

If `:8888` occupied, export once for session and keep sticky for every stack/gate command:

```bash
export SEAWEED_FILER_PORT=18888
export BLOB_FILER_ENDPOINT=http://127.0.0.1:18888
```

Then:

```bash
mise run up
mise run reset
mise run wait:health -- http://127.0.0.1:9333/cluster/status 20000 200
mise run wait:health -- ${BLOB_FILER_ENDPOINT:-http://127.0.0.1:8888}/ 20000 200
command -v pdftoppm
```

Start hosts (pick one):

```bash
# API only
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs

# UI embedded API
API_PORT=4010 UI_PORT=4110 mise x node@24.13.1 -- node apps/ui/src/server.mjs

# UI split
API_PORT=4010 mise x node@24.13.1 -- node apps/api/src/server.mjs
API_PORT=4010 UI_PORT=4110 UI_EMBED_API=0 mise x node@24.13.1 -- node apps/ui/src/server.mjs
```

Health gate:

```bash
mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100
mise run wait:health -- http://127.0.0.1:4110/healthz 15000 100
```

## 3. Canonical Walkthrough Deck (Run In Order)

### 3.1 PO Value Loop

1. Open `http://127.0.0.1:4110/?sleepMs=250`.
2. Run `/doc alpha beta gamma`.
3. Assert FSM: `idle -> running -> done`.
4. Assert text steps exactly frozen `0..8` names.
5. Assert artifacts exactly `raw,docir,chunk-index,memo`.
6. Run `/doc table|x.pdf`.
7. Assert additive OCR row metadata appears: `hard_pages`, `gate_reason_count`, `ocr_pages`, `ocr_failures`, `ocr_model`.
8. Assert no selector churn: `#conversation-plane,#execution-plane,#artifact-plane` remain.

### 3.2 QA Start Matrix

```bash
API=http://127.0.0.1:4010
# accept
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"source":"alpha","sleepMs":50}'
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"alpha"},"sleepMs":50}'
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/doc alpha","sleepMs":50}'
curl -sS -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"table|x.pdf","mime":"application/pdf"},"sleepMs":50}'

# reject
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"run","args":{"run_id":"x"}}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/run x"}'
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"x"},"ocrPolicy":{"engine":"ollama","model":"m","baseUrl":"http://127.0.0.1:1","timeoutMs":1,"maxPages":1}}'
```

Expected: accept => `202`; reject => `400 invalid_command`, `400 invalid_command`, `400 invalid_run_payload field=ocrPolicy.engine`.

### 3.3 Dedup Hash Scope Drill

```bash
WF=wf-$RANDOM
curl -sS -X POST $API/runs -H 'content-type: application/json' -d "{\"intent\":\"doc\",\"args\":{\"source\":\"one\"},\"workflowId\":\"$WF\",\"sleepMs\":5,\"useLlm\":false}" >/dev/null
curl -sS -i -X POST $API/runs -H 'content-type: application/json' -d "{\"intent\":\"doc\",\"args\":{\"source\":\"two\"},\"workflowId\":\"$WF\",\"sleepMs\":999,\"useLlm\":true}"
```

Expected: `409 workflow_id_payload_mismatch`.

### 3.4 Projection + Step Freeze Drill

```bash
RID=<text_run_id>
while :; do RUN=$(curl -sS "$API/runs/$RID"); ST=$(jq -r '.status' <<<"$RUN"); [[ "$ST" == done || "$ST" == error || "$ST" == unknown ]] && break; sleep 0.05; done
echo "$RUN" | jq '{run_id,status,dbos_status,keys:(keys|sort),steps:(.timeline|map({id:.function_id,name:.function_name}))}'
```

Must hold: frozen keys present; text lane remains `0..8` canonical map.

### 3.5 Hard-Doc OCR Step Visibility

```bash
RID=<harddoc_run_id>
curl -sS "$API/runs/$RID" | jq '{status,dbos_status,steps:(.timeline|map(.function_name)),ocr:(.timeline|map(select(.function_name|test("^ocr-"))|{name:.function_name,output:.output}))}'
```

Must include: `ocr-persist-gate`, `ocr-render-store-pages`, `ocr-pages`, `ocr-merge-diff`.

### 3.6 Export/Bundles/Sidecars

```bash
RID=<harddoc_run_id>
EXP=$(curl -sS "$API/runs/$RID/export")
echo "$EXP" | jq '{run_id,status,dbos_status,artifact_ids:(.artifacts|map(.id)),ocr:.ingest.ocr,run_bundle_path}'
B=$(echo "$EXP" | jq -r '.run_bundle_path')
ls -1 "$B" | sort | rg '^(ocr_pages\.json|ocr_report\.md|diff_summary\.md)$'
curl -sS "$API/runs/$RID/bundle" -o /tmp/r1.zip
curl -sS "$API/runs/$RID/bundle.zip" -o /tmp/r2.zip
sha256sum /tmp/r1.zip /tmp/r2.zip
```

Must hold: artifact ids still frozen quartet; ingest OCR tuple present; sidecar triad always present; zip aliases byte-identical.

### 3.7 DB Truth Join Kit

```bash
RID=<harddoc_run_id>
mise run psql -- -c "select workflow_uuid,status,name,recovery_attempts from dbos.workflow_status where workflow_uuid='${RID}';"
mise run psql -- -c "select function_id,function_name,output,error from dbos.operation_outputs where workflow_uuid='${RID}' order by function_id asc;"
mise run psql -- -c "select job_id,doc_id,ver,gate_rev,policy from ocr_job where job_id='${RID}';"
mise run psql -- -c "select page_idx,status,gate_score,jsonb_array_length(gate_reasons) gate_reason_count,png_sha,raw_sha from ocr_page where job_id='${RID}' order by page_idx asc;"
mise run psql -- -c "select source_job_id,page_idx,changed_blocks,page_diff_sha,diff_sha from docir_page_diff where source_job_id='${RID}' order by page_idx asc;"
```

### 3.8 Replay-Once OCR Effect Proof

```bash
RID=<harddoc_run_id>
mise run psql -- -c "select count(*) as n from side_effects where effect_key like '${RID}|ocr-page|%';"
mise run psql -- -c "select count(distinct effect_key) as d from side_effects where effect_key like '${RID}|ocr-page|%';"
```

Must hold: `n == d == ocr_pages_count`.

### 3.9 Hostile Fail-Closed Drills

```bash
curl --path-as-is -sS -i $API/runs/%2E%2E
curl --path-as-is -sS -i $API/runs/..%2Fx/export
curl --path-as-is -sS -i $API/artifacts/%2E%2E
curl -sS -i -X POST $API/runs/<done_run_id>/resume
```

Expected: typed invalid IDs, and `409 run_not_resumable`.

### 3.10 UI Protocol Drills

```bash
UI=http://127.0.0.1:4110
RID=<run_id>
curl -sS $UI/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' $UI/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' -H 'HX-History-Restore-Request:true' $UI/runs/$RID | head -n 5
curl -sS -H 'HX-Request:true' $UI/ui/runs/$RID/poll
```

Expected: full/fragment/full split; poll response atomically OOB-updates `#exec,#artifacts,#run-status`.

## 4. Proof Ladder (Gate Order)

```bash
mise run verify
mise run ui:e2e
mise run golden:record && mise run golden:diff
mise run bench:check
mise run showcase:002:signoff
mise run ci
```

Rules:
1. Stop on first red.
2. DB-reset lanes (`test:workflow`,`test:replay`,`test:idempotency`) stay sequential.
3. If `:8888` collision exists, keep paired override across the whole ladder.

## 5. Extension Recipes (Use, Don’t Improvise)

### 5.1 Add OCR telemetry field (safe additive)

1. Emit at producing step output in [`dbos-workflows.mjs`](/home/haris/projects/jejakekal/apps/api/src/dbos-workflows.mjs).
2. Thread into export summary extractor in [`ingest-summary.mjs`](/home/haris/projects/jejakekal/apps/api/src/export/ingest-summary.mjs).
3. Optionally show UI text in [`ui-view-model.mjs`](/home/haris/projects/jejakekal/apps/ui/src/ui-view-model.mjs) + [`ui-render.mjs`](/home/haris/projects/jejakekal/apps/ui/src/ui-render.mjs).
4. Keep projection keys unchanged.
5. Add tests: unit extractors + integration workflow + UI renderer.

### 5.2 Add OCR engine (currently blocked by law)

Current law is `vllm`-only. To expand:
1. Update parser whitelist in [`ocr/config.mjs`](/home/haris/projects/jejakekal/apps/api/src/ocr/config.mjs).
2. Keep IO contract identical in [`ocr/contract.mjs`](/home/haris/projects/jejakekal/apps/api/src/ocr/contract.mjs).
3. Guarantee deterministic normalization to existing patch schema.
4. Prove typed config-boundary failures for bad engine.
5. Update `AGENTS.md`, `.codex/rules/*`, `spec-0/00-learnings.jsonl`, `spec-0/05-tasks.jsonl`, `spec-0/05-tutorial.jsonl` in same change.

### 5.3 Add new hard-doc step

1. Insert only inside hard-doc hook (`runS4xAfterNormalize`) in [`dbos-workflows.mjs`](/home/haris/projects/jejakekal/apps/api/src/dbos-workflows.mjs).
2. Never renumber baseline text lane.
3. If ext IO exists, mint deterministic effect key in [`effect-key.mjs`](/home/haris/projects/jejakekal/apps/api/src/ingest/effect-key.mjs) and wrap with `callIdempotentEffect`.
4. Persist first, project second, UI last.
5. Add replay/idempotency tests for duplicate-write immunity.

### 5.4 Add new artifact type (forbidden by default)

Do not patch quickly. This is contract migration work:
1. Update frozen vocab in [`contracts.mjs`](/home/haris/projects/jejakekal/apps/api/src/contracts.mjs).
2. Update insert guard in [`artifacts/repository.mjs`](/home/haris/projects/jejakekal/apps/api/src/artifacts/repository.mjs).
3. Update export ordering in [`export-run.mjs`](/home/haris/projects/jejakekal/apps/api/src/export-run.mjs).
4. Update tests + tutorials + learnings + rules; ship migration proof.

## 6. Failure Map (Fast Triage)

1. Stack sick: `mise run up && mise run reset`; then inspect compose JSON and PG mount.
2. Filer drift: run `bash mise-tasks/internal/require-filer-pair`; fix env pair.
3. OCR red: `mise run wait:health -- ${OCR_BASE_URL:-http://127.0.0.1:8000}/health 30000 250`; prefer mock-backed signoff.
4. Poppler missing: install/point `PDFTOPPM_BIN`; expected error is explicit `missing pdftoppm (poppler-utils)`.
5. Export 5xx with persisted blobs: often correct fail-closed behavior (uri/sha/decode invariant fault).
6. Replay anomalies: audit effect-key formula + side_effect counts before touching workflow logic.

## 7. Change Discipline (Mandatory)

For any behavior delta, in same change:
1. Code + tests.
2. Update `spec-0/00-learnings.jsonl` (durable law/constraint only).
3. Update `spec-0/05-tasks.jsonl` (execution evidence).
4. Update `spec-0/05-tutorial.jsonl` (operator flow delta).
5. If new failure mode exists, update `.codex/rules/*`.

## 8. Single-Page Source Index

1. Laws + memory: [`AGENTS.md`](/home/haris/projects/jejakekal/AGENTS.md)
2. Sprint4 HTN: [`05-htn.jsonl`](/home/haris/projects/jejakekal/spec-0/05-htn.jsonl)
3. Sprint4 tasks ledger: [`05-tasks.jsonl`](/home/haris/projects/jejakekal/spec-0/05-tasks.jsonl)
4. Sprint4 tutorial deck: [`05-tutorial.jsonl`](/home/haris/projects/jejakekal/spec-0/05-tutorial.jsonl)
5. Durable laws: [`00-learnings.jsonl`](/home/haris/projects/jejakekal/spec-0/00-learnings.jsonl)
6. Workflow core: [`dbos-workflows.mjs`](/home/haris/projects/jejakekal/apps/api/src/dbos-workflows.mjs)
7. Run-start policy: [`runs-service.mjs`](/home/haris/projects/jejakekal/apps/api/src/runs-service.mjs)
8. OCR seams: [`apps/api/src/ocr/`](/home/haris/projects/jejakekal/apps/api/src/ocr)
9. Export path: [`export-run.mjs`](/home/haris/projects/jejakekal/apps/api/src/export-run.mjs)
10. UI contracts/rendering: [`apps/ui/src/`](/home/haris/projects/jejakekal/apps/ui/src)
11. Task graph: [`.mise.toml`](/home/haris/projects/jejakekal/.mise.toml)
