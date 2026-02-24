import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { percentile, postRun, resetBenchState, waitForRunTerminal, withApiServer } from './bench-lib.mjs';
import { startMockOcrServer } from './ocr-mock-server.mjs';

const BENCH_RUNS = 12;
const BENCH_WARMUP_RUNS = 2;
const BENCH_SOURCE = 'invoice alpha\ninvoice beta\ngamma delta';
const BENCH_OCR_RUNS = 8;
const BENCH_OCR_WARMUP_RUNS = 1;

/**
 * @param {Array<{function_name?:string,duration_ms?:number}>} timeline
 * @param {string} step
 */
function readStepDuration(timeline, step) {
  const row = Array.isArray(timeline) ? timeline.find((entry) => entry?.function_name === step) : null;
  const duration = Number(row?.duration_ms ?? 0);
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

/**
 * @param {Array<{started_at_epoch_ms?:number|null,completed_at_epoch_ms?:number|null,duration_ms?:number|null}>} timeline
 */
function readWorkflowDuration(timeline) {
  const rows = Array.isArray(timeline) ? timeline : [];
  return rows
    .map((row) => Number(row?.duration_ms ?? NaN))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .reduce((total, value) => total + value, 0);
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @param {number} intervalMs
 */
async function waitForHealth(url, timeoutMs = 30_000, intervalMs = 250) {
  const startedAt = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn('mise', ['run', 'wait:health', '--', url, String(timeoutMs), String(intervalMs)], {
      cwd: process.cwd(),
      env: process.env,
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
      resolve({ ok: code === 0, code: code ?? 1, stdout, stderr });
    });
  });
  if (!result.ok) {
    throw new Error(`bench_ocr_health_failed:${url}:${result.stderr || result.stdout}`);
  }
  return Date.now() - startedAt;
}

async function main() {
  await resetBenchState();
  const totalRuns = [];
  const parserRuns = [];
  const normalizeRuns = [];
  const indexRuns = [];
  const ftsIngestRuns = [];
  const ocrGateRuns = [];
  const ocrPageRuns = [];
  const ocrMergeRuns = [];
  const ocrWallRuns = [];
  const ocr = await startMockOcrServer({ text: 'ocr bench text' });
  const previousOcrBaseUrl = process.env.OCR_BASE_URL;

  try {
    await waitForHealth(`${ocr.baseUrl}/health`);
    process.env.OCR_BASE_URL = ocr.baseUrl;
    await withApiServer(async ({ baseUrl }) => {
      for (let i = 0; i < BENCH_RUNS + BENCH_WARMUP_RUNS; i += 1) {
        const runId = await postRun(baseUrl, { source: `${BENCH_SOURCE}\nbench-${i}`, sleepMs: 10 });
        const run = await waitForRunTerminal(baseUrl, runId);
        if (run?.status !== 'done') {
          throw new Error(`bench_ingest_run_failed:${runId}:${String(run?.status ?? 'missing')}`);
        }
        if (i < BENCH_WARMUP_RUNS) {
          continue;
        }
        totalRuns.push(readWorkflowDuration(run.timeline));
        const parserMs = readStepDuration(run.timeline, 'marker-convert');
        const normalizeMs = readStepDuration(run.timeline, 'normalize-docir');
        const indexMs = readStepDuration(run.timeline, 'index-fts');
        parserRuns.push(parserMs);
        normalizeRuns.push(normalizeMs);
        indexRuns.push(indexMs);
        ftsIngestRuns.push(normalizeMs + indexMs);
      }

      for (let i = 0; i < BENCH_OCR_RUNS + BENCH_OCR_WARMUP_RUNS; i += 1) {
        const runId = await postRun(baseUrl, {
          intent: 'doc',
          args: {
            source: `table_row_${i}|value\nx`,
            mime: 'application/pdf'
          },
          sleepMs: 10
        });
        const run = await waitForRunTerminal(baseUrl, runId);
        if (run?.status !== 'done') {
          throw new Error(`bench_ocr_run_failed:${runId}:${String(run?.status ?? 'missing')}`);
        }
        if (i < BENCH_OCR_WARMUP_RUNS) continue;
        const gateMs = readStepDuration(run.timeline, 'ocr-persist-gate');
        const renderMs = readStepDuration(run.timeline, 'ocr-render-store-pages');
        const pageMs = readStepDuration(run.timeline, 'ocr-pages');
        const mergeMs = readStepDuration(run.timeline, 'ocr-merge-diff');
        if (gateMs <= 0 || pageMs <= 0 || mergeMs <= 0) {
          throw new Error(`bench_ocr_missing_metrics:${runId}`);
        }
        ocrGateRuns.push(gateMs);
        ocrPageRuns.push(pageMs);
        ocrMergeRuns.push(mergeMs);
        ocrWallRuns.push(gateMs + renderMs + pageMs + mergeMs);
      }
    });
  } finally {
    if (previousOcrBaseUrl == null) {
      delete process.env.OCR_BASE_URL;
    } else {
      process.env.OCR_BASE_URL = previousOcrBaseUrl;
    }
    await ocr.close().catch(() => {});
  }

  const metric = {
    ingest_p50_ms: Number(percentile(totalRuns, 50).toFixed(2)),
    ingest_p95_ms: Number(percentile(totalRuns, 95).toFixed(2)),
    fts_ingest_ms: Number(percentile(ftsIngestRuns, 95).toFixed(2)),
    parser_p95_ms: Number(percentile(parserRuns, 95).toFixed(2)),
    normalize_p95_ms: Number(percentile(normalizeRuns, 95).toFixed(2)),
    index_fts_p95_ms: Number(percentile(indexRuns, 95).toFixed(2)),
    ocr_gate_ms: Number(percentile(ocrGateRuns, 95).toFixed(2)),
    ocr_page_p95_ms: Number(percentile(ocrPageRuns, 95).toFixed(2)),
    ocr_merge_ms: Number(percentile(ocrMergeRuns, 95).toFixed(2)),
    ocr_wall_ms: Number(percentile(ocrWallRuns, 95).toFixed(2))
  };

  await mkdir('.cache/bench', { recursive: true });
  await writeFile('.cache/bench/ingest.json', `${JSON.stringify(metric, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(metric)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
