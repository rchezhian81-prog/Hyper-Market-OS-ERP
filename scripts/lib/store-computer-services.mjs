// The store computer's own programs as WINDOWS SERVICES, not Docker containers — ADR-0032 · roadmap change CR-01, step 1.
//
//   install-services --pg-bin <PostgreSQL bin folder> --service-host <WinSW.exe>
//                       the shop's database, its office API and its till (the store edge), each a Windows service that
//                       Windows starts at boot, restarts if it stops, and runs under its OWN low-privilege account
//   services-status     each service: installed? running? starting by itself? — and whether the API and the till answer
//   remove-services     stops and removes the three services; the shop's data, settings and logs are all KEPT
//
// ── What a service is here ─────────────────────────────────────────────────────────────────────────────────────────
//   SRE-Database  PostgreSQL 16 (the same major version as the containers), registered by its own `pg_ctl register`,
//                 its data in <data folder>\database, listening on 127.0.0.1 only (sre-store-computer.conf).
//   SRE-API       the office API (services/api/dist/start.js), behind a tiny service host (WinSW), started through
//                 scripts/store-computer-service.mjs, which reads the settings file when it starts, runs the schema
//                 migrations (as compose's `migrate` did on every `up`) and then the API on 127.0.0.1 only. It depends
//                 on SRE-Database, so Windows starts the database first.
//   SRE-Till      the till's store edge (edge/store-edge/dist/start.js), the same way, from till\till.env. It depends on
//                 NOTHING: with the API and the database stopped and the internet gone, the till still sells (P-01).
//
// ── Accounts: each service its own (least privilege, P-04) ─────────────────────────────────────────────────────────
// Each runs as its Windows "virtual service account" (NT SERVICE\<name>): an account nobody can sign in as, made by
// Windows for that one service, with no password anywhere. Its SID is worked out from the service name (serviceSid), so
// the folder rights below are given by SID — the same in every language of Windows. Each account may touch only its own
// things: the database its database folder; the API the settings file (read); the till its till folder; each its own log
// folder. The data-folder lock (store-computer-windows.mjs, dataLockRow) counts these three as "the shop's own services".
//
// ── Secrets (hard rule #4) ─────────────────────────────────────────────────────────────────────────────────────────
// No secret is ever written into a service definition, a command line or a log. The services read the ONE settings
// file the owner's `prepare` wrote (and the till's till.env) when they start. The database's first password goes to
// initdb through a file in the data folder's scratch folder that is deleted at once, and to psql through PGPASSWORD and
// standard input — never an argument. Tests look for every secret in every file, argument and line this module makes.
//
// ── Portability ────────────────────────────────────────────────────────────────────────────────────────────────────
// Node built-ins only; every program is started with an argument array and no shell. Everything that touches Windows
// arrives in `deps`, so the tests drive it with a pretend Windows; the clean-Windows CI job runs it for real.

import { createHash } from 'node:crypto';
import { guarded, loadSettings, parseEnvText, pathFor, PLACEHOLDER, waitReady, lines } from './store-computer.mjs';
import { refusedOnServer } from './store-computer-windows.mjs';
import { writeServicesMarker } from './store-computer-db.mjs';

// ── Names ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The three services, by their Windows names, in the order they are installed (and the reverse of removal). */
export const SERVICES = Object.freeze({ database: 'SRE-Database', api: 'SRE-API', till: 'SRE-Till' });
export const SERVICE_ORDER = Object.freeze([SERVICES.database, SERVICES.api, SERVICES.till]);
/** What the Windows Services list shows for each. */
export const DISPLAY = Object.freeze({
  [SERVICES.database]: 'SRE Retail OS - shop database',
  [SERVICES.api]: 'SRE Retail OS - office API',
  [SERVICES.till]: 'SRE Retail OS - till (store edge)',
});
export const DESCRIPTION = Object.freeze({
  [SERVICES.database]: "The shop's own database (PostgreSQL), on this PC only. Started by Windows at boot.",
  [SERVICES.api]: 'The office pages\' service, on this PC only. Needs the shop database. Started by Windows at boot.',
  [SERVICES.till]: 'The till: it keeps selling with no internet and no office service. Started by Windows at boot.',
});
/** The service host's own folder in the data folder, and the program that each Node service runs. */
export const SERVICES_DIR = 'services';
export const SERVICE_LAUNCHER = 'store-computer-service.mjs';
export const DATABASE_DIR = 'database';
export const LOGS_DIR = 'logs';
export const DB_CONF = 'sre-store-computer.conf';
/** How long a service is given to say RUNNING, and the API to say READY (the first start runs every migration). */
export const START_WAIT_MS = 2 * 60_000;
export const API_READY_WAIT_MS = 5 * 60_000;
/** The programs the PostgreSQL folder must hold. */
export const PG_PROGRAMS = Object.freeze(['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe', 'pg_isready.exe']);
/** The settings the API service is handed — the same list compose hands the API container, and nothing else. */
export const API_KEYS = Object.freeze([
  'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY', 'IDP_ISSUER', 'IDP_AUDIENCE',
  'IDP_OIDC_ISSUER', 'IDP_OIDC_JWKS_URL', 'IDP_OIDC_TENANT_ID', 'IDP_OIDC_SHOP_REALMS', 'IDP_OIDC_CUSTOMER_REALMS',
  'IDP_PROVISIONER_SECRET', 'MIGRATION_TARGET_KIND', 'PAYMENT_DATA_REGION', 'PAYMENT_BACKUP_REGION',
]);

/**
 * The SID of a service's virtual account (NT SERVICE\<name>), as Windows makes it: S-1-5-80- and the SHA-1 of the
 * service name in capitals (UTF-16LE), read as five little-endian 32-bit numbers. `sc.exe showsid <name>` prints the same.
 */
export function serviceSid(name) {
  const h = createHash('sha1').update(Buffer.from(String(name).toUpperCase(), 'utf16le')).digest();
  return `S-1-5-80-${[0, 4, 8, 12, 16].map((i) => h.readUInt32LE(i)).join('-')}`;
}
/** The three services' SIDs: the data-folder lock treats these as the shop's own, alongside the owner and SYSTEM. */
export const OWN_SERVICE_SIDS = Object.freeze(Object.fromEntries(SERVICE_ORDER.map((n) => [serviceSid(n), n])));
export const accountOf = (name) => `NT SERVICE\\${name}`;

// ── The plan (pure) ──────────────────────────────────────────────────────────────────────────────────────────────

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quoteArg = (s) => `"${String(s).replace(/"/g, '')}"`;

/** Where everything is, for this data folder and release. */
export function servicePaths({ platform, repoRoot, dataRoot, pgBin, serviceHost, nodePath }) {
  const p = pathFor(platform);
  const servicesDir = p.join(dataRoot, 'run', SERVICES_DIR);
  return {
    platform,
    repoRoot,
    dataRoot,
    settings: p.join(dataRoot, '.env.real'),
    tillDir: p.join(dataRoot, 'till'),
    tillEnv: p.join(dataRoot, 'till', 'till.env'),
    statusDir: p.join(dataRoot, 'status'),
    scratchDir: p.join(dataRoot, 'scratch'),
    databaseDir: p.join(dataRoot, DATABASE_DIR),
    dbConf: p.join(dataRoot, DATABASE_DIR, DB_CONF),
    logsDir: p.join(dataRoot, LOGS_DIR),
    logDirOf: (name) => p.join(dataRoot, LOGS_DIR, name),
    servicesDir,
    hostExeOf: (name) => p.join(servicesDir, `${name}.exe`),
    hostXmlOf: (name) => p.join(servicesDir, `${name}.xml`),
    launcher: p.join(repoRoot, 'scripts', SERVICE_LAUNCHER),
    apiBundle: p.join(repoRoot, 'services', 'api', 'dist', 'start.js'),
    edgeBundle: p.join(repoRoot, 'edge', 'store-edge', 'dist', 'start.js'),
    buildScript: p.join(repoRoot, 'scripts', 'build-service.mjs'),
    pgBin,
    pgProgram: (exe) => p.join(pgBin ?? '', exe),
    serviceHost,
    nodePath,
  };
}

/**
 * The service host's definition for one Node service (WinSW 2.x). No secret: only paths. Restarts after 10 s, 30 s and
 * 60 s if the program stops; the count is forgotten after an hour of running. 30 s to finish what is in hand at a stop.
 */
export function hostXml(P, name) {
  const kind = name === SERVICES.api ? 'api' : 'till';
  const settings = kind === 'api' ? P.settings : P.tillEnv;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Written by the store-computer tool (ADR-0032). No secret is in this file: the service reads its settings file when it starts. -->',
    '<service>',
    `  <id>${xmlEscape(name)}</id>`,
    `  <name>${xmlEscape(DISPLAY[name])}</name>`,
    `  <description>${xmlEscape(DESCRIPTION[name])}</description>`,
    `  <executable>${xmlEscape(P.nodePath)}</executable>`,
    `  <arguments>${xmlEscape(`${quoteArg(P.launcher)} ${kind} --settings ${quoteArg(settings)}`)}</arguments>`,
    `  <workingdirectory>${xmlEscape(P.repoRoot)}</workingdirectory>`,
    '  <startmode>Automatic</startmode>',
    ...(kind === 'api' ? [`  <depend>${SERVICES.database}</depend>`] : []),
    '  <onfailure action="restart" delay="10 sec"/>',
    '  <onfailure action="restart" delay="30 sec"/>',
    '  <onfailure action="restart" delay="60 sec"/>',
    '  <resetfailure>1 hour</resetfailure>',
    '  <stoptimeout>30 sec</stoptimeout>',
    `  <logpath>${xmlEscape(P.logDirOf(name))}</logpath>`,
    '  <log mode="roll-by-size">',
    '    <sizeThreshold>10240</sizeThreshold>',
    '    <keepFiles>8</keepFiles>',
    '  </log>',
    '</service>',
    '',
  ].join('\r\n');
}

/** The database's own settings file: this PC only, on the copy's port. Included from postgresql.conf. */
export function dbConfText(port) {
  return [
    '# Written by the store-computer tool (ADR-0032). The shop database listens on this PC only.',
    "listen_addresses = '127.0.0.1'",
    `port = ${Number(port)}`,
    '',
  ].join('\n');
}
export const DB_CONF_INCLUDE = `include_if_exists = '${DB_CONF}'`;

const SQL_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SAFE_PASSWORD = /^[A-Za-z0-9_-]{16,}$/;

/** The values the database set-up needs from the settings, or the names of what is wrong. */
export function databaseSettings(settings) {
  const db = settings.POSTGRES_DB ?? '';
  const admin = settings.POSTGRES_USER ?? '';
  const app = settings.APP_DB_USER || 'sre_app';
  const password = settings.POSTGRES_PASSWORD ?? '';
  const port = settings.POSTGRES_PORT || '5432';
  const problems = [];
  if (!SQL_NAME.test(db)) problems.push('POSTGRES_DB is not a plain database name');
  if (!SQL_NAME.test(admin)) problems.push('POSTGRES_USER is not a plain user name');
  if (!SQL_NAME.test(app)) problems.push('APP_DB_USER is not a plain user name');
  if (app === admin) problems.push('APP_DB_USER is the same as POSTGRES_USER (the API refuses the administrator)');
  if (!SAFE_PASSWORD.test(password)) problems.push('POSTGRES_PASSWORD is not one the prepare step made (letters and digits, 16 or more)');
  if (!/^\d{2,5}$/.test(port)) problems.push('POSTGRES_PORT is not a port number');
  return { db, admin, app, password, port, problems };
}

/**
 * What runs once in a new database: the shop's database and its APPLICATION role — not a superuser, not BYPASSRLS — the
 * same three statements as the container's first boot (infra/compose/db-init/01-app-role.sh). Sent on standard input.
 */
export function databaseSetupSql({ db, app, password }) {
  return [
    `SELECT format('CREATE DATABASE %I', '${db}') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${db}')\\gexec`,
    `\\connect ${db}`,
    'DO $$ BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${app}') THEN`,
    `    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', '${app}', '${password}');`,
    '  END IF;',
    'END $$;',
    `GRANT CONNECT, TEMPORARY ON DATABASE "${db}" TO "${app}";`,
    '-- The application role OWNS the schema objects (it runs the migrations), so FORCE ROW LEVEL SECURITY binds it too.',
    `GRANT ALL ON SCHEMA public TO "${app}";`,
    '',
  ].join('\n');
}

/**
 * The folder rights each service needs, by SID, as icacls arguments. (OI)(CI) = this folder and everything in it.
 * M = change, RX = read and run, R = read.
 */
export function grantsFor(P, exists) {
  const sid = (n) => `*${serviceSid(n)}`;
  const g = [];
  const add = (target, name, rights) => { g.push({ target, name, args: [target, '/grant', `${sid(name)}:${rights}`] }); };
  add(P.databaseDir, SERVICES.database, '(OI)(CI)M');
  // The PostgreSQL programs and their lib and share folders beside bin.
  add(pathFor(P.platform).dirname(P.pgBin), SERVICES.database, '(OI)(CI)RX');
  add(P.settings, SERVICES.api, 'R');
  add(P.tillDir, SERVICES.till, '(OI)(CI)M');
  if (exists(P.statusDir)) add(P.statusDir, SERVICES.till, '(OI)(CI)RX');
  for (const n of SERVICE_ORDER) add(P.logDirOf(n), n, '(OI)(CI)M');
  for (const n of [SERVICES.api, SERVICES.till]) {
    add(P.servicesDir, n, '(OI)(CI)RX');
    add(P.repoRoot, n, '(OI)(CI)RX');
  }
  return g;
}

// ── What the services are handed when they start (the launcher, scripts/store-computer-service.mjs) ─────────────

/** DATABASE_URL as the PC sees it: the compose name `db` is this PC, on the copy's port. */
export function hostDatabaseUrl(url, port) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'db') return url;
    u.hostname = '127.0.0.1';
    u.port = String(port || '5432');
    return u.toString();
  } catch { return url; }
}

/**
 * The environment one service runs with: what Windows gave the service (its own folders, SystemRoot …) plus — for the
 * API — ONLY the settings compose hands the API container, on this PC's loopback; for the till, every till.env setting
 * (as start-till.cmd sets them) and this release's screens. Never logged.
 */
export function serviceEnv(kind, settings, base, repoRoot, platform = 'win32') {
  const p = pathFor(platform);
  if (kind === 'api') {
    const picked = Object.fromEntries(API_KEYS.filter((k) => settings[k] !== undefined && settings[k] !== '').map((k) => [k, settings[k]]));
    return {
      ...base,
      TZ: base.TZ ?? 'Asia/Kolkata',
      ...picked,
      DATABASE_URL: hostDatabaseUrl(settings.DATABASE_URL ?? '', settings.POSTGRES_PORT),
      PORT: settings.API_PORT || '8081',
      API_LISTEN_HOST: '127.0.0.1',
      NODE_ENV: 'production',
      MIGRATION_TARGET_KIND: settings.MIGRATION_TARGET_KIND || 'rehearsal',
    };
  }
  const own = Object.fromEntries(Object.entries(settings).filter(([k]) => k !== 'EDGE_SCREEN_HOST'));
  return { ...base, TZ: base.TZ ?? 'Asia/Kolkata', ...own, EDGE_APPS_DIR: p.join(repoRoot, 'apps') };
}

// ── Talking to Windows ───────────────────────────────────────────────────────────────────────────────────────────

const SC = 'sc.exe';
const ICACLS = 'icacls.exe';

/** A service's state: 'missing' · 'running' · 'stopped' · 'starting' · 'stopping' · 'other'. */
export function serviceState(deps, name) {
  const r = deps.spawn(SC, ['query', name], {});
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status === 1060 || /\b1060\b/.test(text)) return 'missing';
  const m = /STATE\s*:\s*(\d+)/.exec(text);
  if (m === null) return r.status === 0 ? 'other' : 'missing';
  return { 1: 'stopped', 2: 'starting', 3: 'stopping', 4: 'running' }[Number(m[1])] ?? 'other';
}

/** How the service is set to start, and as whom: { auto, account, dependsOn }. */
export function serviceConfig(deps, name) {
  const r = deps.spawn(SC, ['qc', name], {});
  const text = String(r.stdout ?? '');
  const start = /START_TYPE\s*:\s*(\d+)/.exec(text);
  const account = /SERVICE_START_NAME[ \t]*:[ \t]*([^\r\n]+)/.exec(text);
  const dep = /DEPENDENCIES[ \t]*:[ \t]*([^\r\n]*)/.exec(text);
  return { auto: start !== null && Number(start[1]) === 2, account: account?.[1]?.trim(), dependsOn: dep?.[1]?.trim() ?? '' };
}

async function waitForState(deps, name, want, waitMs = START_WAIT_MS) {
  const deadline = deps.now().getTime() + waitMs;
  for (;;) {
    const s = serviceState(deps, name);
    if (s === want) return true;
    if (deps.now().getTime() >= deadline) return false;
    await deps.sleep(2_000);
  }
}

const ran = (r) => r.error === undefined && r.status === 0;
// What a program said; when it said nothing (it could not even start), why: Windows' own code, in plain words for the
// one seen on the owner's PC (0xC0000135, a missing DLL — there, Microsoft's Visual C++ runtime).
const said = (r) => {
  const words = lines(`${r.stdout ?? ''}\n${r.stderr ?? ''}`).slice(-3).join(' / ');
  if (words !== '') return words;
  if (r.error !== undefined) return `it could not be started (${r.error.code ?? r.error.message ?? 'error'})`;
  if (r.status === 3221225781 || r.status === -1073741515) return 'it could not start: a part of Windows it needs is missing (Microsoft Visual C++ runtime — run SRE-Setup.exe again, which installs it)';
  return r.status === null || r.status === undefined ? 'it said nothing' : `it ended with code ${r.status} and said nothing`;
};

// ── install-services ─────────────────────────────────────────────────────────────────────────────────────────────

/** Everything that must be true before anything is changed: a list of refusals, plain words. */
export function preflight(deps, P, settings) {
  const fs = deps.fs;
  const out = [];
  if (P.pgBin === undefined || String(P.pgBin).trim() === '') out.push('name the PostgreSQL 16 programs folder with --pg-bin <folder> (the setup program does this for you)');
  else {
    const missing = PG_PROGRAMS.filter((exe) => !fs.existsSync(P.pgProgram(exe)));
    if (missing.length > 0) out.push(`the PostgreSQL folder ${P.pgBin} has no ${missing.join(', ')}`);
  }
  if (P.serviceHost === undefined || String(P.serviceHost).trim() === '') out.push('name the service host program with --service-host <WinSW.exe> (the setup program does this for you)');
  else if (!fs.existsSync(P.serviceHost)) out.push(`the service host program ${P.serviceHost} is not there`);
  if (!fs.existsSync(P.tillEnv)) out.push(`the till is not installed in the data folder yet (${P.tillEnv} is missing) — run first: pnpm run till:install -- --settings ${P.settings} --lane lane-1`);
  if (!fs.existsSync(P.launcher)) out.push(`this release has no ${SERVICE_LAUNCHER} — it is not a complete copy of the system`);
  const db = databaseSettings(settings);
  for (const pr of db.problems) out.push(`in the settings file, ${pr}`);
  return out;
}

/** The Docker copy of this shop, if it is still running here: moving it across is the setup program's job (CR-01 step 2). */
function dockerCopyRunning(deps) {
  const r = deps.spawn('docker', ['ps', '--filter', 'label=com.docker.compose.project=sre-real', '--format', '{{.Names}}'], {});
  if (r.error !== undefined || r.status !== 0) return false;
  return lines(r.stdout).length > 0;
}

/** `install-services`: the three services, installed, given their rights, started, and seen to answer. Re-running is safe. */
export async function installServices(deps, opts) {
  const { say, fs } = deps;
  if (deps.platform !== 'win32') { say('REFUSED — Windows services are for the store computer (Windows 10 or 11). On this computer, use: pnpm run store-computer -- up'); return 2; }
  if (refusedOnServer(deps)) return 2;
  const { L, settings } = loadSettings(deps);
  if (settings === undefined) { say('REFUSED — this copy has no settings file yet. Run first: pnpm run store-computer -- prepare'); return 2; }
  if (L.mode !== 'data-folder') { say('REFUSED — this copy keeps its settings inside the release folder. Move them first: pnpm run store-computer -- migrate-data-folder'); return 2; }
  if (guarded(deps, settings)) return 2;
  const placeholders = Object.entries(settings).filter(([k, v]) => v.includes(PLACEHOLDER) && !k.startsWith('KEYCLOAK_')).map(([k]) => k);
  if (placeholders.length > 0) { say(`REFUSED — the settings file still has a placeholder in ${placeholders.join(', ')}. Nothing was changed.`); return 2; }

  const P = servicePaths({ platform: deps.platform, repoRoot: deps.repoRoot, dataRoot: L.dataRoot, pgBin: opts.pgBin, serviceHost: opts.serviceHost, nodePath: deps.nodePath });
  const stop = preflight(deps, P, settings);
  if (stop.length > 0) { for (const s of stop) say(`REFUSED — ${s}. Nothing was changed.`); return 2; }
  if (dockerCopyRunning(deps)) {
    say('REFUSED — this shop\'s copy is still running in Docker (project sre-real). Moving it to Windows services, keeping its data, is the setup program\'s job (CR-01, step 2). Nothing was changed.');
    return 2;
  }
  const db = databaseSettings(settings);
  const till = parseEnvText(fs.readFileSync(P.tillEnv, 'utf8'));
  const apiPort = settings.API_PORT || '8081';
  const screenPort = till.EDGE_SCREEN_PORT;

  // Ports: a port taken by something else is named before anything is changed (only for a service not yet here).
  for (const [name, port] of [[SERVICES.database, db.port], [SERVICES.api, apiPort], [SERVICES.till, till.EDGE_LANE_PORT], [SERVICES.till, screenPort]]) {
    if (port === undefined || port === '') continue;
    if (serviceState(deps, name) !== 'missing') continue;
    if (await deps.portInUse(Number(port))) {
      say(`NOT INSTALLED — port ${port} on this computer is already taken by another program, so ${DISPLAY[name]} cannot use it. Nothing was changed.`);
      say('  What to do: restart the computer and run this again. If it says this again, send me a photo of this screen.');
      return 1;
    }
  }

  // The programs the two Node services run, built from this release (as the containers build them). An installed release
  // (release.json beside scripts/) brings them built, and has no build tools.
  const prebuilt = fs.existsSync(pathFor(deps.platform).join(deps.repoRoot, 'release.json')) && fs.existsSync(P.apiBundle) && fs.existsSync(P.edgeBundle);
  for (const what of prebuilt ? [] : ['api', 'edge']) {
    const b = deps.spawn(deps.nodePath, [P.buildScript, what, '--quiet'], { cwd: deps.repoRoot, env: deps.env });
    if (!ran(b)) { say(`NOT INSTALLED — this release's ${what === 'api' ? 'office API' : 'till'} program could not be built. ${said(b)}`); return 1; }
  }
  for (const dir of [P.servicesDir, P.logsDir, P.scratchDir, ...SERVICE_ORDER.map((n) => P.logDirOf(n))]) fs.mkdirSync(dir, { recursive: true });

  // 1 — The database. From here on the tool reaches it as a Windows service (store-computer-db.mjs).
  const dbDone = await installDatabase(deps, P, db);
  if (dbDone !== 0) return dbDone;
  writeServicesMarker(deps, P.dataRoot, { pgBin: P.pgBin, port: db.port });
  // CR-01 step 2c (OI-08): a copy moved from Docker has its data restored HERE — into the new, empty database, before the
  // office service starts (and runs the migrations) on it.
  if (opts.afterDatabase !== undefined) {
    const moved = await opts.afterDatabase({ pgBin: P.pgBin, port: db.port });
    if (moved !== 0) return moved;
  }

  // 2 — The API and the till, behind the service host.
  for (const name of [SERVICES.api, SERVICES.till]) {
    const r = installHosted(deps, P, name);
    if (r !== 0) return r;
  }

  // 3 — Rights: each service its own things, by SID (works in every language of Windows).
  for (const g of grantsFor(P, (t) => fs.existsSync(t))) {
    const r = deps.spawn(ICACLS, g.args, {});
    if (!ran(r)) { say(`NOT INSTALLED — Windows would not give ${g.name} its rights on ${g.target}. ${said(r)}`); return 1; }
  }

  // 4 — Start, in order, and see each one answer.
  for (const name of SERVICE_ORDER) {
    if (serviceState(deps, name) !== 'running') deps.spawn(SC, ['start', name], {});
    if (!(await waitForState(deps, name, 'running'))) {
      say(`NOT STARTED — ${DISPLAY[name]} did not start. Its own words are in ${P.logDirOf(name)}.`);
      say('  What to do: send me a photo of this screen.');
      return 1;
    }
    say(`STARTED — ${DISPLAY[name]} (${name}), running as ${accountOf(name)}.`);
  }
  say('Waiting for the office API to say it is ready (the first time, it builds the database tables)…');
  if (!(await waitReady(deps, apiPort, API_READY_WAIT_MS))) {
    say(`NOT READY — the office API did not say ready within ${API_READY_WAIT_MS / 60_000} minutes. Its own words are in ${P.logDirOf(SERVICES.api)}.`);
    return 1;
  }
  if (screenPort !== undefined && !(await pageAnswers(deps, screenPort))) {
    say(`NOT READY — the till's screens did not answer on this PC. Its own words are in ${P.logDirOf(SERVICES.till)}.`);
    return 1;
  }
  say('READY — the shop database, the office API and the till run as Windows services on this PC only, and start by themselves when Windows starts. No Docker is used.');
  say(`  The till: http://127.0.0.1:${screenPort ?? '8091'}/pos/   The shop's data stays in ${P.dataRoot}.`);
  return 0;
}

async function pageAnswers(deps, port) {
  const deadline = deps.now().getTime() + START_WAIT_MS;
  for (;;) {
    try { const r = await deps.fetch(`http://127.0.0.1:${port}/pos/`); if (r.ok) return true; } catch { /* not yet */ }
    if (deps.now().getTime() >= deadline) return false;
    await deps.sleep(2_000);
  }
}

/** The database: made once (never over an existing one), told to listen on this PC only, registered, started, set up. */
async function installDatabase(deps, P, db) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const name = SERVICES.database;
  if (!fs.existsSync(p.join(P.databaseDir, 'PG_VERSION'))) {
    if (fs.existsSync(P.databaseDir) && fs.readdirSync(P.databaseDir).length > 0) {
      say(`REFUSED — ${P.databaseDir} holds files but is not a database. It is never overwritten. Send me a photo of this screen.`);
      return 2;
    }
    // The administrator's first password goes to initdb in a file only it reads, deleted straight after (never an argument).
    const pwFile = p.join(P.scratchDir, `initdb-${deps.random(8).toString('hex')}.tmp`);
    fs.writeFileSync(pwFile, `${db.password}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    let made;
    try {
      made = deps.spawn(P.pgProgram('initdb.exe'), ['-D', P.databaseDir, '-U', db.admin, `--pwfile=${pwFile}`, '-E', 'UTF8', '--locale=C', '-A', 'scram-sha-256'], { env: deps.env });
    } finally {
      fs.rmSync(pwFile, { force: true });
    }
    if (!ran(made)) { say(`NOT INSTALLED — the shop database could not be made. ${said(made)}`); return 1; }
    say(`The shop database was made in ${P.databaseDir}.`);
  } else {
    say(`The shop database in ${P.databaseDir} is kept as it is.`);
  }
  fs.writeFileSync(P.dbConf, dbConfText(db.port), 'utf8');
  const confFile = p.join(P.databaseDir, 'postgresql.conf');
  const conf = fs.readFileSync(confFile, 'utf8');
  if (!conf.split(/\r?\n/).some((l) => l.trim() === DB_CONF_INCLUDE)) fs.appendFileSync(confFile, `\n# ADR-0032: this PC only (written by the store-computer tool)\n${DB_CONF_INCLUDE}\n`, 'utf8');

  if (serviceState(deps, name) === 'missing') {
    const reg = deps.spawn(P.pgProgram('pg_ctl.exe'), ['register', '-N', name, '-D', P.databaseDir, '-S', 'auto', '-w'], { env: deps.env });
    if (!ran(reg)) { say(`NOT INSTALLED — Windows would not take the shop database as a service. ${said(reg)}`); return 1; }
  }
  const cfg = configureService(deps, name);
  if (cfg !== 0) return cfg;
  // Its rights now (it must write its own folder before it can start); the rest are given together below.
  const own = grantsFor(P, () => false).filter((g) => g.name === name);
  for (const g of own) {
    const r = deps.spawn(ICACLS, g.args, {});
    if (!ran(r)) { say(`NOT INSTALLED — Windows would not give ${name} its rights on ${g.target}. ${said(r)}`); return 1; }
  }
  if (serviceState(deps, name) !== 'running') deps.spawn(SC, ['start', name], {});
  if (!(await waitForState(deps, name, 'running'))) { say(`NOT STARTED — the shop database did not start. Windows' Event Viewer (Application) has its words.`); return 1; }
  const deadline = deps.now().getTime() + START_WAIT_MS;
  for (;;) {
    const r = deps.spawn(P.pgProgram('pg_isready.exe'), ['-h', '127.0.0.1', '-p', db.port, '-U', db.admin, '-d', 'postgres'], {});
    if (ran(r)) break;
    if (deps.now().getTime() >= deadline) { say('NOT STARTED — the shop database is running but does not answer on this PC.'); return 1; }
    await deps.sleep(2_000);
  }
  const setup = deps.spawn(P.pgProgram('psql.exe'), ['-h', '127.0.0.1', '-p', db.port, '-U', db.admin, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q'], {
    env: { ...deps.env, PGPASSWORD: db.password }, input: databaseSetupSql(db),
  });
  if (!ran(setup)) { say(`NOT INSTALLED — the shop database could not be set up. ${said(setup)}`); return 1; }
  say(`The shop database "${db.db}" and its application login "${db.app}" (not an administrator) are ready.`);
  return 0;
}

/** Each service: its own account (no password anywhere), restart on failure, its plain description. */
function configureService(deps, name) {
  const steps = [
    ['config', name, 'obj=', accountOf(name), 'start=', 'auto', 'DisplayName=', DISPLAY[name]],
    ['failure', name, 'reset=', '3600', 'actions=', 'restart/10000/restart/30000/restart/60000'],
    ['description', name, DESCRIPTION[name]],
  ];
  for (const args of steps) {
    const r = deps.spawn(SC, args, {});
    if (!ran(r)) { deps.say(`NOT INSTALLED — Windows would not set up ${name} (${args[0]}). ${said(r)}`); return 1; }
  }
  return 0;
}

/** A Node service behind the service host: its copy of the host and its definition, installed once, then configured. */
function installHosted(deps, P, name) {
  const { fs, say } = deps;
  const exe = P.hostExeOf(name);
  const xml = P.hostXmlOf(name);
  const fresh = serviceState(deps, name) === 'missing';
  if (fresh || !fs.existsSync(exe)) fs.copyFileSync(P.serviceHost, exe);
  fs.writeFileSync(xml, hostXml(P, name), 'utf8');
  if (fresh) {
    const r = deps.spawn(exe, ['install'], { cwd: P.servicesDir });
    if (!ran(r)) { say(`NOT INSTALLED — Windows would not take ${DISPLAY[name]} as a service. ${said(r)}`); return 1; }
  }
  return configureService(deps, name);
}

// ── services-status ──────────────────────────────────────────────────────────────────────────────────────────────

/** `services-status`: one line per service and one per answer; 0 when everything runs and answers. */
export async function servicesStatus(deps) {
  const { say } = deps;
  if (deps.platform !== 'win32') { say('Windows services are for the store computer (Windows 10 or 11). On this computer: pnpm run store-computer -- status'); return 2; }
  const { settings } = loadSettings(deps);
  let bad = 0;
  for (const name of SERVICE_ORDER) {
    const state = serviceState(deps, name);
    if (state === 'missing') { say(`MISSING  ${DISPLAY[name]} (${name}) is not installed.`); bad += 1; continue; }
    const cfg = serviceConfig(deps, name);
    const okAccount = String(cfg.account ?? '').toLowerCase() === accountOf(name).toLowerCase();
    const good = state === 'running' && cfg.auto && okAccount;
    if (!good) bad += 1;
    say(`${good ? 'OK      ' : 'FIX     '} ${DISPLAY[name]} (${name}): ${state}; ${cfg.auto ? 'starts by itself' : 'does NOT start by itself'}; runs as ${cfg.account ?? 'unknown'}${okAccount ? '' : ` (should be ${accountOf(name)})`}.`);
  }
  const apiPort = settings?.API_PORT || '8081';
  const apiReady = await waitReady(deps, apiPort, 0);
  if (!apiReady) bad += 1;
  say(`${apiReady ? 'OK      ' : 'FIX     '} the office API ${apiReady ? 'says ready' : 'does not say ready'} on this PC.`);
  return bad === 0 ? 0 : 1;
}

// ── remove-services ──────────────────────────────────────────────────────────────────────────────────────────────

/** `remove-services`: stop and remove the three services, till first. Nothing of the shop's data is touched. */
export async function removeServices(deps) {
  const { say } = deps;
  if (deps.platform !== 'win32') { say('REFUSED — there are no Windows services on this computer.'); return 2; }
  const { L } = loadSettings(deps);
  const P = servicePaths({ platform: deps.platform, repoRoot: deps.repoRoot, dataRoot: L.dataRoot ?? deps.dataRoot ?? '', nodePath: deps.nodePath });
  let failed = 0;
  for (const name of [...SERVICE_ORDER].reverse()) {
    if (serviceState(deps, name) === 'missing') { say(`${DISPLAY[name]} (${name}): not installed.`); continue; }
    deps.spawn(SC, ['stop', name], {});
    await waitForState(deps, name, 'stopped', 60_000);
    const r = deps.spawn(SC, ['delete', name], {});
    if (!ran(r)) { say(`NOT REMOVED — ${DISPLAY[name]} (${name}). ${said(r)}`); failed += 1; continue; }
    say(`REMOVED — ${DISPLAY[name]} (${name}).`);
  }
  say(`Kept, untouched: the shop database (${P.databaseDir}), the settings file, the till's data (${P.tillDir}) and every log (${P.logsDir}).`);
  return failed === 0 ? 0 : 1;
}
