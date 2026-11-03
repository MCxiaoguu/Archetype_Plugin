// A fake Archetype backend for the harness: the studies, runs, report and
// device flow routes the panel uses, answered from the fixtures. Preset study
// ids freeze one moment each (for screenshots); studies the panel creates
// play out in about 20 s.
import { readFileSync } from 'node:fs';
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
    ...(extra.lastUrl ? { lastUrl: extra.lastUrl } : {}),
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

export function createMockBackend({ log = () => {} } = {}) {
  const studies = new Map();
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

  /** Returns [status, body] or null when the route is unknown. */
  async function handle(method, path, body, headers) {
    if (path === '/api/oauth/device/code' && method === 'POST') {
      const device_code = `dev-${++deviceSeq}`;
      devicePolls.set(device_code, 0);
      return [200, { device_code, user_code: 'WDJB-MJHT', verification_uri: 'https://auth.example/activate', verification_uri_complete: 'https://auth.example/activate?user_code=WDJB-MJHT', expires_in: 600, interval: 2 }];
    }
    if (path === '/api/oauth/device/token' && method === 'POST') {
      const n = (devicePolls.get(body?.device_code) ?? 0) + 1;
      devicePolls.set(body?.device_code, n);
      if (n < 4) return [403, { error: n === 2 ? 'slow_down' : 'authorization_pending', error_description: 'waiting' }];
      return [200, { access_token: 'mock-token', token_type: 'Bearer', expires_in: 86400 }];
    }
    if (!path.startsWith('/api/')) return null;
    if (!/^Bearer \S+/.test(headers.authorization ?? '')) return [401, { error: 'Authorization header missing', message: 'Sign in first.' }];
    if (headers.authorization === 'Bearer expired') return [401, { error: 'Invalid token', message: 'Token expired.' }];

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
    const run = /^\/api\/plugin\/runs\/([^/]+)\/report$/.exec(path);
    if (run && method === 'GET') {
      const step = 1 + (Math.floor(Date.now() / 4000) % 3);
      return [200, { status: 'running', steps: Array.from({ length: step }, (_, i) => ({ seq: i + 1, url: at(['1-2', '2-10', '2-20'][i]) })) }];
    }
    return [404, { error: 'not_found', message: `${method} ${path} is not part of the mock.` }];
  }

  return { handle, studies };
}
