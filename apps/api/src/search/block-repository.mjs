const DEFAULT_FTS_LANGUAGE = 'english';

/**
 * @param {string|undefined} value
 */
function resolveFtsLanguage(value) {
  const normalized = String(value ?? DEFAULT_FTS_LANGUAGE).trim().toLowerCase();
  if (normalized !== 'english') {
    throw new Error('invalid_fts_language');
  }
  return normalized;
}

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
  return { indexed: result.rowCount };
}

/**
 * @param {import('pg').Client} client
 * @param {{query:string, language?:string, limit?:number}} params
 */
export async function queryRankedBlocksByTsQuery(client, params) {
  const language = resolveFtsLanguage(params.language);
  const query = String(params.query ?? '').trim();
  if (!query) {
    return [];
  }
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(params.limit ?? 50))));
  const result = await client.query(
    `SELECT doc_id, ver, block_id, ts_rank(tsv, q) AS rank
     FROM block, to_tsquery($1::regconfig, $2) AS q
     WHERE tsv @@ q
     ORDER BY rank DESC, doc_id ASC, ver ASC, block_id ASC
     LIMIT $3`,
    [language, query, limit]
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
  const pages = [...new Set(params.pageNumbers.map((page) => Number(page)).filter((page) => Number.isInteger(page) && page >= 1))].sort(
    (a, b) => a - b
  );
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
  const pages = [...new Set(params.pageNumbers.map((page) => Number(page)).filter((page) => Number.isInteger(page) && page >= 1))].sort(
    (a, b) => a - b
  );
  if (pages.length < 1) return { indexed: 0 };
  const language = resolveFtsLanguage(params.language);
  const result = await client.query(
    `UPDATE block
     SET tsv = to_tsvector($3::regconfig, coalesce(text, ''))
     WHERE doc_id = $1 AND ver = $2 AND page = ANY($4::int[])`,
    [params.docId, params.version, language, pages]
  );
  return { indexed: result.rowCount };
}
