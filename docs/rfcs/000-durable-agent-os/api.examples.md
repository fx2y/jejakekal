# API Examples (Normative Shape)

## Create run
```http
POST /runs
content-type: application/json

{"command":"/ingest","input":{"uri":"file:///tmp/a.pdf"}}
```

```json
{"runId":"run_01H...","status":"running","timeline":[],"artifacts":[]}
```

## Poll run
```http
GET /runs/run_01H...
```

```json
{
  "runId":"run_01H...",
  "status":"succeeded",
  "timeline":[
    {"seq":1,"step":"store_raw","type":"TX_STEP","status":"ok","inHash":"...","outHash":"..."},
    {"seq":2,"step":"parse_marker","type":"CPU_STEP","status":"ok","inHash":"...","outHash":"..."}
  ],
  "artifacts":[
    {"type":"memo.md","uri":"s3://runs/run_01H.../memo.md","sha256":"..."}
  ],
  "runBundlePath":"s3://runs/run_01H.../bundle.zip"
}
```
