---
description: Sandbox executor contract and replay stability.
paths:
  - packages/core/src/sandbox-runner.mjs
  - packages/core/test/sandbox*.mjs
  - mise-tasks/sandbox/**
  - mise-tasks/chaos/**
---

# Sandbox Rules

- Sandbox is a strict executor contract, not a general shell runtime.
- Isolation baseline: no network; explicit workdir; read-only input mount; explicit export mount only.
- Mount contract is frozen: `/workspace/input` (ro), `/workspace/export` (rw).
- Export path/filename must be explicit + validated; writes outside export root are rejected.
- Env exposure is allowlist-only (default deny).
- Replay contract: same image+cmd+input+env-allowlist => same payload hash.
- Behavior changes require sandbox + chaos proofs in release lanes.

# Failure Recipes

- Hash drift for same input: remove env/time nondeterminism.
- Exit 0 with no export: check export path contract + mount wiring.
- CI flakes: pin image/tool versions; avoid mutable tags.
