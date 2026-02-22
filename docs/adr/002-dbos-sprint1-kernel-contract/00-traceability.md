# ADR002 Traceability Matrix

| ADR Clause | Source anchors |
|---|---|
| DBOS tables are run truth | `spec-0/00-learnings.jsonl` (`workflow runtime`, `dbos projections`), `spec-0/02/00-schema.jsonl` (`02.root.inv.workflow`) |
| `/runs*` canonical, `/api/*` removal | `spec-0/00-learnings.jsonl` (`spec-02 route migration`, `C5 compat surface`, `route policy`), `spec-0/02/10-bets.jsonl` (`02.bet.route_surface`) |
| Durable async start | `spec-0/00-learnings.jsonl` (`C2 route migration`, `runs API status contract`), `spec-0/02/32-cycle2-api-projection.jsonl` (`02.c2.api.post_runs`) |
| Timeline order by `function_id` | `spec-0/00-learnings.jsonl` (`dbos projections`), `spec-0/02/32-cycle2-api-projection.jsonl` (`projection_order`) |
| Exactly-once side effects with lock | `spec-0/00-learnings.jsonl` (`side effects`, `idempotent effects concurrency`), `spec-0/02-tasks.jsonl` (`02.p0.effect.race`) |
| Typed 4xx / opaque 500 | `spec-0/00-learnings.jsonl` (`request error contract`), `spec-0/02-tasks.jsonl` (`02.p0.http.badjson`) |
| Fail-closed export source | `spec-0/00-learnings.jsonl` (`DBOS export source recovery`), `spec-0/02-tasks.jsonl` (`02.p1.export.source.fallback`) |
| Run-id hostile-path hardening | `spec-0/00-learnings.jsonl` (`run-id boundary`, `hostile path QA probes`), `spec-0/02-tasks.jsonl` (`02.p0.runid.injection`) |
| Dedup claim hash mismatch => 409 | `spec-0/00-learnings.jsonl` (`workflowId dedup`), `spec-0/02-tasks.jsonl` (`02.p0.workflowid.alias`) |
| UI FSM/IDs as behavior API | `spec-0/00-learnings.jsonl` (`ui e2e`, `ui polling`), `spec-0/02-tutorial.jsonl` (`02.tut.ui.contract`) |
| Bundle additive snapshots + canonical JSON | `spec-0/00-learnings.jsonl` (`bundle migration`, `run bundle C3 additive snapshots`, `C5 bundle contract`) |
| CI singular verdict | `spec-0/00-learnings.jsonl` (`ci parity`, `C5 ci gate`), `spec-0/02-tutorial.jsonl` (`02.tut.loop.release`) |
| Kill9 readiness discipline | `spec-0/00-learnings.jsonl` (`kill9 proof harness`, `kill9 operator drill`), `spec-0/02-tasks.jsonl` (`02.p2.showcase.kill9.restart-readiness`) |
