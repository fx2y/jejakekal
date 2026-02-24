import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { makeClient } from '../apps/api/src/db.mjs';
import { reserveDocVersion } from '../apps/api/src/ingest/doc-repository.mjs';
import { queryRankedBlocksByTsQuery } from '../apps/api/src/retrieval/service.mjs';
import {
  inspectLexicalQuery,
  populateBlockTsv,
  queryLexicalLaneRows,
  queryTableLaneRows,
  queryTrgmLaneRows,
  queryVectorLaneRows,
  replaceDocBlockEmbeddings,
  upsertBlockLedger
} from '../apps/api/src/search/block-repository.mjs';
import { RETRIEVAL_EMBED_MODEL_DEFAULT, embedTextDeterministic, toPgVectorLiteral } from '../apps/api/src/retrieval/embeddings.mjs';
import { percentile, postRun, resetBenchState, waitForRunTerminal, withApiServer } from './bench-lib.mjs';

const BENCH_RUNS = 80;
const LEX_QUERY = 'invoice';
const TYPO_QUERY = 'invocie';
const VECTOR_QUERY = 'invoice total';
const TABLE_EXACT_QUERY = 'total';
const TABLE_FTS_QUERY = 'widget';
const SOURCE = 'invoice alpha\ninvoice beta\ninvoice gamma';
const DEFAULT_SCOPE = Object.freeze({ namespaces: ['default'] });

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function stableStringify(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map((entry) => sortDeep(entry));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
      out[key] = sortDeep(value[key]);
    }
    return out;
  }
  return value;
}

function hashRedacted(value) {
  return sha256Hex(JSON.stringify(sortDeep(value)));
}

/**
 * @param {any} plan
 */
function collectPlanIndexes(plan) {
  const out = new Set();
  const stack = [plan];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node['Index Name'] === 'string') {
      out.add(node['Index Name']);
    }
    const subPlans = Array.isArray(node.Plans) ? node.Plans : [];
    for (const subPlan of subPlans) stack.push(subPlan);
  }
  return out;
}

function collectNodeTypes(plan) {
  const out = new Set();
  const stack = [plan];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node['Node Type'] === 'string') {
      out.add(node['Node Type']);
    }
    const subPlans = Array.isArray(node.Plans) ? node.Plans : [];
    for (const subPlan of subPlans) stack.push(subPlan);
  }
  return out;
}

function sanitizeExplain(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeExplain(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const out = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    if (
      key === 'Startup Cost' ||
      key === 'Total Cost' ||
      key === 'Plan Rows' ||
      key === 'Plan Width' ||
      key === 'Actual Startup Time' ||
      key === 'Actual Total Time' ||
      key === 'Actual Rows' ||
      key === 'Actual Loops' ||
      key === 'Shared Hit Blocks' ||
      key === 'Shared Read Blocks' ||
      key === 'Shared Dirtied Blocks' ||
      key === 'Shared Written Blocks' ||
      key === 'Local Hit Blocks' ||
      key === 'Local Read Blocks' ||
      key === 'Local Dirtied Blocks' ||
      key === 'Local Written Blocks' ||
      key === 'Temp Read Blocks' ||
      key === 'Temp Written Blocks' ||
      key === 'Execution Time' ||
      key === 'Planning Time' ||
      key === 'Rows Removed by Filter'
    ) {
      continue;
    }
    out[key] = sanitizeExplain(record[key]);
  }
  return out;
}

async function withSeqscanGuard(client, fn) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL enable_seqscan = off');
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function explainJson(client, sql, params) {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  return result.rows[0]?.['QUERY PLAN']?.[0] ?? null;
}

async function writeJson(path, value) {
  await writeFile(path, `${stableStringify(value)}\n`, 'utf8');
}

async function seedBenchTableDoc(client) {
  const source = 'bench retrieval table fixture';
  const reserved = await reserveDocVersion(client, {
    rawSha: sha256Hex(source),
    filename: 'bench-retrieval-table.txt',
    mime: 'text/plain',
    byteLength: Buffer.byteLength(source)
  });
  const docId = reserved.docId;
  const version = reserved.version;
  const tableBlock = {
    block_id: 'tbl-001',
    type: 'table',
    page: 1,
    bbox: [0, 0, 1, 1],
    text: 'invoice total widget 100',
    data: {
      title: 'Invoice Totals',
      rows: [{ invoice: 'INV-001', item: 'widget', total: '100' }]
    },
    block_sha: sha256Hex('bench-retrieval-table|1|tbl-001|invoice-total-widget-100')
  };
  await upsertBlockLedger(client, { docId, version, provenance: { source: 'bench-query', kind: 'fixture' }, blocks: [tableBlock] });
  await populateBlockTsv(client, { docId, version, language: 'english' });
  await replaceDocBlockEmbeddings(client, {
    docId,
    version,
    model: RETRIEVAL_EMBED_MODEL_DEFAULT,
    rows: [{ block_id: tableBlock.block_id, emb: embedTextDeterministic(VECTOR_QUERY) }]
  });
}

async function captureExplainArtifacts(client) {
  const vectorLiteral = toPgVectorLiteral(embedTextDeterministic(VECTOR_QUERY));
  const vectorModel = RETRIEVAL_EMBED_MODEL_DEFAULT;
  const explainSpecs = [
    {
      class: 'retrieval.lexical.fts',
      sql: `WITH q AS (
              SELECT websearch_to_tsquery($1::regconfig, $2) AS tsq
            )
            SELECT b.doc_id, b.ver, b.block_id
            FROM q
            JOIN doc_block b ON b.ns = ANY($3::text[])
            JOIN doc_block_fts f ON f.block_pk = b.id
            WHERE f.vec @@ q.tsq
            ORDER BY ts_rank_cd(f.vec, q.tsq) DESC, b.id ASC
            LIMIT $4`,
      params: ['english', LEX_QUERY, ['default'], 25],
      expectedIndexes: ['doc_block_fts_gin']
    },
    {
      class: 'retrieval.trgm.shortfields',
      sql: `WITH cfg AS (
              SELECT set_config('pg_trgm.similarity_threshold', $1::text, true)
            ),
            q AS (
              SELECT $2::text AS txt, $3::jsonb AS acl
            )
            SELECT b.doc_id, b.ver, b.block_id
            FROM cfg
            JOIN q ON TRUE
            JOIN doc_block b ON b.ns = ANY($4::text[])
            WHERE b.acl @> q.acl
              AND (
                (b.title_norm IS NOT NULL AND b.title_norm % q.txt)
                OR (b.entity_norm IS NOT NULL AND b.entity_norm % q.txt)
                OR (b.key_norm IS NOT NULL AND b.key_norm % q.txt)
              )
            ORDER BY b.id ASC
            LIMIT $5`,
      params: ['0.3', TYPO_QUERY, '{}', ['default'], 20],
      expectedIndexes: ['doc_block_title_trgm_gin', 'doc_block_entity_trgm_gin', 'doc_block_key_trgm_gin']
    },
    {
      class: 'retrieval.vector.hnsw',
      sql: `WITH cfg_hnsw AS (
              SELECT CASE
                WHEN $1::text = 'hnsw' THEN set_config('hnsw.ef_search', $2::text, true)
                ELSE NULL
              END
            ),
            cfg_ivf AS (
              SELECT CASE
                WHEN $1::text = 'ivf' THEN set_config('ivfflat.probes', $3::text, true)
                ELSE NULL
              END
            ),
            q AS (
              SELECT $4::vector AS emb, $5::jsonb AS acl
            ),
            ann AS (
              SELECT b.id AS block_pk, b.doc_id, b.ver, b.block_id
              FROM cfg_hnsw
              CROSS JOIN cfg_ivf
              JOIN q ON TRUE
              JOIN doc_block b ON b.ns = ANY($6::text[])
              JOIN doc_block_vec v ON v.block_pk = b.id
              WHERE b.acl @> q.acl
                AND v.model = $7::text
                AND v.emb IS NOT NULL
              ORDER BY v.emb <=> q.emb ASC, b.id ASC
              LIMIT $8
            )
            SELECT ann.doc_id, ann.ver, ann.block_id
            FROM ann
            JOIN doc_block_vec v ON v.block_pk = ann.block_pk
            JOIN q ON TRUE
            ORDER BY (v.emb <=> q.emb) ASC, ann.block_pk ASC
            LIMIT $9`,
      params: ['hnsw', '80', '10', vectorLiteral, '{}', ['default'], vectorModel, 80, 25],
      expectedIndexes: ['doc_block_vec_hnsw']
    },
    {
      class: 'retrieval.table.exact',
      sql: `WITH q AS (
              SELECT $1::text AS key_q, $2::jsonb AS acl
            )
            SELECT t.doc_id, t.ver, (t.cite->>'block_id') AS block_id
            FROM q
            JOIN table_cell t ON t.key_norm = q.key_q
            JOIN doc_block b
              ON b.doc_id = t.doc_id
             AND b.ver = t.ver
             AND b.block_id = (t.cite->>'block_id')
             AND b.type = 'table'
            WHERE b.ns = ANY($3::text[])
              AND b.acl @> q.acl
            ORDER BY t.doc_id ASC, t.ver ASC, t.page ASC, t.table_id ASC, t.row_idx ASC, t.col_idx ASC
            LIMIT $4`,
      params: [TABLE_EXACT_QUERY, '{}', ['default'], 25],
      expectedIndexes: ['table_cell_key_exact_idx']
    },
    {
      class: 'retrieval.table.fts',
      sql: `WITH q AS (
              SELECT websearch_to_tsquery($1::regconfig, $2) AS tsq, $3::jsonb AS acl
            )
            SELECT t.doc_id, t.ver, (t.cite->>'block_id') AS block_id
            FROM q
            JOIN table_cell t ON t.vec @@ q.tsq
            JOIN doc_block b
              ON b.doc_id = t.doc_id
             AND b.ver = t.ver
             AND b.block_id = (t.cite->>'block_id')
             AND b.type = 'table'
            WHERE b.ns = ANY($4::text[])
              AND b.acl @> q.acl
            ORDER BY ts_rank_cd(t.vec, q.tsq) DESC, t.doc_id ASC, t.ver ASC, t.page ASC, t.table_id ASC, t.row_idx ASC, t.col_idx ASC
            LIMIT $5`,
      params: ['english', TABLE_FTS_QUERY, '{}', ['default'], 25],
      expectedIndexes: ['table_cell_vec_gin']
    }
  ];

  const queryHashes = [];
  const explainManifest = [];
  for (const spec of explainSpecs) {
    const raw = await withSeqscanGuard(client, () => explainJson(client, spec.sql, spec.params));
    const plan = raw?.Plan ?? null;
    const planIndexes = [...collectPlanIndexes(plan)].sort((a, b) => a.localeCompare(b));
    const nodeTypes = [...collectNodeTypes(plan)].sort((a, b) => a.localeCompare(b));
    const hasIndexNode = nodeTypes.some((name) => name.includes('Index'));
    if (spec.expectedIndexes.length > 0 && !spec.expectedIndexes.some((name) => planIndexes.includes(name)) && !hasIndexNode) {
      throw new Error(`bench_query_explain_index_missing:${spec.class}`);
    }
    const queryHash = hashRedacted({
      class: spec.class,
      params: spec.params.map((value) =>
        typeof value === 'string' && value.length > 16 ? { kind: 'string', sha256: sha256Hex(value) } : value
      )
    });
    const sqlHash = sha256Hex(spec.sql.replace(/\s+/g, ' ').trim());
    const sanitized = sanitizeExplain(raw);
    const planHash = hashRedacted(sanitized);
    const file = `.cache/bench/explain-${spec.class.replaceAll('.', '-')}.json`;
    await writeJson(file, {
      class: spec.class,
      sql_hash: sqlHash,
      query_hash: queryHash,
      expected_indexes: spec.expectedIndexes,
      observed_indexes: planIndexes,
      observed_node_types: nodeTypes,
      plan_hash: planHash,
      explain: sanitized
    });
    queryHashes.push({
      class: spec.class,
      sql_hash: sqlHash,
      query_hash: queryHash,
      plan_hash: planHash,
      param_count: spec.params.length
    });
    explainManifest.push({ class: spec.class, file, plan_hash: planHash });
  }
  return { queryHashes, explainManifest };
}

async function main() {
  await resetBenchState();
  await withApiServer(async ({ baseUrl }) => {
    const runId = await postRun(baseUrl, { source: SOURCE, sleepMs: 10 });
    const run = await waitForRunTerminal(baseUrl, runId);
    if (run?.status !== 'done') {
      throw new Error(`bench_query_seed_failed:${runId}:${String(run?.status ?? 'missing')}`);
    }

    const client = makeClient();
    await client.connect();
    try {
      await seedBenchTableDoc(client);
      const diag = await inspectLexicalQuery(client, {
        query: LEX_QUERY,
        language: 'english'
      });
      if (!diag.indexable) {
        throw new Error(`bench_query_not_indexable:${diag.query}`);
      }
      const lexRows = await queryLexicalLaneRows(client, {
        query: LEX_QUERY,
        language: 'english',
        limit: 10,
        scope: DEFAULT_SCOPE
      });
      if (!Array.isArray(lexRows) || lexRows.length < 1) {
        throw new Error('bench_query_lex_empty_result');
      }
      const trgmRows = await queryTrgmLaneRows(client, {
        query: TYPO_QUERY,
        limit: 10,
        threshold: 0.3,
        scope: DEFAULT_SCOPE
      });
      if (!Array.isArray(trgmRows) || trgmRows.length < 1) {
        throw new Error('bench_query_trgm_empty_result');
      }
      const vectorRows = await queryVectorLaneRows(client, {
        queryVector: embedTextDeterministic(VECTOR_QUERY),
        model: RETRIEVAL_EMBED_MODEL_DEFAULT,
        limit: 10,
        candidateLimit: 40,
        efSearch: 80,
        scope: DEFAULT_SCOPE
      });
      if (!Array.isArray(vectorRows) || vectorRows.length < 1) {
        throw new Error('bench_query_vec_empty_result');
      }
      const tableExactRows = await queryTableLaneRows(client, {
        query: TABLE_EXACT_QUERY,
        language: 'english',
        limit: 10,
        scope: DEFAULT_SCOPE
      });
      if (!Array.isArray(tableExactRows) || tableExactRows.length < 1) {
        throw new Error('bench_query_table_exact_empty_result');
      }
      const tableFtsRows = await queryTableLaneRows(client, {
        query: TABLE_FTS_QUERY,
        language: 'english',
        limit: 10,
        scope: DEFAULT_SCOPE
      });
      if (!Array.isArray(tableFtsRows) || tableFtsRows.length < 1) {
        throw new Error('bench_query_table_fts_empty_result');
      }

      const { queryHashes, explainManifest } = await captureExplainArtifacts(client);

      const lexRuns = [];
      const trgmRuns = [];
      const vecRuns = [];
      const tblExactRuns = [];
      const tblFtsRuns = [];
      const fuseRuns = [];
      for (let i = 0; i < BENCH_RUNS; i += 1) {
        let start = performance.now();
        const lex = await queryLexicalLaneRows(client, {
          query: LEX_QUERY,
          language: 'english',
          limit: 25,
          scope: DEFAULT_SCOPE
        });
        lexRuns.push(performance.now() - start);
        if (!Array.isArray(lex) || lex.length === 0) throw new Error('bench_query_empty_lex');

        start = performance.now();
        const trgm = await queryTrgmLaneRows(client, {
          query: TYPO_QUERY,
          limit: 25,
          threshold: 0.3,
          scope: DEFAULT_SCOPE
        });
        trgmRuns.push(performance.now() - start);
        if (!Array.isArray(trgm) || trgm.length === 0) throw new Error('bench_query_empty_trgm');

        start = performance.now();
        const vec = await queryVectorLaneRows(client, {
          queryVector: embedTextDeterministic(VECTOR_QUERY),
          model: RETRIEVAL_EMBED_MODEL_DEFAULT,
          limit: 25,
          candidateLimit: 80,
          efSearch: 80,
          scope: DEFAULT_SCOPE
        });
        vecRuns.push(performance.now() - start);
        if (!Array.isArray(vec) || vec.length === 0) throw new Error('bench_query_empty_vec');

        start = performance.now();
        const tblExact = await queryTableLaneRows(client, {
          query: TABLE_EXACT_QUERY,
          language: 'english',
          limit: 25,
          scope: DEFAULT_SCOPE
        });
        tblExactRuns.push(performance.now() - start);
        if (!Array.isArray(tblExact) || tblExact.length === 0) throw new Error('bench_query_empty_tbl_exact');

        start = performance.now();
        const tblFts = await queryTableLaneRows(client, {
          query: TABLE_FTS_QUERY,
          language: 'english',
          limit: 25,
          scope: DEFAULT_SCOPE
        });
        tblFtsRuns.push(performance.now() - start);
        if (!Array.isArray(tblFts) || tblFts.length === 0) throw new Error('bench_query_empty_tbl_fts');

        start = performance.now();
        const fused = await queryRankedBlocksByTsQuery(client, {
          query: VECTOR_QUERY,
          limit: 25,
          enableVector: true,
          vector: { enabled: true, indexType: 'hnsw', efSearch: 80, candidateLimit: 80 },
          scope: DEFAULT_SCOPE
        });
        fuseRuns.push(performance.now() - start);
        if (!Array.isArray(fused) || fused.length === 0) {
          throw new Error('bench_query_empty_result');
        }
      }

      const metric = {
        query_p50_ms: Number(percentile(fuseRuns, 50).toFixed(2)),
        query_p95_ms: Number(percentile(fuseRuns, 95).toFixed(2)),
        fts_query_p95_ms: Number(percentile(lexRuns, 95).toFixed(2)),
        retr_lex_p95_ms: Number(percentile(lexRuns, 95).toFixed(2)),
        retr_trgm_p95_ms: Number(percentile(trgmRuns, 95).toFixed(2)),
        retr_vec_p95_ms: Number(percentile(vecRuns, 95).toFixed(2)),
        retr_tbl_p95_ms: Number(Math.max(percentile(tblExactRuns, 95), percentile(tblFtsRuns, 95)).toFixed(2)),
        retr_fuse_p95_ms: Number(percentile(fuseRuns, 95).toFixed(2))
      };

      const tableMetrics = {
        retr_tbl_exact_p95_ms: Number(percentile(tblExactRuns, 95).toFixed(2)),
        retr_tbl_fts_p95_ms: Number(percentile(tblFtsRuns, 95).toFixed(2))
      };

      queryHashes.push(
        {
          class: 'retrieval.service.fused',
          query_hash: hashRedacted({ query: VECTOR_QUERY, limit: 25, enableVector: true, scope: DEFAULT_SCOPE }),
          sql_hash: null,
          plan_hash: null,
          param_count: 0
        },
        {
          class: 'retrieval.metrics.table.exact',
          query_hash: hashRedacted({ query: TABLE_EXACT_QUERY, scope: DEFAULT_SCOPE }),
          sql_hash: null,
          plan_hash: null,
          param_count: 0
        },
        {
          class: 'retrieval.metrics.table.fts',
          query_hash: hashRedacted({ query: TABLE_FTS_QUERY, scope: DEFAULT_SCOPE }),
          sql_hash: null,
          plan_hash: null,
          param_count: 0
        }
      );

      await mkdir('.cache/bench', { recursive: true });
      await writeJson('.cache/bench/query.json', metric);
      await writeJson('.cache/bench/query-hashes.json', {
        generated_by: 'scripts/bench-query.mjs',
        redaction: 'query text and long params hashed; no raw query text persisted',
        classes: queryHashes.sort((a, b) => a.class.localeCompare(b.class))
      });
      await writeJson('.cache/bench/explain-manifest.json', {
        generated_by: 'scripts/bench-query.mjs',
        explain_artifacts: explainManifest.sort((a, b) => a.class.localeCompare(b.class))
      });
      process.stdout.write(`${JSON.stringify(metric)}\n`);
      process.stdout.write(`${JSON.stringify(tableMetrics)}\n`);
    } finally {
      await client.end();
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
