import { readFile } from 'node:fs/promises';
import { buildRetrievalBundleSidecars } from '../apps/api/src/export/retrieval-sidecars.mjs';

/**
 * @param {string} path
 */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Deterministic retrieval sidecar fixture for golden bundles.
 * Uses provenance-only candidate fixtures and reuses the same export sanitizer as runtime bundles.
 */
export async function loadGoldenRetrievalSidecars() {
  const corpus = await readJson('golden/corpus/retrieval-corpus.json');
  const expected = await readJson('golden/corpus/retrieval-expected.json');
  const cases = Array.isArray(expected.cases) ? expected.cases : [];
  const timeline = cases.map((entry, index) => ({
    function_name: typeof entry.step === 'string' ? entry.step : `retrieve-${index + 1}`,
    output: {
      retrieval: {
        query: typeof entry.query === 'string' ? entry.query : '',
        candidates: Array.isArray(entry.candidates) ? entry.candidates : []
      }
    }
  }));
  const sidecars = buildRetrievalBundleSidecars(timeline);
  if (!sidecars) return null;
  return {
    manifestSummary: {
      ...sidecars.retrieval_summary,
      corpus_id: typeof corpus.id === 'string' ? corpus.id : 'golden-retrieval-corpus',
      corpus_target_docs: Number(corpus?.target?.docs ?? 0),
      corpus_target_queries: Number(corpus?.target?.queries ?? 0),
      corpus_seed_docs: Number(corpus?.seed?.docs ?? 0),
      corpus_seed_queries: Number(corpus?.seed?.queries ?? 0)
    },
    retrievalResults: sidecars.retrieval_results
  };
}

