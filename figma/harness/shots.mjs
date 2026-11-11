#!/usr/bin/env node
// Screenshots of every panel screen in light and dark, against the mock
// backend, into harness/shots/ (gitignored). Run npm run build first.
//
//   node harness/shots.mjs            all scenarios
//   node harness/shots.mjs report     only scenarios whose name contains "report"
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'shots');
const filter = process.argv[2] ?? '';

const pickGoal = async (f) => {
  await f.locator('#pick-goal').selectOption('2:50');
};

/** name, query, wait-for selector in the panel, optional steps, optional panel height. */
const SCENARIOS = [
  { name: '01-signin', q: 'token=none', wait: 'text=Sign in with Archetype' },
  { name: '02-signin-code', q: 'token=none', wait: 'text=Sign in with Archetype', act: async (f) => f.getByRole('button', { name: 'Sign in with Archetype' }).click(), after: '.user-code' },
  { name: '03-signin-expired', q: 'token=expired&study=study-running', wait: 'text=session ended' },
  { name: '04-new-empty', q: 'token=mock', wait: '#pick-start' },
  { name: '05-new-ready', q: 'token=mock&draft=1', wait: '#pick-start', act: pickGoal, height: 1180 },
  { name: '06-new-advice-open', q: 'token=mock&draft=1', wait: '#pick-start', act: async (f) => {
      await pickGoal(f);
      for (const s of await f.locator('details summary').all()) await s.click();
    }, height: 1180 },
  { name: '07-new-blocked', q: 'token=mock&draft=1', wait: '#pick-start', act: async (f) => f.locator('#pick-goal').selectOption('4:1') },
  { name: '08-new-errors', q: 'token=mock', wait: '#pick-start', act: async (f) => {
      await f.locator('#link').fill('https://www.figma.com/board/AbCdEfGh1234567890XyZ/x');
      await f.getByRole('button', { name: 'Launch test' }).click();
    }, height: 900 },
  { name: '09-new-selection', q: 'token=mock&draft=1&selection=2:50', wait: '#pick-start', act: async (f) => f.getByRole('button', { name: 'Use selection' }).nth(1).click() },
  { name: '10-empty-page', q: 'token=mock&doc=empty', wait: 'text=No frames on' },
  { name: '11-launch-personas', q: 'token=mock&study=study-archetypes', wait: 'text=Building personas', after: '.stage-active' },
  { name: '12-launch-error', q: 'token=mock&study=study-fail', wait: 'text=Try again' },
  { name: '13-running', q: 'token=mock&study=study-running', wait: '.persona', after: 'text=On Connect bank' },
  { name: '14-waiting-for-runner', q: 'token=mock&study=study-queued&queuedAgo=5', wait: 'text=Waiting for a runner.' },
  { name: '15-report', q: 'token=mock&study=study-done', wait: '.score' },
  { name: '16-report-full', q: 'token=mock&study=study-done', wait: '.score', height: 1200 },
  { name: '16b-report-flow', q: 'token=mock&study=study-flow', wait: '.score', height: 1700 },
  // A launch the panel runs itself, two personas side by side, a turn or two in: the Live screen over the folded Flow map.
  { name: '13c-running-map-open', q: 'token=mock&draft=1&flowMap=open', wait: '#pick-start', act: async (f) => {
      await pickGoal(f);
      await f.getByRole('button', { name: 'Launch test' }).click();
      await f.getByRole('button', { name: 'Add and launch' }).click({ timeout: 20000 });
      await f.getByRole('button', { name: 'Launch', exact: true }).click({ timeout: 20000 });
      await f.locator('.fm').first().waitFor({ timeout: 30000 });
      await f.locator('.fm-more').first().waitFor({ timeout: 30000 });
      await f.locator('#flowmap-h').scrollIntoViewIfNeeded();
    }, height: 1100 },
  { name: '13b-running-live', q: 'token=mock&draft=1', wait: '#pick-start', act: async (f) => {
      await pickGoal(f);
      await f.getByRole('button', { name: 'Launch test' }).click();
      // The fake file asks to add its library variants, one of which can't be added: launch anyway.
      await f.getByRole('button', { name: 'Add and launch' }).click({ timeout: 20000 });
      await f.getByRole('button', { name: 'Launch', exact: true }).click({ timeout: 20000 });
      await f.locator('.ls-frame img').first().waitFor({ timeout: 30000 });
      await f.locator('.ls-chips li').nth(1).waitFor({ timeout: 30000 });
      // The moment after a click: its target marked on the screen it was on.
      await f.locator('.ls-marks .ls-target').first().waitFor({ state: 'attached', timeout: 30000 });
    }, height: 1100 },
  { name: '16c-report-flow-map', q: 'token=mock&study=study-flow', wait: '.fm', act: async (f) => f.locator('#flowmap-h').scrollIntoViewIfNeeded(), after: '.fm-token' },
  { name: '16d-report-flow-edit', q: 'token=mock&study=study-flow', wait: '.fm', act: async (f) => {
      await f.getByRole('button', { name: 'Edit map' }).click();
      await f.locator('.fm-editor').scrollIntoViewIfNeeded();
    }, after: '.fm-edit-row' },
  { name: '17-history', q: 'token=mock&history=1&study=study-done', wait: '.score', act: async (f) => f.getByRole('button', { name: 'Past tests for this file' }).click(), after: '.history-item' },
  { name: '18-history-empty', q: 'token=mock', wait: '#pick-start', act: async (f) => f.getByRole('button', { name: 'Past tests for this file' }).click(), after: 'text=No tests from this file yet' },
  { name: '19-settings', q: 'token=mock', wait: '#pick-start', act: async (f) => f.getByRole('button', { name: 'Settings' }).click(), after: '#api' },
  { name: '20-loading', q: 'token=mock', wait: null, raw: true },
];

const HOST_SHOTS = [
  { name: '30-host-pins', q: 'token=mock&study=study-done', wait: '.score', act: async (f) => f.getByRole('button', { name: 'Pin findings' }).click(), after: 'text=Pinned findings' },
  { name: '31-host-launch-flow', q: 'token=mock&draft=1', wait: '#pick-start', act: async (f) => {
      await pickGoal(f);
      await f.getByRole('button', { name: 'Launch test' }).click();
      await f.locator('text=Running').first().waitFor();
      await f.locator('.persona').first().waitFor({ timeout: 20000 });
      await f.locator('text=On ').first().waitFor({ timeout: 20000 });
    } },
];

await mkdir(out, { recursive: true });
const srv = await startServer({ port: 0, quiet: true });
const base = `http://localhost:${srv.port}`;
const browser = await chromium.launch();
let n = 0;
let failures = 0;
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 1340 }, deviceScaleFactor: 2 });
    for (const s of [...SCENARIOS, ...HOST_SHOTS]) {
      if (filter && !s.name.includes(filter)) continue;
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.goto(`${base}/?fresh=1&theme=${theme}&${s.q}`);
      const f = page.frameLocator('#plugin-frame');
      if (s.height) await page.evaluate((h) => { document.getElementById('plugin-frame').style.height = `${h}px`; }, s.height);
      try {
        if (s.wait) await f.locator(s.wait).first().waitFor({ timeout: 15000 });
        if (s.act) await s.act(f);
        if (s.after) await f.locator(s.after).first().waitFor({ timeout: 20000 });
      } catch (err) {
        failures++;
        console.log(`  FAILED ${s.name}-${theme}: ${err.message.split('\n')[0]} ${errors.join(' | ')}`);
        await page.screenshot({ path: join(out, `FAILED-${s.name}-${theme}.png`) });
        await page.close();
        continue;
      }
      await page.waitForTimeout(350);
      const file = join(out, `${s.name}-${theme}.png`);
      if (s.name.startsWith('3')) await page.screenshot({ path: file });
      else await page.locator('#plugin').screenshot({ path: file });
      n++;
      if (errors.length) console.log(`  ${s.name}-${theme}: console errors: ${errors.join(' | ')}`);
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
  await srv.close();
}
console.log(`${n} screenshots in harness/shots/${failures ? `, ${failures} failed` : ''}`);
if (failures) process.exitCode = 1;
