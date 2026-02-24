# ADR-004: Sprint3 Ingest Constitution (C0-C7)

Status: Accepted (2026-02-23)
Scope: `spec-0/00-learnings.jsonl`, `spec-0/04-htn.jsonl`, `spec-0/04/*.jsonl`, `spec-0/04-tasks.jsonl`, `spec-0/04-tutorial.jsonl`

## 1. Decision (hard law)
Ship/operate ingest as deterministic DBOS workflow `S0..S6` over Seaweed-S3+PG+Marker, with frozen product contracts and fail-closed invariants. Internal refactors are allowed; public/API/UI semantics are additive-only.

## 2. Why (opinionated)
Any ambiguity in ingest truth creates silent corruption. Therefore:
- truth is persisted, not recomputed
- effects are idempotence-gated, not best-effort
- contracts are code-guarded, not doc-implied
- proofs are release criteria, not optional QA

## 3. Non-negotiables
- Command SoT: `mise`; release verdict: `mise run ci` only.
- Runtime truth: DBOS (`workflow_status`,`operation_outputs`) + persisted artifact/doc-ledger rows.
- API surface: `/runs*`,`/artifacts*`,`/healthz`; `/api/*` forbidden.
- Projection freeze: `run_id,status,dbos_status,header,timeline` (additive fields only).
- Artifact vocab freeze: `raw,docir,chunk-index,memo`.
- Chat plane: control ledger only (`cmd,args,run_id`), no answer-text storage.
- Security: hostile raw path, strict id allowlists, resolve-under-root exports.
- Compatibility dates: `{source}` + `/runs*` compatibility protected through 2026-06-30.

## 4. Architecture
See `docs/adr/004-sprint3-ingest-constitution/flow.mmd` and `contracts.mmd`.

Pipeline law:
`parse -> validate -> normalize -> pure transform -> effect adapter -> canonical projection`

Workflow law:
`reserve-doc -> store-raw -> DBOS.sleep -> marker-convert -> store-parse-outputs -> normalize-docir -> index-fts -> emit-exec-memo -> artifact-count`

## 5. Chosen bets (locked)
- A1 Blob truth path: Seaweed S3 PUT/HEAD/GET only; fid/volume primitives banned.
- A2 Topology: one-binary Seaweed now; split later.
- A3 Parser: pinned local Marker; hybrid OFF by default (`--use_llm=0`).
- A4 IR: persisted block-ledger DocIR v0 (`block_sha`, deterministic `block_id`).
- A5 Concurrency: serial per-doc (parallel only across docs).
- URI bridge: dual-read `bundle://` + `s3://`, strict sha verify.
- Memo encoding: keep `type=memo`, move content to deterministic markdown with block refs.
- FTS surface: internal-only verification; no new public route.

## 6. Invariants by subsystem
- Idempotency: all ext IO via `callIdempotentEffect(effect_key,...)`; forced retry must replay cached response.
- Effect key semantics: semantic identity only (`workflow|step|doc|ver|sha`), no time/attempt suffixes.
- Blob integrity: persisted reads must verify stored `sha256` hex64; malformed persisted URI/sha => opaque 5xx.
- Doc identity: `doc_id=doc-<raw_sha24>`, `ver=latest+1` atomically.
- Parse persistence: `parse/<doc>/<ver>/marker.{json,md}` + `chunks.json`; assets `asset/sha256/<sha>`.
- DocIR identity: `block_sha=sha256(stable_payload)`, `block_id=sha256(doc:ver:page:type:block_sha).slice(0,24)`.
- FTS: materialized `tsv` + `block_tsv_gin`; query via `@@` + `ts_rank` deterministic ordering.
- Bundle determinism: `/bundle` and `/bundle.zip` byte-stable; manifest time pinned to run header `created_at`.
- UI boundary: UI host returns HTML shells/fragments on top-level errors; JSON `internal_error` reserved to proxied API.

## 7. C7 hardening outcomes
- DBOS startup race closed via cross-process PG advisory lock around `DBOS.launch` + duplicate-migration retry.
- Replay nondeterminism closed by pinning S4->S5 pause control at workflow start input (not ambient env).
- Signoff destructiveness closed: preflight `:8888`, auto-apply paired override (`SEAWEED_FILER_PORT` + `BLOB_FILER_ENDPOINT`) across lifecycle commands.
- Release-signal gap closed: enforced signoff runs uncached `mise run --force ci`.
- Artifact list triage gap closed: list exposes `sha256`, digest parity with detail/provenance.

## 8. Walkthroughs (ultra-terse)
### 8.1 Happy ingest
1. POST `/runs` with canonical `{intent:"doc",args:{source:"..."}}`
2. Poll `/runs/:id` until terminal.
3. Assert timeline step order equals S0..S6+tail.
4. Assert artifacts exactly frozen vocab.
5. Export and compare `/bundle` vs `/bundle.zip` hashes.

### 8.2 Hostile inputs
- invalid JSON/body/id/path traversal => typed 4xx
- persisted malformed URI / digest mismatch => opaque 5xx
- workflowId payload mismatch => `409 workflow_id_payload_mismatch`
- non-source ingest commands (`/run`,`/open`) => typed reject

### 8.3 Port-collision-safe ops
If `:8888` busy, **never** partial override. Always pair:
```sh
SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888 mise run up
SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888 mise run reset
SEAWEED_FILER_PORT=18888 BLOB_FILER_ENDPOINT=http://127.0.0.1:18888 mise run ci
```

## 9. Verification contract
Gate ladder:
1. `mise run verify`
2. `mise run ui:e2e`
3. `mise run golden:record && mise run golden:diff`
4. `mise run bench:check`
5. `mise run ci` (sole release verdict)

`bench:check` is correctness gate, not advisory. Metrics must include real-path ingest/FTS/UI/resume signals.

## 10. Rejected alternatives
- Shadow orchestrator or app-level run truth.
- LIST-as-truth blob validation.
- Runtime fallback synthesis/default-source fabrication.
- New public FTS route in sprint3.
- Artifact type expansion beyond frozen vocab.
- Demo-only signoff not backed by machine evidence.

## 11. Consequences
Positive:
- deterministic replay/resume, byte-stable transport, strong ops triage, local/CI parity.

Costs:
- stricter failures (more typed/opaque errors), slower feature latitude, higher proof burden per behavior delta.

## 12. Change control
Any behavior delta is incomplete unless same change updates:
- proof/tests (or golden/perf where relevant)
- `spec-0/00-learnings.jsonl` (durable laws only)
- `spec-0/04-tasks.jsonl` (execution evidence)
- `spec-0/04-tutorial.jsonl` (operator flow changes)
- `.codex/rules/*` for new failure modes
