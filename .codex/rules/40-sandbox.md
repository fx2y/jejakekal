---
description: Sandbox executor safety + replay stability.
paths:
  - packages/core/src/sandbox-runner.mjs
  - packages/core/test/sandbox*.mjs
  - mise-tasks/sandbox/**
  - mise-tasks/chaos/**
---

# Sandbox Rules

- Sandbox is a strict executor, not a feature playground.
- Must run isolated: `--network none`, `--read-only`, scratch mount only, explicit workdir.
- Env exposure is allowlist-only; default deny.
- Export path must be explicit and deterministic; payload hash is contract output.
- Replay safety: same request (image/command/input/env allowlist) => same payload hash.
- Chaos tests are mandatory for sandbox behavior changes.

# Failure Recipes

- Hash mismatch across same input: remove nondeterministic tool output and env/time leakage.
- Missing output file with exit 0: check command/export filename alignment and mount path.
- Sandbox flake in CI: verify container image pin/availability and avoid mutable latest tags in tests when possible.
