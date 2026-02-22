import { spawn } from 'node:child_process';
import { makeClient, resetAppTables } from '../src/db.mjs';

let workflowIdCounter = 0;
let apiPortCounter = 0;

export function nextWorkflowId(prefix) {
  workflowIdCounter += 1;
  return `${prefix}-${process.pid}-${workflowIdCounter}`;
}

export function nextApiPort() {
  apiPortCounter += 1;
  return 4300 + apiPortCounter;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCondition(check, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? 10_000);
  const intervalMs = Number(opts.intervalMs ?? 50);
  const label = opts.label ?? 'condition';
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

export async function connectDbOrSkip(t) {
  const client = makeClient();
  try {
    await client.connect();
  } catch {
    t.skip('postgres unavailable; run mise run up then mise run reset');
    return null;
  }
  t.after(async () => {
    await client.end();
  });
  return client;
}

export async function resetAppDb(client) {
  await resetAppTables(client);
}

export async function setupDbOrSkip(t) {
  const client = await connectDbOrSkip(t);
  if (!client) return null;
  await resetAppDb(client);
  return client;
}

export async function startApiProcess(opts = {}) {
  const port = Number(opts.port ?? nextApiPort());
  const env = {
    ...process.env,
    API_PORT: String(port),
    ...(opts.env ?? {})
  };
  const child = spawn(process.execPath, ['apps/api/src/server.mjs'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const healthUrl = `${baseUrl}/healthz`;

  function isChildGone() {
    if (child.exitCode != null || child.signalCode != null) return true;
    if (!child.pid) return true;
    try {
      process.kill(child.pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  async function isHealthy() {
    try {
      const res = await fetch(healthUrl);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function waitForHealth(timeoutMs = 10_000) {
    await waitForCondition(isHealthy, {
      timeoutMs,
      intervalMs: 50,
      label: `api health on ${healthUrl}`
    });
  }

  async function waitForExit(label, timeoutMs) {
    await waitForCondition(
      async () => isChildGone(),
      { timeoutMs, intervalMs: 25, label }
    );
  }

  /**
   * @param {NodeJS.Signals | number} signal
   */
  async function kill(signal = 'SIGKILL') {
    if (child.exitCode != null) return;
    child.kill(signal);
    await waitForExit(`api child exit (${signal})`, 5_000);
  }

  async function stop() {
    if (child.exitCode != null) return;
    child.kill('SIGTERM');
    try {
      await waitForExit('api child graceful exit', 2_000);
      return;
    } catch {
      // Fall through to hard kill when graceful shutdown misses deadline.
    }
    child.kill('SIGKILL');
    await waitForExit('api child forced exit', 5_000);
  }

  async function readRun(runId) {
    const res = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) return null;
    return res.json();
  }

  async function waitForRunTerminal(runId, timeoutMs = 20_000) {
    let latest = null;
    await waitForCondition(
      async () => {
        latest = await readRun(runId);
        return Boolean(latest && (latest.status === 'done' || latest.status === 'error'));
      },
      { timeoutMs, intervalMs: 50, label: `run ${runId} terminal state` }
    );
    return latest;
  }

  return {
    child,
    port,
    baseUrl,
    output: () => output,
    waitForHealth,
    kill,
    stop,
    readRun,
    waitForRunTerminal
  };
}
