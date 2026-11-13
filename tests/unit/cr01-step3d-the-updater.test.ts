import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { win32 } from 'node:path';
import { main, type Deps, type SpawnResult } from '../../scripts/lib/store-computer.mjs';
import { SERVICES } from '../../scripts/lib/store-computer-services.mjs';
import {
  INSTALL_TASK, KEPT_FOLDER, OUTCOME_LOG, PROGRESS_FILE, REQUEST_MAX_AGE_MS, SYSTEM_SID, UPDATER_EVERY_MINUTES, UPDATER_MARK, UPDATER_TASK, checkRequest, systemTaskXml,
} from '../../scripts/lib/store-pc-updater.mjs';
import { releaseTag, sha256Of, signUpdate, updateRecord } from '../../scripts/lib/store-pc-update.mjs';
import { world, type World } from '../support/store-computer-world';
import { settingsIn, storePc, type PretendWin } from '../support/store-pc-windows';

/**
 * **CR-01 step 3d · OI-05 · OB-717 · OB-718 · OB-719 · OB-721: the store PC's updater.**
 *
 *   `setup` sets up the task "SRE\Software update" (as Windows itself, SYSTEM, every 5 minutes). It acts ONLY on the
 *   owner's request from the Software update page (step 3c): the request is taken and kept; the till is asked whether any
 *   shift is open (OB-718); the release is downloaded and checked — signed, verifying with this PC's own release key, the
 *   signed file, newer, and the one the owner was shown; an encrypted backup is taken; the running version is kept whole
 *   beside the program; then the install runs as its own task FROM THAT KEPT COPY. It runs SRE-Setup.exe silently, and the
 *   PC's checks with the new program. On any failure the old version is put back by itself and checked again. Every step
 *   is written down, before the next, in an append-only log; the page is told the latest word. The shop's data is never
 *   rolled back, copied over or deleted.
 *
 * Driven on a pretend Windows (services, robocopy, the setup program, the till, GitHub). NOTHING HERE IS REAL WINDOWS:
 * the clean-Windows update and broken-update CI jobs are step 3f.
 */

const keys = () => {
  const k = generateKeyPairSync('ed25519');
  return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: k.publicKey.export({ type: 'spki', format: 'pem' }) as string };
};
const SHOP_KEY = keys();
const OTHER_KEY = keys();
const NEW = '1.0.2012';
const OLD = '1.0.2005';
const COMMIT = 'a'.repeat(40);
const SETUP_BYTES = Buffer.from('pretend SRE-Setup.exe 1.0.2012');
const KEPT = `C:\\${KEPT_FOLDER}\\${OLD}`;
const TAG_URL = `https://api.github.com/repos/rchezhian81-prog/Hyper-Market-OS-ERP/releases/tags/${releaseTag(NEW)}`;
const RECORD_URL = 'https://api.github.com/assets/record';
const SETUP_URL = 'https://api.github.com/assets/setup';

interface Pc {
  w: World; d: Deps; win: PretendWin;
  /** What the pretend PC does — changed per test. */
  how: {
    open: string[] | 'silent';
    setupStatus: number;
    newStatusOk: boolean;
    oldSetupOk: boolean;
    record: Record<string, unknown>;
    served: Buffer;
    downloads: string[];
    ran: string[][];
  };
}

/**
 * An installed store PC on version 1.0.2005 (C:\SRE, its data in C:\SRE-data), its three services running, the updater
 * set up by `setup`, the hourly backup scheduled to G:\sre-real, and GitHub offering version 1.0.2012, signed.
 */
async function installedPc(): Promise<Pc> {
  const w = world();
  const fields = { version: NEW, commit: COMMIT, sha256: sha256Of(SETUP_BYTES) };
  const how: Pc['how'] = {
    open: [], setupStatus: 0, newStatusOk: true, oldSetupOk: true,
    record: updateRecord({ ...fields, signature: signUpdate(fields, SHOP_KEY.priv) }) as unknown as Record<string, unknown>,
    served: SETUP_BYTES, downloads: [], ran: [],
  };
  /** The PC's own deps, once made below (the pretend GitHub writes its download through them). */
  const self: { d?: Deps } = {};
  const pc = storePc(w, {
    web: async (url: string) => {
      const body = url === TAG_URL ? JSON.stringify({ tag_name: releaseTag(NEW), assets: [{ name: 'SRE-Setup.exe', url: SETUP_URL }, { name: 'update.json', url: RECORD_URL }] })
        : url === RECORD_URL ? JSON.stringify(how.record) : undefined;
      return { status: body === undefined ? 404 : 200, text: async () => body ?? '' };
    },
    download: async (url: string, _h: Record<string, string>, file: string) => {
      how.downloads.push(url);
      if (url !== SETUP_URL) return { status: 404 };
      realFs(self.d!).writeFileSync(file, how.served);
      return { status: 200 };
    },
  } as Partial<Deps>);
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
        return { status: 1 }; // robocopy: 1 = files copied
      }
      if (exe === 'sre-setup.exe') {
        how.ran.push(['SRE-Setup.exe', ...args]);
        for (const s of SERVICES_IN_ORDER) { const x = win.services.get(s); if (x) x.state = 'stopped'; }
        if (how.setupStatus !== 0) return { status: how.setupStatus };
        // The new version's files replace the program; its `setup` starts the services again.
        d.fs.writeFileSync('C:\\SRE\\release.json', JSON.stringify({ kind: 'sre-store-pc-release', version: NEW }));
        d.fs.writeFileSync('C:\\SRE\\db\\migrations\\0002_new.sql', 'create table if not exists t2 (id int);');
        d.fs.writeFileSync('C:\\SRE\\new-only.txt', 'a file only the new version has');
        for (const s of SERVICES_IN_ORDER) { const x = win.services.get(s); if (x) x.state = 'running'; }
        return { status: 0 };
      }
      if (exe === 'node.exe' && String(args[0]).endsWith('store-computer.mjs')) {
        const version = JSON.parse(d.fs.readFileSync('C:\\SRE\\release.json', 'utf8')).version as string;
        how.ran.push([`node(${version})`, ...args.slice(1)]);
        if (args[1] === 'services-status') return { status: version === NEW && !how.newStatusOk ? 1 : 0, stdout: version === NEW && !how.newStatusOk ? 'FIX      SRE Retail OS - office API (SRE-API): stopped\r\n' : 'OK\r\n' };
        if (args[1] === 'setup') {
          if (!how.oldSetupOk) return { status: 1, stdout: 'NOT STARTED — the shop database did not start.\r\n' };
          for (const s of SERVICES_IN_ORDER) { const x = win.services.get(s); if (x) x.state = 'running'; }
          return { status: 0, stdout: 'SETUP DONE.\r\n' };
        }
        return { status: 0 }; // check-update
      }
      return spawnBase(cmd, args, o);
    }) as Deps['spawn'],
  };
  self.d = d;
  expect(await main(['prepare'], d)).toBe(0);
  const fs = d.fs;
  for (const dir of ['C:\\SRE\\runtime\\pgsql\\bin', 'C:\\SRE\\runtime\\winsw', 'C:\\SRE\\runtime\\node', 'C:\\SRE\\scripts', 'C:\\SRE\\services\\api\\dist', 'C:\\SRE\\edge\\store-edge\\dist', 'C:\\SRE\\db\\migrations', 'C:\\SRE-data\\till', 'G:\\sre-real']) fs.mkdirSync(dir, { recursive: true });
  for (const exe of ['initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'psql.exe', 'pg_isready.exe', 'pg_dump.exe']) fs.writeFileSync(`C:\\SRE\\runtime\\pgsql\\bin\\${exe}`, 'pretend');
  fs.writeFileSync('C:\\SRE\\runtime\\winsw\\WinSW-x64.exe', 'pretend');
  fs.writeFileSync('C:\\SRE\\runtime\\node\\node.exe', 'pretend node');
  fs.writeFileSync('C:\\SRE\\scripts\\store-computer.mjs', '// the tool');
  fs.writeFileSync('C:\\SRE\\scripts\\store-computer-service.mjs', '// launcher');
  fs.writeFileSync('C:\\SRE\\services\\api\\dist\\start.js', '// api');
  fs.writeFileSync('C:\\SRE\\edge\\store-edge\\dist\\start.js', '// edge');
  fs.writeFileSync('C:\\SRE\\db\\migrations\\0001_first.sql', 'create table if not exists t1 (id int);');
  fs.writeFileSync('C:\\SRE\\release.json', JSON.stringify({ kind: 'sre-store-pc-release', version: OLD }));
  fs.writeFileSync('C:\\SRE\\release-signing.pub', SHOP_KEY.pub);
  const s = settingsIn(fs);
  fs.writeFileSync('C:\\SRE-data\\till\\till.env', `EDGE_TENANT_ID=${s['EDGE_TENANT_ID']}\nPACK_SIGNING_KEY=${s['PACK_SIGNING_KEY']}\nEDGE_LANE_ID=lane-1\nEDGE_LANE_PORT=8090\nEDGE_SCREEN_PORT=8091\nEDGE_DATA_DIR=C:\\SRE-data\\till\\edge-data\n`);
  fs.mkdirSync('C:\\SRE-data\\till\\edge-data', { recursive: true });
  expect(await main(['setup'], d)).toBe(0);
  expect(await main(['schedule-backup', '--to', 'G:\\sre-real'], d)).toBe(0);
  w.said.length = 0;
  how.ran.length = 0;
  return { w, d, win, how };
}
const SERVICES_IN_ORDER = [SERVICES.database, SERVICES.api, SERVICES.till];
/** The pretend PC's file system is Node's own behind a Windows-path map: every Node call is there. */
const realFs = (d: Deps): typeof import('node:fs') => d.fs as unknown as typeof import('node:fs');

/** The owner presses Update on the page (step 3c): the request it leaves in the till's data folder. */
function ownerAsks(pc: Pc, over: Record<string, unknown> = {}): void {
  pc.d.fs.writeFileSync('C:\\SRE-data\\till\\edge-data\\update-request.json', JSON.stringify({
    kind: 'sre-store-pc-update-request-v1', requestedAt: pc.d.now().toISOString(), requestedBy: 'owner-01', version: NEW, tag: releaseTag(NEW), commit: COMMIT, sha256: sha256Of(SETUP_BYTES), from: OLD, ...over,
  }));
}
const said = (pc: Pc): string => pc.w.said.join('\n');
const progress = (pc: Pc): Record<string, unknown> => JSON.parse(pc.d.fs.readFileSync(`C:\\SRE-data\\status\\${PROGRESS_FILE}`, 'utf8'));
const outcomes = (pc: Pc): Record<string, unknown>[] => pc.d.fs.readFileSync(`C:\\SRE-data\\updates\\${OUTCOME_LOG}`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const updateFolder = (pc: Pc): string => `C:\\SRE-data\\updates\\${pc.d.fs.readdirSync('C:\\SRE-data\\updates').find((f) => f !== OUTCOME_LOG)!}`;
const installArgs = (pc: Pc): string => /<Arguments>(.*)<\/Arguments>/.exec(pc.w.tasks.registered.get(INSTALL_TASK)!)![1]!;

/** The first half (the 5-minute task), then — as Windows would — the install task, run from the kept copy. */
async function bothHalves(pc: Pc): Promise<{ first: number; second: number }> {
  const first = await main(['apply-update'], pc.d);
  if (!pc.w.tasks.ran.includes(INSTALL_TASK)) return { first, second: -1 };
  const W = /--install '([^']+)'/.exec(installArgs(pc))![1]!;
  const second = await main(['apply-update', '--install', W], { ...pc.d, repoRoot: KEPT });
  return { first, second };
}

describe('setup sets up the updater — a task that only acts on the owner\'s request', () => {
  it('"SRE\\Software update": as Windows itself (SYSTEM), every 5 minutes, through the launcher; the page is told it is set up', async () => {
    const pc = await installedPc();
    const xml = pc.w.tasks.registered.get(UPDATER_TASK)!;
    expect(xml).toContain(`<UserId>${SYSTEM_SID}</UserId>`);
    expect(xml).toContain('<RunLevel>HighestAvailable</RunLevel>');
    expect(xml).toContain(`<Interval>PT${UPDATER_EVERY_MINUTES}M</Interval>`);
    expect(xml).toMatch(/launch\.mjs' apply-update; exit/);
    expect(xml).not.toMatch(/InteractiveToken|Password/);
    const s = settingsIn(pc.d.fs);
    for (const secret of [s['POSTGRES_PASSWORD'], s['PACK_SIGNING_KEY']]) expect(xml).not.toContain(secret!);
    expect(JSON.parse(pc.d.fs.readFileSync(`C:\\SRE-data\\status\\${UPDATER_MARK}`, 'utf8'))).toMatchObject({ task: UPDATER_TASK, everyMinutes: 5 });
  });

  it('with no request it does nothing at all: nothing asked of GitHub, nothing backed up, nothing stopped', async () => {
    const pc = await installedPc();
    expect(await main(['apply-update'], pc.d)).toBe(0);
    expect(said(pc)).toBe('Nothing to do — no update was asked for.');
    expect(pc.how.downloads).toEqual([]);
    expect(pc.how.ran).toEqual([]);
    expect(pc.d.fs.existsSync('C:\\SRE-data\\updates')).toBe(false);
  });

  it('a task that runs as SYSTEM with no schedule (the install) carries no trigger', () => {
    const xml = systemTaskXml({ description: 'x', command: 'c', args: 'a', workingDir: 'w', timeLimit: 'PT3H' });
    expect(xml).not.toContain('<Triggers>');
    expect(xml).toContain(`<UserId>${SYSTEM_SID}</UserId>`);
  });
});

describe('the owner asked: the whole update, every step written down', () => {
  it('UPDATED — taken, no shift open, signed and checked, backed up, old version kept, installed from the kept copy, checked', async () => {
    const pc = await installedPc();
    const dbBefore = pc.d.fs.readFileSync('C:\\SRE-data\\database\\PG_VERSION', 'utf8');
    ownerAsks(pc);
    const { first, second } = await bothHalves(pc);
    expect(first).toBe(0);
    expect(second).toBe(0);
    const out = said(pc);
    // 1 — taken: gone from the till's folder, kept in the update's own folder (never deleted).
    expect(pc.d.fs.existsSync('C:\\SRE-data\\till\\edge-data\\update-request.json')).toBe(false);
    expect(JSON.parse(pc.d.fs.readFileSync(`${updateFolder(pc)}\\request.json`, 'utf8'))).toMatchObject({ requestedBy: 'owner-01', version: NEW });
    // 3 — the release checked against THIS PC's key; 4 — an encrypted backup on the drive, before anything changed.
    expect(out).toMatch(/^CHECKED — version 1\.0\.2012 is signed, its signature verifies with this PC's release key, and the downloaded file is the signed one\.$/m);
    expect(out).toMatch(/^BACKUP DONE — sre-real-backup-/m);
    expect(pc.d.fs.readdirSync('G:\\sre-real').filter((f) => f.endsWith('.manifest.json')).length).toBeGreaterThanOrEqual(2);
    // 5 — the running version kept whole beside the program.
    expect(JSON.parse(pc.d.fs.readFileSync(`${KEPT}\\release.json`, 'utf8')).version).toBe(OLD);
    // 6 — the install half runs from the KEPT copy's own node, as SYSTEM, so SRE-Setup.exe cannot stop it.
    expect(installArgs(pc)).toContain(`'${KEPT}\\runtime\\node\\node.exe' '${KEPT}\\scripts\\store-computer.mjs' apply-update --install`);
    expect(pc.w.tasks.registered.get(INSTALL_TASK)).toContain(`<UserId>${SYSTEM_SID}</UserId>`);
    // 7 — the setup program silently; 8 — the checks by the NEW program; then the page's check asked again.
    expect(pc.how.ran.map((r) => r[0])).toEqual(['robocopy', 'SRE-Setup.exe', `node(${NEW})`, `node(${NEW})`]);
    expect(pc.how.ran[1]).toEqual(expect.arrayContaining(['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']));
    expect(pc.how.ran.slice(2).map((r) => r[1])).toEqual(['services-status', 'check-update']);
    expect(out).toMatch(/^UPDATED — this PC now runs version 1\.0\.2012\. Every check passed\./m);
    expect(progress(pc)).toMatchObject({ kind: 'sre-store-pc-update-progress-v1', state: 'updated', version: NEW, from: OLD, requestedBy: 'owner-01' });
    expect(outcomes(pc).map((o) => `${o['step']}: ${o['outcome']}`)).toEqual([
      'request: taken', 'shifts: none open', 'download: signed and checked', 'backup: done', 'keep: running version kept', 'handed-over: install started',
      'install: started', 'install: setup done', 'checks: passed',
    ]);
    // The shop's data is never touched by the updater.
    expect(pc.d.fs.readFileSync('C:\\SRE-data\\database\\PG_VERSION', 'utf8')).toBe(dbBefore);
  });

  it('a second update later APPENDS to the same log — nothing is rewritten', async () => {
    const pc = await installedPc();
    ownerAsks(pc, { requestedAt: '2000-01-01T00:00:00.000Z' });
    expect(await main(['apply-update'], pc.d)).toBe(2);
    const first = outcomes(pc).length;
    ownerAsks(pc);
    await bothHalves(pc);
    const all = outcomes(pc);
    expect(all.length).toBeGreaterThan(first);
    expect(all.slice(0, first).map((o) => o['outcome'])).toEqual(['taken', expect.stringMatching(/^refused: the request was made at 2000-01-01/)]);
  });
});

describe('refused, nothing changed — and the refusal written down and shown on the page', () => {
  const refusedWith = async (prepare: (pc: Pc) => void | Promise<void>, why: RegExp, opts: { downloaded?: boolean } = {}): Promise<Pc> => {
    const pc = await installedPc();
    await prepare(pc);
    const code = await main(['apply-update'], pc.d);
    expect(code).toBe(2);
    expect(said(pc)).toMatch(why);
    expect(said(pc)).toMatch(/Nothing was changed\.$/m);
    expect(progress(pc)).toMatchObject({ state: 'refused' });
    expect(outcomes(pc).at(-1)!['outcome']).toMatch(/^refused: /);
    // Nothing backed up, nothing kept, nothing installed; the request is kept (taken, never deleted).
    expect(pc.how.ran).toEqual([]);
    expect(pc.w.tasks.registered.has(INSTALL_TASK)).toBe(false);
    expect(pc.d.fs.existsSync(`${updateFolder(pc)}\\request.json`)).toBe(true);
    if (opts.downloaded === false) expect(pc.how.downloads).toEqual([]);
    return pc;
  };

  it('OB-718: a till shift is open', async () => {
    await refusedWith((pc) => { ownerAsks(pc); pc.how.open = ['lane-2']; }, /^NOT STARTED — a till shift is open \(lane-2\) — close every till first, then press Update again\./m, { downloaded: false });
  });
  it('OB-718: the till does not answer — "not known to be closed" is never "closed"', async () => {
    await refusedWith((pc) => { ownerAsks(pc); pc.how.open = 'silent'; }, /the till did not answer, so it is not known that every till shift is closed/, { downloaded: false });
  });
  it('a request older than an hour', async () => {
    await refusedWith((pc) => ownerAsks(pc, { requestedAt: new Date(pc.d.now().getTime() - REQUEST_MAX_AGE_MS - 60_000).toISOString() }), /more than 60 minutes ago — press Update again/, { downloaded: false });
  });
  it('a request for a version that is not newer', async () => {
    await refusedWith((pc) => ownerAsks(pc, { version: OLD, tag: releaseTag(OLD) }), /version 1\.0\.2005 is not newer than the running 1\.0\.2005/, { downloaded: false });
  });
  it('a release that is NOT SIGNED', async () => {
    await refusedWith((pc) => { ownerAsks(pc); pc.how.record = { ...pc.how.record, signature: null }; }, /version 1\.0\.2012 is NOT SIGNED/);
  });
  it('a request is a wish, not authority: a release signed with ANOTHER key is never installed', async () => {
    await refusedWith((pc) => {
      ownerAsks(pc);
      const f = { version: NEW, commit: COMMIT, sha256: sha256Of(SETUP_BYTES) };
      pc.how.record = updateRecord({ ...f, signature: signUpdate(f, OTHER_KEY.priv) }) as unknown as Record<string, unknown>;
    }, /the signature on version 1\.0\.2012 does not verify with this PC's release public key/);
  });
  it('a downloaded file that is not the signed one', async () => {
    await refusedWith((pc) => { ownerAsks(pc); pc.how.served = Buffer.from('something else'); }, /is not the file that was signed/);
  });
  it('a release that is not the one the owner was shown on the page', async () => {
    await refusedWith((pc) => ownerAsks(pc, { sha256: 'f'.repeat(64) }), /the release on GitHub is not the one the owner was shown/);
  });
  it('no backup drive set up: no backup, no update', async () => {
    await refusedWith(async (pc) => { ownerAsks(pc); expect(await main(['unschedule-backup'], pc.d)).toBe(0); pc.w.said.length = 0; }, /the automatic backup is not set up/);
  });
});

describe('the install half checks once more before anything stops', () => {
  it('a till shift opened in the meantime: refused, the setup program never runs', async () => {
    const pc = await installedPc();
    ownerAsks(pc);
    expect(await main(['apply-update'], pc.d)).toBe(0);
    pc.how.open = ['lane-1'];
    const W = /--install '([^']+)'/.exec(installArgs(pc))![1]!;
    expect(await main(['apply-update', '--install', W], { ...pc.d, repoRoot: KEPT })).toBe(2);
    expect(pc.how.ran.some((r) => r[0] === 'SRE-Setup.exe')).toBe(false);
    expect(progress(pc)).toMatchObject({ state: 'refused' });
    expect(said(pc)).toMatch(/NOT STARTED — a till shift was opened \(lane-1\)\. Nothing was changed\./);
  });

  it('the downloaded setup program changed on disk after it was checked: refused', async () => {
    const pc = await installedPc();
    ownerAsks(pc);
    expect(await main(['apply-update'], pc.d)).toBe(0);
    const W = /--install '([^']+)'/.exec(installArgs(pc))![1]!;
    pc.d.fs.writeFileSync(`${W}\\SRE-Setup.exe`, 'swapped');
    expect(await main(['apply-update', '--install', W], { ...pc.d, repoRoot: KEPT })).toBe(2);
    expect(pc.how.ran.some((r) => r[0] === 'SRE-Setup.exe')).toBe(false);
  });
});

describe('any failure: the old version is put back BY ITSELF, and checked', () => {
  it('the new setup did not finish: PUT BACK — services stopped, the kept copy mirrored back exactly, its own setup, checks', async () => {
    const pc = await installedPc();
    ownerAsks(pc);
    pc.how.setupStatus = 13;
    const { second } = await bothHalves(pc);
    expect(second).toBe(1);
    const out = said(pc);
    expect(out).toMatch(/^NOT UPDATED — the new version's setup did not finish/m);
    expect(out).toMatch(/^PUTTING VERSION 1\.0\.2005 BACK, by itself\. The shop's data is not touched\.$/m);
    expect(out).toMatch(/^PUT BACK — version 1\.0\.2005 runs again, and every check passed\./m);
    expect(pc.how.ran.map((r) => r[0] === 'robocopy' ? `robocopy ${r[1]} → ${r[2]}` : `${r[0]} ${r[1]}`)).toEqual([
      `robocopy C:\\SRE → ${KEPT}`, 'SRE-Setup.exe /VERYSILENT', `robocopy ${KEPT} → C:\\SRE`, `node(${OLD}) setup`, `node(${OLD}) services-status`,
    ]);
    expect(JSON.parse(pc.d.fs.readFileSync('C:\\SRE\\release.json', 'utf8')).version).toBe(OLD);
    expect(progress(pc)).toMatchObject({ state: 'rolled-back', version: NEW, from: OLD });
    expect(outcomes(pc).slice(-3).map((o) => `${o['step']}: ${o['outcome']}`)).toEqual([
      expect.stringMatching(/^install: failed: the new version's setup did not finish/), 'rollback: program put back', 'rollback: put back and checked',
    ]);
  });

  it('the new version installed but its checks failed: PUT BACK — and the new version\'s own files are gone from the program', async () => {
    const pc = await installedPc();
    const dbBefore = pc.d.fs.readFileSync('C:\\SRE-data\\database\\PG_VERSION', 'utf8');
    ownerAsks(pc);
    pc.how.newStatusOk = false;
    const { second } = await bothHalves(pc);
    expect(second).toBe(1);
    expect(said(pc)).toMatch(/NOT UPDATED — the store computer's check \(services-status\) did not pass: FIX {6}SRE Retail OS - office API \(SRE-API\): stopped/);
    expect(pc.d.fs.existsSync('C:\\SRE\\new-only.txt')).toBe(false);
    expect(JSON.parse(pc.d.fs.readFileSync('C:\\SRE\\release.json', 'utf8')).version).toBe(OLD);
    expect(progress(pc)).toMatchObject({ state: 'rolled-back' });
    // The program is put back; the shop's data is not (append-only — the old version runs on the same database).
    expect(pc.d.fs.readFileSync('C:\\SRE-data\\database\\PG_VERSION', 'utf8')).toBe(dbBefore);
    expect(outcomes(pc).find((o) => String(o['outcome']).startsWith('failed:'))!['databaseSteps']).toBeUndefined();
  });

  it('the old version could NOT be put back: said in plain words, RED on the page, a person needed — the backup named', async () => {
    const pc = await installedPc();
    ownerAsks(pc);
    pc.how.setupStatus = 13;
    pc.how.oldSetupOk = false;
    const { second } = await bothHalves(pc);
    expect(second).toBe(1);
    const out = said(pc);
    expect(out).toMatch(/^NOT PUT BACK — version 1\.0\.2005's own setup did not finish/m);
    expect(out).toMatch(/A PERSON IS NEEDED NOW\./);
    const p = progress(pc);
    expect(p).toMatchObject({ state: 'rollback-failed' });
    expect(String(p['said'])).toMatch(/Call for help now; the backup taken first is sre-real-backup-/);
  });
});

describe('the request, checked before anything else (pure)', () => {
  const now = new Date('2026-11-12T05:00:00.000Z');
  const good = { kind: 'sre-store-pc-update-request-v1', requestedAt: '2026-11-12T04:59:00.000Z', requestedBy: 'owner-01', version: NEW, tag: releaseTag(NEW), commit: COMMIT, sha256: 'b'.repeat(64) };
  it.each([
    ['not a request', { ...good, kind: 'something' }, /not one this PC understands/],
    ['no fingerprint', { ...good, sha256: 'x' }, /does not name a version, its commit and its fingerprint/],
    ['nobody named', { ...good, requestedBy: '' }, /does not say who made it/],
    ['the wrong release tag', { ...good, tag: 'store-pc-v1.0.1' }, /names the release store-pc-v1\.0\.1/],
    ['dated in the future', { ...good, requestedAt: '2026-11-12T06:00:00.000Z' }, /dated in the future/],
  ])('%s', (_n, r, why) => {
    const c = checkRequest(r, OLD, now);
    expect('refuse' in c ? c.refuse : '').toMatch(why);
  });
  it('a good one passes', () => { expect(checkRequest(good, OLD, now)).toEqual({ request: good }); });
});
