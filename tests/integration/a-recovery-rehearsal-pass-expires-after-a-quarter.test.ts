import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { drReadinessAdapter } from '../../services/api/src/adapters';
import { REHEARSAL_KINDS, REHEARSAL_TARGETS, scoreDrill } from '../../packages/ops/src/index';

// OB-332 (owner, 23 Oct 2026) · QG-08 (§22): a rehearsal PASS counts for one quarter. Four rehearsals that passed four months
// ago read "not proven" today, so the QG-08 reading is HOLD and the gate register refuses a GO over it; rehearsed again
// this quarter, the reading is GO and the owner may decide GO. Head office's own clock decides, read at the request. In
// memory and on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const OWNER = 'u-owner';
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
type Rec = { verdict: string; why: string; rehearsals: { kind: string; state: string; passExpiresAt?: string; detail: string }[] };

describe.each(backings)('a QG-08 rehearsal pass expires after one quarter (OB-332) — on $name', ({ harness }) => {
  it('passes from four months ago read not proven and hold the gate; rehearsed again they read GO; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (hh: typeof h, method: 'GET' | 'POST', path: string, user: string, body?: unknown) =>
      hh.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${randomUUID()}` }) });
    // Four rehearsals that passed 120 days ago, on the register as the drills route records them.
    const longAgo = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const drills = drReadinessAdapter({ store: h.store, now: () => longAgo });
    for (const kind of REHEARSAL_KINDS) {
      const target = REHEARSAL_TARGETS[kind];
      await drills.recordDrill(T, { drillId: `old-${kind}`, rehearsal: kind, result: scoreDrill({ target, dataLossSeconds: 0, recoverySeconds: 1 }), drilledBy: OWNER, drilledAt: longAgo });
    }
    const reading = async (hh: typeof h = h): Promise<Rec> => (await call(hh, 'GET', '/v1/platform/recovery-gate', OWNER)).body as Rec;
    const stale = await reading();
    expect(stale.verdict).toBe('HOLD');
    expect(stale.rehearsals.map((r) => r.state)).toEqual(['expired', 'expired', 'expired', 'expired']);
    expect(stale.why).toContain('not proven');
    expect(Date.parse(stale.rehearsals[0]!.passExpiresAt!)).toBeLessThan(Date.now());
    const decide = (hh: typeof h = h) => call(hh, 'POST', '/v1/compliance/gate-decisions/QG-08/R5', OWNER, { decision: 'GO', evidence: [{ label: 'drills', ref: 'register' }], rationale: 'rehearsed' });
    expect(codeOf(await decide())).toBe('go_refused_while_blocked');
    expect(JSON.stringify((await call(h, 'GET', '/v1/compliance/gates/QG-08/can-pass', OWNER)).body)).toContain('not proven');

    // Rehearsed again this quarter: GO, and the owner may decide GO.
    for (const [kind, secs] of [['backup_restore', 3_600], ['store_recovery', 600], ['rollback', 900], ['incident_escalation', 600]] as const) {
      expect((await call(h, 'POST', '/v1/platform/dr-drills', OWNER, { drillId: `now-${kind}`, rehearsal: kind, dataLossSeconds: 0, recoverySeconds: secs })).status).toBeLessThan(300);
    }
    const fresh = await reading();
    expect(fresh.verdict).toBe('GO');
    expect(fresh.rehearsals.every((r) => r.state === 'passed' && Date.parse(r.passExpiresAt!) > Date.now() + 80 * 86_400_000)).toBe(true);
    expect((await decide()).status).toBeLessThan(300);
    expect((await call(h, 'GET', '/v1/platform/recovery-gate', 'u-cash')).status).toBe(403);

    // A cold restart reads the same register.
    expect((await reading(harness(h))).verdict).toBe('GO');
  }, 120_000);
});
