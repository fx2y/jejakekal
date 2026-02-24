import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { makeClient } from '../apps/api/src/db.mjs';
import { startMockOcrServer } from './ocr-mock-server.mjs';

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

const DEFAULT_FILER_PORT = 8888;
const ALT_FILER_PORT = 18888;

async function isTcpPortOccupied(port) {
  const result = await runCommand('ss', ['-ltn']);
  if (!result.ok) return false;
  const marker = `:${port}`;
  return result.stdout
    .split('\n')
    .some((line) => line.includes(marker));
}

async function resolveStackEnvOverrides() {
  const defaultEndpoint = `http://127.0.0.1:${DEFAULT_FILER_PORT}`;
  const filerPort = process.env.SEAWEED_FILER_PORT;
  const filerEndpoint = process.env.BLOB_FILER_ENDPOINT;
  const hasExplicitPort = typeof filerPort === 'string' && filerPort.length > 0;
  const hasExplicitEndpoint =
    typeof filerEndpoint === 'string' && filerEndpoint.length > 0 && filerEndpoint !== defaultEndpoint;
  if ((hasExplicitPort && !hasExplicitEndpoint) || (!hasExplicitPort && hasExplicitEndpoint)) {
    throw new Error(
      'paired filer override required: set both SEAWEED_FILER_PORT and BLOB_FILER_ENDPOINT'
    );
  }
  if (hasExplicitPort && hasExplicitEndpoint) {
    return {
      env: {
        SEAWEED_FILER_PORT: filerPort,
        BLOB_FILER_ENDPOINT: filerEndpoint
      },
      mode: 'explicit'
    };
  }
  const occupied = await isTcpPortOccupied(DEFAULT_FILER_PORT);
  if (!occupied) {
    return { env: {}, mode: 'default' };
  }
  return {
    env: {
      SEAWEED_FILER_PORT: String(ALT_FILER_PORT),
      BLOB_FILER_ENDPOINT: `http://127.0.0.1:${ALT_FILER_PORT}`
    },
    mode: 'auto_override'
  };
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
 * @param {Record<string, string>} [envOverrides]
 */
async function startApiProcess(port, envOverrides = {}) {
  const child = spawn(process.execPath, ['apps/api/src/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, ...envOverrides, API_PORT: String(port) },
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
 * @param {unknown} value
 */
function assertSha(value, label) {
  const text = typeof value === 'string' ? value : '';
  assert(/^[a-f0-9]{64}$/.test(text), `${label}_invalid`);
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
 * @param {string} runId
 */
async function resumeRun(baseUrl, runId) {
  const res = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST'
  });
  return { status: res.status, json: await res.json() };
}

/**
 * @param {string} baseUrl
 * @param {string} query
 */
async function listArtifacts(baseUrl, query = '') {
  const suffix = query ? `?${query}` : '';
  const res = await fetch(`${baseUrl}/artifacts${suffix}`);
  return { status: res.status, json: await res.json() };
}

/**
 * @param {string} baseUrl
 * @param {string} artifactId
 */
async function getArtifact(baseUrl, artifactId) {
  const res = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`);
  return { status: res.status, json: await res.json() };
}

/**
 * @param {string} baseUrl
 * @param {string} artifactId
 */
async function downloadArtifact(baseUrl, artifactId) {
  const res = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/download`);
  return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
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

/**
 * @param {string} runId
 */
async function cancelWorkflow(runId) {
  const result = await runCommand(
    'pnpm',
    [
      '--filter',
      '@jejakekal/api',
      'exec',
      'dbos',
      'workflow',
      'cancel',
      '-s',
      String(process.env.DBOS_SYSTEM_DATABASE_URL),
      runId
    ],
    { cwd: process.cwd() }
  );
  assert(result.ok, `dbos workflow cancel failed: ${result.stderr || result.stdout}`);
}

async function main() {
  const requireLiveOcr = process.env.SHOWCASE_LIVE_OCR === '1';
  const enforceReleaseCi =
    process.env.SHOWCASE_SKIP_CI === '1'
      ? false
      : process.env.SHOWCASE_ENFORCE_CI === '0'
        ? false
        : true;
  const summary = {
    showcase: '002',
    date_utc: new Date().toISOString(),
    ok: false,
    release_evidence: false,
    failed_step_ids: /** @type {string[]} */ ([]),
    steps: /** @type {Array<Record<string, unknown>>} */ ([]),
    samples: {},
    policy: {
      require_live_ocr: requireLiveOcr,
      enforce_release_ci: enforceReleaseCi
    }
  };
  await mkdir('.cache', { recursive: true });

  /** @type {ApiProcess | null} */
  let api = null;
  /** @type {ApiProcess | null} */
  let killApi = null;
  /** @type {import('pg').Client | null} */
  let dbClient = null;
  /** @type {Record<string, string>} */
  let stackEnv = {};
  /** @type {{baseUrl:string,requests:string[],close:() => Promise<void>} | null} */
  let ocrMock = null;
  let ocrBaseUrl = '';

  /**
   * Execute stack task wrappers directly so paired filer override env is honored
   * even when `.mise.toml` sets default env values.
   * @param {'up'|'down'|'reset'} task
   */
  async function runStackTask(task) {
    return runCommand('bash', [`mise-tasks/stack/${task}`], { env: stackEnv });
  }

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
    await step('setup.filer_preflight', async () => {
      const override = await resolveStackEnvOverrides();
      stackEnv = override.env;
      return { mode: override.mode, ...stackEnv };
    });

    await step('setup.up', async () => {
      const result = await runStackTask('up');
      assert(result.ok, `stack up failed: ${result.stderr || result.stdout}`);
      return { command: 'bash mise-tasks/stack/up', duration_ms: result.duration_ms };
    });

    await step('setup.reset', async () => {
      const reset = await runStackTask('reset');
      if (reset.ok) {
        return {
          command: 'bash mise-tasks/stack/reset',
          duration_ms: reset.duration_ms
        };
      }

      const needsRecovery =
        reset.stderr.includes('is being accessed by other users') ||
        reset.stdout.includes('is being accessed by other users');
      assert(needsRecovery, `stack reset failed: ${reset.stderr || reset.stdout}`);

      const down = await runStackTask('down');
      assert(down.ok, `stack down recovery failed: ${down.stderr || down.stdout}`);
      const up = await runStackTask('up');
      assert(up.ok, `stack up recovery failed: ${up.stderr || up.stdout}`);
      const retry = await runStackTask('reset');
      assert(retry.ok, `stack reset retry failed: ${retry.stderr || retry.stdout}`);
      return {
        command: 'bash mise-tasks/stack/reset',
        recovered_via: ['bash mise-tasks/stack/down', 'bash mise-tasks/stack/up', 'bash mise-tasks/stack/reset'],
        duration_ms: reset.duration_ms + down.duration_ms + up.duration_ms + retry.duration_ms
      };
    });

    await step('setup.ocr_health', async () => {
      if (requireLiveOcr) {
        ocrBaseUrl = String(process.env.OCR_BASE_URL || '').trim();
        assert(ocrBaseUrl.length > 0, 'SHOWCASE_LIVE_OCR=1 requires OCR_BASE_URL');
      } else {
        ocrMock = await startMockOcrServer({ text: 'showcase ocr text' });
        ocrBaseUrl = ocrMock.baseUrl;
      }
      const health = await runCommand('mise', [
        'run',
        'wait:health',
        '--',
        `${ocrBaseUrl}/health`,
        '15000',
        '100'
      ]);
      assert(health.ok, `ocr health gate failed: ${health.stderr || health.stdout}`);
      return { mode: requireLiveOcr ? 'live' : 'mock', ocr_base_url: ocrBaseUrl };
    });

    await step('api.start', async () => {
      api = await startApiProcess(4010, { OCR_BASE_URL: ocrBaseUrl });
      return { base_url: api.baseUrl };
    });

    await step('api.command_router', async () => {
      const slash = await postRun(api.baseUrl, { cmd: '/doc c5-command-router-slash', sleepMs: 10 });
      assert(slash.status === 202, `slash cmd expected 202 got ${slash.status}`);
      const canonical = await postRun(api.baseUrl, {
        intent: 'doc',
        args: { source: 'c5-command-router-canonical' },
        sleepMs: 10
      });
      assert(canonical.status === 202, `canonical intent expected 202 got ${canonical.status}`);
      const slashRunId = String(slash.json.run_id ?? '');
      const canonicalRunId = String(canonical.json.run_id ?? '');
      assert(slashRunId, 'slash cmd missing run_id');
      assert(canonicalRunId, 'canonical payload missing run_id');
      const client = await ensureDbClient();
      const rows = await client.query(
        `SELECT cmd, args, run_id
         FROM chat_event
         WHERE run_id = ANY($1::text[])
         ORDER BY created_at ASC`,
        [[slashRunId, canonicalRunId]]
      );
      assert(rows.rows.length === 2, `chat_event rows for command router expected 2 got ${rows.rows.length}`);
      assert(rows.rows.every((row) => typeof row.cmd === 'string'), 'chat_event cmd missing');
      assert(rows.rows.every((row) => row.args && typeof row.args === 'object'), 'chat_event args missing');
      return { run_ids: [slashRunId, canonicalRunId], chat_rows: rows.rows.length };
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
      for (const expectedName of [
        'reserve-doc',
        'store-raw',
        'DBOS.sleep',
        'marker-convert',
        'store-parse-outputs',
        'normalize-docir',
        'index-fts',
        'emit-exec-memo',
        'artifact-count'
      ]) {
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

    const harddoc = await step('api.harddoc_ocr', async () => {
      const started = await postRun(api.baseUrl, {
        intent: 'doc',
        args: {
          source: 'table header|value\nx',
          mime: 'application/pdf'
        },
        sleepMs: 10
      });
      assert(started.status === 202, `harddoc start expected 202 got ${started.status}`);
      const runId = String(started.json.run_id ?? '');
      assert(runId.length > 0, 'harddoc missing run_id');
      const run = await waitForRunTerminal(api.baseUrl, runId);
      assert(run?.status === 'done', `harddoc status=${String(run?.status ?? 'missing')}`);
      assert(run?.dbos_status === 'SUCCESS', `harddoc dbos_status=${String(run?.dbos_status ?? 'missing')}`);

      const timeline = Array.isArray(run.timeline) ? run.timeline : [];
      const gate = timeline.find((row) => row.function_name === 'ocr-persist-gate');
      const pagesStep = timeline.find((row) => row.function_name === 'ocr-pages');
      const merge = timeline.find((row) => row.function_name === 'ocr-merge-diff');
      assert(gate, 'harddoc missing ocr-persist-gate');
      assert(pagesStep, 'harddoc missing ocr-pages');
      assert(merge, 'harddoc missing ocr-merge-diff');

      const hardPages = Array.isArray(gate.output?.hard_pages)
        ? [...new Set(gate.output.hard_pages.map((x) => Number(x)).filter((x) => Number.isFinite(x)))].sort(
            (a, b) => a - b
          )
        : [];
      const ocrPages = Array.isArray(pagesStep.output?.ocr_pages)
        ? [
            ...new Set(
              pagesStep.output.ocr_pages
                .map((row) => Number(row?.page_idx))
                .filter((x) => Number.isFinite(x))
            )
          ].sort((a, b) => a - b)
        : [];
      const diffSha = merge.output?.diff_sha;
      assert(hardPages.length > 0, 'harddoc hard_pages empty');
      assert(ocrPages.length > 0, 'harddoc ocr_pages empty');
      assertSha(diffSha, 'harddoc_diff_sha');

      const client = await ensureDbClient();
      const effectRows = await client.query(
        `SELECT effect_key, COUNT(*) AS n
         FROM side_effects
         WHERE effect_key LIKE $1
         GROUP BY effect_key
         ORDER BY effect_key ASC`,
        [`${runId}|ocr-page|%`]
      );
      assert(effectRows.rows.length === ocrPages.length, 'harddoc ocr effect rows mismatch');
      assert(effectRows.rows.every((row) => Number(row.n) === 1), 'harddoc duplicate ocr side_effect row');
      assert(
        Array.isArray(ocrMock?.requests) && ocrMock.requests.length === ocrPages.length,
        'harddoc mock ocr call count mismatch'
      );

      return {
        run_id: runId,
        hard_pages: hardPages,
        ocr_pages: ocrPages,
        diff_sha: diffSha,
        ocr_effect_rows: effectRows.rows.length
      };
    });
    summary.samples.harddoc_run_id = harddoc.run_id;

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

    await step('api.artifact_routes', async () => {
      const runId = String(summary.samples.happy_run_id);
      const artifactId = `${runId}:raw`;
      const listed = await listArtifacts(api.baseUrl, 'type=raw&visibility=user');
      assert(listed.status === 200, `GET /artifacts expected 200 got ${listed.status}`);
      assert(Array.isArray(listed.json), 'artifact list is not array');
      assert(
        listed.json.some((row) => row?.id === artifactId),
        `artifact list missing ${artifactId}`
      );
      const detail = await getArtifact(api.baseUrl, artifactId);
      assert(detail.status === 200, `GET /artifacts/:id expected 200 got ${detail.status}`);
      assert(detail.json?.meta?.id === artifactId, `artifact detail meta.id mismatch ${JSON.stringify(detail.json)}`);
      assert(detail.json?.prov?.run_id === runId, `artifact detail prov.run_id mismatch ${JSON.stringify(detail.json)}`);
      const blob = await downloadArtifact(api.baseUrl, artifactId);
      assert(blob.status === 200, `GET /artifacts/:id/download expected 200 got ${blob.status}`);
      assert(blob.contentType.startsWith('text/plain'), `artifact download content-type ${blob.contentType}`);
      assert(blob.text.includes('alpha'), 'artifact download missing expected raw source content');
      return { artifact_id: artifactId, list_count: listed.json.length, content_type: blob.contentType };
    });

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
        "update dbos.operation_outputs set output = '{\"json\":{\"prepared\":\"MISSING_SOURCE\"}}'::jsonb where workflow_uuid = $1 and function_name = 'reserve-doc'",
        [runId]
      );
      const exportedRun = await exportRun(api.baseUrl, runId);
      assert(exportedRun.status === 200, `source_unrecoverable fallback expected 200 got ${exportedRun.status}`);
      const artifactIds = (exportedRun.json.artifacts ?? []).map((row) => row.id);
      assert(isCanonicalArtifactIds(artifactIds), `source_unrecoverable fallback artifacts ${JSON.stringify(artifactIds)}`);
      return { run_id: runId, status: exportedRun.status, artifact_ids: artifactIds };
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
            run.json.timeline.some((row) => row.function_name === 'reserve-doc')
          );
        },
        'kill9 run reserve-doc row'
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
      assert(names.filter((name) => name === 'reserve-doc').length === 1, 'kill9 reserve-doc count != 1');
      assert(names.filter((name) => name === 'DBOS.sleep').length === 1, 'kill9 DBOS.sleep count != 1');
      return { run_id: runId, status: done.status, dbos_status: done.dbos_status, steps: names };
    });
    summary.samples.kill9_run_id = kill9.run_id;

    await step('resume.endpoint_drill', async () => {
      const started = await postRun(api.baseUrl, { cmd: '/doc c5-resume-endpoint', sleepMs: 2500 });
      assert(started.status === 202, `resume drill POST expected 202 got ${started.status}`);
      const runId = String(started.json.run_id ?? '');
      await waitForCondition(
        async () => {
          const run = await readRun(api.baseUrl, runId);
          return run.status === 200 && run.json?.status === 'running';
        },
        `resume drill running ${runId}`,
        10_000,
        50
      );
      await cancelWorkflow(runId);
      await waitForCondition(
        async () => {
          const run = await readRun(api.baseUrl, runId);
          return run.status === 200 && run.json?.dbos_status === 'CANCELLED';
        },
        `resume drill cancelled ${runId}`,
        10_000,
        100
      );
      const resumed = await resumeRun(api.baseUrl, runId);
      assert(resumed.status === 202, `resume endpoint expected 202 got ${resumed.status}`);
      assert(resumed.json?.run_id === runId, `resume response mismatch ${JSON.stringify(resumed.json)}`);
      const done = await waitForRunTerminal(api.baseUrl, runId);
      assert(done?.status === 'done', `resume drill terminal status ${String(done?.status)}`);
      assert(done?.dbos_status === 'SUCCESS', `resume drill dbos_status ${String(done?.dbos_status)}`);
      assert(
        done.timeline.filter((row) => row.function_name === 'reserve-doc').length === 1,
        'resume drill duplicated reserve-doc'
      );
      return { run_id: runId, status: done.status, dbos_status: done.dbos_status };
    });

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

    if (enforceReleaseCi) {
      await step('release.ci', async () => {
        const result = await runCommand('mise', ['run', '--force', 'ci'], { env: stackEnv });
        assert(result.ok, `mise run ci failed: ${result.stderr || result.stdout}`);
        return {
          command: 'mise run --force ci',
          duration_ms: result.duration_ms,
          release_ci_executed: true
        };
      });
    } else {
      await step('release.ci', async () => {
        return {
          skipped: true,
          release_ci_executed: false,
          reason: 'skip requested via SHOWCASE_SKIP_CI=1 or SHOWCASE_ENFORCE_CI=0'
        };
      });
    }

    summary.release_evidence = requireLiveOcr && enforceReleaseCi;
    summary.ok = true;
  } catch {
    summary.ok = false;
  } finally {
    await ocrMock?.close().catch(() => {});
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
