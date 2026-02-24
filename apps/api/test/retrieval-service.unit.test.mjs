import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetrievalService } from '../src/retrieval/service.mjs';
import { normalizeRetrievalScope } from '../src/retrieval/scope.mjs';

function makeService(overrides = {}) {
  return createRetrievalService({
    queryLexicalLaneRows: async () => [],
    queryTableLaneRows: async () => [],
    queryTrgmLaneRows: async () => [],
    queryVectorLaneRows: async () => [],
    ...overrides
  });
}

/**
 * @param {any} row
 */
function rowKey(row) {
  return `${row.doc_id}:${row.ver}:${row.block_id}`;
}

function citeFor(block_id, extras = {}) {
  return {
    doc_version: 1,
    page: 1,
    bbox: [0, 0, 1, 1],
    block_hash: `${block_id}-hash`,
    block_id,
    ...extras
  };
}

test('retrieval scope: namespaces are mandatory and canonicalized', () => {
  assert.deepEqual(normalizeRetrievalScope({ namespaces: ['tenant-z', 'tenant-a', 'tenant-z'] }), {
    namespaces: ['tenant-a', 'tenant-z']
  });
  assert.throws(() => normalizeRetrievalScope({}), {
    message: 'retrieval_scope_required'
  });
});

test('retrieval service: accepts non-default scope and forwards acl to lane adapters', async () => {
  /** @type {Array<any>} */
  const calls = [];
  const service = makeService({
    queryLexicalLaneRows: async (_client, plan) => {
      calls.push(plan);
      return [];
    }
  });
  const rows = await service.queryRankedBlocksByTsQuery(
    /** @type {import('pg').Client} */ ({}),
    {
      query: 'invoice',
      scope: { namespaces: ['tenant-a'], acl: { user: 'u-1' } }
    }
  );
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].scope, { namespaces: ['tenant-a'], acl: { user: 'u-1' } });
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
    rows.map(rowKey),
    ['doc-b:1:b9', 'doc-a:1:b1', 'doc-a:1:b2']
  );
  assert.equal(Array.isArray(rows[0].lane), true);
  assert.equal(Array.isArray(rows[0].lane_reasons), true);
  assert.equal(typeof rows[0].cite, 'object');
  assert.equal(Object.hasOwn(rows[0], 'text'), false);
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
  assert.equal(rows.length, 1);
  assert.equal(rows[0].block_id, 'b1');
  assert.equal(rows[0].lane.includes('trgm'), true);
});

test('retrieval service: table lane can return exact-key hits when other lanes miss', async () => {
  const service = makeService({
    queryTableLaneRows: async () => [{ doc_id: 'doc-a', ver: 1, block_id: 'tbl-1', rank: 1 }]
  });
  const rows = await service.queryRankedBlocksByTsQuery(
    /** @type {import('pg').Client} */ ({}),
    {
      query: 'amount',
      scope: { namespaces: ['default'] }
    }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].block_id, 'tbl-1');
  assert.equal(rows[0].lane.includes('table'), true);
});

test('retrieval service: table plan forwards canonical scope+language to repository adapter', async () => {
  /** @type {Array<any>} */
  const calls = [];
  const service = makeService({
    queryTableLaneRows: async (_client, plan) => {
      calls.push(plan);
      return [];
    }
  });
  await service.queryRankedBlocksByTsQuery(
    /** @type {import('pg').Client} */ ({}),
    {
      query: 'amount',
      language: 'english',
      scope: { namespaces: ['default'] }
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lane, 'table');
  assert.equal(calls[0].language, 'english');
  assert.deepEqual(calls[0].scope, { namespaces: ['default'] });
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
  assert.equal(rows.length, 1);
  assert.equal(rows[0].block_id, 'b1');
  assert.equal(rows[0].lane.includes('vector'), true);
  assert.equal(typeof rows[0].vector_distance, 'number');
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
    rows.map(rowKey),
    ['doc-a:1:b2', 'doc-a:1:b1']
  );
  assert.equal(rows[0].lane.includes('lexical'), true);
  assert.equal(rows[0].lane.includes('vector'), true);
});

test('retrieval service: C6 exact rerank emits provenance-only lane reasons+cite and phrase/freshness priors break RRF ties deterministically', async () => {
  const service = makeService({
    queryLexicalLaneRows: async () => [
      {
        doc_id: 'doc-a',
        ver: 1,
        block_id: 'b1',
        rank: 0.9,
        type: 'text',
        page: 1,
        bbox: [0, 0, 1, 1],
        block_sha: 'a'.repeat(64),
        text: 'invoice gamma'
      },
      {
        doc_id: 'doc-a',
        ver: 2,
        block_id: 'b2',
        rank: 0.8,
        type: 'heading',
        page: 2,
        bbox: [0, 0, 1, 1],
        block_sha: 'b'.repeat(64),
        text: 'invoice alpha exact phrase'
      }
    ],
    queryVectorLaneRows: async () => [
      {
        doc_id: 'doc-a',
        ver: 2,
        block_id: 'b2',
        rank: 0.7,
        distance: 0.2,
        type: 'heading',
        page: 2,
        bbox: [0, 0, 1, 1],
        block_sha: 'b'.repeat(64),
        text: 'invoice alpha exact phrase'
      },
      {
        doc_id: 'doc-a',
        ver: 1,
        block_id: 'b1',
        rank: 0.6,
        distance: 0.1,
        type: 'text',
        page: 1,
        bbox: [0, 0, 1, 1],
        block_sha: 'a'.repeat(64),
        text: 'invoice gamma'
      }
    ]
  });
  const rows = await service.queryRankedBlocksByTsQuery(
    /** @type {import('pg').Client} */ ({}),
    {
      query: '"invoice alpha"',
      scope: { namespaces: ['default'] },
      enableVector: true
    }
  );
  assert.equal(rows.length >= 2, true);
  assert.equal(rows[0].block_id, 'b2');
  assert.equal(rows[0].exact_phrase_hit, true);
  assert.deepEqual(rows[0].lane, ['lexical', 'vector']);
  assert.deepEqual(
    rows[0].lane_reasons.map((reason) => ({ lane: reason.lane, rank_pos: reason.rank_pos })),
    [
      { lane: 'vector', rank_pos: 1 },
      { lane: 'lexical', rank_pos: 2 }
    ]
  );
  assert.deepEqual(rows[0].cite, citeFor('b2', { doc_version: 2, page: 2, block_hash: 'b'.repeat(64) }));
  assert.equal(Object.hasOwn(rows[0], 'text'), false);
});
