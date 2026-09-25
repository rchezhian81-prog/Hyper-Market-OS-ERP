import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Every shop screen must actually BUNDLE for the browser — the one check that a real deployment needs and
// that ordinary CI could not previously make.
//
// The story this guardrail closes: the ERP admin screen imported `accessReview` from the `@sre/identity`
// BARREL, and the barrel re-exports the OTP and org-membership engines, which use `node:crypto`. `node:crypto`
// has no browser build, so `esbuild --platform=browser` refused the bundle and the ERP admin app could not be
// served at all. Nothing caught it, because the only place the browser-target build ran was inside an e2e
// `beforeAll`, and the e2e suite **self-skips when no browser is present** — so on a CI box without Chromium
// the broken bundle was never even attempted. The `*-boot` unit tests import the same modules through Node,
// where `node:crypto` resolves fine, so they stayed green while the browser bundle was broken.
//
// This test runs the SAME browser-target esbuild the deploy build (`scripts/build-app.mjs`) runs, for every
// app that has a browser entry, but **in memory** (`write: false`) — no Chromium, no bundle files written,
// no network. So it runs in the ordinary suite on any box and fails the instant a node-only built-in (or any
// unresolvable import) reaches a browser bundle again. It is the browser-less counterpart to the e2e builds.

const ROOT = join(__dirname, '..', '..');
const APPS_DIR = join(ROOT, 'apps');

/** Every app that ships a browser entry point — discovered, so a new app is covered automatically. */
const browserApps = readdirSync(APPS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((app) => existsSync(join(APPS_DIR, app, 'src', 'browser-entry.ts')))
  .sort();

describe('the browser apps bundle — every shop screen builds for a browser (P-07, §19 delivery, hard rule #4)', () => {
  it('discovers the browser apps (guards against an empty, vacuously-passing sweep)', () => {
    expect(browserApps.length).toBeGreaterThanOrEqual(7);
    expect(browserApps).toContain('web-erp');
    expect(browserApps).toContain('pos');
  });

  it.each(browserApps)('bundles apps/%s/src/browser-entry.ts for the browser with no unresolvable imports', async (app) => {
    const entry = join(APPS_DIR, app, 'src', 'browser-entry.ts');
    // Mirror scripts/build-app.mjs exactly, but write nothing: a build error (e.g. a node:crypto import
    // reaching the browser bundle) rejects this promise, which fails the test with esbuild's own message
    // naming the offending file and import.
    await expect(
      build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: ['es2022'],
        write: false,
        sourcemap: false,
        legalComments: 'none',
        logLevel: 'silent',
      }),
    ).resolves.toBeTruthy();
  }, 30_000);
});
