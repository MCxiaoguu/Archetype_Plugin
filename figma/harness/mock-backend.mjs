// A fake Archetype backend for the harness: the studies, runs, report and
// device flow routes the panel uses, answered from the fixtures. Preset study
// ids freeze one moment each (for screenshots); studies the panel creates
// play out in about 20 s. The trace routes (claim, turn, abort, runs, next wave)
// follow the backend as built, with a scripted brain; `serveMock` serves
// it all over HTTP on 127.0.0.1.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPORT = JSON.parse(readFileSync(join(here, 'fixtures/study-report.json'), 'utf8'));
const PROTO = 'https://www.figma.com/proto/AbCdEfGh1234567890XyZ/Farside-billing';
const at = (dash) => `${PROTO}?node-id=${dash}&starting-point-node-id=1%3A2&scaling=scale-down`;
// unref: a long fake wait (the persona build that never ends) must not keep the process alive.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());
const iso = (t = Date.now()) => new Date(t).toISOString();

const ARCHETYPES = REPORT.archetypes.map((a) => ({ archetypeId: a.archetypeId, archetypeName: a.name, role: a.role }));

function runRow(a, i, status, extra = {}) {
  const done = ['completed', 'abandoned', 'failed', 'aborted'].includes(status);
  const report = REPORT.runs.find((r) => r.archetypeId === a.archetypeId);
  return {
    runId: `run-${a.archetypeId.slice(0, 8)}-${i}`,
    archetypeId: a.archetypeId,
    archetypeName: a.archetypeName,
    role: a.role,
    wave: 1,
    repeatIndex: 0,
    status,
    metrics: done || status === 'running' ? { steps: extra.steps ?? report?.steps ?? 3, frustrationScore: report?.frustrationScore ?? 0 } : null,
    outcome: done ? { completed: status === 'completed', quitReason: status === 'completed' ? null : report?.quitReason ?? 'frustration', abandonedAtStep: null } : null,
    lastStep: extra.lastUrl ? { seq: extra.steps ?? 1, url: extra.lastUrl } : null,
  };
}

const PRESETS = {
  'study-running': {
    status: 'running',
    title: 'Connect a business bank account so invoices can be paid by bank transfer',
    runs: () => [
      runRow(ARCHETYPES[0], 0, 'completed', { steps: 4 }),
      runRow(ARCHETYPES[1], 0, 'abandoned', { steps: 3 }),
      runRow(ARCHETYPES[2], 0, 'running', { steps: 2, lastUrl: at('2-20') }),
      runRow(ARCHETYPES[3], 0, 'running', { steps: 3, lastUrl: at('2-30') }),
      runRow(ARCHETYPES[4], 0, 'running', { steps: 1 }),
      runRow(ARCHETYPES[5], 0, 'queued'),
    ],
  },
  'study-queued': {
    status: 'running',
    title: 'Connect a business bank account so invoices can be paid by bank transfer',
    runs: () => ARCHETYPES.map((a, i) => runRow(a, i, 'queued')),
  },
  'study-done': { status: 'complete', title: REPORT.title, runs: () => ARCHETYPES.map((a, i) => runRow(a, i, i % 2 ? 'abandoned' : 'completed')) },
  'study-archetypes': { status: 'factors_ready', title: 'Connect a business bank account so invoices can be paid by bank transfer', runs: () => [], slowArchetypes: true },
  'study-fail': { status: 'draft', title: 'Connect a business bank account so invoices can be paid by bank transfer', runs: () => [], failFactors: true },
};

/**
 * `clock` is the trace runs' time (the turn deadline); `thinkingPolls` how
 * many polls of a new turn still see it thinking before the scripted brain
 * decides it.
 */
export function createMockBackend({ log = () => {}, clock = () => Date.now(), thinkingPolls = 0 } = {}) {
  const studies = new Map();
  const trace = createTraceRuns({ clock, thinkingPolls });
  let deviceSeq = 0;
  const devicePolls = new Map();
  let seq = 0;

  for (const [id, p] of Object.entries(PRESETS)) studies.set(id, { id, ...p, created: Date.now() });

  function simulated(s) {
    if (!s.runsAt) return { status: s.status, runs: s.runs ? s.runs() : [] };
    const t = (Date.now() - s.runsAt) / 1000;
    const runs = ARCHETYPES.map((a, i) => {
      const startAt = 3 + i * 1.5;
      const endAt = startAt + 5;
      if (t < startAt) return runRow(a, i, 'queued');
      if (t < endAt) return runRow(a, i, 'running', { steps: Math.max(1, Math.floor(t - startAt)), lastUrl: at(['1-2', '2-10', '2-20', '2-30'][Math.min(3, Math.floor(t - startAt))]) });
      return runRow(a, i, i === 1 || i === 5 ? 'abandoned' : 'completed');
    });
    const all = runs.every((r) => r.status !== 'queued' && r.status !== 'running');
    return { status: all ? 'complete' : 'running', runs };
  }

  function statusBody(s) {
    const { status, runs } = simulated(s);
    const byStatus = {};
    for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const terminal = runs.filter((r) => ['completed', 'abandoned', 'failed', 'aborted'].includes(r.status)).length;
    return {
      studyId: s.id,
      status,
      archetypeCount: ARCHETYPES.length,
      factorSpecReady: status !== 'draft',
      runs: { allTerminal: runs.length > 0 && terminal === runs.length, byStatus, terminal, total: runs.length },
      updatedAt: iso(),
    };
  }

  /** Returns [status, body] or null when the route is unknown. `request.bytes` is the body's size, which a turn needs. */
  async function handle(method, path, body, headers, request = {}) {
    if (path === '/api/oauth/device/code' && method === 'POST') {
      const device_code = `dev-${++deviceSeq}`;
      devicePolls.set(device_code, 0);
      return [200, { device_code, user_code: 'WDJB-MJHT', verification_uri: 'https://auth.example/activate', verification_uri_complete: 'https://auth.example/activate?user_code=WDJB-MJHT', expires_in: 600, interval: 2 }];
    }
    if (path === '/api/oauth/device/token' && method === 'POST') {
      const n = (devicePolls.get(body?.device_code) ?? 0) + 1;
      devicePolls.set(body?.device_code, n);
      // Auth0's status codes: 429 for slow_down, 403 while pending.
      if (n === 2) return [429, { error: 'slow_down', error_description: 'You are polling faster than allowed.' }];
      if (n < 4) return [403, { error: 'authorization_pending', error_description: 'waiting' }];
      return [200, { access_token: 'mock-token', token_type: 'Bearer', expires_in: 86400 }];
    }
    if (!path.startsWith('/api/')) return null;
    if (!/^Bearer \S+/.test(headers.authorization ?? '')) return [401, { error: 'Authorization header missing', message: 'Sign in first.' }];
    if (headers.authorization === 'Bearer expired') return [401, { error: 'Invalid token', message: 'Token expired.' }];

    const traced = trace.handle(method, path, body, request);
    if (traced) return traced;

    if (path === '/api/studies' && method === 'POST') {
      const id = `mock${String(++seq).padStart(4, '0')}${Date.now().toString(16)}`;
      const s = { id, status: 'draft', title: body?.title ?? 'Untitled', created: Date.now(), body };
      studies.set(id, s);
      log(`created study ${id}: ${JSON.stringify(body)}`);
      return [201, { studyId: id, title: s.title, status: 'draft', createdAt: iso(), updatedAt: iso(), ...body }];
    }
    const m = /^\/api\/studies\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      const s = studies.get(m[1]);
      if (!s) return [404, { error: 'study_not_found', message: `No study ${m[1]} for this user.` }];
      const sub = m[2] ?? '';
      if (sub === '/factors' && method === 'POST') {
        if (s.failFactors) return [500, { error: 'internal_error', message: 'An unexpected server error occurred while identifying factors. Safe to retry.', request_id: 'req-7f3a' }];
        await sleep(900);
        if (s.status === 'draft') s.status = 'factors_ready';
        return [200, { studyId: s.id, status: s.status, generated: true, factorSpec: { factors: REPORT.factors } }];
      }
      if (sub === '/archetypes' && method === 'POST') {
        await sleep(s.slowArchetypes ? 600_000 : 2500);
        s.status = 'archetypes_ready';
        return [200, { studyId: s.id, status: s.status, generated: true, archetypes: ARCHETYPES }];
      }
      if (sub === '/runs' && method === 'POST') {
        if (!s.runsAt) s.runsAt = Date.now();
        s.status = 'running';
        return [201, { created: true, studyId: s.id, wave: 1, repeatPolicy: 'explore', runs: simulated(s).runs }];
      }
      if (sub === '/status' && method === 'GET') return [200, statusBody(s)];
      if (sub === '/runs' && method === 'GET') {
        const { status, runs } = simulated(s);
        return [200, { studyId: s.id, status, currentWave: 1, runs }];
      }
      if (sub === '/report' && method === 'GET') return [200, { ...REPORT, studyId: s.id, title: s.title, cached: false }];
      if (sub === '' && method === 'GET') return [200, { studyId: s.id, title: s.title, status: simulated(s).status }];
    }
    return [404, { error: 'not_found', message: `${method} ${path} is not part of the mock.` }];
  }

  return { handle, studies, trace };
}

// ── Trace runs: the runs a plugin-mode study's panel drives ─────────────────
// A port of the backend as built: services/trace_turn_service.py (turn body
// validation, ordering, owners, the deadline, aborts), trace_decide.py's
// check of the brain's action, plugin_run_service.claim_run and
// study_run_service.next_wave. The brain is a script per run: each turn's
// step names what to do by an element's label, as a persona reads it.

const TURN_DEADLINE_S = 150;
const MAX_SCREENSHOT_BYTES = 1536 * 1024;
const MAX_SCREENSHOT_B64 = 4 * Math.ceil(MAX_SCREENSHOT_BYTES / 3);
const MAX_ELEMENTS = 80;
const MAX_DETAIL = 500;
const MAX_OVERLAYS = 20;
/** A whole turn body: the screenshot's base64 (2 MB at most) and the rest of the screen. */
const MAX_TURN_BODY_BYTES = 3 * 1024 * 1024;
/** What a step stores (run_protocol.MAX_TEXT), and an element's label. */
const MAX_EXCERPT = 300;
const MAX_TITLE = 300;
const MAX_LABEL = 300;
const MAX_TURN = 10_000;
const ELEMENT_ID = /^e[0-9]+$/;
const NODE_ID = /^I?[0-9]+:[0-9]+(;[0-9]+:[0-9]+)*$/;
const TURN_FIELDS = ['owner', 'turn', 'screen', 'screenshot_b64', 'elements', 'visible_text_excerpt', 'last', 'flags',
  'flag_details', 'elapsed_s', 'client_ts'];
const ELEMENT_ROLES = ['button', 'link', 'text', 'card', 'input', 'icon', 'image'];
const ACTION_TYPES = ['click', 'hover', 'drag', 'press_key', 'scroll', 'wait', 'back', 'type', 'give_up', 'done'];
const OUTCOMES = [
  'navigated', 'swapped', 'opened_overlay', 'closed_overlay', 'changed_state', 'scrolled', 'timers_fired',
  'nothing_happened', 'scroll_at_end', 'back_empty', 'waited', 'typed_nothing', 'left_prototype', 'unsupported',
];
const FLAGS = ['file_changed', 'timer_loop', 'missing_font'];
const FLAG_DETAILS = { timer_loop: 'frames', missing_font: 'fonts' };
const MAX_FLAG_DETAILS = 50;
const TIMER_EFFECTS = ['left_prototype', 'unsupported'];
const MAX_TIMER_EFFECTS = 10;
const MAX_ENGINE_DETAIL = 200;
const NAMED_KEYS = ['Backspace', 'Tab', 'Enter', 'Return', 'Shift', 'Control', 'Ctrl', 'Alt', 'Option', 'Meta', 'Cmd',
  'Command', 'Pause', 'CapsLock', 'Escape', 'Esc', ' ', 'Space', 'Spacebar', 'PageUp', 'PageDown',
  'End', 'Home', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Left', 'Up', 'Right', 'Down',
  'Insert', 'Delete', 'Del', ';', '=', ',', '-', '.', '/', '`', '[', '\\', ']', "'"];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const KEY_NAMES = new Set([...NAMED_KEYS, ...LETTERS, ...LETTERS.toUpperCase(), ...'0123456789', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
const KEY_MODIFIERS = new Set(['Shift', 'Control', 'Ctrl', 'Alt', 'Option', 'Meta', 'Cmd', 'Command']);
/** The decider's own abort when it crashes on a turn: backend-only, as finalize_failed is. */
const DECIDER_ERROR = 'decider_error';
const PANEL_ABORT_CODES = ['render_failed', 'turn_timeout', 'panel_state_lost', 'file_changed',
  'brain_invalid_action', 'model_unavailable', 'debrief_invalid', 'engine_error'];
const TERMINAL = new Set(['completed', 'failed', 'abandoned', 'aborted']);
const BROWSER_ENGINES = ['playwright', 'chrome', 'figma-trace'];
const BROWSER_PROFILES = ['isolated', 'real'];
const OWNER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ELEMENT_ACTIONS = new Set(['click', 'hover', 'drag', 'type']);
const FINAL_ACTIONS = { give_up: 'abandoned', done: 'completed' };

/** An answer the routes give as an error: the backend's slug, message and status. */
class Refused extends Error {
  constructor(status, slug, message, extra = {}) {
    super(message);
    this.status = status;
    this.slug = slug;
    this.extra = extra;
  }
}
const badRequest = (message) => new Refused(400, 'bad_request', message);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isText = (v) => typeof v === 'string';
const repr = (v) => JSON.stringify(v) ?? String(v);
/** A string's length as Python counts it: code points, not UTF-16 units. */
const chars = (s) => [...s].length;
/** Python's == on JSON values: the same keys and values, in any order. */
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));
const sameJson = (a, b) => stable(a) === stable(b);

function isKeyName(key) {
  if (!isText(key) || !key) return false;
  const parts = key.length > 1 && key.includes('+') ? key.split('+') : [key];
  const last = parts.pop();
  return parts.every((m) => KEY_MODIFIERS.has(m)) && KEY_NAMES.has(last);
}

function cleanScreen(screen) {
  if (!isObject(screen)) throw badRequest('screen is required: {url, title?, frameId, overlays?, viewport, scroll?}.');
  for (const [key, what] of [['url', 'the step URL of this screen'], ['frameId', 'the id of the frame showing']]) {
    if (!isText(screen[key]) || !screen[key].trim()) throw badRequest(`screen.${key} is required: ${what}.`);
  }
  const viewport = screen.viewport;
  if (!(Array.isArray(viewport) && viewport.length === 2 && viewport.every((v) => isNumber(v) && v > 0))) {
    throw badRequest(`screen.viewport is required: [width, height] in pixels (got ${repr(viewport)}).`);
  }
  const title = screen.title;
  if (title !== null && title !== undefined && !(isText(title) && chars(title) <= MAX_TITLE)) {
    throw badRequest(`screen.title must be a string of at most ${MAX_TITLE} characters, the frame's name.`);
  }
  const overlays = screen.overlays;
  if (overlays !== null && overlays !== undefined && !(Array.isArray(overlays) && overlays.length <= MAX_OVERLAYS && overlays.every((o) => isText(o) && NODE_ID.test(o)))) {
    throw badRequest(`screen.overlays must be a list of at most ${MAX_OVERLAYS} frame ids like 3:1, the overlays open, bottom first (got ${repr(overlays)}).`);
  }
  const scroll = screen.scroll;
  const scrollKeys = isObject(scroll) ? Object.keys(scroll).sort().join(',') : null;
  if (scroll !== null && scroll !== undefined && !(scrollKeys === 'maxX,maxY,x,y' && Object.values(scroll).every((v) => isNumber(v) && v >= 0))) {
    throw badRequest(`screen.scroll must be {x, y, maxX, maxY}, each a number of pixels from 0 (got ${repr(scroll)}).`);
  }
}

function cleanScreenshot(shot) {
  if (!isText(shot) || !shot) throw badRequest('screenshot_b64 is required: the screen as a base64 JPEG.');
  if (shot.length > MAX_SCREENSHOT_B64) throw badRequest('screenshot_b64 is over 1.5 MB. Export the screen at a lower quality.');
  // Python's b64decode(validate=True): only the alphabet, with correct padding.
  if (shot.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(shot)) throw badRequest('screenshot_b64 is not valid base64.');
  return shot;
}

function cleanElements(elements) {
  if (!Array.isArray(elements)) throw badRequest('elements is required: a list of {id, label, role, box}.');
  if (elements.length > MAX_ELEMENTS) throw badRequest(`elements has ${elements.length} items; at most ${MAX_ELEMENTS}.`);
  const seen = new Set();
  elements.forEach((element, i) => {
    const where = `elements[${i}]`;
    if (!isObject(element)) throw badRequest(`${where} must be an object {id, label, role, box}.`);
    if (!isText(element.id) || !ELEMENT_ID.test(element.id)) throw badRequest(`${where}.id must look like e4 (got ${repr(element.id)}).`);
    if (seen.has(element.id)) throw badRequest(`${where}.id ${element.id} is listed twice; element ids are unique in a turn.`);
    seen.add(element.id);
    if (!isText(element.label) || chars(element.label) > MAX_LABEL) throw badRequest(`${where}.label must be a string of at most ${MAX_LABEL} characters.`);
    if (!ELEMENT_ROLES.includes(element.role)) throw badRequest(`${where}.role must be one of ${ELEMENT_ROLES.join(', ')} (got ${repr(element.role)}).`);
    const box = element.box;
    if (!(Array.isArray(box) && box.length === 4 && box.every(isNumber))) {
      throw badRequest(`${where}.box must be [x, y, width, height] in viewport pixels (got ${repr(box)}).`);
    }
  });
}

function cleanLast(last, n) {
  if (n === 1) {
    if (last !== null && last !== undefined) throw badRequest('last must be null on turn 1: no action came before it.');
    return;
  }
  if (!isObject(last)) throw badRequest(`last is required on turn ${n}: {action, outcome, target?} of the action turn ${n - 1} chose.`);
  if (!isObject(last.action)) throw badRequest(`last.action is required: the action turn ${n - 1} chose.`);
  if (!ACTION_TYPES.includes(last.action.type)) throw badRequest(`last.action.type must be one of ${ACTION_TYPES.join(', ')} (got ${repr(last.action.type)}).`);
  if (!OUTCOMES.includes(last.outcome)) throw badRequest(`last.outcome must be one of ${OUTCOMES.join(', ')} (got ${repr(last.outcome)}).`);
  if (last.target !== null && last.target !== undefined && !isText(last.target)) {
    throw badRequest('last.target must be a string, the element\'s label and id, such as "Continue (e4)".');
  }
  const unsupported = last.unsupported;
  if (last.outcome === 'unsupported') {
    if (!isText(unsupported) || !unsupported.trim()) throw badRequest('last.unsupported is required with the unsupported outcome: what did nothing, such as UPDATE_MEDIA_RUNTIME.');
    if (chars(unsupported) > MAX_ENGINE_DETAIL) throw badRequest(`last.unsupported is at most ${MAX_ENGINE_DETAIL} characters (got ${chars(unsupported)}).`);
  } else if (unsupported !== null && unsupported !== undefined) {
    throw badRequest('last.unsupported is only allowed with the unsupported outcome.');
  }
  const effects = last.timer_effects;
  if (effects === null || effects === undefined) return;
  if (!Array.isArray(effects) || effects.length > MAX_TIMER_EFFECTS) throw badRequest(`last.timer_effects must be a list of at most ${MAX_TIMER_EFFECTS} {type, detail}.`);
  effects.forEach((effect, i) => {
    const where = `last.timer_effects[${i}]`;
    if (!isObject(effect)) throw badRequest(`${where} must be an object {type, detail}.`);
    if (!TIMER_EFFECTS.includes(effect.type)) throw badRequest(`${where}.type must be one of ${TIMER_EFFECTS.join(', ')} (got ${repr(effect.type)}).`);
    if (!isText(effect.detail) || !effect.detail.trim() || chars(effect.detail) > MAX_ENGINE_DETAIL) throw badRequest(`${where}.detail must be 1 to ${MAX_ENGINE_DETAIL} characters.`);
  });
}

function cleanFlagDetails(details, flags) {
  if (details === null || details === undefined) return;
  if (!isObject(details)) throw badRequest('flag_details must be an object {timer_loop?: {frames}, missing_font?: {fonts}}.');
  for (const [flag, value] of Object.entries(details)) {
    const field = FLAG_DETAILS[flag];
    if (!field) throw badRequest(`flag_details.${flag} is not allowed: only ${Object.keys(FLAG_DETAILS).join(', ')} carry details.`);
    if (!flags.includes(flag)) throw badRequest(`flag_details.${flag} needs the ${flag} flag in flags.`);
    const items = isObject(value) ? value[field] : null;
    if (!(Array.isArray(items) && items.length > 0 && items.length <= MAX_FLAG_DETAILS && items.every((i) => isText(i) && i.trim() && chars(i) <= 200))) {
      throw badRequest(`flag_details.${flag}.${field} must be a list of 1 to ${MAX_FLAG_DETAILS} names.`);
    }
  }
}

/** The backend's _clean_turn: returns {n, owner, observation, shot}, or throws a 400. */
export function cleanTurn(body) {
  if (!isObject(body)) throw badRequest('The body must be a JSON object {owner, turn, screen, screenshot_b64, elements, last, flags}.');
  const unknown = Object.keys(body).filter((k) => !TURN_FIELDS.includes(k)).sort();
  if (unknown.length) throw badRequest(`${unknown[0]} is not a turn field: a turn has ${TURN_FIELDS.join(', ')}.`);
  const n = body.turn;
  if (!Number.isInteger(n) || n < 1 || n > MAX_TURN) throw badRequest(`turn must be a whole number from 1 to ${MAX_TURN} (got ${repr(n)}).`);
  if (!isText(body.owner) || !body.owner) throw badRequest('owner is required: the id this panel sent with its claim.');
  cleanScreen(body.screen);
  const shot = cleanScreenshot(body.screenshot_b64);
  cleanElements(body.elements);
  cleanLast(body.last, n);
  const flags = body.flags;
  if (!Array.isArray(flags) || flags.some((f) => !FLAGS.includes(f)) || new Set(flags).size !== flags.length) {
    throw badRequest(`flags must be a list drawn from ${FLAGS.join(', ')}, each at most once (got ${repr(flags)}).`);
  }
  cleanFlagDetails(body.flag_details, flags);
  const excerpt = body.visible_text_excerpt;
  if (excerpt !== null && excerpt !== undefined && !(isText(excerpt) && chars(excerpt) <= MAX_EXCERPT)) {
    throw badRequest(`visible_text_excerpt must be a string of at most ${MAX_EXCERPT} characters.`);
  }
  const { owner, turn, screenshot_b64, ...observation } = body;
  return { n, owner, observation, shot };
}

function cleanBrowser(raw) {
  if (!isObject(raw)) throw badRequest('browser must be an object {engine, version, headless, user_agent, viewport, profile}.');
  if (!BROWSER_ENGINES.includes(raw.engine)) throw badRequest(`browser.engine must be one of ${BROWSER_ENGINES.join(', ')}; got ${repr(raw.engine)}.`);
  if (raw.headless !== undefined && raw.headless !== null && typeof raw.headless !== 'boolean') throw badRequest('browser.headless must be true or false.');
  const viewport = raw.viewport;
  if (viewport !== undefined && viewport !== null) {
    const text = isText(viewport) && /^\s*\d{2,5}\s*[xX]\s*\d{2,5}\s*$/.test(viewport);
    const pair = Array.isArray(viewport) && viewport.length === 2 && viewport.every((v) => Number.isInteger(v));
    const sized = isObject(viewport) && Number.isInteger(viewport.width) && Number.isInteger(viewport.height);
    if (!text && !pair && !sized) throw badRequest('browser.viewport must be {width, height}, [width, height] or a string like 1280x900.');
  }
  const profile = raw.profile;
  if (profile !== undefined && profile !== null && !BROWSER_PROFILES.includes(profile)) {
    throw badRequest(`browser.profile must be one of ${BROWSER_PROFILES.join(', ')}; got ${repr(profile)}.`);
  }
  return raw;
}

/**
 * A scripted brain step, as trace_decide's _clean_action would accept the
 * model's answer: the element it names by label must be on this screen.
 * Returns the action, or throws why the answer can't be used.
 */
function actionFor(step, observation) {
  const idOf = (label) => {
    const element = observation.elements.find((e) => e.label === label);
    if (!element) throw new Error(`no element is labelled ${repr(label)} on ${repr(observation.screen.title)}; it lists ${observation.elements.map((e) => e.label).join(' | ')}`);
    return element.id;
  };
  if (step.click !== undefined) return { type: 'click', element: idOf(step.click) };
  if (step.hover !== undefined) return { type: 'hover', element: idOf(step.hover) };
  if (step.scroll !== undefined) {
    return { type: 'scroll', direction: step.scroll, amount: step.amount ?? 'page', ...(step.over ? { element: idOf(step.over) } : {}) };
  }
  if (step.press !== undefined) {
    if (!isKeyName(step.press)) throw new Error(`action.key must be a key (got ${repr(step.press)})`);
    return { type: 'press_key', key: step.press };
  }
  if (step.type !== undefined) return { type: 'type', element: idOf(step.type[0]), text: step.type[1] };
  if (step.wait !== undefined) return { type: 'wait', seconds: step.wait };
  if (step.back) return { type: 'back' };
  if (step.give_up !== undefined) return { type: 'give_up', reason: step.give_up };
  if (step.done !== undefined) return { type: 'done', claim: step.done };
  throw new Error(`the script step ${repr(step)} is no action`);
}

function createTraceRuns({ clock, thinkingPolls }) {
  const runs = new Map();
  const studies = new Map();
  const finalizing = new Set();
  /** Every turn post the mock received, and every request it refused, for the tests to read. */
  const posts = [];
  const refusals = [];

  function runOf(runId) {
    const run = runs.get(runId);
    if (!run) throw new Refused(404, 'run_not_found', `run not found: ${runId}`);
    return run;
  }

  function checkOwner(run, owner) {
    if (run.owner === null) throw new Refused(409, 'not_owner', `run ${run.runId} was not claimed by a Figma panel, so it takes no turns.`);
    if (owner !== run.owner) throw new Refused(409, 'not_owner', `run ${run.runId} belongs to another panel; stop this session.`);
  }

  const isOpen = (run) => run.status === 'running' && !run.finalizing;
  const closed = (run) => new Refused(409, 'run_ended', run.status === 'running'
    ? `run ${run.runId} is finalizing: its last turn ended it. Stop this session.`
    : `run ${run.runId} is ${run.status}; stop this session.`);

  function abort(run, code) {
    if (!isOpen(run)) return false;
    run.status = 'aborted';
    run.abortReason = code;
    return true;
  }

  function endOf(run) {
    if (TERMINAL.has(run.status)) return { status: run.status, reason: run.abortReason };
    if (run.status === 'running' && run.finalizing) return { status: 'finalizing', reason: null };
    throw new Error(`run ${run.runId} is ${run.status} and could not be aborted`);
  }

  function markFailed(rec, code, message, ended) {
    if (rec.status !== 'thinking') return false;
    Object.assign(rec, { status: 'failed', error: { code, message }, result: { action: null, state: null, ended } });
    return true;
  }

  function failTurn(run, rec, code, message) {
    const ended = abort(run, code) ? { status: 'aborted', reason: code } : endOf(run);
    // The run's finalizer ends it, and says how on the turn that ended it: this turn is left as it is.
    if (ended.status === 'finalizing') return;
    markFailed(rec, code, message, ended);
  }

  function view(rec) {
    const out = { turn: rec.turn, status: rec.status };
    if (rec.status === 'ready') Object.assign(out, { action: rec.result.action, state: rec.result.state, ended: rec.result.ended });
    else if (rec.status === 'failed') Object.assign(out, { error: rec.error, ended: rec.result.ended });
    return structuredClone(out);
  }

  /** trace_decide.decide: one decision, from the run's script. */
  function decide(run, rec) {
    if (rec.status !== 'thinking') return;
    if (!isOpen(run)) {
      markFailed(rec, 'run_ended', `The run ended before turn ${rec.turn} was decided.`, endOf(run));
      return;
    }
    const step = run.script[rec.turn - 1];
    if (!step) {
      failTurn(run, rec, 'brain_invalid_action', `The script has no step for turn ${rec.turn}.`);
      return;
    }
    if (step.hold && !run.released.has(step.hold)) return;
    if (step.fail) {
      failTurn(run, rec, step.fail, `The scripted brain failed with ${step.fail}.`);
      return;
    }
    if (step.expect && rec.observation.screen.title !== step.expect) {
      failTurn(run, rec, 'brain_invalid_action', `The script expected ${repr(step.expect)} on turn ${rec.turn}, but the screen is ${repr(rec.observation.screen.title)}.`);
      return;
    }
    let action;
    try {
      action = actionFor(step, rec.observation);
    } catch (err) {
      // trace_decide asks once more, then fails the turn and aborts the run.
      failTurn(run, rec, 'brain_invalid_action', `The answer was invalid twice: ${err.message}`);
      return;
    }
    const outcomes = run.turnList().map((t) => t.observation.last?.outcome).filter(Boolean);
    const state = {
      seq: rec.turn - 1, maxSteps: 40, unproductive: outcomes.filter((o) => o === 'nothing_happened').length,
      maxUnproductiveSteps: 6, progress: 0, sentimentTrend: 'steady', reviewGiveUp: false, ended: false, endedReason: null,
    };
    if (FINAL_ACTIONS[action.type]) {
      // _begin_final: the run is finalizing before the turn says how it ends;
      // the debrief ends it by the next request (or once `debrief` is released).
      run.finalizing = { turn: rec, status: FINAL_ACTIONS[action.type], reason: action.type, hold: step.debrief ?? null };
      Object.assign(rec, { status: 'ready', result: { action, state, ended: { status: 'finalizing', reason: action.type } } });
      finalizing.add(run);
      return;
    }
    Object.assign(rec, { status: 'ready', result: { action, state, ended: null } });
  }

  /** _finalize_run after the debrief: each finalizing run (not held) takes its final status. */
  function finishDebriefs() {
    for (const run of finalizing) {
      const { turn, status, reason, hold } = run.finalizing;
      if (hold && !run.released.has(hold)) continue;
      finalizing.delete(run);
      run.status = status;
      turn.result.ended = { status, reason };
    }
  }

  function claim(runId, body) {
    if (!isObject(body)) throw badRequest('The body must be a JSON object {browser?, owner?}.');
    if (body.browser !== undefined && body.browser !== null) cleanBrowser(body.browser);
    const owned = body.owner !== undefined && body.owner !== null;
    if (owned && !(isText(body.owner) && OWNER_RE.test(body.owner))) {
      throw badRequest('owner must be a string of 1 to 64 characters (letters, digits, _ or -).');
    }
    if (owned && (body.browser === undefined || body.browser === null || body.browser.engine !== 'figma-trace')) {
      throw badRequest("owner is only for a Figma panel's claim: browser.engine must be figma-trace.");
    }
    const run = runOf(runId);
    // Only a plugin-mode study's runs take turns from a Figma panel.
    if (owned && studies.get(run.studyId)?.execution !== 'plugin') {
      throw badRequest(`run ${runId} is not a run of a plugin-mode study: only those are claimed with an owner.`);
    }
    // A repeat claim from the run's own panel, whose first answer it lost, gets the same briefing again.
    const engineOk = body.browser === undefined || body.browser === null || body.browser.engine === 'figma-trace';
    if (run.status === 'running' && !run.finalizing && run.owner !== null && body.owner === run.owner && engineOk) {
      return [200, { ...structuredClone(run.briefing), claimedAt: run.claimedAt }];
    }
    if (run.status !== 'queued') {
      throw new Refused(409, 'already_claimed', `run ${runId} is ${run.status}, not queued, so it cannot be claimed again. Another actor has it; take the next queued run of the study.`);
    }
    Object.assign(run, { status: 'running', owner: body.owner ?? null, browser: body.browser ?? null, claimedAt: new Date(clock()).toISOString() });
    return [200, { ...structuredClone(run.briefing), claimedAt: run.claimedAt }];
  }

  function postTurn(runId, body) {
    const { n, owner, observation, shot } = cleanTurn(body);
    const run = runOf(runId);
    checkOwner(run, owner);
    const latest = run.turnList().at(-1);
    if (latest && latest.turn === n) return [202, view(latest)];
    if (!isOpen(run) || latest?.result?.ended) throw closed(run);
    const expected = latest ? latest.turn + (latest.status === 'ready' ? 1 : 0) : 1;
    if (n !== expected) {
      throw new Refused(409, 'turn_out_of_order', `turn ${n} is out of order: this run takes turn ${expected} next. Read GET /turn/${expected - 1} and continue from there.`, { expected });
    }
    if (n > 1) {
      // last reports what the action turn n-1 chose did: the step it completes is that action's.
      const chosen = run.turns.get(n - 1).result.action;
      if (!sameJson(observation.last.action, chosen)) {
        throw badRequest(`last.action must be the action turn ${n - 1} chose, ${repr(chosen)} (got ${repr(observation.last.action)}).`);
      }
    }
    const rec = { turn: n, owner, status: 'thinking', observation, screenshot: shot, deadlineAt: clock() + TURN_DEADLINE_S * 1000, polls: 0, result: null, error: null };
    run.turns.set(n, rec);
    return [202, view(rec)];
  }

  function getTurn(runId, n) {
    const run = runOf(runId);
    const rec = n <= MAX_TURN ? run.turns.get(n) : undefined;
    if (!rec) throw new Refused(404, 'turn_not_found', `run ${runId} has no turn ${n}.`);
    const overdue = rec.status === 'thinking' && !rec.result?.ended && !run.finalizing && clock() > rec.deadlineAt;
    if (overdue) {
      failTurn(run, rec, 'turn_timeout', `No decision for turn ${n} within ${TURN_DEADLINE_S} s of it being posted: the task was lost or no trace worker is running.`);
    } else if (rec.status === 'thinking' && ++rec.polls > thinkingPolls) {
      // The worker decides in the background: a poll or more may still see the turn thinking.
      decide(run, rec);
    }
    return [200, view(rec)];
  }

  function abortRun(runId, body) {
    if (!isObject(body)) throw badRequest('The body must be a JSON object {owner, code, detail}.');
    const { owner, code, detail } = body;
    if (!isText(owner) || !owner) throw badRequest('owner is required: the id this panel sent with its claim.');
    if (!PANEL_ABORT_CODES.includes(code)) throw badRequest(`code must be one of ${PANEL_ABORT_CODES.join(', ')} (got ${repr(code)}).`);
    if (!isText(detail) || !detail.trim()) throw badRequest('detail is required: what went wrong, in a sentence.');
    const run = runOf(runId);
    checkOwner(run, owner);
    if (!isOpen(run)) throw closed(run);
    abort(run, code);
    run.abortDetail = detail.trim().slice(0, MAX_DETAIL);
    const ended = { status: 'aborted', reason: code };
    for (const rec of run.turns.values()) markFailed(rec, code, run.abortDetail, ended);
    return [200, { runId, status: 'aborted', abortReason: code }];
  }

  function addRun(study, wave, spec) {
    const run = {
      runId: spec.runId, studyId: study.studyId, wave, status: 'queued', owner: null, finalizing: null,
      archetypeId: spec.archetypeId ?? spec.runId, archetypeName: spec.archetypeName ?? spec.runId, repeatIndex: spec.repeatIndex ?? 0,
      script: spec.script, released: new Set(), turns: new Map(), abortReason: null,
      briefing: {
        runId: spec.runId, sessionId: `sess-${spec.runId}`, brief: `You are ${spec.archetypeName ?? spec.runId}.`,
        persona: { name: spec.archetypeName ?? spec.runId },
        instructions: { targetUrl: 'figma-trace://Prototype/1-2?node-id=1-2', goal: study.goal },
      },
      turnList() {
        return [...this.turns.values()].sort((a, b) => a.turn - b.turn);
      },
    };
    runs.set(run.runId, run);
    return run;
  }

  /** A plugin-mode study with its waves of runs: wave 1 is queued now, the rest come from next-wave. */
  /** A study with its waves of runs; `execution` 'remote' stands for a study no Figma panel runs. */
  function addStudy({ studyId, goal = 'Connect a bank account', waves, execution = 'plugin' }) {
    const study = { studyId, goal, waves, wave: 1, execution };
    studies.set(studyId, study);
    for (const spec of waves[0]) addRun(study, 1, spec);
    return study;
  }

  function nextWave(studyId) {
    const study = studies.get(studyId);
    if (!study) throw new Refused(404, 'study_not_found', `No study ${studyId} for this user.`);
    const mine = [...runs.values()].filter((r) => r.studyId === studyId);
    const open = mine.filter((r) => !TERMINAL.has(r.status));
    if (open.length) {
      throw new Refused(409, 'wave_in_progress', `wave ${study.wave} still has ${open.length} run(s) that are not finished; wait until every run is completed, failed, aborted or abandoned.`);
    }
    const specs = study.waves[study.wave];
    if (!specs) return [200, { studyId, done: true, reason: `at most ${study.waves.length} waves run per study`, baseline: null, wave: study.wave }];
    study.wave += 1;
    const made = specs.map((spec) => addRun(study, study.wave, spec));
    return [201, {
      studyId, wave: study.wave, created: true, repeatPolicy: 'confirm',
      runs: made.map((r) => ({ runId: r.runId, archetypeId: r.archetypeId, archetypeName: r.archetypeName, repeatIndex: r.repeatIndex })),
      reasons: made.map((r) => ({ archetypeId: r.archetypeId, archetypeName: r.archetypeName, count: 1, reason: 'the script adds it' })),
      baseline: null,
    }];
  }

  /** study_run_service.list_runs: the study's runs as the runner reads them to resume and claim. */
  function listRuns(studyId) {
    const study = studies.get(studyId);
    const mine = [...runs.values()].filter((r) => r.studyId === studyId);
    const status = mine.every((r) => TERMINAL.has(r.status)) && !study.waves[study.wave] ? 'complete' : 'running';
    return [200, {
      studyId, status, currentWave: study.wave,
      runs: mine.map((r) => {
        const turns = r.turnList();
        const last = turns[turns.length - 1];
        return {
          runId: r.runId, archetypeId: r.archetypeId, archetypeName: r.archetypeName, role: null, wave: r.wave, purpose: 'design',
          repeatIndex: r.repeatIndex, status: r.status, claimedAt: r.claimedAt ?? null, completedAt: null, outcome: null, metrics: null,
          browser: r.browser, sessionId: r.briefing.sessionId, videoPath: null,
          lastStep: last ? { seq: last.turn, url: last.observation.screen.url } : null,
        };
      }),
    }];
  }

  /** Lets a script step `{hold: name}` decide, or a final step's `{debrief: name}` end its run. */
  function release(runId, name) {
    runOf(runId).released.add(name);
  }

  /** The routes of api/routes_plugin.py and routes_studies.py for trace runs; null for any other path. */
  function handle(method, path, body, request) {
    const claimPath = /^\/api\/plugin\/runs\/([^/]+)\/claim$/.exec(path);
    const turnPath = /^\/api\/plugin\/runs\/([^/]+)\/turn$/.exec(path);
    const turnN = /^\/api\/plugin\/runs\/([^/]+)\/turn\/([^/]+)$/.exec(path);
    const abortPath = /^\/api\/plugin\/runs\/([^/]+)\/abort$/.exec(path);
    const nextPath = /^\/api\/studies\/([^/]+)\/runs\/next$/.exec(path);
    const runsPath = /^\/api\/studies\/([^/]+)\/runs$/.exec(path);
    finishDebriefs();
    try {
      if (claimPath && method === 'POST') return claim(decodeURIComponent(claimPath[1]), body);
      if (turnPath && method === 'POST') {
        // routes_plugin reads a turn body only up to its limit, as Flask's max_content_length does.
        if (request.bytes === undefined) throw new Error(`POST ${path} reached the mock without its body's size: serve it through serveMock, or pass { bytes }.`);
        if (request.bytes > MAX_TURN_BODY_BYTES) {
          throw new Refused(413, 'payload_too_large', `A turn body is at most ${MAX_TURN_BODY_BYTES / (1024 * 1024)} MB: a screenshot of at most 1.5 MB and what the screen shows.`);
        }
        const runId = decodeURIComponent(turnPath[1]);
        const answer = postTurn(runId, body);
        posts.push({ runId, turn: body.turn, body: structuredClone(body), status: answer[0] });
        return answer;
      }
      if (turnN && method === 'GET') {
        if (!/^[0-9]+$/.test(turnN[2]) || Number(turnN[2]) < 1) throw badRequest(`The turn must be a whole number from 1 (got ${repr(turnN[2])}).`);
        return getTurn(decodeURIComponent(turnN[1]), Number(turnN[2]));
      }
      if (abortPath && method === 'POST') return abortRun(decodeURIComponent(abortPath[1]), body);
      if (nextPath && method === 'POST' && studies.has(decodeURIComponent(nextPath[1]))) return nextWave(decodeURIComponent(nextPath[1]));
      if (runsPath && method === 'GET' && studies.has(decodeURIComponent(runsPath[1]))) return listRuns(decodeURIComponent(runsPath[1]));
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      refusals.push({ method, path, status: err.status, error: err.slug, message: err.message, body: structuredClone(body) });
      return [err.status, { error: err.slug, message: err.message, ...err.extra }];
    }
    return null;
  }

  return { handle, addStudy, release, runs, studies, posts, refusals };
}

/** Serves a mock backend over HTTP on 127.0.0.1, on a free port unless given one. */
export function serveMock(mock, { port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    // A turn body over the limit is refused unread, after the sign in check, as the backend does.
    const unread = req.method === 'POST' && /\/turn$/.test(path) && buffer.length > MAX_TURN_BODY_BYTES;
    let body = null;
    if (!unread) {
      try {
        body = buffer.length ? JSON.parse(buffer.toString('utf8')) : null;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request', message: 'The body is not JSON.' }));
        return;
      }
    }
    const out = (await mock.handle(req.method, path, body, req.headers, { bytes: buffer.length })) ?? [404, { error: 'not_found', message: `${req.method} ${path} is not part of the mock.` }];
    res.writeHead(out[0], { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out[1]));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
