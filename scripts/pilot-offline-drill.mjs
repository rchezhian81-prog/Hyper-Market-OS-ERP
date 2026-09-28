#!/usr/bin/env node
// Hosted demo — offline/reconnect + concurrent tills drill (runbook §9.4). Run on the box:
//   pnpm run drill:offline   (stops the demo API for a few minutes)
// Bundles infra/pilot/offline-drill/drill.ts with esbuild (the workspace is TypeScript) into
// node_modules/.cache, then runs it.

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'node_modules', '.cache', 'sre-pilot', 'offline-drill.mjs');

await build({
  entryPoints: [join(ROOT, 'infra', 'pilot', 'offline-drill', 'drill.ts')],
  outfile: OUT, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', logLevel: 'warning',
});

const args = process.argv.slice(2).filter((a) => a !== '--');
const run = spawnSync(process.execPath, [OUT, ...args], { cwd: ROOT, stdio: 'inherit' });
process.exit(run.status ?? 1);
