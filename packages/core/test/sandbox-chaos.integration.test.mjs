import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSandboxStep } from '../src/sandbox-runner.mjs';

const exec = promisify(execFile);

async function dockerAvailable() {
  try {
    await exec('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

test('chaos sandbox replay is stable for same input', { skip: !(await dockerAvailable()) }, async () => {
  const req = {
    image: 'alpine:3.22',
    command: ['sh', '-lc', 'cat input.json > output.json'],
    input: '{"stable":true}',
    envAllowlist: []
  };

  const first = await runSandboxStep(req);
  const second = await runSandboxStep(req);

  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(first.payloadHash, second.payloadHash);
});
