---
description: Task graph and CI parity law.
paths:
  - .mise.toml
  - mise-tasks/**
  - .github/workflows/**
  - scripts/**
---

# Task/CI Rules

- `.mise.toml` is task-graph SoT; avoid shadow command graphs.
- Release verdict is `mise run ci` only; CI workflow calls only that entrypoint.
- `verify` remains fast dev gate; do not smuggle release-only checks outside `ci`.
- Expensive tasks must declare incremental `sources`/`outputs`.
- Task wrappers stay thin, strict, non-interactive (`set -euo pipefail`).
- Host deps stay minimal (`mise` + container runtime); DB ops via `mise run psql`.
- Gate early probes with `mise run wait:health -- <url>` to avoid boot-noise false failures.
- `ui:e2e`, golden, replay/idempotency, perf checks are release-contract lanes inside `ci`.

# Failure Recipes

- CI/local drift: remove duplicate gate logic; rerun `mise run ci`.
- Task unexpectedly skipped: audit `sources/outputs` globs.
- Stack not healthy: inspect compose JSON via `jq -s`; verify PG mount `/var/lib/postgresql`.
