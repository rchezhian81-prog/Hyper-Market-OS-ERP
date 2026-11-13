import { describe, it, expect } from 'vitest';
import { main, type Deps } from '../../scripts/lib/store-computer.mjs';
import { SERVICES } from '../../scripts/lib/store-computer-services.mjs';
import { ADOPTED_MARKER } from '../../scripts/lib/store-computer-adopt.mjs';
import { nativeBackupScript, readServicesMarker } from '../../scripts/lib/store-computer-db.mjs';
import { TASKS } from '../../scripts/lib/store-computer-schedule.mjs';
import { layout } from '../../scripts/lib/store-computer.mjs';
import { world, type World } from '../support/store-computer-world';
import { settingsIn, storePc, type PretendWin } from '../support/store-pc-windows';

/**
 * **CR-01 step 2c · OI-08 — the owner's store PC, set up with Docker on 5–8 Nov 2026, is MOVED onto Windows services, with
 * every record, setting and person kept, and still passes the G4 checks.**
 *
 *   setup on a PC whose shop lives in Docker: the till started at sign-in and the office are stopped (nothing writes any
 *   more); ONE snapshot is taken and counted, the hourly backup's own method; the Docker copy is STOPPED, never removed (its
 *   storage is the way back); the services are installed and, BEFORE the office starts, the snapshot is restored and counted
 *   again — every table's rows, the money in every kind of event, the newest event's number. Only on an exact match is the
 *   move recorded, the old sign-in start removed and the plain snapshot deleted. On any difference: the services are
 *   removed, the new database folder moved aside (kept) and the Docker copy started again.
 *
 *   After the move, the tool reaches the database as a Windows service: backup (the same one-snapshot guarantee, with
 *   Windows' own plumbing), the restore check, G4 checks 1 and 2, the red light, `up` and `autostart`. The rollback drill
 *   and `update` say plainly that their Windows versions come with the one-click update (CR-01 step 3).
 *
 * Driven on a pretend Windows with a pretend Docker and a pretend native PostgreSQL. NOTHING HERE IS REAL WINDOWS.
 */

const said = (w: World): string => w.said.join('\n');

/**
 * The owner's store PC as it is today: settings in F:\SRE-data (prepared with Docker), the till installed and started at
 * sign-in (process 4242), the sign-in start registered, the shop's data in Docker (pretend db with rows and money).
 */
async function ownersPc(): Promise<{ w: World; d: Deps; win: PretendWin }> {
  const w = world();
  const { d, win } = storePc(w);
  w.docker.volumes = ['sre-real_db-data', 'sre-real_edge-data'];
  w.docker.data['sre_real'] = { tables: { event_ledger: 40, products: 2740, schema_migrations: 15 }, values: { SaleCommitted: 1_234_500 }, maxSeq: 40, migrations: ['0001_a.sql', '0015_b.sql'] };
  expect(await main(['prepare', '--data-drive', 'F:'], d)).toBe(0);
  const fs = d.fs;
  for (const dir of ['C:\\SRE\\runtime\\pgsql\\bin', 'C:\\SRE\\runtime\\winsw', 'C:\\SRE\\scripts', 'C:\\SRE\\services\\api\\dist', 'C:\\SRE\\edge\\store-edge\\dist', 'F:\\SRE-data\\till', 'F:\\SRE-data\\run']) fs.mkdirSync(dir, { recursive: true });
  for (const exe of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe', 'pg_isready.exe', 'pg_restore.exe', 'pg_dump.exe']) fs.writeFileSync(`C:\\SRE\\runtime\\pgsql\\bin\\${exe}`, 'pretend');
  fs.writeFileSync('C:\\SRE\\runtime\\winsw\\WinSW-x64.exe', 'pretend');
  fs.writeFileSync('C:\\SRE\\scripts\\store-computer-service.mjs', '// launcher');
  fs.writeFileSync('C:\\SRE\\services\\api\\dist\\start.js', '// api');
  fs.writeFileSync('C:\\SRE\\edge\\store-edge\\dist\\start.js', '// edge');
  fs.writeFileSync('C:\\SRE\\release.json', JSON.stringify({ kind: 'sre-store-pc-release', version: '1.0.0' }));
  const s = settingsIn(fs, 'F:\\SRE-data');
  fs.writeFileSync('F:\\SRE-data\\till\\till.env', `EDGE_TENANT_ID=${s['EDGE_TENANT_ID']}\nPACK_SIGNING_KEY=${s['PACK_SIGNING_KEY']}\nEDGE_LANE_ID=lane-1\nEDGE_LANE_PORT=8090\nEDGE_SCREEN_PORT=8091\nEDGE_DATA_DIR=F:\\SRE-data\\till\\edge-data\n`);
  fs.writeFileSync('F:\\SRE-data\\run\\till.json', JSON.stringify({ pid: 4242, startedAt: '2026-11-08T03:00:00.000Z' }));
  // The release the owner set up with in November (the ZIP in C:\\SRE-2026-11) is the live one before the move.
  fs.writeFileSync('F:\\SRE-data\\run\\current-release.json', JSON.stringify({ folder: 'C:\\SRE-2026-11', setAt: '2026-11-06T10:00:00.000Z' }));
  // The Docker copy was made from that November release folder: Docker says so on its containers (10 Nov 2026: the move
  // must use these files — the installed program's folder has no compose file).
  fs.mkdirSync('C:\\SRE-2026-11\\infra\\compose', { recursive: true });
  fs.writeFileSync('C:\\SRE-2026-11\\infra\\compose\\docker-compose.yml', 'services: {}\n');
  w.docker.madeFrom = 'C:\\SRE-2026-11\\infra\\compose|C:\\SRE-2026-11\\infra\\compose\\docker-compose.yml';
  w.tasks.registered.set(TASKS.start, '<Task/>');
  w.said.length = 0;
  return { w, d, win };
}

describe('setup on the owner\'s PC: the Docker copy is moved, everything kept', () => {
  it('stops the till and the office, takes one counted snapshot, stops Docker (kept), restores, counts again — MATCHED, MOVED', async () => {
    const { w, d, win } = await ownersPc();
    const before = d.fs.readFileSync('F:\\SRE-data\\.env.real', 'utf8');
    expect(await main(['setup'], d)).toBe(0);
    const out = said(w);
    // The till started at sign-in was stopped; the office stopped before the snapshot; Docker stopped, never removed.
    expect(w.killed).toEqual([4242]);
    expect(win.composeSeen.map((a) => a.join(' '))).toEqual(['up -d --wait db', 'stop api', 'stop']);
    expect(w.calls.some((c) => c.cmd === 'docker' && (c.args.includes('down') || c.args.includes('rm') || (c.args[0] === 'volume' && c.args[1] === 'rm')))).toBe(false);
    expect(out).toMatch(/^The shop's data is taken out of Docker in one snapshot: 3 tables, 2795 rows, newest event number 40\.$/m);
    expect(out).toMatch(/^The Docker copy is stopped\. Its storage \(sre-real_db-data\) is KEPT on this PC, untouched — it is the way back\.$/m);
    // Restored into the new database BEFORE the office started, then counted again.
    const restoreAt = win.calls.findIndex((c) => c.cmd.endsWith('pg_restore.exe'));
    const officeStart = win.calls.findIndex((c) => c.cmd === 'sc.exe' && c.args[0] === 'start' && c.args[1] === SERVICES.api);
    expect(restoreAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeLessThan(officeStart);
    expect(win.calls[restoreAt]!.args).toEqual(expect.arrayContaining(['--exit-on-error', '--single-transaction']));
    expect(win.nativeDbs['sre_real']).toEqual(w.docker.data['sre_real']);
    expect(out).toMatch(/^MATCHED — the new database holds exactly what the Docker copy held/m);
    expect(out).toMatch(/^MOVED — the shop runs as Windows services, with everything it had\./m);
    // The settings and the tenant id are kept byte for byte; the move is recorded; the old sign-in start is gone.
    expect(d.fs.readFileSync('F:\\SRE-data\\.env.real', 'utf8')).toBe(before);
    expect(out).toMatch(/This shop's tenant id: [0-9a-f-]{36} {2}\(kept; a name, not a secret\)\./);
    expect(JSON.parse(d.fs.readFileSync(`F:\\SRE-data\\run\\services\\${ADOPTED_MARKER}`, 'utf8'))).toMatchObject({ kind: 'sre-moved-from-docker', keptDockerStorage: 'sre-real_db-data', rows: 2795, maxEventSeq: 40 });
    expect(w.tasks.removed).toContain(TASKS.start);
    expect(readServicesMarker(d, layout('C:\\SRE', 'win32', 'F:\\SRE-data'))).toEqual({ pgBin: 'C:\\SRE\\runtime\\pgsql\\bin', port: '5432' });
    // The plain snapshot is deleted once the move matched.
    expect(d.fs.readdirSync('F:\\SRE-data\\scratch').filter((f) => f.startsWith('move-from-docker-'))).toEqual([]);
    for (const n of [SERVICES.database, SERVICES.api, SERVICES.till]) expect(win.services.get(n)?.state).toBe('running');
    // The installed release is now the live one: the hourly backup and the check run from it; the old one is remembered.
    expect(JSON.parse(d.fs.readFileSync('F:\\SRE-data\\run\\current-release.json', 'utf8'))).toMatchObject({ folder: 'C:\\SRE', previous: 'C:\\SRE-2026-11' });
    expect(out).toMatch(/^The live release is now C:\\SRE \(it was C:\\SRE-2026-11\); the automatic backup and the check run from it\.$/m);
  });

  it('a new database that does not match is NOT accepted: services removed, the new folder kept aside, Docker started again', async () => {
    const { w, d, win } = await ownersPc();
    win.restoreLoses = 1;
    expect(await main(['setup'], d)).toBe(1);
    const out = said(w);
    expect(out).toMatch(/NOT DONE — the new database does not match the Docker copy:/);
    expect(out).toMatch(/table event_ledger: 40 row\(s\) in the manifest, 39 after the restore/);
    expect(out).toMatch(/PUTTING THE SHOP BACK AS IT WAS/);
    expect(win.services.size).toBe(0);
    expect(d.fs.readdirSync('F:\\SRE-data').some((f) => f.startsWith('database-unfinished-'))).toBe(true);
    expect(win.composeSeen.at(-1)!.join(' ')).toBe('up -d db migrate api');
    expect(d.fs.existsSync(`F:\\SRE-data\\run\\services\\${ADOPTED_MARKER}`)).toBe(false);
    expect(readServicesMarker(d, layout('C:\\SRE', 'win32', 'F:\\SRE-data'))).toBeUndefined();
    // The old sign-in start stays, so a restart brings the till back on Docker.
    expect(w.tasks.removed).not.toContain(TASKS.start);
    // The snapshot is kept for a person to look at.
    expect(d.fs.readdirSync('F:\\SRE-data\\scratch').some((f) => f.startsWith('move-from-docker-'))).toBe(true);
  });

  it('refuses, changing nothing, while Docker Desktop is not running — it is needed once more to take the data out', async () => {
    const { w, d, win } = await ownersPc();
    w.docker.running = false;
    expect(await main(['setup'], d)).toBe(2);
    expect(said(w)).toMatch(/^REFUSED — Docker Desktop is installed but not running, and this PC was set up before: its shop may still be in Docker, and Docker is needed to look\. Nothing was changed\./m);
    expect(w.killed).toEqual([]);
    expect(win.services.size).toBe(0);
    // The owner's PC, 12 Nov 2026: this case used to make a NEW, EMPTY database. Now nothing is made.
    expect(win.initdbRuns).toBe(0);
    expect(readServicesMarker(d, layout('C:\\SRE', 'win32', 'F:\\SRE-data'))).toBeUndefined();
  });

  /** The owner's PC after 12 Nov 2026: the services were made with an EMPTY database while the shop stayed in Docker. */
  async function leftBehind(): Promise<{ w: World; d: Deps; win: PretendWin }> {
    const pc = await ownersPc();
    expect(await main(['install-services', '--pg-bin', 'C:\\SRE\\runtime\\pgsql\\bin', '--service-host', 'C:\\SRE\\runtime\\winsw\\WinSW-x64.exe'], pc.d)).toBe(0);
    pc.d.fs.writeFileSync('F:\\SRE-data\\run\\current-release.json', JSON.stringify({ folder: 'C:\\SRE', setAt: '2026-11-12T03:00:00.000Z', previous: 'C:\\SRE-2026-11' }));
    expect(pc.win.nativeDbs['sre_real']).toEqual({ tables: {}, values: {}, maxSeq: 0, migrations: [] }); // empty
    pc.w.said.length = 0;
    return pc;
  }

  it('the services were made EMPTY, the shop left in Docker: setup sets the empty database aside (kept) and does the move — MATCHED, MOVED', async () => {
    const { w, d, win } = await leftBehind();
    expect(await main(['setup'], d)).toBe(0);
    const out = said(w);
    expect(out).toMatch(/^The shop database on this PC was made EMPTY, without the shop's data from Docker/m);
    expect(out).toMatch(/^The new database holds no records: it is set aside, kept, and the move from Docker runs now\.$/m);
    expect(d.fs.readdirSync('F:\\SRE-data').some((f) => f.startsWith('database-empty-not-moved-'))).toBe(true);
    expect(out).toMatch(/^MATCHED — the new database holds exactly what the Docker copy held/m);
    expect(out).toMatch(/^MOVED — /m);
    expect(win.nativeDbs['sre_real']).toEqual(w.docker.data['sre_real']);
    expect(d.fs.existsSync(`F:\\SRE-data\\run\\services\\${ADOPTED_MARKER}`)).toBe(true);
  });

  // The owner's PC, 12 Nov 2026 (release 1.0.2017): SRE-Setup.exe had stopped the three services before copying its files,
  // so the empty database could not be counted ("Connection refused") and the repair refused. It is started first now.
  it('the installer stopped the services first: the database is started, answers, is counted — then set aside and the move runs', async () => {
    const { w, d, win } = await leftBehind();
    for (const s of win.services.values()) s.state = 'stopped';
    const spawn = d.spawn;
    const stoppedDbRefuses: Deps = { ...d, spawn: (cmd, args, o) => (String(cmd).endsWith('psql.exe') && win.services.get(SERVICES.database)?.state !== 'running' ? { status: 2, stdout: '', stderr: 'psql: error: connection to server at "127.0.0.1", port 5432 failed: Connection refused' } : spawn(cmd, args, o)) };
    expect(await main(['setup'], stoppedDbRefuses)).toBe(0);
    const out = said(w);
    expect(out).toMatch(/^The new database holds no records: it is set aside/m);
    expect(out).toMatch(/^MOVED — /m);
    expect(win.nativeDbs['sre_real']).toEqual(w.docker.data['sre_real']);
  });

  it('the new database holds MONEY records (it was traded on): REFUSED, nothing changed, nothing moved over it', async () => {
    const { w, d, win } = await leftBehind();
    win.nativeDbs['sre_real'] = { tables: { event_ledger: 3 }, values: { SaleCommitted: 5_000 }, maxSeq: 3, migrations: ['0001_a.sql'] };
    expect(await main(['setup'], d)).toBe(2);
    expect(said(w)).toMatch(/^REFUSED — the new database on this PC holds money records \(SaleCommitted 5000\): it was traded on\. Nothing was changed/m);
    expect(win.services.size).toBe(3);
    expect(d.fs.readdirSync('F:\\SRE-data').some((f) => f.startsWith('database-empty-not-moved-'))).toBe(false);
    expect(w.killed).toEqual([]);
  });

  // Gap audit, 13 Nov 2026, before the owner's next run.
  it('records with no money in them (a sign-in on the office page): set aside WITH the empty database, said, and the move runs', async () => {
    const { w, d, win } = await leftBehind();
    win.nativeDbs['sre_real'] = { tables: { event_ledger: 2 }, values: {}, maxSeq: 2, migrations: ['0001_a.sql'] };
    expect(await main(['setup'], d)).toBe(0);
    const out = said(w);
    expect(out).toMatch(/^The new database holds no money records \(2 other record\(s\), such as sign-ins\): it is set aside with them, kept, and the move from Docker runs now\.$/m);
    expect(out).toMatch(/^MOVED — /m);
  });

  it('Docker\'s copy is stopped BEFORE the new database is started and looked at (they listen in the same place)', async () => {
    const { d, win } = await leftBehind();
    const from = win.calls.length; // only this run's calls
    expect(await main(['setup'], d)).toBe(0);
    const calls = win.calls.slice(from);
    const stopAt = calls.findIndex((c) => c.cmd === 'docker' && c.args.includes('stop'));
    const dbStartAt = calls.findIndex((c) => c.cmd === 'sc.exe' && c.args[0] === 'start' && c.args[1] === SERVICES.database);
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(dbStartAt);
  });

  it('the database that answers is NOT this PC\'s new one (Docker\'s, still listening): REFUSED — nothing counted, nothing changed', async () => {
    const { w, d, win } = await leftBehind();
    const spawn = d.spawn;
    const dockersAnswers: Deps = { ...d, spawn: (cmd, args, o) => (String(cmd).endsWith('psql.exe') && args.includes('SHOW data_directory') ? { status: 0, stdout: '/var/lib/postgresql/data\n', stderr: '' } : spawn(cmd, args, o)) };
    expect(await main(['setup'], dockersAnswers)).toBe(2);
    expect(said(w)).toMatch(/^REFUSED — the database that answered is not this PC's new one \(its files are in \/var\/lib\/postgresql\/data, not F:\\SRE-data\\database\)\. Nothing was changed\./m);
    expect(win.services.size).toBe(3);
    expect(d.fs.readdirSync('F:\\SRE-data').some((f) => f.startsWith('database-empty-not-moved-'))).toBe(false);
  });

  it('the till\'s old process number now belongs to ANOTHER program (after a restart): it is not stopped', async () => {
    const { w, d } = await ownersPc();
    const other: Deps = { ...d, processCommandLine: () => 'C:\\Windows\\explorer.exe' };
    expect(await main(['setup'], other)).toBe(0);
    expect(w.killed).toEqual([]);
    expect(said(w)).not.toMatch(/The till started at sign-in .* is stopped/);
  });

  it('the till\'s process really is the till (its command line is the store edge): it is stopped for the move', async () => {
    const { w, d } = await ownersPc();
    const till: Deps = { ...d, processCommandLine: () => '"C:\\Program Files\\nodejs\\node.exe" C:\\SRE-2026-11\\edge\\store-edge\\dist\\start.js' };
    expect(await main(['setup'], till)).toBe(0);
    expect(w.killed).toEqual([4242]);
  });

  it('the services were made EMPTY and Docker Desktop is not running: REFUSED, nothing changed', async () => {
    const { w, d, win } = await leftBehind();
    w.docker.running = false;
    expect(await main(['setup'], d)).toBe(2);
    expect(said(w)).toMatch(/^REFUSED — Docker Desktop is installed but not running/m);
    expect(win.services.size).toBe(3);
  });

  // The owner's PC, 10 Nov 2026 (release 1.0.2005): the move asked Docker with the INSTALLED program's compose file, which
  // a release does not carry ("C:\Program Files\SRE Retail OS\infra\compose\docker-compose.yml … cannot find the file"),
  // after it had already stopped the till — and did not give the till back.
  it('speaks to Docker with the files the copy was MADE with (Docker\'s own labels), from that folder — never the installed program\'s', async () => {
    const { w, d, win } = await ownersPc();
    expect(await main(['setup'], d)).toBe(0);
    // Every compose call (up db, the snapshot's exec, stop api, stop) names the copy's own file …
    const composeCalls = win.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'compose' && c.args[1] !== 'version');
    expect(composeCalls.length).toBe(4);
    for (const c of composeCalls) expect(c.args.slice(0, 6)).toEqual(['compose', '-p', 'sre-real', '-f', 'C:\\SRE-2026-11\\infra\\compose\\docker-compose.yml', '--env-file']);
    // … and runs in the copy's folder (the calls the pretend Docker answered itself carry their folder).
    const withFolder = w.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'compose' && c.args[1] !== 'version');
    expect(withFolder.length).toBeGreaterThan(0);
    for (const c of withFolder) expect(c.cwd).toBe('C:\\SRE-2026-11\\infra\\compose');
    expect(said(w)).toMatch(/^The Docker copy was made from C:\\SRE-2026-11\\infra\\compose; it is spoken to with its own files\.$/m);
  });

  it('Docker cannot say where the copy was made: REFUSED before anything stops — the till keeps running', async () => {
    const { w, d, win } = await ownersPc();
    delete w.docker.madeFrom;
    expect(await main(['setup'], d)).toBe(2);
    expect(said(w)).toMatch(/^REFUSED — Docker has no container of the shop that says where it was made\. Nothing was changed; the till and the shop run as before\./m);
    expect(w.killed).toEqual([]);
    expect(win.composeSeen).toEqual([]);
    expect(win.services.size).toBe(0);
    // The old release stays the live one, so the sign-in start keeps working as before.
    expect(JSON.parse(d.fs.readFileSync('F:\\SRE-data\\run\\current-release.json', 'utf8')).folder).toBe('C:\\SRE-2026-11');
  });

  it('the folder the copy was made from is gone: REFUSED before anything stops', async () => {
    const { w, d } = await ownersPc();
    d.fs.rmSync('C:\\SRE-2026-11\\infra\\compose\\docker-compose.yml');
    expect(await main(['setup'], d)).toBe(2);
    expect(said(w)).toMatch(/REFUSED — the folder the Docker copy was made from is not on this PC any more \(C:\\SRE-2026-11\\infra\\compose\\docker-compose\.yml\)\./);
    expect(w.killed).toEqual([]);
  });

  it('Docker\'s database will not start after the till was stopped: nothing changed, and the till is started again', async () => {
    const { w, d, win } = await ownersPc();
    w.docker.upStatus = 1;
    expect(await main(['setup'], d)).toBe(1);
    const out = said(w);
    expect(w.killed).toEqual([4242]);
    expect(out).toMatch(/NOT DONE — the Docker copy's database did not start: .*Nothing was changed\./);
    expect(w.tasks.ran).toEqual([TASKS.start]);
    expect(out).toMatch(/^ {2}The till is started again, as it was\.$/m);
    expect(win.services.size).toBe(0);
    expect(JSON.parse(d.fs.readFileSync('F:\\SRE-data\\run\\current-release.json', 'utf8')).folder).toBe('C:\\SRE-2026-11');
  });

  it('put back after a mismatch: Docker started again AND the till started again', async () => {
    const { w, d, win } = await ownersPc();
    win.restoreLoses = 1;
    expect(await main(['setup'], d)).toBe(1);
    expect(w.tasks.ran).toEqual([TASKS.start]);
    expect(said(w)).toMatch(/^ {2}The Docker copy is running again\.\n {2}The till is started again, as it was\.$/m);
  });

  it('run again after the move: nothing is moved twice, nothing replaced', async () => {
    const { w, d, win } = await ownersPc();
    expect(await main(['setup'], d)).toBe(0);
    const restores = win.calls.filter((c) => c.cmd.endsWith('pg_restore.exe')).length;
    w.said.length = 0;
    expect(await main(['setup'], d)).toBe(0);
    expect(win.calls.filter((c) => c.cmd.endsWith('pg_restore.exe')).length).toBe(restores);
    expect(said(w)).toMatch(/The shop database in F:\\SRE-data\\database is kept as it is\./);
  });
});

describe('after the move, the tool asks the database service — not Docker', () => {
  it('backup: the same one-snapshot guarantee on the PC\'s own PostgreSQL; the restore check reconciles it', async () => {
    const { w, d, win } = await ownersPc();
    expect(await main(['setup'], d)).toBe(0);
    w.docker.running = false; // Docker is gone; the backup must not need it
    w.said.length = 0;
    d.fs.mkdirSync('G:\\sre-real', { recursive: true });
    expect(await main(['backup', '--to', 'G:\\sre-real'], d)).toBe(0);
    expect(said(w)).toMatch(/^BACKUP DONE — sre-real-backup-/m);
    const snap = win.calls.find((c) => c.cmd.endsWith('psql.exe') && String(c.input ?? '').includes('pg_export_snapshot'))!;
    expect(snap.args).toEqual(expect.arrayContaining(['-h', '127.0.0.1', '-p', '5432']));
    expect(snap.env?.['PGPASSWORD']).toBe(settingsIn(d.fs, 'F:\\SRE-data')['POSTGRES_PASSWORD']);
    expect(snap.args.join(' ')).not.toContain(settingsIn(d.fs, 'F:\\SRE-data')['POSTGRES_PASSWORD']!);
    const manifest = d.fs.readdirSync('G:\\sre-real').find((f) => f.endsWith('.manifest.json'))!;
    w.said.length = 0;
    expect(await main(['restore-check', '--from', `G:\\sre-real\\${manifest}`], d)).toBe(0);
    expect(said(w)).toMatch(/RECONCILED|reconciled/);
    expect(w.calls.some((c) => c.cmd === 'docker' && c.args.includes('exec'))).toBe(true); // only the move's own snapshot, before
  });

  it('G4 checks 1 and 2 ask the database service; the red light names the three services', async () => {
    const { w, d, win } = await ownersPc();
    expect(await main(['setup'], d)).toBe(0);
    w.docker.running = false;
    w.said.length = 0;
    await main(['check', '--by', 'Owner'], d);
    const out = said(w);
    expect(out).toMatch(/ 1 {2}PASS {7}Own project, own storage\s+this copy's database lives in F:\\SRE-data\\database, run by its own Windows service \(SRE-Database\)/);
    expect(out).toMatch(/ 2 {2}PASS {7}Own database\s+sre_real is there, and no demo database\./);
    win.services.get(SERVICES.till)!.state = 'stopped';
    w.said.length = 0;
    await main(['status'], d);
    expect(said(w)).toMatch(/not running: the till/);
  });

  it('autostart: nothing to do (Windows starts the services); the drill and update say their Windows versions come in step 3', async () => {
    const { w, d } = await ownersPc();
    expect(await main(['setup'], d)).toBe(0);
    w.said.length = 0;
    expect(await main(['autostart'], d)).toBe(0);
    expect(said(w)).toMatch(/^NOTHING TO DO — this copy runs as Windows services/m);
    w.said.length = 0;
    expect(await main(['drill', '--by', 'Owner', '--to', 'G:\\sre-real', '--previous', 'C:\\SRE-old', '--run'], d)).toBe(2);
    expect(said(w)).toMatch(/NOT YET — this copy runs as Windows services .*CR-01 step 3/);
    w.said.length = 0;
    expect(await main(['update', '--from', 'C:\\SRE-new'], d)).toBe(2);
    expect(said(w)).toMatch(/NOT YET — this copy runs as Windows services .*CR-01 step 3/);
  });
});

describe('the Windows backup script (store-computer-db.mjs)', () => {
  it('one REPEATABLE READ snapshot; totals to a file; pg_dump of that snapshot by the Windows shell\'s %VARIABLE%; plain names only', () => {
    const sql = nativeBackupScript({ user: 'sre_admin', database: 'sre_real', pgDump: 'C:\\Program Files\\SRE Retail OS\\runtime\\pgsql\\bin\\pg_dump.exe', totalsFile: 'F:\\SRE-data\\scratch\\b\\totals.txt', port: '5432' });
    expect(sql).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    expect(sql).toContain("\\o 'F:/SRE-data/scratch/b/totals.txt'");
    expect(sql).toContain('\\! "C:\\Program Files\\SRE Retail OS\\runtime\\pgsql\\bin\\pg_dump.exe" --format=custom --enable-row-security --snapshot=%SRE_SNAPSHOT% -h 127.0.0.1 -p 5432 -U sre_admin -d sre_real');
    expect(() => nativeBackupScript({ user: 'sre_admin; drop', database: 'sre_real', pgDump: 'x', totalsFile: 'y', port: 5432 })).toThrow(/not a plain database name/);
    expect(() => nativeBackupScript({ user: 'sre_admin', database: 'sre_real', pgDump: 'C:\\a%b\\pg_dump.exe', totalsFile: 'y', port: 5432 })).toThrow(/quote, a percent sign/);
  });
});
