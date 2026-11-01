#!/usr/bin/env node
// A FRESH SEED of the hosted DEMO copy only (Round 3). A PERSON runs it on the demo box:
//   pnpm run demo:reseed -- --operator "<your name>" --this-is-the-demo pilot-demo
//
// Bundles db/seed/pilot/run-reseed.ts with esbuild (the workspace is TypeScript) into node_modules/.cache, then runs it.
// The runner holds every refusal (db/seed/pilot/reseed.ts): not the demo tenant, production-marked, no operator, not
// confirmed, or a ledger holding any other tenant — refused, nothing changed.

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'node_modules', '.cache', 'sre-seed', 'run-reseed.mjs');

await build({
  entryPoints: [join(ROOT, 'db', 'seed', 'pilot', 'run-reseed.ts')],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
});

const args = process.argv.slice(2).filter((a) => a !== '--');
const run = spawnSync(process.execPath, [OUT, ...args], { cwd: ROOT, stdio: 'inherit' });
process.exit(run.status ?? 1);
