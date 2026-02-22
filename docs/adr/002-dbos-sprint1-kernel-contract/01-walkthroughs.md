# ADR002 Walkthroughs (dense)

## A. Happy path: async durable run
```bash
RID=$(curl -sS -X POST http://127.0.0.1:4010/runs \
  -H 'content-type: application/json' \
  -d '{"source":"alpha\nbeta","sleepMs":250}' | jq -r '.run_id')

while :; do
  RUN=$(curl -sS http://127.0.0.1:4010/runs/$RID)
  ST=$(jq -r '.status' <<<"$RUN")
  [[ "$ST" == done || "$ST" == error || "$ST" == unknown ]] && break
  sleep 0.05
done

curl -sS http://127.0.0.1:4010/runs/$RID/export | jq '{run_id,status,dbos_status,artifact_ids:(.artifacts|map(.id)),run_bundle_path}'
```
Expected:
- `POST` returns quickly with `run_id`.
- timeline contains `prepare`,`DBOS.sleep`,`side-effect`,`finalize` in `function_id` order.
- artifacts exactly `raw,docir,chunk-index,memo`.

## B. Hostile contract probes (must fail typed)
```bash
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d '{'
curl --path-as-is -sS -i http://127.0.0.1:4010/runs/%2E%2E
curl --path-as-is -sS -i http://127.0.0.1:4010/runs/..%2Fx/export
```
Expected:
- `400 invalid_json`
- `400 invalid_run_id`

## C. Dedup claim integrity
```bash
WF=wf-dedup-$RANDOM
curl -sS -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d "{\"source\":\"one\",\"workflowId\":\"$WF\"}" >/dev/null
curl -sS -i -X POST http://127.0.0.1:4010/runs -H 'content-type: application/json' -d "{\"source\":\"two\",\"workflowId\":\"$WF\"}"
```
Expected: `409 workflow_id_payload_mismatch`.

## D. DB truth correlation
```bash
mise run psql -- -c "select workflow_uuid,status,recovery_attempts from dbos.workflow_status where workflow_uuid='${RID}'"
mise run psql -- -c "select function_id,function_name from dbos.operation_outputs where workflow_uuid='${RID}' order by function_id"
```
Expected: API projection and SQL rows align semantically.

## E. Kill9 resume drill
```bash
API_PORT=4301 mise x node@24.13.1 -- node apps/api/src/server.mjs & APID=$!
RID=$(curl -sS -X POST http://127.0.0.1:4301/runs -H 'content-type: application/json' -d '{"source":"kill9-demo","sleepMs":800}' | jq -r '.run_id')
while ! curl -sS http://127.0.0.1:4301/runs/$RID | jq -e '.timeline[]?|select(.function_name=="prepare")' >/dev/null; do sleep 0.05; done
kill -9 $APID
API_PORT=4301 mise x node@24.13.1 -- node apps/api/src/server.mjs &
until curl -sS http://127.0.0.1:4301/healthz >/dev/null; do sleep 0.05; done
```
Then poll `/runs/$RID` terminal. Expected: no duplicate completed step; terminal `done/SUCCESS`.

## F. CLI/API parity spot
```bash
mise run dbos:workflow:get -- "$RID" | jq '{workflowID,status,workflowName,recoveryAttempts}'
mise run dbos:workflow:steps -- "$RID" | jq 'map({functionID,name})'
curl -sS http://127.0.0.1:4010/runs/$RID | jq '{run_id,dbos_status,name:.header.name,recovery_attempts:.header.recovery_attempts,steps:(.timeline|map({function_id,function_name}))}'
```
Expected: semantic parity.

## G. Release verdict
```bash
mise run verify
mise run ci
```
Rule: only `mise run ci` is shipment authority.

## H. Sequence sketch
```text
UI click
  -> POST /runs (202, run_id)
  -> poll GET /runs/:id until done/error/unknown
  -> GET /runs/:id/export
  -> render 3 planes (IDs immutable)

Server
  -> DBOS.startWorkflow
  -> DBOS writes dbos.workflow_status + dbos.operation_outputs
  -> projections map DBOS rows -> API payload
  -> export writes canonical bundle + additive DBOS snapshots
```
