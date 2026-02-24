---
description: Sandbox executor contract and replay stability.
paths:
  - packages/core/src/sandbox-runner.mjs
  - packages/core/test/sandbox*.mjs
  - mise-tasks/sandbox/**
  - mise-tasks/chaos/**
---

# Sandbox Rules

- Sandbox is an executor contract, not a general shell.
- Isolation baseline: no network, explicit workdir, read-only input mount, explicit export mount only.
- Mount API is frozen: `/workspace/input` (ro), `/workspace/export` (rw).
- Export path must be explicit+validated; writes outside export root are rejected.
- Env exposure is allowlist-only (default deny).
- Replay contract: same image+cmd+input+env-allowlist => same payload hash.
- Behavior deltas require sandbox + chaos proofs in release lanes.

# Failure Recipes

- Same-input hash drift: remove env/time nondeterminism.
- Exit 0 with no export: verify export contract + mount wiring.
- CI flakes: pin images/tool versions; avoid mutable tags.
