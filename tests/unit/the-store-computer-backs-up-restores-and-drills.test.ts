import { describe, it, expect } from 'vitest';
import * as nodeFs from 'node:fs';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupRecordVerdict, main, ownDriveProblem, parseCommandLine, prepare } from '../../scripts/lib/store-computer.mjs';
import {
  assertScratch, backup, backupScript, drill, drillVerdict, migrationProblems, parseTotals, reconcile, releaseId, restoreCheck, scratchName, totalsScript,
  type DrillStep,
} from '../../scripts/lib/store-computer-recovery.mjs';
import { settingsOf, world, type Call, type World } from '../support/store-computer-world';

/**
 * OB-246 — the backup, the restore-and-reconcile and the timed rollback drill (pilot gate G9), built into the owner's
 * store-computer tool so they run on his Windows PC with no PostgreSQL tools, no bash and no git (closes gap G-RD-6).
 * Driven here with a pretend Docker whose pretend database answers the tool's own SQL, a pretend clock, and every line
 * the tool says captured. The same logic on real PostgreSQL: tests/integration/the-store-computer-backup-restores-on-real-postgres.test.ts.
 */

const SECRETS = ['POSTGRES_PASSWORD', 'DATABASE_URL', 'PACK_SIGNING_KEY', 'BOX_HISTORY_SEAL_KEY', 'IDP_SIGNING_KEY'];
const MIN = 60_000;

async function prepared(over: Parameters<typeof world>[0] = {}, opts: Parameters<typeof world>[1] = {}): Promise<World> {
  const w = world(over, opts);
  expect(await prepare(w.deps)).toBe(0);
  w.said.length = 0;
  w.calls.length = 0;
  return w;
}
/** The owner's backup drive, outside the repository folder. */
const driveOf = (): string => mkdtempSync(join(tmpdir(), 'sre-owner-drive-'));
const said = (w: World): string => w.said.join('\n');
const execs = (w: World, program: string): Call[] => w.calls.filter((c) => c.args.includes('exec') && c.args[c.args.indexOf('db') + 1] === program);
const sqlOf = (c: Call): string => c.args[c.args.indexOf('-c') + 1] ?? '';

function expectNoSecret(w: World, extra: string[] = []): void {
  const s = settingsOf(w);
  const seen = [...w.said, ...extra].join('\n');
  for (const k of SECRETS) {
    expect(seen.includes(s[k]!), `${k} was shown`).toBe(false);
    expect(seen.includes(s[k]!.slice(0, 16)), `part of ${k} was shown`).toBe(false);
  }
}
const filesIn = (dir: string): string[] => readdirSync(dir).sort();
const textsIn = (dir: string): string[] => filesIn(dir).filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(dir, f), 'utf8'));

describe('backup --to <folder> — pg_dump inside the database container, streamed to the owner\'s drive', () => {
  it('writes the dump and a manifest (size, SHA-256, time taken, row counts), both read-only; says only names and numbers', async () => {
    const w = await prepared({}, { costOf: (_cmd, _args, input) => (input?.includes('pg_export_snapshot') === true ? 3 * MIN : 0) });
    const drive = driveOf();
    expect(await backup(w.deps, { to: drive })).toBe(0);
    expect(filesIn(drive)).toEqual(['sre-real-backup-2026-10-20T04-30-00-000Z.dump', 'sre-real-backup-2026-10-20T04-30-00-000Z.manifest.json']);
    const dump = join(drive, 'sre-real-backup-2026-10-20T04-30-00-000Z.dump');
    const m = JSON.parse(readFileSync(join(drive, 'sre-real-backup-2026-10-20T04-30-00-000Z.manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(m).toMatchObject({
      kind: 'store-computer-backup', version: 1, project: 'sre-real', database: 'sre_real', folder: drive, file: 'sre-real-backup-2026-10-20T04-30-00-000Z.dump',
      sizeBytes: statSync(dump).size, timeTakenMs: 3 * MIN, consistency: { method: 'exported_snapshot', snapshotId: '00000003-0000001B-1' },
      controlTotals: { rowCounts: { event_ledger: 4, products: 12, schema_migrations: 2 }, valueTotals: { SaleCommitted: 100_000 }, maxEventSeq: 4, totalRows: 18 },
      schemaVersion: '0002_b.sql',
    });
    expect(m['sha256']).toMatch(/^[0-9a-f]{64}$/);
    for (const f of filesIn(drive)) expect(statSync(join(drive, f)).mode & 0o222, f).toBe(0);
    const out = said(w);
    expect(out).toMatch(/^BACKUP DONE — sre-real-backup-.*\.dump, \d+ KB, in 3\.0 min\.$/m);
    expect(out).toMatch(/3 tables, 18 rows in all; the newest event is number 4\./);
    expect(out).toMatch(/Nothing was deleted\./);
    expect(out).toMatch(/^Next: pnpm run store-computer -- restore-check --from .*\.manifest\.json$/m);
    expectNoSecret(w, textsIn(drive));
  });

  it('runs ONE psql session in this copy\'s db container: snapshot, totals and pg_dump of that snapshot, psql\'s own output on stderr', async () => {
    const w = await prepared();
    expect(await backup(w.deps, { to: driveOf() })).toBe(0);
    const [c, ...more] = execs(w, 'psql');
    expect(more).toEqual([]);
    expect(c!.args).toEqual(['compose', '-p', 'sre-real', '-f', 'docker-compose.yml', '--env-file', '.env.real', 'exec', '-T', '-e', 'PGOPTIONS=-c app.tenant_id=*', 'db',
      'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'sre_admin', '-d', 'sre_real']);
    expect(c!.cwd).toBe(join(w.root, 'infra', 'compose'));
    expect(Array.isArray(c!.stdio) && typeof (c!.stdio as unknown[])[1]).toBe('number'); // stdout is the file on the drive, never this program's memory
    const script = c!.input!;
    expect(script.indexOf('\\o | cat 1>&2')).toBeLessThan(script.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'));
    expect(script.indexOf('pg_export_snapshot()')).toBeLessThan(script.indexOf('ROWS|'));
    expect(script.indexOf('ROWS|')).toBeLessThan(script.indexOf('\\! pg_dump --format=custom --enable-row-security --snapshot="$SRE_SNAPSHOT"'));
    expect(script.indexOf('\\! pg_dump')).toBeLessThan(script.indexOf('COMMIT;'));
    expect(script).toContain("SELECT 'DUMPEXIT|' || :'SHELL_EXIT_CODE';");
    // No secret ever goes into the SQL or the command line.
    const s = settingsOf(w);
    for (const k of SECRETS) expect([script, ...c!.args].join(' ').includes(s[k]!), k).toBe(false);
  });

  it('refuses: no --to; a folder inside the system\'s folder; a production settings file — before running a single program', async () => {
    const w = await prepared();
    expect(await backup(w.deps, {})).toBe(2);
    expect(w.said[0]).toMatch(/^REFUSED — say where the backup goes/);
    expect(await backup(w.deps, { to: join(w.root, 'backups') })).toBe(2);
    expect(said(w)).toMatch(/is inside the system's own folder/);
    const f = join(w.root, 'infra', 'compose', '.env.real');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^MIGRATION_TARGET_KIND=rehearsal$/m, 'MIGRATION_TARGET_KIND=production'));
    expect(await backup(w.deps, { to: driveOf() })).toBe(2);
    expect(said(w)).toMatch(/never works on a production box/);
    expect(w.calls).toEqual([]);
    expect(existsSync(join(w.root, 'backups'))).toBe(false);
  });

  it('on Windows: refuses C:, the repository\'s drive and inside C:\\SRE — the same rule as check 10', () => {
    const win = { platform: 'win32', repoRoot: 'C:\\SRE', systemDrive: 'C:' };
    expect(ownDriveProblem('C:\\Backups', win)).toMatch(/on this computer's own drive \(C:\)/);
    expect(ownDriveProblem('C:\\SRE\\backups', win)).toMatch(/inside the system's own folder/);
    expect(ownDriveProblem('D:\\sre-real', { ...win, repoRoot: 'D:\\SRE' })).toMatch(/own drive \(D:\)/);
    expect(ownDriveProblem('E:\\sre-real', win)).toBeUndefined();
  });

  it('a pg_dump that fails, or Docker stopped: NOT DONE, no manifest, and the incomplete file is left — never deleted', async () => {
    const w = await prepared();
    w.docker.dumpExit = 1;
    const drive = driveOf();
    expect(await backup(w.deps, { to: drive })).toBe(1);
    expect(said(w)).toMatch(/NOT DONE — pg_dump ended 1/);
    expect(said(w)).toMatch(/left on the drive with no manifest; it is not a backup/);
    expect(filesIn(drive)).toEqual(['sre-real-backup-2026-10-20T04-30-00-000Z.dump']);
    const v = await prepared();
    v.docker.running = false;
    expect(await backup(v.deps, { to: driveOf() })).toBe(1);
    expect(v.said[0]).toMatch(/^NOT DONE — Docker is installed but not running\./);
    expect(execs(v, 'psql')).toEqual([]);
  });

  it('two backups in the same second get two files: nothing is ever overwritten', async () => {
    const w = await prepared();
    const drive = driveOf();
    expect(await backup(w.deps, { to: drive })).toBe(0);
    expect(await backup(w.deps, { to: drive })).toBe(0);
    expect(filesIn(drive).filter((f) => f.endsWith('.dump'))).toEqual(['sre-real-backup-2026-10-20T04-30-00-000Z-2.dump', 'sre-real-backup-2026-10-20T04-30-00-000Z.dump']);
  });

  it('a drive that is not plugged in is said plainly', async () => {
    const w = await prepared();
    const blocked = join(driveOf(), 'file');
    writeFileSync(blocked, 'x');
    expect(await backup(w.deps, { to: join(blocked, 'sub') })).toBe(1);
    expect(said(w)).toMatch(/could not be made .* Is your backup drive plugged in/);
  });
});

describe('restore-check --from <backup> — a NEW scratch database, reconciled, recorded, then dropped', () => {
  const backedUp = async (over: Parameters<typeof world>[0] = {}): Promise<{ w: World; drive: string; manifest: string; dump: string }> => {
    const w = await prepared(over);
    const drive = driveOf();
    expect(await backup(w.deps, { to: drive })).toBe(0);
    w.said.length = 0;
    w.calls.length = 0;
    return { w, drive, manifest: join(drive, 'sre-real-backup-2026-10-20T04-30-00-000Z.manifest.json'), dump: join(drive, 'sre-real-backup-2026-10-20T04-30-00-000Z.dump') };
  };

  it('restored_and_reconciled: restores into sre_restore_check_<time>, counts, writes the record, THEN drops only that database', async () => {
    const { w, drive, manifest } = await backedUp();
    // Look at the drive at the moment of the DROP: the record must already be there.
    const spawn = w.deps.spawn;
    let recordAtDrop: string[] = [];
    w.deps = { ...w.deps, spawn: (cmd, args, o) => { if (args.some((a) => a.startsWith('DROP DATABASE'))) recordAtDrop = filesIn(drive).filter((f) => f.startsWith('restore-check-')); return spawn(cmd, args, o); } };
    expect(await restoreCheck(w.deps, { from: manifest })).toBe(0);
    const out = said(w);
    expect(out).toMatch(/^restored_and_reconciled — 3 tables, 18 rows, every count and the money match the manifest/m);
    expect(out).toMatch(/The scratch database sre_restore_check_20261020043000 was removed after the record was written\. sre_real was never touched\./);
    expect(recordAtDrop).toEqual(['restore-check-2026-10-20T04-30-00-000Z.json']);
    expect(w.docker.dropped).toEqual(['sre_restore_check_20261020043000']);
    expect(Object.keys(w.docker.data)).toEqual(['sre_real']);
    const rec = JSON.parse(readFileSync(join(drive, recordAtDrop[0]!), 'utf8')) as Record<string, unknown>;
    expect(rec).toMatchObject({ kind: 'store-computer-restore-check', outcome: 'restored_and_reconciled', differences: [], offsiteDir: drive, scratchDatabase: 'sre_restore_check_20261020043000' });
    expect(statSync(join(drive, recordAtDrop[0]!)).mode & 0o222).toBe(0);
    // The restore streamed the file in from the drive.
    const [r] = execs(w, 'pg_restore');
    expect(r!.args.slice(r!.args.indexOf('db') + 1)).toEqual(['pg_restore', '-U', 'sre_admin', '-d', 'sre_restore_check_20261020043000', '--no-owner', '--no-privileges']);
    expect(typeof (r!.stdio as unknown[])[0]).toBe('number');
    expect(out).toMatch(/Next: use this record for check 10/);
    expectNoSecret(w, textsIn(drive));
  });

  it('NEVER targets sre_real: every CREATE, restore, count and DROP names the scratch database; assertScratch refuses anything else', async () => {
    const { w, manifest } = await backedUp();
    await restoreCheck(w.deps, { from: manifest });
    const writes = [...execs(w, 'pg_restore'), ...execs(w, 'psql').filter((c) => /^(CREATE|DROP) DATABASE/.test(sqlOf(c)) || c.input !== undefined)];
    expect(writes.length).toBe(4);
    for (const c of writes) expect(c.args.join(' '), c.args.join(' ')).not.toMatch(/\bsre_real\b(?!-)/);
    for (const bad of ['sre_real', 'postgres', 'template1', 'sre_restore_check_x', 'sre_restore_check_20261020043000; DROP DATABASE sre_real', '']) {
      expect(() => assertScratch(bad, { POSTGRES_DB: 'sre_real' }), bad).toThrow(/refusing to use/);
    }
    expect(() => assertScratch('sre_restore_check_20261020043000', { POSTGRES_DB: 'sre_restore_check_20261020043000' })).toThrow();
    expect(assertScratch('sre_restore_check_20261020043000_2', { POSTGRES_DB: 'sre_real' })).toBe('sre_restore_check_20261020043000_2');
    expect(scratchName(new Date('2026-10-20T04:30:00Z'), ['sre_restore_check_20261020043000'])).toBe('sre_restore_check_20261020043000_2');
  });

  it('a tampered backup file is refused BEFORE any database is made — and the exact difference is said', async () => {
    const { w, drive, dump } = await backedUp();
    chmodSync(dump, 0o644);
    appendFileSync(dump, 'x');
    expect(await restoreCheck(w.deps, { from: dump })).toBe(1);
    const out = said(w);
    expect(out).toMatch(/NOT ACCEPTED — the backup file is not the file that was taken/);
    expect(out).toMatch(/difference: the file is \d+ bytes; the manifest says \d+/);
    expect(out).toMatch(/difference: the file's SHA-256 is [0-9a-f]{64}; the manifest says [0-9a-f]{64}/);
    expect(w.calls.filter((c) => c.args.includes('exec'))).toEqual([]);
    expect(JSON.parse(textsIn(drive).find((t) => t.includes('store-computer-restore-check'))!)).toMatchObject({ outcome: 'refused_file_changed' });
  });

  it('a restore that does not reconcile is NOT ACCEPTED with each exact difference — and the scratch database is still dropped', async () => {
    const { w, manifest } = await backedUp();
    w.docker.restoreLoses = 1;
    expect(await restoreCheck(w.deps, { from: manifest })).toBe(1);
    expect(said(w)).toMatch(/NOT ACCEPTED — the restored copy does not match the manifest/);
    expect(said(w)).toMatch(/difference: table event_ledger: 4 row\(s\) in the manifest, 3 after the restore/);
    expect(said(w)).not.toMatch(/Next: use this record for check 10/);
    expect(w.docker.dropped).toHaveLength(1);
    const v = await backedUp();
    v.w.docker.restoreStatus = 1;
    expect(await restoreCheck(v.w.deps, { from: v.manifest })).toBe(1);
    expect(said(v.w)).toMatch(/difference: the restore program ended 1: pg_restore: error/);
  });

  it('a scratch database that cannot be dropped is said plainly (exit 1); the result is already on the drive', async () => {
    const { w, drive, manifest } = await backedUp();
    w.docker.dropFails = true;
    expect(await restoreCheck(w.deps, { from: manifest })).toBe(1);
    expect(said(w)).toMatch(/could NOT be removed — it is a copy of the shop's data inside this computer's own database container/);
    expect(textsIn(drive).some((t) => t.includes('restored_and_reconciled'))).toBe(true);
  });

  it('refuses: no --from; not a backup name; no such backup; a dump without its manifest is not restored', async () => {
    const w = await prepared();
    expect(await restoreCheck(w.deps, {})).toBe(2);
    expect(await restoreCheck(w.deps, { from: 'E:\\sre-real\\photo.jpg' })).toBe(2);
    expect(await restoreCheck(w.deps, { from: join(driveOf(), 'x.dump') })).toBe(2);
    expect(said(w)).toMatch(/there is no backup at/);
    const drive = driveOf();
    writeFileSync(join(drive, 'lonely.dump'), 'PGDMP{}');
    expect(await restoreCheck(w.deps, { from: join(drive, 'lonely.dump') })).toBe(1);
    expect(said(w)).toMatch(/NOT ACCEPTED — that backup has no usable manifest/);
    expect(w.calls.filter((c) => c.args.includes('exec'))).toEqual([]);
  });

  it('check 10 takes the backup manifest: FAIL until it is restore-checked, PASS after — judged by where the files really are', async () => {
    const { w, manifest } = await backedUp();
    expect(backupRecordVerdict(w.deps, manifest)).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/has not been restore-checked yet/) });
    expect(await restoreCheck(w.deps, { from: manifest })).toBe(0);
    expect(backupRecordVerdict(w.deps, manifest).status).toBe('PASS');
    // A failed restore-check of the same backup does not count; a check of ANOTHER backup does not count either.
    const v = await backedUp();
    v.w.docker.restoreLoses = 1;
    await restoreCheck(v.w.deps, { from: v.manifest });
    expect(backupRecordVerdict(v.w.deps, v.manifest)).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/restore_not_accepted/) });
  });
});

describe('on Windows paths (C:\\SRE, the backup drive E:) — the same commands, end to end', () => {
  /** Windows paths mapped onto a temporary folder: C:\SRE → <root>, E:\… → <root>/../drive-e/… */
  function onWindows(w: World): World['deps'] {
    const drives = join(w.root, '..', `${w.root.split('/').pop()}-drives`);
    const map = (p: unknown): unknown => {
      if (typeof p !== 'string' || !/^[A-Za-z]:\\/.test(p)) return p;
      if (/^C:\\SRE(\\|$)/i.test(p)) return w.root + p.slice(6).replace(/\\/g, '/');
      return join(drives, `drive-${p[0]!.toLowerCase()}`, p.slice(3).replace(/\\/g, '/'));
    };
    const fs = new Proxy(nodeFs, { get: (t, k) => { const f = (t as Record<string | symbol, unknown>)[k]; return typeof f === 'function' ? (...a: unknown[]) => (f as (...x: unknown[]) => unknown).apply(t, a.map(map)) : f; } });
    return { ...w.deps, platform: 'win32', repoRoot: 'C:\\SRE', env: { SystemDrive: 'C:' }, fs: fs as World['deps']['fs'] };
  }

  it('backup --to E:\\sre-real, restore-check, then check 10 on the manifest passes; C:\\Backups is refused', async () => {
    const w = await prepared();
    const deps = onWindows(w);
    expect(await main(['--', 'backup', '--to', 'C:\\Backups'], deps)).toBe(2);
    expect(said(w)).toMatch(/C:\\Backups is on this computer's own drive \(C:\)/);
    expect(await main(['--', 'backup', '--to', 'E:\\sre-real'], deps)).toBe(0);
    expect(said(w)).toMatch(/Manifest: E:\\sre-real\\sre-real-backup-2026-10-20T04-30-00-000Z\.manifest\.json/);
    expect(w.calls.find((c) => c.input !== undefined)!.cwd).toBe('C:\\SRE\\infra\\compose');
    expect(await main(['restore-check', '--from', 'E:\\sre-real\\sre-real-backup-2026-10-20T04-30-00-000Z.manifest.json'], deps)).toBe(0);
    expect(backupRecordVerdict(deps, 'E:\\sre-real\\sre-real-backup-2026-10-20T04-30-00-000Z.manifest.json')).toMatchObject({ status: 'PASS', detail: expect.stringContaining('E:\\sre-real') });
  });
});

describe('drill — backup, restore-check, the previous release back, this release back; timed against §32', () => {
  const MIGRATIONS = { '0001_a.sql': 'CREATE TABLE a (id int);\n', '0002_b.sql': 'CREATE TABLE b (id int);\n' };
  function release(root: string, migrations: Record<string, string>, code: string): void {
    mkdirSync(join(root, 'db', 'migrations'), { recursive: true });
    mkdirSync(join(root, 'infra', 'compose'), { recursive: true });
    mkdirSync(join(root, 'services', 'api'), { recursive: true });
    for (const [n, sql] of Object.entries(migrations)) writeFileSync(join(root, 'db', 'migrations', n), sql);
    writeFileSync(join(root, 'infra', 'compose', 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(join(root, 'services', 'api', 'main.ts'), code);
  }
  async function stage(opts: Parameters<typeof world>[1] = {}, previous: Record<string, string> = { '0001_a.sql': MIGRATIONS['0001_a.sql'] }): Promise<{ w: World; drive: string; prev: string; args: { by: string; to: string; previous: string } }> {
    const w = await prepared({}, opts);
    release(w.root, MIGRATIONS, 'export const v = 2;\n');
    const prev = mkdtempSync(join(tmpdir(), 'sre-previous-release-'));
    release(prev, previous, 'export const v = 1;\n');
    const drive = driveOf();
    return { w, drive, prev, args: { by: 'S. Rajendran', to: drive, previous: prev } };
  }
  const ups = (w: World): Call[] => w.calls.filter((c) => c.args[0] === 'compose' && c.args.includes('up'));
  const drillRecord = (w: World): Record<string, unknown> => JSON.parse(textsIn(join(w.root, 'infra', 'compose', 'records')).at(-1)!) as Record<string, unknown>;

  it('a dry run (no --run) changes nothing, writes nothing, and lists the steps and the targets', async () => {
    const { w, drive, args } = await stage();
    expect(await drill(w.deps, args)).toBe(0);
    const out = said(w);
    expect(out).toMatch(/^DRY RUN — nothing will change\. With --run the drill will, in order:/m);
    expect(out).toMatch(/its 1 steps are this release's first 1, and the 1 newer one\(s\) only add/);
    expect(out).toMatch(/target 30 minutes/);
    expect(w.calls).toEqual([]);
    expect(filesIn(drive)).toEqual([]);
    expect(existsSync(join(w.root, 'infra', 'compose', 'records'))).toBe(false);
  });

  it('--run: G9 PASSED — four timed steps, the previous release from ITS folder with THIS copy\'s settings, then this release; a new dated record', async () => {
    const { w, drive, prev, args } = await stage();
    expect(await drill(w.deps, { ...args, run: true })).toBe(0);
    const [back, forward, ...more] = ups(w);
    expect(more).toEqual([]);
    expect(back!.cwd).toBe(join(prev, 'infra', 'compose'));
    expect(back!.args).toEqual(['compose', '-p', 'sre-real', '-f', 'docker-compose.yml', '--env-file', join(w.root, 'infra', 'compose', '.env.real'), 'up', '-d', '--build', 'db', 'migrate', 'api']);
    expect(forward!.cwd).toBe(join(w.root, 'infra', 'compose'));
    expect(forward!.args).toEqual(['compose', '-p', 'sre-real', '-f', 'docker-compose.yml', '--env-file', '.env.real', 'up', '-d', '--build', 'db', 'migrate', 'api']);
    expect(w.calls.indexOf(back!)).toBeGreaterThan(w.calls.indexOf(execs(w, 'pg_restore')[0]!));
    const out = said(w);
    expect(out).toMatch(/^G9 PASSED — every step worked, each inside its target/m);
    const rec = drillRecord(w);
    expect(rec).toMatchObject({ kind: 'store-computer-rollback-drill', by: 'S. Rajendran', overall: 'G9 PASSED', previousRelease: { folder: prev, migrations: 1 }, currentRelease: { migrations: 2 } });
    expect((rec['steps'] as DrillStep[]).map((s) => [s.key, s.ok, s.withinTarget])).toEqual([['backup', true, true], ['restore', true, true], ['rollback', true, true], ['rollForward', true, true]]);
    expect(rec['method']).toMatch(/the database is not rolled back \(migrations only add\)/);
    // A copy of the record on the drive, beside the backup and its restore-check record.
    expect(filesIn(drive).filter((f) => f.startsWith('g9-drill-'))).toEqual(['g9-drill-2026-10-20T04-30-00-000Z.json']);
    expectNoSecret(w, [...textsIn(drive), ...textsIn(join(w.root, 'infra', 'compose', 'records'))]);
    // Every drill writes a NEW record.
    expect(await drill(w.deps, { ...args, run: true })).toBe(0);
    expect(filesIn(join(w.root, 'infra', 'compose', 'records')).filter((f) => f.startsWith('g9-drill-'))).toHaveLength(2);
  });

  it('a step over its 30-minute target is NOT a pass, even though everything worked', async () => {
    const { w, args } = await stage({ costOf: (_c, a) => (a.includes('up') && a.includes('--build') ? 31 * MIN : 0) });
    expect(await drill(w.deps, { ...args, run: true })).toBe(1);
    expect(said(w)).toMatch(/SLOW {2}put the previous release back and wait for READY — 31\.0 min \(target 30\.0 min\)/);
    expect(said(w)).toMatch(/G9 NOT PASSED — 2 step\(s\) took longer than the target/);
    expect(drillRecord(w)['overall']).toBe('G9 NOT PASSED');
  });

  it('backup and restore each inside 4 hours but together over it: NOT a pass (the database must be back within 4 hours)', async () => {
    const { w, args } = await stage({ costOf: (_c, a, input) => (a.includes('pg_restore') ? 150 * MIN : input?.includes('pg_export_snapshot') === true ? 100 * MIN : 0) });
    expect(await drill(w.deps, { ...args, run: true })).toBe(1);
    expect(said(w)).toMatch(/backup plus restore took \d+\.\d min, over the 4-hour target/);
  });

  it('the previous release that will not come up: FAILED — and this release is still put back', async () => {
    const { w, prev, args } = await stage();
    w.docker.upStatusIn = (cwd) => (cwd.startsWith(prev) ? 1 : 0);
    expect(await drill(w.deps, { ...args, run: true })).toBe(1);
    expect(ups(w)).toHaveLength(2);
    expect(said(w)).toMatch(/FAILED {2}put the previous release back .* Docker could not start it/);
    expect(said(w)).toMatch(/done {2}put this release back and wait for READY/);
    expect(said(w)).toMatch(/G9 NOT PASSED — 1 step\(s\) did not work/);
  });

  it('this release that cannot be put back again is said loudly: run up, send a photo', async () => {
    const { w, prev, args } = await stage();
    w.docker.upStatusIn = (cwd) => (cwd.startsWith(prev) ? 0 : 1);
    expect(await drill(w.deps, { ...args, run: true })).toBe(1);
    expect(said(w)).toMatch(/THIS COPY MAY NOT BE ON THIS RELEASE NOW\. Run: pnpm run store-computer -- up/);
  });

  it('a previous release whose migrate step ADDS to the database is not a clean rollback: FAILED', async () => {
    const { w, args } = await stage();
    w.docker.previousAddsMigration = '0099_previous_only.sql';
    expect(await drill(w.deps, { ...args, run: true })).toBe(1);
    expect(said(w)).toMatch(/the previous release changed the database's steps — that is not a clean rollback/);
  });

  it('an API that answers but was not started by this step (the old one still serving) is not believed', async () => {
    const { w, args } = await stage();
    const spawn = w.deps.spawn;
    w.deps = { ...w.deps, spawn: (cmd, a, o) => (a.includes('label=com.docker.compose.service=api') ? { status: 0, stdout: '/somewhere/else/docker-compose.yml\n' } : spawn(cmd, a, o)) };
    expect(await drill(w.deps, { ...args, run: true })).toBe(1);
    expect(said(w)).toMatch(/the API that answered is not the one this step started/);
  });

  it('a backup that fails stops the drill before any release is touched', async () => {
    const { w, args } = await stage();
    w.docker.dumpExit = 2;
    expect(await drill(w.deps, { ...args, run: true })).toBe(1);
    expect(ups(w)).toEqual([]);
    expect(said(w)).toMatch(/G9 NOT PASSED — 1 step\(s\) did not work .*not every step ran/);
  });

  it('refuses, changing nothing: no --by/--to/--previous; --previous is this folder or inside it or empty; the same release; unsafe migrations; the drive on C:', async () => {
    const { w, prev, args } = await stage();
    expect(await drill(w.deps, {})).toBe(2);
    expect(said(w)).toMatch(/REFUSED — the drill needs: --by "<your name>", --to .*, --previous/);
    const cases: [Partial<typeof args>, RegExp][] = [
      [{ previous: w.root }, /names this release's own folder/],
      [{ previous: join(w.root, 'old') }, /is inside this release's folder/],
      [{ previous: driveOf() }, /there is no release in/],
      [{ to: join(w.root, 'drills') }, /inside the system's own folder/],
    ];
    for (const [over, why] of cases) {
      w.said.length = 0;
      expect(await drill(w.deps, { ...args, ...over, run: true })).toBe(2);
      expect(said(w)).toMatch(why);
    }
    writeFileSync(join(prev, 'services', 'api', 'main.ts'), 'export const v = 2;\n');
    writeFileSync(join(prev, 'db', 'migrations', '0002_b.sql'), MIGRATIONS['0002_b.sql']);
    w.said.length = 0;
    expect(await drill(w.deps, { ...args, run: true })).toBe(2);
    expect(said(w)).toMatch(/the same release — that rehearses nothing/);
    expect(w.calls).toEqual([]);
  });

  it('the database steps must be an exact prefix: a step only the previous release has, or a changed step, is refused', () => {
    expect(migrationProblems({ a: '1' }, { a: '1', b: '2' })).toEqual([]);
    expect(migrationProblems({ a: '1', c: '3' }, { a: '1', b: '2' })[0]).toMatch(/a database step \(c\) this release does not have/);
    expect(migrationProblems({ a: '9' }, { a: '1' })[0]).toMatch(/differs between the two releases/);
    expect(migrationProblems({ b: '2' }, { a: '1', b: '2' })[0]).toMatch(/not the first steps of this release/);
    expect(migrationProblems(undefined, { a: '1' })[0]).toMatch(/no db\\migrations folder/);
  });

  it('a database that has not got every step of this release (or does not answer) is refused before the backup', async () => {
    const { w, args } = await stage();
    w.docker.data['sre_real']!.migrations = ['0001_a.sql'];
    expect(await drill(w.deps, { ...args, run: true })).toBe(2);
    expect(said(w)).toMatch(/has not got every step of this release yet/);
    expect(ups(w)).toEqual([]);
  });

  it('a release id changes with the code and ignores settings files, node_modules and dist', () => {
    const a = mkdtempSync(join(tmpdir(), 'sre-rel-a-'));
    release(a, MIGRATIONS, 'x');
    const id = releaseId(nodeFs, 'linux', a);
    mkdirSync(join(a, 'services', 'node_modules'), { recursive: true });
    writeFileSync(join(a, 'services', 'node_modules', 'big.js'), 'y');
    writeFileSync(join(a, 'services', '.env.real'), 'SECRET=1');
    expect(releaseId(nodeFs, 'linux', a)).toBe(id);
    writeFileSync(join(a, 'services', 'api', 'main.ts'), 'z');
    expect(releaseId(nodeFs, 'linux', a)).not.toBe(id);
  });

  it('the verdict: G9 PASSED only with all four steps, each worked and inside its target', () => {
    const step = (key: DrillStep['key'], over: Partial<DrillStep> = {}): DrillStep => ({ key, title: key, ok: true, ms: MIN, withinTarget: true, ...over });
    const all = [step('backup'), step('restore'), step('rollback'), step('rollForward')];
    expect(drillVerdict(all).passed).toBe(true);
    expect(drillVerdict(all.slice(0, 3)).line).toMatch(/not every step ran/);
    expect(drillVerdict([step('backup'), step('restore'), step('rollback', { ok: false }), step('rollForward')]).passed).toBe(false);
    expect(drillVerdict([step('backup'), step('restore'), step('rollback', { withinTarget: false }), step('rollForward')]).passed).toBe(false);
    expect(drillVerdict([step('backup', { ms: 3 * 60 * MIN }), step('restore', { ms: 61 * MIN }), step('rollback'), step('rollForward')]).passed).toBe(false);
  });

  it('the command line takes the new options; --run is never assumed', () => {
    expect(parseCommandLine(['--', 'drill', '--by', 'O', '--to', 'E:\\sre-real', '--previous', 'C:\\SRE-previous'])).toMatchObject({ command: 'drill', by: 'O', to: 'E:\\sre-real', previous: 'C:\\SRE-previous', run: false, problems: [] });
    expect(parseCommandLine(['drill', '--run'])).toMatchObject({ run: true });
    expect(parseCommandLine(['restore-check', '--from', 'E:\\x.dump'])).toMatchObject({ from: 'E:\\x.dump' });
    expect(parseCommandLine(['backup', '--to'])).toMatchObject({ problems: ['--to needs a value'] });
  });
});

describe('the SQL the tool sends, and the lines it reads back', () => {
  it('reads only tagged lines; anything else is kept to show, never mistaken for a count', () => {
    const t = parseTotals('SNAP|0003-1B-1\nROWS|event_ledger|4\nROWS|a|b|7\nVAL|SaleCommitted|100000\nSEQ|4\nMIG|0001_a.sql\nNOTICE:  something\nDUMPEXIT|0\nDONE|\n');
    expect(t).toMatchObject({ snapshot: '0003-1B-1', rowCounts: { event_ledger: 4, 'a|b': 7 }, valueTotals: { SaleCommitted: 100_000 }, maxEventSeq: 4, migrations: ['0001_a.sql'], dumpExit: 0, done: true, other: ['NOTICE:  something'] });
  });

  it('reconciles rows, money and the newest event — every difference named', () => {
    const e = { rowCounts: { a: 1, b: 2 }, valueTotals: { S: 10 }, maxEventSeq: 5 };
    expect(reconcile(e, e)).toEqual([]);
    expect(reconcile(e, { rowCounts: { a: 1, c: 1 }, valueTotals: { S: 9 }, maxEventSeq: 4 })).toEqual([
      'table b: 2 row(s) in the manifest, but the table is missing after the restore',
      'table c: not in the backup\'s manifest, but 1 row(s) after the restore',
      'money in S: 10 paise in the manifest, 9 after the restore',
      'the newest event: number 5 in the manifest, 4 after the restore',
    ]);
  });

  it('only checked plain names go into the SQL', () => {
    expect(() => backupScript({ user: 'sre_admin', database: 'sre_real; DROP' })).toThrow(/not a plain database name/);
    expect(backupScript({ user: 'sre_admin', database: 'sre_real' })).toContain('\\setenv PGDATABASE sre_real');
    expect(totalsScript().join('\n')).not.toMatch(/sre_real/);
  });
});
