import { assertValidRunId } from '../run-id.mjs';
import { assertValidArtifactId } from './artifact-id.mjs';

/**
 * @param {any} value
 */
function toJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return {};
}

/**
 * @param {import('pg').Client} client
 * @param {{id:string, run_id:string, type:string, format:string, uri:string, sha256:string, title?:string, status?:string, visibility?:string, supersedes_id?:string|null, prov:Record<string, unknown>}} row
 */
export async function insertArtifact(client, row) {
  const id = assertValidArtifactId(row.id, 'artifact_id');
  const runId = assertValidRunId(row.run_id, 'run_id');
  const type = assertValidArtifactId(row.type, 'artifact_type');
  const result = await client.query(
    `INSERT INTO artifact (id, run_id, type, format, uri, sha256, title, status, visibility, supersedes_id, prov)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, run_id, type, format, uri, sha256, title, status, visibility, supersedes_id, prov, created_at`,
    [
      id,
      runId,
      type,
      row.format,
      row.uri,
      row.sha256,
      row.title ?? null,
      row.status ?? 'final',
      row.visibility ?? 'user',
      row.supersedes_id ?? null,
      JSON.stringify(row.prov)
    ]
  );
  return result.rows[0] ? mapArtifactRow(result.rows[0]) : null;
}

/**
 * @param {import('pg').Client} client
 * @param {string} runId
 */
export async function countArtifactsByRunId(client, runId) {
  const normalizedRunId = assertValidRunId(runId, 'run_id');
  const result = await client.query('SELECT COUNT(*)::int AS count FROM artifact WHERE run_id = $1', [normalizedRunId]);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * @param {import('pg').Client} client
 * @param {string} runId
 */
export async function listArtifactsByRunId(client, runId) {
  const normalizedRunId = assertValidRunId(runId, 'run_id');
  const result = await client.query(
    `SELECT id, run_id, type, format, uri, sha256, title, status, visibility, supersedes_id, prov, created_at
     FROM artifact
     WHERE run_id = $1
     ORDER BY created_at ASC, id ASC`,
    [normalizedRunId]
  );
  return result.rows.map((row) => mapArtifactRow(row));
}

/**
 * @param {import('pg').Client} client
 * @param {{type?: string, visibility?: string, q?: string}} filters
 */
export async function listArtifactsByFilters(client, filters = {}) {
  const type = filters.type ? assertValidArtifactId(filters.type, 'type') : null;
  const visibility = filters.visibility ?? null;
  const q = filters.q ? `%${filters.q}%` : null;
  const result = await client.query(
    `SELECT id, run_id, type, format, uri, sha256, title, status, visibility, supersedes_id, prov, created_at
     FROM artifact
     WHERE ($1::text IS NULL OR type = $1)
       AND ($2::text IS NULL OR visibility = $2)
       AND ($3::text IS NULL OR title ILIKE $3)
     ORDER BY created_at DESC, id DESC`,
    [type, visibility, q]
  );
  return result.rows.map((row) => mapArtifactRow(row));
}

/**
 * @param {import('pg').Client} client
 * @param {string} artifactId
 */
export async function getArtifactById(client, artifactId) {
  const normalizedArtifactId = assertValidArtifactId(artifactId, 'artifact_id');
  const result = await client.query(
    `SELECT id, run_id, type, format, uri, sha256, title, status, visibility, supersedes_id, prov, created_at
     FROM artifact
     WHERE id = $1`,
    [normalizedArtifactId]
  );
  const row = result.rows[0];
  return row ? mapArtifactRow(row) : null;
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapArtifactRow(row) {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    type: String(row.type),
    format: String(row.format),
    uri: String(row.uri),
    sha256: String(row.sha256),
    title: typeof row.title === 'string' ? row.title : null,
    status: String(row.status),
    visibility: String(row.visibility),
    supersedes_id: typeof row.supersedes_id === 'string' ? row.supersedes_id : null,
    prov: toJsonObject(row.prov),
    created_at: row.created_at ? new Date(String(row.created_at)).toISOString() : null
  };
}

/**
 * @param {ReturnType<typeof mapArtifactRow>} artifact
 */
export function toArtifactListItem(artifact) {
  return {
    id: artifact.id,
    run_id: artifact.run_id,
    type: artifact.type,
    format: artifact.format,
    sha256: artifact.sha256,
    title: artifact.title,
    status: artifact.status,
    visibility: artifact.visibility,
    created_at: artifact.created_at,
    cost: artifact.prov?.cost ?? null,
    prov: artifact.prov
  };
}
