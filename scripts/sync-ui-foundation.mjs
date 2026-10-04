#!/usr/bin/env node
// Copy the ONE visual foundation to every app that serves screens — and stamp every service worker's cache name
// with what its shell actually contains, so a deploy reaches the browser.
//
// Source of truth: packages/ui/web/sre-foundation.css. Each `apps/<app>/web/` that holds a screen gets a
// byte-identical, TRACKED copy, because every screen is served from its own folder — by the store box's
// screen socket, by the nginx shell container, by the public proxy — and each one precaches `./sre-foundation.css`
// in its service worker so a lane opens with the right look and no network (P-01). One file, nine copies,
// and this script is the only thing that writes them; the guardrail
// tests/guardrails/every-screen-shares-the-foundation.test.ts fails the build if any copy drifts.
//
// THE STAMP (RL-1, 4 Oct 2026). Each `apps/<app>/web/sw.js` serves its committed shell files cache-first under a
// named cache, and drops every other cache when a worker with a NEW name activates. The name used to be a number a
// person bumped by hand — and nobody bumped it when the whole look changed (UX-1a), so the new foundation reached
// the box and not one browser: every page kept the old stylesheet and the old chrome out of its cache, and the
// owner rightly said nothing had changed. Now the name is `sre-<app>-shell-<12 hex>` where the hex is a digest of
// every committed SHELL file's content and of the worker's own code. Change a byte in the shell and the name moves;
// the next visit installs the new worker, which clears the old cache. This script writes it; `--check` refuses a
// stale one; every build runs it (scripts/build-app.mjs); the guardrail pins it.
//
// Usage:  node scripts/sync-ui-foundation.mjs          write every copy and every stamp (also run by scripts/build-app.mjs)
//         node scripts/sync-ui-foundation.mjs --check  exit 1 naming any copy or stamp that differs; write nothing
//
// The marketing site (apps/site) has its own identity on purpose and is not a screen; it is left alone.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FOUNDATION_SOURCE = 'packages/ui/web/sre-foundation.css';
export const FOUNDATION_FILE = 'sre-foundation.css';
export const NOT_A_SCREEN = new Set(['site']);
export const WORKER_FILE = 'sw.js';
const CACHE_LINE = /^const CACHE = '(sre-[a-z0-9-]+-shell)-[0-9a-z]+';$/m;

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

/** The committed SHELL list a worker precaches, as written in its source. */
export function shellOf(workerSource) {
  const m = /const SHELL = \[([^\]]*)\]/.exec(workerSource);
  if (!m) return [];
  return [...m[1].matchAll(/'\.\/([^']+)'/g)].map((x) => x[1]);
}

/**
 * The digest of a worker's shell: every committed SHELL file's bytes, in SHELL order, and the worker's own code with
 * its CACHE line blanked (so the digest does not depend on itself). A SHELL file that is missing is digested as
 * missing — the install would fail loudly anyway (`addAll`), and a stamp must not hide that.
 */
export function shellStampFor(app, root = ROOT) {
  const web = join(root, 'apps', app, 'web');
  const source = readFileSync(join(web, WORKER_FILE), 'utf8');
  const hash = createHash('sha256');
  for (const file of shellOf(source)) {
    const path = join(web, file);
    hash.update(`${file}\0`);
    hash.update(existsSync(path) ? readFileSync(path) : 'MISSING');
    hash.update('\0');
  }
  hash.update(source.replace(CACHE_LINE, "const CACHE = '';"));
  return hash.digest('hex').slice(0, 12);
}

/** What the worker's CACHE line must say: its own prefix (one per app, so no deploy evicts another's shell) + the stamp. */
export function expectedCacheName(app, root = ROOT) {
  const source = readFileSync(join(root, 'apps', app, 'web', WORKER_FILE), 'utf8');
  const m = CACHE_LINE.exec(source);
  if (!m) throw new Error(`apps/${app}/web/${WORKER_FILE} has no "const CACHE = 'sre-<app>-shell-…'" line to stamp`);
  return `${m[1]}-${shellStampFor(app, root)}`;
}

/** Compare (and optionally write) every worker's stamp. Returns the apps whose cache name was stale. */
export function stampServiceWorkers({ root = ROOT, write = true } = {}) {
  const stale = [];
  for (const app of screenAppDirs(root)) {
    const file = join(root, 'apps', app, 'web', WORKER_FILE);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const expected = expectedCacheName(app, root);
    if (CACHE_LINE.exec(source)?.[0] === `const CACHE = '${expected}';`) continue;
    stale.push(app);
    if (write) writeFileSync(file, source.replace(CACHE_LINE, `const CACHE = '${expected}';`));
  }
  return stale;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes('--check');
  const drifted = syncFoundation({ write: !check });
  if (check && drifted.length > 0) {
    console.error(`sre-foundation.css differs from ${FOUNDATION_SOURCE} in: ${drifted.map((a) => `apps/${a}/web`).join(', ')} — run: node scripts/sync-ui-foundation.mjs`);
    process.exit(1);
  }
  const stale = stampServiceWorkers({ write: !check });
  if (check && stale.length > 0) {
    console.error(`the service worker's cache name does not match its shell in: ${stale.map((a) => `apps/${a}/web/${WORKER_FILE}`).join(', ')} — a shell file changed without the stamp; run: node scripts/sync-ui-foundation.mjs`);
    process.exit(1);
  }
  console.log(check
    ? `every apps/*/web/${FOUNDATION_FILE} matches ${FOUNDATION_SOURCE}; every apps/*/web/${WORKER_FILE} cache name matches its shell`
    : drifted.length === 0
      ? `every apps/*/web/${FOUNDATION_FILE} was already current`
      : `${FOUNDATION_FILE} written to: ${drifted.map((a) => `apps/${a}/web`).join(', ')}`);
  if (!check) console.log(stale.length === 0 ? `every apps/*/web/${WORKER_FILE} cache name was already current` : `${WORKER_FILE} cache name stamped in: ${stale.map((a) => `apps/${a}/web`).join(', ')}`);
}
