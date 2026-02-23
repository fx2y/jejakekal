---
description: Repo-wide engineering law (default unless stricter scoped rule applies).
---

# Global Rules

- Determinism first; convenience second; hidden fallback never.
- Prefer seam-first additive change; preserve stable contracts unless explicit compat plan lands.
- Keep core pure/replayable; isolate effects behind explicit adapters.
- Canonical flow: `parse -> validate -> normalize -> pure transform -> effect adapter -> canonical projection`.
- No hidden mutable globals; no ambient time/random in deterministic lanes.
- Fail closed: typed `4xx` for client fault; opaque server error for invariant/runtime fault.
- Codify frozen contracts in code constants + runtime guards + tests (not comments only).
- Canonical JSON/text outputs are stable-ordered and newline-terminated; diff noise is a bug.
- Use `mise` tasks as execution/test verdict SoT; avoid ad-hoc parallel command graphs.
- Optimize for compounding handoff: record durable law once, evidence elsewhere.

# Review Bar

- Reject nondeterminism, hidden synthesis, or silent recovery across invariant breaks.
- Reject behavior deltas without proof and living-spec log updates.
- Reject removals/migrations without explicit window + closure proof.
- Reject fixes without repro + regression coverage.
