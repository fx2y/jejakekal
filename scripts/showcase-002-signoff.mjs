import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { makeClient } from '../apps/api/src/db.mjs';

/** @typedef {Awaited<ReturnType<typeof startApiProcess>>} ApiProcess */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string}} [opts]
 */
async function runCommand(cmd, args, opts = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        code: code ?? 1,
        stdout,
        stderr,
        duration_ms: Date.now() - startedAt
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(check, label, timeoutMs = 15_000, intervalMs = 50) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
}

/**
 * @param {number} port
 */
async function startApiProcess(port) {
  const child = spawn(process.execPath, ['apps/api/src/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(port) },
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
  await waitForCondition(
    async () => {
      try {
        const res = await fetch(`${baseUrl}/healthz`);
        return res.ok;
      } catch {
        return false;
      }
    },
    `api health on ${baseUrl}/healthz`
  );

  async function stop() {
    if (child.exitCode != null) return;
    child.kill('SIGTERM');
    await waitForCondition(
      async () => child.exitCode != null || child.signalCode != null,
      'api process stop',
      5_000,
      25
    ).catch(async () => {
      child.kill('SIGKILL');
      await waitForCondition(
        async () => child.exitCode != null || child.signalCode != null,
        'api process hard stop',
        5_000,
        25
      );
    });
  }

  async function kill() {
    if (child.exitCode != null) return;
    child.kill('SIGKILL');
    await waitForCondition(
      async () => child.exitCode != null || child.signalCode != null,
      'api process kill',
      5_000,
      25
    );
  }

  return { child, baseUrl, output: () => output, stop, kill };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * @param {string} baseUrl
 * @param {Record<string, unknown>} payload
 */
async function postRun(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { status: res.status, json: await res.json() };
}

/**
 * @param {string} baseUrl
 * @param {string} runId
 */
async function readRun(baseUrl, runId) {
  const res = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}`);
  return { status: res.status, json: await res.json() };
}

/**
 * @param {string} baseUrl
 * @param {string} runId
 */
async function waitForRunTerminal(baseUrl, runId) {
  let latest = null;
  await waitForCondition(
    async () => {
      const run = await readRun(baseUrl, runId);
      if (run.status !== 200) return false;
      latest = run.json;
      return ['done', 'error', 'unknown'].includes(String(latest.status));
    },
    `run ${runId} terminal status`,
    25_000,
    50
  );
  return latest;
}

/**
 * @param {string} baseUrl
 * @param {string} runId
 */
async function exportRun(baseUrl, runId) {
  const res = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}/export`);
  return { status: res.status, json: await res.json() };
}

/**
 * @param {string} baseUrl
 * @param {string} encodedPath
 */
async function curlPathAsIs(baseUrl, encodedPath) {
  const cmd = [
    '--path-as-is',
    '-sS',
    '-w',
    '\\n%{http_code}',
    `${baseUrl}${encodedPath}`
  ];
  const result = await runCommand('curl', cmd);
  assert(result.ok, `curl failed for ${encodedPath}: ${result.stderr || result.stdout}`);
  const lines = result.stdout.trimEnd().split('\n');
  const status = Number(lines.pop());
  const bodyText = lines.join('\n');
  return { status, bodyText, json: JSON.parse(bodyText) };
}

/**
 * @param {unknown[]} ids
 */
function isCanonicalArtifactIds(ids) {
  return JSON.stringify(ids) === JSON.stringify(['raw', 'docir', 'chunk-index', 'memo']);
}

async function main() {
  const summary = {
    showcase: '002',
    date_utc: new Date().toISOString(),
    ok: false,
    failed_step_ids: /** @type {string[]} */ ([]),
    steps: /** @type {Array<Record<string, unknown>>} */ ([]),
    samples: {}
  };
  await mkdir('.cache', { recursive: true });

  /** @type {ApiProcess | null} */
  let api = null;
  /** @type {ApiProcess | null} */
  let killApi = null;
  /** @type {import('pg').Client | null} */
  let dbClient = null;

  const addStep = (step) => {
    summary.steps.push(step);
    if (step.ok === false) {
      summary.failed_step_ids.push(String(step.id));
    }
  };

  async function step(id, run) {
    const startedAt = Date.now();
    try {
      const evidence = await run();
      addStep({ id, ok: true, duration_ms: Date.now() - startedAt, evidence });
      return evidence;
    } catch (error) {
      addStep({
        id,
        ok: false,
        duration_ms: Date.now() - startedAt,
        error: String(error instanceof Error ? error.message : error)
      });
      throw error;
    }
  }

  async function ensureDbClient() {
    if (dbClient) return dbClient;
    dbClient = makeClient();
    await dbClient.connect();
    return dbClient;
  }

  try {
    await step('setup.up', async () => {
      const result = await runCommand('mise', ['run', 'up']);
      assert(result.ok, `mise run up failed: ${result.stderr || result.stdout}`);
      return { command: 'mise run up', duration_ms: result.duration_ms };
    });

    await step('setup.reset', async () => {
      const reset = await runCommand('mise', ['run', 'reset']);
      if (reset.ok) {
        return {
          command: 'mise run reset',
          duration_ms: reset.duration_ms
        };
      }

      const needsRecovery =
        reset.stderr.includes('is being accessed by other users') ||
        reset.stdout.includes('is being accessed by other users');
      assert(needsRecovery, `mise run reset failed: ${reset.stderr || reset.stdout}`);

      const down = await runCommand('mise', ['run', 'down']);
      assert(down.ok, `mise run down recovery failed: ${down.stderr || down.stdout}`);
      const up = await runCommand('mise', ['run', 'up']);
      assert(up.ok, `mise run up recovery failed: ${up.stderr || up.stdout}`);
      const retry = await runCommand('mise', ['run', 'reset']);
      assert(retry.ok, `mise run reset retry failed: ${retry.stderr || retry.stdout}`);
      return {
        command: 'mise run reset',
        recovered_via: ['mise run down', 'mise run up', 'mise run reset'],
        duration_ms: reset.duration_ms + down.duration_ms + up.duration_ms + retry.duration_ms
      };
    });

    await step('api.start', async () => {
      api = await startApiProcess(4010);
      return { base_url: api.baseUrl };
    });

    const happy = await step('api.happy', async () => {
      const started = await postRun(api.baseUrl, {
        source: 'alpha\nbeta [low]\ngamma',
        sleepMs: 500
      });
      assert(started.status === 202, `POST /runs expected 202 got ${started.status}`);
      const runId = String(started.json.run_id ?? '');
      assert(runId.length > 0, 'POST /runs returned empty run_id');
      const run = await waitForRunTerminal(api.baseUrl, runId);
      assert(run && run.dbos_status === 'SUCCESS', `run terminal dbos_status=${String(run?.dbos_status)}`);
      const timeline = /** @type {Array<{function_name:string,function_id:number}>} */ (run.timeline ?? []);
      const names = timeline.map((row) => row.function_name);
      for (const expectedName of ['prepare', 'DBOS.sleep', 'side-effect', 'finalize']) {
        assert(names.includes(expectedName), `timeline missing ${expectedName}`);
      }
      for (let index = 1; index < timeline.length; index += 1) {
        assert(
          Number(timeline[index].function_id) >= Number(timeline[index - 1].function_id),
          'timeline function_id not monotonic'
        );
      }
      return { run_id: runId, status: run.status, dbos_status: run.dbos_status };
    });
    summary.samples.happy_run_id = happy.run_id;

    const exported = await step('api.export', async () => {
      const result = await exportRun(api.baseUrl, String(summary.samples.happy_run_id));
      assert(result.status === 200, `GET /runs/:id/export expected 200 got ${result.status}`);
      const artifactIds = (result.json.artifacts ?? []).map((row) => row.id);
      assert(isCanonicalArtifactIds(artifactIds), `artifact ids mismatch: ${JSON.stringify(artifactIds)}`);
      const bundlePath = String(result.json.run_bundle_path ?? '');
      assert(bundlePath.length > 0, 'missing run_bundle_path');
      const files = (await readdir(bundlePath)).sort();
      const required = [
        'artifacts.json',
        'citations.json',
        'manifest.json',
        'operation_outputs.json',
        'timeline.json',
        'tool-io.json',
        'workflow_status.json'
      ];
      for (const file of required) {
        assert(files.includes(file), `bundle missing ${file}`);
      }
      return { run_bundle_path: bundlePath, artifact_ids: artifactIds, files };
    });
    summary.samples.bundle_path = exported.run_bundle_path;

    await step('db.truth', async () => {
      const client = await ensureDbClient();
      const runId = String(summary.samples.happy_run_id);
      const header = await client.query(
        'select workflow_uuid,status from dbos.workflow_status where workflow_uuid = $1',
        [runId]
      );
      assert(header.rows.length === 1, `workflow_status rows=${header.rows.length}`);
      const steps = await client.query(
        'select function_id,function_name from dbos.operation_outputs where workflow_uuid = $1 order by function_id asc',
        [runId]
      );
      assert(steps.rows.length >= 4, `operation_outputs rows=${steps.rows.length}`);
      return { workflow_rows: header.rows.length, step_rows: steps.rows.length };
    });

    await step('hostile.invalid_json', async () => {
      const res = await fetch(`${api.baseUrl}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{'
      });
      const body = await res.json();
      assert(res.status === 400, `invalid_json expected 400 got ${res.status}`);
      assert(body.error === 'invalid_json', `invalid_json expected payload got ${JSON.stringify(body)}`);
      return { status: res.status, body };
    });

    await step('hostile.encoded_traversal', async () => {
      const badRun = await curlPathAsIs(api.baseUrl, '/runs/%2E%2E');
      const badExport = await curlPathAsIs(api.baseUrl, '/runs/..%2Fx/export');
      assert(badRun.status === 400, `/runs/%2E%2E expected 400 got ${badRun.status}`);
      assert(badExport.status === 400, `/runs/..%2Fx/export expected 400 got ${badExport.status}`);
      assert(badRun.json.error === 'invalid_run_id', `bad run payload ${badRun.bodyText}`);
      assert(badExport.json.error === 'invalid_run_id', `bad export payload ${badExport.bodyText}`);
      return { run_status: badRun.status, export_status: badExport.status };
    });

    await step('hostile.workflowid_mismatch', async () => {
      const workflowId = `wf-dedup-${process.pid}`;
      const first = await postRun(api.baseUrl, { source: 'one', workflowId, sleepMs: 5 });
      assert(first.status === 202, `first workflowId claim expected 202 got ${first.status}`);
      const second = await postRun(api.baseUrl, { source: 'two', workflowId, sleepMs: 5 });
      assert(second.status === 409, `workflowId mismatch expected 409 got ${second.status}`);
      assert(
        second.json.error === 'workflow_id_payload_mismatch',
        `workflowId mismatch payload ${JSON.stringify(second.json)}`
      );
      return { status: second.status, workflow_id: workflowId };
    });

    await step('hostile.source_unrecoverable', async () => {
      const client = await ensureDbClient();
      const started = await postRun(api.baseUrl, { source: 'will-be-removed', sleepMs: 10 });
      assert(started.status === 202, `source_unrecoverable setup expected 202 got ${started.status}`);
      const runId = String(started.json.run_id);
      await waitForRunTerminal(api.baseUrl, runId);
      await client.query(
        "update dbos.operation_outputs set output = '{\"json\":{\"prepared\":\"MISSING_SOURCE\"}}'::jsonb where workflow_uuid = $1 and function_name = 'prepare'",
        [runId]
      );
      const exportedRun = await exportRun(api.baseUrl, runId);
      assert(exportedRun.status === 422, `source_unrecoverable expected 422 got ${exportedRun.status}`);
      assert(
        exportedRun.json.error === 'source_unrecoverable',
        `source_unrecoverable payload ${JSON.stringify(exportedRun.json)}`
      );
      return { run_id: runId, status: exportedRun.status };
    });

    await step('kill9.start', async () => {
      killApi = await startApiProcess(4301);
      return { base_url: killApi.baseUrl };
    });

    const kill9 = await step('kill9.resume_with_readiness', async () => {
      const started = await postRun(killApi.baseUrl, { source: 'kill9-demo', sleepMs: 800 });
      assert(started.status === 202, `kill9 POST expected 202 got ${started.status}`);
      const runId = String(started.json.run_id);
      await waitForCondition(
        async () => {
          const run = await readRun(killApi.baseUrl, runId);
          return (
            run.status === 200 &&
            Array.isArray(run.json.timeline) &&
            run.json.timeline.some((row) => row.function_name === 'prepare')
          );
        },
        'kill9 run prepare row'
      );
      await killApi.kill();
      killApi = await startApiProcess(4301);
      await waitForCondition(
        async () => {
          try {
            const res = await fetch(`${killApi.baseUrl}/healthz`);
            return res.ok;
          } catch {
            return false;
          }
        },
        'restart healthz readiness'
      );
      const done = await waitForRunTerminal(killApi.baseUrl, runId);
      const names = done.timeline.map((row) => row.function_name);
      assert(done.status === 'done', `kill9 expected done got ${String(done.status)}`);
      assert(done.dbos_status === 'SUCCESS', `kill9 expected SUCCESS got ${String(done.dbos_status)}`);
      assert(names.filter((name) => name === 'prepare').length === 1, 'kill9 prepare count != 1');
      assert(names.filter((name) => name === 'DBOS.sleep').length === 1, 'kill9 DBOS.sleep count != 1');
      return { run_id: runId, status: done.status, dbos_status: done.dbos_status, steps: names };
    });
    summary.samples.kill9_run_id = kill9.run_id;

    await step('cli_api.parity', async () => {
      const runId = String(summary.samples.happy_run_id);
      const cliGet = await runCommand('mise', ['run', 'dbos:workflow:get', '--', runId]);
      assert(cliGet.ok, `dbos workflow get failed: ${cliGet.stderr || cliGet.stdout}`);
      const cliSteps = await runCommand('mise', ['run', 'dbos:workflow:steps', '--', runId]);
      assert(cliSteps.ok, `dbos workflow steps failed: ${cliSteps.stderr || cliSteps.stdout}`);
      const getJson = JSON.parse(cliGet.stdout.trim());
      const stepsJson = JSON.parse(cliSteps.stdout.trim());
      const run = await readRun(api.baseUrl, runId);
      assert(run.status === 200, `API parity run fetch failed status=${run.status}`);
      assert(getJson.workflowID === run.json.run_id, 'CLI/API workflowID mismatch');
      assert(getJson.status === run.json.dbos_status, 'CLI/API status mismatch');
      assert(getJson.workflowName === run.json.header.name, 'CLI/API workflowName mismatch');
      const cliTimeline = stepsJson.map((row) => `${row.functionID}:${row.name}`);
      const apiTimeline = run.json.timeline.map((row) => `${row.function_id}:${row.function_name}`);
      assert(JSON.stringify(cliTimeline) === JSON.stringify(apiTimeline), 'CLI/API timeline mismatch');
      return { workflow_id: getJson.workflowID, steps: cliTimeline.length };
    });

    await step('release.ci', async () => {
      const result = await runCommand('mise', ['run', 'ci']);
      assert(result.ok, `mise run ci failed: ${result.stderr || result.stdout}`);
      return { command: 'mise run ci', duration_ms: result.duration_ms };
    });

    summary.ok = true;
  } catch {
    summary.ok = false;
  } finally {
    if (killApi) await killApi.stop().catch(() => {});
    if (api) await api.stop().catch(() => {});
    await dbClient?.end().catch(() => {});
    await writeFile('.cache/showcase-002-signoff.json', `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const failed = {
    showcase: '002',
    ok: false,
    fatal_error: String(error instanceof Error ? error.message : error)
  };
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/showcase-002-signoff.json', `${JSON.stringify(failed, null, 2)}\n`, 'utf8');
  process.stderr.write(`${JSON.stringify(failed, null, 2)}\n`);
  process.exitCode = 1;
});
