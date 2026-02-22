# Jejakekal Policy SoT

Repo memory SoT for humans+agents.
Hard meta-rules:
- Keep exactly one git-tracked repo-root memory file: `AGENTS.md`.
- `CONTRIBUTING.md`/`HARNESS.md` are summaries, never authority.
- Private prefs live in untracked `AGENTS.local.md`.

## Command SoT (hard)

- Bootstrap: `mise install`
- Inner loop: `mise watch verify` (or narrower watch task)
- Quick gate: `mise run verify` (`lint`,`typecheck`,`test:unit`,`test:workflow`)
- Release verdict: `mise run ci` (only)
- Stack ops: `mise run up|down|reset|psql`
- Golden: `mise run golden:record && mise run golden:diff`
- UI behavior: `mise run ui:e2e`
- Perf budget: `mise run bench:check`
- CI parity: GH Action must execute `mise run ci` only

## Engineering Doctrine (hard, opinionated)

- Determinism > convenience.
- Core is pure; effects at boundaries only.
- Behavior contract beats implementation style; preserve public keys/IDs/routes unless migrated additively.
- Fail closed: no silent fallback data synthesis for broken invariants.
- Typed client errors (`4xx`) for client faults; server faults stay opaque (`internal_error`).
- Exactly-once-effective side effects only via `callIdempotentEffect(effectKey, ...)` (serialized + locked).
- Durability is non-optional: checkpointed steps, replay, crash-resume from last completed step.
- Security baseline: strict run-id parsing/allowlist, raw-path hostile handling, export write confined under bundle root.
- Sandbox is strict executor contract, not general shell.
- Perf caps are correctness caps.

## Coding Style (hard)

- Pipeline shape: `parse -> validate -> normalize -> pure transform -> effect adapter -> canonical projection`.
- Name things by domain + unit (`*_ms`, `workflow_id`, `effect_key`), never vague aliases.
- Prefer small composable modules with explicit I/O; reject hidden global mutable state.
- Use additive migrations, not big-bang rewrites; keep compatibility windows explicit+time-boxed.
- Keep JSON outputs canonical/stable/newline-terminated; diff noise is a bug.

## Product Contracts To Freeze

- API: canonical `/runs*` + `/healthz`; no `/api/*` resurrection.
- Run payload: stable keys (`run_id,status,dbos_status,header,timeline`), export adds `artifacts` + `run_bundle_path`.
- UI: fixed plane IDs + `#run-status[data-state]` FSM (`idle|running|done|error`).
- Artifact vocabulary: `raw,docir,chunk-index,memo` (`chunk-index` only).
- Run bundle: fixed v0 set + additive DBOS snapshots; normalized root/time for cross-machine diffs.
- Workflow truth: DBOS tables (`dbos.workflow_status`, `dbos.operation_outputs`); projections must honor DBOS shape quirks.

## Living-Spec Loop (mandatory per behavior delta)

- Ship proof with change (test and/or golden and/or perf).
- Update durable decisions in `spec-*/00-learnings.jsonl`.
- Update execution ledger in `spec-*/01-tasks.jsonl` or active cycle tasks file (e.g. `spec-0/02-tasks.jsonl`).
- Update operator recipe when UX/ops flow changes (`spec-*/02-tutorial.jsonl` when present).
- New failure mode => new rule/recipe in `.codex/rules/*` in same change.
- Behavior-changing PR without proof+log updates is incomplete.

## Triage First Moves

- PG unavailable: `mise run up && mise run reset`.
- Stack unhealthy: `docker compose -f infra/compose/docker-compose.yml ps --format json | jq -s`; verify health + PG mount `/var/lib/postgresql`.
- Replay/idempotency flake: check determinism freeze, checkpoint writes, effect-key composition/lock path.
- Hostile path probe false negatives: use `curl --path-as-is` for encoded dot-segments.
- Golden drift: verify structural intent; never blind re-record.
- Sandbox hash drift: remove nondeterministic env/output/time leakage.
- CI/local mismatch: rerun only `mise run ci`; delete shadow command graphs.

## Imported Scoped Rules

@.codex/rules/00-global.md
@.codex/rules/10-tasking-ci.md
@.codex/rules/20-api-workflow-db.md
@.codex/rules/30-pipeline-bundle.md
@.codex/rules/40-sandbox.md
@.codex/rules/50-ui.md
@.codex/rules/60-tests-perf.md
