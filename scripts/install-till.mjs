#!/usr/bin/env node
// Install the one-PC till — Stage D (KL-08 / H-11 · P-01 · P-07 · hard rule #4).
//
// The in-store install runbook used to be seven manual steps: copy a settings file, fill it in, build
// three bundles, type a twelve-line environment command, keep a window open. Every one of those steps
// is a place a technician mis-types a port or forgets a key on a Saturday. This turns them into ONE
// command that a technician runs once on the shop PC:
//
//   pnpm run till:install -- --tenant <your tenant id>
//
// It checks the machine, writes the till's settings file, builds the till screen, the office screens
// and the store edge, and writes a start script for this PC's operating system — then says, in plain
// English, what to do next (double-click the start script; open the till in the browser). Re-running
// it is safe: it never overwrites a settings file that already holds a key (that key signed the packs
// this till trades on), unless told to with `--force`.
//
// ── What it deliberately does NOT do ─────────────────────────────────────────
//
//   • It never prints the signing key, and never writes a cloud token. A token is a credential a
//     person issues (`pnpm run token:store`) and puts into the settings file by hand (hard rule #4).
//   • It never invents a key when a cloud is configured: the till must trade on packs signed with the
//     SAME key the cloud signs with, so the key is COPIED from the cloud's settings file
//     (`infra/compose/.env`) when one exists. A key is generated only for an offline-only till
//     (`--generate-key`), and the output says so — that till cannot take a cloud pack until the cloud
//     is given the same key.
//   • It does not start the till. Starting is the technician's visible act, so they see the two
//     lines that matter (`lane socket on …`, `screens on …`) with their own eyes.
//
// Everything that decides something is a pure, exported helper (unit-tested); the runner at the
// bottom is a thin shell over them, and an integration test runs the whole command into a temporary
// folder and then STARTS the edge from the settings it wrote — the proof that the install works.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { parseEnv, PLACEHOLDER } from './standup-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// ── Pure helpers (unit-tested; the runner below is a thin shell over these) ───

/** The Node version this codebase needs (`package.json` engines). */
export const MIN_NODE_MAJOR = 22;

/** Is this Node new enough? `version` is `process.version` ("v22.5.0"). */
export function checkNodeVersion(version) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  if (!Number.isFinite(major)) return { ok: false, detail: `could not read the Node version from "${version}"` };
  return major >= MIN_NODE_MAJOR
    ? { ok: true, detail: `Node ${version} is new enough` }
    : { ok: false, detail: `Node ${version} is too old — this till needs Node ${MIN_NODE_MAJOR} or newer`, fix: `Install Node ${MIN_NODE_MAJOR} LTS from nodejs.org, then run this again.` };
}

/** Parse the command line into flags. Unknown flags are named, not ignored. */
export function parseArgs(argv) {
  const flags = { tenant: undefined, dir: undefined, composeEnv: undefined, lanePort: '8090', screenPort: '8091', generateKey: false, skipBuild: false, force: false, dryRun: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (a === '--tenant') flags.tenant = next();
    else if (a === '--dir') flags.dir = next();
    else if (a === '--from-compose-env') flags.composeEnv = next();
    else if (a === '--lane-port') flags.lanePort = next();
    else if (a === '--screen-port') flags.screenPort = next();
    else if (a === '--generate-key') flags.generateKey = true;
    else if (a === '--skip-build') flags.skipBuild = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else flags.unknown.push(a);
  }
  return flags;
}

const isPort = (v) => /^\d+$/.test(String(v)) && Number(v) > 0 && Number(v) < 65536;
const realValue = (v) => typeof v === 'string' && v !== '' && !v.includes(PLACEHOLDER);

/**
 * Decide the till's settings from what the technician gave, what the cloud's settings file says, and
 * what an earlier install wrote. Returns `{ ok, settings, problems, notes }` — every problem at once,
 * in words, so the technician fixes them in one pass (the same rule the API's boot check follows).
 *
 *   • tenant: `--tenant`, else the cloud settings file's `EDGE_TENANT_ID`, else the existing till.env.
 *   • signing key: the EXISTING till.env's (never rotated by an install), else the cloud settings
 *     file's `PACK_SIGNING_KEY` (the till must trade on packs the cloud signed), else — only with
 *     `--generate-key` — a fresh hex key for an offline-only till.
 *   • cloud URL: copied from the cloud settings file when it names one; the token is NEVER copied.
 */
export function planTillSettings(input) {
  const { flags, installDir, appsDir, composeEnv = undefined, existing = undefined, generatedKey = undefined } = input;
  const problems = [];
  const notes = [];

  const tenantId = flags.tenant ?? (realValue(composeEnv?.EDGE_TENANT_ID) ? composeEnv.EDGE_TENANT_ID : undefined) ?? existing?.EDGE_TENANT_ID;
  if (!realValue(tenantId)) problems.push('no tenant id: pass --tenant <id>, or fill EDGE_TENANT_ID in the cloud settings file (infra/compose/.env)');

  let signingKey;
  if (realValue(existing?.PACK_SIGNING_KEY)) {
    signingKey = existing.PACK_SIGNING_KEY;
    notes.push('kept the signing key this till already had — an install never rotates it');
  } else if (realValue(composeEnv?.PACK_SIGNING_KEY)) {
    signingKey = composeEnv.PACK_SIGNING_KEY;
    notes.push('copied the pack signing key from the cloud settings file, so this till trades on the packs the cloud signs');
  } else if (flags.generateKey) {
    signingKey = generatedKey ?? randomBytes(32).toString('hex');
    notes.push('GENERATED a signing key for an OFFLINE-ONLY till — a cloud must be given this same key before this till can take a cloud pack');
  } else {
    problems.push('no pack signing key: point at the cloud settings file (--from-compose-env infra/compose/.env, filled in), or pass --generate-key for an offline-only till');
  }
  if (signingKey !== undefined && signingKey.length < 32) problems.push('the pack signing key is shorter than 32 characters — the edge refuses to start on it');

  if (!isPort(flags.lanePort)) problems.push(`--lane-port must be a port number (got "${flags.lanePort}")`);
  if (!isPort(flags.screenPort)) problems.push(`--screen-port must be a port number (got "${flags.screenPort}")`);
  if (isPort(flags.lanePort) && isPort(flags.screenPort) && flags.lanePort === flags.screenPort) problems.push('the lane port and the screen port must differ');
  if (flags.lanePort !== '8090') notes.push(`lane port ${flags.lanePort}: the till screen posts to 8090 by default — only change this if the screen is told the same port`);

  const cloudUrl = realValue(composeEnv?.CLOUD_API_URL) ? composeEnv.CLOUD_API_URL : (existing?.CLOUD_API_URL ?? '');
  if (cloudUrl === '') notes.push('no cloud URL set — the till starts OFFLINE-FIRST: it sells, saves every sale to disk and queues it; turn sync on later by filling CLOUD_API_URL and CLOUD_API_TOKEN');

  const settings = {
    EDGE_DATA_DIR: join(installDir, 'edge-data'),
    EDGE_TENANT_ID: tenantId ?? '',
    PACK_SIGNING_KEY: signingKey ?? '',
    EDGE_CAPACITY_BYTES: existing?.EDGE_CAPACITY_BYTES ?? '10737418240',
    EDGE_LANE_PORT: String(flags.lanePort),
    EDGE_SCREEN_PORT: String(flags.screenPort),
    EDGE_APPS_DIR: appsDir,
    CLOUD_API_URL: cloudUrl,
    // Never copied from anywhere. A person issues a token and puts it here by hand (hard rule #4).
    CLOUD_API_TOKEN: existing?.CLOUD_API_TOKEN ?? '',
  };
  return { ok: problems.length === 0, settings, problems, notes };
}

/** The settings file, with a comment per line a technician can read. Values are unquoted so the same
 *  file loads in sh (`set -a; . till.env`), in cmd (`for /f … delims==`) and in the readiness check. */
export function renderTillEnv(settings) {
  return [
    '# SRE Retail OS — this till\'s settings. Written by `pnpm run till:install`. Keep this file on this PC only;',
    '# it holds the pack signing key and, once you issue one, the cloud token (hard rule #4).',
    '',
    '# Where this till keeps every sale, refund and queue on disk. Back it up (docs/runbooks/backup-and-recovery.md).',
    `EDGE_DATA_DIR=${settings.EDGE_DATA_DIR}`,
    '# Which shop this till belongs to.',
    `EDGE_TENANT_ID=${settings.EDGE_TENANT_ID}`,
    '# Signs the price list this till trades on. Must be the SAME key the cloud signs packs with.',
    `PACK_SIGNING_KEY=${settings.PACK_SIGNING_KEY}`,
    '# How much disk the till may use for locally-saved work (10 GiB = days of trading with no line).',
    `EDGE_CAPACITY_BYTES=${settings.EDGE_CAPACITY_BYTES}`,
    '# The loopback socket the till screen saves sales to. The screen posts to 8090 — leave it.',
    `EDGE_LANE_PORT=${settings.EDGE_LANE_PORT}`,
    '# The loopback port the till and office screens are served from: open http://127.0.0.1:<port>/pos/',
    `EDGE_SCREEN_PORT=${settings.EDGE_SCREEN_PORT}`,
    '# Where the screens live on this PC.',
    `EDGE_APPS_DIR=${settings.EDGE_APPS_DIR}`,
    '# OPTIONAL — leave both blank and the till still sells and queues (offline-first). Fill both to sync to the cloud.',
    `CLOUD_API_URL=${settings.CLOUD_API_URL}`,
    '# Issue with `pnpm run token:store` and paste here by hand. Never share it; never commit this file.',
    `CLOUD_API_TOKEN=${settings.CLOUD_API_TOKEN}`,
    '',
  ].join('\n');
}

/** The start script for this PC's operating system. Loads till.env, then runs the built edge. */
export function renderStartScript(platform, input) {
  const entry = join(input.repoRoot, 'edge', 'store-edge', 'dist', 'start.js');
  if (platform === 'win32') {
    return [
      '@echo off',
      'rem SRE Retail OS — start this till (the store edge: the save socket + the screens). Written by till:install.',
      'rem Loads till.env from this folder, then runs the built edge. Leave this window open while the shop trades.',
      'for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0till.env") do set "%%A=%%B"',
      `node "${entry}"`,
      'pause',
      '',
    ].join('\r\n');
  }
  return [
    '#!/usr/bin/env sh',
    '# SRE Retail OS — start this till (the store edge: the save socket + the screens). Written by till:install.',
    '# Loads till.env from this folder, then runs the built edge. Leave this terminal open while the shop trades.',
    'set -e',
    'HERE="$(cd "$(dirname "$0")" && pwd)"',
    'set -a; . "$HERE/till.env"; set +a',
    `exec node "${entry}"`,
    '',
  ].join('\n');
}

/** A systemd user unit, for a Linux shop PC that should start the till at login without a window. Optional. */
export function renderSystemdUnit(input) {
  return [
    '[Unit]',
    'Description=SRE Retail OS till (store edge)',
    'After=network.target',
    '',
    '[Service]',
    `EnvironmentFile=${join(input.installDir, 'till.env')}`,
    `ExecStart=/usr/bin/env node ${join(input.repoRoot, 'edge', 'store-edge', 'dist', 'start.js')}`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The build commands the install runs, in order — named so the dry run and the test can list them. */
export const BUILD_STEPS = Object.freeze([
  { name: 'the till screen', args: ['scripts/build-app.mjs', 'pos'] },
  { name: 'the office screens', args: ['scripts/build-app.mjs', 'web-erp'] },
  { name: 'the store edge', args: ['scripts/build-service.mjs', 'edge'] },
]);

/** What the technician does next, in plain English. Never includes the key or a token. */
export function renderNextSteps(input) {
  const { settings, installDir, platform } = input;
  const start = platform === 'win32' ? 'start-till.cmd' : 'start-till.sh';
  const lines = [
    '',
    'Till installed.',
    '─'.repeat(44),
    `Settings:       ${join(installDir, 'till.env')}`,
    `Sales on disk:  ${settings.EDGE_DATA_DIR}`,
    `Start script:   ${join(installDir, start)}`,
    '',
    'Next:',
    `  1. Start the till: ${platform === 'win32' ? `double-click ${start}` : `run ${join(installDir, start)}`}`,
    '     It prints "lane socket on 127.0.0.1:' + settings.EDGE_LANE_PORT + '" and "screens on 127.0.0.1:' + settings.EDGE_SCREEN_PORT + '". Leave it running.',
    `  2. Open the till in a browser on THIS PC: http://127.0.0.1:${settings.EDGE_SCREEN_PORT}/pos/`,
    '  3. Ring a sale and take cash — the receipt number appears once the sale is on this PC\'s disk.',
    '  4. Pull the network cable and ring another — it still completes; the unsent counter goes up. Nothing is lost.',
    `  5. Check the pieces: pnpm run standup:check   (reads ${join(installDir, 'till.env')})`,
  ];
  if (settings.CLOUD_API_URL === '') {
    lines.push('', 'This till is OFFLINE-FIRST for now (no cloud URL). To sync to the books later: issue a store token');
    lines.push('(pnpm run token:store), then fill CLOUD_API_URL and CLOUD_API_TOKEN in till.env and restart the till.');
  } else {
    lines.push('', `Sync target: ${settings.CLOUD_API_URL}. Fill CLOUD_API_TOKEN in till.env (pnpm run token:store) before starting, or the till runs offline-first.`);
  }
  if (platform !== 'win32') lines.push('', `Optional (Linux, start at login): copy ${join(installDir, 'sre-till.service')} to ~/.config/systemd/user/ and run: systemctl --user enable --now sre-till`);
  return lines.join('\n');
}

// ── The runner ───────────────────────────────────────────────────────────────

async function readEnvFile(path) {
  try { return parseEnv(await readFile(path, 'utf8')); } catch { return undefined; }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.unknown.length > 0) {
    process.stderr.write(`Unknown option(s): ${flags.unknown.join(' ')}\nUsage: node scripts/install-till.mjs [--tenant <id>] [--dir <folder>] [--from-compose-env <file>] [--lane-port 8090] [--screen-port 8091] [--generate-key] [--skip-build] [--force] [--dry-run]\n`);
    process.exitCode = 64; // EX_USAGE
    return;
  }

  const node = checkNodeVersion(process.version);
  if (!node.ok) {
    process.stderr.write(`\n✕ ${node.detail}\n  Fix: ${node.fix}\n\n`);
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  const installDir = resolve(flags.dir ?? join(REPO, 'till'));
  const appsDir = join(REPO, 'apps');
  const composePath = flags.composeEnv !== undefined ? resolve(flags.composeEnv) : join(REPO, 'infra', 'compose', '.env');
  const composeEnv = await readEnvFile(composePath);
  const envPath = join(installDir, 'till.env');
  const existing = await readEnvFile(envPath);

  const plan = planTillSettings({ flags, installDir, appsDir, composeEnv, existing });
  if (!plan.ok) {
    process.stderr.write(`\nThe till cannot be installed yet — ${plan.problems.length} problem(s):\n${plan.problems.map((p) => `  ✕ ${p}`).join('\n')}\n\n`);
    process.exitCode = 78;
    return;
  }
  for (const note of plan.notes) process.stdout.write(`• ${note}\n`);

  if (existing !== undefined && !flags.force) {
    // An earlier install wrote settings. Rebuilding is fine; rewriting the file is not, unless asked.
    process.stdout.write(`• ${envPath} already exists — kept as it is (pass --force to rewrite it)\n`);
  }

  if (flags.dryRun) {
    process.stdout.write(`\nDry run — would write ${envPath}, start scripts in ${installDir}, and build: ${BUILD_STEPS.map((s) => s.name).join(', ')}.\n`);
    return;
  }

  await mkdir(plan.settings.EDGE_DATA_DIR, { recursive: true });
  if (existing === undefined || flags.force) {
    await writeFile(envPath, renderTillEnv(plan.settings), { mode: 0o600 });
    await chmod(envPath, 0o600);
    process.stdout.write(`• wrote ${envPath}\n`);
  }

  const sh = join(installDir, 'start-till.sh');
  await writeFile(sh, renderStartScript('linux', { repoRoot: REPO }), { mode: 0o755 });
  await chmod(sh, 0o755);
  await writeFile(join(installDir, 'start-till.cmd'), renderStartScript('win32', { repoRoot: REPO }));
  await writeFile(join(installDir, 'sre-till.service'), renderSystemdUnit({ installDir, repoRoot: REPO }));
  process.stdout.write(`• wrote start scripts in ${installDir}\n`);

  if (!flags.skipBuild) {
    for (const step of BUILD_STEPS) {
      process.stdout.write(`• building ${step.name}…\n`);
      execFileSync(process.execPath, step.args.map((a) => (isAbsolute(a) ? a : join(REPO, a))).map((a, i) => (i === 0 ? a : step.args[i])), { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
    }
  } else {
    process.stdout.write('• build skipped (--skip-build)\n');
  }

  process.stdout.write(`${renderNextSteps({ settings: plan.settings, installDir, platform: process.platform })}\n`);
}

// Run only when invoked directly, so the pure helpers can be imported by tests without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
