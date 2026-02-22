---
description: Task graph, CI parity, toolchain discipline.
paths:
  - .mise.toml
  - package.json
  - tsconfig.json
  - mise-tasks/**
  - scripts/build.mjs
  - scripts/lint.mjs
  - .github/workflows/**
  - .githooks/**
---

# Task/CI Rules

- `.mise.toml` is command graph SoT; task names stay stable/namespaced.
- Full release verdict is `mise run ci`; CI YAML/scripts must not duplicate gate lists.
- New expensive tasks must declare `sources` + `outputs` (incremental skip required).
- Wrappers in `mise-tasks/**` stay thin, strict (`set -euo pipefail`), non-interactive.
- Host deps stay minimal: `mise` + container runtime only; DB access via `mise run psql`.
- Tool/version pins live in `mise` + `packageManager`; upgrade via reviewed PRs.
- `ui:e2e` and perf checks belong inside `mise run ci`, never side pipelines.

# Failure Recipes

- Task unexpectedly skipped: audit `sources/outputs` globs and generated paths.
- CI/local drift: workflow must run only `mise run ci`; remove shadow gates.
- Stack health timeout: parse compose stream via `jq -s`; inspect per-service health.
- PG boot failure: verify mount path `/var/lib/postgresql` (PG18 layout).
