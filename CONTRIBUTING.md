# Contributing

## Harness Rules

1. No direct side-effects in tests; wrap every side-effect in a replay-safe workflow step.
2. Freeze time and random in workflow tests where values influence behavior.
3. New integration steps must include a crash/resume test.
4. Review run-bundle diffs, not just assertion output.
5. Primary dev loop is `mise watch verify` (or `mise watch test:unit`).
