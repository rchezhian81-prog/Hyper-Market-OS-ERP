#!/usr/bin/env node
// Build the POS shell bundle. Compiles the tested TypeScript session
// (`apps/pos/src/browser-entry.ts` and everything it composes) into a single
// browser module, so the Sale screen is driven by the REAL engines rather than the
// view's stand-in.
//
// Usage:  pnpm build:pos            (one-off build)
//         pnpm build:pos --watch    (rebuild on change while designing the screen)
//
// The output is a build artifact (git-ignored): `web/pos-session.bundle.js`.
// `web/app.js` uses `window.posSession` when the bundle is present and falls back
// to its stand-in when it is not, so the shell always opens.

import { build, context } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'apps', 'pos', 'src', 'browser-entry.ts');
const OUTFILE = join(ROOT, 'apps', 'pos', 'web', 'pos-session.bundle.js');

/** esbuild options — a self-contained ES module for modern browsers. */
const options = {
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  // Keep the bundle readable in the store during pilot; minify for production.
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
  logLevel: 'info',
};

const watch = process.argv.includes('--watch');

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('POS bundle: watching for changes…');
} else {
  await build(options);
  console.log(`POS bundle written to ${OUTFILE.replace(ROOT + '/', '')}`);
}
