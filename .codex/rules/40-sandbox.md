---
description: Sandbox executor contract and replay stability.
paths:
  - packages/core/src/sandbox-runner.mjs
  - packages/core/test/sandbox*.mjs
  - mise-tasks/sandbox/**
  - mise-tasks/chaos/**
---

# Sandbox Rules

- Sandbox is strict executor contract; not a general shell runtime.
- Isolation baseline: no network, explicit workdir, read-only input mount, explicit writable export mount only.
- Mount contract is fixed: `/workspace/input` (ro), `/workspace/export` (rw).
- Export path/filename must be explicit and validated; writes outside export root are rejected.
- Environment exposure is allowlist-only (default deny).
- Replay contract: same image+cmd+input+env-allowlist => same payload hash.
- Sandbox behavior changes require sandbox + chaos proofs in release lanes.

# Failure Recipes

- Hash drift for same input: remove env/time nondeterminism.
- Exit 0 but no export: verify export path contract and mount wiring.
- CI flakes: pin image/tool versions; avoid mutable tags.
