---
description: Task graph, stack ops, and CI parity law.
paths:
  - .mise.toml
  - mise-tasks/**
  - .github/workflows/**
  - scripts/**
---

# Task/CI Rules

- `.mise.toml` is command-graph SoT; wrappers/scripts are leaves only.
- Release verdict is only `mise run ci`; CI pipelines call only this entrypoint.
- `mise run verify` is the dev gate; no release-only checks hidden outside `ci`.
- First external probe must be gated via `mise run wait:health -- <url>`.
- Core contract lanes (`replay`,`idempotency`,`workflow`,`ui:e2e`,`golden:diff`,`bench:check`,`smoke:ingest`) stay inside `ci`.
- DB-reset integration lanes run sequentially (non-parallel-safe unless isolation model changes).
- Wrapper scripts are strict/non-interactive (`set -euo pipefail`) with deterministic env handling.
- Host deps remain minimal (`mise` + container runtime); SQL truth path is `mise run psql`.
- Filer override is paired+sticky: set both `SEAWEED_FILER_PORT` and `BLOB_FILER_ENDPOINT` across `up|reset|verify|ci|signoff` or set neither.
- Poppler preflight is shared contract for OCR lanes (workflow/smoke/bench/signoff), not lane-local logic.

# Failure Recipes

- CI/local drift: delete shadow gates; rerun `mise run ci`.
- Task skipped unexpectedly: audit `sources/outputs` and hidden env dependencies.
- Stack unhealthy: inspect compose JSON (`jq -s`), verify PG mount `/var/lib/postgresql`, resolve Seaweed port collisions.
- Seaweed S3 `InvalidAccessKeyId|AccessDenied`: bootstrap IAM creds, then rerun reset + proofs.
