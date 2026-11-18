#!/usr/bin/env node
// What a store-computer Windows service runs (ADR-0032 · CR-01 step 1) — written into each service's definition by
// `store-computer install-services`; nobody types it.
//
//   node scripts/store-computer-service.mjs api  --settings <data folder>\.env.real
//   node scripts/store-computer-service.mjs till --settings <data folder>\till\till.env
//   node scripts/store-computer-service.mjs remote-link --settings <data folder>\remote-link\remote-link.json  (OB-840)
//
// It reads the settings file NOW, as the service starts, so no secret ever sits in a service definition (hard rule #4),
// and hands the program only what the container would have been handed (scripts/lib/store-computer-services.mjs,
// serviceEnv). For the API it first brings the database tables up to date (scripts/migrate.mjs — compose's `migrate`
// did the same on every start), then runs the API on this PC only. For the till it runs the store edge with this
// release's screens. A stop from Windows reaches the program as Ctrl+C, which both programs already finish cleanly on.
// It never prints a setting.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnvText } from './lib/store-computer.mjs';
import { serviceEnv } from './lib/store-computer-services.mjs';
import { readLinkSettings, runRemoteLink } from './lib/store-computer-remote.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [kind, flag, settingsPath] = process.argv.slice(2);

if ((kind !== 'api' && kind !== 'till' && kind !== 'remote-link') || flag !== '--settings' || settingsPath === undefined) {
  process.stderr.write('Usage: node scripts/store-computer-service.mjs <api|till|remote-link> --settings <file>\n');
  process.exit(2);
}

// OB-840 · ADR-0035: the owner's remote link — Windows' own ssh.exe dialling OUT to the relay, again and again, with the
// line's state in its status file for Today. Its settings are paths and a host name only; no secret is read here.
if (kind === 'remote-link') {
  let cfg;
  try { cfg = readLinkSettings(readFileSync(settingsPath, 'utf8')); } catch { cfg = undefined; }
  if (cfg === undefined) {
    process.stderr.write(`sre-remote-link service: its settings file ${settingsPath} cannot be read. Run: store-computer remote-access setup. Nothing was started.\n`);
    process.exit(78);
  }
  let stopped = false;
  let child;
  let wake;
  const stop = () => { stopped = true; wake?.(); try { child?.kill(); } catch { /* already gone */ } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await runRemoteLink({
    fs: { writeFileSync },
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; }),
    stopped: () => stopped,
    every: (ms, fn) => { const t = setInterval(fn, ms); return { cancel: () => clearInterval(t) }; },
    say: (line) => { process.stdout.write(`${new Date().toISOString()}  ${line}\n`); },
    runSsh: (program, args, onLine) => new Promise((resolve) => {
      child = spawn(program, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
      let rest = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const parts = (rest + chunk).split(/\r?\n/);
        rest = parts.pop() ?? '';
        // ssh's own -v words go to the service's log only when they matter (the line, a refusal); never a key.
        for (const l of parts) { onLine(l); if (/forward|denied|refused|failed|timed out|unreachable|verification|Authenticated|closed/i.test(l)) process.stdout.write(`${new Date().toISOString()}  ssh: ${l}\n`); }
      });
      child.on('error', () => { resolve(-1); });
      child.on('exit', (code) => { resolve(code ?? -1); });
    }),
  }, cfg);
  process.exit(0);
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
