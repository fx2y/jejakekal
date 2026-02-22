# ADR-001: Runtime Invariants as Product Contract (SoT Compression)

- Date: 2026-02-22
- Status: Accepted
- Scope: `spec-0/*` consolidation into executable architecture policy
- Sources: `spec-0/00-learnings.jsonl`, `spec-0/01-tasks.jsonl`

## TL;DR
System correctness == invariant preservation, not “feature seems fine”. Repo is designed so local dev, CI, replay, sandbox, golden, UI, perf all validate one contract: deterministic, resumable, idempotent workflow execution with artifact-first review.

## Context (why this ADR exists)
Spec-0 encoded many local decisions; risk is drift + tribal memory. This ADR compresses them into one enforceable model and maps each clause to shipped proof.

## Decision (normative)
1. Build/test command graph SoT is `.mise.toml`; host prerequisites are only `mise` + container runtime.
2. CI/local parity is strict: GitHub Action runs only `mise run ci`; any new quality gate must be included there.
3. Workflow runtime uses DBOS SDK as source of truth (`dbos.workflow_status` + `dbos.operation_outputs`) behind adapter boundary (`apps/api/src/workflow.mjs`).
4. External side effects must go through `callIdempotentEffect(effectKey, ...)`; raw effect calls are forbidden.
5. Workflow tests affecting behavior must freeze `Date.now` + `Math.random`.
6. Regression review unit is run-bundle/golden artifact diff; avoid opaque-only assertions.
7. Golden artifacts must be path/time neutral (`createdAt` normalized, stable manifest root/token, locale/tz-neutral).
8. Sandbox is strict deterministic executor contract: ro mount, explicit export path, env allowlist, stable payload hash.
9. UI e2e validates semantic IDs + state transitions (not pixels/screenshots).
10. Performance budgets are correctness gates; budget miss == failure.
11. Stack runtime uses compose postgres+blob wrappers (`up/down/reset/psql`), PG18 volume mount fixed to `/var/lib/postgresql`.
12. Operational memory split: `spec-0/01-tasks.jsonl` tracks execution/checklist state; `spec-0/00-learnings.jsonl` stores durable constraints/decisions only.

## Model (compressed architecture)
```text
Inputs -> Workflow Engine -> Deterministic Pipeline -> Run Bundle -> Golden/Review
            | dbos status+steps     | raw/docir/chunk-index/memo |
            | replay                | canonical JSON             +-> UI planes(state IDs)
            | idempotent effects    |                            +-> Perf gates
            +-> Sandbox executor (RO + explicit export + hash-stable)

Gate graph:
verify = lint + typecheck + unit + workflow
ci = verify + workflow/system gates + bench:check (+ others in .mise.toml)
CI action: ONLY `mise run ci`
```

## Walkthroughs (normative examples)
### 1) Replay + exactly-once effect
```js
await callIdempotentEffect(`send-email:${workflowId}:${stepId}`, async () => sendEmail(payload));
// crash after durable step write, before next step
// rerun same workflowId => resumes at next unfinished step; email not resent
```

### 2) Deterministic test scaffold
```js
const realNow = Date.now;
const realRand = Math.random;
Date.now = () => 1700000000000;
Math.random = () => 0.123456789;
// run workflow/replay test
Date.now = realNow;
Math.random = realRand;
```

### 3) Golden neutrality
```json
{
  "createdAt": "<normalized>",
  "manifestRoot": "<stable-token>",
  "timeline": ["...stable ordering..."]
}
```
Rule: re-record golden only after structural diff review confirms intentional behavior change.

### 4) Sandbox contract
```sh
sandbox-run \
  --read-only /input \
  --export /scratch/out.json \
  --env-allowlist "A,B,C"
```
Invariant: same input+allowlisted env => same payload hash + same exported structure.

### 5) UI behavior contract
```html
<div id="run-status" data-state="running"></div>
```
E2E asserts transitions, e.g. `idle -> running -> completed|failed`, using stable IDs/datasets.

## Evidence map (spec-0 tasks -> contract)
- Build/CI SoT/parity: `A1..A8`, `I1`, `FINAL`
- Stack lifecycle/health: `B1..B3`
- Workflow determinism/replay/idempotency: `C1..C5`
- Run bundle + golden stability: `D1..D3`
- Pipeline deterministic quartet: `E1..E3`
- Sandbox replay safety: `F1..F2`
- UI semantic e2e: `G1..G2`
- Perf budgets as gates: `H1..H2`
- Tool freshness flow: `I2`
- Process guardrails: `P1`
- Deferred/non-blocking: `BONUS1=partial` (MCP exposure)

## Consequences
- Pros: high confidence under crash/retry, minimal CI drift, reviewable behavior deltas, reproducible cross-machine outputs.
- Costs: stricter dev discipline (idempotency keys, determinism freezes, canonicalization burden), more upfront gate maintenance.
- Rejected shortcuts: host-installed `psql`, ad-hoc CI commands, pixel-based UI assertions, raw side effects.

## Operational checklist (for any behavior change)
1. Update tests and/or golden/perf evidence.
2. Update `spec-*/00-learnings.jsonl` for durable decision/constraint.
3. Update `spec-*/01-tasks.jsonl` execution state.
4. If new failure mode: add fix recipe in `.codex/rules/*`.

## Non-goals
- Not a DBOS-replacement plan.
- Not UX/style guidance.
- Not replacing existing AGENTS policy; this ADR is subordinate implementation architecture.

## File/ownership anchors
- Workflow boundary: `apps/api/src/workflow.mjs`
- Idempotent effects: `apps/api/src/effects.mjs`
- Bundle canon: `packages/core/src/run-bundle.mjs`
- Sandbox executor: `packages/core/src/sandbox-runner.mjs`
- Stack: `infra/compose/docker-compose.yml`, `mise-tasks/stack/*`
- CI entrypoint: `.github/workflows/ci.yml`, `.mise.toml`

## Decision test (quick)
If a proposed change cannot satisfy all below, reject/reshape:
- deterministic replay?
- exactly-once-effective side effects?
- artifact diff reviewability?
- ci/local parity via `mise run ci`?
- benchmark budget safety?
