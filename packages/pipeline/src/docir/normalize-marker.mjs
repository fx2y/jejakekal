import { sha256 } from '../../../core/src/hash.mjs';

const ALLOWED_BLOCK_TYPES = new Set(['text', 'table', 'figure', 'code']);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Stable JSON stringify for hashing block payloads deterministically.
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value == null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (!isRecord(value)) {
    return JSON.stringify(String(value));
  }
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * @param {string} docId
 * @param {number} version
 * @param {number} page
 * @param {'text'|'table'|'figure'|'code'} type
 * @param {string} blockSha
 */
export function deriveBlockId(docId, version, page, type, blockSha) {
  return sha256(`${docId}:${version}:${page}:${type}:${blockSha}`).slice(0, 24);
}

/**
 * @param {string} docId
 * @param {number} version
 * @param {number} page
 * @param {unknown} tablePayload
 */
export function deriveTableId(docId, version, page, tablePayload) {
  return sha256(`${docId}:${version}:${page}:table:${stableStringify(tablePayload)}`);
}

/**
 * @param {unknown} value
 * @returns {Array<number>|null}
 */
function canonicalizeBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bbox = value.map((entry) => Number(entry));
  if (bbox.some((entry) => !Number.isFinite(entry))) return null;
  return bbox;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function resolvePage(value, fallback) {
  const page = Number(value);
  if (!Number.isFinite(page)) return fallback;
  return Math.max(1, Math.trunc(page));
}

/**
 * @param {unknown} value
 * @returns {'text'|'table'|'figure'|'code'}
 */
function resolveType(value) {
  const type = String(value ?? '').trim().toLowerCase();
  if (!ALLOWED_BLOCK_TYPES.has(type)) {
    throw new Error('invalid_marker_block_type');
  }
  return /** @type {'text'|'table'|'figure'|'code'} */ (type);
}

/**
 * @param {{docId:string, version:number, markerJson:unknown}} params
 */
export function normalizeMarkerToBlocks(params) {
  if (!isRecord(params.markerJson)) {
    throw new Error('invalid_marker_json');
  }
  const blocksInput = params.markerJson.blocks;
  if (!Array.isArray(blocksInput)) {
    throw new Error('invalid_marker_blocks');
  }
  return blocksInput.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error('invalid_marker_block');
    }
    const page = resolvePage(entry.page, index + 1);
    const type = resolveType(entry.type);
    const bbox = canonicalizeBbox(entry.bbox);
    const rawPayload = stableStringify(entry);
    const blockSha = sha256(rawPayload);
    const text = typeof entry.text === 'string' ? entry.text : null;
    return {
      block_id: deriveBlockId(params.docId, params.version, page, type, blockSha),
      type,
      page,
      bbox,
      text,
      data: entry,
      block_sha: blockSha
    };
  });
}
