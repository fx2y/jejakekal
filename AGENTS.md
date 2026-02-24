# Jejakekal Policy SoT

Repo constitution. Bias: deterministic, fail-closed, persisted-first, additive, replay-safe.

## Authority (hard)

- Order: `AGENTS.md` (global law) > `.codex/rules/*` (scoped law) > `spec-*` logs (evidence/law history).
- Conflict rule: stricter wins; else preserve shipped public contract.

## Memory SoT (hard)

- One tracked repo-root memory file only: `AGENTS.md`.
- `CONTRIBUTING.md` / `HARNESS.md` are summaries.
- Operator-private prefs: untracked `AGENTS.local.md`.

## Command SoT (hard)

- Bootstrap: `mise install`.
- Dev loop/gate: `mise watch verify` / `mise run verify`.
- Release verdict (only): `mise run ci`.
- Stack ops: `mise run up|down|reset|psql`.
- First probe rule: `mise run wait:health -- <url> [timeoutMs intervalMs]`.
- Contract lanes: `ui:e2e`, `golden:record && golden:diff`, `bench:check`, `smoke:ingest`, `showcase:002:signoff`.
- Filer override law: `SEAWEED_FILER_PORT` and `BLOB_FILER_ENDPOINT` are paired+sticky across `up|reset|verify|ci|signoff`; never one-sided.

## Product/API Contracts (hard)

- Runtime truth: DBOS (`dbos.workflow_status`,`dbos.operation_outputs`) + persisted app rows; no shadow truth.
- Public API freeze: `/runs*`, `/artifacts*`, `/healthz`; `/api/*` resurrection forbidden.
- `/runs*` removal blocked before `2026-06-30`; after that needs explicit migration proof.
- Start normalize order is frozen: canonical `{intent,args}` -> slash `cmd` -> compat `{source}`; no default-source synthesis.
- Compat `{source}` window: `ALLOW_SOURCE_COMPAT_UNTIL` (default `2026-06-30`); post-window => typed `400 source_compat_expired`.
- Ingest lane rejects non-source commands/intents with canonical `400 invalid_command`.
- `workflowId` dedup hash scope is canonical `{intent,args}` only (exclude controls like `sleepMs`,`useLlm`); mismatch => `409 workflow_id_payload_mismatch`.
- Run projection frozen keys: `run_id,status,dbos_status,header,timeline` (additive-only enrichment).
- Artifact vocab frozen: `raw,docir,chunk-index,memo` (exact spelling).
- Chat plane is command ledger only: `cmd,args,run_id`; answer-text persistence/rendering is a contract violation.

## OCR Branch Contracts (hard)

- Default text lane step map is frozen (`0..8`: `reserve-doc`,`store-raw`,`DBOS.sleep`,`marker-convert`,`store-parse-outputs`,`normalize-docir`,`index-fts`,`emit-exec-memo`,`artifact-count`); never renumber.
- OCR branch must be additive (new `ocr-*` steps only).
- OCR policy/config resolves once at host/start boundary; deterministic snapshot; no ad-hoc step-level `process.env`.
- Engine surface is C3-frozen: `vllm` only (env + client payload); non-vllm fails at config/start boundary (`400 field=ocrPolicy.engine` on HTTP lane).
- Gate contract: `computeHardPages` is pure/order-stable/sparse-safe on canonical `page_idx`; emits deterministic `code_rev` + `gate_rev`.
- Render contract: if `hard_pages>0`, require source PDF and 1:1 valid rendered PNG rows; mismatch/malformed row is invariant error (no soft continue).
- OCR effect key freeze: `workflow|ocr-page|doc|ver|p<idx>|model|gate_rev|png_sha`.
- OCR persisted truth is first-class: `ocr_job`,`ocr_page`,`ocr_patch`,`docir_page_version`,`docir_page_diff` (append lineage; no shadow recompute).
- Merge contract: patched+changed gated pages only; deterministic dedupe/order/hashes; single-tx apply.
- Export/additive OCR surface: ingest summary carries `hard_pages,ocr_pages,ocr_failures,ocr_model,diff_sha`; sidecar triad always present (`ocr_pages.json`,`ocr_report.md`,`diff_summary.md`).

## Correctness/Security Doctrine (hard)

- Priority: invariants > determinism > compatibility > speed.
- Canonical shape: `parse -> validate -> normalize -> pure transform -> effect adapter -> canonical projection`.
- Core logic pure/replayable; effects only at boundaries through `callIdempotentEffect(effect_key, ...)` (per-key serialization + PG advisory lock).
- DBOS startup must be cross-process serialized (advisory lock around `DBOS.launch`; tolerate single duplicate-key retry race).
- Fail-closed matrix: typed `4xx` for client faults; opaque `internal_error` / invariant `5xx` for server/runtime faults.
- Security boundaries: treat raw path as hostile (`curl --path-as-is` parity), decode+allowlist IDs, resolve exports under root, split request-parse errors vs persisted-row invariant errors.
- Provenance boundary: IDs/hashes/keys only; raw input text excluded from control-plane outputs.

## Artifact/Blob/Bundle Contracts (hard)

- Persisted artifact rows are truth and append-only; supersede via new row only.
- Workflow terminal success requires persisted artifact count `>=1` (`FAILED_NO_ARTIFACT` if zero).
- Write boundary enforces frozen artifact vocab at insert time.
- Persisted blob readers must use stored `uri` + sha256 verification; unreadable/mismatch/bad sha/bad persisted URI => opaque `5xx`.
- URI allowlist: `bundle://`,`s3://`; strict parsing and trust-domain split.
- Bundle endpoints `/runs/:id/bundle` + `/runs/:id/bundle.zip` are deterministic aliases (byte-stable); manifest timestamps pin to run header `created_at` when present.
- Bundle storage root defaults to `.cache/run-bundles`; cleanup is explicit opt-in.

## UI/Host Contracts (hard)

- Frozen plane IDs: `#conversation-plane,#execution-plane,#artifact-plane`; aliases `#conv,#exec,#artifacts` are wrappers only.
- Run-status FSM: `idle|running|done|error`; unknown backend status maps terminal `error`.
- Host split: API host emits JSON truth; UI host emits HTML shell/fragments.
- UI full-shell rule: non-HX or HX-history-restore on UI host returns full shell.
- Poll truth path: `/ui/runs/:id/poll`; single response includes atomic OOB updates for `#exec,#artifacts,#run-status`.
- Resume control is explicit/fail-closed (show/allow only for `CANCELLED|RETRIES_EXCEEDED`).
- UI proxy for artifacts/bundle/download must be byte-safe and preserve `content-type` + `content-disposition`.
- Startup mode explicit: embedded API default; split mode=`UI_EMBED_API=0` + shared `API_PORT`; no double-bind.

## Coding Style Doctrine (hard)

- Seam-first additive design; do not fork baseline lanes when hooks/seams can compose.
- One module = one contract boundary; parse/validate at edge, keep interior pure.
- No hidden globals in deterministic lanes (`Date.now`,`Math.random`,`process.env` reads at boundary only).
- Encode invariants at write boundaries (DB insert/update seams), then assert at read/projection seams.
- Prefer explicit state machines and typed error families over boolean soup/stringly branching.
- Deterministic serialization/order/newline for canonical outputs; diff noise is a bug.
- Comments are for non-obvious invariants/tradeoffs only.

## Living-Spec Loop (mandatory per behavior delta)

- Ship behavior change with proof in same change.
- Durable law/constraint -> `spec-*/00-learnings.jsonl`.
- Execution/proof evidence -> active tasks log (`spec-*/01-tasks.jsonl` or cycle tasks file).
- UX/ops flow delta -> tutorial log (`spec-*/**/*tutorial.jsonl`).
- New failure mode -> new/updated `.codex/rules/*` in same change.
- Tutorial/signoff is a contract test; stop at first invariant break.

## Fast Triage

- Stack unhealthy: `mise run up && mise run reset`; inspect compose JSON (`jq -s`) and PG mount `/var/lib/postgresql`.
- Probe noise: gate with `mise run wait:health -- <url>`.
- `:8888` collision: set paired filer overrides and rerun core gates.
- Seaweed S3 auth errors: bootstrap IAM keypair, rerun reset.
- Replay/idempotency drift: audit deterministic clocks/random, checkpoint boundaries, effect keys, lock path.
- Export anomalies: missing/tampered persisted blob => expected opaque `5xx`; missing timeline source with persisted rows may still export `200`.
- Startup `dbos_migrations_pkey` duplicate: inspect DBOS launch lock path before retry.
- Golden drift: inspect intent; never blind re-record.
- CI/local mismatch: trust only `mise run ci`; delete shadow gate graphs.

## Imported Scoped Rules

@.codex/rules/00-global.md
@.codex/rules/10-tasking-ci.md
@.codex/rules/20-api-workflow-db.md
@.codex/rules/30-pipeline-bundle.md
@.codex/rules/40-sandbox.md
@.codex/rules/50-ui.md
@.codex/rules/60-tests-perf.md
