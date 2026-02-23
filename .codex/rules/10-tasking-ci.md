---
description: Task graph, stack ops, and CI parity law.
paths:
  - .mise.toml
  - mise-tasks/**
  - .github/workflows/**
  - scripts/**
---

# Task/CI Rules

- `.mise.toml` is command-graph SoT; wrappers/scripts are thin leaves, not alternate orchestrators.
- Release verdict is `mise run ci` only; GH Actions call only that entrypoint.
- `verify` stays the fast dev gate; don't hide release-only checks outside `ci`.
- Gate all first probes with `mise run wait:health -- <url>` (API/UI/Seaweed master/filer/S3).
- `smoke:ingest` is ops-contract lane (S3 put/head/get + marker sanity + FTS index presence); keep deterministic.
- Golden/UI/perf/replay/idempotency lanes are release-contract lanes inside `ci`.
- Task wrappers stay strict/non-interactive (`set -euo pipefail`) and declare incremental `sources/outputs` when expensive.
- Host deps stay minimal (`mise` + container runtime); DB ops via `mise run psql`.
- Seaweed port overrides are additive envs (`SEAWEED_*_PORT`); filer override must be paired with `BLOB_FILER_ENDPOINT` across `up|reset|verify|ci`.
- Local/demo/showcase helpers may skip lanes by default, but must not redefine release verdict or CI parity.

# Failure Recipes

- CI/local drift: delete shadow gate logic; rerun `mise run ci`.
- Task unexpectedly skipped: audit `sources/outputs` globs and hidden env deps.
- Stack unhealthy: inspect compose JSON via `jq -s`; verify PG mount `/var/lib/postgresql` and Seaweed port collisions.
- Seaweed S3 `InvalidAccessKeyId|AccessDenied`: bootstrap IAM creds, then rerun reset/proofs.
