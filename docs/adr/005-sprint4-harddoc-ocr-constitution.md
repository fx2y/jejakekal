# ADR-005: Sprint4 Hard-Doc OCR Constitution (C0-C7 + Audit + Live005)

Status: Accepted (2026-02-24)
Scope: `spec-0/00-learnings.jsonl`, `spec-0/05-htn.jsonl`, `spec-0/05/*.jsonl`, `spec-0/05-tasks.jsonl`, `spec-0/05-tutorial.jsonl`

## 1. Decision (hard)
Ship hard-doc OCR as additive branch only (`gate -> render -> ocr -> merge`) under persisted-first truth, exact-once-effective IO, frozen public/UI contracts, and fail-closed runtime behavior. Baseline text lane (`0..8`) is constitutionally immutable.

## 2. Thesis (opinionated)
The only acceptable OCR feature is one that cannot lie.
- If it cannot be replayed deterministically, it is wrong.
- If it is not persisted as first-class truth, it is a cache bug.
- If it mutates frozen API/UI contracts, it is rejected.
- If an outage can crash host process, it is a design failure.

## 3. Constitutional lock set
- Command SoT: `mise` only. Dev gate=`mise run verify`; release verdict=`mise run ci` only.
- Runtime truth: DBOS (`workflow_status`,`operation_outputs`) + persisted app rows; no shadow truth.
- Public API freeze: `/runs*`,`/artifacts*`,`/healthz`; `/api/*` forbidden.
- `/runs*` protected through `2026-06-30`; compat `{source}` default sunset `2026-06-30` (`400 source_compat_expired` post-window).
- Start normalize order frozen: canonical `{intent,args}` -> slash `cmd` -> compat `{source}`; no default-source synthesis.
- Ingest reject law: non-source intents/commands => typed `400 invalid_command`.
- Dedup law: `workflowId` mismatch hash scope=`{intent,args}` only; mismatch=>`409 workflow_id_payload_mismatch`.
- Run projection freeze: `run_id,status,dbos_status,header,timeline` (additive enrichment only).
- Artifact vocab freeze (write+read): `raw,docir,chunk-index,memo`.
- Chat plane law: command ledger only (`cmd,args,run_id`), no answer text persistence.

## 4. Branch architecture (additive, seam-first)
See: `docs/adr/005-sprint4-harddoc-ocr-constitution/flow.mmd`, `contracts.mmd`.

Pipeline law:
`parse -> validate -> normalize -> pure transform -> effect adapter -> canonical projection`

Workflow law:
- Baseline text lane frozen: `0 reserve-doc,1 store-raw,2 DBOS.sleep,3 marker-convert,4 store-parse-outputs,5 normalize-docir,6 index-fts,7 emit-exec-memo,8 artifact-count`
- OCR branch additive: `ocr-persist-gate -> ocr-render-store-pages -> ocr-pages -> ocr-merge-diff`

Seams:
- `gate-core` (pure deterministic scorer)
- `pdf-render/render-seam` (adapter; strict index translators)
- `engine-seam` (vLLM-only C3 surface)
- `merge-core` (pure plan) + tx apply seam
- `default-text-lane` with optional post-normalize hook (no lane copy-fork)

## 5. OCR laws by cycle (compressed)
- C0: froze API/UI contracts + extracted seams + centralized OCR policy resolver + prewired OCR tables/repo.
- C1: `computeHardPages` deterministic (`hard_pages`,`score_by_page`,`reasons`,`code_rev`,`gate_rev`); persisted gate truth in `ocr_job`/`ocr_page`; baseline lane unchanged.
- C2: rendered selected pages via `pdftoppm`; internal page index canonical `0`-based; persisted PNG truth in `ocr_page`; poppler contract explicit.
- C3: strict OCR IO contract; vLLM adapter; per-page effect key frozen `workflow|ocr-page|doc|ver|p<idx>|model|gate_rev|png_sha`; raw OCR blobs + `ocr_patch` persisted; non-vllm rejected.
- C4: deterministic merge plan (`patched+changed gated pages only`), one-tx apply + lineage (`docir_page_version`,`docir_page_diff`), additive sidecar triad, memo/export OCR summary additive.
- C5: `/runs` hard-doc routing additive on PDF signal; deterministic hard-doc workflow id seed; timeout budget plumbed via start seam; replay/cancel-resume proves no duplicate OCR effects.
- C6: UI execution plane surfaces OCR telemetry additively; export ingest includes `hard_pages,ocr_pages,ocr_failures,ocr_model,diff_sha`; SQL operator kit codified.
- C7: readiness gates + poppler preflight reuse + OCR perf budgets (`ocr_gate_ms,ocr_page_p95_ms,ocr_merge_ms,ocr_wall_ms`) + signoff invariants.

## 6. Persisted truth schema (first-class OCR)
- `ocr_job(job_id,doc_id,ver,gate_rev,policy,...)`
- `ocr_page(job_id,page_idx,status,gate_score,gate_reasons,png_uri,png_sha,raw_uri,raw_sha,...)`
- `ocr_patch(doc_id,ver,page_idx,patch_sha,...)` append-only
- `docir_page_version(...)` lineage
- `docir_page_diff(source_job_id,page_idx,before_sha,after_sha,changed_blocks,page_diff_sha,diff_sha,...)`

Truth rule: runtime consumers read rows; never recompute gate/merge truth from transient adapter payloads.

## 7. Invariant matrix (fail-closed)
See: `docs/adr/005-sprint4-harddoc-ocr-constitution/failure-matrix.md`.

Key hard-fails:
- `hard_pages>0` and missing source PDF => invariant error.
- rendered row count/shape mismatch for requested hard pages => invariant error.
- malformed OCR row => invariant error (no synthetic empty patch).
- unknown artifact type at insert => reject at write boundary.
- blob unreadable/sha mismatch/bad persisted URI => opaque `5xx`.
- OCR transport faults normalize to `ocr_endpoint_unreachable`; workflow emits sanitized step error; host must survive.

## 8. Determinism recipes
- Gate ordering: score desc, then page idx asc; sparse page_idx-safe.
- Render index policy: internal `page_idx0`; adapters use `toPdfPageIndex()/toPageIdx0()` only.
- Merge ordering: deterministic dedupe on `block_sha`,`source_rank`,`block_id`.
- Hashes: explicit `code_rev`,`gate_rev`,`page_diff_sha`,`diff_sha`.
- Bundle determinism: `/runs/:id/bundle` and `/runs/:id/bundle.zip` byte-stable aliases.
- Sidecar determinism: always emit triad `ocr_pages.json`,`ocr_report.md`,`diff_summary.md` (explicit no-diff payload if needed).

## 9. Security/provenance boundary
- Raw path hostile parity (`curl --path-as-is`), strict ID allowlist decode.
- Export resolve-under-root.
- Parse/request faults => typed `4xx`; persisted-row invariant faults => opaque `5xx`.
- Provenance in control-plane outputs is IDs/hashes/keys; raw source text redacted from timeline (`reserve-doc.output.source` stripped).

## 10. Live005/audit closures (normative)
- Closed ops drift: paired filer override now honored by top-level `mise` flow; no wrapper bypass.
- Closed crash class: OCR endpoint outage no longer crashes API process; normalized sentinel emitted.
- Closed QA drift: reject-matrix docs/scripts pin current error envelope parsing (`.error` string form) until explicit schema migration.
- Closed scenario fragility: signoff deck reordered; baseline contract probes precede OCR tranche; OCR readiness gate mandatory before hard-doc run.

## 11. Walkthroughs (operator-short)
### 11.1 Fast value path
1. `mise install && mise run up && mise run reset`
2. `mise run wait:health -- http://127.0.0.1:4010/healthz 15000 100`
3. `POST /runs` text source; verify timeline is baseline `0..8` and artifacts frozen quartet.
4. `mise run wait:health -- ${OCR_BASE_URL:-http://127.0.0.1:8000}/health 30000 250`
5. `POST /runs` hard-doc (`source/locator *.pdf` or `mime=application/pdf`); verify OCR steps visible.
6. `GET /runs/:id/export`; verify additive `ingest.ocr` tuple + sidecar triad + bundle zip hash identity.

### 11.2 Reject matrix (canonical)
```sh
curl -i -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"run","args":{"run_id":"x"}}'   # 400 invalid_command
curl -i -X POST $API/runs -H 'content-type: application/json' -d '{"cmd":"/run x"}'                                  # 400 invalid_command
curl -i -X POST $API/runs -H 'content-type: application/json' -d '{"intent":"doc","args":{"source":"x"},"ocrPolicy":{"engine":"ollama","model":"m","baseUrl":"http://127.0.0.1:1","timeoutMs":1,"maxPages":1}}'  # 400 invalid_run_payload field=ocrPolicy.engine
```

### 11.3 Dedup scope proof
```sh
WF=wf-$RANDOM
curl -sS -X POST $API/runs -H 'content-type: application/json' -d "{\"intent\":\"doc\",\"args\":{\"source\":\"one\"},\"workflowId\":\"$WF\",\"sleepMs\":5,\"useLlm\":false}" >/dev/null
curl -i  -X POST $API/runs -H 'content-type: application/json' -d "{\"intent\":\"doc\",\"args\":{\"source\":\"two\"},\"workflowId\":\"$WF\",\"sleepMs\":999,\"useLlm\":true}"   # 409 workflow_id_payload_mismatch
```

### 11.4 Replay-once OCR effect proof
```sql
select count(*) n from side_effects where effect_key like '<run_id>|ocr-page|%';
select count(distinct effect_key) d from side_effects where effect_key like '<run_id>|ocr-page|%';
-- invariant: n=d=ocr_pages_count
```

### 11.5 :8888 collision-safe bootstrap
```sh
SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888 mise run up
SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888 mise run reset
SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888 mise run ci
```

## 12. Release proof ladder (non-negotiable)
1. `mise run verify`
2. `mise run ui:e2e`
3. `mise run golden:record && mise run golden:diff`
4. `mise run bench:check`
5. `mise run ci` (sole release verdict)

## 13. Deferred bets (strict boundaries)
- Bet0 shipped (mandatory): page OCR branch end-to-end.
- Bet1 optional toggle: table rescue pre-pass.
- Bet2 optional toggle: engine fallback fanout (currently blocked by C3 freeze; runtime surface remains vLLM-only).
- Bet3 deferred: region OCR forbidden until deterministic geometry proof exists.

Bet orthogonality law: toggles may alter adapter internals only; never `/runs` core payload contract, artifact vocab, or UI plane IDs.

## 14. Consequences
Good:
- deterministic replay, auditable OCR lineage, stable external contracts, resilient signoff signal.

Cost:
- stricter typed/opaque failures, higher proof burden, reduced “move fast” latitude.

## 15. Change-control law
Behavior delta is incomplete unless same change updates proof + logs:
- `spec-0/00-learnings.jsonl` (durable laws)
- `spec-0/05-tasks.jsonl` (execution evidence)
- `spec-0/05-tutorial.jsonl` (operator flow)
- `.codex/rules/*` for new failure modes
