---
description: Repo-wide coding + review policy.
---

# Global Rules

- Runtime baseline: Node ESM (`.mjs`) + JSDoc-typed JS (`checkJs` on); exported APIs need clear param/return contracts.
- Style baseline: deterministic data first, minimal magic, explicit I/O boundaries, no hidden global state.
- Keep side effects at edges; core transforms should be pure and replayable.
- Prefer stable schemas over clever abstractions; compatibility beats novelty.
- File outputs that feed tests/goldens must be canonical and newline-terminated.
- Never bypass `mise` entrypoints for official build/test verdicts.
- Additive change policy: do not break existing task names/contracts without paired migration + tests.
- Unknowns resolve by proving invariants in tests, not comments.

# Review Bar (opinionated)

- Reject code that cannot be replayed/diffed deterministically.
- Reject “fixes” without failure reproduction.
- Reject behavior changes lacking test/golden/perf proof.
- Favor small seams + adapters; avoid framework lock-in in core logic.
- Optimize for debuggability: explicit names, stable IDs, structured artifacts.
