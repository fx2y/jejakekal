import { normalizeOcrPageIn, normalizeOcrPageOut } from './contract.mjs';

const OCR_PROMPT = 'Text Recognition:';
const OCR_RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class OcrEndpointUnreachableError extends Error {
  constructor() {
    super('ocr_endpoint_unreachable');
    this.name = 'OcrEndpointUnreachableError';
  }
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {unknown} value
 */
function isAbortTimeoutError(value) {
  return value instanceof DOMException && value.name === 'TimeoutError';
}

/**
 * @param {unknown} value
 */
function isTransientFetchError(value) {
  if (!value || typeof value !== 'object') return false;
  const err = /** @type {{name?:unknown,code?:unknown,cause?:unknown,message?:unknown}} */ (value);
  if (typeof err.name === 'string' && err.name === 'AbortError') return true;
  if (isAbortTimeoutError(value)) return true;
  const directCode = typeof err.code === 'string' ? err.code : '';
  const causeCode =
    err.cause && typeof err.cause === 'object' && typeof /** @type {{code?:unknown}} */ (err.cause).code === 'string'
      ? /** @type {{code:string}} */ (err.cause).code
      : '';
  const code = directCode || causeCode;
  if (
    typeof err.message === 'string' &&
    err.message.includes('fetch failed') &&
    code === 'ECONNREFUSED'
  ) {
    return true;
  }
  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETUNREACH',
    'ECONNREFUSED',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET'
  ].includes(code);
}

/**
 * @param {unknown} raw
 */
function extractTextMarkdown(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const top = /** @type {Record<string, unknown>} */ (raw);
  const choices = Array.isArray(top.choices) ? top.choices : [];
  const first = choices[0];
  if (!first || typeof first !== 'object') return '';
  const message = /** @type {Record<string, unknown>} */ (first).message;
  if (!message || typeof message !== 'object') return '';
  const content = /** @type {Record<string, unknown>} */ (message).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const row = /** @type {Record<string, unknown>} */ (part);
      if (typeof row.text === 'string') return row.text;
      return '';
    })
    .join('\n')
    .trim();
}

/**
 * @param {{status:number,message:string,retryable:boolean}} input
 */
function makeHttpError(input) {
  const err = /** @type {Error & {code?:string,httpStatus?:number}} */ (new Error(input.message));
  err.code = input.retryable ? 'ocr_http_retryable' : 'ocr_http_fatal';
  err.httpStatus = input.status;
  return err;
}

/**
 * @param {string} baseUrl
 */
function toChatCompletionsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
}

/**
 * @param {{
 *   ocrPolicy?: Record<string, unknown>,
 *   ocrInput: import('./contract.mjs').OCRPageIn,
 *   fetchImpl?: typeof fetch
 * }} params
 */
export async function callOcrVllm(params) {
  const policy = params.ocrPolicy ?? {};
  const engine = String(policy.engine ?? 'vllm').trim().toLowerCase();
  if (engine !== 'vllm') {
    throw new Error('invalid_ocr_engine');
  }
  const model = String(policy.model ?? '').trim();
  const baseUrl = String(policy.baseUrl ?? '').trim();
  const timeoutMs = Number(policy.timeoutMs ?? 120000);
  if (!model) throw new Error('invalid_ocr_policy_model');
  if (!baseUrl) throw new Error('invalid_ocr_policy_base_url');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error('invalid_ocr_policy_timeout_ms');
  }

  const endpoint = toChatCompletionsUrl(baseUrl);
  const body = {
    model,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: params.ocrInput.image_uri } },
          { type: 'text', text: params.ocrInput.prompt }
        ]
      }
    ]
  };
  const fetchImpl = params.fetchImpl ?? fetch;

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        const retryable = OCR_RETRYABLE_STATUS.has(response.status);
        if (!retryable) {
          throw makeHttpError({
            status: response.status,
            retryable: false,
            message: `ocr_http_${response.status}`
          });
        }
        throw makeHttpError({
          status: response.status,
          retryable: true,
          message: `ocr_http_${response.status}`
        });
      }
      const raw = await response.json();
      return normalizeOcrPageOut({
        text_md: extractTextMarkdown(raw),
        tables: [],
        confidence: null,
        engine_meta: { engine: 'vllm', model, endpoint },
        raw
      });
    } catch (error) {
      const e = /** @type {{code?:unknown,message?:unknown}} */ (error);
      const retryable = isTransientFetchError(error) || e.code === 'ocr_http_retryable';
      if (!retryable || attempt >= 3) {
        if (retryable) {
          throw new OcrEndpointUnreachableError();
        }
        throw error;
      }
      lastError = error;
      await sleep(100 * attempt);
    }
  }
  if (lastError && (isTransientFetchError(lastError) || /** @type {{code?:unknown}} */ (lastError).code === 'ocr_http_retryable')) {
    throw new OcrEndpointUnreachableError();
  }
  throw lastError ?? new Error('ocr_http_failed');
}

/**
 * @param {{
 *   pages:Array<{page_idx:number,doc_id?:string,ver?:number,png_uri?:string|null,png?:Buffer|null,png_sha?:string|null,mime?:string|null,prompt?:string}>,
 *   ocrPolicy?: Record<string, unknown>,
 *   fetchImpl?: typeof fetch
 * }} params
 */
export async function runOcrEngineSeam(params) {
  /** @type {Array<{page_idx:number,text_md:string,tables?:unknown[],confidence?:number|null,engine_meta:Record<string,unknown>,raw:unknown}>} */
  const patches = [];
  for (const row of params.pages ?? []) {
    const pageIn = normalizeOcrPageIn({
      doc_id: row?.doc_id,
      ver: row?.ver,
      page_idx: row?.page_idx,
      image_uri: row?.png_uri,
      prompt: row.prompt ?? OCR_PROMPT
    });
    const out = await callOcrVllm({
      ocrPolicy: params.ocrPolicy,
      ocrInput: pageIn,
      fetchImpl: params.fetchImpl
    });
    patches.push({
      page_idx: pageIn.page_idx,
      text_md: out.text_md,
      tables: out.tables,
      confidence: out.confidence ?? null,
      engine_meta: out.engine_meta,
      raw: out.raw
    });
  }
  return { patches };
}
