// Derives the harness report from the backend's golden report
// (Archetype_Backend docs/fixtures/study-report.example.json): same numbers,
// with the live site's URLs swapped for prototype URLs of the fixture frames,
// as the runner would record them on a Figma prototype.
//
//   node harness/fixtures/make-report.mjs <golden.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const FILE = 'https://www.figma.com/proto/AbCdEfGh1234567890XyZ/Farside-billing';
const PATHS = {
  '/settings/billing/bank/verify': '2-30',
  '/settings/billing/bank': '2-20',
  '/settings/billing': '2-10',
  '/help': '2-40',
};
const proto = (dash) => `${FILE}?node-id=${dash}&starting-point-node-id=1%3A2&scaling=scale-down`;

function swap(url) {
  if (typeof url !== 'string' || !url.startsWith('https://farside-moon.pages.dev')) return url;
  const path = new URL(url).pathname;
  const hit = Object.keys(PATHS).find((p) => path === p || path.startsWith(`${p}/`));
  return proto(hit ? PATHS[hit] : '1-2');
}

function walk(v) {
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = k === 'url' ? swap(val) : walk(val);
    return out;
  }
  return v;
}

const report = walk(golden);
report.task = { ...report.task, url: proto('1-2'), startPath: null };
report.title = 'Connect a business bank account so invoices can be paid by bank transfer';
writeFileSync(join(here, 'study-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('wrote harness/fixtures/study-report.json');
