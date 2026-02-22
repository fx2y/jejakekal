import { getRunSteps } from '../runs-projections.mjs';

/**
 * @typedef {ReturnType<typeof import('./repository.mjs').mapArtifactRow>} ArtifactRow
 */

/**
 * @param {import('pg').Client} client
 * @param {Map<string, Promise<Map<string, number>>>} cache
 * @param {string} runId
 * @param {(client: import('pg').Client, runId: string) => Promise<Array<{function_name:string,function_id:number}>>} readSteps
 */
async function readRunStepIndex(client, cache, runId, readSteps) {
  const cached = cache.get(runId);
  if (cached) return cached;
  const pending = (async () => {
    const steps = await readSteps(client, runId);
    return new Map(steps.map((step) => [step.function_name, step.function_id]));
  })();
  cache.set(runId, pending);
  try {
    return await pending;
  } catch (error) {
    cache.delete(runId);
    throw error;
  }
}

/**
 * @param {import('pg').Client} client
 * @param {Map<string, Promise<Map<string, number>>>} cache
 * @param {ArtifactRow} artifact
 * @param {(client: import('pg').Client, runId: string) => Promise<Array<{function_name:string,function_id:number}>>} readSteps
 */
export async function withProducerFunctionId(client, cache, artifact, readSteps = getRunSteps) {
  const producerStep =
    artifact.prov && typeof artifact.prov === 'object' && typeof artifact.prov.producer_step === 'string'
      ? artifact.prov.producer_step
      : null;
  if (!producerStep) return artifact;
  const stepIndex = await readRunStepIndex(client, cache, artifact.run_id, readSteps);
  const producerFunctionId = stepIndex.get(producerStep);
  if (producerFunctionId == null) return artifact;
  return {
    ...artifact,
    prov: {
      ...artifact.prov,
      producer_function_id: producerFunctionId
    }
  };
}

/**
 * @param {import('pg').Client} client
 * @param {ArtifactRow[]} artifacts
 * @param {(client: import('pg').Client, runId: string) => Promise<Array<{function_name:string,function_id:number}>>} [readSteps]
 */
export async function enrichArtifactsWithProducerFunctionId(client, artifacts, readSteps = getRunSteps) {
  const cache = new Map();
  return Promise.all(artifacts.map((artifact) => withProducerFunctionId(client, cache, artifact, readSteps)));
}
