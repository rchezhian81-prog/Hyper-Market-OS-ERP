// The store computer's backup, restore-and-reconcile and rollback drill — OB-246 (gap G-RD-6, pilot gate G9), built
// into the owner's guided tool so they run on his Windows 10/11 PC with Docker Desktop, Node 22 and pnpm only: no
// PostgreSQL tools on the computer itself, no bash, no git (his code comes from a ZIP download).
//
//   backup --to <folder>          pg_dump runs INSIDE this copy's database container; with the till's data and the
//                                 settings it is ENCRYPTED onto the backup drive (OB-249), with a manifest (sizes,
//                                 SHA-256s, time taken, row counts) — all read-only
//   restore-check --from <file>   opens it with the backup passphrase, restores the database into a NEW scratch database
//                                 inside the same container (never into sre_real), reconciles it against the manifest,
//                                 checks the till's data file by file and the settings copy, records the result, then
//                                 drops ONLY the scratch database it made
//   drill --by "<name>" --to <folder> --previous <folder> [--run]
//                                 the timed G9 drill: backup → restore-check → the previous release back → this release
//                                 back, each against the roadmap §32 targets; a new dated record every time
//
// ── One moment, two views (audit GT-07) ───────────────────────────────────────────────────────────────────────────
// The row counts in the manifest and the dump come from ONE database moment. A single psql session inside the
// container opens a REPEATABLE READ, READ ONLY transaction, exports its snapshot, counts every table inside it, and
// then — while that transaction is still open — runs `pg_dump --snapshot=<that snapshot>` through psql's `\!`. psql's
// own output is sent to stderr (`\o | cat 1>&2`), so the only thing on stdout is pg_dump's archive, which goes
// straight into the file on the drive: the dump never passes through this program's memory, whatever its size.
//
// ── What "putting the previous release back" means here, honestly ─────────────────────────────────────────────────
// The store computer runs the release in the folder the ZIP was extracted to. The previous release is the previous
// ZIP, kept extracted in its own folder (for example C:\SRE-previous). Going back = building and starting that folder's
// services under the same compose project, with THIS copy's settings file and THIS copy's database. The database is
// NOT rolled back: the repository's migrations only add (db/migrations; release.sh says the same), and none has a
// "down" step. So the drill first proves the previous release's migrations are an exact prefix of this release's (same
// names, same contents) and are all applied; then the previous release's services run against the current schema —
// which is exactly what would happen on a real bad night — and the drill checks the previous release's migrate step
// added nothing. If that cannot be proved, the drill refuses rather than pretending (it never fakes a rollback).
//
// Nothing is ever deleted (hard rule #6): no backup, no manifest, no record. The ONE thing removed is the scratch
// database restore-check itself created, by a name that can only be a scratch name, and only after the result is on
// the drive. No secret is ever printed or written into a manifest or a record (hard rule #4). Every program is started
// with an argument array and no shell.

import { createHash } from 'node:crypto';
import { DRILL_TARGETS } from './rollback-drill.mjs';
import {
  DEMO_PROJECT, FINGERPRINT_KEYS, PROJECT, SETTINGS_NAME, composeBase, composeEnv, dockerProblem, fingerprintsOf, guarded, lines,
  loadSettings, ownDriveProblem, parseEnvText, pathFor, rel, stampOf, waitReady,
} from './store-computer.mjs';
import {
  MIN_PASSPHRASE, SCRYPT, decryptFile, encryptFile, keyFileProblem, makeBackupKey, openJson, passphraseProblem, publicKeyOf,
  sealJson, unlockBackupKey,
} from './store-computer-crypto.mjs';
import { checkBundle, tillSummary, writeBundle } from './store-computer-files.mjs';
import { backupDriveProblem } from './store-computer-windows.mjs';

// ── Encryption (OB-249 · audit rows 2–3, lane B B7 and B6/Q8) ─────────────────────────────────────────────────────
// Since OB-249 every backup is ENCRYPTED and holds EVERYTHING: the database, the till's own data (edge-data: unsent
// sales, the queue, dead letters, PIN verifiers; and till.env), the check records, and an encrypted copy of this copy's
// settings file (.env.real) — so a dead disk loses neither sales nor keys. See store-computer-crypto.mjs for the scheme
// (encrypted to a public key; the private key sealed with the owner's passphrase, which is never stored) and
// store-computer-files.mjs for how the till's data is copied consistently while the till keeps selling.
//
// The plain working copies (the dump and the bundle) are made in the data folder's scratch folder on THIS computer's
// own disk — where the live database already is — encrypted onto the drive, and then removed. Nothing plain ever reaches
// the backup drive. Removing a working copy is not deleting evidence: the backup is the encrypted file, which is kept.

// ── Fixed names ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Every scratch database restore-check makes starts with this, and nothing else ever does. */
export const SCRATCH_PREFIX = 'sre_restore_check_';
const SCRATCH = /^sre_restore_check_\d{14}(?:_\d{1,3})?$/;
/** A database or role name this tool will put into SQL: plain lower-case identifiers only (checked before use). */
const PLAIN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/** Row-level security (migration 0012): the platform's view, every tenant — the same scope the other backup tools use. */
export const PLATFORM_PGOPTIONS = 'PGOPTIONS=-c app.tenant_id=*';
/** A custom-format pg_dump archive starts with these five bytes. */
const DUMP_MAGIC = 'PGDMP';
/** How long a release may take to say READY after Docker has started it. */
export const DRILL_READY_WAIT_MS = 10 * 60_000;
/** What the API image is built from (infra/docker/api.Dockerfile): two releases that differ in none of these are one. */
export const RELEASE_INPUTS = Object.freeze(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'packages', 'services', 'db', 'scripts', 'infra/docker', 'infra/compose/docker-compose.yml']);
const RELEASE_SKIP = new Set(['node_modules', 'dist', 'records', 'coverage', '.turbo', '.git']);

/**
 * The scratch database's name, from the clock: `sre_restore_check_YYYYMMDDHHMMSS`, with `_2`, `_3`… if that one is
 * already there. Never the copy's own database — `assertScratch` is called again on every use.
 */
export function scratchName(at, taken) {
  const base = `${SCRATCH_PREFIX}${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  for (let i = 1; i < 1000; i += 1) {
    const name = i === 1 ? base : `${base}_${i}`;
    if (!taken.includes(name)) return name;
  }
  throw new Error('no free scratch database name');
}

/** Throws unless `name` is a scratch name and is not this copy's own database. The last lock before any CREATE, restore or DROP. */
export function assertScratch(name, settings) {
  const own = String(settings?.POSTGRES_DB || 'sre_real');
  if (typeof name !== 'string' || !SCRATCH.test(name) || name === own || name === 'sre_real' || name === 'postgres' || name.startsWith('template')) {
    throw new Error(`refusing to use "${String(name)}" as a scratch database: only a new ${SCRATCH_PREFIX}… database is ever restored into or removed`);
  }
  return name;
}

// ── The SQL the tool sends (no value from outside is ever put into it except checked plain names) ─────────────────

/** psql lines that print the control totals as tagged lines: ROWS|table|n · VAL|type|minor · SEQ|n · MIG|name. */
export function totalsScript() {
  return [
    "SELECT format('SELECT %L || count(*) FROM public.%I', 'ROWS|' || tablename || '|', tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \\gexec",
    "SELECT CASE WHEN to_regclass('public.event_ledger') IS NOT NULL THEN $q$SELECT 'VAL|' || type || '|' || coalesce(sum((payload->>'totalMinor')::bigint), 0) FROM event_ledger WHERE payload ? 'totalMinor' GROUP BY type ORDER BY type$q$ END \\gexec",
    "SELECT CASE WHEN to_regclass('public.event_ledger') IS NOT NULL THEN $q$SELECT 'SEQ|' || coalesce(max(seq), 0) FROM event_ledger$q$ END \\gexec",
    "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NOT NULL THEN $q$SELECT 'MIG|' || name FROM schema_migrations ORDER BY name$q$ END \\gexec",
  ];
}

/**
 * The one psql session the backup runs inside the container: one REPEATABLE READ snapshot, the totals read in it, and
 * pg_dump of exactly that snapshot written to stdout (psql's own output goes to stderr, so stdout is the archive only).
 */
export function backupScript({ user, database }) {
  for (const n of [user, database]) if (!PLAIN_NAME.test(String(n))) throw new Error(`not a plain database name: ${String(n)}`);
  return [
    '\\set ON_ERROR_STOP 1',
    // To stderr through `cat`: opening /dev/stderr itself fails when stderr is a socket (ENXIO), a pipe never does.
    '\\o | cat 1>&2',
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
    'SELECT pg_export_snapshot() AS sre_snapshot \\gset',
    "SELECT 'SNAP|' || :'sre_snapshot';",
    ...totalsScript(),
    '\\setenv SRE_SNAPSHOT :sre_snapshot',
    `\\setenv PGUSER ${user}`,
    `\\setenv PGDATABASE ${database}`,
    '\\! pg_dump --format=custom --enable-row-security --snapshot="$SRE_SNAPSHOT"',
    "SELECT 'DUMPEXIT|' || :'SHELL_EXIT_CODE';",
    'COMMIT;',
    "SELECT 'DONE|';",
    '',
  ].join('\n');
}

/** Read the tagged lines back. Anything else on the stream (a NOTICE, an error) is left for the caller to show. */
export function parseTotals(text) {
  const out = { rowCounts: {}, valueTotals: {}, maxEventSeq: null, migrations: [], snapshot: undefined, dumpExit: undefined, done: false, other: [] };
  for (const line of lines(text)) {
    const bar = line.indexOf('|');
    const tag = bar === -1 ? '' : line.slice(0, bar);
    const rest = bar === -1 ? '' : line.slice(bar + 1);
    const last = rest.lastIndexOf('|');
    if (tag === 'ROWS' && last > 0) out.rowCounts[rest.slice(0, last)] = Number(rest.slice(last + 1));
    else if (tag === 'VAL' && last > 0) out.valueTotals[rest.slice(0, last)] = Number(rest.slice(last + 1));
    else if (tag === 'SEQ') out.maxEventSeq = Number(rest);
    else if (tag === 'MIG') out.migrations.push(rest);
    else if (tag === 'SNAP') out.snapshot = rest;
    else if (tag === 'DUMPEXIT') out.dumpExit = rest === '' ? undefined : Number(rest);
    else if (tag === 'DONE') out.done = true;
    else out.other.push(line);
  }
  return out;
}

/** What differs between the manifest's totals and what the restored database holds — each one plain line, or none. */
export function reconcile(expected, got) {
  const differences = [];
  const tables = new Set([...Object.keys(expected.rowCounts ?? {}), ...Object.keys(got.rowCounts ?? {})]);
  for (const t of [...tables].sort()) {
    const e = expected.rowCounts?.[t];
    const g = got.rowCounts?.[t];
    if (e === undefined) differences.push(`table ${t}: not in the backup's manifest, but ${g} row(s) after the restore`);
    else if (g === undefined) differences.push(`table ${t}: ${e} row(s) in the manifest, but the table is missing after the restore`);
    else if (e !== g) differences.push(`table ${t}: ${e} row(s) in the manifest, ${g} after the restore`);
  }
  const streams = new Set([...Object.keys(expected.valueTotals ?? {}), ...Object.keys(got.valueTotals ?? {})]);
  for (const s of [...streams].sort()) {
    const e = expected.valueTotals?.[s] ?? 0;
    const g = got.valueTotals?.[s] ?? 0;
    if (e !== g) differences.push(`money in ${s}: ${e} paise in the manifest, ${g} after the restore`);
  }
  if ((expected.maxEventSeq ?? 0) !== (got.maxEventSeq ?? 0)) differences.push(`the newest event: number ${expected.maxEventSeq ?? 0} in the manifest, ${got.maxEventSeq ?? 0} after the restore`);
  return differences;
}

// ── Small helpers over `deps` ─────────────────────────────────────────────────────────────────────────────────────

/** `docker compose … exec -T -e PGOPTIONS=… db <program> <args>` — this copy's own database container, never another. */
export const dbExec = (program, args, L) => [...composeBase(L), 'exec', '-T', '-e', PLATFORM_PGOPTIONS, 'db', program, ...args];
const psqlArgs = (user, database) => ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database];

/** SHA-256 of a file, read in pieces (a backup can be larger than memory). */
export function hashFile(fs, file) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function startsWithMagic(fs, file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(DUMP_MAGIC.length);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return n === DUMP_MAGIC.length && buf.toString('latin1') === DUMP_MAGIC;
  } finally { fs.closeSync(fd); }
}

export const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
export const mins = (ms) => `${(ms / 60_000).toFixed(1)} min`;
/** The first line a program said on its error stream, cut short — enough to name the problem, never a page of output. */
const firstProblem = (text) => (lines(text).find((l) => /error|fatal|could not|failed|denied|no such/i.test(l)) ?? lines(text)[0] ?? '').slice(0, 200);

/** A new file name in `dir` from `stem` and `ext` that does not exist yet — never overwriting one. */
export function freshName(deps, dir, stem, ext) {
  const p = pathFor(deps.platform);
  for (let i = 1; ; i += 1) {
    const candidate = p.join(dir, `${stem}${i === 1 ? '' : `-${i}`}${ext}`);
    if (!deps.fs.existsSync(candidate)) return candidate;
  }
}

export function writeRecord(deps, file, record, readOnly) {
  deps.fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  if (readOnly) deps.fs.chmodSync(file, 0o444);
}

/** The folder the owner named for a backup drive, checked as check 10 checks it. Returns the problem, or undefined. */
export function folderRefusal(deps, dir) {
  const problem = ownDriveProblem(dir, { platform: deps.platform, repoRoot: deps.repoRoot, systemDrive: deps.env.SystemDrive, dataRoot: deps.dataRoot })
    // OB-281 · OB-283: then Windows is asked what kind of drive it is — only a USB or removable drive is accepted.
    ?? backupDriveProblem(deps, dir);
  return problem === undefined ? undefined : `${problem}. A backup goes to one of your own USB backup drives only (for example E:\\sre-real) — never onto a disk inside this computer (C: or F:), into the shop's data folder or into the system's folder.`;
}

/** Everything a command needs before it touches Docker: the settings, the refusals, Docker itself. */
export function ready(deps) {
  const { L, settings } = loadSettings(deps);
  if (settings === undefined) { deps.say('REFUSED — this copy has no settings file yet. Run first: pnpm run store-computer -- prepare'); return { code: 2 }; }
  if (guarded(deps, settings)) return { code: 2 };
  const user = String(settings.POSTGRES_USER || 'sre_admin');
  const database = String(settings.POSTGRES_DB || 'sre_real');
  if (!PLAIN_NAME.test(user) || !PLAIN_NAME.test(database)) {
    deps.say('REFUSED — the database name or user in this copy\'s settings is not a plain name (small letters, digits and _ only). Send me a photo of this screen (never of the file).');
    return { code: 2 };
  }
  return { L, settings, user, database, env: composeEnv(deps.env, settings) };
}

/** A backup needs the data folder (its key, its scratch space). A copy still inside the release folder is moved first. */
export function dataFolderReady(deps, ctx) {
  if (ctx.L.mode === 'data-folder') return true;
  deps.say("REFUSED — this copy's settings and the till's data are still inside the system's own folder, where a new release would replace them.");
  deps.say('  Move them first: close the till window, then run: pnpm run store-computer -- migrate-data-folder');
  return false;
}

export function dockerReady(deps) {
  const docker = dockerProblem(deps);
  if (docker === undefined) return true;
  deps.say(`NOT DONE — ${docker.what}`);
  deps.say(`  What to do: ${docker.fix}`);
  return false;
}

// ── The backup key (OB-249: "encrypted, with a passphrase the owner types once") ─────────────────────────────────────

export const KEY_FILE = 'backup-key.json';
export const keyFilePath = (deps, L) => pathFor(deps.platform).join(L.backupDir, KEY_FILE);
/** The copy of the sealed key on each backup drive folder, so the drive and the passphrase alone restore on a new PC. */
export const driveKeyName = (keyId) => `sre-backup-key-${keyId}.json`;

const readJson = (fs, f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };

/** The backup key file in the data folder: { present: false } · { present: true, key } · { present: true, problem }. */
export function readBackupKey(deps, L) {
  if (L.mode !== 'data-folder') return { present: false };
  const f = keyFilePath(deps, L);
  if (!deps.fs.existsSync(f)) return { present: false };
  const k = readJson(deps.fs, f);
  const problem = keyFileProblem(k);
  return problem === undefined ? { present: true, key: k } : { present: true, problem };
}

/**
 * The backup key: the one already made, or — only with a person at the keyboard — a new one, its private half sealed with
 * the passphrase typed twice. The passphrase is passed to scrypt and dropped: never stored, never said, never returned.
 */
export async function ensureBackupKey(deps, L) {
  const { say } = deps;
  const got = readBackupKey(deps, L);
  if (got.present && got.problem !== undefined) { say(`NOT DONE — the backup key file ${keyFilePath(deps, L)} cannot be used: ${got.problem}. Nothing was changed. Send me a photo of this screen.`); return undefined; }
  if (got.present) return got.key;
  say('The backups are ENCRYPTED. Choose the backup passphrase now. You type it this once, and again only to check or restore a backup.');
  say(`  At least ${MIN_PASSPHRASE} characters — a short sentence you will remember. Write it on paper and lock the paper away from this computer.`);
  say('  This computer keeps only a sealed key that the passphrase opens, never the passphrase. If it is forgotten, NOBODY can open the backups.');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const passphrase1 = await deps.askSecret('New backup passphrase (nothing shows as you type), then Enter: ');
    const noKeyboard = passphrase1 === undefined;
    if (noKeyboard) { say('NOT DONE — there is no keyboard here to type a passphrase. Run this command yourself in PowerShell.'); return undefined; }
    const passphrase2 = await deps.askSecret('The same passphrase again, then Enter: ');
    const problem = passphraseProblem(passphrase1, passphrase2 ?? '');
    if (problem === undefined) {
      const key = makeBackupKey(passphrase1, { now: deps.now(), scrypt: deps.scryptCost ?? SCRYPT });
      deps.fs.mkdirSync(L.backupDir, { recursive: true });
      deps.fs.writeFileSync(keyFilePath(deps, L), `${JSON.stringify(key, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      say(`BACKUP PASSPHRASE SET — backup key ${key.keyId}. The passphrase itself is kept nowhere on this computer.`);
      return key;
    }
    say(`  Not accepted: ${problem}. ${3 - attempt} more ${3 - attempt === 1 ? 'try' : 'tries'}.`);
  }
  say('NOT DONE — no passphrase was set, so nothing was backed up. Run the command again when you are ready.');
  return undefined;
}

/** Ask for the passphrase and open the key: up to three tries. Returns { ok, privateKey } or { ok: false, problem }. */
export async function unlockWithPassphrase(deps, key, why) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const passphrase = await deps.askSecret(`Backup passphrase, to ${why} (nothing shows as you type), then Enter: `);
    if (passphrase === undefined) return { ok: false, problem: 'there is no keyboard here to type the passphrase' };
    const u = unlockBackupKey(key, passphrase);
    if (u.ok || u.wrongPassphrase !== true) return u;
    deps.say(`  That passphrase does not open backup key ${key.keyId}. ${3 - attempt} more ${3 - attempt === 1 ? 'try' : 'tries'}.`);
  }
  return { ok: false, problem: 'the passphrase given three times does not open the backup key' };
}

/** The key a backup was encrypted to: the data folder's, or the copy on the drive beside the backup. */
export function keyForBackup(deps, L, dir, keyId) {
  const p = pathFor(deps.platform);
  const own = readBackupKey(deps, L);
  if (own.key?.keyId === keyId) return { key: own.key };
  const onDrive = readJson(deps.fs, p.join(dir, driveKeyName(keyId)));
  if (onDrive !== undefined && keyFileProblem(onDrive) === undefined && onDrive.keyId === keyId) return { key: onDrive };
  return { problem: `the backup key ${keyId} it was encrypted to is neither in this computer's data folder nor on the drive (${driveKeyName(keyId)})` };
}

// ── backup ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where the till keeps its data, from its settings — and its bill-number witness, which a backup never carries (OB-87). */
export function tillFolders(deps, L) {
  const p = pathFor(deps.platform);
  const env = deps.fs.existsSync(L.tillEnv) ? parseEnvText(deps.fs.readFileSync(L.tillEnv, 'utf8')) : undefined;
  const edgeData = typeof env?.EDGE_DATA_DIR === 'string' && env.EDGE_DATA_DIR.trim() !== '' ? p.resolve(env.EDGE_DATA_DIR.trim()) : p.join(L.tillDir, 'edge-data');
  const witness = typeof env?.EDGE_WITNESS_DIR === 'string' && env.EDGE_WITNESS_DIR.trim() !== '' ? p.resolve(env.EDGE_WITNESS_DIR.trim()) : `${edgeData.replace(/[\\/]+$/, '')}-witness`;
  return { installed: env !== undefined, env, edgeData, witness, lanePort: Number(env?.EDGE_LANE_PORT || 8090) };
}

/**
 * The backup itself, without the talking: returns { ok, manifestPath, manifest } or { ok: false, problem }.
 * `ctx` is what `ready` returned; `dir` the checked folder on a backup drive; `key` the backup key file (public half used).
 * Four encrypted files and a manifest, all new ('wx') and then read-only; nothing plain ever reaches the drive.
 */
export function takeStoreBackup(deps, ctx, dir, key) {
  const { fs } = deps;
  const p = pathFor(deps.platform);
  const L = ctx.L;
  if (L.mode !== 'data-folder') return { ok: false, problem: "this copy's data is still inside the system's own folder — run migrate-data-folder first" };
  if (key === undefined) return { ok: false, problem: 'there is no backup key yet — take one backup yourself first (backup --to …) to choose the passphrase' };
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    return { ok: false, problem: `the folder ${dir} could not be made (${e?.code ?? 'error'}). Is your backup drive plugged in, and is its letter right?` };
  }
  const till = tillFolders(deps, L);
  const inside = (root, x) => { const r = p.relative(root, x); return r === '' || (!r.startsWith('..') && !p.isAbsolute(r)); };
  if (inside(till.edgeData, till.witness)) return { ok: false, problem: `the till's bill-number witness (${till.witness}) is inside its data folder, so a backup would carry it (OB-87). Send me a photo of this screen.` };

  const at = deps.now();
  const manifestPath = freshName(deps, dir, `${PROJECT}-backup-${stampOf(at)}`, '.manifest.json');
  const backupId = p.basename(manifestPath, '.manifest.json');
  const names = { database: `${backupId}.dump.sreenc`, files: `${backupId}.files.sreenc`, settings: `${backupId}.settings.sreenc` };
  for (const n of Object.values(names)) if (fs.existsSync(p.join(dir, n))) return { ok: false, problem: `${n} is already there. Nothing was written.` };

  const scratch = p.join(L.scratchDir, backupId);
  fs.mkdirSync(scratch, { recursive: true });
  const pub = publicKeyOf(key);
  const t0 = deps.now().getTime();
  try {
    // 1. The database: one snapshot, counted and dumped (GT-07), into the scratch folder on this computer's own disk.
    const plainDump = p.join(scratch, 'database.dump');
    const fd = fs.openSync(plainDump, 'wx', 0o600);
    let r;
    try {
      r = deps.spawn('docker', dbExec('psql', psqlArgs(ctx.user, ctx.database), L), {
        cwd: L.composeDir, env: ctx.env, input: backupScript({ user: ctx.user, database: ctx.database }), stdio: ['pipe', fd, 'pipe'],
      });
      try { fs.fsyncSync(fd); } catch { /* the scratch copy is read back at once */ }
    } finally { fs.closeSync(fd); }
    const said = parseTotals(r.stderr ?? '');
    const bytes = fs.statSync(plainDump).size;
    const why = r.error !== undefined ? `Docker could not be started (${r.error.code ?? r.error.message})`
      : r.status !== 0 ? `the database did not finish the backup (it ended ${r.status}): ${firstProblem(said.other.join('\n')) || 'no reason given'}`
        : said.dumpExit !== 0 ? `pg_dump ended ${said.dumpExit === undefined ? 'without saying how' : said.dumpExit}: ${firstProblem(said.other.join('\n')) || 'no reason given'}`
          : !said.done || said.snapshot === undefined ? 'the database session did not finish cleanly'
            : bytes === 0 || !startsWithMagic(fs, plainDump) ? 'the file written is not a database backup'
              : undefined;
    if (why !== undefined) return { ok: false, problem: `${why}. Nothing was written to the drive.` };
    const db = encryptFile(fs, plainDump, p.join(dir, names.database), pub, { purpose: 'database', keyId: key.keyId });

    // 2. The till's own data and the records — copied consistently while the till keeps selling (store-computer-files.mjs).
    const bundle = p.join(scratch, 'files.bundle');
    const toc = writeBundle(fs, deps.platform, [
      { prefix: 'till/edge-data', dir: till.edgeData },
      { prefix: 'till/till.env', file: L.tillEnv },
      { prefix: 'records', dir: L.records },
    ], bundle, { ...(deps.inFlightWaitMs === undefined ? {} : { waitMs: deps.inFlightWaitMs }) });
    const files = encryptFile(fs, bundle, p.join(dir, names.files), pub, { purpose: 'files', keyId: key.keyId });

    // 3. This copy's settings, with its secrets (B6/Q8): encrypted, so a dead disk does not lose the keys.
    const settings = encryptFile(fs, L.settings, p.join(dir, names.settings), pub, { purpose: 'settings', keyId: key.keyId });

    // 4. The sealed key, once per drive folder (it opens only with the passphrase).
    const keyOnDrive = p.join(dir, driveKeyName(key.keyId));
    if (!fs.existsSync(keyOnDrive)) { fs.writeFileSync(keyOnDrive, `${JSON.stringify(key, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); fs.chmodSync(keyOnDrive, 0o444); }

    const tookMs = deps.now().getTime() - t0;
    const totalRows = Object.values(said.rowCounts).reduce((a, b) => a + b, 0);
    const summary = tillSummary(toc);
    const manifest = {
      kind: 'store-computer-backup',
      version: 2,
      backupId,
      project: PROJECT,
      database: ctx.database,
      computer: deps.platform === 'win32' ? 'Windows' : 'Linux',
      at: at.toISOString(),
      folder: dir,
      encryption: { scheme: 'x25519-hkdf-sha256/aes-256-gcm', keyId: key.keyId, keyFile: driveKeyName(key.keyId), opensWith: "the owner's backup passphrase, which is kept nowhere on any computer" },
      file: names.database,
      sizeBytes: db.bytes,
      sha256: db.sha256,
      checksumAlgorithm: 'sha256',
      parts: {
        database: { file: names.database, sizeBytes: db.bytes, sha256: db.sha256, plainBytes: db.plainBytes, plainSha256: db.plainSha256, format: 'pg_dump custom format, taken inside the database container' },
        files: { file: names.files, sizeBytes: files.bytes, sha256: files.sha256, plainSha256: files.plainSha256, fileCount: toc.length, till: { installed: till.installed, ...summary }, contents: "the till's data (edge-data and till.env) and the check records — never the bill-number witness (OB-87)" },
        settings: { file: names.settings, sizeBytes: settings.bytes, sha256: settings.sha256, plainSha256: settings.plainSha256, contents: `this copy's settings file (${SETTINGS_NAME}), with its secrets` },
      },
      timeTakenMs: tookMs,
      consistency: { method: 'exported_snapshot', isolation: 'repeatable_read', snapshotId: said.snapshot, till: 'whole files first, then each log up to its last complete record, the bill-number log last' },
      // Counts and the newest event are not personal or money figures; the money per event type is sealed to the key.
      controlTotals: { rowCounts: said.rowCounts, maxEventSeq: said.maxEventSeq, totalRows },
      sealedValueTotals: sealJson(said.valueTotals, pub),
      schemaVersion: said.migrations.at(-1) ?? 'unknown',
      migrationsApplied: said.migrations.length,
    };
    writeRecord(deps, manifestPath, manifest, false);
    for (const n of [...Object.values(names), p.basename(manifestPath)]) fs.chmodSync(p.join(dir, n), 0o444);
    return { ok: true, manifestPath, manifest, dumpPath: p.join(dir, names.database) };
  } catch (e) {
    return { ok: false, problem: `the backup stopped: ${e?.code ?? (e instanceof Error ? e.message : String(e))}. Anything already on the drive has no manifest, so it is never mistaken for a backup` };
  } finally {
    // The plain working copies only — on this computer's own disk, never the drive. The backup is the encrypted files.
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** What a backup's manifest says, in the owner's words: three lines for the screen. */
export function backupLines(m) {
  const t = m.parts?.files?.till;
  return [
    `  Database: ${Object.keys(m.controlTotals.rowCounts).length} tables, ${m.controlTotals.totalRows} rows${m.controlTotals.maxEventSeq === null ? '' : `; the newest event is number ${m.controlTotals.maxEventSeq}`}.`,
    t === undefined || !t.installed ? "  The till's data: there is no till on this computer yet." : `  The till's data: ${t.files} file(s) — ${t.saleRecords} sale record(s), ${t.deadLetterRecords} dead-letter record(s)${t.pinCredentials ? ', the staff PIN checks' : ''}${t.inFlightBytes > 0 ? ' (a record being written that moment goes in the next backup)' : ''}.`,
    `  This copy's settings (with its keys): encrypted copy included. Encrypted to backup key ${m.encryption.keyId}.`,
  ];
}

/** `backup --to <folder>`: one encrypted backup of everything onto a backup drive (the owner's daily drive, on demand). */
export async function backup(deps, opts) {
  const { say } = deps;
  const to = typeof opts.to === 'string' ? opts.to.trim() : '';
  if (to === '') { say('REFUSED — say where the backup goes: pnpm run store-computer -- backup --to E:\\sre-real  (your backup drive\'s letter instead of E:)'); return 2; }
  const ctx = ready(deps);
  if (ctx.code !== undefined) return ctx.code;
  const dir = pathFor(deps.platform).resolve(to);
  const refusal = folderRefusal(deps, dir);
  if (refusal !== undefined) { say(`REFUSED — ${refusal}`); return 2; }
  if (!dataFolderReady(deps, ctx)) return 2;
  if (!dockerReady(deps)) return 1;
  const key = await ensureBackupKey(deps, ctx.L);
  if (key === undefined) return 1;

  say(`Backing up this copy (${PROJECT}) — the database, the till's data and the settings — onto ${dir}, encrypted. The shop keeps working while it runs.`);
  const b = takeStoreBackup(deps, ctx, dir, key);
  recordBackupOutcome(deps, ctx.L, { kind: 'on-demand', to: dir, ...b });
  if (!b.ok) { say(`NOT DONE — ${b.problem}`); say('  What to do: run "pnpm run store-computer -- up", then this again. If it says this again, send me a photo of this screen.'); return 1; }
  const m = b.manifest;
  say(`BACKUP DONE — ${m.backupId}, ${size(m.parts.database.sizeBytes + m.parts.files.sizeBytes + m.parts.settings.sizeBytes)} encrypted, in ${mins(m.timeTakenMs)}.`);
  for (const l of backupLines(m)) say(l);
  say(`  Its SHA-256 (the database file's own fingerprint, not a secret): ${m.sha256}`);
  say(`  Manifest: ${b.manifestPath}`);
  say('  Every file is now read-only and encrypted; nothing plain is on the drive. Nothing was deleted.');
  say(`Next: pnpm run store-computer -- restore-check --from ${b.manifestPath}`);
  return 0;
}

// ── The backup log (append-only) and the last outcome, for backup-status and the red banner ─────────────────────────

export const LAST_BACKUP = 'last-backup.json';
export const BACKUP_LOG = 'backup-log.jsonl';

/**
 * Write down how a backup went: one line appended to the backup log (never rewritten — hard rule #6) and the latest
 * success and the latest attempt in last-backup.json (replaced whole, temp file then rename). No secret is in either.
 */
export function recordBackupOutcome(deps, L, b) {
  if (L.mode !== 'data-folder') return;
  const { fs } = deps;
  const p = pathFor(deps.platform);
  fs.mkdirSync(L.backupDir, { recursive: true });
  const at = deps.now().toISOString();
  const entry = b.ok
    ? { at, kind: b.kind, ok: true, to: b.to, backupId: b.manifest.backupId, manifest: b.manifestPath, bytes: b.manifest.parts.database.sizeBytes + b.manifest.parts.files.sizeBytes + b.manifest.parts.settings.sizeBytes, timeTakenMs: b.manifest.timeTakenMs }
    : { at, kind: b.kind, ok: false, to: b.to, problem: b.problem };
  fs.appendFileSync(p.join(L.backupDir, BACKUP_LOG), `${JSON.stringify(entry)}\n`, 'utf8');
  const last = readJson(fs, p.join(L.backupDir, LAST_BACKUP)) ?? {};
  const next = { ...last, lastAttempt: entry, ...(b.ok ? { lastSuccess: entry } : {}) };
  const tmp = p.join(L.backupDir, `${LAST_BACKUP}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p.join(L.backupDir, LAST_BACKUP));
}

/** The last outcome, or undefined. */
export const readLastBackup = (deps, L) => (L.mode === 'data-folder' ? readJson(deps.fs, pathFor(deps.platform).join(L.backupDir, LAST_BACKUP)) : undefined);

// ── restore-check ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The backup's manifest (and, for a first-generation backup, its plain dump), from any of its file names. */
export function backupFiles(platform, from) {
  const p = pathFor(platform);
  const abs = p.resolve(from);
  for (const ext of ['.dump.sreenc', '.files.sreenc', '.settings.sreenc']) {
    if (abs.endsWith(ext)) return { manifestPath: `${abs.slice(0, -ext.length)}.manifest.json`, dumpPath: `${abs.slice(0, -ext.length)}.dump` };
  }
  if (abs.endsWith('.manifest.json')) return { manifestPath: abs, dumpPath: `${abs.slice(0, -'.manifest.json'.length)}.dump` };
  if (abs.endsWith('.dump')) return { manifestPath: `${abs.slice(0, -'.dump'.length)}.manifest.json`, dumpPath: abs };
  return undefined;
}

/** Is this a manifest `backup` wrote (the first, plain generation, or the encrypted one)? Returns the problem, or undefined. */
export function manifestProblem(m) {
  if (m === null || typeof m !== 'object') return 'it is not a backup manifest';
  if (m.kind !== 'store-computer-backup' || (m.version !== 1 && m.version !== 2)) return 'it is not a manifest written by "store-computer backup"';
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return 'it has no SHA-256 for the backup file';
  if (!Number.isInteger(m.sizeBytes) || m.sizeBytes <= 0) return 'it has no size for the backup file';
  const t = m.controlTotals;
  if (t === null || typeof t !== 'object' || t.rowCounts === null || typeof t.rowCounts !== 'object' || Object.keys(t.rowCounts).length === 0) return 'it has no row counts to reconcile against';
  if (m.version === 2) {
    if (typeof m.encryption?.keyId !== 'string') return 'it does not say which key it was encrypted to';
    for (const part of ['database', 'files', 'settings']) {
      const x = m.parts?.[part];
      if (typeof x?.file !== 'string' || !/^[0-9a-f]{64}$/.test(String(x.sha256)) || !/^[0-9a-f]{64}$/.test(String(x.plainSha256))) return `it does not describe its ${part} part`;
    }
  }
  return undefined;
}

/** Which of an encrypted backup's files are missing or not the files that were written. Needs no passphrase. */
export function changedParts(deps, dir, manifest) {
  const p = pathFor(deps.platform);
  const out = [];
  for (const [name, part] of Object.entries(manifest.parts)) {
    const f = p.join(dir, part.file);
    if (!deps.fs.existsSync(f)) { out.push(`the ${name} file ${part.file} is not there`); continue; }
    const bytes = deps.fs.statSync(f).size;
    if (bytes !== part.sizeBytes) out.push(`the ${name} file is ${bytes} bytes; the manifest says ${part.sizeBytes}`);
    else if (hashFile(deps.fs, f) !== part.sha256) out.push(`the ${name} file's SHA-256 is not the one in the manifest`);
  }
  return out;
}

/**
 * Restore one dump file into a NEW scratch database and count it. Returns { scratch, differences, reconciled } — the
 * caller writes the record and only then drops the scratch database (`dropScratch`).
 */
function restoreIntoScratch(deps, ctx, dumpFile, expected) {
  const { fs } = deps;
  const list = deps.spawn('docker', dbExec('psql', [...psqlArgs(ctx.user, 'postgres'), '-c', 'SELECT datname FROM pg_database'], ctx.L), { cwd: ctx.L.composeDir, env: ctx.env });
  if (list.error !== undefined || list.status !== 0) return { differences: ['this copy\'s database did not answer (run: pnpm run store-computer -- up)'], outcome: 'restore_not_accepted' };
  const scratch = assertScratch(scratchName(deps.now(), lines(list.stdout)), ctx.settings);
  const made = deps.spawn('docker', dbExec('psql', [...psqlArgs(ctx.user, 'postgres'), '-c', `CREATE DATABASE "${assertScratch(scratch, ctx.settings)}"`], ctx.L), { cwd: ctx.L.composeDir, env: ctx.env });
  if (made.error !== undefined || made.status !== 0) return { scratch, made: false, differences: [`the scratch database could not be made: ${firstProblem(made.stderr) || 'no reason given'}`], outcome: 'restore_not_accepted' };
  try {
    const fd = fs.openSync(dumpFile, 'r');
    let restored;
    try {
      restored = deps.spawn('docker', dbExec('pg_restore', ['-U', ctx.user, '-d', assertScratch(scratch, ctx.settings), '--no-owner', '--no-privileges'], ctx.L), { cwd: ctx.L.composeDir, env: ctx.env, stdio: [fd, 'pipe', 'pipe'] });
    } finally { fs.closeSync(fd); }
    // Reconcile — the step that makes this a restore rather than a hope.
    const counted = deps.spawn('docker', dbExec('psql', psqlArgs(ctx.user, assertScratch(scratch, ctx.settings)), ctx.L), { cwd: ctx.L.composeDir, env: ctx.env, input: `${totalsScript().join('\n')}\n` });
    const got = parseTotals(counted.stdout ?? '');
    const differences = [];
    if (restored.error !== undefined || restored.status !== 0) differences.push(`the restore program ended ${restored.status ?? restored.error?.code}: ${firstProblem(restored.stderr) || 'no reason given'}`);
    if (counted.error !== undefined || counted.status !== 0) differences.push('the restored copy could not be counted');
    else differences.push(...reconcile(expected, got));
    return { scratch, made: true, differences, reconciled: { tables: Object.keys(got.rowCounts).length, rows: Object.values(got.rowCounts).reduce((a, b) => a + b, 0), maxEventSeq: got.maxEventSeq } };
  } catch (e) {
    return { scratch, made: true, differences: [`the restore stopped: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

function dropScratch(deps, ctx, scratch) {
  const drop = deps.spawn('docker', dbExec('psql', [...psqlArgs(ctx.user, 'postgres'), '-c', `DROP DATABASE "${assertScratch(scratch, ctx.settings)}"`], ctx.L), { cwd: ctx.L.composeDir, env: ctx.env });
  return drop.error === undefined && drop.status === 0;
}

/**
 * The restore check without the talking: returns the record it wrote (with `recordPath`). `ctx` is what `ready` returned;
 * `privateKey` the unlocked backup key (an encrypted backup cannot be opened without it).
 * Order: the files must be the files that were taken → (encrypted) opened into the scratch folder → a NEW scratch database
 * → restore → reconcile → the till's data checked file by file → the settings copy opened → the record on the drive →
 * only then the scratch database is dropped and the plain working copies removed.
 */
export function runRestoreCheck(deps, ctx, files, privateKey) {
  const { fs } = deps;
  const p = pathFor(deps.platform);
  const dir = p.dirname(files.manifestPath);
  const at = deps.now();
  const t0 = at.getTime();
  const recordPath = freshName(deps, dir, `restore-check-${stampOf(at)}`, '.json');
  const base = { kind: 'store-computer-restore-check', version: 1, at: at.toISOString(), project: PROJECT, backupFile: p.basename(files.dumpPath), offsiteDir: dir };
  const finish = (record) => {
    const full = { ...base, ...record, timeTakenMs: deps.now().getTime() - t0 };
    writeRecord(deps, recordPath, full, true);
    return { ...full, recordPath };
  };

  const manifest = readJson(fs, files.manifestPath);
  const mp = manifest === undefined ? 'it could not be read' : manifestProblem(manifest);
  if (mp !== undefined) return finish({ outcome: 'refused_no_manifest', differences: [`the manifest ${p.basename(files.manifestPath)}: ${mp}`] });
  base.backupId = manifest.backupId;
  base.sha256 = manifest.sha256;

  // ── The first, plain generation (before OB-249): the dump itself on the drive ────────────────────────────────
  if (manifest.version === 1) {
    if (!fs.existsSync(files.dumpPath)) return finish({ outcome: 'refused_file_changed', differences: [`the backup file ${p.basename(files.dumpPath)} is not there`] });
    const bytes = fs.statSync(files.dumpPath).size;
    const sha256 = hashFile(fs, files.dumpPath);
    const changed = [];
    if (bytes !== manifest.sizeBytes) changed.push(`the file is ${bytes} bytes; the manifest says ${manifest.sizeBytes}`);
    if (sha256 !== manifest.sha256) changed.push(`the file's SHA-256 is ${sha256}; the manifest says ${manifest.sha256}`);
    if (changed.length > 0) return finish({ outcome: 'refused_file_changed', differences: changed, detail: 'the backup file is not the file that was taken — it was not restored, and it must not be relied on' });
    const r = restoreIntoScratch(deps, ctx, files.dumpPath, manifest.controlTotals);
    if (r.scratch !== undefined) base.scratchDatabase = r.scratch;
    const written = finish(r.outcome === 'restore_not_accepted' && r.made !== true
      ? { outcome: 'restore_not_accepted', differences: r.differences, scratchDropped: 'not made' }
      : {
        outcome: r.differences.length === 0 ? 'restored_and_reconciled' : 'restore_not_accepted', differences: r.differences, reconciled: r.reconciled,
        detail: r.differences.length === 0 ? 'restored from the file on the backup drive into a new scratch database, and every table\'s rows, the money and the newest event match the manifest exactly' : 'the restore did NOT reconcile with the manifest — do not rely on this backup',
        scratchDropped: 'after this record',
      });
    return r.made === true ? { ...written, dropped: dropScratch(deps, ctx, r.scratch) } : written;
  }

  // ── The encrypted generation (OB-249) ─────────────────────────────────────────────────────────────────────────
  base.backupFile = manifest.file;
  base.encryption = { keyId: manifest.encryption.keyId };
  const changed = changedParts(deps, dir, manifest);
  if (changed.length > 0) return finish({ outcome: 'refused_file_changed', differences: changed, detail: 'the backup\'s files are not the files that were taken — nothing was opened or restored, and the backup must not be relied on' });
  if (privateKey === undefined) return finish({ outcome: 'not_opened', differences: ['the backup passphrase was not given, so the encrypted backup could not be opened'] });

  const work = p.join(ctx.L.scratchDir, `restore-check-${stampOf(at)}-${Math.floor(t0 % 100000)}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    const open = (part, purpose) => {
      const out = p.join(work, purpose);
      const d = decryptFile(fs, p.join(dir, manifest.parts[part].file), out, privateKey, { expectPurpose: purpose });
      if (!d.ok) return { problem: `the ${part} file: ${d.problem}` };
      if (d.plainSha256 !== manifest.parts[part].plainSha256) return { problem: `the ${part} file opened, but what is inside is not what was backed up` };
      return { file: out };
    };
    const totals = openJson(manifest.sealedValueTotals, privateKey);
    const db = open('database', 'database');
    const bundled = open('files', 'files');
    const settingsCopy = open('settings', 'settings');
    const notOpened = [db, bundled, settingsCopy].filter((x) => x.problem !== undefined).map((x) => x.problem);
    if (!totals.ok) notOpened.push(totals.problem);
    if (notOpened.length > 0) return finish({ outcome: 'not_opened', differences: notOpened, detail: 'the backup did not open with this key — nothing was restored' });

    // The till's data: every file's SHA-256 and every log's whole records, checked inside the bundle (never restored).
    const tillCheck = checkBundle(fs, bundled.file);
    const tillPart = manifest.parts.files.till ?? {};
    const tillFound = tillSummary(tillCheck.files);
    const tillProblems = tillCheck.problems.map((x) => `the till's data: ${x}`);
    if (tillCheck.ok && (tillFound.saleRecords !== tillPart.saleRecords || tillFound.deadLetterRecords !== tillPart.deadLetterRecords)) tillProblems.push(`the till's data: ${tillFound.saleRecords} sale and ${tillFound.deadLetterRecords} dead-letter record(s) found; the manifest says ${tillPart.saleRecords} and ${tillPart.deadLetterRecords}`);

    // The settings copy: it opens, it holds this copy's secrets (names only — values are never read out).
    const copied = parseEnvText(fs.readFileSync(settingsCopy.file, 'utf8'));
    const fpCopy = fingerprintsOf(copied);
    const fpNow = fingerprintsOf(ctx.settings);
    const secretsInCopy = Object.keys(fpCopy.fingerprints).length;
    const settingsProblems = secretsInCopy === FINGERPRINT_KEYS.length ? [] : [`the settings copy holds ${secretsInCopy} of the ${FINGERPRINT_KEYS.length} secrets`];
    const sameAsNow = FINGERPRINT_KEYS.every((k) => fpCopy.fingerprints[k] !== undefined && fpCopy.fingerprints[k] === fpNow.fingerprints[k]);

    const r = restoreIntoScratch(deps, ctx, db.file, { ...manifest.controlTotals, valueTotals: totals.value });
    if (r.scratch !== undefined) base.scratchDatabase = r.scratch;
    const differences = [...r.differences, ...tillProblems, ...settingsProblems];
    const record = r.outcome === 'restore_not_accepted' && r.made !== true
      ? { outcome: 'restore_not_accepted', differences, scratchDropped: 'not made' }
      : {
        outcome: differences.length === 0 ? 'restored_and_reconciled' : 'restore_not_accepted',
        differences,
        reconciled: r.reconciled,
        till: { checked: tillCheck.ok, files: tillCheck.files.length, saleRecords: tillFound.saleRecords, deadLetterRecords: tillFound.deadLetterRecords, pinCredentials: tillFound.pinCredentials },
        settings: { opened: true, secretsInCopy, sameAsThisComputer: sameAsNow },
        detail: differences.length === 0
          ? 'opened with the backup passphrase; the database restored into a new scratch database and every table\'s rows, the money and the newest event match the manifest exactly; every till file matches its fingerprint and every log holds its whole records; the settings copy opens and holds every secret'
          : 'the backup did NOT check out — do not rely on it',
        scratchDropped: 'after this record',
      };
    const written = finish(record);
    return r.made === true ? { ...written, dropped: dropScratch(deps, ctx, r.scratch) } : written;
  } finally {
    // The plain working copies only, on this computer's own disk. The backup on the drive is untouched.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** `restore-check --from <backup file>`: prove a backup opens, restores and reconciles. */
export async function restoreCheck(deps, opts) {
  const { say } = deps;
  const p = pathFor(deps.platform);
  const from = typeof opts.from === 'string' ? opts.from.trim() : '';
  const files = from === '' ? undefined : backupFiles(deps.platform, from);
  if (files === undefined) { say('REFUSED — name the backup to check: pnpm run store-computer -- restore-check --from E:\\sre-real\\<the .manifest.json file backup wrote>'); return 2; }
  const ctx = ready(deps);
  if (ctx.code !== undefined) return ctx.code;
  if (!deps.fs.existsSync(files.manifestPath) && !deps.fs.existsSync(files.dumpPath)) { say(`REFUSED — there is no backup at ${from}. Is your backup drive plugged in, and is its letter right?`); return 2; }
  if (!dockerReady(deps)) return 1;

  const manifest = readJson(deps.fs, files.manifestPath);
  let privateKey;
  if (manifest?.version === 2 && manifestProblem(manifest) === undefined) {
    const dir = p.dirname(files.manifestPath);
    const changed = changedParts(deps, dir, manifest);
    if (changed.length === 0) {
      const k = keyForBackup(deps, ctx.L, dir, manifest.encryption.keyId);
      if (k.key === undefined) { say(`NOT CHECKED — ${k.problem}. Nothing was opened.`); return 1; }
      const u = await unlockWithPassphrase(deps, k.key, 'open this backup');
      if (!u.ok) { say(`NOT CHECKED — ${u.problem}. Nothing was opened or restored.`); }
      else privateKey = u.privateKey;
    }
  }
  say(`Checking the backup ${manifest?.backupId ?? p.basename(files.dumpPath)}: opening it, restoring the database into a NEW scratch database inside this copy's database container (never into ${ctx.database}), counting, and checking the till's data and the settings copy.`);
  const r = runRestoreCheck(deps, ctx, files, privateKey);
  say(restoreSummary(r));
  for (const d of r.differences ?? []) say(`  difference: ${d}`);
  if (r.till !== undefined) say(`  The till's data: ${r.till.files} file(s) checked, ${r.till.saleRecords} sale record(s), ${r.till.deadLetterRecords} dead-letter record(s)${r.till.pinCredentials ? ', the staff PIN checks' : ''} — ${r.till.checked ? 'every one whole' : 'NOT all whole'}.`);
  if (r.settings !== undefined) say(`  This copy's settings: the encrypted copy opens and holds ${r.settings.secretsInCopy} secret(s)${r.settings.sameAsThisComputer ? ', the same as this computer has now' : ' (they differ from this computer\'s now — it was re-keyed since)'}. No value was shown.`);
  say(`  Record: ${r.recordPath}  (read-only, beside the backup; no secret is in it)`);
  if (r.scratchDatabase !== undefined) {
    say(r.dropped ? `  The scratch database ${r.scratchDatabase} was removed after the record was written. ${ctx.database} was never touched.`
      : `  The scratch database ${r.scratchDatabase} could NOT be removed — it is a copy of the shop's data inside this computer's own database container. Send me a photo of this screen.`);
  }
  if (r.outcome === 'restored_and_reconciled') say(`Next: use this record for check 10: pnpm run store-computer -- check --by "<your name>" --backup-record ${r.recordPath}`);
  return r.outcome === 'restored_and_reconciled' && r.dropped !== false ? 0 : 1;
}

function restoreSummary(r) {
  if (r.outcome === 'restored_and_reconciled') return `restored_and_reconciled — ${r.reconciled.tables} tables, ${r.reconciled.rows} rows, every count and the money match the manifest (${mins(r.timeTakenMs)}).`;
  if (r.outcome === 'refused_file_changed') return 'NOT ACCEPTED — the backup file is not the file that was taken. It was not restored. Do not rely on it; take a new backup.';
  if (r.outcome === 'refused_no_manifest') return 'NOT ACCEPTED — that backup has no usable manifest, so there is nothing to reconcile against. It was not restored.';
  if (r.outcome === 'not_opened') return 'NOT ACCEPTED — the encrypted backup was not opened, so nothing was restored. The exact reason:';
  return 'NOT ACCEPTED — the restored copy does not match the manifest. The exact differences:';
}

// ── drill ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** db/migrations/*.sql in a release folder: name → SHA-256 of its content. */
export function migrationsOf(fs, platform, folder) {
  const p = pathFor(platform);
  const dir = p.join(folder, 'db', 'migrations');
  if (!fs.existsSync(dir)) return undefined;
  const out = {};
  for (const name of fs.readdirSync(dir).filter((f) => String(f).endsWith('.sql')).map(String).sort()) {
    out[name] = createHash('sha256').update(fs.readFileSync(p.join(dir, name), 'utf8')).digest('hex');
  }
  return out;
}

/**
 * Can the previous release run against this release's schema? Only when every one of its migrations is one of this
 * release's — same name, same content — and they come first. Returns the problems (empty = compatible).
 */
export function migrationProblems(previous, current) {
  const problems = [];
  if (previous === undefined) return ['the previous release folder has no db\\migrations folder — it is not a complete release'];
  if (current === undefined) return ['this release has no db\\migrations folder'];
  const prevNames = Object.keys(previous).sort();
  const curNames = Object.keys(current).sort();
  for (const n of prevNames) {
    if (!(n in current)) problems.push(`the previous release has a database step (${n}) this release does not have — going back is not safe`);
    else if (previous[n] !== current[n]) problems.push(`the database step ${n} differs between the two releases — going back is not safe`);
  }
  if (problems.length === 0 && prevNames.some((n, i) => curNames[i] !== n)) problems.push('the previous release\'s database steps are not the first steps of this release — going back is not safe');
  return problems;
}

/** One fingerprint for a release folder: what the API image is built from, file by file (never a settings file). */
export function releaseId(fs, platform, folder) {
  const p = pathFor(platform);
  const h = createHash('sha256');
  const walk = (relPath) => {
    const abs = p.join(folder, ...relPath.split('/'));
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(abs).map(String).sort()) {
        if (RELEASE_SKIP.has(entry) || entry.startsWith('.env')) continue;
        walk(`${relPath}/${entry}`);
      }
      return;
    }
    h.update(`${relPath}\0`);
    h.update(fs.readFileSync(abs));
    h.update('\0');
  };
  for (const input of RELEASE_INPUTS) walk(input);
  return h.digest('hex').slice(0, 16);
}

/** Which compose file the running API container was started from (compose's own label), or undefined. */
function apiStartedFrom(deps) {
  const r = deps.spawn('docker', ['ps', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--filter', 'label=com.docker.compose.service=api', '--format', '{{.Label "com.docker.compose.project.config_files"}}'], {});
  return r.status === 0 ? lines(r.stdout)[0] : undefined;
}

const samePath = (platform, a, b) => {
  const norm = (x) => (platform === 'win32' ? String(x).replace(/\//g, '\\').toLowerCase() : String(x));
  return norm(a) === norm(b);
};

/** The checks both the dry run and the real run make, before anything changes. Returns { problems, plan }. */
export function drillPlan(deps, ctx, opts) {
  const p = pathFor(deps.platform);
  const problems = [];
  const to = p.resolve(opts.to);
  const refusal = folderRefusal(deps, to);
  if (refusal !== undefined) problems.push(refusal);
  const prev = p.resolve(opts.previous);
  const fromRepo = p.relative(deps.repoRoot, prev);
  const insideRepo = fromRepo === '' || (!fromRepo.startsWith('..') && !p.isAbsolute(fromRepo));
  const prevCompose = p.join(prev, 'infra', 'compose', 'docker-compose.yml');
  let migrations;
  let ids;
  if (samePath(deps.platform, prev, deps.repoRoot)) problems.push(`--previous names this release's own folder (${prev}). It must be the PREVIOUS release's folder, for example C:\\SRE-previous.`);
  else if (insideRepo) problems.push(`--previous (${prev}) is inside this release's folder. Keep the previous release in its own folder beside it, for example C:\\SRE-previous.`);
  else if (!deps.fs.existsSync(prevCompose)) problems.push(`there is no release in ${prev} (no infra\\compose\\docker-compose.yml). Extract the previous release's ZIP there (guide Part 11).`);
  else {
    const before = migrationsOf(deps.fs, deps.platform, prev);
    const now = migrationsOf(deps.fs, deps.platform, deps.repoRoot);
    problems.push(...migrationProblems(before, now));
    migrations = { previous: Object.keys(before ?? {}).length, current: Object.keys(now ?? {}).length };
    ids = { previous: releaseId(deps.fs, deps.platform, prev), current: releaseId(deps.fs, deps.platform, deps.repoRoot) };
    if (ids.previous === ids.current) problems.push('the previous release and this one are the same release — that rehearses nothing. Use the release before this one.');
  }
  return {
    problems,
    plan: { to, previous: prev, previousCompose: prevCompose, currentCompose: p.join(ctx.L.composeDir, 'docker-compose.yml'), migrations, releaseIds: ids, newerMigrations: migrations === undefined ? undefined : migrations.current - migrations.previous },
  };
}

/** The steps' targets (roadmap §32): the database back within 4 hours; the service back within 30 minutes. */
export const STEP_TARGETS = Object.freeze({ backup: DRILL_TARGETS.recoveryMs, restore: DRILL_TARGETS.recoveryMs, rollback: DRILL_TARGETS.rollbackMs, rollForward: DRILL_TARGETS.rollForwardMs });

/** The overall answer: "G9 PASSED" only when every step worked and every time is inside its target. */
export function drillVerdict(steps) {
  const failed = steps.filter((s) => !s.ok);
  const over = steps.filter((s) => s.ok && !s.withinTarget);
  const recoveryMs = steps.filter((s) => s.key === 'backup' || s.key === 'restore').reduce((a, s) => a + s.ms, 0);
  const recoveryOver = recoveryMs > DRILL_TARGETS.recoveryMs;
  const all = ['backup', 'restore', 'rollback', 'rollForward'].every((k) => steps.some((s) => s.key === k));
  if (all && failed.length === 0 && over.length === 0 && !recoveryOver) return { passed: true, line: 'G9 PASSED — every step worked, each inside its target (database back within 4 hours, service back within 30 minutes).' };
  const parts = [];
  if (failed.length > 0) parts.push(`${failed.length} step(s) did not work (${failed.map((s) => s.title).join('; ')})`);
  if (over.length > 0) parts.push(`${over.length} step(s) took longer than the target (${over.map((s) => s.title).join('; ')})`);
  if (recoveryOver) parts.push(`backup plus restore took ${mins(recoveryMs)}, over the 4-hour target`);
  if (!all) parts.push('not every step ran');
  return { passed: false, line: `G9 NOT PASSED — ${parts.join('; ')}. No real data may be loaded until a drill passes.` };
}

/** `drill --by "<name>" --to <folder> --previous <folder> [--run]`: the timed G9 drill (a dry run without --run). */
export async function drill(deps, opts) {
  const { say, fs } = deps;
  const p = pathFor(deps.platform);
  const by = typeof opts.by === 'string' ? opts.by.trim() : '';
  const missing = [];
  if (by === '') missing.push('--by "<your name>"');
  if (typeof opts.to !== 'string' || opts.to.trim() === '') missing.push('--to <your backup drive folder, for example E:\\sre-real>');
  if (typeof opts.previous !== 'string' || opts.previous.trim() === '') missing.push('--previous <the previous release\'s folder, for example C:\\SRE-previous>');
  if (missing.length > 0) { say(`REFUSED — the drill needs: ${missing.join(', ')}`); say('  pnpm run store-computer -- drill --by "Your Name" --to E:\\sre-real --previous C:\\SRE-previous'); return 2; }
  const ctx = ready(deps);
  if (ctx.code !== undefined) return ctx.code;
  const { problems, plan } = drillPlan(deps, ctx, opts);
  if (problems.length > 0) { for (const pr of problems) say(`REFUSED — ${pr}`); say('  Nothing was changed.'); return 2; }

  const steps = [
    `1. back up this copy onto ${plan.to} (target: with step 2, inside 4 hours);`,
    '2. restore that backup into a new scratch database and reconcile it (never into the real database);',
    `3. put the previous release back: start ${plan.previous}'s services on this copy's database (the database is not rolled back: its ${plan.migrations.previous} steps are this release's first ${plan.migrations.previous}, and the ${plan.newerMigrations} newer one(s) only add), and wait for READY (target 30 minutes);`,
    '4. put this release back and wait for READY again (target 30 minutes);',
    '5. print each time against its target, and write a new dated record.',
  ];
  if (opts.run !== true) {
    say('DRY RUN — nothing will change. With --run the drill will, in order:');
    for (const s of steps) say(`  ${s}`);
    say(`  Previous release ${plan.releaseIds.previous} → this release ${plan.releaseIds.current}.`);
    say('  The API restarts twice: do it at a quiet time. When you are ready, run the same command with --run at the end.');
    return 0;
  }

  if (!dataFolderReady(deps, ctx)) return 2;
  if (!dockerReady(deps)) return 1;
  const demo = lines(deps.spawn('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${DEMO_PROJECT}`, '--format', '{{.Names}}'], {}).stdout);
  if (demo.length > 0) { say(`REFUSED — the demo's containers (project ${DEMO_PROJECT}) are on this computer. The demo never runs on the store computer (gate G4). Nothing was changed.`); return 2; }
  const at = deps.now();
  const port = ctx.settings.API_PORT || '8081';
  const record = {
    kind: 'store-computer-rollback-drill', version: 1, at: at.toISOString(), by, project: PROJECT,
    computer: deps.platform === 'win32' ? 'Windows' : 'Linux',
    method: 'previous release folder, started on this copy\'s current database — the database is not rolled back (migrations only add)',
    previousRelease: { folder: plan.previous, releaseId: plan.releaseIds.previous, migrations: plan.migrations.previous },
    currentRelease: { folder: deps.repoRoot, releaseId: plan.releaseIds.current, migrations: plan.migrations.current },
    targets: { recoveryMs: DRILL_TARGETS.recoveryMs, rollbackMs: DRILL_TARGETS.rollbackMs, rollForwardMs: DRILL_TARGETS.rollForwardMs },
    steps: [],
  };
  const timed = async (key, title, fn) => {
    const t0 = deps.now().getTime();
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
    const ms = deps.now().getTime() - t0;
    const step = { key, title, ok: r.ok === true, ms, targetMs: STEP_TARGETS[key], withinTarget: ms <= STEP_TARGETS[key], detail: r.detail };
    record.steps.push(step);
    say(`  ${step.ok ? (step.withinTarget ? 'done' : 'SLOW') : 'FAILED'}  ${title} — ${mins(ms)} (target ${mins(STEP_TARGETS[key])})${r.detail === undefined ? '' : ` — ${r.detail}`}`);
    return { ...r, ms };
  };
  const startRelease = async (composeDir, expectedCompose, settingsFile) => {
    const up = deps.spawn('docker', ['compose', '-p', PROJECT, '-f', 'docker-compose.yml', '--env-file', settingsFile, 'up', '-d', '--build', 'db', 'migrate', 'api'], { cwd: composeDir, env: ctx.env, stdio: 'inherit' });
    if (up.error !== undefined || up.status !== 0) return { ok: false, detail: `Docker could not start it (it ended ${up.status ?? up.error?.code})` };
    if (!(await waitReady(deps, port, DRILL_READY_WAIT_MS))) return { ok: false, detail: `the API did not say ready within ${DRILL_READY_WAIT_MS / 60_000} minutes` };
    const from = apiStartedFrom(deps);
    if (from === undefined || !from.split(',').some((f) => samePath(deps.platform, f.trim(), expectedCompose))) return { ok: false, detail: 'the API that answered is not the one this step started' };
    return { ok: true };
  };
  const appliedNow = () => {
    const r = deps.spawn('docker', dbExec('psql', psqlArgs(ctx.user, ctx.database), ctx.L), { cwd: ctx.L.composeDir, env: ctx.env, input: `${totalsScript()[3]}\n` });
    return r.status === 0 ? parseTotals(r.stdout ?? '').migrations : undefined;
  };

  say(`Rollback drill (pilot gate G9) on project ${PROJECT}, by ${by}: back to ${plan.previous}, then forward to this release.`);
  const before = appliedNow();
  const want = Object.keys(migrationsOf(fs, deps.platform, deps.repoRoot) ?? {});
  if (before === undefined || want.some((n) => !before.includes(n))) {
    say('REFUSED — this copy\'s database has not got every step of this release yet (or did not answer). Run first: pnpm run store-computer -- up. Nothing was changed.');
    return 2;
  }

  // The backup is encrypted, and step 2 opens it: the passphrase is asked for now, before any step is timed.
  const key = await ensureBackupKey(deps, ctx.L);
  if (key === undefined) { say('REFUSED — the drill needs the backup passphrase. Nothing was changed.'); return 2; }
  const opened = await unlockWithPassphrase(deps, key, 'check the drill\'s backup');
  if (!opened.ok) { say(`REFUSED — ${opened.problem}. Nothing was changed.`); return 2; }

  let manifestPath;
  const b = await timed('backup', 'backup onto the backup drive', () => {
    const r = takeStoreBackup(deps, ctx, plan.to, key);
    recordBackupOutcome(deps, ctx.L, { kind: 'drill', to: plan.to, ...r });
    manifestPath = r.manifestPath;
    return r.ok ? { ok: true, detail: `${r.manifest.file}, ${size(r.manifest.sizeBytes)}` } : { ok: false, detail: r.problem };
  });
  if (b.ok) {
    await timed('restore', 'restore into a new scratch database and reconcile', () => {
      const r = runRestoreCheck(deps, ctx, backupFiles(deps.platform, manifestPath), opened.privateKey);
      record.restoreCheckRecord = r.recordPath;
      const fine = r.outcome === 'restored_and_reconciled' && r.dropped !== false;
      return { ok: fine, detail: fine ? 'restored_and_reconciled' : `${r.outcome}${r.differences.length > 0 ? `: ${r.differences.join('; ')}` : ''}${r.dropped === false ? '; the scratch database could not be removed' : ''}` };
    });
  }
  record.backupManifest = manifestPath;
  const recoveryFine = record.steps.length === 2 && record.steps.every((s) => s.ok);
  if (recoveryFine) {
    await timed('rollback', 'put the previous release back and wait for READY', async () => {
      const r = await startRelease(p.join(plan.previous, 'infra', 'compose'), plan.previousCompose, ctx.L.settings);
      if (!r.ok) return r;
      const after = appliedNow();
      if (after === undefined || after.length !== before.length) return { ok: false, detail: 'the previous release changed the database\'s steps — that is not a clean rollback' };
      return { ok: true, detail: 'the previous release is running on this copy\'s current database' };
    });
    // Forward again ALWAYS once the previous release was tried: the shop's copy must end on this release.
    await timed('rollForward', 'put this release back and wait for READY', () => startRelease(ctx.L.composeDir, plan.currentCompose, ctx.L.mode === 'data-folder' ? ctx.L.settings : SETTINGS_NAME));
  }

  const verdict = drillVerdict(record.steps);
  record.overall = verdict.passed ? 'G9 PASSED' : 'G9 NOT PASSED';
  record.finishedAt = deps.now().toISOString();
  const total = record.steps.reduce((a, s) => a + s.ms, 0);
  say(`  times    ${record.steps.map((s) => `${s.key} ${mins(s.ms)}`).join(' · ')} · total ${mins(total)}`);
  say(verdict.line);
  const forward = record.steps.find((s) => s.key === 'rollForward');
  if (forward !== undefined && !forward.ok) say('  THIS COPY MAY NOT BE ON THIS RELEASE NOW. Run: pnpm run store-computer -- up — and send me a photo of this screen.');

  // A new dated record every time, in the records folder and on the backup drive; never overwriting one.
  const recDir = opts.out ?? ctx.L.records;
  fs.mkdirSync(recDir, { recursive: true });
  const recFile = freshName(deps, recDir, `g9-drill-${stampOf(at)}`, '.json');
  writeRecord(deps, recFile, record, false);
  say(`Record written: ${rel(deps, recFile)}  (no secret is in it — keep it with the workbook)`);
  try {
    const onDrive = freshName(deps, plan.to, `g9-drill-${stampOf(at)}`, '.json');
    writeRecord(deps, onDrive, record, true);
    say(`  A copy is on your backup drive: ${onDrive}`);
  } catch { say('  The copy for your backup drive could not be written. Copy the record above onto it by hand.'); }
  return verdict.passed ? 0 : 1;
}
