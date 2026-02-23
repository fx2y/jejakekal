import { badRequest } from './request-errors.mjs';
import { RUNS_COMPAT_WINDOW_END } from './contracts.mjs';

export const ALLOW_SOURCE_COMPAT_UNTIL = 'ALLOW_SOURCE_COMPAT_UNTIL';
export const JEJAKEKAL_COMPAT_TODAY = 'JEJAKEKAL_COMPAT_TODAY';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const telemetry = {
  count: 0,
  last_day: null,
  until: null
};

/**
 * @param {unknown} value
 * @param {string} field
 */
function assertDateYmd(value, field) {
  if (typeof value !== 'string' || !YMD_RE.test(value)) {
    throw badRequest('invalid_run_payload', { field });
  }
  return value;
}

/**
 * @param {string} nowDay
 * @param {string} compatUntil
 */
export function assertSourceCompatAllowed(nowDay, compatUntil) {
  if (nowDay > compatUntil) {
    throw badRequest('source_compat_expired', { until: compatUntil });
  }
}

export function resolveSourceCompatUntil() {
  const raw = process.env[ALLOW_SOURCE_COMPAT_UNTIL] ?? RUNS_COMPAT_WINDOW_END;
  return assertDateYmd(raw, ALLOW_SOURCE_COMPAT_UNTIL);
}

export function resolveCompatToday() {
  const injected = process.env[JEJAKEKAL_COMPAT_TODAY];
  if (typeof injected === 'string') {
    return assertDateYmd(injected, JEJAKEKAL_COMPAT_TODAY);
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * @param {{today:string, until:string}} params
 */
export function recordSourceCompatUsage(params) {
  telemetry.count += 1;
  telemetry.last_day = params.today;
  telemetry.until = params.until;
  process.stderr.write(
    `[telemetry] source_compat_used today=${params.today} until=${params.until}\n`
  );
}

export function getSourceCompatTelemetry() {
  return {
    count: telemetry.count,
    last_day: telemetry.last_day,
    until: telemetry.until
  };
}

export function resetSourceCompatTelemetryForTest() {
  telemetry.count = 0;
  telemetry.last_day = null;
  telemetry.until = null;
}
