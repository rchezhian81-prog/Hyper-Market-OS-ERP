import { describe, it, expect } from 'vitest';
import { win32 } from 'node:path';
import { main, type Deps, type SpawnResult } from '../../scripts/lib/store-computer.mjs';
import { SERVICES } from '../../scripts/lib/store-computer-services.mjs';
import { KEPT_FOLDER, SYSTEM_SID } from '../../scripts/lib/store-pc-updater.mjs';
import { DRILL_LOG, DRILL_PROGRESS, DRILL_TASK } from '../../scripts/lib/store-pc-drill.mjs';
import { world, type World } from '../support/store-computer-world';
import { settingsIn, storePc, type PretendWin } from '../support/store-pc-windows';

/**
 * **CR-01 step 3e · OI-05 · pilot gate G9 · QG-08 · roadmap §32 · OB-718: the timed rollback drill on Windows services.**
 *
 *   Until now `drill` said "NOT YET" on a store PC that runs as Windows services (ADR-0032). Now it runs there, in the
 *   updater's own way: the person's window checks, takes an ENCRYPTED backup, restores it into a scratch database and
 *   reconciles it, and keeps the running version whole beside the program; then a task (as Windows itself, from that
 *   kept copy — Windows will not replace a running program file) puts the EARLIER version back and checks it, and puts
 *   the running version back and checks it. Each leg is timed against §32 (30 minutes; the database within 4 hours).
 *   G9 PASSED only when every step worked inside its target. A new record every time, a read-only copy on the backup
 *   drive, and — only when every step worked — the QG-08 rollback body for head office's register. The shop's database
 *   is never rolled back or touched; nothing is ever deleted; it refuses while a till shift is open (OB-718).
 *
 * Driven on a pretend Windows (services, robocopy, the tool's own `setup` and checks, the till). NOTHING HERE IS REAL
 * WINDOWS: the clean-Windows run is CR-01 step 3f.
 */

const CUR = '1.0.2012';
const PREV = '1.0.2005';
const KEPT_ROOT = `C:\\${KEPT_FOLDER}`;
const KEPT_PREV = `${KEPT_ROOT}\\${PREV}`;
const KEPT_CUR = `${KEPT_ROOT}\\${CUR}`;
const SHOP_DB = 'sre_real';
const STEPS = ['0001_first.sql', '0002_new.sql'];

interface Pc {
  w: World; d: Deps; win: PretendWin;
  how: {
    open: string[] | 'silent';
    /** The versions whose `services-status` says FIX. */
    badChecks: Set<string>;
    /** The versions whose own `setup` does not finish. */
    badSetup: Set<string>;
    /** The previous version's setup adds a database step (it must not). */
    prevAddsStep: boolean;
    ran: string[][];
  };
}

const SERVICES_IN_ORDER = [SERVICES.database, SERVICES.api, SERVICES.till];
const realFs = (d: Deps): typeof import('node:fs') => d.fs as unknown as typeof import('node:fs');
const versionOn = (d: Deps): string => JSON.parse(d.fs.readFileSync('C:\\SRE\\release.json', 'utf8')).version as string;

/** One whole installed version's files, in `root`. */
function writeVersion(fs: Deps['fs'], root: string, version: string, steps: string[]): void {
  for (const dir of ['runtime\\pgsql\\bin', 'runtime\\winsw', 'runtime\\node', 'scripts', 'services\\api\\dist', 'edge\\store-edge\\dist', 'db\\migrations']) fs.mkdirSync(`${root}\\${dir}`, { recursive: true });
  for (const exe of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe', 'pg_isready.exe', 'pg_dump.exe', 'pg_restore.exe']) fs.writeFileSync(`${root}\\runtime\\pgsql\\bin\\${exe}`, 'pretend');
  fs.writeFileSync(`${root}\\runtime\\winsw\\WinSW-x64.exe`, 'pretend');
  fs.writeFileSync(`${root}\\runtime\\node\\node.exe`, 'pretend node');
  fs.writeFileSync(`${root}\\scripts\\store-computer.mjs`, `// the tool, version ${version}`);
  fs.writeFileSync(`${root}\\scripts\\store-computer-service.mjs`, '// launcher');
  fs.writeFileSync(`${root}\\services\\api\\dist\\start.js`, `// api ${version}`);
  fs.writeFileSync(`${root}\\edge\\store-edge\\dist\\start.js`, `// edge ${version}`);
  for (const s of steps) fs.writeFileSync(`${root}\\db\\migrations\\${s}`, `-- ${s}\ncreate table if not exists t_${s.slice(0, 4)} (id int);`);
  fs.writeFileSync(`${root}\\release.json`, JSON.stringify({ kind: 'sre-store-pc-release', version }));
}

/**
 * A store PC on version 1.0.2012 (C:\SRE, its data in C:\SRE-data), the three services running, the shop's database
 * holding both of its steps and some sales, the hourly backup on G:\sre-real — and version 1.0.2005 kept from an earlier
 * update in C:\SRE Retail OS kept\1.0.2005.
 */
async function storePcWithAnEarlierVersion(): Promise<Pc> {
  const w = world();
  const how: Pc['how'] = { open: [], badChecks: new Set(), badSetup: new Set(), prevAddsStep: false, ran: [] };
  const pc = storePc(w);
  const { win } = pc;
  const base = pc.d;
  const fetchBase = base.fetch;
  const spawnBase = base.spawn;
  const d: Deps = {
    ...base,
    freeDiskBytes: () => 200 * 1024 ** 3,
    fetch: (async (url: string) => {
      if (url.endsWith('/update/open-shifts')) {
        if (how.open === 'silent') throw new Error('ECONNREFUSED');
        return { ok: true, json: async () => ({ kind: 'sre-open-shifts-v1', open: (how.open as string[]).map((tillId) => ({ tillId })) }) };
      }
      if (url.endsWith('/pos/')) return { ok: true, json: async () => ({}) };
      return fetchBase(url);
    }) as Deps['fetch'],
    spawn: ((cmd: string, args: readonly string[], o: Record<string, unknown> = {}): SpawnResult => {
      const exe = win32.basename(cmd).toLowerCase();
      if (exe === 'robocopy.exe') {
        how.ran.push(['robocopy', args[0]!, args[1]!]);
        realFs(d).rmSync(args[1]!, { recursive: true, force: true });
        realFs(d).cpSync(args[0]!, args[1]!, { recursive: true });
        return { status: 1 };
      }
      if (exe === 'node.exe' && String(args[0]).endsWith('store-computer.mjs')) {
        const version = versionOn(d);
        how.ran.push([`node(${version})`, ...args.slice(1)]);
        if (args[1] === 'services-status') return how.badChecks.has(version) ? { status: 1, stdout: 'FIX      SRE Retail OS - office API (SRE-API): stopped\r\n' } : { status: 0, stdout: 'OK\r\n' };
        if (args[1] === 'setup') {
          if (how.badSetup.has(version)) return { status: 1, stdout: 'NOT STARTED — the shop database did not start.\r\n' };
          if (version === PREV && how.prevAddsStep) win.nativeDbs[SHOP_DB]!.migrations.push('0003_only_old.sql');
          for (const s of SERVICES_IN_ORDER) { const x = win.services.get(s); if (x) x.state = 'running'; }
          return { status: 0, stdout: 'SETUP DONE.\r\n' };
        }
        return { status: 0 };
      }
      return spawnBase(cmd, args, o);
    }) as Deps['spawn'],
  };
  expect(await main(['prepare'], d)).toBe(0);
  const fs = d.fs;
  writeVersion(fs, 'C:\\SRE', CUR, STEPS);
  writeVersion(fs, KEPT_PREV, PREV, STEPS.slice(0, 1));
  for (const dir of ['C:\\SRE-data\\till\\edge-data', 'G:\\sre-real']) fs.mkdirSync(dir, { recursive: true });
  const s = settingsIn(fs);
  fs.writeFileSync('C:\\SRE-data\\till\\till.env', `EDGE_TENANT_ID=${s['EDGE_TENANT_ID']}\nPACK_SIGNING_KEY=${s['PACK_SIGNING_KEY']}\nEDGE_LANE_ID=lane-1\nEDGE_LANE_PORT=8090\nEDGE_SCREEN_PORT=8091\nEDGE_DATA_DIR=C:\\SRE-data\\till\\edge-data\n`);
  expect(await main(['setup'], d)).toBe(0);
  expect(await main(['schedule-backup', '--to', 'G:\\sre-real'], d)).toBe(0);
  // The shop's database: both steps applied, and some synthetic trading.
  win.nativeDbs[SHOP_DB] = { tables: { event_ledger: 12, schema_migrations: 2, products: 40 }, values: { 'sale.committed': 154_900 }, maxSeq: 12, migrations: [...STEPS] };
  w.said.length = 0;
  how.ran.length = 0;
  return { w, d, win, how };
}

const said = (pc: Pc): string => pc.w.said.join('\n');
const drillArgs = (pc: Pc): string => /<Arguments>(.*)<\/Arguments>/.exec(pc.w.tasks.registered.get(DRILL_TASK)!)![1]!;
const records = (pc: Pc): string[] => pc.d.fs.readdirSync('C:\\SRE-data\\records').map(String).filter((f) => f.startsWith('g9-drill-'));
const theRecord = (pc: Pc): Record<string, unknown> & { steps: { key: string; ok: boolean; detail?: string }[]; overall: string } => {
  const f = records(pc).find((n) => !n.includes('qg08'))!;
  return JSON.parse(pc.d.fs.readFileSync(`C:\\SRE-data\\records\\${f}`, 'utf8'));
};
const log = (pc: Pc): Record<string, unknown>[] => pc.d.fs.readFileSync(`C:\\SRE-data\\drills\\${DRILL_LOG}`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const progress = (pc: Pc): Record<string, unknown> => JSON.parse(pc.d.fs.readFileSync(`C:\\SRE-data\\status\\${DRILL_PROGRESS}`, 'utf8'));

/** The person's window (`drill --run`), then — as Windows would — the task, run from the kept copy of the running version. */
async function bothHalves(pc: Pc, extra: string[] = []): Promise<{ first: number; second: number }> {
  const first = await main(['drill', '--by', 'Mr Sivakumar', '--run', ...extra], pc.d);
  if (!pc.w.tasks.ran.includes(DRILL_TASK)) return { first, second: -1 };
  const W = /drill --legs '([^']+)'/.exec(drillArgs(pc))![1]!;
  const second = await main(['drill', '--legs', W], { ...pc.d, repoRoot: KEPT_CUR });
  return { first, second };
}

describe('the dry run — what the drill would do, nothing changed', () => {
  it('finds the newest earlier version kept by the updater, names every step and its target, and touches nothing', async () => {
    const pc = await storePcWithAnEarlierVersion();
    expect(await main(['drill', '--by', 'Mr Sivakumar'], pc.d)).toBe(0);
    const out = said(pc);
    expect(out).toMatch(/^DRY RUN — nothing will change\./m);
    expect(out).toContain(`put version ${PREV} back from ${KEPT_PREV}`);
    expect(out).toContain('target 30 minutes');
    expect(out).toContain('back up this PC onto G:\\sre-real, encrypted');
    expect(out).toContain(`"${DRILL_TASK}"`);
    expect(pc.how.ran).toEqual([]);
    expect(pc.w.tasks.registered.has(DRILL_TASK)).toBe(false);
    expect(pc.d.fs.existsSync('C:\\SRE-data\\drills')).toBe(false);
    expect(pc.d.fs.existsSync(KEPT_CUR)).toBe(false);
  });

  it('of two kept versions it takes the newest one that is still EARLIER than the running one', async () => {
    const pc = await storePcWithAnEarlierVersion();
    writeVersion(pc.d.fs, `${KEPT_ROOT}\\1.0.1999`, '1.0.1999', STEPS.slice(0, 1));
    writeVersion(pc.d.fs, `${KEPT_ROOT}\\1.0.2020`, '1.0.2020', STEPS);
    expect(await main(['drill', '--by', 'Mr Sivakumar'], pc.d)).toBe(0);
    expect(said(pc)).toContain(`put version ${PREV} back from ${KEPT_PREV}`);
  });
});

describe('refused before anything changes — and said in plain words', () => {
  it('no name: the drill is always someone\'s', async () => {
    const pc = await storePcWithAnEarlierVersion();
    expect(await main(['drill', '--run'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/^REFUSED — the drill needs: --by "<your name>"$/m);
  });

  it('no earlier version kept yet (no update has happened): it says so, and how there will be one', async () => {
    const pc = await storePcWithAnEarlierVersion();
    realFs(pc.d).rmSync(KEPT_ROOT, { recursive: true, force: true });
    expect(await main(['drill', '--by', 'Mr Sivakumar', '--run'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/REFUSED — no earlier version is kept on this PC yet .*The updater keeps the running version before every update/);
    expect(pc.how.ran).toEqual([]);
  });

  it('--previous naming the program\'s own folder, or a folder with no whole version in it', async () => {
    const pc = await storePcWithAnEarlierVersion();
    expect(await main(['drill', '--by', 'Mr Sivakumar', '--previous', 'C:\\SRE\\scripts'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/REFUSED — --previous \(C:\\SRE\\scripts\) is the program's own folder, or inside it/);
    pc.w.said.length = 0;
    pc.d.fs.mkdirSync('C:\\SRE-old', { recursive: true });
    expect(await main(['drill', '--by', 'Mr Sivakumar', '--previous', 'C:\\SRE-old'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/REFUSED — there is no whole installed version in C:\\SRE-old/);
  });

  it('an earlier version whose database steps are not this version\'s first steps: going back is not safe, never faked', async () => {
    const pc = await storePcWithAnEarlierVersion();
    pc.d.fs.writeFileSync(`${KEPT_PREV}\\db\\migrations\\0001_first.sql`, '-- a different first step');
    expect(await main(['drill', '--by', 'Mr Sivakumar', '--run'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/REFUSED — the database step 0001_first\.sql differs between the two releases — going back is not safe/);
    expect(pc.how.ran).toEqual([]);
  });

  it('OB-718: a till shift open, or a till that does not answer — nothing backed up, nothing kept, nothing stopped', async () => {
    for (const open of [['till-2'], 'silent'] as const) {
      const pc = await storePcWithAnEarlierVersion();
      pc.how.open = open as string[] | 'silent';
      expect(await main(['drill', '--by', 'Mr Sivakumar', '--run'], pc.d)).toBe(2);
      expect(said(pc)).toMatch(open === 'silent' ? /REFUSED — the till did not answer/ : /REFUSED — a till shift is open \(till-2\)/);
      expect(pc.how.ran).toEqual([]);
      expect(pc.d.fs.readdirSync('G:\\sre-real').filter((f) => String(f).endsWith('.manifest.json')).length).toBe(1);
    }
  });

  it('the shop\'s database without every step of this version: "added nothing" would prove nothing', async () => {
    const pc = await storePcWithAnEarlierVersion();
    pc.win.nativeDbs[SHOP_DB]!.migrations = STEPS.slice(0, 1);
    expect(await main(['drill', '--by', 'Mr Sivakumar', '--run'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/REFUSED — the shop's database has not got every step of this version/);
  });
});

describe('the whole drill — G9 PASSED, every step written down, the shop\'s data never touched', () => {
  it('backup, restore and reconcile, keep, then (as SYSTEM, from the kept copy) the earlier version back and checked, then this one', async () => {
    const pc = await storePcWithAnEarlierVersion();
    const dbBefore = JSON.stringify(pc.win.nativeDbs[SHOP_DB]);
    const { first, second } = await bothHalves(pc);
    expect(first).toBe(0);
    expect(second).toBe(0);
    const out = said(pc);
    // The first half: an encrypted backup, its restore into a scratch database, the running version kept.
    expect(out).toMatch(/^ {2}done {2}backup onto the backup drive, encrypted — /m);
    expect(out).toMatch(/^ {2}done {2}restore into a new scratch database and reconcile — /m);
    expect(out).toMatch(new RegExp(`^KEPT — the running version ${CUR.replace(/\./g, '\\.')} is copied to`, 'm'));
    expect(out).toMatch(/^STARTED — the task "SRE\\Rollback drill" now puts version 1\.0\.2005 back, then 1\.0\.2012 again\./m);
    // The task: as Windows itself, run by the KEPT copy's own node — never from the program folder it replaces.
    expect(pc.w.tasks.registered.get(DRILL_TASK)).toContain(`<UserId>${SYSTEM_SID}</UserId>`);
    expect(drillArgs(pc)).toContain(`'${KEPT_CUR}\\runtime\\node\\node.exe' '${KEPT_CUR}\\scripts\\store-computer.mjs' drill --legs`);
    // In order: keep; then the earlier version in, its setup, its checks; then this version in, its setup, its checks.
    expect(pc.how.ran.map((r) => r.slice(0, 2).join(' '))).toEqual([
      `robocopy C:\\SRE`,
      `robocopy ${KEPT_PREV}`, `node(${PREV}) setup`, `node(${PREV}) services-status`,
      `robocopy ${KEPT_CUR}`, `node(${CUR}) setup`, `node(${CUR}) services-status`,
    ]);
    expect(pc.how.ran[0]![2]).toBe(KEPT_CUR);
    expect(versionOn(pc.d)).toBe(CUR);
    // The verdict and the record: every step, its time and target; a read-only copy on the drive.
    expect(out).toMatch(/^G9 PASSED — every step worked, each inside its target/m);
    const rec = theRecord(pc);
    expect(rec).toMatchObject({ kind: 'store-computer-rollback-drill', version: 2, by: 'Mr Sivakumar', computer: 'Windows', overall: 'G9 PASSED', previousRelease: { version: PREV }, currentRelease: { version: CUR } });
    expect(rec.steps.map((s) => `${s.key}:${s.ok}`)).toEqual(['backup:true', 'restore:true', 'rollback:true', 'rollForward:true']);
    const onDrive = pc.d.fs.readdirSync('G:\\sre-real').map(String).filter((f) => f.startsWith('g9-drill-'));
    expect(onDrive).toHaveLength(1);
    // QG-08: the body of POST /v1/platform/dr-drills for the rollback rehearsal — data loss 0, the rollback leg's time.
    const ev = records(pc).find((f) => f.includes('qg08-rollback'))!;
    expect(JSON.parse(pc.d.fs.readFileSync(`C:\\SRE-data\\records\\${ev}`, 'utf8'))).toEqual({ drillId: rec['drillId'], rehearsal: 'rollback', dataLossSeconds: 0, recoverySeconds: expect.any(Number) });
    // Every step in the append-only log, before the next; the latest word for the dry run.
    expect(log(pc).map((l) => `${l['step']}: ${String(l['outcome']).split(':')[0]}`)).toEqual([
      'start: started', 'backup: done', 'restore: done', 'keep: running version kept', 'handed-over: rollback and roll forward started',
      'rollback: done', 'rollForward: done', 'verdict: G9 PASSED',
    ]);
    expect(progress(pc)).toMatchObject({ state: 'finished', overall: 'G9 PASSED' });
    // Never touched: the shop's database. Never said or written: a secret.
    expect(JSON.stringify(pc.win.nativeDbs[SHOP_DB])).toBe(dbBefore);
    const s = settingsIn(pc.d.fs);
    for (const secret of [s['POSTGRES_PASSWORD'], s['PACK_SIGNING_KEY']]) {
      expect(out).not.toContain(secret!);
      expect(JSON.stringify(rec)).not.toContain(secret!);
      expect(pc.w.tasks.registered.get(DRILL_TASK)).not.toContain(secret!);
    }
    // The dry run afterwards says how the last drill went.
    pc.w.said.length = 0;
    expect(await main(['drill', '--by', 'Mr Sivakumar'], pc.d)).toBe(0);
    expect(said(pc)).toMatch(/^The last drill \(g9-drill-.*\): G9 PASSED/m);
  });

  it('a second drill writes NEW records and APPENDS to the log — nothing is overwritten', async () => {
    const pc = await storePcWithAnEarlierVersion();
    await bothHalves(pc);
    const firstLog = log(pc).length;
    const firstRecords = records(pc).length;
    pc.w.tasks.ran.length = 0;
    await bothHalves(pc);
    expect(log(pc).length).toBe(firstLog * 2);
    expect(records(pc).length).toBe(firstRecords * 2);
  });
});

describe('a step that does not work — G9 NOT PASSED, said, and the PC ends on the version it was on', () => {
  it('the earlier version\'s checks fail: the rollback is FAILED, the running version is put back all the same, no QG-08 body', async () => {
    const pc = await storePcWithAnEarlierVersion();
    pc.how.badChecks.add(PREV);
    const { second } = await bothHalves(pc);
    expect(second).toBe(1);
    expect(said(pc)).toMatch(/^ {2}FAILED {2}put version 1\.0\.2005 back and pass its checks — .*services-status/m);
    expect(said(pc)).toMatch(/^G9 NOT PASSED — 1 step\(s\) did not work/m);
    expect(said(pc)).toMatch(/QG-08: NOT a rehearsal record/);
    expect(versionOn(pc.d)).toBe(CUR);
    expect(records(pc).some((f) => f.includes('qg08'))).toBe(false);
    expect(theRecord(pc).steps.map((s) => `${s.key}:${s.ok}`)).toEqual(['backup:true', 'restore:true', 'rollback:false', 'rollForward:true']);
  });

  it('the earlier version added a database step: that is not a clean rollback', async () => {
    const pc = await storePcWithAnEarlierVersion();
    pc.how.prevAddsStep = true;
    expect((await bothHalves(pc)).second).toBe(1);
    expect(theRecord(pc).steps.find((s) => s.key === 'rollback')).toMatchObject({ ok: false, detail: expect.stringMatching(/changed the shop's database steps/) });
  });

  it('the running version cannot be put back: A PERSON IS NEEDED NOW, on the screen and on the record', async () => {
    const pc = await storePcWithAnEarlierVersion();
    pc.how.badSetup.add(CUR);
    expect((await bothHalves(pc)).second).toBe(1);
    expect(said(pc)).toMatch(/^ {2}A PERSON IS NEEDED NOW — version 1\.0\.2012's program is in place, but it did not start or did not pass its checks\. Run SRE-Setup\.exe of version 1\.0\.2012 again as administrator/m);
    expect(progress(pc)).toMatchObject({ state: 'forward-failed', overall: 'G9 NOT PASSED' });
    expect(String(progress(pc)['said'])).toMatch(/A person is needed now: run SRE-Setup\.exe of version 1\.0\.2012 again as administrator/);
  });

  it('the backup does not reconcile: it stops there — nothing kept, no task, the program and the services untouched', async () => {
    const pc = await storePcWithAnEarlierVersion();
    pc.win.restoreLoses = 1;
    const { first, second } = await bothHalves(pc);
    expect(first).toBe(1);
    expect(second).toBe(-1);
    expect(said(pc)).toMatch(/^NOT GOING ON — the backup did not restore and reconcile/m);
    expect(pc.how.ran).toEqual([]);
    expect(pc.w.tasks.registered.has(DRILL_TASK)).toBe(false);
    expect(theRecord(pc).overall).toBe('G9 NOT PASSED');
  });

  it('a till shift opened between the two halves: the task stops nothing, and says so', async () => {
    const pc = await storePcWithAnEarlierVersion();
    expect(await main(['drill', '--by', 'Mr Sivakumar', '--run'], pc.d)).toBe(0);
    pc.how.open = ['till-1'];
    const W = /drill --legs '([^']+)'/.exec(drillArgs(pc))![1]!;
    const ranBefore = pc.how.ran.length;
    expect(await main(['drill', '--legs', W], { ...pc.d, repoRoot: KEPT_CUR })).toBe(2);
    expect(said(pc)).toMatch(/^NOT GOING ON — a till shift was opened \(till-1\)\. Nothing was stopped\./m);
    expect(pc.how.ran.length).toBe(ranBefore);
    expect(versionOn(pc.d)).toBe(CUR);
    expect(theRecord(pc).overall).toBe('G9 NOT PASSED');
  });

  it('the second half refuses a folder that holds no drill plan', async () => {
    const pc = await storePcWithAnEarlierVersion();
    pc.d.fs.mkdirSync('C:\\SRE-data\\drills\\nothing', { recursive: true });
    expect(await main(['drill', '--legs', 'C:\\SRE-data\\drills\\nothing'], { ...pc.d, repoRoot: KEPT_CUR })).toBe(2);
    expect(said(pc)).toMatch(/REFUSED — C:\\SRE-data\\drills\\nothing holds no drill plan/);
  });
});
