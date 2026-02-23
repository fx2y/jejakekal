import { sha256 } from '../../../../packages/core/src/hash.mjs';

const SHA256_RE = /^[a-f0-9]{64}$/;
const DOC_ID_PREFIX = 'doc-';
const DOC_ID_HEX_LEN = 24;

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertSha256(value, field) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

/**
 * @param {string} rawSha
 */
export function deriveDocId(rawSha) {
  const normalized = assertSha256(rawSha, 'raw_sha');
  return `${DOC_ID_PREFIX}${normalized.slice(0, DOC_ID_HEX_LEN)}`;
}

/**
 * C2 placeholder until marker runner wiring lands in C3.
 */
export const MARKER_CONFIG_PLACEHOLDER_SHA = sha256(
  JSON.stringify({
    parser: 'docir-runner',
    version: 1,
    use_llm: 0
  })
);

/**
 * Reserve (doc_id, ver) deterministically for a raw payload hash.
 * @param {import('pg').Client} client
 * @param {{rawSha:string, filename:string, mime:string, byteLength:number, markerConfigSha?: string}} params
 */
export async function reserveDocVersion(client, params) {
  const rawSha = assertSha256(params.rawSha, 'raw_sha');
  const docId = deriveDocId(rawSha);
  const filename = typeof params.filename === 'string' && params.filename.length > 0 ? params.filename : 'inline.txt';
  const mime = typeof params.mime === 'string' && params.mime.length > 0 ? params.mime : 'text/plain';
  const byteLength = Number(params.byteLength);
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new Error('invalid_byte_length');
  }
  const markerConfigSha = assertSha256(
    params.markerConfigSha ?? MARKER_CONFIG_PLACEHOLDER_SHA,
    'marker_config_sha'
  );

  await client.query('BEGIN');
  try {
    const upsert = await client.query(
      `INSERT INTO doc (doc_id, raw_sha, filename, mime, byte_len, latest_ver)
       VALUES ($1, $2, $3, $4, $5, 0)
       ON CONFLICT (raw_sha)
       DO UPDATE SET
         filename = EXCLUDED.filename,
         mime = EXCLUDED.mime,
         byte_len = EXCLUDED.byte_len
       RETURNING doc_id, latest_ver`,
      [docId, rawSha, filename, mime, byteLength]
    );
    const row = upsert.rows[0];
    if (!row) {
      throw new Error('doc_reserve_failed');
    }
    const reservedDocId = String(row.doc_id);
    const nextVersion = Number(row.latest_ver) + 1;

    const bump = await client.query(
      `UPDATE doc
       SET latest_ver = $2
       WHERE doc_id = $1`,
      [reservedDocId, nextVersion]
    );
    if (bump.rowCount !== 1) {
      throw new Error('doc_version_bump_failed');
    }

    await client.query(
      `INSERT INTO doc_ver (doc_id, ver, raw_sha, marker_config_sha)
       VALUES ($1, $2, $3, $4)`,
      [reservedDocId, nextVersion, rawSha, markerConfigSha]
    );

    await client.query('COMMIT');
    return {
      docId: reservedDocId,
      version: nextVersion,
      rawSha,
      markerConfigSha
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
