#!/usr/bin/env node
// Build the DEMO store pack for the demo store box from the published price list (ADR-0016). A PERSON runs it:
//   pnpm run demo:store-pack -- --operator "<your name>"
//
// Bundles db/seed/pilot/run-store-pack.ts with esbuild (the workspace is TypeScript) into
// node_modules/.cache, then runs it. The runner holds every safety check (see db/seed/pilot/hosted.ts).

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'node_modules', '.cache', 'sre-seed', 'run-store-pack.mjs');

await build({
  entryPoints: [join(ROOT, 'db', 'seed', 'pilot', 'run-store-pack.ts')],
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
