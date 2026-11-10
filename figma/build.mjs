// Builds the plugin: dist/code.js (main thread) and dist/ui.html (the panel,
// with its script and styles inlined, because Figma loads one HTML string).
import { build, context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const dist = join(root, 'dist');
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
};

const codeOptions = {
  ...common,
  entryPoints: [join(root, 'src/code.ts')],
  outfile: join(dist, 'code.js'),
  // The main thread runs in Figma's sandbox; keep the syntax conservative.
  target: 'es2017',
  format: 'iife',
};

async function writeUi() {
  const result = await build({
    ...common,
    entryPoints: [join(root, 'src/ui/main.tsx')],
    write: false,
    target: 'chrome100',
    format: 'iife',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = await readFile(join(root, 'src/ui/styles.css'), 'utf8');
  const html = await readFile(join(root, 'src/ui/index.html'), 'utf8');
  const out = html.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
  await writeFile(join(dist, 'ui.html'), out);
  console.log(`dist/ui.html ${(out.length / 1024).toFixed(1)} kB`);
}

if (watch) {
  const ctx = await context(codeOptions);
  await ctx.watch();
  const uiCtx = await context({
    entryPoints: [join(root, 'src/ui/main.tsx')],
    bundle: true,
    write: false,
    plugins: [{ name: 'inline', setup: (b) => b.onEnd(() => writeUi().catch((e) => console.error(e))) }],
  });
  await uiCtx.watch();
  console.log('watching for changes');
} else {
  await build(codeOptions);
  await writeUi();
}
