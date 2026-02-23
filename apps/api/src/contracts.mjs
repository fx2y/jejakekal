export const ARTIFACT_TYPE_VOCABULARY = Object.freeze(['raw', 'docir', 'chunk-index', 'memo']);

export const RUN_PROJECTION_FROZEN_KEYS = Object.freeze([
  'run_id',
  'status',
  'dbos_status',
  'header',
  'timeline'
]);

export const RUNS_COMPAT_WINDOW_END = '2026-06-30';

const ARTIFACT_TYPE_SET = new Set(ARTIFACT_TYPE_VOCABULARY);

/**
 * @param {string} type
 */
export function assertFrozenArtifactType(type) {
  if (!ARTIFACT_TYPE_SET.has(type)) {
    throw new Error('artifact_type_contract_violation');
  }
  return type;
}
