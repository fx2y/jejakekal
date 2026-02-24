import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandToWorkflowValue,
  parseIntentPayload,
  parseSlashCommand
} from '../src/commands/parse-command.mjs';

test('parse-command: slash parser normalizes source and id commands', () => {
  assert.deepEqual(parseSlashCommand('/doc hello world'), {
    cmd: '/doc',
    intent: 'doc',
    args: { source: 'hello world' }
  });
  assert.deepEqual(parseSlashCommand('/run wf-1'), {
    cmd: '/run',
    intent: 'run',
    args: { run_id: 'wf-1' }
  });
});

test('parse-command: canonical intent payload normalization', () => {
  assert.deepEqual(
    parseIntentPayload({ intent: 'research', args: { source: 'find x' } }),
    {
      cmd: '/research',
      intent: 'research',
      args: { source: 'find x' }
    }
  );
});

test('parse-command: source intents accept additive ns/acl retrieval scope fields', () => {
  assert.deepEqual(
    parseIntentPayload({
      intent: 'doc',
      args: {
        source: 's3://bucket/doc.pdf',
        ns: ['tenant-z', 'tenant-a', 'tenant-z'],
        acl: { user: 'u-1' }
      }
    }),
    {
      cmd: '/doc',
      intent: 'doc',
      args: {
        source: 's3://bucket/doc.pdf',
        ns: ['tenant-a', 'tenant-z'],
        acl: { user: 'u-1' }
      }
    }
  );
});

test('parse-command: invalid commands and payloads fail typed 400', () => {
  assert.throws(() => parseSlashCommand('/nope x'), {
    name: 'RequestError',
    payload: { error: 'invalid_command', cmd: '/nope' }
  });
  assert.throws(() => parseIntentPayload({ intent: 'doc', args: {} }), {
    name: 'RequestError',
    payload: { error: 'invalid_run_payload' }
  });
  assert.throws(() => parseIntentPayload({ intent: 'doc', args: { source: 'x', acl: 'invalid' } }), {
    name: 'RequestError',
    payload: { error: 'invalid_run_payload' }
  });
});

test('parse-command: workflow value uses source for source intents and json for non-source intents', () => {
  assert.equal(
    commandToWorkflowValue({ intent: 'doc', args: { source: 'abc' } }),
    'abc'
  );
  assert.equal(
    commandToWorkflowValue({ intent: 'open', args: { artifact_id: 'a1' } }),
    '{"intent":"open","args":{"artifact_id":"a1"}}'
  );
});
