---
description: Sandbox executor safety + replay stability.
paths:
  - packages/core/src/sandbox-runner.mjs
  - packages/core/test/sandbox*.mjs
  - mise-tasks/sandbox/**
  - mise-tasks/chaos/**
---

# Sandbox Rules

- Sandbox is a strict executor contract, not an integration playground.
- Isolation baseline: `--network none`, read-only input mount, explicit writable export mount only, explicit workdir.
- Mount model is fixed: `/workspace/input` (ro) + `/workspace/export` (rw); reject writes outside declared export file.
- Env exposure is allowlist-only (default deny).
- Export filename/path must be explicit + validated; payload hash is contract output.
- Replay contract: same image+cmd+input+env allowlist => same payload hash.
- Sandbox behavior deltas require sandbox + chaos proof.

# Failure Recipes

- Hash mismatch for same input: remove env/time nondeterminism and unstable tool output.
- Exit 0 but missing export: verify export filename alignment and mount paths.
- CI flakes: verify image pin/availability; avoid mutable `latest` tags in tests.
