/**
 * @param {string} html
 */
function parseHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

/**
 * @param {ParentNode} root
 * @param {string} selector
 */
function replaceById(root, selector) {
  const incoming = root.querySelector(selector);
  const current = document.querySelector(selector);
  if (!incoming || !current) return;
  current.replaceWith(incoming);
}

/**
 * @param {string} html
 */
function applyUiResponse(html) {
  const fragment = parseHtml(html);
  replaceById(fragment, '#main');
  replaceById(fragment, '#conv');
  replaceById(fragment, '#exec');
  replaceById(fragment, '#artifacts');
  replaceById(fragment, '#run-status');
}

function readPollTarget() {
  const execEl = /** @type {HTMLElement|null} */ (document.getElementById('exec'));
  if (!execEl) return null;
  const path = execEl.getAttribute('hx-get');
  const trigger = execEl.getAttribute('hx-trigger') ?? '';
  if (!path || !trigger.startsWith('every ')) return null;
  const rawInterval = trigger.slice('every '.length).trim();
  const ms = rawInterval.endsWith('s')
    ? Number(rawInterval.slice(0, -1)) * 1000
    : rawInterval.endsWith('ms')
      ? Number(rawInterval.slice(0, -2))
      : Number(rawInterval);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { path, intervalMs: Math.floor(ms) };
}

async function pollLoop() {
  const status = document.getElementById('run-status');
  if (!status || status.getAttribute('data-state') !== 'running') return;

  const target = readPollTarget();
  if (!target) return;

  try {
    const response = await fetch(target.path, {
      headers: { 'HX-Request': 'true' }
    });
    if (!response.ok) return;
    const html = await response.text();
    applyUiResponse(html);
  } catch {
    return;
  }

  setTimeout(() => {
    void pollLoop();
  }, target.intervalMs);
}

async function handleCommandSubmit(event) {
  const form = /** @type {HTMLFormElement} */ (event.target);
  if (!form || (!form.matches('#command-form') && !form.matches('#resume-form'))) return;
  if (typeof window !== 'undefined' && typeof window['htmx'] !== 'undefined') return;

  event.preventDefault();
  const isCommand = form.matches('#command-form');
  const body = new URLSearchParams();
  if (isCommand) {
    for (const [key, value] of new FormData(form).entries()) {
      if (typeof value === 'string') {
        body.append(key, value);
      }
    }
  }
  const response = await fetch(isCommand ? '/ui/commands' : form.action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: isCommand ? body : undefined
  });
  const html = await response.text();
  applyUiResponse(html);
  void pollLoop();
}

document.addEventListener('submit', (event) => {
  void handleCommandSubmit(event);
});

document.addEventListener('DOMContentLoaded', () => {
  void pollLoop();
});

document.body.addEventListener('htmx:afterSwap', () => {
  void pollLoop();
});
