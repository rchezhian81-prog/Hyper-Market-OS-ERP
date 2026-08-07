#!/usr/bin/env node
// Build an app shell bundle. Compiles an app's tested TypeScript model
// (`apps/<app>/src/browser-entry.ts` and everything it composes) into a single
// browser module, so the screen is driven by the REAL engines rather than a
// stand-in.
//
// Usage:  node scripts/build-app.mjs <app> [--watch]
//         pnpm build:pos            pnpm build:owner
//         pnpm build:pos --watch    (rebuild on change while designing a screen)
//
// The output is a build artifact (git-ignored): `apps/<app>/web/<app>.bundle.js`.
// Each app's `app.js` uses the bundled model when present and falls back to its
// stand-in when it is not, so a shell always opens.

import { build, context } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const app = process.argv[2];
if (!app || app.startsWith('--')) {
  console.error('Usage: node scripts/build-app.mjs <app> [--watch]');
  process.exit(1);
}

const ENTRY = join(ROOT, 'apps', app, 'src', 'browser-entry.ts');
const OUTFILE = join(ROOT, 'apps', app, 'web', `${app}.bundle.js`);

if (!existsSync(ENTRY)) {
  console.error(`No browser entry for "${app}" (expected ${ENTRY.replace(ROOT + '/', '')}).`);
  process.exit(1);
}

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

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`${app} bundle: watching for changes…`);
} else {
  await build(options);
  console.log(`${app} bundle written to ${OUTFILE.replace(ROOT + '/', '')}`);
}
