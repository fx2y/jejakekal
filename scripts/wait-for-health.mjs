const url = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? '10000');
const intervalMs = Number(process.argv[4] ?? '100');

if (!url) {
  process.stderr.write('usage: node scripts/wait-for-health.mjs <url> [timeoutMs] [intervalMs]\n');
  process.exit(2);
}

if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(intervalMs) || intervalMs < 1) {
  process.stderr.write('timeoutMs and intervalMs must be positive numbers\n');
  process.exit(2);
}

const started = Date.now();
let lastError = '';
while (Date.now() - started < timeoutMs) {
  try {
    const res = await fetch(url);
    if (res.ok) {
      const payload = await res.text();
      process.stdout.write(payload.length > 0 ? `${payload}\n` : '\n');
      process.exit(0);
    }
    lastError = `status=${res.status}`;
  } catch (error) {
    lastError = String(error instanceof Error ? error.message : error);
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

process.stderr.write(`timed out waiting for health: ${url}; last=${lastError}\n`);
process.exit(1);

