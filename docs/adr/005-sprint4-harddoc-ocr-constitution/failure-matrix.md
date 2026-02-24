# Failure Matrix (Fail-Closed)

| Boundary | Condition | Verdict |
|---|---|---|
| run-start parse | non-source intent/cmd on ingest lane | `400 invalid_command` |
| run-start policy | `ocrPolicy.engine != vllm` | `400 invalid_run_payload field=ocrPolicy.engine` |
| dedup | same workflowId + different `{intent,args}` | `409 workflow_id_payload_mismatch` |
| render seam | `hard_pages>0` and missing source PDF | invariant `5xx` |
| render seam | requested pages != valid rendered PNG rows | invariant `5xx` |
| OCR seam | malformed OCR input row | invariant `5xx` |
| OCR transport | connection refused/timeout | normalized `ocr_endpoint_unreachable` step error; host alive |
| artifact write | unknown artifact type | reject at insert boundary |
| blob read | persisted uri/sha malformed or mismatch | opaque `5xx` |
| hostile path | traversal-like IDs (`--path-as-is`) | typed ID `4xx` |
| resume | terminal non-resumable state | `409 run_not_resumable` |
