# ADR-003 Companion: Contract Map

## Cycle Compression
| Cycle | Delta | Proof Close |
|---|---|---|
| C0 | contract freezes + seam extraction | unit/e2e probe + verify |
| C1 | artifact persistence core + postcondition | workflow/unit |
| C2 | command router + chat ledger + artifact/resume routes | workflow/ui |
| C3 | server-driven htmx UI + viewer + OOB poll | ui:e2e |
| C4 | resume UX + deterministic bundle + trust fields | replay/workflow/ui |
| C5 | checklist closure + guardrails + ops docs/signoff | ci + signoff |
| C6 | post-C5 hardening (blob durability, strict decode, UI parity, dedup) | verify lanes |
| C7 | tutorial-driven signoff + startup/readiness backlog closure | signoff + split-mode smoke |
| C8 | signoff003 blockers (UI host boundary, OOB target, run-scope artifacts) | ui:e2e + verify |

## Contract Axes
| Axis | Rule |
|---|---|
| API surface | `/runs* + /artifacts* + /healthz` canonical; `/runs*` compat hard floor until >=2026-06-30 |
| Start payload | `{intent,args}` canonical; `{source}` compat explicit/time-boxed; no default synthesis |
| Run projection | frozen keys immutable; additive only |
| Artifact truth | persisted immutable rows + blob hash verification |
| Chat truth | control-plane only (`cmd,args,run_id`) |
| UI | frozen IDs + additive aliases; strict status FSM; HX full/fragment/history; atomic OOB poll |
| Errors | typed 4xx client faults; opaque `internal_error` 5xx |
| CI parity | only `mise run ci` verdict |

## Hot Failure Modes -> Expected Response
| Failure | Expected |
|---|---|
| Encoded traversal run/artifact id | typed 400 invalid id |
| Invalid slash cmd/payload/sleepMs | typed 400 |
| workflowId same id, different payload | 409 mismatch |
| Missing/tampered persisted blob | opaque 5xx |
| Corrupt JSON artifact blob | opaque 5xx |
| Non-resumable resume attempt | 409 run_not_resumable |
| Unknown backend UI status | terminal UI `error` |

## Minimal Release Checklist
1. `mise run verify`
2. `mise run test:replay`
3. `mise run ui:e2e`
4. `mise run golden:diff`
5. `mise run bench:check`
6. `mise run ci` (only verdict)
