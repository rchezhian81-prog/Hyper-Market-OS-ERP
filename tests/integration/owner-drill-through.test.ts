import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Owner drill-through + KPI comparison, end to end (M29-FR-02 · NFR-15 · §28, API-10). The owner sees a
// figure and asks "show me". A drill that looks right and is wrong is worse than none, so the rows must add
// up to the headline — and when they don't it is said LOUDLY, never hidden. Scope is enforced: rows in
// branches the viewer cannot see are withheld, the total recomputed, and the viewer TOLD a figure exists
// they cannot see. Every drill is logged (who reached which transactions). Gated owner.kpi.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const txn = (over: Record<string, unknown>) => ({ transactionId: 't', at: '2026-08-20T10:00:00.000Z', branchId: 'b1', amountMinor: 0, description: 'sale', ...over });

const drill = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'dr') =>
  h.request({ method: 'POST', path: '/v1/reporting/drill', userId: u, tenantId: A, idempotencyKey: key, body });
const compare = (h: ApiHarness, u: string, body: Record<string, unknown>, key = 'cmp') =>
  h.request({ method: 'POST', path: '/v1/reporting/compare', userId: u, tenantId: A, idempotencyKey: key, body });
const audits = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/reporting/drill-audits', userId: u, tenantId: A });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner'); // owner.kpi.read
  await h.provisionRole(A, 'u-cash', 'cashier'); // not
  return h;
}

describe('owner drill-through — "show me", and it had better add up (M29-FR-02)', () => {
  it('reconciles when the rows add up to the headline, and logs the drill', async () => {
    const h = await seeded();
    const res = await drill(h, 'u-owner', {
      metric: 'fresh_margin', kpiValueMinor: 100000, branchScope: 'all',
      transactions: [txn({ transactionId: 't1', amountMinor: 40000 }), txn({ transactionId: 't2', amountMinor: 30000 }), txn({ transactionId: 't3', amountMinor: 30000 })],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reconciles: true, shownTotalMinor: 100000, withheldCount: 0 });
    expect((res.body as { transactions: unknown[] }).transactions).toHaveLength(3);

    // The drill is logged (§28) — and survives a restart.
    const restarted = apiHarness({ store: h.store });
    const log = (await audits(restarted, 'u-owner')).body as { audits: { userId: string; metric: string; reconciled: boolean; transactionsShown: number }[]; count: number };
    expect(log.count).toBe(1);
    expect(log.audits[0]).toMatchObject({ userId: 'u-owner', metric: 'fresh_margin', reconciled: true, transactionsShown: 3 });
  });

  it('shouts a LOUD discrepancy when the rows do not add up to the figure they came from', async () => {
    const h = await seeded();
    const res = await drill(h, 'u-owner', {
      metric: 'fresh_margin', kpiValueMinor: 100000, branchScope: 'all',
      transactions: [txn({ transactionId: 't1', amountMinor: 40000 }), txn({ transactionId: 't2', amountMinor: 30000 })], // sum 70000
    });
    expect(res.body).toMatchObject({ reconciles: false });
    expect((res.body as { discrepancy?: string }).discrepancy).toContain('DO NOT ADD UP');
  });

  it('withholds out-of-scope rows, recomputes the shown total, and says the headline includes them', async () => {
    const h = await seeded();
    const res = await drill(h, 'u-owner', {
      metric: 'sales', kpiValueMinor: 100000, branchScope: ['b1'], // only b1 in scope
      transactions: [txn({ transactionId: 't1', branchId: 'b1', amountMinor: 60000 }), txn({ transactionId: 't2', branchId: 'b2', amountMinor: 40000 })],
    });
    expect(res.body).toMatchObject({ reconciles: true, shownTotalMinor: 60000, withheldCount: 1, withheldTotalMinor: 40000 });
    expect((res.body as { transactions: unknown[] }).transactions).toHaveLength(1);
    expect((res.body as { detail: string }).detail).toContain('not shown');
  });

  it('ranks a metric across a dimension (unattributed grouped, not dropped), and is gated', async () => {
    const h = await seeded();
    const res = await compare(h, 'u-owner', {
      dimension: 'category', metric: 'sales', branchScope: 'all',
      transactions: [txn({ transactionId: 't1', categoryId: 'catA', amountMinor: 60000 }), txn({ transactionId: 't2', categoryId: 'catB', amountMinor: 30000 }), txn({ transactionId: 't3', amountMinor: 10000 })],
    });
    expect(res.status).toBe(200);
    const body = res.body as { rows: { key: string; valueMinor: number; shareBps: number }[]; totalMinor: number; reconciles: boolean };
    expect(body).toMatchObject({ totalMinor: 100000, reconciles: true });
    expect(body.rows[0]).toMatchObject({ key: 'catA', valueMinor: 60000, shareBps: 6000 });
    expect(body.rows.some((r) => r.key === 'unattributed')).toBe(true); // grouped, never dropped

    // Gating + validation.
    expect((await drill(h, 'u-cash', { metric: 'm', kpiValueMinor: 0, transactions: [] }, 'dr-cash')).status).toBe(403);
    expect((await compare(h, 'u-cash', { dimension: 'branch', metric: 'm', transactions: [] }, 'cmp-cash')).status).toBe(403);
    expect((await audits(h, 'u-cash')).status).toBe(403);
    expect(codeOf(await drill(h, 'u-owner', { metric: 'm', transactions: [] }, 'dr-bad'))).toBe('not_readable_as_a_drill');
  });
});
