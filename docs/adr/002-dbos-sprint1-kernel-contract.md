# ADR 002: DBOS Sprint1 Kernel Contract (Hard Freeze)

- Status: Accepted
- Date: 2026-02-22
- Owners: API+UI+Core+Ops
- Scope: `spec-0/02` Sprint1 only

## Thesis
`DBOS` is the run OS. `dbos.workflow_status` + `dbos.operation_outputs` are sole execution truth. API/UI/export/proofs are projections of that truth. Anything else is compatibility scaffolding, then deletion.

## Why this ADR exists
Spec artifacts converged on one recurring failure mode: drift via duplicate truths (custom workflow tables, shadow CI graphs, path aliases, heuristic UI completion, fallback synthesis). Sprint1 exits only if drift vectors are closed, not “managed”.

## Decision (opinionated, non-negotiable)
1. Canonical surface is `/runs*` + `/healthz`; `/api/*` is migration-only and now prunable.
2. Start semantics are durable-async: `POST /runs` returns after durable start (`202`), never after completion.
3. Projection semantics are DBOS-native: `GET /runs/:id` = mapped `status` + raw `dbos_status` + header + `function_id`-ordered timeline.
4. Exactly-once-effective side effects only via `callIdempotentEffect(effect_key, ...)` with per-key serialization + advisory lock.
5. Fail closed: invalid/hostile input => typed `4xx`; server faults => opaque `500 internal_error`; unrecoverable export source => `422 source_unrecoverable` (no synthetic fallback).
6. Determinism is correctness, not style: freeze wall-clock/random in workflow tests; use monotonic time for timeouts.
7. Bundle contract is stable-v0+additive snapshots: keep canonical JSON, normalized roots/times, additive `workflow_status.json` + `operation_outputs.json`.
8. CI authority is singular: release verdict = `mise run ci` only.

## Constraints frozen from learnings/HTN/tasks/tutorial
- Host deps minimal: `mise` + container runtime.
- DB ops via stack wrappers; no host `psql` assumption.
- PG18 mount is `/var/lib/postgresql`.
- Sandbox contract strict: RO input + explicit RW export only.
- UI contract API = IDs/FSM, not pixels: `#run-status[data-state]` in `idle|running|done|error`.
- Artifact vocabulary canonicalized: `raw,docir,chunk-index,memo`.
- Run-id boundary hardened: raw path parse, decode+allowlist, resolve-under-root guard.
- Workflow ID dedup is strong claim, not alias: payload hash mismatch => `409 workflow_id_payload_mismatch`.

## Architecture (seams, not rewrites)
```text
Client/UI
  -> POST /runs -------------------------------> DBOS startWorkflow (durable)
  -> GET /runs/:id ----------------------------> SQL projections from dbos.*
  -> GET /runs/:id/export ---------------------> run-bundle writer (+dbos snapshots)

DBOS tables (truth):
  dbos.workflow_status      (run header/lifecycle)
  dbos.operation_outputs    (step timeline, output/error, function_id order)

App tables (non-truth):
  side_effects              (idempotent effect ledger)
  workflow_input_claims     (caller workflowId hash claim)
```

```mermaid
flowchart LR
  A[POST /runs] --> B[DBOS.startWorkflow]
  B --> C[(dbos.workflow_status)]
  B --> D[(dbos.operation_outputs)]
  C --> E[GET /runs/:id projection]
  D --> E
  E --> F[UI execution plane]
  C --> G[/runs/:id/export]
  D --> G
  G --> H[run bundle + additive snapshots]
```

## Cycle compression (C0->C5 distilled)
1. `C0`: Freeze seams, freeze bets, avoid runtime churn.
2. `C1`: Swap substrate to DBOS runtime/facade; delete app-owned workflow truth.
3. `C2`: Ship canonical `/runs` durable-start + DBOS projections + status mapping.
4. `C3`: Rewire UI execution plane + export DBOS snapshot bundle; preserve DOM/FSM contracts.
5. `C4`: Prove durability (kill-9), retry/backoff, CLI/API parity, determinism discipline.
6. `C5`: Harden shutdown/cleanup, prune compat surface, enforce gates/log updates.

## Operational truth table
| Concern | Required behavior | Anti-pattern (forbidden) |
|---|---|---|
| Start | `POST /runs` returns durable handle | sync run-to-completion |
| Timeline order | sort by `function_id` | insertion/arrival heuristics |
| Side effects | idempotent wrapper + lock | direct external call in workflow path |
| Export | deterministic snapshot, no synthesis | default/fake source fallback |
| Errors | typed 4xx, opaque 500 | stack traces/contracts leaked |
| CI | `mise run ci` only | duplicated gate DAGs |
| UI | ID/FSM assertions | pixel snapshots as contract |

## Canonical snippets
```js
// durable start
const start = DBOS.startWorkflow(DefaultWf, opts);
const h = await start(input);
return { run_id: h.workflowID, status: 'running' };
```

```sql
select workflow_uuid,status,name,recovery_attempts,executor_id
from dbos.workflow_status where workflow_uuid=$1;

select function_id,function_name,started_at_epoch_ms,completed_at_epoch_ms,output,error
from dbos.operation_outputs where workflow_uuid=$1 order by function_id asc;
```

```js
await callIdempotentEffect(pg, `${workflowId}:side-effect:email`, effectFn);
```

## Proof obligations (release-blocking)
- Kill-9 mid-sleep resumes from last completed step without duplicate completed-step execution.
- Durable-start survives immediate post-`202` crash.
- Retry/backoff behavior proven via DBOS step config, not manual loops.
- CLI (`dbos workflow get/steps`) semantically matches `/runs/:id` projection.
- Hostile-path and malformed-input contracts emit typed failures (`invalid_json`, `invalid_run_id`, mismatch `409`, export `422`).
- `ui:e2e`, golden, perf budgets, sandbox chaos, workflow/idempotency/replay all transitively green under `mise run ci`.

## Consequences
- Good: single truth source; deterministic audits; lower migration entropy; less hidden coupling.
- Cost: stricter run-id and payload contracts can reject historically tolerated junk.
- Cost: local/proof harnesses must honor boot/shutdown/readiness rigor.
- Cost: contributors lose “quick hacks” (sync handlers, fallback synthesis, ad-hoc CI commands).

## Rejected alternatives
- Keep custom workflow tables as “cache”: rejected (dual truth drift).
- Keep `/api/*` indefinitely: rejected (contract ambiguity, test split-brain).
- Use pixel e2e as acceptance: rejected (style churn noise).
- Treat perf as advisory: rejected (perf regressions are correctness regressions).

## Guardrails for future ADRs
- Additive migrations only.
- No new surface without proof lane + spec-loop logs (`00-learnings`, `02-tasks`, tutorial/rules when applicable).
- Any exception must state expiry cycle/date and removal owner.
