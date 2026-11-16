import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { tenantClient } from '../support/r3-ops-backings';
import { sealedDecision } from '../support/store-seal';

/**
 * **P-08 · MG-10 — two refused relays in the same millisecond are two records, never one.**
 * A refused decision was numbered by its kind, its day and the instant it arrived — so a second refusal for the same day
 * in the same millisecond took the first one's number and was silently dropped from the owner's feed (found on CI, where
 * the store box relayed an unsealed day and a stranger's day back to back). With the clock held still, both are kept.
 * Synthetic data only.
 */
describe('two refused relays for one day, in one millisecond, are both kept (P-08)', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('an unsealed day and somebody else\'s day, relayed at the same instant, both show on the owner\'s feed', async () => {
    const AT = '2026-10-11T08:00:00.000Z';
    // Hold the wall clock still (only Date — timers and promises run as normal), so both relays arrive in one millisecond.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(AT));
    const h = apiHarness({ now: () => AT });
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-recon', 'store_manager');
    await h.provisionRole(T, 'u-other', 'store_manager');
    await h.provisionRole(T, 'u-sync', 'store_computer', ['S1']);
    const { req, ok } = tenantClient(() => h, T);
    const policy = await h.request({ method: 'PUT', path: '/v1/migration/parallel-run/policy', userId: 'u-owner', tenantId: T, idempotencyKey: `pol-${T}`, body: { cutoverId: 'CUT-1', dailyReconcilerUserId: 'u-recon', requiredCleanDays: 2, maxParallelDays: 14, startedOn: '2026-10-10' } });
    expect(policy.status).toBe(201);
    const day = (by: string) => ({ businessDate: '2026-10-10', enteredBy: by, comparisons: [{ area: 'sales_value', legacyValue: 100, newValue: 100, toleranceMinor: 0 }], explanations: [], enteredAt: AT });
    const unsealed = await ok(req('POST', '/v1/migration/parallel-run/days/2026-10-10/synced', day('u-recon'), 'u-sync'), 'unsealed');
    const other = await ok(req('POST', '/v1/migration/parallel-run/days/2026-10-10/synced', sealedDecision(T, 'MigrationParallelDayEntered', day('u-other')), 'u-sync'), 'other');
    expect((unsealed.body as { refusedDecisionId: string }).refusedDecisionId).not.toBe((other.body as { refusedDecisionId: string }).refusedDecisionId);
    const feed = (await ok(req('GET', '/v1/migration/screen', undefined, 'u-owner'), 'feed')).body as { refusedDecisions: { refusedBecause: string }[] };
    expect(feed.refusedDecisions.map((r) => r.refusedBecause).sort()).toEqual(['decider_not_verified_at_store', 'not_the_named_reconciler']);
  });
});
