#!/usr/bin/env node
// Build a backend service into a single Node module — the artifact its container runs.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// The whole codebase is TypeScript with **extensionless** ESM imports (`./main`,
// `../../../packages/…`). Every tool that reads it — `tsc`, `vitest`, esbuild — resolves those
// happily. Raw `node --experimental-strip-types` on the source tree does **not**: current Node's
// ESM resolver requires a full specifier and never appends `.ts`, so a container launched straight
// at `…/src/start.ts` dies on the first import before `main()` ever runs. For the cloud API that
// is a crash where the deployment is meant to REFUSE a bad configuration cleanly (exit 78); for
// the store edge it is a container that never comes up at all.
//
// So each service runs a built artifact, exactly as the app shells already do
// (`scripts/build-app.mjs`). esbuild bundles the workspace TypeScript — imported by relative path,
// so it is pulled in — while `packages: 'external'` keeps real npm dependencies (`pg`) required
// from `node_modules` at run time rather than inlined. The output is one plain `.js` file with the
// types stripped and every extension resolved.
//
// Usage:  node scripts/build-service.mjs <api|edge|tools>
// Output: <service>/dist/start.js  (git-ignored — `dist/` is in .gitignore)
//         `tools` bundles the operator commands (scripts/migration-load.ts, scripts/bootstrap-tenant.ts)
//         into scripts/dist/ — they import the workspace TypeScript the same way the services do.

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The services that ship as a container. Named so a Dockerfile and this script cannot drift. */
const SERVICES = {
  api: { entry: 'services/api/src/start.ts', outfile: 'services/api/dist/start.js' },
  edge: { entry: 'edge/store-edge/src/start.ts', outfile: 'edge/store-edge/dist/start.js' },
};

/** Operator commands a person runs on the box; bundled together, each to its own file. */
const TOOLS = {
  entries: ['scripts/migration-load.ts', 'scripts/bootstrap-tenant.ts', 'scripts/demo-smoke.ts'],
  outdir: 'scripts/dist',
};

const name = process.argv[2];
if (name === 'tools') {
  await build({
    entryPoints: TOOLS.entries.map((e) => join(ROOT, e)),
    outdir: join(ROOT, TOOLS.outdir),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    packages: 'external',
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'info',
  });
  console.log(`tools bundle written to ${TOOLS.outdir}/`);
  process.exit(0);
}

const service = name === undefined ? undefined : SERVICES[name];
if (service === undefined) {
  console.error(`Usage: node scripts/build-service.mjs <${Object.keys(SERVICES).join('|')}|tools>`);
  process.exit(1);
}

const ENTRY = join(ROOT, service.entry);
const OUTFILE = join(ROOT, service.outfile);
if (!existsSync(ENTRY)) {
  console.error(`No entry for "${name}" (expected ${service.entry}).`);
  process.exit(1);
}

await build({
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  // Bundle the workspace TypeScript (imported by relative path); keep npm dependencies such as
  // `pg` external so they load from node_modules, which is what the runtime image already ships.
  packages: 'external',
  // Real stack traces map back to the TypeScript source when something goes wrong at 2am.
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
});

console.log(`${name} bundle written to ${service.outfile}`);
