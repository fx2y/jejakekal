# Snippets (Canonical)

## Gate selection
```js
const scored = pages
  .map((p, idx) => ({ idx, score: scorePage(p), reasons: explain(p) }))
  .sort((a, b) => b.score - a.score || a.idx - b.idx);
const hard_pages = scored.filter((x) => x.score >= threshold).slice(0, maxPages).map((x) => x.idx);
```

## OCR effect key
```js
const effectKey = `${workflowId}|ocr-page|${docId}|${ver}|p${pageIdx0}|${model}|${gateRev}|${pngSha}`;
```

## Index translators
```js
const toPdfPageIndex = (pageIdx0) => pageIdx0 + 1;
const toPageIdx0 = (pdfPageIdx1) => pdfPageIdx1 - 1;
```

## Start seam (timeout + workflowID)
```js
DBOS.startWorkflow(workflowFn, { workflowID, timeoutMS })(input);
```

## OCR readiness gate
```sh
mise run wait:health -- "${OCR_BASE_URL:-http://127.0.0.1:8000}/health" 30000 250
```
