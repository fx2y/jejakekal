# Acceptance Checklist (Release Blockers)

- [ ] `mise run ci` passes.
- [ ] Crash-resume verified by forced mid-run termination.
- [ ] No external effect bypasses idempotent wrapper.
- [ ] Run returns timeline + artifacts + runBundlePath.
- [ ] Golden diff reviewed/approved for structural intent.
- [ ] Sandbox deterministic hash check passes.
- [ ] UI e2e validates ID/state transitions.
- [ ] Perf budget check passes.
