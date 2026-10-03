#!/usr/bin/env node
// Publish the demo branch's signed price list to the demo store box's tills (ADR-0016). A PERSON runs it:
//   pnpm run demo:publish-pack -- --operator "<your name>"
//
// Bundles db/seed/pilot/run-publish-pack.ts with esbuild (the workspace is TypeScript) into
// node_modules/.cache, then runs it. The runner holds every safety check (see db/seed/pilot/hosted.ts).

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'node_modules', '.cache', 'sre-seed', 'run-publish-pack.mjs');

await build({
  entryPoints: [join(ROOT, 'db', 'seed', 'pilot', 'run-publish-pack.ts')],
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
