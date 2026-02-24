import { sha256 } from '../../../../packages/core/src/hash.mjs';

export const RETRIEVAL_EMBED_DIM = 1536;
export const RETRIEVAL_EMBED_MODEL_DEFAULT = 'det-hash-1536-v1';

/**
 * @param {unknown} value
 */
export function resolveEmbeddingModel(value) {
  const model = String(value ?? RETRIEVAL_EMBED_MODEL_DEFAULT).trim();
  if (!model) {
    throw new Error('invalid_embedding_model');
  }
  return model;
}

/**
 * @param {unknown} value
 */
function normalizeEmbeddingText(value) {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/**
 * @param {string} text
 */
function tokenize(text) {
  const tokens = text
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : ['__empty__'];
}

/**
 * Deterministic local embedding used as a replay-safe seam placeholder.
 * Produces stable unit vectors without external IO.
 * @param {unknown} value
 */
export function embedTextDeterministic(value) {
  const text = normalizeEmbeddingText(value);
  const tokens = tokenize(text);
  const vector = new Float64Array(RETRIEVAL_EMBED_DIM);
  for (const token of tokens) {
    const digest = sha256(token);
    for (let i = 0; i < 4; i += 1) {
      const offset = i * 8;
      const raw = Number.parseInt(digest.slice(offset, offset + 8), 16);
      const idx = raw % RETRIEVAL_EMBED_DIM;
      const sign = raw & 1 ? -1 : 1;
      const mag = ((raw >>> 1) % 997) / 997;
      vector[idx] += sign * (0.25 + mag);
    }
  }
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm) || 1;
  /** @type {number[]} */
  const out = new Array(RETRIEVAL_EMBED_DIM);
  for (let i = 0; i < vector.length; i += 1) {
    out[i] = Number((vector[i] / norm).toFixed(6));
  }
  return out;
}

/**
 * @param {number[]} emb
 */
export function toPgVectorLiteral(emb) {
  if (!Array.isArray(emb) || emb.length !== RETRIEVAL_EMBED_DIM) {
    throw new Error('invalid_embedding_dim');
  }
  return `[${emb.map((n) => Number(n).toFixed(6)).join(',')}]`;
}

/**
 * @param {Array<{id:string,text:string|null|undefined}>} rows
 */
export function embedManyTextsDeterministic(rows) {
  return rows.map((row) => ({
    id: row.id,
    embedding: embedTextDeterministic(row.text ?? '')
  }));
}
