#!/usr/bin/env node
// The plugin harness: serves dist/ui.html inside a page that plays Figma's
// main thread (fixture graph, canvas, storage) over postMessage.
//
//   node harness/serve.mjs                       mock backend from fixtures
//   node harness/serve.mjs --backend http://localhost:5013 --token x
//                                                live backend; the panel's
//                                                iframe has a null origin, as
//                                                in Figma, so the backend must
//                                                allow it (or add --proxy)
//   Options: --port 4400  --proxy  --doc path/to/snapshot.json
//            --start "1:3=Welcome" --goal "71:616=Done" [--file "File name"]
//                                                a stand in page for a real
//                                                file: two frames, one hotspot
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockBackend } from './mock-backend.mjs';
import { themeUi } from './theme.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function cors(res, req) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

export function startServer(opts = {}) {
  const port = opts.port ?? 4400;
  const backend = opts.backend ? opts.backend.replace(/\/+$/, '') : null;
  const docPath = opts.doc ? resolve(opts.doc) : join(here, 'fixtures/doc.json');
  const standIn = opts.start && opts.goal ? standInDoc(opts.start, opts.goal, opts.file) : null;
  const quiet = opts.quiet ?? false;
  const log = (m) => quiet || console.log(`[harness] ${m}`);
  const mock = createMockBackend({ log });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (path.startsWith('/mock/') || path.startsWith('/proxy/')) {
        cors(res, req);
        if (req.method === 'OPTIONS') return send(res, 204, '');
        const raw = await readBody(req);
        if (path.startsWith('/proxy/')) {
          const target = `${backend}${path.slice('/proxy'.length)}${url.search}`;
          const headers = {};
          for (const h of ['authorization', 'content-type', 'accept']) if (req.headers[h]) headers[h] = req.headers[h];
          const r = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
          log(`${req.method} ${path.slice(6)} -> ${r.status}`);
          return send(res, r.status, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') ?? 'application/json');
        }
        let body = null;
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
        } catch {
          return send(res, 400, { error: 'bad_json', message: 'Body is not JSON.' });
        }
        const out = await mock.handle(req.method, path.slice('/mock'.length), body, req.headers);
        log(`${req.method} ${path.slice(5)} -> ${out ? out[0] : 404}`);
        return out ? send(res, out[0], out[1]) : send(res, 404, { error: 'not_found', message: 'Unknown route.' });
      }
      if (path === '/config.json') {
        const port = server.address().port;
        const apiBase = backend ? (opts.proxy ? `http://localhost:${port}/proxy` : backend) : `http://localhost:${port}/mock`;
        return send(res, 200, { mode: backend ? 'live' : 'mock', apiBase, backend, token: opts.token ?? null, proxy: !!opts.proxy, webBase: opts.web ?? 'https://www.syntheticarchetype.com' });
      }
      if (path === '/doc.json') return send(res, 200, standIn ? JSON.stringify(standIn) : readFileSync(docPath, 'utf8'));
      if (path === '/ui.html') {
        const file = join(root, 'dist/ui.html');
        if (!existsSync(file)) return send(res, 500, 'dist/ui.html is missing: run npm run build first.', 'text/plain');
        return send(res, 200, themeUi(readFileSync(file, 'utf8'), url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'), TYPES['.html']);
      }
      if (path === '/' || path === '/index.html') return send(res, 200, readFileSync(join(here, 'host/index.html'), 'utf8'), TYPES['.html']);
      if (path.startsWith('/host/') || path.startsWith('/fixtures/')) {
        const file = join(here, path);
        if (!file.startsWith(here) || !existsSync(file)) return send(res, 404, 'not found', 'text/plain');
        return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
      }
      return send(res, 404, 'not found', 'text/plain');
    } catch (err) {
      log(`error on ${path}: ${err?.message ?? err}`);
      return send(res, 502, { error: 'harness_error', message: String(err?.message ?? err) });
    }
  });

  return new Promise((resolveStart) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      log(`http://localhost:${actual}  (${backend ? `live: ${backend}${opts.proxy ? ' via proxy' : ''}` : 'mock backend'})`);
      resolveStart({
        server,
        port: actual,
        close: () =>
          new Promise((r) => {
            server.close(r);
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** A page with the real file's start and goal frames and one hotspot between them. */
export function standInDoc(start, goal, fileName = 'Prototype') {
  const frame = (spec, fallback) => {
    const [id, ...name] = String(spec).split('=');
    if (!/^\d+:\d+$/.test(id)) throw new Error(`--start and --goal take a Plugin API node id like 71:616, got ${spec}`);
    return { id, name: name.join('=') || fallback };
  };
  const s = frame(start, 'Start screen');
  const g = frame(goal, 'Goal screen');
  return {
    fileName,
    pageId: '0:1',
    pageName: 'Page 1 (harness stand in)',
    frames: [s, g],
    flowStarts: [{ nodeId: s.id, name: 'Flow 1' }],
    hotspots: [{ id: 'harness:1', name: 'Continue', type: 'INSTANCE', frameId: s.id, trigger: 'ON_CLICK', actions: [{ kind: 'node', navigation: 'NAVIGATE', destinationId: g.id }] }],
    destinations: { [g.id]: { exists: true, frameId: g.id } },
    truncated: false,
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') o.port = Number(next());
    else if (a === '--backend') o.backend = next();
    else if (a === '--token') o.token = next();
    else if (a === '--doc') o.doc = next();
    else if (a === '--web') o.web = next();
    else if (a === '--proxy') o.proxy = true;
    else if (a === '--start') o.start = next();
    else if (a === '--goal') o.goal = next();
    else if (a === '--file') o.file = next();
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n'));
      process.exit(0);
    }
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer(parseArgs(process.argv.slice(2)));
}
