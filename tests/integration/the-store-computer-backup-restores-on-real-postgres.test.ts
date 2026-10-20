import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { backupRecordVerdict, type SpawnResult } from '../../scripts/lib/store-computer.mjs';
import { backup, restoreCheck } from '../../scripts/lib/store-computer-recovery.mjs';
import { world, type World } from '../support/store-computer-world';

/**
 * OB-246 (gap G-RD-6) on REAL PostgreSQL: the store computer's `backup` (one psql session — a REPEATABLE READ snapshot,
 * the row counts read in it, and `pg_dump --snapshot` of that same moment via psql's `\!`, psql's own output on stderr
 * so stdout is the archive only) and `restore-check` (a NEW scratch database, pg_restore streamed in from the file,
 * reconciled against the manifest, the record written, then only the scratch database dropped).
 *
 * On the owner's PC every one of those programs runs INSIDE the sre-real db container (`docker compose … exec -T db …`).
 * Here the "docker exec" is injected: the same program, with the same arguments, the same input and the same streams,
 * runs on this computer against a throw-away empty database, migrated here (synthetic data, hard rule #7).
 * Real Docker and real Windows are NOT exercised here.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;
const RUN = Date.now().toString(36);
const DB = `sc_backup_${RUN}`;
const TENANT = randomUUID();
const urlFor = (db: string): string => { const u = new URL(DATABASE_URL!); u.pathname = `/${db}`; return u.toString(); };

/** `docker compose … exec -T -e K=V db <program> <args>` → `<program> -h <host> -p <port> <args>` here, nothing else. */
function localExec(w: World, pathFirst?: string): World['deps']['spawn'] {
  const u = new URL(DATABASE_URL!);
  return (cmd, args, o): SpawnResult => {
    w.calls.push({ cmd, args: [...args] });
    if (cmd !== 'docker') return { status: 1, stderr: 'only docker is expected here' };
    if (args[0] === '--version' || args[0] === 'info' || (args[0] === 'compose' && args[1] === 'version')) return { status: 0, stdout: '27.0.0\n' };
    const at = args.indexOf('exec');
    if (args[0] !== 'compose' || at === -1) return { status: 0, stdout: '' };
    const db = args.indexOf('db', at);
    const env: Record<string, string | undefined> = { ...process.env, ...(pathFirst === undefined ? {} : { PATH: `${pathFirst}:${process.env['PATH'] ?? ''}` }), PGHOST: u.hostname, PGPORT: u.port || '5432', ...(u.password === '' ? {} : { PGPASSWORD: decodeURIComponent(u.password) }) };
    for (let i = at + 1; i < db; i += 1) if (args[i] === '-e') { const [k, ...v] = args[i + 1]!.split('='); env[k!] = v.join('='); i += 1; }
    const [program, ...rest] = args.slice(db + 1);
    const r = spawnSync(program!, ['-h', u.hostname, '-p', u.port || '5432', ...rest], {
      encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, shell: false,
      ...(o.input === undefined ? {} : { input: o.input }), ...(o.stdio === undefined ? {} : { stdio: o.stdio as never }),
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error === undefined ? {} : { error: r.error }) };
  };
}

describeOrSkip('the store computer backup restores and reconciles — on real PostgreSQL (OB-246)', () => {
  let admin: Pool;
  const drive = mkdtempSync(join(tmpdir(), 'sc-owner-drive-'));
  const scratchMade: string[] = [];

  beforeAll(async () => {
    admin = new Pool({ connectionString: urlFor('postgres'), max: 1 });
    admin.on('error', () => { /* a scratch database is dropped; its idle connections are cut */ });
    await admin.query(`CREATE DATABASE ${DB}`);
    const pool = new Pool({ connectionString: urlFor(DB), max: 2, options: '-c app.tenant_id=*' });
    pool.on('error', () => { /* dropped after */ });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
    const store = new SqlEventStore(pgPoolClient(pool));
    await store.registerTenant(TENANT, 'tests/store-computer-backup');
    for (let n = 1; n <= 3; n += 1) {
      await store.append(TENANT, 'sales', makeEvent({ id: `sc-${RUN}-${n}`, type: 'SaleCommitted', occurredAt: new Date(Date.now() - 60_000 + n).toISOString(), idempotencyKey: `sc-${TENANT}-${n}`, source: 'api/pos', payload: { saleId: `S-${n}`, totalMinor: 12_345 } }));
    }
    await pool.query('CREATE TABLE sc_probe (id serial PRIMARY KEY, note text NOT NULL)');
    await pool.query("INSERT INTO sc_probe (note) SELECT 'before the backup ' || g FROM generate_series(1, 5) g");
    await pool.end();
  }, 120_000);

  afterAll(async () => {
    // This run's own throw-away databases only — synthetic, never a shop's data.
    for (const db of [DB, ...scratchMade]) await admin?.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin?.end();
    rmSync(drive, { recursive: true, force: true });
  });

  /** A pretend store computer whose settings name this run's database, with the "docker exec" run here. */
  function storeComputer(pathFirst?: string): World {
    const w = world();
    const u = new URL(DATABASE_URL!);
    writeFileSync(join(w.root, 'infra', 'compose', '.env.real'), [
      `POSTGRES_USER=${decodeURIComponent(u.username)}`, `POSTGRES_DB=${DB}`, 'MIGRATION_TARGET_KIND=rehearsal', `EDGE_TENANT_ID=${randomUUID()}`, '',
    ].join('\n'));
    w.deps = { ...w.deps, spawn: localExec(w, pathFirst), now: () => new Date() };
    return w;
  }
  const scratchOf = (w: World): string[] => w.calls.flatMap((c) => c.args.filter((a) => /^CREATE DATABASE "/.test(a)).map((a) => /"([a-z0-9_]+)"/.exec(a)![1]!));

  it('backup takes one consistent snapshot to the drive; restore-check restores it into a NEW scratch database, reconciles, records, and drops only that', async () => {
    const w = storeComputer();
    expect(await backup(w.deps, { to: drive }), w.said.join('\n')).toBe(0);
    const manifestName = readdirSync(drive).find((f) => f.endsWith('.manifest.json'))!;
    const manifest = JSON.parse(readFileSync(join(drive, manifestName), 'utf8')) as { controlTotals: { rowCounts: Record<string, number>; valueTotals: Record<string, number>; maxEventSeq: number }; consistency: { snapshotId: string }; sha256: string; sizeBytes: number };
    expect(manifest.consistency.snapshotId).toMatch(/^[0-9A-F]+-[0-9A-F]+-\d+$/);
    expect(manifest.controlTotals.rowCounts['event_ledger']).toBeGreaterThanOrEqual(3);
    expect(manifest.controlTotals.valueTotals['SaleCommitted']).toBeGreaterThanOrEqual(3 * 12_345);
    // The file on the drive is a real custom-format archive (pg_dump's own header), and only that.
    expect(readFileSync(join(drive, manifestName.replace('.manifest.json', '.dump'))).subarray(0, 5).toString('latin1')).toBe('PGDMP');
    // The counts are the database's own at that moment.
    const live = new Pool({ connectionString: urlFor(DB), max: 1, options: '-c app.tenant_id=*' });
    live.on('error', () => { /* dropped after */ });
    expect(Number((await live.query('SELECT count(*)::bigint AS n FROM event_ledger')).rows[0].n)).toBe(manifest.controlTotals.rowCounts['event_ledger']);
    await live.end();

    w.said.length = 0;
    expect(await restoreCheck(w.deps, { from: join(drive, manifestName) }), w.said.join('\n')).toBe(0);
    scratchMade.push(...scratchOf(w));
    expect(w.said.join('\n')).toMatch(/^restored_and_reconciled — /m);
    expect(scratchMade).toHaveLength(1);
    expect(scratchMade[0]).toMatch(/^sre_restore_check_\d{14}(_\d+)?$/);
    // Dropped: the scratch database is gone; this run's database is untouched.
    const names = (await admin.query<{ datname: string }>('SELECT datname FROM pg_database')).rows.map((r) => r.datname);
    expect(names).not.toContain(scratchMade[0]);
    expect(names).toContain(DB);
    // Check 10 accepts the manifest now that it is restore-checked.
    expect(backupRecordVerdict(w.deps, join(drive, manifestName)).status).toBe('PASS');
  }, 120_000);

  it('a tampered backup file fails — refused before restoring; and a manifest that does not match what is in the file fails reconciliation', async () => {
    const w = storeComputer();
    const own = mkdtempSync(join(tmpdir(), 'sc-owner-drive-2-'));
    try {
      expect(await backup(w.deps, { to: own }), w.said.join('\n')).toBe(0);
      const manifestName = readdirSync(own).find((f) => f.endsWith('.manifest.json'))!;
      const dump = join(own, manifestName.replace('.manifest.json', '.dump'));

      // (1) one byte added to the file: the SHA-256 and the size differ — not restored, no database made.
      const copy = mkdtempSync(join(tmpdir(), 'sc-owner-drive-3-'));
      writeFileSync(join(copy, manifestName), readFileSync(join(own, manifestName)));
      writeFileSync(join(copy, manifestName.replace('.manifest.json', '.dump')), readFileSync(dump));
      appendFileSync(join(copy, manifestName.replace('.manifest.json', '.dump')), Buffer.from([0]));
      w.said.length = 0;
      w.calls.length = 0;
      expect(await restoreCheck(w.deps, { from: join(copy, manifestName) })).toBe(1);
      expect(w.said.join('\n')).toMatch(/NOT ACCEPTED — the backup file is not the file that was taken/);
      expect(scratchOf(w)).toEqual([]);
      rmSync(copy, { recursive: true, force: true });

      // (2) the file intact but the manifest claiming one more sale than the file holds: restored, and the count says no.
      chmodSync(join(own, manifestName), 0o644);
      const m = JSON.parse(readFileSync(join(own, manifestName), 'utf8')) as { controlTotals: { rowCounts: Record<string, number> } };
      const expected = m.controlTotals.rowCounts['event_ledger']!;
      m.controlTotals.rowCounts['event_ledger'] = expected + 1;
      writeFileSync(join(own, manifestName), JSON.stringify(m));
      w.said.length = 0;
      w.calls.length = 0;
      expect(await restoreCheck(w.deps, { from: join(own, manifestName) })).toBe(1);
      scratchMade.push(...scratchOf(w));
      expect(w.said.join('\n')).toMatch(new RegExp(`difference: table event_ledger: ${expected + 1} row\\(s\\) in the manifest, ${expected} after the restore`));
      const names = (await admin.query<{ datname: string }>('SELECT datname FROM pg_database')).rows.map((r) => r.datname);
      for (const s of scratchOf(w)) expect(names).not.toContain(s);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  }, 120_000);

  it('one moment (GT-07): a row committed WHILE pg_dump runs is in neither the dump nor the manifest — and the restore still reconciles', async () => {
    // A stand-in pg_dump, first on PATH for the psql session's `\\!`: it commits one more row from ANOTHER connection, then runs
    // the real pg_dump. The backup's snapshot was taken before that row, so neither the counts nor the dump may hold it.
    const bin = mkdtempSync(join(tmpdir(), 'sc-pgdump-wrapper-'));
    const realDump = spawnSync('sh', ['-c', 'command -v pg_dump'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(bin, 'pg_dump'), `#!/bin/sh\npsql -X -q -c "INSERT INTO sc_probe (note) VALUES ('committed while the dump ran')" >/dev/null || exit 9\nexec ${realDump} "$@"\n`, { mode: 0o755 });
    const own = mkdtempSync(join(tmpdir(), 'sc-owner-drive-4-'));
    try {
      const w = storeComputer(bin);
      expect(await backup(w.deps, { to: own }), w.said.join('\n')).toBe(0);
      const manifestName = readdirSync(own).find((f) => f.endsWith('.manifest.json'))!;
      const m = JSON.parse(readFileSync(join(own, manifestName), 'utf8')) as { controlTotals: { rowCounts: Record<string, number> } };
      const live = new Pool({ connectionString: urlFor(DB), max: 1 });
      live.on('error', () => { /* dropped after */ });
      const now = Number((await live.query('SELECT count(*)::bigint AS n FROM sc_probe')).rows[0].n);
      await live.end();
      expect(now).toBe(m.controlTotals.rowCounts['sc_probe']! + 1);
      w.said.length = 0;
      expect(await restoreCheck(w.deps, { from: join(own, manifestName) }), w.said.join('\n')).toBe(0);
      scratchMade.push(...scratchOf(w));
      expect(w.said.join('\n')).toMatch(/^restored_and_reconciled — /m);
    } finally {
      rmSync(own, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  }, 120_000);
});
