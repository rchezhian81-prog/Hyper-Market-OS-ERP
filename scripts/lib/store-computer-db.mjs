// How the store-computer tool reaches THIS COPY'S DATABASE — in Docker (the first way, ADR-0002) or as the Windows service
// SRE-Database (ADR-0032 · CR-01 step 2c). One place decides, so backup, the restore check, the G4 checks and the red
// light all ask the same database the shop is trading on.
//
// A copy runs as Windows services once `install-services` has written <data folder>\run\services\database.json (the
// PostgreSQL programs' folder and the port — no secret). From then on every database command is the PostgreSQL program
// itself on 127.0.0.1, with the administrator's password handed in PGPASSWORD (never an argument), instead of
// `docker compose exec db …`. Before that, nothing changes.

import { composeBase, dockerProblem, lines, pathFor } from './store-computer.mjs';

export const SERVICES_MARKER = 'database.json';
/** Every statement the backup and the restore check run sees every tenant's rows (row-level security, 0012). */
export const ALL_TENANTS_PGOPTIONS = '-c app.tenant_id=*';

/** Where the marker is, for this data folder. */
export const servicesMarkerPath = (platform, dataRoot) => pathFor(platform).join(dataRoot, 'run', 'services', SERVICES_MARKER);

/** What install-services recorded about the database service ({ pgBin, port }), or undefined: this copy runs in Docker. */
export function readServicesMarker(deps, L) {
  if (L?.dataRoot === undefined) return undefined;
  const file = servicesMarkerPath(deps.platform, L.dataRoot);
  if (!deps.fs.existsSync(file)) return undefined;
  try {
    const m = JSON.parse(deps.fs.readFileSync(file, 'utf8'));
    return typeof m?.pgBin === 'string' && m.pgBin !== '' ? { pgBin: m.pgBin, port: String(m.port ?? '5432') } : undefined;
  } catch { return undefined; }
}

/** Written by install-services once the database service is set up. Names and a port only. */
export function writeServicesMarker(deps, dataRoot, { pgBin, port }) {
  const file = servicesMarkerPath(deps.platform, dataRoot);
  deps.fs.mkdirSync(pathFor(deps.platform).dirname(file), { recursive: true });
  deps.fs.writeFileSync(file, `${JSON.stringify({ kind: 'sre-store-computer-services', version: 1, pgBin, port: String(port), service: 'SRE-Database', writtenAt: deps.now().toISOString() }, null, 2)}\n`, 'utf8');
}

/** Is the database there to be asked? { what, fix } when not; undefined when it is. */
export function databaseProblem(deps, L) {
  const native = readServicesMarker(deps, L);
  if (native === undefined) return dockerProblem(deps);
  const r = deps.spawn('sc.exe', ['query', 'SRE-Database'], {});
  if (/STATE\s*:\s*4\b/.test(String(r.stdout ?? ''))) return undefined;
  return { what: 'the shop database (the Windows service SRE-Database) is not running.', fix: 'Restart the computer. If it says this again, run: pnpm run store-computer -- services-status, and send me a photo of the screen.' };
}

/**
 * One database program (psql, pg_dump, pg_restore) for this copy: the command, its arguments and its environment.
 * `ctx` is recovery's `ready()` — { L, settings, user, env, native? }.
 */
export function dbCommand(deps, ctx, program, args) {
  if (ctx.native !== undefined) {
    const p = pathFor(deps.platform);
    const exe = p.join(ctx.native.pgBin, deps.platform === 'win32' ? `${program}.exe` : program);
    return {
      cmd: exe,
      args: ['-h', '127.0.0.1', '-p', ctx.native.port, ...args],
      opts: { cwd: ctx.L.dataRoot, env: { ...ctx.env, PGPASSWORD: String(ctx.settings.POSTGRES_PASSWORD ?? ''), PGOPTIONS: ALL_TENANTS_PGOPTIONS } },
    };
  }
  // ctx.compose: the Docker copy's own compose files and folder (the move, store-computer-adopt.mjs); else this copy's.
  return { cmd: 'docker', args: [...(ctx.compose?.base ?? composeBase(ctx.L)), 'exec', '-T', '-e', `PGOPTIONS=${ALL_TENANTS_PGOPTIONS}`, 'db', program, ...args], opts: { cwd: ctx.compose?.dir ?? ctx.L.composeDir, env: ctx.env } };
}

/** Run it: `extra` is merged into the spawn options (input, stdio). */
export function dbSpawn(deps, ctx, program, args, extra = {}) {
  const c = dbCommand(deps, ctx, program, args);
  return deps.spawn(c.cmd, c.args, { ...c.opts, ...extra });
}

/**
 * The backup's ONE psql session on the PC's own PostgreSQL (Windows services): one REPEATABLE READ snapshot, the totals
 * read in it written to `totalsFile` (psql's \o), and pg_dump of exactly that snapshot on psql's own standard output —
 * the archive file. The same guarantee as the Docker script (recovery's backupScript, GT-07); only the plumbing differs:
 * Windows has no `cat`, and its shell names a variable %LIKE_THIS%.
 */
export function nativeBackupScript({ user, database, pgDump, totalsFile, port }) {
  const plain = /^[a-z_][a-z0-9_]*$/;
  for (const n of [user, database]) if (!plain.test(String(n))) throw new Error(`not a plain database name: ${String(n)}`);
  if (/['"%\r\n]/.test(String(pgDump)) || /['\r\n]/.test(String(totalsFile))) throw new Error('a path with a quote, a percent sign or a line break cannot be used');
  const totals = String(totalsFile).replace(/\\/g, '/');
  return [
    '\\set ON_ERROR_STOP 1',
    `\\o '${totals}'`,
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',
    'SELECT pg_export_snapshot() AS sre_snapshot \\gset',
    "SELECT 'SNAP|' || :'sre_snapshot';",
    "SELECT format('SELECT %L || count(*) FROM public.%I', 'ROWS|' || tablename || '|', tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \\gexec",
    "SELECT CASE WHEN to_regclass('public.event_ledger') IS NOT NULL THEN $q$SELECT 'VAL|' || type || '|' || coalesce(sum((payload->>'totalMinor')::bigint), 0) FROM event_ledger WHERE payload ? 'totalMinor' GROUP BY type ORDER BY type$q$ END \\gexec",
    "SELECT CASE WHEN to_regclass('public.event_ledger') IS NOT NULL THEN $q$SELECT 'SEQ|' || coalesce(max(seq), 0) FROM event_ledger$q$ END \\gexec",
    "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NOT NULL THEN $q$SELECT 'MIG|' || name FROM schema_migrations ORDER BY name$q$ END \\gexec",
    '\\setenv SRE_SNAPSHOT :sre_snapshot',
    `\\! "${pgDump}" --format=custom --enable-row-security --snapshot=%SRE_SNAPSHOT% -h 127.0.0.1 -p ${Number(port)} -U ${user} -d ${database}`,
    "SELECT 'DUMPEXIT|' || :'SHELL_EXIT_CODE';",
    'COMMIT;',
    "SELECT 'DONE|';",
    '\\o',
    '',
  ].join('\n');
}

/** The other lines psql said that are not the tagged totals — for a reason to show. */
export const otherLines = (text) => lines(text).filter((l) => !/^(ROWS|VAL|SEQ|MIG|SNAP|DUMPEXIT|DONE)\|/.test(l));
