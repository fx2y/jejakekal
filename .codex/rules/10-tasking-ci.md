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

- `.mise.toml` is command SoT; keep task names stable and namespaced.
- New expensive task must declare `sources` + `outputs` (incremental skip is mandatory).
- CI workflow runs `mise run ci` only; never duplicate gate lists in YAML.
- Tool pins live in `mise` + `packageManager`; update by PR, never ad hoc local drift.
- Keep `MISE_JOBS` parallelism sane (`4` local default) and deterministic.
- Wrappers in `mise-tasks/**` should be thin, strict (`set -euo pipefail`), non-interactive.
- Stack wrappers use `docker compose ... exec` (no host `psql` assumptions).

# Failure Recipes

- Task skips unexpectedly: check `sources/outputs` glob coverage and generated files.
- CI/local drift: compare against `.github/workflows/ci.yml`; if it does more than `mise run ci`, fix workflow.
- Stack health timeout: validate compose JSON stream parse via `jq -s` and per-service health fields.
- PG boot failure after image bump: confirm volume mount path `/var/lib/postgresql`.
