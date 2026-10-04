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
import { syncFoundation, stampServiceWorkers, FOUNDATION_FILE, WORKER_FILE } from './sync-ui-foundation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every build refreshes the shared stylesheet copies first, so a screen is never built against a stale look
// (packages/ui/web/sre-foundation.css is the source; apps/<app>/web/sre-foundation.css are its tracked copies).
const refreshed = syncFoundation();
if (refreshed.length > 0) console.log(`shared copies refreshed (${FOUNDATION_FILE}, sre-update.js): ${refreshed.join(', ')}`);
// …and every service worker's cache name follows its shell (RL-1), so the build that changed a screen also changes
// the name the browser keys the old shell under.
const stamped = stampServiceWorkers();
if (stamped.length > 0) console.log(`${WORKER_FILE} cache name stamped in: ${stamped.map((a) => `apps/${a}/web`).join(', ')}`);

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
  // Build-time flag for the "DEMO / PILOT — NOT PRODUCTION" banner. The hosted demo builds with
  // PILOT_DEMO_BANNER=1 so the banner shows; a production build leaves it unset, so it does not.
  // Baked in at build time (esbuild `define`) rather than read at runtime — a browser has no env.
  define: {
    PILOT_DEMO_BANNER: JSON.stringify(process.env.PILOT_DEMO_BANNER ?? ''),
    // DEMO ONLY (ADR-0016): the hosted demo's till writes to the demo store box via this same-origin path.
    // Unset in production, where the till writes to its own store's loopback exactly as before.
    PILOT_DEMO_LANE_BASE: JSON.stringify(process.env.PILOT_DEMO_LANE_BASE ?? ''),
  },
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`${app} bundle: watching for changes…`);
} else {
  await build(options);
  console.log(`${app} bundle written to ${OUTFILE.replace(ROOT + '/', '')}`);
}
