import { describe, it, expect } from 'vitest';
import { main } from '../../scripts/lib/store-computer.mjs';
import { INSTALL_TASK, KEPT_FOLDER } from '../../scripts/lib/store-pc-updater.mjs';
import { DRILL_TASK } from '../../scripts/lib/store-pc-drill.mjs';
import { releaseTag, sha256Of } from '../../scripts/lib/store-pc-update.mjs';
import { COMMIT, KEPT, NEW, OLD, SETUP_BYTES, installedPc, type Pc } from '../support/store-pc-installed';

/**
 * **CR-01 step 3e · OI-05 ("the rollback drill, G9, still passes") · OB-246 · OB-718 · roadmap §32: the timed rollback
 * drill on the store PC's Windows services.**
 *
 *   The same drill as the Docker one, in the same order and against the same targets: (1) an encrypted backup onto the
 *   backup drive; (2) restored into a NEW scratch database and reconciled; (3) the previous release's PROGRAM put back over
 *   the program folder, its own setup run, and checked by it — on the same database, which is never rolled back (its steps
 *   must not change); (4) always forward again, checked; (5) every time against its target, and a new dated record in the
 *   records folder and, read-only, on the drive. Steps 3–4 run as their own task (SYSTEM) from the kept copy of this
 *   release, because a program cannot replace the folder it runs from; `drill-result` says the outcome. The previous
 *   release is the newest kept copy (one is kept at every update) or a folder named with --previous. Refused while a till
 *   shift is open.
 *
 * Driven on a pretend Windows. NOTHING HERE IS REAL WINDOWS.
 */

const KEPT_NEW = `C:\\${KEPT_FOLDER}\\${NEW}`;
const said = (pc: Pc): string => pc.w.said.join('\n');
const DRILL = ['drill', '--by', 'The Owner', '--to', 'G:\\sre-real'];

/** The PC after the owner updated it from 1.0.2005 to 1.0.2012 on the Software update page (CR-01 step 3d). */
async function updatedPc(): Promise<Pc> {
  const pc = await installedPc();
  pc.d.fs.writeFileSync('C:\\SRE-data\\till\\edge-data\\update-request.json', JSON.stringify({
    kind: 'sre-store-pc-update-request-v1', requestedAt: pc.d.now().toISOString(), requestedBy: 'owner-01', version: NEW, tag: releaseTag(NEW), commit: COMMIT, sha256: sha256Of(SETUP_BYTES), from: OLD,
  }));
  expect(await main(['apply-update'], pc.d)).toBe(0);
  const W = /--install '([^']+)'/.exec(/<Arguments>(.*)<\/Arguments>/.exec(pc.w.tasks.registered.get(INSTALL_TASK)!)![1]!)![1]!;
  expect(await main(['apply-update', '--install', W], { ...pc.d, repoRoot: KEPT })).toBe(0);
  expect(JSON.parse(pc.d.fs.readFileSync('C:\\SRE\\release.json', 'utf8')).version).toBe(NEW);
  pc.w.said.length = 0;
  pc.how.ran.length = 0;
  return pc;
}

/** The first half at the keyboard; then — as Windows would — the drill task, from the kept copy of this release. */
async function runDrill(pc: Pc): Promise<{ first: number; second: number }> {
  const first = await main([...DRILL, '--run'], pc.d);
  if (!pc.w.tasks.ran.includes(DRILL_TASK)) return { first, second: -1 };
  const args = /<Arguments>(.*)<\/Arguments>/.exec(pc.w.tasks.registered.get(DRILL_TASK)!)![1]!;
  const W = /drill --continue '([^']+)'/.exec(args)![1]!;
  const second = await main(['drill', '--continue', W], { ...pc.d, repoRoot: KEPT_NEW });
  return { first, second };
}
const records = (pc: Pc, dir: string): string[] => pc.d.fs.readdirSync(dir).map(String).filter((f) => /^g9-drill-.*\.json$/.test(f));
const newestRecord = (pc: Pc): Record<string, unknown> => {
  const files = records(pc, 'C:\\SRE-data\\records').sort();
  return JSON.parse(pc.d.fs.readFileSync(`C:\\SRE-data\\records\\${files[files.length - 1]}`, 'utf8'));
};
const version = (pc: Pc): string => JSON.parse(pc.d.fs.readFileSync('C:\\SRE\\release.json', 'utf8')).version;

describe('the dry run says what will happen, and changes nothing', () => {
  it('the previous release is the newest kept one (1.0.2005, kept by the update); the database is not rolled back', async () => {
    const pc = await updatedPc();
    expect(await main(DRILL, pc.d)).toBe(0);
    const out = said(pc);
    expect(out).toMatch(/^DRY RUN — nothing will change\./m);
    expect(out).toContain(`3. put the previous release (${OLD}, from ${KEPT}) back over the program and run its own setup`);
    expect(out).toMatch(/which is NOT rolled back \(its 1 steps are this release's first 1; the 1 newer one\(s\) only add\)/);
    expect(out).toContain(`4. put this release (${NEW}) back the same way and check it again (target 30 minutes);`);
    expect(out).toMatch(/the till pauses for a few minutes\. Close every till first/);
    expect(pc.how.ran).toEqual([]);
    expect(pc.w.tasks.registered.has(DRILL_TASK)).toBe(false);
  });
});

describe('refused before anything changes', () => {
  it('no previous release on the PC yet (never updated): said, with where one comes from', async () => {
    const pc = await installedPc();
    expect(await main([...DRILL, '--run'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/^REFUSED — there is no previous release on this PC to go back to\. One is kept by itself at every update from the Software update page/m);
    expect(pc.how.ran).toEqual([]);
  });

  it('a --previous folder that is not an installed release', async () => {
    const pc = await updatedPc();
    pc.d.fs.mkdirSync('C:\\SRE-2026-11\\infra\\compose', { recursive: true });
    expect(await main([...DRILL, '--previous', 'C:\\SRE-2026-11', '--run'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/^REFUSED — C:\\SRE-2026-11 is not an installed release/m);
  });

  it('a till shift is open (OB-718: the services restart) — and a till that does not answer', async () => {
    const pc = await updatedPc();
    pc.how.open = ['lane-1'];
    expect(await main([...DRILL, '--run'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/^REFUSED — a till shift is open \(lane-1\)\. Close every till first\. Nothing was changed\.$/m);
    pc.how.open = 'silent';
    expect(await main([...DRILL, '--run'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/the till did not answer, so it is not known that every till shift is closed/);
    expect(pc.how.ran).toEqual([]);
  });

  it('the database has not got every step of this release', async () => {
    const pc = await updatedPc();
    pc.how.dbSteps = ['0001_first.sql'];
    expect(await main([...DRILL, '--run'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/^REFUSED — this copy's database has not got every step of this release yet/m);
  });
});

describe('the drill on Windows services: G9 PASSED', () => {
  it('backup, restore and reconcile, back to 1.0.2005, forward to 1.0.2012 — each timed, checked, and recorded', async () => {
    const pc = await updatedPc();
    const { first, second } = await runDrill(pc);
    expect(first).toBe(0);
    expect(second).toBe(0);
    const out = said(pc);
    // Steps 1–2 at the keyboard (the passphrase opens the backup).
    expect(out).toMatch(/^ {2}done {2}backup onto the backup drive — /m);
    expect(out).toMatch(/^ {2}done {2}restore into a new scratch database and reconcile — .*restored_and_reconciled/m);
    expect(out).toMatch(/^STARTED — steps 3 and 4 run by themselves now, as the task "SRE\\Rollback drill"/m);
    // Steps 3–4 from the KEPT copy of this release, as SYSTEM, so the program folder can be replaced.
    expect(pc.w.tasks.registered.get(DRILL_TASK)).toContain('<UserId>S-1-5-18</UserId>');
    expect(pc.w.tasks.registered.get(DRILL_TASK)).toContain(`'${KEPT_NEW}\\runtime\\node\\node.exe' '${KEPT_NEW}\\scripts\\store-computer.mjs' drill --continue`);
    expect(pc.how.ran.map((r) => (r[0] === 'robocopy' ? `robocopy ${r[1]} → ${r[2]}` : `${r[0]} ${r[1]}`))).toEqual([
      `robocopy C:\\SRE → ${KEPT_NEW}`,
      `robocopy ${KEPT} → C:\\SRE`, `node(${OLD}) setup`, `node(${OLD}) services-status`,
      `robocopy ${KEPT_NEW} → C:\\SRE`, `node(${NEW}) setup`, `node(${NEW}) services-status`,
    ]);
    expect(out).toMatch(/^ {2}done {2}put the previous release back and check it — .*version 1\.0\.2005 runs on this copy's current database/m);
    expect(out).toMatch(/^ {2}done {2}put this release back and check it — /m);
    expect(out).toMatch(/^G9 PASSED — every step worked, each inside its target/m);
    // The shop ends on this release; the database was never rolled back.
    expect(version(pc)).toBe(NEW);
    expect(pc.how.dbSteps).toEqual(['0001_first.sql', '0002_new.sql']);
    // A new dated record, and a read-only copy on the drive.
    const rec = newestRecord(pc);
    expect(rec).toMatchObject({ kind: 'store-computer-rollback-drill', overall: 'G9 PASSED', by: 'The Owner', previousRelease: { version: OLD }, currentRelease: { version: NEW } });
    expect((rec['steps'] as { key: string }[]).map((s) => s.key)).toEqual(['backup', 'restore', 'rollback', 'rollForward']);
    expect(records(pc, 'G:\\sre-real')).toHaveLength(1);
    // drill-result says it in plain words.
    pc.w.said.length = 0;
    expect(await main(['drill-result'], pc.d)).toBe(0);
    expect(said(pc)).toMatch(/^G9 PASSED — the drill of .* by The Owner: back to 1\.0\.2005, then forward to 1\.0\.2012\.$/m);
  });

  it('while steps 3–4 still run, drill-result says so', async () => {
    const pc = await updatedPc();
    expect(await main([...DRILL, '--run'], pc.d)).toBe(0);
    pc.w.said.length = 0;
    expect(await main(['drill-result'], pc.d)).toBe(2);
    expect(said(pc)).toMatch(/^STILL RUNNING — the drill started .* has not finished yet\./m);
  });
});

describe('the drill on Windows services: G9 NOT PASSED, said plainly — and the shop still ends on this release', () => {
  it('the previous release does not come up: step 3 FAILED, step 4 still runs, the PC ends on 1.0.2012', async () => {
    const pc = await updatedPc();
    pc.how.oldSetupOk = false;
    const { second } = await runDrill(pc);
    expect(second).toBe(1);
    const out = said(pc);
    expect(out).toMatch(/^ {2}FAILED {2}put the previous release back and check it — .*version 1\.0\.2005's own setup did not finish/m);
    expect(out).toMatch(/^ {2}done {2}put this release back and check it/m);
    expect(out).toMatch(/^G9 NOT PASSED — 1 step\(s\) did not work/m);
    expect(version(pc)).toBe(NEW);
    expect(newestRecord(pc)).toMatchObject({ overall: 'G9 NOT PASSED' });
  });

  it('this release does not come back: a person is needed, said plainly', async () => {
    const pc = await updatedPc();
    pc.how.newSetupOk = false;
    const { second } = await runDrill(pc);
    expect(second).toBe(1);
    expect(said(pc)).toMatch(/THIS PC MAY NOT BE ON 1\.0\.2012 NOW\. A PERSON IS NEEDED/);
  });

  it('a till shift opened before steps 3–4: they do not run, nothing is changed, NOT PASSED', async () => {
    const pc = await updatedPc();
    expect(await main([...DRILL, '--run'], pc.d)).toBe(0);
    pc.how.open = ['lane-2'];
    const args = /<Arguments>(.*)<\/Arguments>/.exec(pc.w.tasks.registered.get(DRILL_TASK)!)![1]!;
    const W = /drill --continue '([^']+)'/.exec(args)![1]!;
    pc.how.ran.length = 0;
    expect(await main(['drill', '--continue', W], { ...pc.d, repoRoot: KEPT_NEW })).toBe(1);
    expect(said(pc)).toMatch(/NOT DONE — a till shift was opened \(lane-2\)\. Steps 3 and 4 did not run; nothing was changed\./);
    expect(pc.how.ran).toEqual([]);
    expect(newestRecord(pc)).toMatchObject({ overall: 'G9 NOT PASSED' });
  });
});
