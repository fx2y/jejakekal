import { assertValidArtifactId } from '../artifacts/artifact-id.mjs';
import { badRequest } from '../request-errors.mjs';
import { assertValidRunId } from '../run-id.mjs';

const SOURCE_INTENTS = new Set(['doc', 'research', 'deck', 'sheet']);
const COMMAND_INTENTS = new Set([...SOURCE_INTENTS, 'run', 'open']);

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function requireNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {unknown} value
 */
function normalizeArgsObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  throw badRequest('invalid_run_payload');
}

/**
 * @param {string} intent
 * @param {Record<string, unknown>} args
 */
function normalizeIntentArgs(intent, args) {
  if (SOURCE_INTENTS.has(intent)) {
    if (!requireNonEmptyString(args.source)) {
      throw badRequest('invalid_run_payload');
    }
    const source = String(args.source).trim();
    return { source };
  }
  if (intent === 'run') {
    if (!requireNonEmptyString(args.run_id)) {
      throw badRequest('invalid_run_payload');
    }
    const runId = String(args.run_id).trim();
    return { run_id: assertValidRunId(runId, 'run_id') };
  }
  if (intent === 'open') {
    if (!requireNonEmptyString(args.artifact_id)) {
      throw badRequest('invalid_run_payload');
    }
    const artifactId = String(args.artifact_id).trim();
    return { artifact_id: assertValidArtifactId(artifactId, 'artifact_id') };
  }
  throw badRequest('invalid_command', { cmd: `/${intent}` });
}

/**
 * @param {Record<string, unknown>} body
 */
export function parseIntentPayload(body) {
  if (!requireNonEmptyString(body.intent)) {
    throw badRequest('invalid_run_payload');
  }
  const intent = body.intent.trim();
  if (!COMMAND_INTENTS.has(intent)) {
    throw badRequest('invalid_command', { cmd: `/${intent}` });
  }
  const args = normalizeIntentArgs(intent, normalizeArgsObject(body.args));
  return { cmd: `/${intent}`, intent, args };
}

/**
 * Parse slash command text into normalized command payload.
 * @param {string} raw
 */
export function parseSlashCommand(raw) {
  if (!requireNonEmptyString(raw)) {
    throw badRequest('invalid_command', { cmd: '' });
  }
  const tokens = raw.trim().split(/\s+/);
  const cmd = tokens[0] ?? '';
  if (!cmd.startsWith('/')) {
    throw badRequest('invalid_command', { cmd });
  }
  const intent = cmd.slice(1);
  if (!COMMAND_INTENTS.has(intent)) {
    throw badRequest('invalid_command', { cmd });
  }

  if (SOURCE_INTENTS.has(intent)) {
    const source = raw.trim().slice(cmd.length).trim();
    if (!source) {
      throw badRequest('invalid_run_payload');
    }
    return { cmd, intent, args: { source } };
  }

  const value = tokens[1] ?? '';
  if (!value || tokens.length !== 2) {
    throw badRequest('invalid_run_payload');
  }
  if (intent === 'run') {
    return { cmd, intent, args: { run_id: assertValidRunId(value, 'run_id') } };
  }
  return { cmd, intent, args: { artifact_id: assertValidArtifactId(value, 'artifact_id') } };
}

/**
 * @param {{intent:string, args:Record<string, unknown>}} command
 */
export function commandToWorkflowValue(command) {
  if (SOURCE_INTENTS.has(command.intent)) {
    return String(command.args.source);
  }
  return JSON.stringify({ intent: command.intent, args: command.args });
}
