#!/usr/bin/env node
// What a store-computer Windows service runs (ADR-0032 · CR-01 step 1) — written into each service's definition by
// `store-computer install-services`; nobody types it.
//
//   node scripts/store-computer-service.mjs api  --settings <data folder>\.env.real
//   node scripts/store-computer-service.mjs till --settings <data folder>\till\till.env
//
// It reads the settings file NOW, as the service starts, so no secret ever sits in a service definition (hard rule #4),
// and hands the program only what the container would have been handed (scripts/lib/store-computer-services.mjs,
// serviceEnv). For the API it first brings the database tables up to date (scripts/migrate.mjs — compose's `migrate`
// did the same on every start), then runs the API on this PC only. For the till it runs the store edge with this
// release's screens. A stop from Windows reaches the program as Ctrl+C, which both programs already finish cleanly on.
// It never prints a setting.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnvText } from './lib/store-computer.mjs';
import { serviceEnv } from './lib/store-computer-services.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [kind, flag, settingsPath] = process.argv.slice(2);

if ((kind !== 'api' && kind !== 'till') || flag !== '--settings' || settingsPath === undefined) {
  process.stderr.write('Usage: node scripts/store-computer-service.mjs <api|till> --settings <file>\n');
  process.exit(2);
}

let settings;
try {
  settings = parseEnvText(readFileSync(settingsPath, 'utf8'));
} catch (e) {
  process.stderr.write(`sre-${kind} service: its settings file ${settingsPath} cannot be read (${e?.code ?? 'error'}). Nothing was started.\n`);
  process.exit(78);
}

const env = serviceEnv(kind, settings, process.env, repoRoot, process.platform);
for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;

if (kind === 'api') {
  const migrated = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'migrate.mjs')], { cwd: repoRoot, env: process.env, stdio: 'inherit', windowsHide: true });
  if (migrated.error !== undefined || migrated.status !== 0) {
    process.stderr.write('sre-api service: the database tables could not be brought up to date (the lines above say why). The API was not started; Windows will try again.\n');
    process.exit(1);
  }
  await import(pathToFileURL(path.join(repoRoot, 'services', 'api', 'dist', 'start.js')).href);
} else {
  await import(pathToFileURL(path.join(repoRoot, 'edge', 'store-edge', 'dist', 'start.js')).href);
}
