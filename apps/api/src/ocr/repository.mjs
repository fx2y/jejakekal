const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertNonEmptyString(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`invalid_ocr_${field}`);
  return normalized;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertNonNegativeInt(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid_ocr_${field}`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertPositiveInt(value, field) {
  const parsed = assertNonNegativeInt(value, field);
  if (parsed < 1) throw new Error(`invalid_ocr_${field}`);
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertSha256(value, field) {
  const normalized = assertNonEmptyString(value, field);
  if (!SHA256_HEX_RE.test(normalized)) {
    throw new Error(`invalid_ocr_${field}`);
  }
  return normalized;
}

/**
 * @param {unknown} value
 */
function toJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  return {};
}

/**
 * @param {unknown} value
 */
function toJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {import('pg').Client} client
 * @param {{job_id:string,doc_id:string,ver:number,gate_rev:string,policy?:Record<string, unknown>}} row
 */
export async function insertOcrJob(client, row) {
  const result = await client.query(
    `INSERT INTO ocr_job (job_id, doc_id, ver, gate_rev, policy)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (job_id) DO NOTHING
     RETURNING job_id, doc_id, ver, gate_rev, policy, created_at`,
    [
      assertNonEmptyString(row.job_id, 'job_id'),
      assertNonEmptyString(row.doc_id, 'doc_id'),
      assertPositiveInt(row.ver, 'ver'),
      assertNonEmptyString(row.gate_rev, 'gate_rev'),
      JSON.stringify(toJsonObject(row.policy))
    ]
  );
  return result.rows[0] ? mapOcrJobRow(result.rows[0]) : null;
}

/**
 * @param {import('pg').Client} client
 * @param {{job_id:string,page_idx:number,status:string,gate_score?:number|null,gate_reasons?:unknown[],png_uri?:string|null,png_sha?:string|null,raw_uri?:string|null,raw_sha?:string|null}} row
 */
export async function upsertOcrPage(client, row) {
  const pngSha = row.png_sha == null ? null : assertSha256(row.png_sha, 'png_sha');
  const rawSha = row.raw_sha == null ? null : assertSha256(row.raw_sha, 'raw_sha');
  const gateScore = row.gate_score == null ? null : Number(row.gate_score);
  if (gateScore != null && !Number.isFinite(gateScore)) {
    throw new Error('invalid_ocr_gate_score');
  }
  const result = await client.query(
    `INSERT INTO ocr_page (job_id, page_idx, status, gate_score, gate_reasons, png_uri, png_sha, raw_uri, raw_sha)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
     ON CONFLICT (job_id, page_idx) DO UPDATE
     SET status = EXCLUDED.status,
         gate_score = EXCLUDED.gate_score,
         gate_reasons = EXCLUDED.gate_reasons,
         png_uri = EXCLUDED.png_uri,
         png_sha = EXCLUDED.png_sha,
         raw_uri = EXCLUDED.raw_uri,
         raw_sha = EXCLUDED.raw_sha
     RETURNING job_id, page_idx, status, gate_score, gate_reasons, png_uri, png_sha, raw_uri, raw_sha, created_at`,
    [
      assertNonEmptyString(row.job_id, 'job_id'),
      assertNonNegativeInt(row.page_idx, 'page_idx'),
      assertNonEmptyString(row.status, 'status'),
      gateScore,
      JSON.stringify(toJsonArray(row.gate_reasons)),
      row.png_uri == null ? null : String(row.png_uri),
      pngSha,
      row.raw_uri == null ? null : String(row.raw_uri),
      rawSha
    ]
  );
  return mapOcrPageRow(result.rows[0]);
}

/**
 * @param {import('pg').Client} client
 * @param {{doc_id:string,ver:number,page_idx:number,patch_sha:string,patch:unknown,source_job_id?:string|null}} row
 */
export async function insertOcrPatch(client, row) {
  const result = await client.query(
    `INSERT INTO ocr_patch (doc_id, ver, page_idx, patch_sha, patch, source_job_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT (doc_id, ver, page_idx, patch_sha) DO NOTHING
     RETURNING doc_id, ver, page_idx, patch_sha, patch, source_job_id, created_at`,
    [
      assertNonEmptyString(row.doc_id, 'doc_id'),
      assertPositiveInt(row.ver, 'ver'),
      assertNonNegativeInt(row.page_idx, 'page_idx'),
      assertSha256(row.patch_sha, 'patch_sha'),
      JSON.stringify(row.patch ?? {}),
      row.source_job_id == null ? null : assertNonEmptyString(row.source_job_id, 'source_job_id')
    ]
  );
  return result.rows[0] ? mapOcrPatchRow(result.rows[0]) : null;
}

/**
 * @param {import('pg').Client} client
 * @param {{doc_id:string,ver:number,page_idx:number,page_sha:string,source:string,source_ref_sha?:string|null}} row
 */
export async function insertDocirPageVersion(client, row) {
  const sourceRefSha =
    row.source_ref_sha == null ? null : assertSha256(row.source_ref_sha, 'source_ref_sha');
  const result = await client.query(
    `INSERT INTO docir_page_version (doc_id, ver, page_idx, page_sha, source, source_ref_sha)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (doc_id, ver, page_idx, page_sha) DO NOTHING
     RETURNING doc_id, ver, page_idx, page_sha, source, source_ref_sha, created_at`,
    [
      assertNonEmptyString(row.doc_id, 'doc_id'),
      assertPositiveInt(row.ver, 'ver'),
      assertNonNegativeInt(row.page_idx, 'page_idx'),
      assertSha256(row.page_sha, 'page_sha'),
      assertNonEmptyString(row.source, 'source'),
      sourceRefSha
    ]
  );
  return result.rows[0] ? mapDocirPageVersionRow(result.rows[0]) : null;
}

/**
 * @param {import('pg').Client} client
 * @param {string} jobId
 */
export async function listOcrPagesByJob(client, jobId) {
  const result = await client.query(
    `SELECT job_id, page_idx, status, gate_score, gate_reasons, png_uri, png_sha, raw_uri, raw_sha, created_at
     FROM ocr_page
     WHERE job_id = $1
     ORDER BY page_idx ASC`,
    [assertNonEmptyString(jobId, 'job_id')]
  );
  return result.rows.map((row) => mapOcrPageRow(row));
}

/**
 * @param {import('pg').Client} client
 * @param {{job_id:string,page_idx:number,status:string,png_uri:string,png_sha:string}} row
 */
export async function updateOcrPageRender(client, row) {
  const result = await client.query(
    `UPDATE ocr_page
     SET status = $3, png_uri = $4, png_sha = $5
     WHERE job_id = $1 AND page_idx = $2
     RETURNING job_id, page_idx, status, gate_score, gate_reasons, png_uri, png_sha, raw_uri, raw_sha, created_at`,
    [
      assertNonEmptyString(row.job_id, 'job_id'),
      assertNonNegativeInt(row.page_idx, 'page_idx'),
      assertNonEmptyString(row.status, 'status'),
      assertNonEmptyString(row.png_uri, 'png_uri'),
      assertSha256(row.png_sha, 'png_sha')
    ]
  );
  if (!result.rows[0]) {
    throw new Error('ocr_page_not_found');
  }
  return mapOcrPageRow(result.rows[0]);
}

/**
 * @param {import('pg').Client} client
 * @param {{job_id:string,page_idx:number,status:string,raw_uri:string,raw_sha:string}} row
 */
export async function updateOcrPageResult(client, row) {
  const result = await client.query(
    `UPDATE ocr_page
     SET status = $3, raw_uri = $4, raw_sha = $5
     WHERE job_id = $1 AND page_idx = $2
     RETURNING job_id, page_idx, status, gate_score, gate_reasons, png_uri, png_sha, raw_uri, raw_sha, created_at`,
    [
      assertNonEmptyString(row.job_id, 'job_id'),
      assertNonNegativeInt(row.page_idx, 'page_idx'),
      assertNonEmptyString(row.status, 'status'),
      assertNonEmptyString(row.raw_uri, 'raw_uri'),
      assertSha256(row.raw_sha, 'raw_sha')
    ]
  );
  if (!result.rows[0]) {
    throw new Error('ocr_page_not_found');
  }
  return mapOcrPageRow(result.rows[0]);
}

/**
 * @param {import('pg').Client} client
 * @param {{job_id:string, status?:string}} params
 */
export async function listOcrPagesByJobStatus(client, params) {
  const status = params.status == null ? null : assertNonEmptyString(params.status, 'status');
  const result = await client.query(
    `SELECT job_id, page_idx, status, gate_score, gate_reasons, png_uri, png_sha, raw_uri, raw_sha, created_at
     FROM ocr_page
     WHERE job_id = $1
       AND ($2::text IS NULL OR status = $2)
     ORDER BY page_idx ASC`,
    [assertNonEmptyString(params.job_id, 'job_id'), status]
  );
  return result.rows.map((row) => mapOcrPageRow(row));
}

/**
 * @param {import('pg').Client} client
 * @param {{doc_id:string,ver:number,source_job_id?:string|null}} params
 */
export async function listLatestOcrPatchesByDocVersion(client, params) {
  const sourceJobId =
    params.source_job_id == null ? null : assertNonEmptyString(params.source_job_id, 'source_job_id');
  const result = await client.query(
    `SELECT DISTINCT ON (page_idx) doc_id, ver, page_idx, patch_sha, patch, source_job_id, created_at
     FROM ocr_patch
     WHERE doc_id = $1
       AND ver = $2
       AND ($3::text IS NULL OR source_job_id = $3)
     ORDER BY page_idx ASC, created_at DESC, patch_sha DESC`,
    [assertNonEmptyString(params.doc_id, 'doc_id'), assertPositiveInt(params.ver, 'ver'), sourceJobId]
  );
  return result.rows.map((row) => mapOcrPatchRow(row));
}

/**
 * @param {import('pg').Client} client
 * @param {{
 *   doc_id:string,
 *   ver:number,
 *   page_idx:number,
 *   before_sha:string,
 *   after_sha:string,
 *   changed_blocks:number,
 *   page_diff_sha:string,
 *   diff_sha:string,
 *   source_job_id?:string|null
 * }} row
 */
export async function insertDocirPageDiff(client, row) {
  const result = await client.query(
    `INSERT INTO docir_page_diff (doc_id, ver, page_idx, before_sha, after_sha, changed_blocks, page_diff_sha, diff_sha, source_job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (doc_id, ver, page_idx, page_diff_sha) DO NOTHING
     RETURNING doc_id, ver, page_idx, before_sha, after_sha, changed_blocks, page_diff_sha, diff_sha, source_job_id, created_at`,
    [
      assertNonEmptyString(row.doc_id, 'doc_id'),
      assertPositiveInt(row.ver, 'ver'),
      assertNonNegativeInt(row.page_idx, 'page_idx'),
      assertSha256(row.before_sha, 'before_sha'),
      assertSha256(row.after_sha, 'after_sha'),
      assertNonNegativeInt(row.changed_blocks, 'changed_blocks'),
      assertSha256(row.page_diff_sha, 'page_diff_sha'),
      assertSha256(row.diff_sha, 'diff_sha'),
      row.source_job_id == null ? null : assertNonEmptyString(row.source_job_id, 'source_job_id')
    ]
  );
  return result.rows[0] ? mapDocirPageDiffRow(result.rows[0]) : null;
}

/**
 * @param {import('pg').Client} client
 * @param {{source_job_id:string}} params
 */
export async function listDocirPageDiffByJob(client, params) {
  const result = await client.query(
    `SELECT doc_id, ver, page_idx, before_sha, after_sha, changed_blocks, page_diff_sha, diff_sha, source_job_id, created_at
     FROM docir_page_diff
     WHERE source_job_id = $1
     ORDER BY page_idx ASC, created_at DESC`,
    [assertNonEmptyString(params.source_job_id, 'source_job_id')]
  );
  return result.rows.map((row) => mapDocirPageDiffRow(row));
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapOcrJobRow(row) {
  return {
    job_id: String(row.job_id),
    doc_id: String(row.doc_id),
    ver: Number(row.ver),
    gate_rev: String(row.gate_rev),
    policy: toJsonObject(row.policy),
    created_at: row.created_at ? new Date(String(row.created_at)).toISOString() : null
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapOcrPageRow(row) {
  const gateScore = row.gate_score == null ? null : Number(row.gate_score);
  return {
    job_id: String(row.job_id),
    page_idx: Number(row.page_idx),
    status: String(row.status),
    gate_score: Number.isFinite(gateScore) ? gateScore : null,
    gate_reasons: toJsonArray(row.gate_reasons),
    png_uri: typeof row.png_uri === 'string' ? row.png_uri : null,
    png_sha: typeof row.png_sha === 'string' ? row.png_sha : null,
    raw_uri: typeof row.raw_uri === 'string' ? row.raw_uri : null,
    raw_sha: typeof row.raw_sha === 'string' ? row.raw_sha : null,
    created_at: row.created_at ? new Date(String(row.created_at)).toISOString() : null
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapOcrPatchRow(row) {
  return {
    doc_id: String(row.doc_id),
    ver: Number(row.ver),
    page_idx: Number(row.page_idx),
    patch_sha: String(row.patch_sha),
    patch: row.patch,
    source_job_id: typeof row.source_job_id === 'string' ? row.source_job_id : null,
    created_at: row.created_at ? new Date(String(row.created_at)).toISOString() : null
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapDocirPageVersionRow(row) {
  return {
    doc_id: String(row.doc_id),
    ver: Number(row.ver),
    page_idx: Number(row.page_idx),
    page_sha: String(row.page_sha),
    source: String(row.source),
    source_ref_sha: typeof row.source_ref_sha === 'string' ? row.source_ref_sha : null,
    created_at: row.created_at ? new Date(String(row.created_at)).toISOString() : null
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapDocirPageDiffRow(row) {
  return {
    doc_id: String(row.doc_id),
    ver: Number(row.ver),
    page_idx: Number(row.page_idx),
    before_sha: String(row.before_sha),
    after_sha: String(row.after_sha),
    changed_blocks: Number(row.changed_blocks),
    page_diff_sha: String(row.page_diff_sha),
    diff_sha: String(row.diff_sha),
    source_job_id: typeof row.source_job_id === 'string' ? row.source_job_id : null,
    created_at: row.created_at ? new Date(String(row.created_at)).toISOString() : null
  };
}
