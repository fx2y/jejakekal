import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './hash.mjs';

/**
 * @typedef {{
 * workflowId: string,
 * createdAt: string,
 * schemaVersion: string,
 * locale: string,
 * timezone: string,
 * root: string,
 * artifact_refs?: unknown[],
 * step_summaries?: unknown[]
 * }} RunManifest
 */

/**
 * @param {unknown} value
 */
function stableJson(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}

/**
 * @param {any} value
 * @returns {any}
 */
function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortDeep(item));
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * @param {string} dir
 */
async function ensureEmptyDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

/**
 * @param {{workflowId: string, root: string, schemaVersion?: string, createdAt?: string, artifactRefs?: unknown[], stepSummaries?: unknown[]}} opts
 * @returns {RunManifest}
 */
export function makeManifest(opts) {
  const createdAt =
    typeof opts.createdAt === 'string' && opts.createdAt.length > 0
      ? opts.createdAt
      : new Date(Date.now()).toISOString();
  return {
    workflowId: opts.workflowId,
    createdAt,
    schemaVersion: opts.schemaVersion ?? 'run-bundle-v0',
    locale: 'C',
    timezone: 'UTC',
    root: opts.root,
    ...(Array.isArray(opts.artifactRefs) ? { artifact_refs: opts.artifactRefs } : {}),
    ...(Array.isArray(opts.stepSummaries) ? { step_summaries: opts.stepSummaries } : {})
  };
}

/**
 * @param {string} dir
 * @param {{
 * manifest: RunManifest,
 * timeline: unknown[],
 * toolIO: unknown[],
 * artifacts: unknown[],
 * citations: unknown[],
 * extraJsonFiles?: Record<string, unknown>
 * }} bundle
 */
export async function writeRunBundle(dir, bundle) {
  await ensureEmptyDir(dir);

  const files = {
    'manifest.json': bundle.manifest,
    'timeline.json': bundle.timeline,
    'tool-io.json': bundle.toolIO,
    'artifacts.json': bundle.artifacts,
    'citations.json': bundle.citations,
    ...(bundle.extraJsonFiles ?? {})
  };

  /** @type {Record<string,string>} */
  const hashes = {};
  for (const [filename, value] of Object.entries(files)) {
    const payload = stableJson(/** @type {Record<string, unknown>} */ (value));
    await writeFile(join(dir, filename), `${payload}\n`, 'utf8');
    hashes[filename] = sha256(payload);
  }

  return hashes;
}

/**
 * @param {string} dir
 */
export async function readBundle(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  /** @type {Record<string, any>} */
  const out = {};
  for (const name of names) {
    out[name] = JSON.parse(await readFile(join(dir, name), 'utf8'));
  }
  return out;
}

/**
 * @param {Record<string, any>} fileMap
 */
function normalize(fileMap) {
  const clone = structuredClone(fileMap);
  if (clone['manifest.json']) {
    clone['manifest.json'].createdAt = '<normalized>';
    clone['manifest.json'].root = '<normalized-root>';
  }
  return clone;
}

/**
 * @param {string} expectedDir
 * @param {string} actualDir
 */
export async function diffRunBundles(expectedDir, actualDir) {
  const expected = normalize(await readBundle(expectedDir));
  const actual = normalize(await readBundle(actualDir));
  const diffs = [];
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    const lhs = JSON.stringify(expected[key]);
    const rhs = JSON.stringify(actual[key]);
    if (lhs !== rhs) {
      diffs.push({ file: key, expected: expected[key], actual: actual[key] });
    }
  }
  return diffs;
}
