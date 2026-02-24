import test from 'node:test';
import assert from 'node:assert/strict';
import { insertArtifact } from '../src/artifacts/repository.mjs';

test('artifacts repository: insertArtifact rejects unknown artifact type at write boundary', async () => {
  let queryCalled = false;
  const client = /** @type {import('pg').Client} */ (
    /** @type {unknown} */ ({
      query: async () => {
        queryCalled = true;
        throw new Error('should_not_query');
      }
    })
  );
  await assert.rejects(
    () =>
      insertArtifact(client, {
        id: 'wf-1:bad',
        run_id: 'wf-1',
        type: 'exec-memo',
        format: 'application/json',
        uri: 's3://mem/run/wf-1/bad.json',
        sha256: 'a'.repeat(64),
        prov: {}
      }),
    {
      message: 'artifact_type_contract_violation'
    }
  );
  assert.equal(queryCalled, false);
});
