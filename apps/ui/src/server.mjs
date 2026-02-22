import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startApiServer } from '../../api/src/server.mjs';
import { closeServer, listenLocal, sendJson } from '../../api/src/http.mjs';
import { onceAsync } from '../../../packages/core/src/once-async.mjs';
import { decodeArtifactRouteId } from '../../api/src/routes/artifacts-paths.mjs';
import { decodeRunRouteId, getRequestPathname } from '../../api/src/routes/runs-paths.mjs';
import { decodeAndValidateRunId } from '../../api/src/run-id.mjs';
import { isRequestError } from '../../api/src/request-errors.mjs';
import { shouldServeFullDocument } from './hx-request.mjs';
import { getArtifact, getRun, listArtifacts, resumeRun, startRun } from './ui-api-client.mjs';
import { resolveRunAfterStart } from './ui-command-start.mjs';
import {
  renderArtifactViewer,
  renderArtifactsPane,
  renderCommandFragment,
  renderConversationPane,
  renderExecutionPane,
  renderMainFragment,
  renderPage,
  renderPollFragment
} from './ui-render.mjs';
import { statusModel } from './ui-view-model.mjs';

/**
 * @param {number} uiPort
 * @param {{apiPort?: number}} [opts]
 */
export async function startUiServer(uiPort = 4110, opts = {}) {
  const api = await startApiServer(Number(opts.apiPort ?? process.env.API_PORT ?? '4010'));

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400).end('missing url');
        return;
      }

      if (await handleUiRoutes(req, res, { apiPort: api.port })) {
        return;
      }

      if (shouldProxy(req.method ?? 'GET', req.url)) {
        await proxyToApi(req, res, api.port);
        return;
      }

      const file = resolveStaticFile(req.url);
      const contentType = contentTypeFor(file);
      const payload = await readFile(join(process.cwd(), 'apps/ui/src', file), 'utf8');
      res.writeHead(200, { 'content-type': contentType });
      res.end(payload);
    } catch (error) {
      if (isRequestError(error)) {
        sendJson(res, error.status, error.payload);
        return;
      }
      sendJson(res, 500, { error: 'internal_error' });
    }
  });

  const boundUiPort = await listenLocal(server, uiPort);
  const close = onceAsync(async () => {
    await closeServer(server);
    await api.close();
  });

  return {
    uiPort: boundUiPort,
    apiPort: api.port,
    close
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
async function readRequest(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

/**
 * @param {string} url
 */
function readFilters(url) {
  const queryIndex = url.indexOf('?');
  const query =
    queryIndex === -1 ? new URLSearchParams() : new URLSearchParams(url.slice(queryIndex + 1));
  const sleepRaw = query.get('sleepMs');
  const sleepMs = sleepRaw ? Number(sleepRaw) : undefined;
  const stepRaw = query.get('step');
  const step = stepRaw == null ? undefined : Number(stepRaw);
  return {
    type: query.get('type') ?? undefined,
    visibility: query.get('visibility') ?? undefined,
    q: query.get('q') ?? undefined,
    sleepMs: Number.isFinite(sleepMs) ? sleepMs : undefined,
    step: Number.isFinite(step) ? Math.max(0, Math.trunc(step)) : undefined,
    queryString: query.toString()
  };
}

/**
 * @param {string} pathname
 */
function decodeUiResumeRouteRunId(pathname) {
  return decodeUiRunRouteIdWithSuffix(pathname, '/resume');
}

/**
 * @param {string} pathname
 */
function decodeUiPollRouteRunId(pathname) {
  return decodeUiRunRouteIdWithSuffix(pathname, '/poll');
}

/**
 * @param {string} pathname
 * @param {string} suffix
 */
function decodeUiRunRouteIdWithSuffix(pathname, suffix) {
  const prefix = '/ui/runs/';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const raw = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (!raw || raw.includes('/')) return null;
  return decodeAndValidateRunId(raw);
}

/**
 * @param {{run: import('./ui-view-model.mjs').RunProjection | null, runMissing: boolean, runErrorStatus: number | null}} state
 * @param {string | null} requestedRunId
 */
function uiRunView(state, requestedRunId) {
  if (state.run) {
    const status = statusModel(state.run);
    return { status, execEmptyText: 'No run selected.' };
  }
  if (requestedRunId && state.runMissing) {
    return {
      status: { state: 'error', text: `error:${requestedRunId}:run_not_found` },
      execEmptyText: 'Run not found.'
    };
  }
  if (requestedRunId && state.runErrorStatus != null) {
    return {
      status: { state: 'error', text: `error:${requestedRunId}:load:${state.runErrorStatus}` },
      execEmptyText: `Run load failed (${state.runErrorStatus}).`
    };
  }
  return { status: statusModel(null), execEmptyText: 'No run selected.' };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {{type?: string, visibility?: string, q?: string, sleepMs?: number, step?: number}} filters
 * @param {{statusCode:number, statusText:string}} errorState
 */
function sendPollErrorResponse(res, headers, filters, errorState) {
  const exec = renderExecutionPane(null, filters, {
    status: { state: 'error', text: errorState.statusText },
    emptyText: 'Run unavailable.'
  }).replace(
    '<section id="execution-plane" class="plane">',
    '<section id="execution-plane" class="plane" hx-swap-oob="true">'
  );
  const artifacts = renderArtifactsPane([], filters);
  if (shouldServeFullDocument(headers)) {
    const page = renderPage({
      title: 'Run',
      conv: renderConversationPane('error', errorState.statusText),
      exec: renderExecutionPane(null, filters, {
        status: { state: 'error', text: errorState.statusText },
        emptyText: 'Run unavailable.'
      }),
      artifacts
    });
    res.writeHead(errorState.statusCode, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  res.writeHead(errorState.statusCode, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    renderPollFragment({
      exec,
      artifacts,
      statusState: 'error',
      statusText: errorState.statusText
    })
  );
}

/**
 * @param {number} apiPort
 * @param {string|null} runId
 * @param {{type?: string, visibility?: string, q?: string, sleepMs?: number, queryString?: string}} filters
 */
async function loadUiState(apiPort, runId, filters) {
  const artifactsRes = await listArtifacts(apiPort, filters.queryString ?? '');
  const artifacts = Array.isArray(artifactsRes.body) ? artifactsRes.body : [];

  let run = null;
  let runMissing = false;
  let runErrorStatus = null;
  if (runId) {
    const runRes = await getRun(apiPort, runId);
    if (runRes.ok && runRes.body && typeof runRes.body === 'object') {
      run = /** @type {import('./ui-view-model.mjs').RunProjection} */ (runRes.body);
    } else if (runRes.status === 404) {
      runMissing = true;
    } else {
      runErrorStatus = runRes.status;
    }
  }

  return { run, artifacts, runMissing, runErrorStatus };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{apiPort:number}} ctx
 */
async function handleUiRoutes(req, res, ctx) {
  if (!req.url) return false;
  const pathname = getRequestPathname(req.url);
  const filters = readFilters(req.url);

  if (req.method === 'GET' && pathname === '/__probe/hx-branch') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        hx_request: String(req.headers['hx-request'] ?? '').toLowerCase() === 'true',
        hx_history_restore_request:
          String(req.headers['hx-history-restore-request'] ?? '').toLowerCase() === 'true',
        full_document: shouldServeFullDocument(req.headers)
      })
    );
    return true;
  }

  if (req.method === 'POST' && pathname === '/ui/commands') {
    const formBody = new URLSearchParams(await readRequest(req));
    const cmd = (formBody.get('cmd') ?? '').trim();
    const sleepMs = Number(formBody.get('sleepMs') ?? filters.sleepMs ?? NaN);
    const started = await startRun(ctx.apiPort, {
      cmd,
      sleepMs: Number.isFinite(sleepMs) ? Math.max(1, Math.floor(sleepMs)) : undefined
    });

    const run = await resolveRunAfterStart(started, (runId) => getRun(ctx.apiPort, runId));

    const artifactsRes = await listArtifacts(ctx.apiPort, filters.queryString);
    const artifacts = Array.isArray(artifactsRes.body) ? artifactsRes.body : [];
    const status = statusModel(run);

    const conv = started.ok
      ? renderConversationPane(status.state, status.text)
      : renderConversationPane('error', `error:start:${started.status}`);

    const panes = {
      conv: conv.replace('<aside id="conv">', '<aside id="conv" hx-swap-oob="true">'),
      exec: renderExecutionPane(run, filters, {
        status,
        emptyText: started.ok ? 'Run not yet visible.' : 'No run selected.'
      }),
      artifacts: renderArtifactsPane(artifacts, filters),
      statusState: started.ok ? status.state : 'error',
      statusText: started.ok ? status.text : `error:start:${started.status}`
    };
    if (shouldServeFullDocument(req.headers)) {
      const page = renderPage({
        title: run ? `Run ${run.run_id}` : 'Jejakekal Harness',
        conv: renderConversationPane(panes.statusState, panes.statusText),
        exec: renderExecutionPane(run, filters, {
          status: { state: panes.statusState, text: panes.statusText },
          emptyText: started.ok ? 'Run not yet visible.' : 'No run selected.'
        }),
        artifacts: renderArtifactsPane(artifacts, filters)
      });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return true;
    }

    const fragment = renderCommandFragment(panes);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fragment);
    return true;
  }

  if (req.method === 'POST') {
    const resumeRunId = decodeUiResumeRouteRunId(pathname);
    if (resumeRunId) {
      const resumed = await resumeRun(ctx.apiPort, resumeRunId);
      const state = await loadUiState(ctx.apiPort, resumeRunId, filters);
      const runView = uiRunView(state, resumeRunId);
      const status = runView.status;
      const conv = resumed.ok
        ? renderConversationPane(status.state, status.text)
        : renderConversationPane('error', `error:resume:${resumed.status}`);
      const panes = {
        conv: conv.replace('<aside id="conv">', '<aside id="conv" hx-swap-oob="true">'),
        exec: renderExecutionPane(state.run, filters, {
          status,
          emptyText: runView.execEmptyText
        }),
        artifacts: renderArtifactsPane(state.artifacts, filters),
        statusState: resumed.ok ? status.state : 'error',
        statusText: resumed.ok ? status.text : `error:resume:${resumed.status}`
      };
      if (shouldServeFullDocument(req.headers)) {
        const page = renderPage({
          title: state.run ? `Run ${state.run.run_id}` : 'Jejakekal Harness',
          conv: renderConversationPane(panes.statusState, panes.statusText),
          exec: renderExecutionPane(state.run, filters, {
            status: { state: panes.statusState, text: panes.statusText },
            emptyText: runView.execEmptyText
          }),
          artifacts: renderArtifactsPane(state.artifacts, filters)
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return true;
      }
      const fragment = renderCommandFragment(panes);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fragment);
      return true;
    }
  }

  if (req.method === 'GET') {
    if (pathname.startsWith('/ui/runs/') && pathname.endsWith('/poll')) {
      let runId = null;
      try {
        runId = decodeUiPollRouteRunId(pathname);
      } catch (error) {
        if (isRequestError(error)) {
          sendPollErrorResponse(res, req.headers, filters, {
            statusCode: error.status,
            statusText: `error:${String(error.payload.error ?? 'invalid_run_id')}`
          });
          return true;
        }
        throw error;
      }
      if (!runId) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return true;
      }
      const state = await loadUiState(ctx.apiPort, runId, filters);
      if (state.runMissing) {
        sendPollErrorResponse(res, req.headers, filters, {
          statusCode: 404,
          statusText: `error:${runId}:run_not_found`
        });
        return true;
      }
      const runView = uiRunView(state, runId);
      const status = runView.status;
      const exec = renderExecutionPane(state.run, filters, {
        status,
        emptyText: runView.execEmptyText
      }).replace(
        '<section id="execution-plane" class="plane">',
        '<section id="execution-plane" class="plane" hx-swap-oob="true">'
      );
      const artifacts = renderArtifactsPane(state.artifacts, filters);

      if (shouldServeFullDocument(req.headers)) {
        const page = renderPage({
          title: state.run ? `Run ${state.run.run_id}` : 'Run',
          conv: renderConversationPane(status.state, status.text),
          exec: renderExecutionPane(state.run, filters, {
            status,
            emptyText: runView.execEmptyText
          }),
          artifacts
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return true;
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        renderPollFragment({
          exec,
          artifacts,
          statusState: status.state,
          statusText: status.text
        })
      );
      return true;
    }

    const runId = decodeRunRouteId(pathname);
    const artifactId = decodeArtifactRouteId(pathname);
    const isMainRoute = pathname === '/' || pathname === '/artifacts' || !!runId || !!artifactId;
    if (isMainRoute) {
      const state = await loadUiState(ctx.apiPort, runId, filters);
      const runView = uiRunView(state, runId);
      const status = runView.status;
      const conv = renderConversationPane(status.state, status.text);
      const exec = renderExecutionPane(state.run, filters, {
        status,
        emptyText: runView.execEmptyText
      });

      let artifacts = renderArtifactsPane(state.artifacts, filters);
      if (artifactId) {
        const artifactRes = await getArtifact(ctx.apiPort, artifactId);
        artifacts = renderArtifactViewer(
          artifactRes.ok && artifactRes.body && typeof artifactRes.body === 'object'
            ? /** @type {{meta?:Record<string, unknown>,content?:unknown,prov?:unknown}} */ (
                artifactRes.body
              )
            : null
        );
      }

      const panes = {
        conv,
        exec,
        artifacts,
        title: runId ? `Run ${runId}` : artifactId ? `Artifact ${artifactId}` : 'Jejakekal Harness'
      };

      const html = shouldServeFullDocument(req.headers) ? renderPage(panes) : renderMainFragment(panes);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return true;
    }
  }

  return false;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} apiPort
 */
async function proxyToApi(req, res, apiPort) {
  const upstream = await fetch(`http://127.0.0.1:${apiPort}${req.url}`, {
    method: req.method,
    headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
    body: req.method === 'POST' ? await readRequest(req) : undefined
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': upstream.headers.get('content-type') ?? 'application/json'
  };
  const contentDisposition = upstream.headers.get('content-disposition');
  if (contentDisposition) {
    headers['content-disposition'] = contentDisposition;
  }
  res.writeHead(upstream.status, headers);
  res.end(body);
}

/**
 * @param {string} url
 */
function resolveStaticFile(url) {
  if (url === '/app.js') return 'app.mjs';
  if (url === '/' || url === '/index.html') return 'index.html';

  const name = url.startsWith('/') ? url.slice(1) : url;
  if (!name.includes('/') && (name.endsWith('.css') || name.endsWith('.mjs') || name.endsWith('.js'))) {
    return name;
  }
  return 'index.html';
}

/**
 * @param {string} method
 * @param {string} url
 */
function shouldProxy(method, url) {
  if (method === 'GET') {
    const pathname = getRequestPathname(url);
    if (pathname === '/runs' || pathname === '/artifacts') return true;
    if (pathname.startsWith('/runs/') && !pathname.endsWith('/poll')) {
      return pathname.endsWith('/export') || pathname.endsWith('/bundle') || pathname.endsWith('/bundle.zip');
    }
    if (pathname.startsWith('/artifacts/') && pathname.endsWith('/download')) return true;
    return url === '/healthz';
  }
  return url.startsWith('/runs') || url.startsWith('/artifacts') || url === '/healthz';
}

/**
 * @param {string} file
 */
function contentTypeFor(file) {
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.js')) return 'text/javascript';
  if (file.endsWith('.mjs')) return 'text/javascript';
  return 'text/html';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.UI_PORT ?? '4110');
  startUiServer(port)
    .then((ui) => {
      process.stdout.write(`ui listening on ${ui.uiPort}\n`);
      const handleSignal = async (signal) => {
        process.stdout.write(`ui shutdown (${signal})\n`);
        await ui.close();
        process.exit(0);
      };
      process.once('SIGINT', () => {
        void handleSignal('SIGINT');
      });
      process.once('SIGTERM', () => {
        void handleSignal('SIGTERM');
      });
    })
    .catch((error) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
