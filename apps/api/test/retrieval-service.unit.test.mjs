import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetrievalService } from '../src/retrieval/service.mjs';
import { normalizeRetrievalScope } from '../src/retrieval/scope.mjs';

function makeService(overrides = {}) {
  return createRetrievalService({
    queryLexicalLaneRows: async () => [],
    queryTrgmLaneRows: async () => [],
    queryVectorLaneRows: async () => [],
    ...overrides
  });
}

test('retrieval scope: namespaces are mandatory and canonicalized', () => {
  assert.deepEqual(normalizeRetrievalScope({ namespaces: ['tenant-z', 'tenant-a', 'tenant-z'] }), {
    namespaces: ['tenant-a', 'tenant-z']
  });
  assert.throws(() => normalizeRetrievalScope({}), {
    message: 'retrieval_scope_required'
  });
});

test('retrieval service: rejects unsupported multi-tenant scope until schema lane lands', async () => {
  const service = makeService();
  await assert.rejects(
    () =>
      service.queryRankedBlocksByTsQuery(
        /** @type {import('pg').Client} */ ({}),
        {
          query: 'invoice',
          scope: { namespaces: ['tenant-a'] }
        }
      ),
    {
      message: 'retrieval_scope_unsupported'
    }
  );
});

test('retrieval service: lexical lane output is deterministic by rank then id', async () => {
  const service = makeService({
    queryLexicalLaneRows: async () => [
      { doc_id: 'doc-a', ver: 1, block_id: 'b2', rank: 0.8 },
      { doc_id: 'doc-a', ver: 1, block_id: 'b1', rank: 0.8 },
      { doc_id: 'doc-b', ver: 1, block_id: 'b9', rank: 0.9 }
    ]
  });
  const rows = await service.queryRankedBlocksByTsQuery(
    /** @type {import('pg').Client} */ ({}),
    {
      query: 'invoice',
      scope: { namespaces: ['default'] }
    }
  );
  assert.deepEqual(
    rows.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`),
    ['doc-b:1:b9', 'doc-a:1:b1', 'doc-a:1:b2']
  );
});

test('retrieval service: lexical plan forwards canonical scope to repository adapter', async () => {
  /** @type {Array<any>} */
  const calls = [];
  const service = makeService({
    queryLexicalLaneRows: async (_client, plan) => {
      calls.push(plan);
      return [{ doc_id: 'doc-a', ver: 1, block_id: 'b1', rank: 1 }];
    }
  });
  await service.queryRankedBlocksByTsQuery(
    /** @type {import('pg').Client} */ ({}),
    {
      query: 'invoice',
      scope: { namespaces: ['default'] }
    }
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].scope, { namespaces: ['default'] });
});

test('retrieval service: trgm lane can return typo hits when lexical misses', async () => {
  const service = makeService({
    queryTrgmLaneRows: async () => [{ doc_id: 'doc-a', ver: 1, block_id: 'b1', rank: 0.61 }]
  });
  const rows = await service.queryRankedBlocksByTsQuery(
    /** @type {import('pg').Client} */ ({}),
    {
      query: 'invocie',
      scope: { namespaces: ['default'] }
    }
  );
  assert.deepEqual(rows, [{ doc_id: 'doc-a', ver: 1, block_id: 'b1', rank: 0.61 }]);
});

test('retrieval service: vector lane is opt-in and forwards deterministic vector plan fields', async () => {
  /** @type {Array<any>} */
  const calls = [];
  const service = makeService({
    queryVectorLaneRows: async (_client, plan) => {
      calls.push(plan);
      return [{ doc_id: 'doc-a', ver: 1, block_id: 'b1', rank: 0.77, distance: 0.23 }];
    }
  });
  const rows = await service.queryRankedBlocksByTsQuery(
    /** @type {import('pg').Client} */ ({}),
    {
      query: 'invoice',
      scope: { namespaces: ['default'] },
      enableVector: true,
      vector: { efSearch: 123, candidateLimit: 17, indexType: 'hnsw' }
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(Array.isArray(calls[0].queryVector), true);
  assert.equal(calls[0].queryVector.length, 1536);
  assert.equal(calls[0].efSearch, 123);
  assert.equal(calls[0].candidateLimit >= calls[0].limit, true);
  assert.deepEqual(rows, [{ doc_id: 'doc-a', ver: 1, block_id: 'b1', rank: 0.77 }]);
});

test('retrieval service: vector rows are deterministically fused with lexical rows via RRF', async () => {
  const service = makeService({
    queryLexicalLaneRows: async () => [{ doc_id: 'doc-a', ver: 1, block_id: 'b2', rank: 0.9 }],
    queryVectorLaneRows: async () => [
      { doc_id: 'doc-a', ver: 1, block_id: 'b1', rank: 0.8, distance: 0.2 },
      { doc_id: 'doc-a', ver: 1, block_id: 'b2', rank: 0.7, distance: 0.3 }
    ]
  });
  const rows = await service.queryRankedBlocksByTsQuery(
    /** @type {import('pg').Client} */ ({}),
    {
      query: 'invoice',
      scope: { namespaces: ['default'] },
      enableVector: true
    }
  );
  assert.deepEqual(
    rows.map((row) => `${row.doc_id}:${row.ver}:${row.block_id}`),
    ['doc-a:1:b2', 'doc-a:1:b1']
  );
});
