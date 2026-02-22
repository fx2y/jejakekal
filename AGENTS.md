# Jejakekal Policy SoT

Authoritative repo policy/workflow/invariants for agents + humans. Keep exactly one git-tracked repo-root memory file (`AGENTS.md`). Treat `CONTRIBUTING.md`/`HARNESS.md` as summaries, not policy sources. Use `AGENTS.local.md` for private prefs only.

## Build/Run Entry Points (hard)

- Bootstrap: `mise install`
- Fast dev loop: `mise watch verify` (or narrower watch task)
- Quick gate: `mise run verify` (`lint` + `typecheck` + `test:unit` + `test:workflow`)
- Full gate (only release verdict): `mise run ci`
- Stack lifecycle: `mise run up`, `mise run down`, `mise run reset`, `mise run psql`
- Golden workflow: `mise run golden:record` then `mise run golden:diff`
- UI behavior gate: `mise run ui:e2e`
- Perf gate: `mise run bench:check`

## Non-Negotiable Invariants

- Host deps stay narrow: only `mise` + container runtime; never require host `psql`/tool drift.
- `.mise.toml` is build/test SoT; do not add parallel command graphs elsewhere.
- CI/local parity is absolute: GH Action runs `mise run ci` only.
- Workflow engine remains DBOS-shaped: deterministic replay, checkpointed steps, crash-resume from last completed step.
- Side effects are exactly-once-effective via `callIdempotentEffect(effectKey, ...)`; never call external effects raw.
- Every workflow test that touches behavior must freeze `Date.now` + `Math.random`.
- Regressions are reviewed via artifacts/run-bundle diff, not opaque assertion text.
- Golden bundle diffs must be path/time neutral (`createdAt`, roots, locale/timezone stability).
- Sandbox contract is strict executor semantics: `--read-only`, explicit export file, env allowlist, deterministic payload hash.
- UI e2e asserts IDs + state transitions, never pixel snapshots.
- Performance budget misses are correctness failures.
- Any new gate belongs in `mise run ci`; nowhere else.

## State + Content Patterns

- API workflow response contract: timeline + artifacts + run-bundle path; preserve stable keys/names.
- UI state machine lives in DOM IDs/datasets (`#run-status[data-state]`), planes are fixed IDs.
- Pipeline outputs are deterministic quartet: raw, docir, chunk-index, memo.
- JSON artifacts are canonicalized/stable (sorted objects where relevant, newline-terminated files).

## Living Spec Loop (mandatory on every behavior change)

- Ship proof with change: test delta and/or golden delta and/or perf budget delta.
- Update learnings log for durable decisions/constraints: `spec-*/00-learnings.jsonl`.
- Update checklist state for execution status: `spec-*/01-tasks.jsonl`.
- If a new failure mode appears, codify fix recipe in `.codex/rules/*` (not tribal memory).
- PRs with behavior deltas but no proof/log updates are incomplete.

## Failure Triage (first moves)

- `postgres unavailable` in tests: `mise run up` then `mise run reset`.
- `stack did not become healthy`: inspect `docker compose ... ps --format json | jq -s`; verify health + PG volume mount path (`/var/lib/postgresql`).
- Replay/idempotency flake: verify determinism freeze + step checkpoint writes + idempotency key composition.
- Golden mismatch: confirm only intentional structural diff; re-record only after review.
- Sandbox chaos hash drift: remove nondeterministic output/env leakage, enforce identical input->output.
- CI pass local fail (or inverse): rerun only via `mise run ci`; remove ad-hoc command paths.

## Imported Scoped Rules

@.codex/rules/00-global.md
@.codex/rules/10-tasking-ci.md
@.codex/rules/20-api-workflow-db.md
@.codex/rules/30-pipeline-bundle.md
@.codex/rules/40-sandbox.md
@.codex/rules/50-ui.md
@.codex/rules/60-tests-perf.md
