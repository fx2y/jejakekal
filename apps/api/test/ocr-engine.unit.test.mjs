import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { normalizeOcrPageIn, normalizeOcrPageOut } from '../src/ocr/contract.mjs';
import { runOcrEngineSeam } from '../src/ocr/engine-seam.mjs';
import { closeServer, listenLocal } from '../src/http.mjs';

test('ocr contract: normalize input/output fail closed and preserve raw', () => {
  const input = normalizeOcrPageIn({
    doc_id: 'doc-1',
    ver: 2,
    page_idx: 0,
    image_uri: 's3://mem/run/x.png',
    prompt: 'Text Recognition:'
  });
  assert.deepEqual(input, {
    doc_id: 'doc-1',
    ver: 2,
    page_idx: 0,
    image_uri: 's3://mem/run/x.png',
    prompt: 'Text Recognition:'
  });

  const out = normalizeOcrPageOut({
    text_md: 'hello',
    engine_meta: { engine: 'vllm' },
    raw: { choices: [] }
  });
  assert.equal(out.text_md, 'hello');
  assert.deepEqual(out.engine_meta, { engine: 'vllm' });
  assert.deepEqual(out.raw, { choices: [] });

  assert.throws(() => normalizeOcrPageOut({ text_md: 'x' }), { message: 'invalid_ocr_raw' });
});

test('ocr engine seam: vllm adapter posts image_url+prompt and normalizes output', async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url ?? '');
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: [{ type: 'text', text: 'recognized markdown' }]
            }
          }
        ]
      })
    );
  });
  const port = await listenLocal(server, 0);
  t.after(async () => {
    await closeServer(server);
  });

  const out = await runOcrEngineSeam({
    pages: [
      {
        doc_id: 'doc-1',
        ver: 1,
        page_idx: 0,
        png_uri: 's3://mem/run/wf/p0.png'
      }
    ],
    ocrPolicy: {
      enabled: true,
      engine: 'vllm',
      model: 'zai-org/GLM-OCR',
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3000,
      maxPages: 10
    }
  });
  assert.equal(requests.length, 1);
  assert.equal(out.patches.length, 1);
  assert.equal(out.patches[0].text_md, 'recognized markdown');
  assert.equal(typeof out.patches[0].raw, 'object');
});

test('ocr engine seam: transient 503 retries then succeeds', async (t) => {
  let attempts = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    attempts += 1;
    if (attempts < 3) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'busy' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'ok after retry' } }]
      })
    );
  });
  const port = await listenLocal(server, 0);
  t.after(async () => {
    await closeServer(server);
  });

  const out = await runOcrEngineSeam({
    pages: [{ doc_id: 'doc-1', ver: 1, page_idx: 0, png_uri: 's3://mem/run/wf/p0.png' }],
    ocrPolicy: {
      enabled: true,
      engine: 'vllm',
      model: 'zai-org/GLM-OCR',
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3000,
      maxPages: 10
    }
  });
  assert.equal(attempts, 3);
  assert.equal(out.patches[0].text_md, 'ok after retry');
});

test('ocr engine seam: malformed OCR page rows fail closed', async () => {
  await assert.rejects(
    () =>
      runOcrEngineSeam({
        pages: [{ page_idx: 5 }]
      }),
    {
      message: 'invalid_ocr_doc_id'
    }
  );
});
