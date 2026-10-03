#!/usr/bin/env node
// Seed the HOSTED demo box with the synthetic `pilot-demo` dataset (runbook §8).
//
// Usage (on the box, from the repo root, stack up):
//   pnpm run seed:pilot -- --operator "<your name>"
//
// Bundles db/seed/pilot/run-hosted.ts with esbuild (the workspace is TypeScript, as for the API and
// edge builds) into node_modules/.cache — so `pg` resolves from the repo — then runs it. The runner,
// not this wrapper, holds every safety check; see db/seed/pilot/hosted.ts.

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'node_modules', '.cache', 'sre-seed', 'run-hosted.mjs');

await build({
  entryPoints: [join(ROOT, 'db', 'seed', 'pilot', 'run-hosted.ts')],
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
