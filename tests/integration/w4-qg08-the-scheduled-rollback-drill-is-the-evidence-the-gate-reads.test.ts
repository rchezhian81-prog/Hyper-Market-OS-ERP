import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { runRollbackDrill, rehearsalBodyOf, type DrillSteps } from '../../scripts/lib/rollback-drill.mjs';

/**
 * W4 · QG-08 (roadmap §22 "Backup restore, store recovery, rollback and incident escalation rehearsed"; §32; pilot gate G9).
 * The timed rollback drill runs END TO END with --run against the composed stack in a scheduled workflow
 * (.github/workflows/rollback-drill.yml), and its result is the evidence the QG-08 gate reads:
 *
 *   • the workflow is wired: weekly and on demand (never on a pull request), main only, the stack put live on the current
 *     commit by release.sh, the drill run with --run between the current commit and the one before it, the databases in
 *     the environment only, an EMPTY restore target, no secret used, the record and the evidence kept;
 *   • the drill's record becomes the body of POST /v1/platform/dr-drills for the rollback rehearsal — and head office,
 *     given that body, scores it against the fixed 30-minute target and the QG-08 reading reads the rollback as passed; an
 *     over-target drill is recorded and read as a MISS; a drill that never got the previous release back is no record.
 *
 * Synthetic stand-ins for the drill's steps (nothing here touches a stack); the register is head office's own, in memory and
 * on real PostgreSQL. What only the box can show — the drill on the real store PC — stays EXTERNAL (EX-09).
 */

const WF = readFileSync('.github/workflows/rollback-drill.yml', 'utf8');
const PREV = 'a'.repeat(40);
const CURR = 'b'.repeat(40);
const MIN = 60_000;

function steps(rollbackMinutes: number, ok = true): { steps: DrillSteps; now: () => number } {
  let t = Date.parse('2026-11-01T22:13:00.000Z');
  const deploys = [rollbackMinutes, 4];
  return {
    now: () => t,
    steps: {
      recovery: async () => { t += 12 * MIN; return { outcome: 'restored_and_reconciled', backupId: 'bk-syn-1', timingsMs: { total: 12 * MIN } }; },
      deploy: async () => { t += (deploys.shift() ?? 4) * MIN; return { ok, code: ok ? 0 : 70 }; },
      ready: async () => true,
    },
  };
}

describe('QG-08 · the scheduled rollback drill is wired, and its result is what the gate reads', () => {
  it('the workflow: weekly and by hand only, on main, release.sh puts the current commit live, then the drill runs with --run', () => {
    const on = /^on:\n([\s\S]*?)\n\S/m.exec(WF)?.[1] ?? '';
    expect(on).toMatch(/^ {2}schedule:\n(?: {4}#[^\n]*\n)* {4}- cron: '\d+ \d+ \* \* [0-6]'/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on).not.toMatch(/pull_request|push:/);
    expect(WF).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(WF).toContain('fetch-depth: 0');
    expect(WF).toContain('PREVIOUS=$(git rev-parse HEAD^1)');
    const live = WF.indexOf('bash infra/deploy/release.sh "$DRILL_CURRENT"');
    const drill = WF.indexOf('node scripts/rollback-drill.mjs --previous "$DRILL_PREVIOUS" --current "$DRILL_CURRENT" --project sre-drill');
    expect(live).toBeGreaterThan(0);
    expect(drill).toBeGreaterThan(live);
    expect(WF.slice(drill, WF.indexOf('\n\n', drill))).toMatch(/--run\s*$/);
    expect(WF).toContain('SRE_DEPLOY_CONF: ${{ runner.temp }}/sre/deploy.conf');
    expect(WF).toMatch(/timeout-minutes: \d+/);
  });

  it('the databases: the stack\'s own in the environment only, the restore into a separate EMPTY database; no secret, nothing committed', () => {
    expect(WF).toContain('RESTORE_TARGET_URL: postgres://sre@127.0.0.1:5433/sre_restore_target');
    expect(WF).toMatch(/restore-target:\n\s+image: postgres:16/);
    expect(WF).toContain('export DATABASE_URL=$(printf');
    expect(WF).not.toMatch(/--(database|target)[- ]url/i);
    expect(WF).not.toMatch(/secrets\./);
    expect(WF).toContain('echo "::add-mask::$PW"');
    expect(WF).toContain('echo "MIGRATION_TARGET_KIND=rehearsal"');
    expect(WF).toContain('openssl rand -hex 24'); // URL-safe, as the deploy job's
    expect(WF).toMatch(/Tear down\n\s+if: always\(\)[\s\S]*down -v --remove-orphans[\s\S]*rm -f \.env/);
  });

  it('the evidence is kept and shown: the drill record and the rollback rehearsal body, uploaded by a pinned action', () => {
    expect(WF).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    expect(WF).toContain('name: qg08-rollback-drill');
    expect(WF).toContain('${{ runner.temp }}/drill/');
    expect(WF).toContain('.qg08-rollback.json');
    expect(WF).toContain('POST /v1/platform/dr-drills');
    expect(readFileSync('scripts/rollback-drill.mjs', 'utf8')).toContain('rehearsalBodyOf(record)');
  });

  it('a drill inside its targets → a rollback rehearsal body; the drill shell writes it next to the record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-w4-drill-'));
    const { steps: s, now } = steps(9);
    const record = await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-drill', steps: s, now, workDir: dir, drillId: 'rollback-drill-w4-1' });
    expect(record.outcome).toBe('passed');
    const ev = rehearsalBodyOf(record);
    expect(ev).toEqual({ recordable: true, body: { drillId: 'rollback-drill-w4-1', rehearsal: 'rollback', dataLossSeconds: 0, recoverySeconds: 540 }, words: expect.stringMatching(/9\.0 min \(target 30 min\)/) });
    expect(readdirSync(dir)).toEqual(['rollback-drill-w4-1.json']);
  });

  it('a refused drill, or one whose previous release never came back, is NOT a rehearsal record — a person records the miss', async () => {
    const refused = await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'production', project: 'sre-drill', ...steps(5) });
    expect(rehearsalBodyOf(refused)).toEqual({ recordable: false, why: expect.stringMatching(/ended refused[\s\S]*QG-08 stays HOLD/) });
    const failed = await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-drill', ...steps(5, false) });
    expect(failed.outcome).toBe('failed');
    expect(rehearsalBodyOf(failed).recordable).toBe(false);
  });
});

const backings = useRestartableBackings();
const OWNER = 'u-owner';
type Reading = { verdict: string; rehearsals: { kind: string; state: string; drillId?: string; detail: string }[] };

describe.each(backings)('QG-08 · head office reads the scheduled drill\'s evidence — on $name', ({ harness }) => {
  it('the body recorded on the register: the rollback reads passed against 30 minutes; an over-target drill reads FAILED, never a pass', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
      h.request({ method, path, userId: OWNER, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${randomUUID()}` }) });
    const rollbackOf = async () => ((await call('GET', '/v1/platform/recovery-gate')).body as Reading).rehearsals.find((r) => r.kind === 'rollback')!;
    expect((await rollbackOf()).state).toBe('missing');

    const inside = rehearsalBodyOf(await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-drill', drillId: 'rollback-drill-w4-in', ...steps(9) }));
    if (!inside.recordable) throw new Error(inside.why);
    expect((await call('POST', '/v1/platform/dr-drills', inside.body)).status).toBe(201);
    expect(await rollbackOf()).toMatchObject({ state: 'passed', drillId: 'rollback-drill-w4-in' });

    // The next week's drill took 41 minutes to put the previous release back: recorded, scored a MISS, and the gate holds.
    const over = await runRollbackDrill({ previous: PREV, current: CURR, targetKind: 'rehearsal', project: 'sre-drill', drillId: 'rollback-drill-w4-over', ...steps(41) });
    expect(over.outcome).toBe('over_target');
    const late = rehearsalBodyOf(over);
    if (!late.recordable) throw new Error(late.why);
    expect(late.body.recoverySeconds).toBe(41 * 60);
    expect((await call('POST', '/v1/platform/dr-drills', late.body)).status).toBe(201);
    expect(await rollbackOf()).toMatchObject({ state: 'failed', drillId: 'rollback-drill-w4-over' });
    const reading = (await call('GET', '/v1/platform/recovery-gate')).body as Reading;
    expect(reading.verdict).toBe('HOLD');
  }, 120_000);
});
