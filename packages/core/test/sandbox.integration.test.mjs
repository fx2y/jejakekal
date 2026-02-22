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

test('sandbox runner mounts workspace read-only and exports artifact', { skip: !(await dockerAvailable()) }, async () => {
  const result = await runSandboxStep({
    image: 'alpine:3.22',
    command: ['sh', '-lc', 'cat input/input.json > export/output.json'],
    input: '{"ok":true}',
    envAllowlist: []
  });

  assert.equal(result.code, 0);
  assert.match(result.payload, /"ok"/);
  assert.equal(result.payloadHash.length, 64);
});

test('sandbox runner blocks writes outside explicit export file', { skip: !(await dockerAvailable()) }, async () => {
  const result = await runSandboxStep({
    image: 'alpine:3.22',
    command: ['sh', '-lc', 'set -e; echo hacked > pwn.txt; cat input/input.json > export/output.json'],
    input: '{"ok":true}',
    envAllowlist: []
  });

  assert.notEqual(result.code, 0);
  assert.equal(result.payload, '');
});
