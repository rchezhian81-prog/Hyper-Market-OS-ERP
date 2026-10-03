#!/usr/bin/env node
// Hosted demo — authenticated browser workflow check (runbook §9.1). Run on the box:
//   pnpm run check:browser -- --base https://<demo-host> [--out DIR]
// Bundles infra/pilot/browser-check/check.ts with esbuild (the workspace is TypeScript) into
// node_modules/.cache — so playwright-core resolves from the repo — then runs it. Needs Chromium:
//   npx playwright-core install --with-deps chromium

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'node_modules', '.cache', 'sre-pilot', 'browser-check.mjs');

await build({
  entryPoints: [join(ROOT, 'infra', 'pilot', 'browser-check', 'check.ts')],
  outfile: OUT, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', logLevel: 'warning',
});

const args = process.argv.slice(2).filter((a) => a !== '--');
const run = spawnSync(process.execPath, [OUT, ...args], { cwd: ROOT, stdio: 'inherit' });
process.exit(run.status ?? 1);
