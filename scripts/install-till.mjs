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
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path, { dirname, join, resolve, isAbsolute } from 'node:path';
import { parseEnv, PLACEHOLDER } from './standup-check.mjs';
import { buildStoreToken } from './issue-store-token.mjs';

/**
 * The store computer's DATA FOLDER (audit row 9 · C-12): when the settings file named with --settings sits in a folder
 * holding this note (written by `store-computer prepare` / `migrate-data-folder`), the till's settings and data go in
 * that folder's `till` subfolder — outside the release folder, so a new release never replaces them. The start scripts
 * stay in this release's own till folder and read the till's settings from there. Same name as scripts/lib/store-computer.mjs.
 */
export const DATA_MARKER = 'THIS-IS-THE-SHOP-DATA-FOLDER.txt';

/**
 * Where the till's settings (till.env), its data (edge-data) and its bill-number witness go:
 * `--dir`, else `--data-dir`, else `<the data folder>/till` when --settings is in the store computer's data folder, else
 * this release's own `till` folder (as before). Returns { installDir, dataFolder } — dataFolder set only in the data folder.
 */
export function tillInstallDir({ flags, repoRoot, exists = existsSync }) {
  if (flags.dir !== undefined) return { installDir: resolve(flags.dir) };
  if (flags.dataDir !== undefined) return { installDir: resolve(flags.dataDir) };
  if (flags.composeEnv !== undefined) {
    const folder = dirname(resolve(flags.composeEnv));
    if (exists(join(folder, DATA_MARKER))) return { installDir: join(folder, 'till'), dataFolder: folder };
  }
  return { installDir: join(repoRoot, 'till') };
}

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
  const flags = { tenant: undefined, lane: undefined, store: undefined, dir: undefined, dataDir: undefined, composeEnv: undefined, settingsNamed: false, lanePort: '8090', screenPort: '8091', generateKey: false, skipBuild: false, force: false, dryRun: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return argv[i]; };
    // Gap W-1: pnpm 10 hands a typed `--` on to the script (`pnpm run till:install -- --lane lane-1`). It only means "the
    // options start here", never an option of its own, so it is skipped — the runbooks show that form.
    if (a === '--') continue;
    if (a === '--tenant') flags.tenant = next();
    // Gap W-5: the store this till serves, as head office knows it. With the store computer's own settings file it also
    // connects the till to this copy's books: the address, a store token and "take the store setup from head office".
    else if (a === '--store') flags.store = next();
    else if (a === '--lane') flags.lane = next();
    else if (a === '--dir') flags.dir = next();
    // Audit row 9: the till's settings and data in a folder of their own, outside the release (the data folder's `till`).
    else if (a === '--data-dir') flags.dataDir = next();
    else if (a === '--from-compose-env') flags.composeEnv = next();
    // Gap G-RD-3: the same, under the name every newer command uses — `--settings infra/compose/.env.real` on the store
    // computer's real-data copy. Named on purpose, so a file that cannot be read is a problem, never a silent fall-back.
    else if (a === '--settings') { flags.composeEnv = next(); flags.settingsNamed = true; }
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
  const { flags, installDir, appsDir, composeEnv = undefined, existing = undefined, generatedKey = undefined, statusFile = undefined, realCopy = false, mintStoreToken = undefined } = input;
  const problems = [];
  const notes = [];

  if (flags.settingsNamed === true && composeEnv === undefined) {
    problems.push(`the settings file named with --settings could not be read${flags.composeEnv === undefined ? ' (no file was named after it)' : ` (${flags.composeEnv})`} — check the path, for example infra/compose/.env.real`);
  }

  const tenantId = flags.tenant ?? (realValue(composeEnv?.EDGE_TENANT_ID) ? composeEnv.EDGE_TENANT_ID : undefined) ?? existing?.EDGE_TENANT_ID;
  if (!realValue(tenantId)) problems.push('no tenant id: pass --tenant <id>, or fill EDGE_TENANT_ID in the cloud settings file (infra/compose/.env)');

  // Which lane THIS till is (SP-4b · F09). Every sale it rings names the lane, so the lane must be a real, chosen name —
  // `--lane`, else what an earlier install wrote. Never a default: two tills defaulting to the same lane would be one lane
  // on paper and two in the shop.
  const laneId = flags.lane ?? existing?.EDGE_LANE_ID;
  if (!realValue(laneId)) problems.push('no lane id: pass --lane <id> (for example lane-1) — every sale this till rings names the lane it was rung on');

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

  // Gap W-5: the store this till serves — named with --store, or kept from an earlier install. On the store computer's own
  // real-data copy (`--settings …\.env.real`) naming the store also CONNECTS the till to this copy's books: the address is
  // this PC's own API port (the tool writes it — the owner never types an address), the store token is made here from the
  // copy's own signing key and written straight into till.env (never shown, never printed), and the box takes its store
  // setup from head office. Before the store exists at head office nothing is connected: the till stays offline-first.
  const storeId = flags.store ?? existing?.EDGE_STORE_ID;
  if (flags.store !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(flags.store))) problems.push(`--store must be the store's id as head office knows it (letters, digits, ".", "_" or "-"), got "${flags.store}"`);
  const connect = realCopy && flags.store !== undefined;
  let cloudUrl = realValue(composeEnv?.CLOUD_API_URL) ? composeEnv.CLOUD_API_URL : (existing?.CLOUD_API_URL ?? '');
  let token = existing?.CLOUD_API_TOKEN ?? '';
  if (connect) {
    const port = realValue(composeEnv?.API_PORT) ? composeEnv.API_PORT : '8081';
    if (!isPort(port)) problems.push(`the settings file's API_PORT is not a port number ("${port}")`);
    cloudUrl = `http://127.0.0.1:${port}`;
    const minted = mintStoreToken === undefined ? { problem: 'there is no way to make the store token here' } : mintStoreToken(flags.store);
    if (minted.problem !== undefined) problems.push(`the store token could not be made: ${minted.problem}`);
    else {
      token = minted.token;
      notes.push(`connected to this copy's books for store ${flags.store}: a NEW store token (the store-edge sign-in, locked to store ${flags.store}, ${STORE_TOKEN_HOURS / 24} days) was written into till.env — it is never shown`);
    }
  } else if (flags.store !== undefined) {
    notes.push(`store ${flags.store} written; no store token is made here (only with the store computer's own settings file, --settings …\\.env.real) — issue one with pnpm run token:store`);
  }
  if (cloudUrl === '') notes.push('no cloud URL set — the till starts OFFLINE-FIRST: it sells, saves every sale to disk and queues it; turn sync on later by filling CLOUD_API_URL and CLOUD_API_TOKEN');

  const settings = {
    EDGE_DATA_DIR: join(installDir, 'edge-data'),
    // OB-87: the bill-number witness, OUTSIDE edge-data so a backup of edge-data never carries it (a restore is then seen).
    EDGE_WITNESS_DIR: join(installDir, 'edge-witness'),
    EDGE_TENANT_ID: tenantId ?? '',
    EDGE_LANE_ID: laneId ?? '',
    PACK_SIGNING_KEY: signingKey ?? '',
    EDGE_CAPACITY_BYTES: existing?.EDGE_CAPACITY_BYTES ?? '10737418240',
    EDGE_LANE_PORT: String(flags.lanePort),
    EDGE_SCREEN_PORT: String(flags.screenPort),
    EDGE_APPS_DIR: appsDir,
    CLOUD_API_URL: cloudUrl,
    // Never copied from anywhere: kept from an earlier install, or (W-5, the store computer's own copy) made here for this
    // store from the copy's own signing key. A cloud settings file's token never travels (hard rule #4).
    CLOUD_API_TOKEN: token,
    // Audit row 6: on the store computer, the file its own check writes — the office screens show its red banner.
    ...(statusFile !== undefined ? { EDGE_STORE_COMPUTER_STATUS_FILE: statusFile } : existing?.EDGE_STORE_COMPUTER_STATUS_FILE !== undefined ? { EDGE_STORE_COMPUTER_STATUS_FILE: existing.EDGE_STORE_COMPUTER_STATUS_FILE } : {}),
    // W-5: the store, and "take this store's setup from head office", whenever a store is named.
    ...(realValue(storeId) ? { EDGE_STORE_ID: storeId, EDGE_STORE_PACK_SOURCE: 'head-office' } : {}),
    // OB-252: the real copy takes guest sales only — no customer mobile number, no loyalty — whatever the setup says.
    ...(realCopy || existing?.EDGE_GUEST_SALES_ONLY === '1' ? { EDGE_GUEST_SALES_ONLY: '1' } : {}),
    // OB-248 · OB-256: the real copy runs the MIRROR PILOT — the old ERP bills every customer; this till records the same
    // lines "Paid on old system" with the old bill number (OB-264). Always together with guest sales only: the box refuses
    // to start with the mirror on and guest-only off, and `mirrorSettingsProblem` refuses to write a real till without both.
    ...(realCopy || existing?.EDGE_MIRROR_PILOT === '1' ? { EDGE_MIRROR_PILOT: '1' } : {}),
    // OB-259: the office screens this PC serves ask for the person's own till PIN; a till-only role opens only the till.
    EDGE_OFFICE_SIGN_IN: 'pin',
  };
  if (realCopy) notes.push('guest sales only (OB-252): the till takes no customer mobile number and no loyalty');
  if (realCopy) notes.push('mirror pilot (OB-248 · OB-256): every sale and refund is "Paid on old system", with the old bill number (OB-264); no money in this drawer');
  return { ok: problems.length === 0, settings, problems, notes };
}

/**
 * OB-248 · OB-252 — the store computer's REAL copy is the mirror pilot, and the mirror pilot is guest sales only. The till's
 * settings as they will stand after this run (a new file, or an existing one with this run's changes) must say BOTH
 * `EDGE_MIRROR_PILOT=1` and `EDGE_GUEST_SALES_ONLY=1`; otherwise nothing is written and the reason is given. Undefined =
 * fine. Outside the real copy there is no rule here (the demo and a rehearsal till keep their own settings).
 */
export function mirrorSettingsProblem({ realCopy, finalSettings }) {
  if (!realCopy) return undefined;
  const missing = ['EDGE_MIRROR_PILOT', 'EDGE_GUEST_SALES_ONLY'].filter((k) => String(finalSettings?.[k] ?? '').trim() !== '1');
  if (missing.length === 0) return undefined;
  return `this is the store computer's real copy, which runs the mirror pilot with guest sales only (OB-248, OB-252), but the till's settings would not say ${missing.map((k) => `${k}=1`).join(' and ')}. Nothing was written. If till.env says otherwise, it was changed by hand: run the install again with --force to write it whole`;
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
    '# The bill-number witness: OUTSIDE edge-data, never backed up with it, never restored over. If this till\'s edge-data is',
    '# restored from a backup, the witness shows it and the till numbers under a brand-new prefix until head office answers.',
    `EDGE_WITNESS_DIR=${settings.EDGE_WITNESS_DIR}`,
    '# Which shop this till belongs to.',
    `EDGE_TENANT_ID=${settings.EDGE_TENANT_ID}`,
    '# Which LANE this till is. Every sale it rings names this lane; the cashier signs in with their staff code.',
    `EDGE_LANE_ID=${settings.EDGE_LANE_ID}`,
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
    ...(settings.EDGE_STORE_COMPUTER_STATUS_FILE === undefined ? [] : [
      "# The store computer's own check (store-computer status) writes this file; the office screens show its red banner.",
      `EDGE_STORE_COMPUTER_STATUS_FILE=${settings.EDGE_STORE_COMPUTER_STATUS_FILE}`,
    ]),
    ...(settings.EDGE_STORE_ID === undefined ? [] : [
      "# The store this till serves, as head office knows it; the box takes that store's setup from head office.",
      `EDGE_STORE_ID=${settings.EDGE_STORE_ID}`,
      `EDGE_STORE_PACK_SOURCE=${settings.EDGE_STORE_PACK_SOURCE}`,
    ]),
    ...(settings.EDGE_GUEST_SALES_ONLY === undefined ? [] : [
      '# OB-252: guest sales only — the till takes no customer mobile number and no loyalty.',
      `EDGE_GUEST_SALES_ONLY=${settings.EDGE_GUEST_SALES_ONLY}`,
    ]),
    ...(settings.EDGE_MIRROR_PILOT === undefined ? [] : [
      '# OB-248 · OB-256: the mirror pilot — every sale and refund is "Paid on old system", with the old bill number (OB-264).',
      '# Always with EDGE_GUEST_SALES_ONLY=1: the till refuses to start with this on and guest sales only off.',
      `EDGE_MIRROR_PILOT=${settings.EDGE_MIRROR_PILOT}`,
    ]),
    ...(settings.EDGE_OFFICE_SIGN_IN === undefined ? [] : [
      "# OB-259: the office screens ask for the person's own till PIN; a cashier opens only the till.",
      `EDGE_OFFICE_SIGN_IN=${settings.EDGE_OFFICE_SIGN_IN}`,
    ]),
    '',
  ].join('\n');
}

/** How long a store token the installer makes lasts — the same 30 days `token:store` gives by default. */
export const STORE_TOKEN_HOURS = 720;
/** What a connect (W-5) or a newer install may add to or change in an existing till.env — never the key, the lane or the folders. */
export const CONNECT_KEYS = Object.freeze(['CLOUD_API_URL', 'CLOUD_API_TOKEN', 'EDGE_STORE_ID', 'EDGE_STORE_PACK_SOURCE', 'EDGE_GUEST_SALES_ONLY', 'EDGE_MIRROR_PILOT', 'EDGE_OFFICE_SIGN_IN']);

/**
 * An existing till.env with the connect keys set from the plan, in place; every other line is kept exactly as it was (the
 * signing key, the lane, the folders, the comments). Returns the new text and the NAMES that changed — never their values.
 */
export function updateTillEnv(text, settings) {
  const want = Object.fromEntries(CONNECT_KEYS.filter((k) => settings[k] !== undefined).map((k) => [k, String(settings[k])]));
  const changed = [];
  const done = new Set();
  const out = String(text).split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) return raw;
    const k = line.slice(0, line.indexOf('=')).trim();
    if (!(k in want)) return raw;
    done.add(k);
    if (line.slice(line.indexOf('=') + 1).trim() === want[k]) return raw;
    changed.push(k);
    return `${k}=${want[k]}`;
  });
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  for (const k of Object.keys(want)) if (!done.has(k)) { out.push(`${k}=${want[k]}`); changed.push(k); }
  return { text: `${out.join('\n')}\n`, changed };
}

/**
 * What a run changes in a till.env that is already there (and not --force): with --store, every connect key the plan
 * sets (W-5); otherwise only the guest-sales and office sign-in settings, and only where the file has none yet — so an
 * update or a re-run never rewrites the address or the token by surprise.
 */
export function tillEnvChangesFor({ settings, existing, flags }) {
  if (flags.store !== undefined) return Object.fromEntries(CONNECT_KEYS.filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]]));
  return Object.fromEntries(['EDGE_GUEST_SALES_ONLY', 'EDGE_MIRROR_PILOT', 'EDGE_OFFICE_SIGN_IN'].filter((k) => settings[k] !== undefined && existing?.[k] === undefined).map((k) => [k, settings[k]]));
}

/**
 * Is this settings file the store computer's own real-data copy? Its name (`.env.real`, gap G-RD-3) or the shop's data
 * folder note beside it says so — the two places `store-computer prepare` writes it.
 */
export function isRealCopySettings(composePath, exists = existsSync) {
  if (composePath === undefined) return false;
  const file = resolve(composePath);
  return path.basename(file) === '.env.real' || exists(join(dirname(file), DATA_MARKER));
}

/** The store computer's store token for one store: the store-edge sign-in, locked to that store (OB-54), from the copy's own key. */
export function storeTokenMinter(composeEnv, nowMs = Date.now()) {
  return (storeId) => {
    const missing = ['IDP_SIGNING_KEY', 'IDP_ISSUER', 'IDP_AUDIENCE', 'EDGE_TENANT_ID'].filter((k) => !realValue(composeEnv?.[k]));
    if (missing.length > 0) return { problem: `the settings file has no ${missing.join(', ')}` };
    const policy = { secret: composeEnv.IDP_SIGNING_KEY, issuer: composeEnv.IDP_ISSUER, audience: composeEnv.IDP_AUDIENCE };
    return { token: buildStoreToken({ sub: 'store-edge', tenantId: composeEnv.EDGE_TENANT_ID, storeId, ttlSeconds: STORE_TOKEN_HOURS * 3600 }, policy, nowMs) };
  };
}

/**
 * The start script for this PC's operating system. Loads till.env, then runs the built edge.
 * `tillEnvPath` (the store computer's data folder, audit row 9): the till's settings are read from there, not from the
 * script's own folder, and the screens are THIS release's (EDGE_APPS_DIR set after the settings are read), so a new
 * release's start script runs the new screens on the same till data.
 */
export function renderStartScript(platform, input) {
  const p = input.platformPath ?? (platform === 'win32' ? path.win32 : path.posix);
  const entry = (input.platformPath === undefined ? join : p.join)(input.repoRoot, 'edge', 'store-edge', 'dist', 'start.js');
  const apps = (input.platformPath === undefined ? join : p.join)(input.repoRoot, 'apps');
  const outside = input.tillEnvPath !== undefined;
  if (platform === 'win32') {
    return [
      '@echo off',
      'rem SRE Retail OS — start this till (the store edge: the save socket + the screens). Written by till:install.',
      outside ? 'rem Loads till.env from the shop\'s data folder, then runs this release\'s built edge. Leave this window open while the shop trades.'
        : 'rem Loads till.env from this folder, then runs the built edge. Leave this window open while the shop trades.',
      ...(outside ? ['rem If the till was started automatically at sign-in (store-computer autostart), do NOT start it here as well.'] : []),
      `for /f "usebackq eol=# tokens=1,* delims==" %%A in ("${outside ? input.tillEnvPath : '%~dp0till.env'}") do set "%%A=%%B"`,
      ...(outside ? [`set "EDGE_APPS_DIR=${apps}"`] : []),
      'rem With arguments it runs an administrator command instead, e.g. issuing a till PIN: start-till.cmd till-pin --user <staff id> --by "<name>"',
      `node "${entry}" %*`,
      'pause',
      '',
    ].join('\r\n');
  }
  return [
    '#!/usr/bin/env sh',
    '# SRE Retail OS — start this till (the store edge: the save socket + the screens). Written by till:install.',
    outside ? "# Loads till.env from the shop's data folder, then runs this release's built edge. Leave this terminal open while the shop trades."
      : '# Loads till.env from this folder, then runs the built edge. Leave this terminal open while the shop trades.',
    'set -e',
    'HERE="$(cd "$(dirname "$0")" && pwd)"',
    `set -a; . "${outside ? input.tillEnvPath : '$HERE/till.env'}"; set +a`,
    ...(outside ? [`EDGE_APPS_DIR="${apps}"; export EDGE_APPS_DIR`] : []),
    '# With arguments it runs an administrator command instead, e.g. issuing a till PIN: start-till.sh till-pin --user <staff id> --by "<name>"',
    `exec node "${entry}" "$@"`,
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
  const scriptsDir = input.scriptsDir ?? installDir;
  const start = platform === 'win32' ? 'start-till.cmd' : 'start-till.sh';
  const lines = [
    '',
    'Till installed.',
    '─'.repeat(44),
    `Settings:       ${join(installDir, 'till.env')}`,
    `Sales on disk:  ${settings.EDGE_DATA_DIR}`,
    `Start script:   ${join(scriptsDir, start)}`,
    '',
    'Next:',
    `  1. Start the till: ${platform === 'win32' ? `double-click ${start}` : `run ${join(scriptsDir, start)}`}`,
    '     It prints "lane socket on 127.0.0.1:' + settings.EDGE_LANE_PORT + '" and "screens on 127.0.0.1:' + settings.EDGE_SCREEN_PORT + '". Leave it running.',
    `  2. Open the till in a browser on THIS PC: http://127.0.0.1:${settings.EDGE_SCREEN_PORT}/pos/`,
    '     Sign in with your staff code (top right) before the first sale — every sale names who rang it and on which lane.',
    '  3. Ring a sale and take cash — the receipt number appears once the sale is on this PC\'s disk.',
    '  4. Pull the network cable and ring another — it still completes; the unsent counter goes up. Nothing is lost.',
    `  5. Check the pieces: pnpm run standup:check   (reads ${join(installDir, 'till.env')})`,
  ];
  if (settings.CLOUD_API_URL === '' && input.realCopy === true) {
    lines.push('', "This till is OFFLINE-FIRST for now. Once the store exists at head office, connect it to this copy's books with");
    lines.push('the same command plus --store <the store id> (it writes the address and a store token itself), then restart the till.');
  } else if (settings.CLOUD_API_URL === '') {
    lines.push('', 'This till is OFFLINE-FIRST for now (no cloud URL). To sync to the books later: issue a store token');
    lines.push('(pnpm run token:store), then fill CLOUD_API_URL and CLOUD_API_TOKEN in till.env and restart the till.');
  } else if (settings.CLOUD_API_TOKEN !== '' && settings.EDGE_STORE_ID !== undefined) {
    lines.push('', `Connected: this till sends its sales to this copy's books for store ${settings.EDGE_STORE_ID}, and takes that store's setup from head office.`);
    lines.push('Close the till window and start it again so it picks this up. The store token lasts 30 days: run this command again before then.');
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
    process.stderr.write(`Unknown option(s): ${flags.unknown.join(' ')}\nUsage: pnpm run till:install -- --lane <lane, e.g. lane-1> [--store <store id>] [--tenant <id>] [--dir <folder>] [--from-compose-env <file> | --settings <file>] [--lane-port 8090] [--screen-port 8091] [--generate-key] [--skip-build] [--force] [--dry-run]\n`);
    process.exitCode = 64; // EX_USAGE
    return;
  }

  const node = checkNodeVersion(process.version);
  if (!node.ok) {
    process.stderr.write(`\n✕ ${node.detail}\n  Fix: ${node.fix}\n\n`);
    process.exitCode = 78; // EX_CONFIG
    return;
  }

  const { installDir, dataFolder } = tillInstallDir({ flags, repoRoot: REPO });
  // The start scripts always belong to THIS release; the till's settings and data may live in the data folder.
  const scriptsDir = flags.dir !== undefined ? installDir : join(REPO, 'till');
  const appsDir = join(REPO, 'apps');
  const composePath = flags.composeEnv !== undefined ? resolve(flags.composeEnv) : join(REPO, 'infra', 'compose', '.env');
  const composeEnv = await readEnvFile(composePath);
  const envPath = join(installDir, 'till.env');
  const existing = await readEnvFile(envPath);
  if (dataFolder !== undefined) process.stdout.write(`• the store computer's data folder: the till's settings and data go in ${installDir}, outside this release\n`);

  const realCopy = flags.settingsNamed === true && isRealCopySettings(composePath);
  const plan = planTillSettings({
    flags, installDir, appsDir, composeEnv, existing, realCopy, mintStoreToken: storeTokenMinter(composeEnv),
    ...(dataFolder === undefined ? {} : { statusFile: join(dataFolder, 'status', 'store-computer-status.json') }),
  });
  if (!plan.ok) {
    process.stderr.write(`\nThe till cannot be installed yet — ${plan.problems.length} problem(s):\n${plan.problems.map((p) => `  ✕ ${p}`).join('\n')}\n\n`);
    process.exitCode = 78;
    return;
  }
  for (const note of plan.notes) process.stdout.write(`• ${note}\n`);

  // An earlier install wrote settings. Rebuilding is fine; rewriting the file is not, unless asked — only the store
  // connection (W-5, with --store) and the newer guest/office settings are written into it, in place, never shown.
  const changes = existing !== undefined && !flags.force ? tillEnvChangesFor({ settings: plan.settings, existing, flags }) : {};
  if (existing !== undefined && !flags.force && Object.keys(changes).length === 0) {
    process.stdout.write(`• ${envPath} already exists — kept as it is (pass --force to rewrite it)\n`);
  }
  // OB-248 · OB-252: a real copy's till is never written without BOTH mirror settings — checked on what the file will say.
  const mirror = mirrorSettingsProblem({ realCopy, finalSettings: existing === undefined || flags.force ? plan.settings : { ...existing, ...changes } });
  if (mirror !== undefined) {
    process.stderr.write(`\nThe till cannot be installed yet — 1 problem(s):\n  ✕ ${mirror}\n\n`);
    process.exitCode = 78;
    return;
  }

  if (flags.dryRun) {
    process.stdout.write(`\nDry run — would write ${envPath}${Object.keys(changes).length > 0 ? ` (${Object.keys(changes).join(', ')})` : ''}, start scripts in ${installDir}, and build: ${BUILD_STEPS.map((s) => s.name).join(', ')}.\n`);
    return;
  }

  await mkdir(plan.settings.EDGE_DATA_DIR, { recursive: true });
  if (existing === undefined || flags.force) {
    await writeFile(envPath, renderTillEnv(plan.settings), { mode: 0o600 });
    await chmod(envPath, 0o600);
    process.stdout.write(`• wrote ${envPath}\n`);
  } else if (Object.keys(changes).length > 0) {
    const updated = updateTillEnv(await readFile(envPath, 'utf8'), changes);
    const tmp = `${envPath}.tmp`;
    await writeFile(tmp, updated.text, { mode: 0o600 });
    await rename(tmp, envPath);
    await chmod(envPath, 0o600);
    process.stdout.write(`• ${envPath} kept; set in it (names only, never the values): ${updated.changed.length === 0 ? 'nothing new' : updated.changed.join(', ')}\n`);
  }

  await mkdir(scriptsDir, { recursive: true });
  const outside = scriptsDir === installDir ? {} : { tillEnvPath: envPath };
  const sh = join(scriptsDir, 'start-till.sh');
  await writeFile(sh, renderStartScript('linux', { repoRoot: REPO, ...outside }), { mode: 0o755 });
  await chmod(sh, 0o755);
  await writeFile(join(scriptsDir, 'start-till.cmd'), renderStartScript('win32', { repoRoot: REPO, ...outside }));
  await writeFile(join(scriptsDir, 'sre-till.service'), renderSystemdUnit({ installDir, repoRoot: REPO }));
  process.stdout.write(`• wrote start scripts in ${scriptsDir}\n`);

  if (!flags.skipBuild) {
    for (const step of BUILD_STEPS) {
      process.stdout.write(`• building ${step.name}…\n`);
      execFileSync(process.execPath, step.args.map((a) => (isAbsolute(a) ? a : join(REPO, a))).map((a, i) => (i === 0 ? a : step.args[i])), { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
    }
  } else {
    process.stdout.write('• build skipped (--skip-build)\n');
  }

  process.stdout.write(`${renderNextSteps({ settings: plan.settings, installDir, scriptsDir, platform: process.platform, realCopy })}\n`);
}

// Run only when invoked directly, so the pure helpers can be imported by tests without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
