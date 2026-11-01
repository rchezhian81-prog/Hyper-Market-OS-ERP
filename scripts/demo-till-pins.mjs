#!/usr/bin/env node
// The demo people's TILL PINs on the hosted demo box (Round 3). A PERSON runs it on the box, in their own terminal:
//   pnpm run demo:till-pins -- --by "<your name>" [--user <one demo person>]
//
// Bundles db/seed/pilot/run-till-pins.ts with esbuild into node_modules/.cache, then runs it. It runs the store box's own
// audited PIN command (edge/store-edge/src/till-pin-command.ts) inside the demo's edge container, once per person: each
// person types their OWN new PIN twice, hidden, at this keyboard — nobody else sees it, nothing prints or keeps it.

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'node_modules', '.cache', 'sre-seed', 'run-till-pins.mjs');

await build({
  entryPoints: [join(ROOT, 'db', 'seed', 'pilot', 'run-till-pins.ts')],
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
