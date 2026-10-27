// The owner's guided store-computer setup — OB-240 (the real-data copy on a computer inside the shop) · OB-244 (the owner
// does every hands-on step himself, on a Windows 10/11 PC; no AI ever gets admin access to his computers).
//
//   doctor   checks the computer: Windows/Linux, memory, free disk, the folder, Docker, Node 22, pnpm, the time zone; on
//            Windows also — read-only — the free space on the data drive AND on C:, Docker's disk image, who is an
//            administrator and who can read the data (OB-283 · OB-284; store-computer-windows.mjs). It refuses on a Windows
//            Server, and so do prepare, up, autostart and update (OB-282)
//   prepare  writes .env.real ONCE in the shop's data folder — `--data-drive F:` puts it in F:\SRE-data and records that
//            place (OB-283) — with fresh secrets made on this computer (never printed, never returned)
//   up       starts this copy (compose project sre-real: db, migrate, api) and waits for the API to say ready
//   check    runs the ten isolation checks of pilot gate G4 (runbook Step 6) and writes a dated record — gap G-RD-1
//   fingerprints  shows a short one-way fingerprint of each secret (never the secret) and writes them to a file that is
//            safe to share — run on the demo box and on the store computer, so check 3 can compare them (OB-245, G-RD-8)
//   backup · restore-check · drill   the backup, restore-and-reconcile and timed rollback drill on Windows (OB-246,
//            G-RD-6, gate G9) — in scripts/lib/store-computer-recovery.mjs; since OB-249 every backup is ENCRYPTED and
//            holds the database, the till's own data and the settings (store-computer-crypto.mjs, store-computer-files.mjs)
//   schedule-backup · unschedule-backup · backup-status · autostart   the store computer runs itself: the hourly backup
//            and the start at sign-in, as Windows tasks (OB-249 · audit row 5) — scripts/lib/store-computer-schedule.mjs
//   status   the store computer's own red light: backup age, the till's queue, the disk, the containers (audit row 6) —
//            scripts/lib/store-computer-status.mjs; the office screens show the same banner
//   migrate-data-folder · update   the shop's data lives OUTSIDE the release folder, so an update never loses it (audit
//            row 9) — scripts/lib/store-computer-data.mjs
//   seal · parallel-policy   the two owner steps of the migration that had no command (audit row 8, MG-02 · MG-10b)
//
// Every command refuses, before it does anything: a production box (hard rule #7), the demo tenant (gate G4), the demo's
// compose project or settings files, and seeding people (that is `tenant:bootstrap`, and it waits for the OB-243 names).
// Nothing here loads real data: real data waits for the owner's named people (OB-243) and his written GO (OB-242).
//
// ── Secrets (hard rule #4) ─────────────────────────────────────────────────────────────────────────────────────────
// A secret is made with the operating system's CSPRNG, written straight into .env.real, and never printed, logged,
// returned or put in a record. Every line this module says goes through `say`, and no `say` line names a secret's value —
// a guardrail scans for it (tests/guardrails/the-store-computer-setup-never-shows-a-secret.test.ts) and the tests capture
// every line and every record and look for each secret in them.
//
// ── Portability ────────────────────────────────────────────────────────────────────────────────────────────────────
// Node built-ins only (no openssl, grep, curl or uuidgen — Windows has none of them). Every program is started with an
// argument array and no shell, so no value is ever interpolated into a command line. Everything that touches the world
// (files, programs, the network, the clock, the CSPRNG) arrives in `deps`, so the tests drive it without Docker.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, drill, restoreCheck, tillFolders } from './store-computer-recovery.mjs';
import { deviceDoorRow } from './store-computer-device-door.mjs';
import { autostart, backupStatus, scheduleBackup, scheduledBackup, startAtSignIn, unscheduleBackup } from './store-computer-schedule.mjs';
import { status } from './store-computer-status.mjs';
import { migrateDataFolder, update } from './store-computer-data.mjs';
import {
  administratorsRow, backupDriveProblem, dataDriveProblem, dataLockRow, dockerDiskRow, driveLetterOf, refusedOnServer, windowsEdition,
} from './store-computer-windows.mjs';

// ── Fixed names ───────────────────────────────────────────────────────────────────────────────────────────────────

/** This copy's compose project. Its volumes become sre-real_db-data, sre-real_edge-data, … (runbook Step 1). */
export const PROJECT = 'sre-real';
/** The hosted demo's compose project. Never started, stopped or changed from here; its presence is a G4 failure. */
export const DEMO_PROJECT = 'sre-pilot';
/** The demo tenant. Real data never goes into it, and this copy is never it. */
export const DEMO_TENANT = 'pilot-demo';
/** This copy's settings file, in infra/compose. */
export const SETTINGS_NAME = '.env.real';
/** Settings files that belong to other copies (the demo's shape). Read only to compare fingerprints in memory. */
export const OTHER_SETTINGS_NAMES = Object.freeze(['.env', '.env.pilot']);

/** The secrets this copy holds. None of them is ever shown. */
export const SECRET_KEYS = Object.freeze(['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY', 'CLOUD_API_TOKEN']);
/** The values that make this copy itself: none may equal any value in another copy's settings file on this computer. */
export const OWN_KEYS = Object.freeze(['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY', 'IDP_ISSUER', 'IDP_AUDIENCE', 'EDGE_TENANT_ID', 'POSTGRES_DB']);
/** Settings that would seed a person at the API's boot. Seeding is `tenant:bootstrap` with the OB-243 names, never this tool. */
export const SEEDING_KEYS = Object.freeze(['BOOTSTRAP_OWNER_TENANT_ID', 'BOOTSTRAP_OWNER_USER_ID']);

/** The doctor's thresholds. An 8 GB computer reports a little under 8 GiB to the operating system, so 7.5 GiB is "8 GB". */
export const THRESHOLDS = Object.freeze({
  ramBytes: 7.5 * 1024 ** 3,
  /** Free space where the shop's data lives (and Docker's disk image, OB-283): the 50 GB the setup has always asked. */
  diskBytes: 50 * 1024 ** 3,
  /**
   * Free space on the system drive (C:) when the data is on another drive (OB-283): C: then keeps only the programs —
   * Docker Desktop's program and WSL, Node.js, pnpm's package store and the release folders. A working allowance, NOT a
   * published figure (Docker publishes no installed size): one release folder measured here is about 0.06 GB of files
   * plus about 0.13 GB of packages, and three are kept at once during an update (live, previous, new); the rest is room
   * for Docker Desktop's own program and its updates, and for Windows' updates.
   */
  systemDriveBytes: 15 * 1024 ** 3,
  minNodeMajor: 22,
  /** Windows 10 version 2004 — the first that runs WSL 2, which Docker Desktop needs. */
  minWindowsBuild: 19041,
  timeZones: Object.freeze(['Asia/Kolkata', 'Asia/Calcutta']),
});

/** How long `up` waits for the API to say ready (the first start builds the API, which is the slow part). */
export const READY_WAIT_MS = 5 * 60_000;

const PLACEHOLDER = 'REPLACE_WITH';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const real = (v) => typeof v === 'string' && v.trim() !== '' && !v.includes(PLACEHOLDER);

// ── Where things are ──────────────────────────────────────────────────────────────────────────────────────────────

/** The path module for the computer the tool runs on (Windows paths on Windows, whatever the tests run on). */
export const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * The shop's DATA FOLDER (audit row 9 / C-12 / B11): this copy's settings, the check records, the till's own data and the
 * backup key live OUTSIDE the release folder, so a new release can be put beside the old one — and an old release folder
 * removed — without touching a sale, a secret or a record. On Windows it is <system drive>\SRE-data (C:\SRE-data), the
 * same for every release; SRE_DATA_DIR names another. Elsewhere it is the release folder's name plus "-data".
 */
export const DATA_FOLDER_NAME = 'SRE-data';
/** The note in the data folder that says what it is. Its presence beside a settings file is how till:install knows it. */
export const DATA_MARKER = 'THIS-IS-THE-SHOP-DATA-FOLDER.txt';
export const DATA_MARKER_TEXT = [
  "THIS FOLDER HOLDS THE SHOP'S DATA for the store computer (SRE Retail OS).",
  '',
  "In it: this copy's settings and secrets (.env.real), the till's sales, queue, dead letters and staff PIN checks",
  '(till\\edge-data), the bill-number witness (till\\edge-witness), the check records, and the backup key.',
  '',
  '  * Never delete this folder, never move it, and never copy it to a USB stick, an email or a cloud folder.',
  '    The automatic backup makes ENCRYPTED copies of it on the backup drive.',
  '  * A new release of the system goes into its OWN folder; this folder stays exactly where it is.',
  '  * Never photograph the files in it.',
  '',
].join('\r\n');

/** The data folder when nothing records another: SRE_DATA_DIR, else C:\SRE-data on Windows, else "<release folder>-data". */
export function fallbackDataRoot(repoRoot, platform, env = {}) {
  const p = pathFor(platform);
  const given = String(env.SRE_DATA_DIR ?? '').trim();
  if (given !== '') return p.resolve(given);
  if (platform === 'win32') return p.join(`${String(env.SystemDrive || 'C:').replace(/[\\/]+$/, '')}\\`, DATA_FOLDER_NAME);
  return `${p.resolve(repoRoot).replace(/[\\/]+$/, '')}-data`;
}

// ── Where the data folder is, recorded (OB-283) ────────────────────────────────────────────────────────────────────
// The data folder may be on any internal drive (F:\SRE-data on the pilot PC). Where it is, is RECORDED when `prepare
// --data-drive` makes it (or `migrate-data-folder --data-drive` moves it), in one small note OUTSIDE every release
// folder — C:\ProgramData\SRE\data-folder.json — so every command of every release, the Windows tasks and till:pin all
// find the same folder, and nothing guesses. The note holds a folder name only, never a secret; Part 26c locks its
// folder like the data. A note that cannot be read, or that names a folder that is not there (a drive missing or its
// letter changed), stops every command with what to do — never a silent fall-back to C:\SRE-data, where a second copy
// could be made by mistake.

export const DATA_POINTER_KIND = 'sre-data-folder';

/** Where the note is: SRE_DATA_POINTER (tests), else %ProgramData%\SRE\data-folder.json, else beside the release folder. */
export function dataPointerPath(repoRoot, platform, env = {}) {
  const p = pathFor(platform);
  const given = String(env.SRE_DATA_POINTER ?? '').trim();
  if (given !== '') return p.resolve(given);
  if (platform === 'win32') {
    const programData = String(env.ProgramData || env.ALLUSERSPROFILE || `${String(env.SystemDrive || 'C:').replace(/[\\/]+$/, '')}\\ProgramData`);
    return p.join(programData, 'SRE', 'data-folder.json');
  }
  return p.join(p.dirname(p.resolve(repoRoot)), '.sre-data-folder.json');
}

/** Read the note: undefined (none) · { dataRoot } · { problem }. */
export function readDataPointer(fs, platform, file) {
  if (file === undefined || !fs.existsSync(file)) return undefined;
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { problem: `the note that says where the shop's data folder is (${file}) cannot be read` }; }
  const root = typeof j?.dataRoot === 'string' ? j.dataRoot.trim() : '';
  if (j?.kind !== DATA_POINTER_KIND || root === '' || !pathFor(platform).isAbsolute(root)) return { problem: `the note that says where the shop's data folder is (${file}) is not one this tool wrote` };
  return { dataRoot: root };
}

/** Record where the data folder is: the note replaced whole (a temporary file, then a rename). */
export function writeDataPointer(deps, dataRoot, by) {
  if (deps.dataPointer === undefined) return;
  const p = pathFor(deps.platform);
  deps.fs.mkdirSync(p.dirname(deps.dataPointer), { recursive: true });
  const tmp = `${deps.dataPointer}.tmp`;
  const note = { kind: DATA_POINTER_KIND, version: 1, dataRoot, setAt: deps.now().toISOString(), setBy: `store-computer ${by}`, note: "Where the shop's data folder is. No secret is in this file. Never edit it: migrate-data-folder --data-drive moves the folder and this note together." };
  deps.fs.writeFileSync(tmp, `${JSON.stringify(note, null, 2)}\n`, 'utf8');
  deps.fs.renameSync(tmp, deps.dataPointer);
}

/** The same folder? (Windows: letters' case does not matter.) */
export const sameFolder = (platform, a, b) => {
  const p = pathFor(platform);
  const n = (x) => p.resolve(String(x)).replace(/[\\/]+$/, '');
  return platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/**
 * The data folder for this computer, the way till:pin and every other script find it: SRE_DATA_DIR, else the recorded
 * note (OB-283), else C:\SRE-data (Windows) or "<release folder>-data". A note that cannot be used gives the fall-back
 * here — the store-computer tool itself refuses on it (`resolveDataFolder`).
 */
export function defaultDataRoot(repoRoot, platform, env = {}, fs = nodeFs) {
  if (String(env.SRE_DATA_DIR ?? '').trim() !== '') return fallbackDataRoot(repoRoot, platform, env);
  const note = readDataPointer(fs, platform, dataPointerPath(repoRoot, platform, env));
  return note?.dataRoot ?? fallbackDataRoot(repoRoot, platform, env);
}

/**
 * The deps with the RECORDED data folder in them (OB-283), or { problem }. Without a note, deps are as given. The
 * window's SRE_DATA_DIR naming another folder than the note is a visible conflict, never a silent choice.
 */
export function resolveDataFolder(deps) {
  if (deps.dataPointer === undefined) return { deps };
  const note = readDataPointer(deps.fs, deps.platform, deps.dataPointer);
  if (note === undefined) return { deps };
  if (note.problem !== undefined) return { problem: `${note.problem}. Nothing was changed. Send me a photo of this screen.` };
  const given = String(deps.env?.SRE_DATA_DIR ?? '').trim();
  if (given !== '' && !sameFolder(deps.platform, given, note.dataRoot)) return { problem: `this window names SRE_DATA_DIR=${given}, but this computer's data folder is recorded as ${note.dataRoot} (${deps.dataPointer}). Close this PowerShell window, open a new one, and run the command again.` };
  if (!deps.fs.existsSync(note.dataRoot)) return { problem: `the shop's data folder is recorded as ${note.dataRoot}, but it is not there. Is drive ${driveLetterOf(note.dataRoot) ?? '?'}: missing, or has its letter changed (File Explorer → This PC)? Nothing was changed. Send me a photo of this screen and of This PC.` };
  return { deps: { ...deps, dataRoot: note.dataRoot } };
}

/**
 * `--data-drive F:` → F:\SRE-data (OB-283). Elsewhere (the tests, a Linux box) the value is the drive's folder, and the
 * data folder is <that folder>/SRE-data. Returns { dataRoot, note? } or { problem }. Read-only.
 */
export function dataRootOnDrive(deps, given) {
  const v = String(given ?? '').trim();
  const p = pathFor(deps.platform);
  if (deps.platform === 'win32') {
    const m = /^([A-Za-z]):\\?$/.exec(v);
    if (m === null) return { problem: `--data-drive takes a drive letter, for example --data-drive F:  (it was given "${v}")` };
    const letter = m[1].toUpperCase();
    const root = `${letter}:\\`;
    if (!deps.fs.existsSync(root)) return { problem: `there is no drive ${letter}: on this computer (File Explorer → This PC shows the letters)` };
    const k = dataDriveProblem(deps, letter);
    if (k.problem !== undefined) return { problem: k.problem };
    return { dataRoot: p.join(root, DATA_FOLDER_NAME), note: k.note };
  }
  if (v === '' || !deps.fs.existsSync(p.resolve(v))) return { problem: `--data-drive names a drive folder that is not there ("${v}")` };
  return { dataRoot: p.join(p.resolve(v), DATA_FOLDER_NAME) };
}

/**
 * Every path the tool uses. Without `dataRoot`: the first layout, everything inside the release folder (still read, so a
 * copy set up that way keeps working until `migrate-data-folder` moves it). With `dataRoot`: the data-folder layout.
 */
export function layout(repoRoot, platform, dataRoot) {
  const p = pathFor(platform);
  const composeDir = p.join(repoRoot, 'infra', 'compose');
  const common = {
    repoRoot,
    composeDir,
    example: p.join(composeDir, '.env.example'),
    others: OTHER_SETTINGS_NAMES.map((name) => ({ name, path: p.join(composeDir, name) })),
    sliceScript: p.join('scripts', 'dist', 'migration-slice.js'),
    buildScript: p.join('scripts', 'build-service.mjs'),
    releaseTill: p.join(repoRoot, 'till'),
  };
  if (dataRoot === undefined) {
    return { ...common, mode: 'in-release', settings: p.join(composeDir, SETTINGS_NAME), records: p.join(composeDir, 'records'), tillDir: p.join(repoRoot, 'till'), tillEnv: p.join(repoRoot, 'till', 'till.env') };
  }
  const tillDir = p.join(dataRoot, 'till');
  return {
    ...common,
    mode: 'data-folder',
    dataRoot,
    marker: p.join(dataRoot, DATA_MARKER),
    settings: p.join(dataRoot, SETTINGS_NAME),
    records: p.join(dataRoot, 'records'),
    tillDir,
    tillEnv: p.join(tillDir, 'till.env'),
    backupDir: p.join(dataRoot, 'backup'),
    statusDir: p.join(dataRoot, 'status'),
    statusFile: p.join(dataRoot, 'status', 'store-computer-status.json'),
    runDir: p.join(dataRoot, 'run'),
    scratchDir: p.join(dataRoot, 'scratch'),
  };
}

/**
 * The layout this computer uses now: the data folder when its settings file is there; the first, in-release layout when
 * only that one's settings file is there (until `migrate-data-folder`); the data folder for a copy not set up yet.
 */
export function resolveLayout(deps) {
  const legacy = layout(deps.repoRoot, deps.platform);
  if (deps.dataRoot === undefined) return legacy;
  const data = layout(deps.repoRoot, deps.platform, deps.dataRoot);
  if (deps.fs.existsSync(data.settings)) return data;
  if (deps.fs.existsSync(legacy.settings)) return legacy;
  return data;
}

/** Both layouts, for the commands that move from one to the other. */
export const bothLayouts = (deps) => ({ legacy: layout(deps.repoRoot, deps.platform), data: deps.dataRoot === undefined ? undefined : layout(deps.repoRoot, deps.platform, deps.dataRoot) });

/** Make the data folder and its note (never overwriting the note). */
export function ensureDataFolder(deps, L) {
  if (L.mode !== 'data-folder') return;
  deps.fs.mkdirSync(L.dataRoot, { recursive: true });
  if (!deps.fs.existsSync(L.marker)) deps.fs.writeFileSync(L.marker, DATA_MARKER_TEXT, { encoding: 'utf8', flag: 'wx' });
}

/** `KEY=value` lines; blanks and `#` comments ignored; the first `=` splits (the same reading as standup-check). */
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** The demo tenants this copy must never be: the demo's label, plus the settings' own DEMO_TENANT_IDS list. */
export function demoTenants(settings) {
  const listed = String(settings?.DEMO_TENANT_IDS ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return [...new Set([DEMO_TENANT, ...listed])];
}

// ── The refusals every command makes ──────────────────────────────────────────────────────────────────────────────

/**
 * What stops a command before it does anything. `settings` is this copy's settings (or undefined before `prepare`);
 * `processEnv` is the terminal's own environment, which Docker Compose would otherwise let win over the file.
 */
export function refusals(settings, processEnv = {}) {
  const out = [];
  const isProduction = (v) => String(v ?? '').trim().toLowerCase() === 'production';
  if (isProduction(settings?.MIGRATION_TARGET_KIND)) out.push(`this copy's settings say MIGRATION_TARGET_KIND=production. This tool never works on a production box (hard rule #7). Stop and send me a photo of this screen.`);
  if (isProduction(processEnv.MIGRATION_TARGET_KIND)) out.push('this window has MIGRATION_TARGET_KIND=production set. Close this PowerShell window, open a new one in the same folder, and run the command again.');
  const demo = demoTenants(settings);
  if (settings !== undefined && demo.includes(String(settings.EDGE_TENANT_ID ?? '').trim())) out.push(`this copy's tenant is a demo tenant ("${String(settings.EDGE_TENANT_ID).trim()}"). The real copy is never the demo (pilot gate G4).`);
  if (processEnv.EDGE_TENANT_ID !== undefined && demo.includes(String(processEnv.EDGE_TENANT_ID).trim())) out.push('this window names the demo tenant (EDGE_TENANT_ID). Close this PowerShell window, open a new one, and run the command again.');
  for (const key of SEEDING_KEYS) {
    if (settings !== undefined && String(settings[key] ?? '').trim() !== '') out.push(`this copy's settings name ${key}. People are never seeded by this tool — that is tenant:bootstrap, after the owner names them (OB-243).`);
  }
  return out;
}

/** The terminal's environment with every setting this copy's file holds taken out, so the FILE decides, never the shell. */
export function composeEnv(processEnv, settings) {
  const env = { ...processEnv };
  for (const key of Object.keys(settings ?? {})) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith('COMPOSE_')) delete env[key];
  return env;
}

/** The fixed start of every compose command: this project, the base file only (never the demo's overlay), this file. */
export const COMPOSE_BASE = Object.freeze(['compose', '-p', PROJECT, '-f', 'docker-compose.yml', '--env-file', SETTINGS_NAME]);
/** The same for the layout in use: in the data folder, compose is given the settings file by its full path. */
export const composeBase = (L) => (L?.mode === 'data-folder' ? ['compose', '-p', PROJECT, '-f', 'docker-compose.yml', '--env-file', L.settings] : [...COMPOSE_BASE]);

// ── prepare ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The values `prepare` writes, from the example file and a CSPRNG. Returns the planned map and the names of the
 * secrets in it. The caller writes it to disk and never shows it.
 */
export function planSettings(example, { random, uuid }) {
  const tenantId = uuid();
  const appUser = real(example.APP_DB_USER) ? example.APP_DB_USER : 'sre_app';
  const fresh = new Set();
  const make = (bytes, encoding) => {
    for (;;) {
      const v = random(bytes).toString(encoding);
      if (!fresh.has(v)) { fresh.add(v); return v; }
    }
  };
  // Hex for the database password: it sits inside DATABASE_URL, so it must be URL-safe (no '/', '+' or '=').
  const dbPassword = make(24, 'hex');
  // base64url for the keys: URL-safe too, and no '=' padding that a Windows `for /f … delims==` could split on.
  const packKey = make(48, 'base64url');
  const sealKey = make(48, 'base64url');
  const idpKey = make(48, 'base64url');
  const dbName = 'sre_real';
  const planned = {
    POSTGRES_DB: dbName,
    POSTGRES_PASSWORD: dbPassword,
    DATABASE_URL: ['postgres', '://', appUser, ':', dbPassword, '@db:5432/', dbName].join(''),
    PACK_SIGNING_KEY: packKey,
    BOX_HISTORY_SEAL_KEY: sealKey,
    IDP_SIGNING_KEY: idpKey,
    IDP_ISSUER: `sre-real-store-computer-${tenantId}`,
    IDP_AUDIENCE: 'sre-real-api',
    MIGRATION_TARGET_KIND: 'rehearsal',
    EDGE_TENANT_ID: tenantId,
    CLOUD_API_URL: '',
    CLOUD_API_TOKEN: '',
    SRE_PUBLIC_HOST: '',
    SRE_STAFF_ROUTE: 'staff-not-public',
    DEMO_TENANT_IDS: DEMO_TENANT,
  };
  return { planned, secretNames: ['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY'] };
}

/** The example file with each planned setting filled in place; settings the example lacks are added at the end. */
export function renderSettings(exampleText, planned, nowIso) {
  const done = new Set();
  const lines = String(exampleText).split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) return raw;
    const key = line.slice(0, line.indexOf('=')).trim();
    if (!Object.hasOwn(planned, key)) return raw;
    done.add(key);
    return `${key}=${planned[key]}`;
  });
  const missing = Object.keys(planned).filter((k) => !done.has(k));
  const head = [
    `# THIS COPY'S SETTINGS — the real-data copy on the store computer (compose project ${PROJECT}).`,
    `# Written by "pnpm run store-computer -- prepare" on ${nowIso}. The secrets in it were made on this computer.`,
    '# Keep this file on this computer ONLY. Never photograph it, never send it, never copy it to another computer',
    '# or a cloud folder, and never copy it to .env (every command takes this file by name).',
    '',
  ];
  const tail = missing.length === 0 ? [] : ['', '# ── Added for this copy by store-computer prepare ──', '# The demo tenant(s) every loader refuses by name, as a second lock (gate G4).', ...missing.map((k) => `${k}=${planned[k]}`)];
  return [...head, ...lines, ...tail, ''].join('\n');
}

/** Which planned setting equals a value in another copy's settings file. Compared by SHA-256, in memory; names only. */
export function clashes(planned, keys, others) {
  const found = [];
  for (const other of others) {
    const hashes = new Set(Object.values(other.values).filter(real).map(sha256));
    for (const key of keys) {
      if (real(planned[key]) && hashes.has(sha256(planned[key]))) found.push({ key, file: other.name });
    }
  }
  return found;
}

const readOthers = (deps, L) => L.others
  .filter((o) => deps.fs.existsSync(o.path))
  .map((o) => ({ name: o.name, values: parseEnvText(deps.fs.readFileSync(o.path, 'utf8')) }));

/** A path as the owner should read it: inside the release folder, relative to it; anywhere else (the data folder), in full. */
export const rel = (deps, abs) => {
  const p = pathFor(deps.platform);
  const r = p.relative(deps.repoRoot, abs);
  return r === '' ? '.' : r.startsWith('..') || p.isAbsolute(r) ? abs : r;
};
/** The clock as a file-name stamp: 2026-10-20T04-30-00-000Z. */
export const stampOf = (at) => at.toISOString().replace(/[:.]/g, '-');

/**
 * `prepare [--data-drive F:]`: write .env.real once, in the shop's data folder — on the drive named (OB-283: F:\SRE-data
 * on the pilot PC), recorded so every later command finds it. Never overwrites, never seeds, never shows a secret.
 */
export async function prepare(given, opts = {}) {
  const { say, fs } = given;
  if (refusedOnServer(given)) return 2;
  let deps = given;
  let driveNote;
  if (opts.dataDrive !== undefined) {
    const t = dataRootOnDrive(given, opts.dataDrive);
    if (t.problem !== undefined) { say(`REFUSED — ${t.problem}. Nothing was written.`); return 2; }
    const now = resolveLayout(given);
    if (fs.existsSync(now.settings) && !sameFolder(given.platform, pathFor(given.platform).dirname(now.settings), t.dataRoot)) {
      say(`REFUSED — this copy is already set up: its settings are in ${now.settings}. Nothing was written.`);
      say(`  To move its data to ${t.dataRoot}, close the till window and run: pnpm run store-computer -- migrate-data-folder --data-drive ${opts.dataDrive}`);
      return 2;
    }
    deps = { ...given, dataRoot: t.dataRoot };
    driveNote = t.note;
  }
  const L = resolveLayout(deps);
  const shownPath = rel(deps, L.settings);
  if (fs.existsSync(L.settings)) {
    say(`REFUSED — ${shownPath} already exists. It is never overwritten: it holds this copy's secrets.`);
    say('If this copy is already set up, the next step is: pnpm run store-computer -- up');
    return 2;
  }
  const stop = refusals(undefined, deps.env);
  if (stop.length > 0) { for (const r of stop) say(`REFUSED — ${r}`); return 2; }
  if (!fs.existsSync(L.example)) {
    say(`REFUSED — ${rel(deps, L.example)} is missing, so this is not a complete copy of the system. Download the ZIP again (guide Part 3).`);
    return 2;
  }
  const exampleText = fs.readFileSync(L.example, 'utf8');
  const { planned, secretNames } = planSettings(parseEnvText(exampleText), deps);

  const found = clashes(planned, OWN_KEYS, readOthers(deps, L));
  if (found.length > 0) {
    for (const c of found) say(`REFUSED — the value this would write for ${c.key} is already in infra/compose/${c.file} on this computer. Nothing was written.`);
    say('This copy must share nothing with any other copy. Send me a photo of this screen (never of a settings file).');
    return 2;
  }

  const text = renderSettings(exampleText, planned, deps.now().toISOString());
  // Self-check before writing: every planned setting reads back exactly, and no placeholder is left in a value.
  const back = parseEnvText(text);
  const wrong = Object.keys(planned).filter((k) => back[k] !== planned[k]);
  const left = Object.entries(back).filter(([, v]) => v.includes(PLACEHOLDER)).map(([k]) => k).filter((k) => !k.startsWith('KEYCLOAK_'));
  if (wrong.length > 0 || left.length > 0) {
    say(`REFUSED — the settings file would not read back correctly (${[...wrong, ...left].join(', ')}). Nothing was written. Send me a photo of this screen.`);
    return 1;
  }
  // 'wx': created only if it does not exist — even a file appearing in the last millisecond is never overwritten.
  ensureDataFolder(deps, L);
  // OB-283: where the data folder is, recorded BEFORE the settings are written there — so a stop in between leaves a
  // recorded, empty data folder (prepare again simply fills it), never settings that no command can find.
  if (L.mode === 'data-folder') writeDataPointer(deps, L.dataRoot, 'prepare');
  fs.writeFileSync(L.settings, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

  // From here on only names and the tenant id (a UUID, not a secret) are said — never `planned` itself.
  const filledNames = Object.keys(planned);
  const tenantId = planned.EDGE_TENANT_ID;
  say(`Settings file written: ${shownPath}`);
  say('  It stays on this computer only. Never photograph it, never send it, never open it on a shared screen.');
  if (L.mode === 'data-folder') say(`  It is in the shop's data folder ${L.dataRoot}, outside the system's own folder, so a new release never touches it.`);
  if (L.mode === 'data-folder' && deps.dataPointer !== undefined) say(`  Where the data folder is, is recorded in ${deps.dataPointer} (a folder name, no secret): every command finds it there.`);
  if (driveNote !== undefined) say(`  The data drive: ${driveNote}.`);
  if (deps.platform === 'win32') say('  This PC is shared (OB-284): lock the data folder NOW, before anyone else signs in — guide Part 26c, step 1.');
  say('Filled in (names only — the values are never shown):');
  for (const key of filledNames) say(`  ${key}${secretNames.includes(key) ? '   (a new secret, made on this computer)' : ''}`);
  say(`This copy's tenant id: ${tenantId}`);
  say('  Write it in the setup workbook. It is a name, not a secret.');
  say(`Compose project: ${PROJECT}`);
  say('No person was set up. That waits for the names you give (OB-243), and no real data is loaded by this tool.');
  say('Next: pnpm run store-computer -- up');
  return 0;
}

// ── Reading this copy's settings ──────────────────────────────────────────────────────────────────────────────────

export function loadSettings(deps) {
  const L = resolveLayout(deps);
  if (!deps.fs.existsSync(L.settings)) return { L, settings: undefined };
  return { L, settings: parseEnvText(deps.fs.readFileSync(L.settings, 'utf8')) };
}

export function guarded(deps, settings) {
  const stop = refusals(settings, deps.env);
  for (const r of stop) deps.say(`REFUSED — ${r}`);
  return stop.length > 0;
}

// ── Docker ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What is wrong with Docker on this computer, in plain words with the one thing to do — or undefined when it is fine. */
export function dockerProblem(deps) {
  const win = deps.platform === 'win32';
  const v = deps.spawn('docker', ['--version'], {});
  if (v.error !== undefined || v.status !== 0) {
    return {
      what: 'Docker is not installed on this computer, or Windows cannot find it.',
      fix: win ? 'Install Docker Desktop (guide Part 2), restart the computer, open Docker Desktop once, then run this again.' : 'Install Docker Engine with the compose plugin, then run this again.',
    };
  }
  const info = deps.spawn('docker', ['info', '--format', '{{.ServerVersion}}'], {});
  if (info.status !== 0) {
    return {
      what: win ? 'Docker Desktop is installed but not running.' : 'Docker is installed but not running.',
      fix: win ? 'Open Docker Desktop from the Start menu, wait until it says "Engine running", then run this again.' : 'Start Docker (sudo systemctl start docker), then run this again.',
    };
  }
  const compose = deps.spawn('docker', ['compose', 'version'], {});
  if (compose.status !== 0) {
    return { what: "Docker's compose part is missing.", fix: win ? 'Update Docker Desktop to its latest version (Docker Desktop → Settings → Software updates), then run this again.' : 'Install the Docker compose plugin, then run this again.' };
  }
  return undefined;
}

export const lines = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
const projectContainers = (deps, project) => lines(deps.spawn('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}'], {}).stdout);
const runningContainers = (deps, project) => lines(deps.spawn('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}'], {}).stdout);

async function readyNow(deps, port) {
  try {
    const res = await deps.fetch(`http://127.0.0.1:${port}/readyz`);
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ready === true;
  } catch { return false; }
}

/** Poll readyz until it says ready or the wait is over. */
export async function waitReady(deps, port, waitMs = READY_WAIT_MS) {
  const deadline = deps.now().getTime() + waitMs;
  for (;;) {
    if (await readyNow(deps, port)) return true;
    if (deps.now().getTime() >= deadline) return false;
    await deps.sleep(3_000);
  }
}

// ── up ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `up`: start this copy's database, schema and API, show them, and wait for READY. */
export async function up(deps) {
  const { say } = deps;
  if (refusedOnServer(deps)) return 2;
  const { L, settings } = loadSettings(deps);
  if (settings === undefined) { say('REFUSED — this copy has no settings file yet. Run first: pnpm run store-computer -- prepare'); return 2; }
  if (guarded(deps, settings)) return 2;
  const placeholders = Object.entries(settings).filter(([k, v]) => v.includes(PLACEHOLDER) && !k.startsWith('KEYCLOAK_')).map(([k]) => k);
  if (placeholders.length > 0) { say(`REFUSED — the settings file still has a placeholder in ${placeholders.join(', ')}. Send me a photo of this screen (not of the file).`); return 2; }

  const docker = dockerProblem(deps);
  if (docker !== undefined) { say(`NOT STARTED — ${docker.what}`); say(`  What to do: ${docker.fix}`); return 1; }

  const demo = projectContainers(deps, DEMO_PROJECT);
  if (demo.length > 0) {
    say(`REFUSED — the demo's containers (project ${DEMO_PROJECT}) are on this computer. The demo never runs on the store computer (gate G4).`);
    say('  Nothing was started or stopped. Send me a photo of this screen.');
    return 2;
  }

  if (runningContainers(deps, PROJECT).length === 0) {
    for (const [name, port] of [['database', settings.POSTGRES_PORT || '5432'], ['API', settings.API_PORT || '8081']]) {
      if (await deps.portInUse(Number(port))) {
        say(`NOT STARTED — port ${port} on this computer is already taken by another program, so this copy's ${name} cannot start.`);
        say('  What to do: restart the computer, open Docker Desktop, and run this again. If it says this again, send me a photo of this screen.');
        return 1;
      }
    }
  } else {
    say(`This copy (${PROJECT}) is already running — bringing it up to date.`);
  }

  const env = composeEnv(deps.env, settings);
  say(`Starting this copy (${PROJECT}): the database, the schema check and the API. The first time takes several minutes.`);
  const started = deps.spawn('docker', [...composeBase(L), 'up', '-d', 'db', 'migrate', 'api'], { cwd: L.composeDir, env, stdio: 'inherit' });
  if (started.error !== undefined || started.status !== 0) {
    say('NOT STARTED — Docker could not start this copy. The lines above, in Docker\'s own words, say why.');
    say('  What to do: send me a photo of the red text.');
    return 1;
  }
  const ps = deps.spawn('docker', [...composeBase(L), 'ps'], { cwd: L.composeDir, env });
  for (const l of lines(ps.stdout)) say(`  ${l}`);

  const port = settings.API_PORT || '8081';
  say('Waiting for the API to say it is ready…');
  if (!(await waitReady(deps, port))) {
    say(`NOT READY — the API did not say ready within ${READY_WAIT_MS / 60_000} minutes.`);
    say('  What to do: run "pnpm run store-computer -- up" once more. If it says this again, send me a photo of this screen.');
    return 1;
  }
  say('READY — this copy is up on this computer, and needs no internet.');
  say('Next: pnpm run store-computer -- check --by "<your name>"');
  return 0;
}

// ── fingerprints (OB-245 — how check 3 is signed off; closes gap G-RD-8) ──────────────────────────────────────────
//
// The demo's secrets are never on the store computer, and the store computer's never on the demo. So each computer
// shows — and writes to a small file — a one-way FINGERPRINT of each of its secrets: the first 12 hex characters of
// SHA-256 over a fixed label and the value. The store computer's `check --demo-fingerprints <file>` compares its own
// fingerprints with the demo's; check 3 passes only when every one differs from every one.
//
// Why a fingerprint gives nothing away: each secret is at least 32 characters from the operating system's random source
// (192 bits or more). SHA-256 cannot be run backwards; the only way from a fingerprint to a value is to guess values
// and compare, and 2^192 guesses is out of reach of every computer there will ever be. Only 12 hex characters (48 bits)
// are kept, so even a guesser with unlimited time would find about 2^144 different values that give the same
// fingerprint — the fingerprint cannot point at the one value that is the secret. The fixed label means the fingerprint
// matches no other hash of the same value made anywhere else. A value shorter than 32 characters is never fingerprinted
// (a short one could be guessed); the file says "too short" for it instead. Two different random secrets share a
// fingerprint by chance about once in 2^48 (280 million million) comparisons — and a chance match makes check 3 FAIL,
// never pass, so the mistake is always on the safe side.

/** The fixed label every fingerprint is made with. Changing it would make old fingerprint files incomparable (refused). */
export const FINGERPRINT_LABEL = 'sre-retail-os/secret-fingerprint/v1';
/** The secrets `prepare` generates — the ones check 3 says must be this copy's own. */
export const FINGERPRINT_KEYS = Object.freeze(['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY']);
export const FINGERPRINT_MIN_LENGTH = 32;
export const FINGERPRINT_HEX = 12;
const FINGERPRINT = /^[0-9a-f]{12}$/;
const NOT_FINGERPRINTED = Object.freeze(['not set', 'too short']);

/** One fingerprint: the first 12 hex of SHA-256(label, NUL, value). One way: the value cannot be worked out from it. */
export function fingerprintOf(value) {
  return createHash('sha256').update(FINGERPRINT_LABEL, 'utf8').update('\0').update(String(value), 'utf8').digest('hex').slice(0, FINGERPRINT_HEX);
}

/** Every FINGERPRINT_KEYS setting: its fingerprint, or why it has none ("not set", "too short"). Values never leave here. */
export function fingerprintsOf(settings) {
  const fingerprints = {};
  const notFingerprinted = {};
  for (const key of FINGERPRINT_KEYS) {
    const v = settings?.[key];
    if (!real(v)) notFingerprinted[key] = 'not set';
    else if (String(v).trim().length < FINGERPRINT_MIN_LENGTH) notFingerprinted[key] = 'too short';
    else fingerprints[key] = fingerprintOf(String(v).trim());
  }
  return { fingerprints, notFingerprinted };
}

/** Read a fingerprint file. Anything malformed, empty or made another way is refused — never treated as a pass. */
export function readFingerprintFile(text) {
  let f;
  try { f = JSON.parse(String(text)); } catch { return { ok: false, reason: 'it is not a fingerprint file (it could not be read as one)' }; }
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return { ok: false, reason: 'it is not a fingerprint file' };
  if (f.kind !== 'sre-secret-fingerprints' || f.version !== 1) return { ok: false, reason: 'it is not a fingerprint file written by "store-computer fingerprints"' };
  if (f.label !== FINGERPRINT_LABEL) return { ok: false, reason: 'it was made with a different fingerprint label, so it cannot be compared' };
  const fps = f.fingerprints;
  const not = f.notFingerprinted ?? {};
  if (fps === null || typeof fps !== 'object' || Array.isArray(fps) || not === null || typeof not !== 'object' || Array.isArray(not)) return { ok: false, reason: 'its fingerprints are missing or malformed' };
  for (const k of [...Object.keys(fps), ...Object.keys(not)]) if (!FINGERPRINT_KEYS.includes(k)) return { ok: false, reason: `it names a setting this check does not know (${k})` };
  for (const [k, v] of Object.entries(fps)) if (typeof v !== 'string' || !FINGERPRINT.test(v)) return { ok: false, reason: `the fingerprint for ${k} is not 12 hex characters` };
  for (const [k, v] of Object.entries(not)) if (!NOT_FINGERPRINTED.includes(v) || k in fps) return { ok: false, reason: `the entry for ${k} is malformed` };
  const missing = FINGERPRINT_KEYS.filter((k) => !(k in fps) && !(k in not));
  if (missing.length > 0) return { ok: false, reason: `it says nothing about ${missing.join(', ')} — it may be cut short` };
  if (Object.keys(fps).length === 0) return { ok: false, reason: 'it holds no fingerprint at all — there is nothing to compare' };
  return { ok: true, file: { settingsFile: typeof f.settingsFile === 'string' ? f.settingsFile : '', fingerprints: { ...fps }, notFingerprinted: { ...not } } };
}

/** Every pair (ours, theirs) whose fingerprints are equal — any of ours against any of theirs. */
export function fingerprintMatches(own, theirs) {
  const found = [];
  for (const [mine, a] of Object.entries(own)) for (const [other, b] of Object.entries(theirs)) if (a === b) found.push({ own: mine, demo: other });
  return found;
}

/** The settings file `fingerprints` reads: --settings, or this repository's .env.real, or (on the demo box) .env.pilot. */
function fingerprintSource(deps, given) {
  const p = pathFor(deps.platform);
  if (given !== undefined) return { file: p.resolve(given) };
  const L = resolveLayout(deps);
  const pilot = L.others.find((o) => o.name === '.env.pilot').path;
  const found = [L.settings, pilot].filter((f) => deps.fs.existsSync(f));
  if (found.length === 1) return { file: found[0] };
  if (found.length === 0) return { problem: `there is no ${SETTINGS_NAME} (the store computer) or .env.pilot (the demo box) in infra/compose here. Name the settings file with --settings <file>.` };
  return { problem: `both ${SETTINGS_NAME} and .env.pilot are in infra/compose here. Say which one with --settings <file>. (On the store computer, .env.pilot should not be there at all — check 3 will say so.)` };
}

/** `fingerprints [--settings <file>] [--out <folder>]`: the secrets' fingerprints, shown and written to a shareable file. */
export async function fingerprints(deps, opts) {
  const { say, fs } = deps;
  const src = fingerprintSource(deps, opts.settings);
  if (src.problem !== undefined) { say(`REFUSED — ${src.problem}`); return 2; }
  const p = pathFor(deps.platform);
  if (!fs.existsSync(src.file)) { say(`REFUSED — there is no settings file at ${src.file}.`); return 2; }
  const values = parseEnvText(fs.readFileSync(src.file, 'utf8'));
  if (String(values.MIGRATION_TARGET_KIND ?? '').trim().toLowerCase() === 'production') { say('REFUSED — these settings say MIGRATION_TARGET_KIND=production. This tool never works on a production box (hard rule #7).'); return 2; }
  const fp = fingerprintsOf(values);
  if (Object.keys(fp.fingerprints).length === 0) { say(`REFUSED — ${p.basename(src.file)} holds none of the secrets (${FINGERPRINT_KEYS.join(', ')}). Is it the right settings file?`); return 2; }

  const at = deps.now();
  const where = deps.platform === 'win32' ? 'Windows' : 'Linux';
  say(`Secret fingerprints from ${p.basename(src.file)} on this computer (${where}). A fingerprint is one-way: the secret is never shown and cannot be worked out from it.`);
  for (const key of FINGERPRINT_KEYS) {
    if (key in fp.fingerprints) say(`  ${key.padEnd(22)} ${fp.fingerprints[key]}`);
    else say(`  ${key.padEnd(22)} (${fp.notFingerprinted[key]} — no fingerprint)`);
  }
  const dir = opts.out === undefined ? resolveLayout(deps).records : p.resolve(opts.out);
  fs.mkdirSync(dir, { recursive: true });
  let file;
  for (let i = 1; ; i += 1) {
    file = p.join(dir, `fingerprints-${stampOf(at)}${i === 1 ? '' : `-${i}`}.json`);
    if (!fs.existsSync(file)) break;
  }
  const out = {
    kind: 'sre-secret-fingerprints', version: 1, label: FINGERPRINT_LABEL, algorithm: `the first ${FINGERPRINT_HEX} hex characters of SHA-256 over the label, a NUL and the value`,
    at: at.toISOString(), computer: where, settingsFile: p.basename(src.file), fingerprints: fp.fingerprints, notFingerprinted: fp.notFingerprinted,
  };
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  say(`Fingerprint file written: ${file}`);
  say('  It holds no secret — it is safe to copy to the store computer. The settings file itself never leaves this computer.');
  return 0;
}

/** Check 3 against the demo's fingerprint file. Returns a check result. */
export function demoFingerprintVerdict(settings, text) {
  const got = readFingerprintFile(text);
  if (!got.ok) return { status: 'FAIL', detail: `REFUSED the demo fingerprint file — ${got.reason}. Make it again on the demo box (guide Part 9) and copy it here.` };
  if (got.file.settingsFile === SETTINGS_NAME) return { status: 'FAIL', detail: `REFUSED the demo fingerprint file — it was made from a store computer's ${SETTINGS_NAME}, not from the demo's settings. Use the file made on the demo box.` };
  const own = fingerprintsOf(settings);
  const ownMissing = Object.entries(own.notFingerprinted).map(([k, why]) => `${k} (${why})`);
  if (ownMissing.length > 0) return { status: 'FAIL', detail: `this copy's own secrets are not all there and long: ${ownMissing.join(', ')}. prepare makes each one at least ${FINGERPRINT_MIN_LENGTH} characters.` };
  const same = fingerprintMatches(own.fingerprints, got.file.fingerprints);
  if (same.length > 0) return { status: 'FAIL', detail: `${same.map((m) => `this copy's ${m.own} has the same fingerprint as the demo's ${m.demo}`).join('; ')}. That secret is shared with the demo: it must be replaced before any real data. Send me a photo of this screen.` };
  const short = Object.keys(got.file.notFingerprinted).filter((k) => got.file.notFingerprinted[k] === 'too short');
  const theirs = Object.keys(got.file.fingerprints).length;
  return { status: 'PASS', detail: `all ${FINGERPRINT_KEYS.length} of this copy's secret fingerprints differ from all ${theirs} of the demo's${short.length > 0 ? ` (the demo's ${short.join(', ')} ${short.length === 1 ? 'is' : 'are'} shorter than any of this copy's, so cannot be equal to one)` : ''}. Compared by one-way fingerprint; no secret was shown or moved.` };
}

// ── check (pilot gate G4, runbook Step 6) ─────────────────────────────────────────────────────────────────────────

export const CHECK_TITLES = Object.freeze([
  'Own project, own storage',
  'Own database',
  "Own secrets (none is the demo's)",
  'Never connected to the demo',
  'Works with the internet cable unplugged',
  'Never production',
  'The demo tenant is refused',
  'Production is refused',
  'The real tenant is a UUID and nobody\'s demo',
  "Backups go to the owner's drive only",
]);

const result = (n, status, detail) => ({ n, title: CHECK_TITLES[n - 1], status, detail });
const isLocalUrl = (v) => v === '' || /^http:\/\/(api|127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/i.test(v);
const isLocalHost = (v) => { try { return ['api', '127.0.0.1', 'localhost'].includes(new URL(v).hostname.toLowerCase()); } catch { return false; } };

/** The overall answer: "G4 PASSED" only when all ten pass. */
export function overall(results) {
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const needs = results.filter((r) => r.status === 'NEEDS-YOU').length;
  const passed = results.length === 10 && results.every((r) => r.status === 'PASS');
  if (passed) return { passed: true, line: 'G4 PASSED — all ten isolation checks pass.' };
  const parts = [];
  if (fail > 0) parts.push(`${fail} failed`);
  if (needs > 0) parts.push(`${needs} need you`);
  if (results.length !== 10) parts.push(`${10 - results.length} not run`);
  return { passed: false, line: `G4 NOT PASSED — ${parts.join(', ')}. No real data may be loaded until G4 passes.` };
}

/** The table, as lines. Only the statuses and the details the checks wrote — never a setting's value. */
export function checkTable(results) {
  const out = [' #  RESULT     CHECK'];
  for (const r of results) {
    out.push(`${String(r.n).padStart(2)}  ${r.status.padEnd(9)}  ${r.title}`);
    out.push(`               ${r.detail}`);
  }
  return out;
}

/** Run the real slice command's refusal path against a folder holding only a slice.json (no CSV, no real data). */
function sliceRefusal(deps, L, { tenantId, settingsPath, expect }) {
  const dir = deps.fs.mkdtempSync(pathFor(deps.platform).join(deps.tmpdir(), 'sre-g4-'));
  try {
    const manifest = { loadId: 'g4-isolation-check', tenantId, operator: 'g4-isolation-check', storeId: 'g4-isolation-check', department: { categoryId: 'g4-isolation-check', name: 'G4 isolation check (no data)' }, files: {} };
    deps.fs.writeFileSync(pathFor(deps.platform).join(dir, 'slice.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const r = deps.spawn(deps.nodePath, [L.sliceScript, '--dir', dir, '--stage', '--offline', '--settings', settingsPath], { cwd: deps.repoRoot, env: composeEnv(deps.env, {}) });
    const said = `${r.stdout ?? ''}`;
    const refused = r.status === 1 && said.includes(`REFUSED (${expect})`);
    return { refused, status: r.status };
  } finally {
    deps.fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The ten checks. Read-only, except the temporary folder and file checks 7 and 8 make and delete. */
export async function runChecks(deps, settings, opts) {
  const { fs } = deps;
  const L = resolveLayout(deps);
  const p = pathFor(deps.platform);
  const results = [];
  const docker = dockerProblem(deps);
  const others = readOthers(deps, L);
  const port = settings.API_PORT || '8081';

  // 1 — own project, own storage.
  if (docker !== undefined) results.push(result(1, 'FAIL', `${docker.what} ${docker.fix}`));
  else {
    const vols = lines(deps.spawn('docker', ['volume', 'ls', '--format', '{{.Name}}'], {}).stdout);
    const own = vols.filter((v) => v.startsWith(`${PROJECT}_`));
    const demo = vols.filter((v) => v.startsWith(`${DEMO_PROJECT}_`));
    if (demo.length > 0) results.push(result(1, 'FAIL', `the demo's storage is on this computer (${demo.length} ${DEMO_PROJECT}_ volume(s)). The demo never lives here.`));
    else if (own.length === 0) results.push(result(1, 'FAIL', `no ${PROJECT}_ storage yet — run: pnpm run store-computer -- up`));
    else results.push(result(1, 'PASS', `${own.length} ${PROJECT}_ volume(s), and no ${DEMO_PROJECT}_ volume on this computer.`));
  }

  // 2 — own database.
  if (docker !== undefined) results.push(result(2, 'FAIL', 'Docker is not ready, so the database could not be asked.'));
  else {
    const user = settings.POSTGRES_USER || 'sre_admin';
    const r = deps.spawn('docker', [...composeBase(L), 'exec', '-T', 'db', 'psql', '-U', user, '-d', 'postgres', '-Atc', 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1'], { cwd: L.composeDir, env: composeEnv(deps.env, settings) });
    const names = lines(r.stdout);
    const ownDb = settings.POSTGRES_DB || 'sre_real';
    const demoDbs = new Set(['sre_pilot', ...others.map((o) => o.values.POSTGRES_DB).filter(real)]);
    demoDbs.delete(ownDb);
    const foreign = names.filter((n) => demoDbs.has(n));
    if (r.status !== 0) results.push(result(2, 'FAIL', `this copy's database did not answer — run: pnpm run store-computer -- up`));
    else if (!names.includes(ownDb)) results.push(result(2, 'FAIL', `the database ${ownDb} is not there.`));
    else if (foreign.length > 0) results.push(result(2, 'FAIL', `a demo database is inside this copy (${foreign.join(', ')}).`));
    else results.push(result(2, 'PASS', `${ownDb} is there, and no demo database.`));
  }

  // 3 — own secrets.
  {
    const held = SECRET_KEYS.filter((k) => real(settings[k]));
    const seen = new Map();
    const dupInside = [];
    for (const k of held) {
      const h = sha256(settings[k]);
      if (seen.has(h)) dupInside.push(`${seen.get(h)} and ${k}`); else seen.set(h, k);
    }
    const found = clashes(settings, [...SECRET_KEYS, 'IDP_ISSUER', 'EDGE_TENANT_ID'], others);
    if (dupInside.length > 0) results.push(result(3, 'FAIL', `two of this copy's secrets are the same (${dupInside.join(', ')}). Each must be its own.`));
    else if (found.length > 0) results.push(result(3, 'FAIL', `${found.map((c) => `${c.key} equals a value in infra/compose/${c.file}`).join('; ')}. If that file is a copy of ${SETTINGS_NAME}, it is not needed: every command takes ${SETTINGS_NAME} by name.`));
    else if (opts.demoFingerprints !== undefined) {
      // OB-245: the demo's fingerprints, made on the demo box and copied here. Malformed or empty is refused, never a pass.
      let text;
      try { text = fs.readFileSync(opts.demoFingerprints, 'utf8'); } catch { text = undefined; }
      const v = text === undefined
        ? { status: 'FAIL', detail: `REFUSED the demo fingerprint file — it could not be read (${opts.demoFingerprints}). Check the file name you gave after --demo-fingerprints.` }
        : demoFingerprintVerdict(settings, text);
      results.push(result(3, v.status, v.detail));
    } else if (others.length === 0) results.push(result(3, 'NEEDS-YOU', "not checked here: the demo's settings are not on this computer, which is itself the expected state. Make the demo's fingerprint file on the demo box (guide Part 9), copy it here, and run check again with --demo-fingerprints \"<that file>\"."));
    else results.push(result(3, 'PASS', `none of this copy's secrets equals any value in ${others.map((o) => `infra/compose/${o.name}`).join(' or ')} (compared by fingerprint, in memory).`));
  }

  // 4 — never connected to the demo.
  {
    const bad = [];
    const files = [{ name: SETTINGS_NAME, values: settings }];
    if (fs.existsSync(L.tillEnv)) files.push({ name: L.mode === 'data-folder' ? L.tillEnv : 'till/till.env', values: parseEnvText(fs.readFileSync(L.tillEnv, 'utf8')) });
    for (const f of files) {
      const url = String(f.values.CLOUD_API_URL ?? '').trim();
      if (!isLocalUrl(url)) bad.push(`${f.name}: CLOUD_API_URL names an address outside this computer`);
      if (String(f.values.SRE_PUBLIC_HOST ?? '').trim() !== '') bad.push(`${f.name}: SRE_PUBLIC_HOST is not blank`);
    }
    const issuer = String(settings.IDP_ISSUER ?? '').trim();
    if (!real(issuer)) bad.push(`${SETTINGS_NAME}: IDP_ISSUER is not set`);
    else if (/^https?:\/\//i.test(issuer) && !isLocalHost(issuer)) bad.push(`${SETTINGS_NAME}: IDP_ISSUER names an address outside this computer`);
    for (const c of clashes(settings, ['CLOUD_API_URL', 'IDP_ISSUER', 'SRE_PUBLIC_HOST'], others)) bad.push(`${SETTINGS_NAME}: ${c.key} is the same as in infra/compose/${c.file}`);
    results.push(bad.length > 0 ? result(4, 'FAIL', `${bad.join('; ')}.`) : result(4, 'PASS', `only this computer's own values or blank in ${files.map((f) => f.name).join(' and ')}.`));
  }

  // 5 — the internet cable. The tool cannot unplug it; the owner does, and says so with --offline-confirmed.
  {
    const ready = await readyNow(deps, port);
    if (!ready) results.push(result(5, 'FAIL', 'the API is not answering ready on this computer — run: pnpm run store-computer -- up'));
    else if (opts.offlineConfirmed) results.push(result(5, 'PASS', `the API answered ready while ${opts.by} confirmed the internet cable was unplugged.`));
    else results.push(result(5, 'NEEDS-YOU', 'the API answers ready. Now unplug the INTERNET cable (leave the cable to the tills), then run: pnpm run store-computer -- check --by "<your name>" --offline-confirmed'));
  }

  // 6 — never production.
  {
    const kind = String(settings.MIGRATION_TARGET_KIND ?? '').trim();
    results.push(kind === 'rehearsal' ? result(6, 'PASS', 'MIGRATION_TARGET_KIND is rehearsal.') : result(6, 'FAIL', `MIGRATION_TARGET_KIND is "${kind}", not rehearsal.`));
  }

  // 7 and 8 — the real loader's own refusals, on a folder with no data in it.
  const build = deps.spawn(deps.nodePath, [L.buildScript, 'tools'], { cwd: deps.repoRoot, env: composeEnv(deps.env, {}) });
  if (build.error !== undefined || build.status !== 0) {
    results.push(result(7, 'FAIL', 'the loader could not be prepared for the check (the tools build failed). Send me a photo of this screen.'));
    results.push(result(8, 'FAIL', 'the loader could not be prepared for the check (the tools build failed).'));
  } else {
    const seven = sliceRefusal(deps, L, { tenantId: DEMO_TENANT, settingsPath: L.settings, expect: 'demo_tenant' });
    results.push(seven.refused ? result(7, 'PASS', 'the loader said REFUSED (demo_tenant) for the demo tenant, before reading a row.') : result(7, 'FAIL', `the loader did not refuse the demo tenant (it ended ${seven.status}).`));

    // A temporary copy of this copy's settings with MIGRATION_TARGET_KIND=production — its secrets left out (they play
    // no part in the refusal, and a secret copied is a secret to look after) — deleted straight afterwards.
    const tmp = fs.mkdtempSync(p.join(deps.tmpdir(), 'sre-g4-settings-'));
    const copy = p.join(tmp, '.env.production-check');
    let eight;
    try {
      const copied = { ...settings, MIGRATION_TARGET_KIND: 'production' };
      for (const k of SECRET_KEYS) copied[k] = '';
      fs.writeFileSync(copy, `${Object.entries(copied).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      eight = sliceRefusal(deps, L, { tenantId: settings.EDGE_TENANT_ID, settingsPath: copy, expect: 'production_target' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    const gone = !fs.existsSync(copy);
    if (!gone) results.push(result(8, 'FAIL', `the temporary copy of the settings could not be deleted (${copy}). Delete that file by hand.`));
    else results.push(eight.refused ? result(8, 'PASS', 'the loader said REFUSED (production_target) for a temporary copy set to production; that copy is deleted.') : result(8, 'FAIL', `the loader did not refuse production (it ended ${eight.status}).`));
  }

  // 9 — the real tenant.
  {
    const t = String(settings.EDGE_TENANT_ID ?? '').trim();
    if (!UUID.test(t)) results.push(result(9, 'FAIL', 'EDGE_TENANT_ID is not a UUID.'));
    else if (demoTenants(settings).includes(t)) results.push(result(9, 'FAIL', 'EDGE_TENANT_ID is listed as a demo tenant.'));
    else results.push(result(9, 'PASS', `EDGE_TENANT_ID ${t} is a UUID, not ${DEMO_TENANT}, and not in DEMO_TENANT_IDS.`));
  }

  // 10 — backups go to the owner's drive. The tool cannot know which drive is his: it reads the backup step's record.
  if (opts.backupRecord === undefined) {
    results.push(result(10, 'NEEDS-YOU', 'take the first backup onto your own backup drive (guide Part 8), then run check again with --backup-record "<the .manifest.json file backup wrote>".'));
  } else {
    const v = backupRecordVerdict(deps, opts.backupRecord);
    results.push(result(10, v.status, v.detail));
  }
  return results;
}

/**
 * Is `dir` on this computer's own drive? On Windows: the system drive (C:), the drive the repository is on, or the drive
 * the shop's data is on (F: on the pilot PC, OB-283); anywhere: inside the repository or the data folder. Returns the
 * problem in plain words, or undefined. Check 10 and `backup --to` both use it — and on Windows they then also ask
 * Windows what KIND of drive it is: every disk inside this PC is refused, only a USB or removable drive is accepted
 * (OB-281, `backupDriveProblem` in store-computer-windows.mjs).
 */
export function ownDriveProblem(dir, { platform, repoRoot, systemDrive, dataRoot }) {
  const p = pathFor(platform);
  const drive = (x) => p.parse(p.resolve(x)).root.replace(/[\\/]+$/, '').toLowerCase();
  const ownDrives = platform === 'win32' ? new Set([drive(repoRoot), String(systemDrive ?? 'C:').toLowerCase(), ...(dataRoot === undefined ? [] : [drive(dataRoot)])]) : new Set();
  // On Windows `relative` across drives returns the other drive's absolute path, which is NOT inside the repository.
  const inside = (root) => { const r = p.relative(root, p.resolve(dir)); return r === '' || (!r.startsWith('..') && !p.isAbsolute(r)); };
  if (inside(repoRoot)) return `${dir} is inside the system's own folder (${repoRoot})`;
  if (dataRoot !== undefined && inside(dataRoot)) return `${dir} is inside the shop's data folder (${dataRoot}) — a backup must be on another drive`;
  if (platform === 'win32' && ownDrives.has(drive(dir))) return `${dir} is on this computer's own drive (${drive(dir).toUpperCase()})`;
  return undefined;
}

/**
 * Check 10 from the backup step's own record: it restored and reconciled, and the copy went to a folder that is not on
 * this computer's own drive (`ownDriveProblem`). Takes the older recovery-rehearsal record, or a `restore-check` record.
 */
export function backupVerdict(rec, { platform, repoRoot, systemDrive, dataRoot, driveProblem }) {
  if (rec === undefined || rec === null || typeof rec !== 'object') return { status: 'FAIL', detail: 'the backup record could not be read. Check the file name you gave after --backup-record.' };
  if (rec.outcome !== 'restored_and_reconciled') return { status: 'FAIL', detail: `the backup record says "${String(rec.outcome)}", not restored_and_reconciled. Take the backup again.` };
  const dir = typeof rec.offsiteDir === 'string' ? rec.offsiteDir.trim() : '';
  if (dir === '') return { status: 'FAIL', detail: 'the backup record names no backup drive folder.' };
  if (ownDriveProblem(dir, { platform, repoRoot, systemDrive, dataRoot }) !== undefined) {
    return { status: 'FAIL', detail: `the backup went to ${dir}, which is on this computer's own drive — it must go to your backup drive.` };
  }
  const kind = driveProblem?.(dir);
  if (kind !== undefined) return { status: 'FAIL', detail: `the backup went to ${dir}, which is not accepted as a backup drive: ${kind}.` };
  return { status: 'PASS', detail: `the backup record says the copy went to ${dir} and restored and reconciled. Confirm ${dir} is your own backup drive.` };
}

/**
 * Check 10 from the file named after --backup-record. Three kinds are accepted:
 *   • a `store-computer backup` manifest — it passes only if a `restore-check` record beside it, for this very backup
 *     (same backup id and SHA-256), says restored_and_reconciled; the folder judged is where the manifest really is;
 *   • a `store-computer restore-check` record — the folder judged is where the record really is;
 *   • the older recovery-rehearsal record (scripts/recovery-rehearsal.mjs) — as before.
 */
export function backupRecordVerdict(deps, file) {
  const { fs } = deps;
  const p = pathFor(deps.platform);
  const where = { platform: deps.platform, repoRoot: deps.repoRoot, systemDrive: deps.env.SystemDrive, dataRoot: deps.dataRoot, driveProblem: (dir) => backupDriveProblem(deps, dir) };
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
  const rec = read(file);
  const here = p.dirname(p.resolve(file));
  if (rec?.kind === 'store-computer-restore-check') return backupVerdict({ ...rec, offsiteDir: here }, where);
  if (rec?.kind !== 'store-computer-backup') return backupVerdict(rec, where);
  const checks = (() => { try { return fs.readdirSync(here).map(String).filter((n) => /^restore-check-.*\.json$/.test(n)).sort(); } catch { return []; } })()
    .map((n) => read(p.join(here, n)))
    .filter((r) => r?.kind === 'store-computer-restore-check' && r.backupId === rec.backupId && r.sha256 === rec.sha256);
  if (checks.length === 0) return { status: 'FAIL', detail: `this backup (${String(rec.backupId)}) has not been restore-checked yet. Run: pnpm run store-computer -- restore-check --from "${file}", then check again.` };
  const good = checks.find((r) => r.outcome === 'restored_and_reconciled');
  return backupVerdict(good === undefined ? checks.at(-1) : { ...good, offsiteDir: here }, where);
}

/** A dated record file name that never overwrites another. */
function recordPath(deps, dir, at) {
  const p = pathFor(deps.platform);
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  for (let i = 1; ; i += 1) {
    const candidate = p.join(dir, `g4-check-${stamp}${i === 1 ? '' : `-${i}`}.json`);
    if (!deps.fs.existsSync(candidate)) return candidate;
  }
}

/** `check`: the ten G4 checks, the table, the record. */
export async function check(deps, opts) {
  const { say, fs } = deps;
  const by = typeof opts.by === 'string' ? opts.by.trim() : '';
  if (by === '') { say('REFUSED — say who is running the check: pnpm run store-computer -- check --by "<your name>"'); return 2; }
  const { L, settings } = loadSettings(deps);
  if (settings === undefined) { say('REFUSED — this copy has no settings file yet. Run first: pnpm run store-computer -- prepare'); return 2; }
  if (guarded(deps, settings)) return 2;

  const at = deps.now();
  say(`Pilot gate G4 — the ten isolation checks, on ${deps.platform === 'win32' ? 'Windows' : 'Linux'}, project ${PROJECT}, by ${by}.`);
  const results = await runChecks(deps, settings, { ...opts, by });
  for (const l of checkTable(results)) say(l);
  const verdict = overall(results);
  say(verdict.line);

  const dir = opts.out ?? L.records;
  fs.mkdirSync(dir, { recursive: true });
  const file = recordPath(deps, dir, at);
  const record = {
    kind: 'g4-isolation-check',
    at: at.toISOString(),
    by,
    project: PROJECT,
    tenantId: String(settings.EDGE_TENANT_ID ?? ''),
    computer: deps.platform === 'win32' ? 'Windows' : 'Linux',
    offlineConfirmed: opts.offlineConfirmed === true,
    results: results.map((r) => ({ n: r.n, check: r.title, result: r.status, detail: r.detail })),
    ...(opts.demoFingerprints === undefined ? {} : { demoFingerprintFile: pathFor(deps.platform).basename(opts.demoFingerprints) }),
    overall: verdict.passed ? 'G4 PASSED' : 'G4 NOT PASSED',
  };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  say(`Record written: ${rel(deps, file)}  (no secret is in it — keep it with the workbook)`);
  return verdict.passed ? 0 : 1;
}

// ── doctor ────────────────────────────────────────────────────────────────────────────────────────────────────────

const gib = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;

/** The doctor's rows, each OK, FIX (with the plain-English fix) or NEEDS-YOU (what to check by eye). Read-only over `deps`. */
export function doctorRows(deps, extra = {}) {
  const rows = [];
  const row = (name, ok, detail, fix) => rows.push({ name, status: ok ? 'OK' : 'FIX', detail, ...(ok ? {} : { fix }) });
  const win = deps.platform === 'win32';

  if (win) {
    const build = Number(String(deps.os.release()).split('.')[2] ?? 0);
    const name = `${deps.os.version()} (build ${build})`;
    row('Windows', build >= THRESHOLDS.minWindowsBuild, name, 'Update Windows: Settings → Windows Update → Check for updates, install everything, restart, run this again.');
  } else if (deps.platform === 'linux') {
    row('Linux', true, `Linux ${deps.os.release()}`);
  } else {
    row('System', false, `this computer runs ${deps.platform}`, 'This setup is for a Windows 10/11 or Linux computer.');
  }

  const ram = deps.os.totalmem();
  row('Memory', ram >= THRESHOLDS.ramBytes, `${gib(ram)} of memory`, 'This computer needs at least 8 GB of memory (RAM). Use another computer, or have memory added.');

  // OB-283: the free space is read WHERE THE DATA LIVES (with Docker's disk image beside it), and — when that is another
  // drive — C: is checked for what stays on it: the release folders and the programs.
  const p = pathFor(deps.platform);
  const L0 = resolveLayout(deps);
  const dataAt = L0.mode === 'data-folder' ? L0.dataRoot : deps.repoRoot;
  const freeAt = (dir) => { try { return deps.freeDiskBytes(dir); } catch { return undefined; } };
  const nearest = (dir) => { let d = p.resolve(dir); while (!deps.fs.existsSync(d) && p.dirname(d) !== d) d = p.dirname(d); return d; };
  if (win) {
    const dataDrive = (driveLetterOf(dataAt) ?? 'C').toUpperCase();
    const systemDrive = (driveLetterOf(String(deps.env.SystemDrive || 'C:')) ?? 'C').toUpperCase();
    const dataFree = freeAt(`${dataDrive}:\\`);
    const apart = dataDrive !== systemDrive;
    row(apart ? 'Data drive' : 'Free disk', dataFree !== undefined && dataFree >= THRESHOLDS.diskBytes,
      dataFree === undefined ? `could not read the free space on ${dataDrive}:` : `${gib(dataFree)} free on ${dataDrive}:, the drive that holds the shop's data (${dataAt})${apart ? " and Docker's disk image" : ''}`,
      apart
        ? `Free up space until ${dataDrive}: has at least 50 GB free, then run this again.`
        : `Free up space until ${dataDrive}: has at least 50 GB free (empty the Recycle Bin, remove old downloads), then run this again. If this PC has another disk inside it with more room (File Explorer → This PC, for example F:), put the shop's data there instead: run  pnpm run store-computer -- doctor --data-drive F:  (guide Part 5).`);
    if (apart) {
      const sysFree = freeAt(`${systemDrive}:\\`);
      row(`${systemDrive}: drive`, sysFree !== undefined && sysFree >= THRESHOLDS.systemDriveBytes,
        sysFree === undefined ? `could not read the free space on ${systemDrive}:` : `${gib(sysFree)} free on ${systemDrive}:, which keeps the system's folders (${deps.repoRoot}) and the programs (Docker Desktop, Node.js)`,
        `Free up space until ${systemDrive}: has at least ${THRESHOLDS.systemDriveBytes / 1024 ** 3} GB free (empty the Recycle Bin, remove old downloads), then run this again.`);
      const k = dataDriveProblem(deps, dataDrive);
      row('Data disk', k.problem === undefined, k.problem ?? k.note ?? `${dataDrive}: is inside this computer`, "Choose a disk INSIDE this PC for the shop's data (guide Part 5). Send me a photo of this screen and of File Explorer → This PC.");
    }
  } else {
    const free = freeAt(nearest(dataAt));
    row('Free disk', free !== undefined && free >= THRESHOLDS.diskBytes, free === undefined ? 'could not read the free space' : `${gib(free)} free on the drive holding ${dataAt}`, 'Free up space until this drive has at least 50 GB free (empty the Recycle Bin, remove old downloads), then run this again.');
  }

  const folder = deps.repoRoot;
  const synced = /onedrive|dropbox|google ?drive|icloud/i.test(folder);
  const spaced = /\s/.test(folder);
  row('Folder', !synced && !spaced, folder, synced
    ? 'This folder is inside a cloud-synced folder, which would copy the secrets off this computer. Move the folder to C:\\SRE (guide Part 3).'
    : 'The folder path has a space in it. Move the folder to C:\\SRE (guide Part 3).');

  const docker = dockerProblem(deps);
  row('Docker', docker === undefined, docker === undefined ? 'installed and running' : docker.what, docker?.fix);

  const major = Number(String(deps.nodeVersion).replace(/^v/, '').split('.')[0]);
  row('Node.js', Number.isFinite(major) && major >= THRESHOLDS.minNodeMajor, `Node ${deps.nodeVersion}`, 'Install Node.js 22 LTS from nodejs.org (guide Part 2), close PowerShell, open it again, run this again.');

  const agent = String(deps.env.npm_config_user_agent ?? '');
  const pnpm = /\bpnpm\/(\d+[^\s]*)/.exec(agent);
  row('pnpm', pnpm !== null, pnpm === null ? 'not found (run this as: pnpm run store-computer -- doctor)' : `pnpm ${pnpm[1]}`, 'Install pnpm: in PowerShell type  npm install -g pnpm  then close PowerShell, open it again, and run this again.');

  const tz = deps.timeZone();
  row('Time zone', THRESHOLDS.timeZones.includes(tz), tz, win
    ? 'Settings → Time & language → Date & time → Time zone: (UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi. Then run this again.'
    : 'Set the time zone to Asia/Kolkata (sudo timedatectl set-timezone Asia/Kolkata), then run this again.');

  const L = resolveLayout(deps);
  if (deps.fs.existsSync(L.settings)) {
    const stop = refusals(parseEnvText(deps.fs.readFileSync(L.settings, 'utf8')), deps.env);
    row('This copy', stop.length === 0, stop.length === 0 ? `${SETTINGS_NAME} is there and safe to use` : stop.join(' '), 'Stop here and send me a photo of this screen.');
  } else {
    row('This copy', true, `no ${SETTINGS_NAME} yet — the next step makes it (prepare)`);
  }
  // Audit row 9 / C-12: the shop's data lives outside the release folder, so an update can never lose it.
  if (deps.dataRoot !== undefined) {
    if (L.mode === 'data-folder') row('Data', true, `the shop's data folder is ${L.dataRoot} — apart from the system's own folder`);
    else row('Data', false, `this copy's settings and the till's data are inside the system's own folder (${deps.repoRoot}), where a new release would replace them`, 'Close the till window, then run: pnpm run store-computer -- migrate-data-folder');
  }
  // OB-422: the handheld door's lock, when this computer's till opens the door — read-only, public certificates only.
  const door = deviceDoorRow(deps, tillFolders(deps, L));
  if (door !== undefined) rows.push(door);

  // Windows only, read-only: the edition (OB-282 — a server is refused before this list), Docker's disk image on the
  // data drive (OB-283), who is an administrator and who can read the data on this shared PC (OB-251 · OB-284). A check
  // Windows does not answer is NEEDS-YOU with what to look at by eye — never an OK.
  if (win) {
    const edition = extra.edition ?? windowsEdition(deps);
    if (!edition.known) rows.push({ name: 'Edition', status: 'NEEDS-YOU', detail: `Windows did not say its edition (Node reads "${edition.caption || 'nothing'}")`, fix: 'Check by eye: Settings → System → About → Edition must say Windows 10 or 11 — never "Windows Server" (guide Part 1, OB-282).' });
    else rows.push({ name: 'Edition', status: 'OK', detail: `${edition.caption || 'Windows'} — not a server` });
    rows.push(dockerDiskRow(deps, dataAt));
    rows.push(administratorsRow(deps));
    rows.push(dataLockRow(deps, L0, deps.dataPointer));
  }
  return rows;
}

/** `doctor [--data-drive F:]`: the rows, printed. Refuses on a Windows Server (OB-282). Changes nothing. */
export async function doctor(given, opts = {}) {
  let deps = given;
  if (opts.dataDrive !== undefined) {
    const t = dataRootOnDrive(given, opts.dataDrive);
    if (t.problem !== undefined) { given.say(`REFUSED — ${t.problem}.`); return 2; }
    deps = { ...given, dataRoot: t.dataRoot };
  }
  const edition = windowsEdition(deps);
  if (refusedOnServer(deps, edition)) return 2;
  const rows = doctorRows(deps, { edition });
  deps.say('Checking this computer for the store setup:');
  for (const r of rows) {
    deps.say(`  ${r.status.padEnd(9)}  ${r.name.padEnd(11)} ${r.detail}`);
    if (r.status !== 'OK') deps.say(`                         What to do: ${r.fix}`);
  }
  const fix = rows.filter((r) => r.status === 'FIX').length;
  const needs = rows.filter((r) => r.status === 'NEEDS-YOU').length;
  const next = `Next: pnpm run store-computer -- prepare${opts.dataDrive === undefined ? '' : ` --data-drive ${opts.dataDrive}`}`;
  if (fix > 0) deps.say(`${fix} thing(s) to fix first. Fix them one at a time, then run doctor again.`);
  else if (needs > 0) deps.say(`No FIX. ${needs} line(s) say NEEDS-YOU: each one says what you do, and when. ${next}`);
  else deps.say(`All OK. ${next}`);
  return fix === 0 ? 0 : 1;
}

// ── The command line ──────────────────────────────────────────────────────────────────────────────────────────────

export const USAGE = [
  'Usage: pnpm run store-computer -- <command>',
  '  doctor [--data-drive F:]                 check this computer (and the drive the shop\'s data will be on)',
  '  prepare [--data-drive F:]                write this copy\'s settings file once, in the shop\'s data folder (F:\\SRE-data)',
  '  up                                       start this copy and wait until it is ready',
  '  check --by "<name>" [--offline-confirmed] [--demo-fingerprints <file>] [--backup-record <file>] [--out <folder>]',
  '                                           the ten G4 isolation checks, and a dated record',
  '  fingerprints [--settings <file>] [--out <folder>]',
  '                                           one-way fingerprints of the secrets (never the secrets), and a file safe to share',
  '  backup --to <folder on your backup drive>',
  '                                           back this copy up onto your backup drive, with a manifest',
  '  restore-check --from <backup file>       restore a backup into a scratch database and reconcile it',
  '  drill --by "<name>" --to <folder> --previous <previous release folder> [--run]',
  '                                           the timed rollback drill (pilot gate G9); a dry run without --run',
  '  schedule-backup --to <folder on the drive that stays plugged in> --every 60',
  '                                           automatic encrypted backup every N minutes (Windows Task Scheduler)',
  '  unschedule-backup                        turn the automatic backup off (every backup is kept)',
  '  backup-status                            the automatic backup, the last backup, and the room left on the drive',
  '  status                                   the store computer check: backup, till queue, disk, containers (red banner)',
  '  autostart [--off]                        start everything by itself when you sign in to Windows',
  '  migrate-data-folder [--data-drive F:]    move the settings and the till\'s data out of the system\'s folder,',
  '                                           or the whole data folder to another internal drive',
  '  update --from <new release folder> [--to <backup drive folder>]',
  '                                           install a new release, keeping every sale, setting and record',
  '  seal --dir <slice folder> --as <login> --backup-restored-on YYYY-MM-DD [--source <id>]',
  '                                           seal the old ERP\'s exported files (MG-02) — asks your OWN till PIN',
  '  parallel-policy --as <login> --cutover <id> --reconciler <login> --clean-days N --max-days M --start YYYY-MM-DD',
  '                                           write the parallel-run policy (MG-10) — asks your OWN till PIN',
  ' Head office\'s own jobs on this computer (OB-257) — each asks for a YES, then each person\'s OWN till PIN:',
  '  shop --as <login> --approver <the owner\'s login> --company <code> --legal-name "<as on the GST certificate>" --gstin <GSTIN> --store <code> --store-name "<name>" [--place-of-business "<line 1 | line 2>"]',
  '                                           the company, its legal name and GSTIN, and the store, active',
  '  store-settings --as <login> --store <code> --cutoff HH:MM --stale-after-minutes N --count-approval-rupees R',
  '                 --handover-tolerance-rupees R --cash-variance-rupees R',
  '                                           the store\'s settings (a new version each time)',
  '  bill-prefix --as <login> --store <code> --till <lane> --prefix <prefix> [--reason "<why>"]',
  '                                           the till\'s bill-number prefix',
  '  grant --as <login> --approver <second login> --person <login> --role <role> --store <code> --reason "<why>"',
  '                                           a role at the store: one person asks, a second approves',
  '  publish-catalogue --as <login> --store <code>',
  '                                           the signed price list for the store, to the till',
];

/** The owner setup commands (OB-257): scripts/owner-setup.ts → packages/migration/src/owner-steps-command.ts. */
export const SETUP_COMMANDS = Object.freeze(['shop', 'store-settings', 'bill-prefix', 'grant', 'publish-catalogue']);
/** Their flags, as typed (each takes a value), handed on as they are. */
export const SETUP_FLAGS = Object.freeze(['--company', '--legal-name', '--gstin', '--store', '--store-name', '--place-of-business', '--cutoff', '--stale-after-minutes', '--count-approval-rupees', '--handover-tolerance-rupees', '--cash-variance-rupees', '--till', '--prefix', '--reason', '--approver', '--person', '--role']);

/**
 * An owner setup command (OB-257), run as the people who do it: this copy's settings and the till's are handed to the
 * setup tool, which asks for a YES and each person's own PIN at THIS keyboard (so it runs in this window, not captured),
 * and calls this copy's own head-office routes on loopback. Nothing is written to the database from here.
 */
export async function ownerSetup(deps, step, cl) {
  const { say } = deps;
  const { L, settings } = loadSettings(deps);
  if (settings === undefined) { say('REFUSED — this copy has no settings file yet. Run first: pnpm run store-computer -- prepare'); return 2; }
  if (guarded(deps, settings)) return 2;
  const env = composeEnv(deps.env, {});
  const built = deps.spawn(deps.nodePath, [L.buildScript, 'tools', '--quiet'], { cwd: deps.repoRoot, env });
  if (built.error !== undefined || built.status !== 0) { say('NOT DONE — the setup tool could not be prepared (the tools build failed). Send me a photo of this screen.'); return 1; }
  const p = pathFor(deps.platform);
  const pass = [];
  for (const [flag, value] of Object.entries(cl.setup)) pass.push(flag, value);
  if (cl.as !== undefined) pass.push('--as', cl.as);
  const tillEnv = deps.fs.existsSync(L.tillEnv) ? ['--till-settings', L.tillEnv] : [];
  const r = deps.spawn(deps.nodePath, [p.join('scripts', 'dist', 'owner-setup.js'), step, ...pass, '--settings', L.settings, ...tillEnv], { cwd: deps.repoRoot, env, stdio: 'inherit' });
  if (r.error !== undefined) { say('NOT DONE — the setup tool could not be started.'); return 1; }
  return r.status ?? 1;
}

/** The owner steps of the migration (audit row 8): the slice tool, built, run as the signed-in person on THIS copy. */
export async function ownerStep(deps, step, cl) {
  const { say } = deps;
  const { L, settings } = loadSettings(deps);
  if (settings === undefined) { say('REFUSED — this copy has no settings file yet. Run first: pnpm run store-computer -- prepare'); return 2; }
  if (guarded(deps, settings)) return 2;
  if (step === 'seal' && (typeof cl.dir !== 'string' || cl.dir.trim() === '')) { say('REFUSED — name the slice folder: pnpm run store-computer -- seal --dir <folder with slice.json and the CSV files> --as <your login> --backup-restored-on YYYY-MM-DD'); return 2; }
  const env = composeEnv(deps.env, {});
  const built = deps.spawn(deps.nodePath, [L.buildScript, 'tools', '--quiet'], { cwd: deps.repoRoot, env });
  if (built.error !== undefined || built.status !== 0) { say('NOT DONE — the migration tool could not be prepared (the tools build failed). Send me a photo of this screen.'); return 1; }
  const pass = (flag, value) => (value === undefined ? [] : [flag, String(value)]);
  const args = step === 'seal'
    ? [L.sliceScript, '--dir', pathFor(deps.platform).resolve(cl.dir), '--seal', ...pass('--as', cl.as), ...pass('--backup-restored-on', cl.backupRestoredOn), ...pass('--source', cl.source)]
    : [L.sliceScript, '--parallel-policy', ...pass('--as', cl.as), ...pass('--cutover', cl.cutover), ...pass('--reconciler', cl.reconciler), ...pass('--clean-days', cl.cleanDays), ...pass('--max-days', cl.maxDays), ...pass('--start', cl.start)];
  // OB-257: the step asks the acting person for their own till PIN at THIS keyboard (checked against the till's own
  // verifiers), so it runs in this window — never captured — and is handed the till's settings.
  const tillEnv = deps.fs.existsSync(L.tillEnv) ? ['--till-settings', L.tillEnv] : [];
  const r = deps.spawn(deps.nodePath, [...args, '--settings', L.settings, ...tillEnv], { cwd: deps.repoRoot, env, stdio: 'inherit' });
  if (r.error !== undefined) { say('NOT DONE — the migration tool could not be started.'); return 1; }
  return r.status ?? 1;
}

/** Read the command line. Unknown options are named, never ignored. */
export function parseCommandLine(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  const out = {
    command: undefined, by: undefined, out: undefined, backupRecord: undefined, offlineConfirmed: false, demoFingerprints: undefined,
    settings: undefined, to: undefined, from: undefined, previous: undefined, run: false, every: undefined, off: false, quiet: false,
    dir: undefined, as: undefined, backupRestoredOn: undefined, source: undefined, cutover: undefined, reconciler: undefined,
    cleanDays: undefined, maxDays: undefined, start: undefined, dataDrive: undefined, setup: {}, problems: [],
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const value = () => {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) { out.problems.push(`${a} needs a value`); return undefined; }
      i += 1; return v;
    };
    if (a === '--') continue;
    if (a === '--by') out.by = value();
    else if (a === '--out') out.out = value();
    else if (a === '--backup-record') out.backupRecord = value();
    else if (a === '--offline-confirmed') out.offlineConfirmed = true;
    else if (a === '--demo-fingerprints') out.demoFingerprints = value();
    else if (a === '--settings') out.settings = value();
    else if (a === '--to') out.to = value();
    else if (a === '--from') out.from = value();
    else if (a === '--previous') out.previous = value();
    else if (a === '--run') out.run = true;
    else if (a === '--every') out.every = value();
    else if (a === '--off') out.off = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--dir') out.dir = value();
    else if (a === '--as') out.as = value();
    else if (a === '--backup-restored-on') out.backupRestoredOn = value();
    else if (a === '--source') out.source = value();
    else if (a === '--cutover') out.cutover = value();
    else if (a === '--reconciler') out.reconciler = value();
    else if (a === '--clean-days') out.cleanDays = value();
    else if (a === '--max-days') out.maxDays = value();
    else if (a === '--start') out.start = value();
    else if (a === '--data-drive') out.dataDrive = value();
    else if (SETUP_FLAGS.includes(a)) { const v = value(); if (v !== undefined) out.setup[a] = v; }
    else if (!a.startsWith('--') && out.command === undefined) out.command = a;
    else out.problems.push(`unknown option ${a}`);
  }
  return out;
}

/** Run one command. Returns the exit code: 0 done · 1 not done (a check failed, a step did not work) · 2 refused or misused. */
export async function main(argv, given) {
  const cl = parseCommandLine(argv);
  if (cl.problems.length > 0 || cl.command === undefined) {
    for (const pr of cl.problems) given.say(`Not understood: ${pr}`);
    for (const l of USAGE) given.say(l);
    return 2;
  }
  if (cl.dataDrive !== undefined && !['doctor', 'prepare', 'migrate-data-folder'].includes(cl.command)) {
    given.say(`Not understood: --data-drive goes with doctor, prepare and migrate-data-folder only — every other command finds the data folder by itself.`);
    return 2;
  }
  // OB-283: every command finds the shop's data folder the same way — where it is recorded.
  const found = resolveDataFolder(given);
  if (found.problem !== undefined) { given.say(`REFUSED — ${found.problem}`); return 2; }
  const deps = found.deps;
  switch (cl.command) {
    case 'doctor': return doctor(deps, { dataDrive: cl.dataDrive });
    case 'prepare': return prepare(deps, { dataDrive: cl.dataDrive });
    case 'up': return up(deps);
    case 'check': return check(deps, { by: cl.by, out: cl.out, backupRecord: cl.backupRecord, offlineConfirmed: cl.offlineConfirmed, demoFingerprints: cl.demoFingerprints });
    case 'fingerprints': return fingerprints(deps, { settings: cl.settings, out: cl.out });
    case 'backup': return backup(deps, { to: cl.to });
    case 'restore-check': return restoreCheck(deps, { from: cl.from });
    case 'drill': return drill(deps, { by: cl.by, to: cl.to, previous: cl.previous, run: cl.run, out: cl.out });
    case 'schedule-backup': return scheduleBackup(deps, { to: cl.to, every: cl.every });
    case 'unschedule-backup': return unscheduleBackup(deps);
    case 'backup-status': return backupStatus(deps);
    case 'status': return status(deps, { quiet: cl.quiet });
    case 'autostart': return autostart(deps, { off: cl.off });
    case 'migrate-data-folder': return migrateDataFolder(deps, { dataDrive: cl.dataDrive });
    case 'update': return update(deps, { from: cl.from, to: cl.to });
    case 'seal': return ownerStep(deps, 'seal', cl);
    case 'parallel-policy': return ownerStep(deps, 'parallel-policy', cl);
    // OB-257: head office's own jobs on this computer, each by the people whose act it is.
    case 'shop': return ownerSetup(deps, 'shop', cl);
    case 'store-settings': return ownerSetup(deps, 'store-settings', cl);
    case 'bill-prefix': return ownerSetup(deps, 'bill-prefix', cl);
    case 'grant': return ownerSetup(deps, 'grant', cl);
    case 'publish-catalogue': return ownerSetup(deps, 'publish-catalogue', cl);
    // What the Windows tasks run (never typed by the owner): the hourly backup and the sign-in start.
    case 'scheduled-backup': return scheduledBackup(deps);
    case 'start-at-sign-in': return startAtSignIn(deps);
    default:
      deps.say(`Not understood: the command "${cl.command}"`);
      for (const l of USAGE) deps.say(l);
      return 2;
  }
}

// ── The real world ────────────────────────────────────────────────────────────────────────────────────────────────

/** Is something already listening on this port on this computer? Tries to connect, then to listen (Windows-safe). */
export function portInUse(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    sock.setTimeout(1_000);
    let asked = false;
    const listenCheck = () => {
      if (asked) return;
      asked = true;
      sock.destroy();
      const srv = createServer();
      srv.once('error', (e) => resolve(e?.code === 'EADDRINUSE' || e?.code === 'EACCES'));
      srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(false)));
    };
    sock.once('connect', () => { asked = true; sock.destroy(); resolve(true); });
    sock.once('timeout', listenCheck);
    sock.once('error', listenCheck);
  });
}

/**
 * Ask for a passphrase at the keyboard without showing it: the terminal is put in raw mode and nothing typed is echoed.
 * Resolves undefined when there is no keyboard (a scheduled task) — the caller then never waits for one. The value is
 * handed to the caller only, never written anywhere.
 */
export function askSecret(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let typed = '';
    const done = (value) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') { done(typed); return; }
        if (ch === '\u0003') { done(undefined); return; } // Ctrl+C
        if (ch === '\u0008' || ch === '\u007f') typed = typed.slice(0, -1);
        else if (ch >= ' ') typed += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    input.on('data', onData);
  });
}

/** The deps for a real run: this repository, this computer, its programs. No shell, ever. */
export function defaultDeps() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  return {
    repoRoot,
    // The fall-back data folder; `main` puts the RECORDED one in its place (OB-283, `resolveDataFolder`).
    dataRoot: fallbackDataRoot(repoRoot, process.platform, process.env),
    dataPointer: dataPointerPath(repoRoot, process.platform, process.env),
    platform: process.platform,
    env: process.env,
    fs: nodeFs,
    spawn: (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts, shell: false }),
    // A program left running after this one ends (the till's box, Docker Desktop): no window, its words to a log file.
    spawnDetached: (cmd, args, opts = {}) => {
      const out = opts.logFile === undefined ? 'ignore' : nodeFs.openSync(opts.logFile, 'a');
      const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, windowsHide: true, stdio: ['ignore', out, out], shell: false });
      child.unref();
      if (typeof out === 'number') nodeFs.closeSync(out);
      return { pid: child.pid };
    },
    processAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    killProcess: (pid) => { try { process.kill(pid); } catch { /* already gone */ } },
    askSecret,
    diskSpace: (dir) => { const s = nodeFs.statfsSync(dir); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; },
    fetch: (url) => fetch(url, { signal: AbortSignal.timeout(5_000) }),
    portInUse,
    sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
    now: () => new Date(),
    random: (n) => randomBytes(n),
    uuid: () => randomUUID(),
    os: { totalmem: () => os.totalmem(), release: () => os.release(), version: () => os.version() },
    freeDiskBytes: (dir) => { const s = nodeFs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); },
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    nodeVersion: process.version,
    nodePath: process.execPath,
    tmpdir: () => os.tmpdir(),
    say: (line) => { process.stdout.write(`${line}\n`); },
  };
}
