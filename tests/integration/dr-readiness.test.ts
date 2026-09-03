import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// DR-drill scoring & backup-retention eligibility, end to end (M35-FR-02, API-11, §32, hard rule #6). The
// readiness posture around a proven backup: can the shop come back inside the roadmap's RPO/RTO, and which
// aged backups may be pruned WITHOUT ever emptying the shelf. Stateless rulings on the tested @sre/ops
// engine. Gated backup.verify.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const targets = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/platform/recovery-targets', userId: u, tenantId: A });
const score = (h: ApiHarness, u: string, body: Record<string, unknown>, key = `s-${Math.random()}`) =>
  h.request({ method: 'POST', path: '/v1/platform/dr-drills/score', userId: u, tenantId: A, idempotencyKey: key, body });
const eligible = (h: ApiHarness, u: string, body: Record<string, unknown>, key = `e-${Math.random()}`) =>
  h.request({ method: 'POST', path: '/v1/platform/backups/eligible-for-removal', userId: u, tenantId: A, idempotencyKey: key, body });

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');                // backup.verify.read
  await h.provisionRole(A, 'u-cash', 'cashier');  // none
  return h;
}

// Five backups oldest-to-newest gaps, to exercise the retention window and the keep floor.
const MANIFESTS = [
  { backupId: 'b1', startedAt: '2026-09-01T02:00:00Z' }, // newest
  { backupId: 'b2', startedAt: '2026-08-20T02:00:00Z' },
  { backupId: 'b3', startedAt: '2026-08-10T02:00:00Z' }, // inside a 30-day window from 2026-09-03
  { backupId: 'b4', startedAt: '2026-07-01T02:00:00Z' }, // older than the window
  { backupId: 'b5', startedAt: '2026-06-01T02:00:00Z' }, // older than the window
];

describe('DR readiness: recovery targets, drill scoring, retention eligibility (M35-FR-02)', () => {
  it('publishes the §32 recovery targets — committed local sales must not be lost at all (RPO 0)', async () => {
    const h = await cast();
    const res = await targets(h, 'u-owner');
    expect(res.status).toBe(200);
    const body = res.body as { targets: { service: string; rpoSeconds: number; rtoSeconds: number }[] };
    const edge = body.targets.find((t) => t.service.includes('store-edge'));
    expect(edge?.rpoSeconds).toBe(0);              // §32: no data loss for committed sales
    expect(body.targets.find((t) => t.service === 'cloud')?.rtoSeconds).toBe(14_400);
  });

  it('scores a rehearsal pass, and NAMES an RPO miss and an RTO miss against the target', async () => {
    const h = await cast();

    // By service name: within both targets → passed.
    const ok = await score(h, 'u-owner', { service: 'cloud', dataLossSeconds: 300, recoverySeconds: 3600 });
    expect(ok.body).toMatchObject({ passed: true, metRpo: true, metRto: true });

    // Committed local sales, any loss at all fails the RPO of 0 — the miss is named.
    const rpoMiss = await score(h, 'u-owner', { service: 'store-edge (committed sales)', dataLossSeconds: 5, recoverySeconds: 100 });
    expect(rpoMiss.body).toMatchObject({ passed: false, metRpo: false, metRto: true });
    expect((rpoMiss.body as { detail: string }).detail).toContain('RPO of 0s');

    // Explicit target, recovery too slow → RTO miss named.
    const rtoMiss = await score(h, 'u-owner', { target: { service: 'depot', rpoSeconds: 60, rtoSeconds: 120 }, dataLossSeconds: 30, recoverySeconds: 200 });
    expect(rtoMiss.body).toMatchObject({ passed: false, metRpo: true, metRto: false });
    expect((rtoMiss.body as { detail: string }).detail).toContain('RTO of 120s');
  });

  it('reports aged backups eligible for removal — but never empties the shelf (hard rule #6)', async () => {
    const h = await cast();

    // 30-day window from 2026-09-03, keep the newest 2: b4 and b5 are past both the floor and the window.
    const r = await eligible(h, 'u-owner', { manifests: MANIFESTS, asOf: '2026-09-03T00:00:00Z', retentionDays: 30, keepAtLeast: 2 });
    const body = r.body as { eligibleForRemoval: { backupId: string }[]; eligibleCount: number; keptCount: number };
    expect(body.eligibleForRemoval.map((m) => m.backupId).sort()).toEqual(['b4', 'b5']);
    expect(body.eligibleCount).toBe(2);
    expect(body.keptCount).toBe(3);

    // The floor is load-bearing: keepAtLeast at or above the count keeps EVERY backup, however old.
    const allKept = await eligible(h, 'u-owner', { manifests: MANIFESTS, asOf: '2026-09-03T00:00:00Z', retentionDays: 30, keepAtLeast: 5 });
    expect(allKept.body).toMatchObject({ eligibleCount: 0, keptCount: 5 });
  });

  it('refuses a drill with no target / no measured seconds, an unknown service, a bad removal request, and gates on backup.verify.read', async () => {
    const h = await cast();

    expect(codeOf(await score(h, 'u-owner', { dataLossSeconds: 10, recoverySeconds: 20 }))).toBe('drill_needs_a_target');
    expect(codeOf(await score(h, 'u-owner', { service: 'cloud' }))).toBe('drill_needs_measured_seconds');
    expect(codeOf(await score(h, 'u-owner', { service: 'no-such-service', dataLossSeconds: 1, recoverySeconds: 1 }))).toBe('unknown_recovery_target');
    expect(codeOf(await score(h, 'u-owner', { target: { service: 'x', rpoSeconds: -1, rtoSeconds: 1 }, dataLossSeconds: 1, recoverySeconds: 1 }))).toBe('target_not_a_recovery_target');

    expect(codeOf(await eligible(h, 'u-owner', { asOf: '2026-09-03T00:00:00Z', retentionDays: 30 }))).toBe('removal_needs_manifests');
    expect(codeOf(await eligible(h, 'u-owner', { manifests: MANIFESTS, retentionDays: 30 }))).toBe('removal_needs_asof_and_retention');
    expect(codeOf(await eligible(h, 'u-owner', { manifests: MANIFESTS, asOf: '2026-09-03T00:00:00Z', retentionDays: 30, keepAtLeast: 1.5 }))).toBe('keep_at_least_not_a_count');

    // A cashier holds no backup.verify.read → refused on every route.
    expect((await targets(h, 'u-cash')).status).toBe(403);
    expect((await score(h, 'u-cash', { service: 'cloud', dataLossSeconds: 1, recoverySeconds: 1 })).status).toBe(403);
    expect((await eligible(h, 'u-cash', { manifests: MANIFESTS, asOf: '2026-09-03T00:00:00Z', retentionDays: 30 })).status).toBe(403);
  });
});
