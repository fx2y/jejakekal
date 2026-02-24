---
description: Repo-wide engineering law (default unless stricter scoped rule applies).
---

# Global Rules

- Decision order: invariants > determinism > compatibility > speed.
- Change shape: seam-first, additive-first; no contract churn without explicit compat window + closure proof.
- Canonical architecture: `parse -> validate -> normalize -> pure transform -> effect adapter -> canonical projection`.
- Core lanes stay pure/replayable; effects only via named adapters.
- Deterministic lanes forbid ambient `Date.now`/`Math.random`/ad-hoc `process.env`.
- Parse env/config once at process/start boundary; pass explicit snapshots downstream.
- Fail-closed: typed `4xx` for client faults; opaque server faults for invariant/runtime breaks.
- Encode invariants at write boundaries, re-assert at read/projection boundaries.
- Frozen contracts must be enforced in constants + runtime guards + tests (comments are insufficient).
- Canonical outputs (JSON/text/bundle manifests) are stable-ordered + newline-terminated.
- `mise` command graph is execution/verdict SoT; shadow orchestrators are policy violations.
- Keep policy memory terse: durable laws in learnings, execution evidence in tasks/tutorial logs.

# Review Bar

- Reject hidden synthesis/fallback/recovery over invariant breaks.
- Reject behavior deltas without same-change proof + living-spec updates.
- Reject removals/migrations without date window + migration proof.
- Reject bugfixes lacking failing repro + regression test.
