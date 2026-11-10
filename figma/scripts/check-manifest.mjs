// Checks that manifest.json is valid for import and points at built files.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const problems = [];
const need = (cond, msg) => cond || problems.push(msg);

need(typeof manifest.name === 'string' && manifest.name, 'name is required');
need(typeof manifest.id === 'string' && manifest.id, 'id is required');
need(manifest.api === '1.0.0', 'api must be 1.0.0');
need(manifest.documentAccess === 'dynamic-page', 'documentAccess must be dynamic-page');
need(Array.isArray(manifest.editorType) && manifest.editorType.includes('figma'), 'editorType must include figma');
for (const key of ['main', 'ui']) {
  const p = manifest[key];
  need(typeof p === 'string' && p.startsWith('dist/'), `${key} must point into dist/`);
  if (typeof p === 'string') need(existsSync(join(root, p)), `${key} file ${p} does not exist; run npm run build`);
}
const net = manifest.networkAccess ?? {};
need(Array.isArray(net.allowedDomains) && net.allowedDomains.length > 0, 'networkAccess.allowedDomains must list at least one domain');
need(!(net.allowedDomains ?? []).some((d) => /localhost|127\.0\.0\.1/.test(d)), 'local servers belong in devAllowedDomains, not allowedDomains');
// Figma refuses the whole manifest on import ("must be a valid URL") when a
// domain is an IP address, so loopback servers are listed as localhost only.
for (const key of ['allowedDomains', 'devAllowedDomains']) {
  for (const d of net[key] ?? []) {
    const host = d.replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '');
    need(!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !d.includes('['), `networkAccess.${key}: ${d} is an IP address, which Figma rejects; use a host name such as localhost`);
  }
}
need(typeof net.reasoning === 'string' && net.reasoning.length > 20, 'networkAccess.reasoning should explain the access');
const text = JSON.stringify(manifest);
need(!/[\u2013\u2014]/.test(text), 'no en or em dashes in the manifest');

if (existsSync(join(root, 'dist/ui.html'))) {
  const html = readFileSync(join(root, 'dist/ui.html'), 'utf8');
  need(!/<script[^>]+src=/.test(html), 'dist/ui.html must inline its script');
  need(!/<link[^>]+stylesheet/.test(html), 'dist/ui.html must inline its styles');
}

if (problems.length) {
  console.error(`manifest check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`manifest ok: ${manifest.name} (${manifest.main}, ${manifest.ui})`);
