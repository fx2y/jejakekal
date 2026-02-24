import { resolveFtsLanguage } from '../retrieval/lanes/lexical.mjs';
import { toPgVectorLiteral } from '../retrieval/embeddings.mjs';
import { deriveTableId } from '../../../../packages/pipeline/src/docir/normalize-marker.mjs';

const DEFAULT_NAMESPACE = 'default';

/**
 * @param {unknown} value
 */
function assertJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_block_provenance');
  }
  return value;
}

/**
 * @param {unknown} value
 */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {unknown} value
 */
function normalizeText(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  return text.replace(/\s+/g, ' ');
}

/**
 * @param {unknown} value
 */
function parseNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Number(value.replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {{row_idx:number,col_idx:number,key_norm:string|null,val_norm:string|null,val_num:number|null,unit:string|null,text:string|null}} a
 * @param {{row_idx:number,col_idx:number,key_norm:string|null,val_norm:string|null,val_num:number|null,unit:string|null,text:string|null}} b
 */
function compareTableCells(a, b) {
  if (a.row_idx !== b.row_idx) return a.row_idx - b.row_idx;
  if (a.col_idx !== b.col_idx) return a.col_idx - b.col_idx;
  if ((a.key_norm ?? '') !== (b.key_norm ?? '')) return (a.key_norm ?? '').localeCompare(b.key_norm ?? '');
  return (a.val_norm ?? '').localeCompare(b.val_norm ?? '');
}

/**
 * @param {Record<string, unknown>} data
 * @param {string|null} fallbackText
 */
function rowizeTableCells(data, fallbackText) {
  /** @type {Array<{row_idx:number,col_idx:number,key_norm:string|null,val_norm:string|null,val_num:number|null,unit:string|null,text:string|null}>} */
  const out = [];
  const rows = Array.isArray(data.rows) ? data.rows : null;
  if (rows && rows.length > 0) {
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx += 1) {
      const row = rows[rowIdx];
      if (Array.isArray(row)) {
        for (let colIdx = 0; colIdx < row.length; colIdx += 1) {
          const cell = row[colIdx];
          const valNorm = normalizeText(cell);
          out.push({
            row_idx: rowIdx,
            col_idx: colIdx,
            key_norm: null,
            val_norm: valNorm,
            val_num: parseNumeric(cell),
            unit: null,
            text: valNorm
          });
        }
        continue;
      }
      const rowObj = asRecord(row);
      if (!rowObj) continue;
      const keys = Object.keys(rowObj).sort((a, b) => a.localeCompare(b));
      for (let colIdx = 0; colIdx < keys.length; colIdx += 1) {
        const key = keys[colIdx];
        const value = rowObj[key];
        const keyNorm = normalizeText(key);
        const valNorm = normalizeText(value);
        out.push({
          row_idx: rowIdx,
          col_idx: colIdx,
          key_norm: keyNorm,
          val_norm: valNorm,
          val_num: parseNumeric(value),
          unit: null,
          text: [keyNorm, valNorm].filter(Boolean).join(' ') || null
        });
      }
    }
  }
  if (out.length < 1 && fallbackText) {
    out.push({
      row_idx: 0,
      col_idx: 0,
      key_norm: null,
      val_norm: fallbackText,
      val_num: parseNumeric(fallbackText),
      unit: null,
      text: fallbackText
    });
  }
  return out.sort(compareTableCells);
}

/**
 * Build a stable table payload for `table_id` hashing from persisted block data.
 * Marker tables usually store rows/headers at top-level; OCR tables store payload under `data.table`.
 * @param {Record<string, unknown>} data
 * @param {string|null} fallbackText
 */
function canonicalizeTablePayload(data, fallbackText) {
  const nested = asRecord(data.table);
  if (nested) return nested;
  /** @type {Record<string, unknown>} */
  const picked = {};
  for (const key of ['headers', 'rows', 'cells', 'columns', 'caption', 'title', 'unit']) {
    if (key in data) {
      picked[key] = data[key];
    }
  }
  if (Object.keys(picked).length > 0) return picked;
  return fallbackText ? { text: fallbackText } : {};
}

/**
 * @param {number[] | undefined} pageNumbers
 */
function canonicalPages(pageNumbers) {
  if (!Array.isArray(pageNumbers)) return [];
  return [...new Set(pageNumbers.map((page) => Number(page)).filter((page) => Number.isInteger(page) && page >= 1))].sort((a, b) => a - b);
}

/**
 * @param {unknown} value
 */
function resolveVectorIndexType(value) {
  const normalized = String(value ?? 'hnsw').trim().toLowerCase();
  if (normalized === 'hnsw' || normalized === 'ivf') return normalized;
  throw new Error('invalid_vector_index_type');
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} code
 */
function resolvePositiveInt(value, fallback, code) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  const int = Math.trunc(parsed);
  if (int < 1) throw new Error(code);
  return int;
}

/**
 * @param {import('pg').Client} client
 * @param {{docId:string, version:number, language?:string, pageNumbers?:number[]}} params
 */
async function syncRetrievalProjection(client, params) {
  const language = resolveFtsLanguage(params.language);
  const pages = canonicalPages(params.pageNumbers);
  const pageScoped = pages.length > 0;

  if (pageScoped) {
    await client.query(
      `DELETE FROM doc_block d
       WHERE d.doc_id = $1
         AND d.ver = $2
         AND d.page = ANY($3::int[])
         AND NOT EXISTS (
           SELECT 1
           FROM block b
           WHERE b.doc_id = d.doc_id
             AND b.ver = d.ver
             AND b.block_id = d.block_id
         )`,
      [params.docId, params.version, pages]
    );
  } else {
    await client.query(
      `DELETE FROM doc_block d
       WHERE d.doc_id = $1
         AND d.ver = $2
         AND NOT EXISTS (
           SELECT 1
           FROM block b
           WHERE b.doc_id = d.doc_id
             AND b.ver = d.ver
             AND b.block_id = d.block_id
         )`,
      [params.docId, params.version]
    );
  }

  await client.query(
    pageScoped
      ? `INSERT INTO doc_block (doc_id, ver, block_id, ns, acl, type, text, data, title_norm, entity_norm, key_norm, page, bbox, block_sha)
         SELECT b.doc_id,
                b.ver,
                b.block_id,
                $4::text,
                '{}'::jsonb,
                b.type,
                b.text,
                b.data,
                NULLIF(BTRIM(REGEXP_REPLACE(LOWER(UNACCENT(COALESCE(b.data->>'title', b.data->>'header', b.data->>'heading', ''))), '\\s+', ' ', 'g')), ''),
                NULLIF(BTRIM(REGEXP_REPLACE(LOWER(UNACCENT(COALESCE(b.data->>'entity', b.data->>'name', ''))), '\\s+', ' ', 'g')), ''),
                NULLIF(
                  SPLIT_PART(
                    BTRIM(
                      REGEXP_REPLACE(
                        LOWER(UNACCENT(COALESCE(b.data->>'key', b.data->>'keyword', b.text, ''))),
                        '\\s+',
                        ' ',
                        'g'
                      )
                    ),
                    ' ',
                    1
                  ),
                  ''
                ),
                b.page,
                b.bbox,
                b.block_sha
         FROM block b
         WHERE b.doc_id = $1
           AND b.ver = $2
           AND b.page = ANY($3::int[])
         ON CONFLICT (doc_id, ver, block_id) DO UPDATE
         SET type = EXCLUDED.type,
              text = EXCLUDED.text,
              data = EXCLUDED.data,
              title_norm = EXCLUDED.title_norm,
              entity_norm = EXCLUDED.entity_norm,
              key_norm = EXCLUDED.key_norm,
              page = EXCLUDED.page,
              bbox = EXCLUDED.bbox,
              block_sha = EXCLUDED.block_sha,
              updated_at = NOW()`
      : `INSERT INTO doc_block (doc_id, ver, block_id, ns, acl, type, text, data, title_norm, entity_norm, key_norm, page, bbox, block_sha)
         SELECT b.doc_id,
                b.ver,
                b.block_id,
                $3::text,
                '{}'::jsonb,
                b.type,
                b.text,
                b.data,
                NULLIF(BTRIM(REGEXP_REPLACE(LOWER(UNACCENT(COALESCE(b.data->>'title', b.data->>'header', b.data->>'heading', ''))), '\\s+', ' ', 'g')), ''),
                NULLIF(BTRIM(REGEXP_REPLACE(LOWER(UNACCENT(COALESCE(b.data->>'entity', b.data->>'name', ''))), '\\s+', ' ', 'g')), ''),
                NULLIF(
                  SPLIT_PART(
                    BTRIM(
                      REGEXP_REPLACE(
                        LOWER(UNACCENT(COALESCE(b.data->>'key', b.data->>'keyword', b.text, ''))),
                        '\\s+',
                        ' ',
                        'g'
                      )
                    ),
                    ' ',
                    1
                  ),
                  ''
                ),
                b.page,
                b.bbox,
                b.block_sha
         FROM block b
         WHERE b.doc_id = $1
           AND b.ver = $2
         ON CONFLICT (doc_id, ver, block_id) DO UPDATE
         SET type = EXCLUDED.type,
              text = EXCLUDED.text,
              data = EXCLUDED.data,
              title_norm = EXCLUDED.title_norm,
              entity_norm = EXCLUDED.entity_norm,
              key_norm = EXCLUDED.key_norm,
              page = EXCLUDED.page,
              bbox = EXCLUDED.bbox,
              block_sha = EXCLUDED.block_sha,
              updated_at = NOW()`,
    pageScoped ? [params.docId, params.version, pages, DEFAULT_NAMESPACE] : [params.docId, params.version, DEFAULT_NAMESPACE]
  );

  await client.query(
    pageScoped
      ? `INSERT INTO doc_block_fts (block_pk, vec)
         SELECT d.id,
                setweight(
                  to_tsvector(
                    $4::regconfig,
                    coalesce(d.data->>'title', d.data->>'header', d.data->>'heading', '')
                  ),
                  'A'
                )
                || setweight(
                  to_tsvector(
                    $4::regconfig,
                    coalesce(d.data->>'subtitle', d.data->>'section', '')
                  ),
                  'B'
                )
                || setweight(to_tsvector($4::regconfig, coalesce(d.text, '')), 'D')
         FROM doc_block d
         WHERE d.doc_id = $1
           AND d.ver = $2
           AND d.page = ANY($3::int[])
         ON CONFLICT (block_pk) DO UPDATE
         SET vec = EXCLUDED.vec,
             updated_at = NOW()`
      : `INSERT INTO doc_block_fts (block_pk, vec)
         SELECT d.id,
                setweight(
                  to_tsvector(
                    $3::regconfig,
                    coalesce(d.data->>'title', d.data->>'header', d.data->>'heading', '')
                  ),
                  'A'
                )
                || setweight(
                  to_tsvector(
                    $3::regconfig,
                    coalesce(d.data->>'subtitle', d.data->>'section', '')
                  ),
                  'B'
                )
                || setweight(to_tsvector($3::regconfig, coalesce(d.text, '')), 'D')
         FROM doc_block d
         WHERE d.doc_id = $1
           AND d.ver = $2
         ON CONFLICT (block_pk) DO UPDATE
         SET vec = EXCLUDED.vec,
             updated_at = NOW()`,
    pageScoped ? [params.docId, params.version, pages, language] : [params.docId, params.version, language]
  );

  const tableBlocksResult = await client.query(
    pageScoped
      ? `SELECT block_id, page, bbox, text, data, block_sha
         FROM doc_block
         WHERE doc_id = $1
           AND ver = $2
           AND type = 'table'
           AND page = ANY($3::int[])
         ORDER BY page ASC, block_id ASC`
      : `SELECT block_id, page, bbox, text, data, block_sha
         FROM doc_block
         WHERE doc_id = $1
           AND ver = $2
           AND type = 'table'
         ORDER BY page ASC, block_id ASC`,
    pageScoped ? [params.docId, params.version, pages] : [params.docId, params.version]
  );

  await client.query(
    pageScoped
      ? `DELETE FROM table_cell
         WHERE doc_id = $1
           AND ver = $2
           AND page = ANY($3::int[])`
      : `DELETE FROM table_cell
         WHERE doc_id = $1
           AND ver = $2`,
    pageScoped ? [params.docId, params.version, pages] : [params.docId, params.version]
  );

  let insertedTableCells = 0;
  for (const block of tableBlocksResult.rows) {
    const data = asRecord(block.data) ?? {};
    const fallbackText = normalizeText(block.text);
    const cells = rowizeTableCells(data, fallbackText);
    const tableId = deriveTableId(
      params.docId,
      params.version,
      Number(block.page),
      canonicalizeTablePayload(data, fallbackText)
    );
    const cite = {
      doc_version: params.version,
      page: Number(block.page),
      bbox: Array.isArray(block.bbox) ? block.bbox : null,
      block_hash: String(block.block_sha),
      block_id: String(block.block_id)
    };
    for (const cell of cells) {
      const result = await client.query(
        `INSERT INTO table_cell (
          doc_id, ver, table_id, page, row_idx, col_idx, key_norm, val_norm, val_num, unit, text, cite
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
         ON CONFLICT (doc_id, ver, table_id, row_idx, col_idx) DO UPDATE
         SET page = EXCLUDED.page,
             key_norm = EXCLUDED.key_norm,
             val_norm = EXCLUDED.val_norm,
             val_num = EXCLUDED.val_num,
             unit = EXCLUDED.unit,
             text = EXCLUDED.text,
             cite = EXCLUDED.cite,
             updated_at = NOW()`,
        [
          params.docId,
          params.version,
          tableId,
          Number(block.page),
          cell.row_idx,
          cell.col_idx,
          cell.key_norm,
          cell.val_norm,
          cell.val_num,
          cell.unit,
          cell.text,
          JSON.stringify(cite)
        ]
      );
      insertedTableCells += result.rowCount ?? 0;
    }
  }

  await client.query(
    pageScoped
      ? `UPDATE table_cell
         SET vec = to_tsvector($4::regconfig, coalesce(text, ''))
         WHERE doc_id = $1
           AND ver = $2
           AND page = ANY($3::int[])`
      : `UPDATE table_cell
         SET vec = to_tsvector($3::regconfig, coalesce(text, ''))
         WHERE doc_id = $1
           AND ver = $2`,
    pageScoped ? [params.docId, params.version, pages, language] : [params.docId, params.version, language]
  );

  const projectionCount = await client.query(
    pageScoped
      ? `SELECT COUNT(*)::int AS count
         FROM doc_block
         WHERE doc_id = $1
           AND ver = $2
           AND page = ANY($3::int[])`
      : `SELECT COUNT(*)::int AS count
         FROM doc_block
         WHERE doc_id = $1
           AND ver = $2`,
    pageScoped ? [params.docId, params.version, pages] : [params.docId, params.version]
  );

  return {
    projected: Number(projectionCount.rows[0]?.count ?? 0),
    table_cells: insertedTableCells
  };
}

/**
 * @param {import('pg').Client} client
 * @param {{docId:string, version:number, blocks:Array<{block_id:string,type:string,page:number,bbox:Array<number>|null,text:string|null,data:Record<string,unknown>,block_sha:string}>, provenance:Record<string, unknown>}} params
 */
export async function upsertBlockLedger(client, params) {
  const provenance = JSON.stringify(assertJsonObject(params.provenance));
  let upserted = 0;
  for (const block of params.blocks) {
    const result = await client.query(
      `INSERT INTO block (doc_id, ver, block_id, type, page, bbox, text, data, block_sha, prov)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10::jsonb)
       ON CONFLICT (doc_id, ver, block_id) DO UPDATE
       SET type = EXCLUDED.type,
           page = EXCLUDED.page,
           bbox = EXCLUDED.bbox,
           text = EXCLUDED.text,
           data = EXCLUDED.data,
           block_sha = EXCLUDED.block_sha,
           prov = EXCLUDED.prov
       WHERE block.block_sha = EXCLUDED.block_sha
       RETURNING block_id`,
      [
        params.docId,
        params.version,
        block.block_id,
        block.type,
        block.page,
        JSON.stringify(block.bbox),
        block.text,
        JSON.stringify(block.data),
        block.block_sha,
        provenance
      ]
    );
    if (result.rowCount !== 1) {
      throw new Error('block_conflict_mismatch');
    }
    upserted += 1;
  }
  return { upserted };
}

/**
 * @param {import('pg').Client} client
 * @param {{docId:string, version:number, language?:string}} params
 */
export async function populateBlockTsv(client, params) {
  const language = resolveFtsLanguage(params.language);
  const result = await client.query(
    `UPDATE block
     SET tsv = to_tsvector($3::regconfig, coalesce(text, ''))
     WHERE doc_id = $1 AND ver = $2`,
    [params.docId, params.version, language]
  );
  const projection = await syncRetrievalProjection(client, {
    docId: params.docId,
    version: params.version,
    language
  });
  return { indexed: result.rowCount, projection };
}

/**
 * @param {import('pg').Client} client
 * @param {{query:string, language:string}} params
 */
export async function inspectLexicalQuery(client, params) {
  const query = String(params.query ?? '').trim();
  if (!query) {
    return {
      language: resolveFtsLanguage(params.language),
      query: '',
      indexable_query: '',
      indexable: false
    };
  }
  const language = resolveFtsLanguage(params.language);
  const result = await client.query(
    `SELECT querytree(websearch_to_tsquery($1::regconfig, $2)) AS idx_q`,
    [language, query]
  );
  const indexableQuery = String(result.rows[0]?.idx_q ?? '');
  return {
    language,
    query,
    indexable_query: indexableQuery,
    indexable: indexableQuery.length > 0
  };
}

/**
 * @param {import('pg').Client} client
 * @param {{query:string, language:string, docId:string, version:number, blockId:string}} params
 */
export async function buildLexicalHeadline(client, params) {
  const query = String(params.query ?? '').trim();
  if (!query) return null;
  const language = resolveFtsLanguage(params.language);
  const result = await client.query(
    `SELECT ts_headline(
              $1::regconfig,
              coalesce(b.text, ''),
              websearch_to_tsquery($1::regconfig, $2),
              'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MinWords=4,MaxWords=18,FragmentDelimiter=" ... "'
            ) AS snippet
     FROM doc_block b
     WHERE b.doc_id = $3
       AND b.ver = $4
       AND b.block_id = $5
     LIMIT 1`,
    [language, query, params.docId, params.version, params.blockId]
  );
  if (result.rows.length !== 1) return null;
  const snippet = result.rows[0]?.snippet;
  return typeof snippet === 'string' && snippet.length > 0 ? snippet : null;
}

/**
 * @param {import('pg').Client} client
 * SQL adapter only: lexical lane candidate query against the legacy block ledger.
 * @param {{query:string, language:string, limit:number, scope:{namespaces:string[]}}} params
 */
export async function queryLexicalLaneRows(client, params) {
  const query = String(params.query ?? '').trim();
  if (!query) {
    return [];
  }
  const language = resolveFtsLanguage(params.language);
  const namespaces = Array.isArray(params.scope?.namespaces)
    ? [...new Set(params.scope.namespaces.map((entry) => String(entry ?? '').trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      )
    : [];
  if (namespaces.length < 1) {
    return [];
  }
  const diagnostics = await inspectLexicalQuery(client, { query, language });
  if (!diagnostics.indexable) {
    return [];
  }
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(params.limit ?? 50))));
  const result = await client.query(
    `WITH q AS (
       SELECT websearch_to_tsquery($1::regconfig, $2) AS tsq
     )
     SELECT b.doc_id,
            b.ver,
            b.block_id,
            ts_rank_cd(f.vec, q.tsq) AS rank
     FROM q
     JOIN doc_block b ON b.ns = ANY($3::text[])
     JOIN doc_block_fts f ON f.block_pk = b.id
     WHERE f.vec @@ q.tsq
     ORDER BY rank DESC, b.id ASC
     LIMIT $4`,
    [language, query, namespaces, limit]
  );
  return result.rows.map((row) => ({
    doc_id: String(row.doc_id),
    ver: Number(row.ver),
    block_id: String(row.block_id),
    rank: Number(row.rank)
  }));
}

/**
 * @param {import('pg').Client} client
 * SQL adapter only: trigram lane candidate query against normalized short fields.
 * @param {{query:string, limit:number, threshold:number, scope:{namespaces:string[], acl?:Record<string, unknown>}}} params
 */
export async function queryTrgmLaneRows(client, params) {
  const query = normalizeText(params.query);
  if (!query || query.length < 3) {
    return [];
  }
  const namespaces = Array.isArray(params.scope?.namespaces)
    ? [...new Set(params.scope.namespaces.map((entry) => String(entry ?? '').trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      )
    : [];
  if (namespaces.length < 1) {
    return [];
  }
  const acl =
    params.scope?.acl && typeof params.scope.acl === 'object' && !Array.isArray(params.scope.acl) ? params.scope.acl : {};
  const threshold = Number.isFinite(Number(params.threshold))
    ? Math.max(0, Math.min(1, Number(params.threshold)))
    : 0.3;
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(params.limit ?? 50))));
  const result = await client.query(
    `WITH cfg AS (
       SELECT set_config('pg_trgm.similarity_threshold', $1::text, true)
     ),
     q AS (
       SELECT $2::text AS txt, $3::jsonb AS acl
     )
     SELECT b.doc_id,
            b.ver,
            b.block_id,
            GREATEST(
              similarity(COALESCE(b.title_norm, ''), q.txt),
              similarity(COALESCE(b.entity_norm, ''), q.txt),
              similarity(COALESCE(b.key_norm, ''), q.txt)
            ) AS rank
     FROM cfg
     JOIN q ON TRUE
     JOIN doc_block b ON b.ns = ANY($4::text[])
     WHERE b.acl @> q.acl
       AND (
         (b.title_norm IS NOT NULL AND b.title_norm % q.txt)
         OR (b.entity_norm IS NOT NULL AND b.entity_norm % q.txt)
         OR (b.key_norm IS NOT NULL AND b.key_norm % q.txt)
       )
     ORDER BY rank DESC, b.id ASC
     LIMIT $5`,
    [String(threshold), query, JSON.stringify(acl), namespaces, limit]
  );
  return result.rows.map((row) => ({
    doc_id: String(row.doc_id),
    ver: Number(row.ver),
    block_id: String(row.block_id),
    rank: Number(row.rank)
  }));
}

/**
 * @param {import('pg').Client} client
 * @param {{docId:string, version:number, pageNumbers?:number[]}} params
 */
export async function listEmbeddableDocBlocks(client, params) {
  const pages = canonicalPages(params.pageNumbers);
  const pageScoped = pages.length > 0;
  const result = await client.query(
    pageScoped
      ? `SELECT b.block_id, b.block_sha, b.type, b.page, b.text, b.data
         FROM doc_block b
         WHERE b.doc_id = $1
           AND b.ver = $2
           AND b.page = ANY($3::int[])
         ORDER BY b.page ASC, b.block_id ASC`
      : `SELECT b.block_id, b.block_sha, b.type, b.page, b.text, b.data
         FROM doc_block b
         WHERE b.doc_id = $1
           AND b.ver = $2
         ORDER BY b.page ASC, b.block_id ASC`,
    pageScoped ? [params.docId, params.version, pages] : [params.docId, params.version]
  );
  return result.rows.map((row) => ({
    block_id: String(row.block_id),
    block_sha: String(row.block_sha),
    type: String(row.type),
    page: Number(row.page),
    text: typeof row.text === 'string' ? row.text : null,
    data: asRecord(row.data) ?? {}
  }));
}

/**
 * @param {import('pg').Client} client
 * @param {{docId:string, version:number, model:string, rows:Array<{block_id:string, emb:number[]}>, pageNumbers?:number[]}} params
 */
export async function replaceDocBlockEmbeddings(client, params) {
  const pages = canonicalPages(params.pageNumbers);
  const pageScoped = pages.length > 0;
  const model = String(params.model ?? '').trim();
  if (!model) throw new Error('invalid_embedding_model');
  await client.query(
    pageScoped
      ? `DELETE FROM doc_block_vec v
         USING doc_block b
         WHERE v.block_pk = b.id
           AND b.doc_id = $1
           AND b.ver = $2
           AND b.page = ANY($3::int[])`
      : `DELETE FROM doc_block_vec v
         USING doc_block b
         WHERE v.block_pk = b.id
           AND b.doc_id = $1
           AND b.ver = $2`,
    pageScoped ? [params.docId, params.version, pages] : [params.docId, params.version]
  );
  let upserted = 0;
  for (const row of params.rows) {
    const result = await client.query(
      `INSERT INTO doc_block_vec (block_pk, emb, model)
       SELECT b.id, $4::vector, $5::text
       FROM doc_block b
       WHERE b.doc_id = $1
         AND b.ver = $2
         AND b.block_id = $3
       ON CONFLICT (block_pk) DO UPDATE
       SET emb = EXCLUDED.emb,
           model = EXCLUDED.model,
           updated_at = NOW()`,
      [params.docId, params.version, row.block_id, toPgVectorLiteral(row.emb), model]
    );
    upserted += result.rowCount ?? 0;
  }
  return { upserted };
}

/**
 * @param {import('pg').Client} client
 * @param {{queryVector:number[], model:string, limit:number, candidateLimit?:number, efSearch?:number, ivfProbes?:number, indexType?:'hnsw'|'ivf', scope:{namespaces:string[], acl?:Record<string, unknown>}}} params
 */
export async function queryVectorLaneRows(client, params) {
  const namespaces = Array.isArray(params.scope?.namespaces)
    ? [...new Set(params.scope.namespaces.map((entry) => String(entry ?? '').trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      )
    : [];
  if (namespaces.length < 1) return [];
  const acl =
    params.scope?.acl && typeof params.scope.acl === 'object' && !Array.isArray(params.scope.acl) ? params.scope.acl : {};
  const model = String(params.model ?? '').trim();
  if (!model) throw new Error('invalid_embedding_model');
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(params.limit ?? 50))));
  const candidateLimit = Math.max(limit, Math.min(400, Math.trunc(Number(params.candidateLimit ?? Math.max(limit * 4, 50)))));
  const indexType = resolveVectorIndexType(params.indexType);
  const efSearch = resolvePositiveInt(params.efSearch, 80, 'invalid_vector_ef_search');
  const ivfProbes = resolvePositiveInt(params.ivfProbes, 10, 'invalid_vector_ivf_probes');
  const vectorLiteral = toPgVectorLiteral(params.queryVector);
  const result = await client.query(
    `WITH cfg_hnsw AS (
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
       SELECT b.id AS block_pk,
              b.doc_id,
              b.ver,
              b.block_id
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
     SELECT ann.doc_id,
            ann.ver,
            ann.block_id,
            1 - (v.emb <=> q.emb) AS rank,
            (v.emb <=> q.emb) AS distance
     FROM ann
     JOIN doc_block_vec v ON v.block_pk = ann.block_pk
     JOIN q ON TRUE
     ORDER BY distance ASC, ann.block_pk ASC
     LIMIT $9`,
    [
      indexType,
      String(efSearch),
      String(ivfProbes),
      vectorLiteral,
      JSON.stringify(acl),
      namespaces,
      model,
      candidateLimit,
      limit
    ]
  );
  return result.rows.map((row) => ({
    doc_id: String(row.doc_id),
    ver: Number(row.ver),
    block_id: String(row.block_id),
    rank: Number(row.rank),
    distance: Number(row.distance)
  }));
}

/**
 * @param {unknown} value
 */
function asTableCellCite(value) {
  const cite = asRecord(value);
  return cite ?? {};
}

/**
 * @param {import('pg').Client} client
 * SQL adapter only: table-cell retrieval with exact-key fast path and FTS fallback.
 * Returns ordered cell hits (not block-deduped) so callers can preserve `(table,row,col)` address semantics.
 * @param {{query:string, language:string, limit:number, scope:{namespaces:string[], acl?:Record<string, unknown>}}} params
 */
export async function queryTableCellLaneRows(client, params) {
  const rawQuery = String(params.query ?? '').trim();
  if (!rawQuery) return [];
  const keyQuery = normalizeText(rawQuery);
  if (!keyQuery) return [];
  const language = resolveFtsLanguage(params.language);
  const namespaces = Array.isArray(params.scope?.namespaces)
    ? [...new Set(params.scope.namespaces.map((entry) => String(entry ?? '').trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      )
    : [];
  if (namespaces.length < 1) return [];
  const acl =
    params.scope?.acl && typeof params.scope.acl === 'object' && !Array.isArray(params.scope.acl) ? params.scope.acl : {};
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(params.limit ?? 50))));

  const exact = await client.query(
    `WITH q AS (
       SELECT $1::text AS key_q, $2::jsonb AS acl
     )
     SELECT t.doc_id,
            t.ver,
            (t.cite->>'block_id') AS block_id,
            t.table_id,
            t.row_idx,
            t.col_idx,
            t.key_norm,
            t.val_norm,
            t.val_num,
            t.unit,
            t.cite,
            1.0::double precision AS rank,
            'exact'::text AS match_kind
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
    [keyQuery, JSON.stringify(acl), namespaces, limit]
  );
  if (exact.rows.length > 0) {
    return exact.rows.map((row) => ({
      doc_id: String(row.doc_id),
      ver: Number(row.ver),
      block_id: String(row.block_id),
      table_id: String(row.table_id),
      row_idx: Number(row.row_idx),
      col_idx: Number(row.col_idx),
      key_norm: typeof row.key_norm === 'string' ? row.key_norm : null,
      val_norm: typeof row.val_norm === 'string' ? row.val_norm : null,
      val_num: typeof row.val_num === 'number' ? row.val_num : row.val_num == null ? null : Number(row.val_num),
      unit: typeof row.unit === 'string' ? row.unit : null,
      cite: asTableCellCite(row.cite),
      rank: Number(row.rank),
      match_kind: 'exact'
    }));
  }

  const diagnostics = await inspectLexicalQuery(client, { query: rawQuery, language });
  if (!diagnostics.indexable) return [];

  const fallback = await client.query(
    `WITH q AS (
       SELECT websearch_to_tsquery($1::regconfig, $2) AS tsq, $3::jsonb AS acl
     )
     SELECT t.doc_id,
            t.ver,
            (t.cite->>'block_id') AS block_id,
            t.table_id,
            t.row_idx,
            t.col_idx,
            t.key_norm,
            t.val_norm,
            t.val_num,
            t.unit,
            t.cite,
            ts_rank_cd(t.vec, q.tsq) AS rank,
            'fts'::text AS match_kind
     FROM q
     JOIN table_cell t ON t.vec @@ q.tsq
     JOIN doc_block b
       ON b.doc_id = t.doc_id
      AND b.ver = t.ver
      AND b.block_id = (t.cite->>'block_id')
      AND b.type = 'table'
     WHERE b.ns = ANY($4::text[])
       AND b.acl @> q.acl
     ORDER BY rank DESC, t.doc_id ASC, t.ver ASC, t.page ASC, t.table_id ASC, t.row_idx ASC, t.col_idx ASC
     LIMIT $5`,
    [language, rawQuery, JSON.stringify(acl), namespaces, limit]
  );
  return fallback.rows.map((row) => ({
    doc_id: String(row.doc_id),
    ver: Number(row.ver),
    block_id: String(row.block_id),
    table_id: String(row.table_id),
    row_idx: Number(row.row_idx),
    col_idx: Number(row.col_idx),
    key_norm: typeof row.key_norm === 'string' ? row.key_norm : null,
    val_norm: typeof row.val_norm === 'string' ? row.val_norm : null,
    val_num: typeof row.val_num === 'number' ? row.val_num : row.val_num == null ? null : Number(row.val_num),
    unit: typeof row.unit === 'string' ? row.unit : null,
    cite: asTableCellCite(row.cite),
    rank: Number(row.rank),
    match_kind: 'fts'
  }));
}

/**
 * @param {import('pg').Client} client
 * @param {{query:string, language:string, limit:number, scope:{namespaces:string[], acl?:Record<string, unknown>}}} params
 */
export async function queryTableLaneRows(client, params) {
  const cellRows = await queryTableCellLaneRows(client, params);
  const byBlock = new Map();
  for (const row of cellRows) {
    const key = `${row.doc_id}:${row.ver}:${row.block_id}`;
    if (!byBlock.has(key)) {
      byBlock.set(key, {
        doc_id: row.doc_id,
        ver: row.ver,
        block_id: row.block_id,
        rank: row.rank
      });
    }
  }
  return [...byBlock.values()];
}

/**
 * @param {import('pg').Client} client
 * @param {{docId:string, version:number}} params
 */
export async function listBlocksByDocVersion(client, params) {
  const result = await client.query(
    `SELECT block_id, type, page, text, data, block_sha
     FROM block
     WHERE doc_id = $1 AND ver = $2
     ORDER BY page ASC, block_id ASC`,
    [params.docId, params.version]
  );
  return result.rows.map((row) => ({
    block_id: String(row.block_id),
    type: String(row.type),
    page: Number(row.page),
    text: typeof row.text === 'string' ? row.text : null,
    data:
      row.data && typeof row.data === 'object' && !Array.isArray(row.data)
        ? /** @type {Record<string, unknown>} */ (row.data)
        : {},
    block_sha: String(row.block_sha)
  }));
}

/**
 * @param {import('pg').Client} client
 * @param {{docId:string, version:number, pageNumbers:number[]}} params
 */
export async function deleteTextTableBlocksByPages(client, params) {
  const pages = canonicalPages(params.pageNumbers);
  if (pages.length < 1) return { deleted: 0 };
  const result = await client.query(
    `DELETE FROM block
     WHERE doc_id = $1
       AND ver = $2
       AND page = ANY($3::int[])
       AND type IN ('text','table')`,
    [params.docId, params.version, pages]
  );
  return { deleted: result.rowCount };
}

/**
 * @param {import('pg').Client} client
 * @param {{docId:string, version:number, pageNumbers:number[], language?:string}} params
 */
export async function populateBlockTsvForPages(client, params) {
  const pages = canonicalPages(params.pageNumbers);
  if (pages.length < 1) return { indexed: 0, projection: { projected: 0, table_cells: 0 } };
  const language = resolveFtsLanguage(params.language);
  const result = await client.query(
    `UPDATE block
     SET tsv = to_tsvector($3::regconfig, coalesce(text, ''))
     WHERE doc_id = $1 AND ver = $2 AND page = ANY($4::int[])`,
    [params.docId, params.version, language, pages]
  );
  const projection = await syncRetrievalProjection(client, {
    docId: params.docId,
    version: params.version,
    language,
    pageNumbers: pages
  });
  return { indexed: result.rowCount, projection };
}
