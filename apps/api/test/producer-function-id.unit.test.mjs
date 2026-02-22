import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichArtifactsWithProducerFunctionId } from '../src/artifacts/producer-function-id.mjs';

test('producer-function-id cache dedupes concurrent step reads per run', async () => {
  let reads = 0;
  const artifacts = [
    {
      id: 'run-1:raw',
      run_id: 'run-1',
      type: 'raw',
      format: 'text/plain',
      uri: 'bundle://run-1/run-1%3Araw/ingest/raw.txt',
      sha256: 'x',
      title: 'Raw',
      status: 'final',
      visibility: 'user',
      supersedes_id: null,
      prov: { producer_step: 'persist-artifacts' },
      created_at: '2026-02-22T00:00:00.000Z'
    },
    {
      id: 'run-1:memo',
      run_id: 'run-1',
      type: 'memo',
      format: 'application/json',
      uri: 'bundle://run-1/run-1%3Amemo/ingest/memo.json',
      sha256: 'y',
      title: 'Memo',
      status: 'final',
      visibility: 'user',
      supersedes_id: null,
      prov: { producer_step: 'persist-artifacts' },
      created_at: '2026-02-22T00:00:00.000Z'
    }
  ];
  const fakeReadSteps = async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return [{ function_name: 'persist-artifacts', function_id: 4 }];
  };

  const enriched = await enrichArtifactsWithProducerFunctionId(
    /** @type {any} */ ({}),
    artifacts,
    /** @type {any} */ (fakeReadSteps)
  );

  assert.equal(reads, 1);
  assert.equal(enriched[0].prov.producer_function_id, 4);
  assert.equal(enriched[1].prov.producer_function_id, 4);
});
