import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sha256 } from './hash.mjs';

/**
 * @typedef {{image: string, command: string[], envAllowlist?: string[], input: string, exportFile?: string, crashSignal?: NodeJS.Signals}} SandboxRequest
 */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function execChild(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * @param {SandboxRequest} req
 */
export async function runSandboxStep(req) {
  const scratch = await mkdtemp(join(tmpdir(), 'jejakekal-sbx-'));
  const inFile = join(scratch, 'input.json');
  const outFile = join(scratch, req.exportFile ?? 'output.json');
  await writeFile(inFile, req.input, 'utf8');

  const env = { PATH: process.env.PATH ?? '' };
  for (const key of req.envAllowlist ?? []) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  const args = [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '-v',
    `${scratch}:/workspace`,
    '-w',
    '/workspace',
    req.image,
    ...req.command
  ];

  const result = await execChild('docker', args, env);
  const payload = result.code === 0 ? await readFile(outFile, 'utf8') : '';
  const hash = payload ? sha256(payload) : '';

  await rm(scratch, { recursive: true, force: true });

  return {
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    payload,
    payloadHash: hash
  };
}
