# Failure Matrix (typed vs opaque)

| Case | Expected | Why |
|---|---|---|
| invalid JSON payload | `400 invalid_json` | client fault |
| malformed run payload | `400 invalid_run_payload` | client fault |
| non-source slash cmd (`/run`) on ingest lane | `400 invalid_command` | policy fail-closed |
| traversal/encoded hostile IDs | `400 invalid_run_id`/`invalid_artifact_id` | security boundary |
| workflowId same id + different canonical `{intent,args}` | `409 workflow_id_payload_mismatch` | strict dedup |
| persisted malformed `uri` | opaque `500 internal_error` | server-trust invariant break |
| persisted missing/invalid sha256 | opaque `500 internal_error` | integrity invariant break |
| blob unreadable/sha mismatch | opaque `500 internal_error` | tamper/unreadable fail-closed |
| unknown artifact type in export mapping | opaque `500 internal_error` | frozen vocab violation |
