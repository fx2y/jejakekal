import { readJsonRequest, sendJson } from './http.mjs';
import { exportRunBundle } from './export-run.mjs';
import { readRun, normalizeRunStartPayload, startRunDurably } from './runs-service.mjs';
import { insertChatEvent } from './chat-events/repository.mjs';
import { conflict } from './request-errors.mjs';
import { ensureDbosRuntime } from './dbos-runtime.mjs';
import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  decodeRunExportRouteId,
  decodeRunResumeRouteId,
  decodeRunRouteId,
  getRequestPathname
} from './routes/runs-paths.mjs';

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{client: import('pg').Client, bundlesRoot: string}} ctx
 */
export async function handleRunsRoute(req, res, ctx) {
  if (!req.url) return false;
  const pathname = getRequestPathname(req.url);

  if (req.method === 'POST' && pathname === '/runs') {
    const payload = normalizeRunStartPayload(await readJsonRequest(req));
    const { runId } = await startRunDurably(ctx.client, { ...payload, bundlesRoot: ctx.bundlesRoot });
    await insertChatEvent(ctx.client, { cmd: payload.cmd, args: payload.args, run_id: runId });
    const run = await readRun(ctx.client, runId);
    sendJson(res, 202, {
      run_id: runId,
      status: run?.status ?? 'running',
      dbos_status: run?.dbos_status ?? null
    });
    return true;
  }

  if (req.method === 'GET') {
    const exportRunId = decodeRunExportRouteId(pathname);
    if (exportRunId) {
      const exported = await exportRunBundle({
        client: ctx.client,
        bundlesRoot: ctx.bundlesRoot,
        runId: exportRunId
      });
      if (!exported) {
        sendJson(res, 404, { error: 'run_not_found', run_id: exportRunId });
        return true;
      }
      sendJson(res, 200, exported);
      return true;
    }

    const runId = decodeRunRouteId(pathname);
    if (runId) {
      const run = await readRun(ctx.client, runId);
      if (!run) {
        sendJson(res, 404, { error: 'run_not_found', run_id: runId });
        return true;
      }
      sendJson(res, 200, run);
      return true;
    }
  }

  if (req.method === 'POST') {
    const resumeRunId = decodeRunResumeRouteId(pathname);
    if (resumeRunId) {
      const run = await readRun(ctx.client, resumeRunId);
      if (!run) {
        sendJson(res, 404, { error: 'run_not_found', run_id: resumeRunId });
        return true;
      }
      if (!['CANCELLED', 'RETRIES_EXCEEDED'].includes(String(run.dbos_status))) {
        throw conflict('run_not_resumable', { run_id: resumeRunId });
      }
      await ensureDbosRuntime();
      await DBOS.resumeWorkflow(resumeRunId);
      sendJson(res, 202, { run_id: resumeRunId, status: 'running' });
      return true;
    }
  }

  return false;
}
