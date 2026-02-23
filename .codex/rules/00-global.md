---
description: Repo-wide engineering law (applies unless stricter scoped rule overrides).
---

# Global Rules

- Determinism first; convenience second.
- Prefer seam-first additive changes over broad rewrites.
- Keep core pure and replayable; isolate effects behind explicit adapters.
- Canonical code flow: `parse -> validate -> normalize -> pure transform -> effect adapter -> canonical projection`.
- No hidden mutable global state.
- Fail closed; never synthesize fallback data to hide invariant breaks.
- Typed `4xx` for client fault; opaque `internal_error` for server fault.
- Stable public contracts (keys/IDs/routes/task names) unless additive migration proof lands.
- Canonical JSON output: stable structure, newline-terminated; diff noise is a bug.
- Authoritative execution/test verdicts run through `mise` tasks only.

# Review Bar

- Reject nondeterministic behavior/diffs.
- Reject behavior deltas without executable proof.
- Reject migration/removal without explicit compat window + closure evidence.
- Reject fixes lacking repro + regression test.
