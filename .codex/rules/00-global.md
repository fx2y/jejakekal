---
description: Repo-wide coding + review policy.
---

# Global Rules

- Runtime baseline: Node ESM (`.mjs`) + JSDoc-typed JS (`checkJs` on); exported surfaces need explicit input/output contracts.
- Design baseline: deterministic-first, explicit I/O seams, no hidden mutable global state.
- Preferred code shape: `parse -> validate -> normalize -> pure transform -> effect adapter -> canonical projection`.
- Keep side effects at edges; core logic must replay from persisted inputs.
- No silent invariant-masking fallbacks; emit typed errors or fail fast.
- Canonicalize all artifact JSON used by tests/goldens (stable key order where relevant, newline-terminated).
- Never bypass `mise` for authoritative build/test verdicts.
- Compatibility over novelty: schema/route/task changes are additive unless explicit migration lands with tests.
- Resolve uncertainty with proofs (tests/golden/perf), not comments.

# Review Bar (opinionated)

- Reject non-replayable behavior or nondeterministic diffs.
- Reject fixes without reproduction + regression proof.
- Reject behavior deltas without test/golden/perf evidence.
- Reject broad rewrites where seam-level adapters suffice.
- Require debuggable artifacts: stable IDs, typed errors, structured outputs.
