// Plays Figma's main thread for the panel: answers its messages with the
// fixture graph, keeps "clientStorage" in localStorage, and draws a tiny
// canvas so Show on canvas and Pin findings are visible.
//
// URL parameters (all optional) set up a moment for screenshots:
//   theme=light|dark  token=none|mock|expired  study=<mock study id>
//   queuedAgo=<minutes>  history=1  draft=1  selection=<node id>  doc=empty
//   fresh=1 (ignore stored values)
const params = new URLSearchParams(location.search);
const config = await (await fetch('/config.json')).json();
let doc = await (await fetch('/doc.json')).json();
if (params.get('doc') === 'empty') doc = { ...doc, frames: [], hotspots: [], flowStarts: [], destinations: {} };

const iframe = document.getElementById('plugin-frame');
const logEl = document.getElementById('log');
const themeSel = document.getElementById('theme');
const fresh = params.get('fresh') === '1';
const PREFIX = `archetype-harness:${config.mode}:`;
const mem = new Map();
const storage = {
  get: (k) => {
    if (fresh) return mem.get(k);
    const v = localStorage.getItem(PREFIX + k);
    return v === null ? undefined : JSON.parse(v);
  },
  set: (k, v) => (fresh ? mem.set(k, v) : localStorage.setItem(PREFIX + k, JSON.stringify(v))),
  del: (k) => (fresh ? mem.delete(k) : localStorage.removeItem(PREFIX + k)),
};

document.getElementById('mode').textContent = config.mode === 'live' ? `live: ${config.backend}${config.proxy ? ' (proxy)' : ''}` : 'mock backend';
document.getElementById('mode').classList.toggle('live', config.mode === 'live');
document.getElementById('page-name').textContent = `${doc.fileName} / ${doc.pageName}`;
document.getElementById('reset').onclick = () => {
  for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  location.reload();
};

const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
themeSel.value = theme;
document.documentElement.classList.toggle('dark', theme === 'dark');
themeSel.onchange = () => {
  params.set('theme', themeSel.value);
  location.search = params.toString();
};
iframe.src = `/ui.html?theme=${theme}`;

function log(kind, text) {
  const li = document.createElement('li');
  li.innerHTML = `<b>${kind}</b> ${String(text).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}`;
  logEl.prepend(li);
}

const post = (msg) => iframe.contentWindow.postMessage({ pluginMessage: msg }, '*');

// Canvas

const POS = {};
let selection = params.get('selection');
const pins = new Map();
function layout() {
  const order = doc.frames.map((f) => f.id);
  order.forEach((id, i) => (POS[id] = { x: (i % 4) * 210, y: Math.floor(i / 4) * 340 + 10 }));
}
function drawCanvas() {
  layout();
  const host = document.getElementById('frames');
  host.innerHTML = '';
  for (const f of doc.frames) {
    const el = document.createElement('div');
    el.className = `frame${selection === f.id ? ' selected' : ''}`;
    el.style.left = `${POS[f.id].x}px`;
    el.style.top = `${POS[f.id].y + 20}px`;
    el.dataset.id = f.id;
    const hs = doc.hotspots.filter((h) => h.frameId === f.id).map((h) => `<div class="hs">${h.name}</div>`).join('');
    el.innerHTML = `<div class="frame-name">${f.name}</div><div class="frame-box">${hs}</div>`;
    const pin = pins.get(f.id);
    if (pin) el.insertAdjacentHTML('beforeend', `<div class="pin">${pin.replace(/</g, '&lt;')}</div>`);
    el.onclick = () => {
      selection = f.id;
      drawCanvas();
      post({ type: 'selection', selection: { id: f.id, name: f.name } });
    };
    host.appendChild(el);
  }
  const svg = document.getElementById('edges');
  const lines = [];
  for (const h of doc.hotspots) {
    for (const a of h.actions) {
      const to = a.kind === 'node' ? doc.destinations[a.destinationId]?.frameId : null;
      if (!to || !POS[to] || !POS[h.frameId] || to === h.frameId) continue;
      const p = POS[h.frameId];
      const q = POS[to];
      const x1 = p.x + 190;
      const y1 = p.y + 150 + (lines.length % 5) * 8;
      const x2 = q.x + 40;
      const y2 = q.y + 150;
      lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0d99ff" stroke-opacity=".35" stroke-width="1.5" marker-end="url(#arrow)"/>`);
    }
  }
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#0d99ff" fill-opacity=".6"/></marker></defs>${lines.join('')}`;
}
drawCanvas();

// Storage keys mirror src/main/storage.ts

const K = { settings: 'settings', token: 'token', studies: 'studies', last: 'last', draft: 'draft' };

function initPayload() {
  const now = Date.now();
  const tokenParam = params.get('token');
  let token = storage.get(K.token) ?? config.token ?? null;
  if (tokenParam === 'none') token = null;
  else if (tokenParam === 'mock') token = 'mock-token';
  else if (tokenParam === 'expired') token = 'expired';
  let studies = storage.get(K.studies) ?? [];
  let lastStudyId = storage.get(K.last) ?? null;
  const study = params.get('study');
  const startFrame = doc.frames.find((f) => f.id === doc.flowStarts[0]?.nodeId) ?? doc.frames[0];
  const goalFrame = doc.frames.find((f) => f.id === '2:50') ?? doc.frames[1];
  const base = { startName: startFrame?.name ?? 'Start', goalName: goalFrame?.name ?? 'Goal', size: 'quick', status: 'running', outcome: null };
  if (params.get('history') === '1') {
    studies = [
      { ...base, studyId: 'study-done', title: 'Connect a business bank account so invoices can be paid by bank transfer', launchedAt: now - 26 * 3600e3, status: 'complete', outcome: '6 of 15 reached the goal' },
      { ...base, studyId: 'study-running', title: 'Find where to change the payout account', startName: 'Billing settings', goalName: 'Verify phone', launchedAt: now - 12 * 60e3 },
      { ...base, studyId: 'study-fail', title: 'Upgrade to the annual plan', startName: 'Dashboard', goalName: 'Plans', launchedAt: now - 9 * 86400e3, status: 'failed', size: 'thorough' },
    ];
  }
  if (study) {
    const rec = studies.find((s) => s.studyId === study) ?? { ...base, studyId: study, title: 'Connect a business bank account so invoices can be paid by bank transfer', launchedAt: now - Number(params.get('queuedAgo') ?? 0) * 60e3 };
    rec.launchedAt = now - Number(params.get('queuedAgo') ?? 0) * 60e3 || rec.launchedAt;
    studies = [rec, ...studies.filter((s) => s.studyId !== study)];
    lastStudyId = study;
  }
  const draft =
    params.get('draft') === '1'
      ? {
          goal: 'Connect a business bank account so invoices can be paid by bank transfer',
          who: 'Founders of 2 to 10 person B2B SaaS teams who do their own bookkeeping and have no finance hire.',
          product: 'Invoicing for small B2B teams',
          link: 'https://www.figma.com/design/AbCdEfGh1234567890XyZ/Farside-billing?node-id=0-1',
          size: 'quick',
        }
      : storage.get(K.draft) ?? null;
  // Seed storage so later save-study echoes keep the preset list, as Figma's
  // clientStorage would.
  storage.set(K.studies, studies);
  if (lastStudyId) storage.set(K.last, lastStudyId);
  const settings = storage.get(K.settings) ?? { apiBase: config.apiBase, webBase: config.webBase };
  const sel = selection ? doc.frames.find((f) => f.id === selection) : null;
  return { type: 'init', settings, token, fileKey: null, doc, selection: sel ? { id: sel.id, name: sel.name } : null, studies, lastStudyId, draft, pluginVersion: 'harness' };
}

window.addEventListener('message', (event) => {
  if (event.source !== iframe.contentWindow) return;
  const msg = event.data && event.data.pluginMessage;
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'ready':
      log('ready', 'panel loaded');
      post(initPayload());
      break;
    case 'resize': {
      const w = Math.min(900, Math.max(320, Math.round(msg.width)));
      const h = Math.min(1200, Math.max(420, Math.round(msg.height)));
      iframe.style.width = `${w}px`;
      iframe.style.height = `${h}px`;
      break;
    }
    case 'refresh':
      log('refresh', 'page re-read');
      post({ type: 'doc', doc });
      post({ type: 'selection', selection: selection ? { id: selection, name: doc.frames.find((f) => f.id === selection)?.name ?? selection } : null });
      break;
    case 'save-settings':
      storage.set(K.settings, msg.settings);
      log('settings', JSON.stringify(msg.settings));
      break;
    case 'save-token':
      if (msg.token) storage.set(K.token, msg.token);
      else storage.del(K.token);
      log('token', msg.token ? 'stored' : 'cleared');
      break;
    case 'save-study': {
      const list = [msg.record, ...(storage.get(K.studies) ?? []).filter((s) => s.studyId !== msg.record.studyId)].slice(0, 20);
      storage.set(K.studies, list);
      storage.set(K.last, msg.record.studyId);
      post({ type: 'studies', studies: list, lastStudyId: msg.record.studyId });
      break;
    }
    case 'forget-last':
      storage.del(K.last);
      break;
    case 'save-draft':
      storage.set(K.draft, msg.draft);
      break;
    case 'open-url':
      log('openExternal', msg.url);
      if (config.mode === 'live') window.open(msg.url, '_blank', 'noopener');
      break;
    case 'show-node': {
      const f = doc.frames.find((x) => x.id === msg.nodeId) ?? doc.frames.find((x) => doc.hotspots.some((h) => h.id === msg.nodeId && h.frameId === x.id));
      if (!f) {
        post({ type: 'show-result', ok: false, message: 'That frame is no longer in this file.' });
        break;
      }
      selection = f.id;
      drawCanvas();
      const el = document.querySelector(`.frame[data-id="${f.id}"]`);
      el?.classList.add('focus');
      el?.scrollIntoView({ block: 'center', inline: 'center' });
      log('show', `${f.name} (${msg.nodeId})`);
      post({ type: 'show-result', ok: true, message: null });
      break;
    }
    case 'pin': {
      let count = 0;
      for (const p of msg.pins) {
        if (doc.frames.some((f) => f.id === p.frameId)) {
          pins.set(p.frameId, p.label);
          count++;
        }
      }
      drawCanvas();
      log('pin', `${count} annotation(s)`);
      post({ type: 'pin-result', ok: count > 0, count, message: count ? `Pinned findings on ${count} frame${count === 1 ? '' : 's'}.` : 'None of the frames with findings are on this file any more.' });
      break;
    }
    case 'clear-pins': {
      const count = pins.size;
      pins.clear();
      drawCanvas();
      post({ type: 'pin-result', ok: true, count, message: count ? `Cleared pins from ${count} frame${count === 1 ? '' : 's'}.` : 'No Archetype pins on this page.' });
      break;
    }
    case 'notify':
      log('notify', msg.text);
      break;
    default:
      log('unknown', JSON.stringify(msg));
  }
});
