import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runRollbackDrill, drillProblems, DRILL_TARGETS, type DrillSteps } from '../../scripts/lib/rollback-drill.mjs';

/**
 * Pilot gate G9 — the previous release is put back and the backup restored, under a simulated failure, TIMED against
 * the roadmap's §32 targets (service back in 30 minutes; database restored in 4 hours). The drill's logic on
 * synthetic stand-ins: nothing here touches a database, a release or a box.
 */

const PREV = 'a'.repeat(40);
const CURR = 'b'.repeat(40);
const MIN = 60_000;

/** A clock the steps move on: each step "takes" the minutes it is told. */
function clockAndSteps(plan: { recovery?: number; deploy?: number[]; ready?: boolean[]; recoveryOutcome?: string; deployOk?: boolean[] } = {}) {
  let t = Date.parse('2026-10-19T02:00:00.000Z');
  const calls: string[] = [];
  const deployMinutes = [...(plan.deploy ?? [6, 5])];
  const ready = [...(plan.ready ?? [true, true])];
  const deployOk = [...(plan.deployOk ?? [true, true])];
  const steps: DrillSteps = {
    recovery: async () => { calls.push('recovery'); t += (plan.recovery ?? 20) * MIN; return { outcome: plan.recoveryOutcome ?? 'restored_and_reconciled', backupId: 'bk-1', timingsMs: { backup: 1, offsiteCopyAndCheck: 1, restoreAndReconcile: 1, total: 3 } }; },
    deploy: async (sha) => { calls.push(`deploy ${sha.slice(0, 1)}`); t += (deployMinutes.shift() ?? 5) * MIN; const ok = deployOk.shift() ?? true; return { ok, code: ok ? 0 : 70 }; },
    ready: async () => { calls.push('ready'); return ready.shift() ?? true; },
  };
  return { now: () => t, steps, calls };
}

describe('the rollback drill (G9)', () => {
  it('refuses before touching anything: production, bad or equal commits, no project', async () => {
    expect(drillProblems({ previous: PREV, current: CURR, targetKind: 'production', project: 'sre-real' })).toEqual([expect.stringMatching(/never runs against production/)]);
    expect(drillProblems({ previous: PREV, current: PREV, targetKind: 'rehearsal', project: 'sre-real' })).toEqual([expect.stringMatching(/same commit/)]);
    expect(drillProblems({ previous: 'main', current: 'HEAD', targetKind: undefined, project: undefined })).toHaveLength(3);
    const { now, steps, calls } = clockAndSteps();
    const r = await runRollbackDrill({ previous: PREV, current: CURR, targetKind: ' Production ', project: 'sre-real', steps, now });
    expect(r.outcome).toBe('refused');
    expect(calls).toEqual([]);
  });

  it('a good drill: recovery, then back to the previous release, then forward — each timed, inside the targets, recorded once', async () => {
    const work = mkdtempSync(join(tmpdir(), 'drill-'));
    const lines: string[] = [];
    const { now, steps, calls } = clockAndSteps();
    const r = await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-real', steps, now, workDir: work, log: (l) => lines.push(l) });
    expect(calls).toEqual(['recovery', 'deploy a', 'ready', 'deploy b', 'ready']);
    expect(r.outcome).toBe('passed');
    expect(r.timingsMs).toMatchObject({ recovery: 20 * MIN, rollback: 6 * MIN, rollForward: 5 * MIN, total: 31 * MIN });
    expect(r.withinTargets).toBe(true);
    expect(lines.join('\n')).toMatch(/recovery 20\.0 min \(target 240 min\) · rollback 6\.0 min \(target 30 min\) · roll forward 5\.0 min/);
    const files = readdirSync(work);
    expect(files).toEqual([`${r.drillId}.json`]);
    expect(JSON.parse(readFileSync(join(work, files[0]!), 'utf8'))).toMatchObject({ outcome: 'passed', previous: PREV, current: CURR });
    // A record is never overwritten (hard rule #6).
    await expect(runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-real', steps: clockAndSteps().steps, now, workDir: work, drillId: r.drillId })).rejects.toThrow();
  });

  it('every step working but over a target is NOT a pass', async () => {
    const { now, steps } = clockAndSteps({ deploy: [31, 5] });
    const r = await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-real', steps, now });
    expect(r.outcome).toBe('over_target');
    expect(r.detail).toMatch(/rollback took 31\.0 min, over the 30-minute target/);
    expect(DRILL_TARGETS.recoveryMs).toBe(4 * 60 * MIN);
    const slow = clockAndSteps({ recovery: 241 });
    expect((await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-real', steps: slow.steps, now: slow.now })).detail).toMatch(/recovery took 241\.0 min, over the 4-hour target/);
  });

  it('a backup that does not restore stops the drill before any release is touched', async () => {
    const { now, steps, calls } = clockAndSteps({ recoveryOutcome: 'restore_not_accepted' });
    const r = await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-real', steps, now });
    expect(r.outcome).toBe('failed');
    expect(calls).toEqual(['recovery']);
  });

  it('the previous release failing to come up leaves the box on the live one; failing to come FORWARD calls a person', async () => {
    const a = clockAndSteps({ deployOk: [false] });
    const ra = await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-real', steps: a.steps, now: a.now });
    expect(ra.outcome).toBe('failed');
    expect(a.calls).toEqual(['recovery', 'deploy a']);
    expect(ra.detail).toMatch(/stays on the release that was live/);
    const b = clockAndSteps({ ready: [true, false] });
    const rb = await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-real', steps: b.steps, now: b.now });
    expect(rb.outcome).toBe('failed');
    expect(rb.detail).toMatch(/a person is needed on the box now/);
  });

  it('the shell refuses without its arguments and, without --run, only prints the plan', () => {
    const none = spawnSync('node', ['scripts/rollback-drill.mjs'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: '', RESTORE_TARGET_URL: '' } });
    expect(none.status).toBe(2);
    expect(none.stderr).toMatch(/REFUSED — --previous/);
    const dry = spawnSync('node', ['scripts/rollback-drill.mjs', '--previous', PREV, '--current', CURR, '--project', 'sre-real', '--work', '/nonexistent/drill', '--backup-drive', '/nonexistent/drive', '--settings', '/nonexistent/.env'], { encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/DRY RUN — nothing will change/);
    const noSecrets = spawnSync('node', ['scripts/rollback-drill.mjs', '--previous', PREV, '--current', CURR, '--project', 'sre-real', '--work', '/x', '--backup-drive', '/y', '--settings', '/nonexistent/.env', '--run'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    expect(noSecrets.status).toBe(2);
    expect(noSecrets.stderr).toMatch(/DATABASE_URL and RESTORE_TARGET_URL must be set in the environment/);
  });
});
