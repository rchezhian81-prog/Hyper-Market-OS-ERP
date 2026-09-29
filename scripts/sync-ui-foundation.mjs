#!/usr/bin/env node
// Copy the ONE visual foundation to every app that serves screens.
//
// Source of truth: packages/ui/web/sre-foundation.css. Each `apps/<app>/web/` that holds a screen gets a
// byte-identical, TRACKED copy, because every screen is served from its own folder — by the store box's
// screen socket, by the nginx shell container, by the public proxy — and each one precaches `./sre-foundation.css`
// in its service worker so a lane opens with the right look and no network (P-01). One file, nine copies,
// and this script is the only thing that writes them; the guardrail
// tests/guardrails/every-screen-shares-the-foundation.test.ts fails the build if any copy drifts.
//
// Usage:  node scripts/sync-ui-foundation.mjs          write every copy (also run by scripts/build-app.mjs)
//         node scripts/sync-ui-foundation.mjs --check  exit 1 naming any copy that differs; write nothing
//
// The marketing site (apps/site) has its own identity on purpose and is not a screen; it is left alone.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FOUNDATION_SOURCE = 'packages/ui/web/sre-foundation.css';
export const FOUNDATION_FILE = 'sre-foundation.css';
export const NOT_A_SCREEN = new Set(['site']);

/** Every `apps/<app>/web` folder that holds at least one screen (an .html page), the marketing site excepted. */
export function screenAppDirs(root = ROOT) {
  return readdirSync(join(root, 'apps'))
    .filter((app) => !NOT_A_SCREEN.has(app))
    .filter((app) => {
      const web = join(root, 'apps', app, 'web');
      return existsSync(web) && statSync(web).isDirectory() && readdirSync(web).some((f) => f.endsWith('.html'));
    })
    .sort();
}

/** Compare (and optionally write) every copy. Returns the apps whose copy was missing or different. */
export function syncFoundation({ root = ROOT, write = true } = {}) {
  const source = readFileSync(join(root, FOUNDATION_SOURCE));
  const drifted = [];
  for (const app of screenAppDirs(root)) {
    const target = join(root, 'apps', app, 'web', FOUNDATION_FILE);
    const same = existsSync(target) && readFileSync(target).equals(source);
    if (same) continue;
    drifted.push(app);
    if (write) writeFileSync(target, source);
  }
  return drifted;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes('--check');
  const drifted = syncFoundation({ write: !check });
  if (check && drifted.length > 0) {
    console.error(`sre-foundation.css differs from ${FOUNDATION_SOURCE} in: ${drifted.map((a) => `apps/${a}/web`).join(', ')} — run: node scripts/sync-ui-foundation.mjs`);
    process.exit(1);
  }
  console.log(check
    ? `every apps/*/web/${FOUNDATION_FILE} matches ${FOUNDATION_SOURCE}`
    : drifted.length === 0
      ? `every apps/*/web/${FOUNDATION_FILE} was already current`
      : `${FOUNDATION_FILE} written to: ${drifted.map((a) => `apps/${a}/web`).join(', ')}`);
}
