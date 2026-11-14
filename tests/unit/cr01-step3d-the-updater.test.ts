import { describe, it, expect } from 'vitest';
import { main } from '../../scripts/lib/store-computer.mjs';
import {
  INSTALL_TASK, OUTCOME_LOG, PROGRESS_FILE, REQUEST_MAX_AGE_MS, SYSTEM_SID, UPDATER_EVERY_MINUTES, UPDATER_MARK, UPDATER_TASK, checkRequest, systemTaskXml,
} from '../../scripts/lib/store-pc-updater.mjs';
import { releaseTag, sha256Of, signUpdate, updateRecord } from '../../scripts/lib/store-pc-update.mjs';
import { settingsIn } from '../support/store-pc-windows';
import { COMMIT, KEPT, NEW, OLD, OTHER_KEY, SETUP_BYTES, installedPc, type Pc } from '../support/store-pc-installed';

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
