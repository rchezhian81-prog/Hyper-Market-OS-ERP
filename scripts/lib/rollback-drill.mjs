// The timed rollback drill (pilot gate G9 · QG-08 "backup restore, store recovery, rollback … rehearsed" · MG-11 ·
// roadmap §32 recovery targets). The logic, with every step injected so it is tested on synthetic stand-ins; the
// shell (`scripts/rollback-drill.mjs`) wires the real steps on the box.
//
// G9 asks for one thing the repository did not have: a SCRIPTED, TIMED rehearsal that the previous release can be put
// back and the data restored, under a simulated failure — with the times printed. The pieces existed separately
// (`infra/deploy/release.sh` deploys a commit and rolls back on failure; `scripts/lib/recovery-rehearsal.mjs` backs up,
// copies off-site, restores into an EMPTY database and reconciles). This runs them as one drill, in this order:
//
//   1. RECOVERY — back up the live database, copy it to the owner's backup drive, restore that copy into an EMPTY,
//      separate database and reconcile rows and money to the paisa. (Nothing is restored over the live database.)
//   2. ROLLBACK — the simulated failure: put the PREVIOUS release back (release.sh <previous>), and wait for READY.
//   3. ROLL FORWARD — put the CURRENT release back (release.sh <current>), and wait for READY.
//
// It refuses before touching anything: a production target (hard rule #7), a commit that is not 40 hex characters,
// the same commit twice (that rehearses nothing), and no compose project named. It stops at the first failed step;
// if the previous release came up but the box then cannot be put forward again, it says a person is needed now.
// The times are measured against the roadmap's own targets (§32): the service back within 30 minutes; the database
// restored within 4 hours. Over a target is not a pass. Nothing is ever deleted (hard rule #6): each drill writes a
// NEW record file.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Roadmap §32: store-edge service RTO ≤ 30 min; database RTO ≤ 4 h. */
export const DRILL_TARGETS = Object.freeze({ rollbackMs: 30 * 60 * 1000, rollForwardMs: 30 * 60 * 1000, recoveryMs: 4 * 60 * 60 * 1000 });

const SHA = /^[0-9a-f]{40}$/;

/** Every reason the drill would refuse to start, all at once. Empty = it may start. */
export function drillProblems({ previous, current, targetKind, project }) {
  const problems = [];
  if ((targetKind ?? 'rehearsal').trim().toLowerCase() === 'production') problems.push('MIGRATION_TARGET_KIND is production — the drill never runs against production (hard rule #7)');
  if (!SHA.test(previous ?? '')) problems.push('--previous must be the 40-character commit of the release to go back to');
  if (!SHA.test(current ?? '')) problems.push('--current must be the 40-character commit that is live now');
  if (SHA.test(previous ?? '') && previous === current) problems.push('--previous and --current are the same commit — that rehearses nothing');
  if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) problems.push('--project must name the compose project this box runs (for example the store computer\'s own)');
  return problems;
}

const minutes = (ms) => `${(ms / 60000).toFixed(1)} min`;

/**
 * Run the drill. `steps.recovery()` → the recovery rehearsal's record ({ outcome, timingsMs }); `steps.deploy(sha)` →
 * { ok, code, detail }; `steps.ready()` → true when the API says READY. `now()` is the clock (injected for tests).
 */
export async function runRollbackDrill({ previous, current, targetKind, project, steps, now = Date.now, log = () => {}, workDir, drillId }) {
  const startedAt = new Date(now()).toISOString();
  const id = drillId ?? `rollback-drill-${startedAt.replace(/[:.]/g, '-')}`;
  const record = { drillId: id, startedAt, previous, current, project, targets: DRILL_TARGETS, steps: [], timingsMs: {}, outcome: 'refused', detail: '' };
  const finish = (outcome, detail) => {
    record.outcome = outcome;
    record.detail = detail;
    record.finishedAt = new Date(now()).toISOString();
    if (workDir !== undefined) {
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    }
    log(`  outcome  ${outcome.toUpperCase()} — ${detail}`);
    return record;
  };

  const problems = drillProblems({ previous, current, targetKind, project });
  if (problems.length > 0) {
    for (const p of problems) log(`  REFUSED — ${p}`);
    return finish('refused', problems.join('; '));
  }

  const timed = async (name, fn) => {
    const t0 = now();
    let result;
    try { result = await fn(); } catch (e) { result = { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
    const ms = now() - t0;
    record.steps.push({ name, ok: result.ok === true, ms, ...(result.detail === undefined ? {} : { detail: result.detail }) });
    log(`  ${result.ok === true ? 'done' : 'FAILED'}  ${name} — ${minutes(ms)}${result.detail === undefined ? '' : ` (${result.detail})`}`);
    return { ...result, ms };
  };
  const deployAndWait = async (sha) => {
    const d = await steps.deploy(sha);
    if (d.ok !== true) return { ok: false, detail: d.detail ?? `the release script ended ${d.code}` };
    const up = await steps.ready();
    return up === true ? { ok: true, detail: `release ${sha.slice(0, 12)} is up and READY` } : { ok: false, detail: `release ${sha.slice(0, 12)} did not become READY` };
  };

  log(`Rollback drill ${id} on project ${project}: back to ${previous.slice(0, 12)}, then forward to ${current.slice(0, 12)}.`);

  // 1. Recovery: backup → the owner's backup drive → restore into an EMPTY database → reconcile.
  const recovery = await timed('recovery: back up, copy to the backup drive, restore into an empty database, reconcile', async () => {
    const r = await steps.recovery();
    return r.outcome === 'restored_and_reconciled'
      ? { ok: true, detail: `restored and reconciled (backup ${r.backupId ?? '?'})`, sub: r.timingsMs }
      : { ok: false, detail: r.detail ?? r.outcome };
  });
  record.timingsMs.recovery = recovery.ms;
  if (recovery.sub !== undefined) record.timingsMs.recoveryParts = recovery.sub;
  if (!recovery.ok) return finish('failed', 'the backup did not restore and reconcile — do not rely on it; nothing else was touched');

  // 2. The simulated failure: the previous release goes back on.
  const back = await timed(`rollback: put the previous release ${previous.slice(0, 12)} back and wait for READY`, () => deployAndWait(previous));
  record.timingsMs.rollback = back.ms;
  if (!back.ok) {
    // release.sh, failing to bring the previous release up, puts the live one back itself (exit 70) — the box is still on
    // the current release. Anything else needs a person.
    return finish('failed', 'the previous release could not be put back — the box stays on the release that was live; read the release log before trying again');
  }

  // 3. Forward again to the release that was live.
  const forward = await timed(`roll forward: put the current release ${current.slice(0, 12)} back and wait for READY`, () => deployAndWait(current));
  record.timingsMs.rollForward = forward.ms;
  record.timingsMs.total = recovery.ms + back.ms + forward.ms;
  if (!forward.ok) return finish('failed', `the box is on the PREVIOUS release ${previous.slice(0, 12)} and could not be put forward — a person is needed on the box now (docs/runbooks/automatic-deployment.md, "When it goes red")`);

  const over = [
    back.ms > DRILL_TARGETS.rollbackMs ? `rollback took ${minutes(back.ms)}, over the 30-minute target` : '',
    forward.ms > DRILL_TARGETS.rollForwardMs ? `roll forward took ${minutes(forward.ms)}, over the 30-minute target` : '',
    recovery.ms > DRILL_TARGETS.recoveryMs ? `recovery took ${minutes(recovery.ms)}, over the 4-hour target` : '',
  ].filter((s) => s !== '');
  record.withinTargets = over.length === 0;
  log(`  times    recovery ${minutes(recovery.ms)} (target 240 min) · rollback ${minutes(back.ms)} (target 30 min) · roll forward ${minutes(forward.ms)} (target 30 min) · total ${minutes(record.timingsMs.total)}`);
  if (over.length > 0) return finish('over_target', `${over.join('; ')} — every step worked, but G9 is not passed until it is inside the targets`);
  return finish('passed', 'the previous release went back on, the backup restored and reconciled, and the current release came back — all inside the targets');
}
