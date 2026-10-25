import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { approvedActivationBody } from '../support/approved-org-change';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { saasRolloutSweep } from '../../services/api/src/saas-rollout-adapters';
import type { Plan } from '../../packages/platform/src/plans';

// M36-FR-01 · D12-FR-06 · R8-2 · OB-321 (owner, 23 Oct 2026, in writing): stores, lanes, users and AI spend are metered per
// shop FOR INFORMATION; no price is invented ("not set"); nothing is ever stopped. A plan change is judged before it happens,
// and one that switches features off goes through only with those features named. Through the real API, in memory and —
// with DATABASE_URL — on real PostgreSQL, with cold restarts. Synthetic data only.

const backings = useRestartableBackings();
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const G1 = '33AABCS1429B1Z1';
/** The owner's OA-12 plan structure, as main.ts offers it (the meter reads the plan's limits for information only). */
const PLANS: readonly Plan[] = [
  { planId: 'starter', name: 'Starter', grants: ['loyalty'], limits: { lanes: 2, branches: 1, named_users: 10 }, monthlyPriceMinor: 1_000_000 },
  { planId: 'standard', name: 'Standard', grants: ['loyalty', 'delivery'], limits: { lanes: 6, branches: 1, named_users: 40 }, monthlyPriceMinor: 1_300_000, overageMinor: { lanes: 100_000 } },
  { planId: 'growth', name: 'Growth', grants: ['loyalty', 'delivery', 'customer_app', 'b2b'], limits: { lanes: 15, branches: 3, named_users: 120 }, monthlyPriceMinor: 1_500_000, overageMinor: { lanes: 90_000 } },
];

describe.each(backings)('the shop is metered for information, and a plan change is judged first — on $name', ({ harness }) => {
  it('counts stores, lanes, users and AI spend from their registers; records hourly; price "not set"; plan change guarded', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-it', 'platform_admin');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier', ['B1']);
    await h.provisionRole(T, 'u-box', 'store_computer', ['B1']);
    await h.provisionRole(T, 'cust-1', 'customer');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Record<string, unknown>> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body as Record<string, unknown>; };

    await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(call('POST', `/v1/org/gst-registrations/${G1}`, 'u-owner', { companyId: 'C1', legalName: 'SRE Retail Pvt Ltd' }), 'gstin');
    for (const b of ['B1', 'B2']) await ok(call('POST', `/v1/org/nodes/${b}`, 'u-owner', { kind: 'branch', name: `Store ${b}`, parentId: 'C1', companyId: 'C1', gstin: G1 }), b);
    await ok(call('POST', '/v1/org/nodes/B1/activation', 'u-it', await approvedActivationBody(h, T, 'u-it', 'u-owner', 'B1')), 'activate B1'); // B2 stays a draft
    for (const [d, s] of [['lane-1', 'active'], ['lane-2', 'active'], ['lane-3', 'retired']] as const) {
      await ok(call('POST', `/v1/platform/devices/${d}/register`, 'u-owner', { branchId: 'B1', kind: 'pos_lane', label: d }), d);
      if (s === 'retired') await ok(call('POST', `/v1/platform/devices/${d}/status`, 'u-owner', { status: 'retired', reason: 'broken' }), `retire ${d}`);
    }
    // AI spend: two metered runs this month (the AI ledger's own fact) and one last month.
    for (const [id, cost, when] of [['r1', 1_200, new Date().toISOString()], ['r2', 800, new Date().toISOString()], ['r0', 9_999, '2020-01-15T10:00:00.000Z']] as const) {
      await h.store.append(T, STREAM.ai, makeEvent({ id: `ai-cost-${id}`, type: 'AiRunCosted', occurredAt: when, idempotencyKey: `ai-cost-${T}-${id}`, source: 'test/seed', payload: { runId: id, agent: 'A01', costMinor: cost, calledAModel: true } }));
    }

    // Who may read it: the owner and IT, not a cashier.
    expect((await call('GET', '/v1/platform/metering', 'u-cash')).status).toBe(403);
    expect(codeOf(await call('GET', '/v1/platform/metering', 'u-owner', undefined, { month: '2026-13' }))).toBe('not_a_month');
    const first = await ok(call('GET', '/v1/platform/metering', 'u-it'), 'metering') as { now: Record<string, number>; monthRecorded: { recorded: boolean; words?: string }; price: { set: boolean; words: string }; forInformationOnly: boolean; mayContinueTrading: boolean; plan: unknown; sources: Record<string, string> };
    // 1 active store (B2 is a draft); 2 lanes (lane-3 retired); 4 people (owner, IT, manager, cashier — not the box, not the customer); ₹20.00 of AI.
    expect(first.now).toMatchObject({ stores: 1, lanes: 2, users: 4, aiSpendMinor: 2_000 });
    expect(first.monthRecorded).toEqual({ recorded: false, words: 'not recorded yet — the hourly meter has no record for this month' });
    expect([first.price.set, first.price.words, first.forInformationOnly, first.mayContinueTrading, first.plan]).toEqual([false, 'not set', true, true, null]);
    expect(Object.keys(first.sources).sort()).toEqual(['aiSpendMinor', 'lanes', 'stores', 'users']);

    // The worker's hourly record — once per hour, whatever the number of passes.
    const sweep = saasRolloutSweep({ store: h.store, now: () => new Date().toISOString(), plans: PLANS });
    const at = new Date().toISOString();
    expect(await sweep(T, at)).toBe(1);
    expect(await sweep(T, at)).toBe(0);

    h = harness(h); // ── COLD RESTART ──
    const after = await ok(call('GET', '/v1/platform/metering', 'u-owner'), 'metering') as { monthRecorded: Record<string, unknown> };
    expect(after.monthRecorded).toMatchObject({ recorded: true, hoursRecorded: 1, peakStores: 1, peakLanes: 2, peakUsers: 4, aiSpendMinor: 2_000 });
    const old = await ok(call('GET', '/v1/platform/metering', 'u-owner', undefined, { month: '2020-01' }), 'old') as { now: unknown; monthRecorded: { recorded: boolean } };
    expect([old.now, old.monthRecorded.recorded]).toEqual([null, false]);

    // ── Plan change: judged first; features lost must be named ──
    expect(codeOf(await call('POST', '/v1/platform/subscription/plan-change/preview', 'u-owner', { planId: 'platinum' }))).toBe('unknown_plan');
    await ok(call('POST', '/v1/platform/subscription', 'u-owner', { planId: 'growth', rail: 'upi_autopay' }), 'subscribe growth');
    const withPlan = await ok(call('GET', '/v1/platform/metering', 'u-owner'), 'metering') as { plan: { planId: string; limitsForInformation: { dimension: string; used: number; limit: number; overBy: number }[] }; price: { words: string } };
    expect(withPlan.plan.planId).toBe('growth');
    expect(withPlan.plan.limitsForInformation.find((d) => d.dimension === 'lanes')).toMatchObject({ used: 2, limit: 15, overBy: 0 });
    expect(withPlan.price.words).toBe('not set'); // still no price worked out — information only
    const preview = await ok(call('POST', '/v1/platform/subscription/plan-change/preview', 'u-owner', { planId: 'starter' }), 'preview') as { kind: string; featuresLost: string[]; wouldExceed: unknown[]; dataDeleted: boolean };
    expect(preview).toMatchObject({ kind: 'downgrade', featuresLost: ['b2b', 'customer_app', 'delivery'], dataDeleted: false });
    expect(preview.wouldExceed).toEqual([]);
    h = harness(h); // ── COLD RESTART ──
    const refused = await call('POST', '/v1/platform/subscription', 'u-owner', { planId: 'starter', rail: 'upi_autopay' });
    expect(codeOf(refused)).toBe('plan_change_loses_features');
    expect(codeOf(await call('POST', '/v1/platform/subscription', 'u-owner', { planId: 'starter', rail: 'upi_autopay', acceptFeaturesLost: ['delivery'] }))).toBe('plan_change_loses_features');
    const moved = await ok(call('POST', '/v1/platform/subscription', 'u-owner', { planId: 'starter', rail: 'upi_autopay', acceptFeaturesLost: ['delivery', 'b2b', 'customer_app'] }), 'move to starter') as { planChange: { featuresLost: string[] } };
    expect(moved.planChange.featuresLost).toEqual(['b2b', 'customer_app', 'delivery']);
    expect(((await ok(call('GET', '/v1/platform/subscription', 'u-owner'), 'sub')) as { subscription: { planId: string } }).subscription.planId).toBe('starter');
    // An upgrade loses nothing and needs nothing named.
    await ok(call('POST', '/v1/platform/subscription', 'u-owner', { planId: 'standard', rail: 'upi_autopay' }), 'upgrade');
  }, 120_000);
});
