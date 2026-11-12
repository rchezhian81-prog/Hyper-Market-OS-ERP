import { describe, it, expect } from 'vitest';
import { receivablesView, receivablesViewRoutes, type ReceivablesViewDeps } from '../../services/finance/src/receivables-view';
import type { Receivable } from '../../packages/b2b/src/index';

/**
 * **U6 · M23-FR-01 ("manage payable/receivable"; acceptance "AP/AR reconciles to purchase/sales") · QG-07 · P-08: one read
 * that puts EVERY credit customer's receivables beside the finance ledger's figure for them — two figures reached two
 * different ways, the difference always visible — with the ageing from the due date.**
 *
 * The per-customer engines (`ageReceivables`, `reconcileAr`) already exist; the audit found no screen shows the account.
 * This is the read behind that screen. Pure engine first, then the route with its permission and its honest empty.
 */
const inv = (customerId: string, invoiceId: string, issuedOn: string, dueOn: string, grossMinor: number, settledMinor = 0, disputed = false): Receivable =>
  ({ invoiceId, number: invoiceId.toUpperCase(), customerId, issuedOn, dueOn, grossMinor, settledMinor, disputed });

describe('the receivables view', () => {
  it('ages every credit customer from the due date and reconciles the collections figure with the finance ledger, the difference visible; totals across customers', () => {
    const v = receivablesView({
      asAt: '2026-09-30',
      customers: [
        { customerId: 'CUST1', invoices: [inv('CUST1', 'inv-1', '2026-07-21', '2026-08-20', 100_000), inv('CUST1', 'inv-2', '2026-09-16', '2026-10-15', 50_000)], financeOutstandingMinor: 150_000 },
        { customerId: 'CUST2', invoices: [inv('CUST2', 'inv-3', '2026-04-01', '2026-05-01', 200_000, 0, true)], financeOutstandingMinor: 180_000 },
      ],
    });
    expect(v.customers.map((c) => [c.customerId, c.outstandingMinor, c.financeOutstandingMinor, c.differenceMinor, c.agrees, c.overdueMinor, c.disputedMinor])).toEqual([
      ['CUST2', 200_000, 180_000, 20_000, false, 200_000, 200_000],
      ['CUST1', 150_000, 150_000, 0, true, 100_000, 0],
    ]);
    expect(v.totals).toMatchObject({ customers: 2, outstandingMinor: 350_000, financeOutstandingMinor: 330_000, differenceMinor: 20_000, overdueMinor: 300_000, disputedMinor: 200_000, differing: 1 });
    expect(v.agrees).toBe(false);
  });

  it('with no credit customer the view says so — never a balanced zero', () => {
    const v = receivablesView({ asAt: '2026-09-30', customers: [] });
    expect(v.customers).toEqual([]);
    expect(v.totals.customers).toBe(0);
    expect(v.agrees).toBe(null);
  });
});

describe('the receivables route', () => {
  it('answers every credit customer as at the shop day, with the derivations of both figures', async () => {
    const deps: ReceivablesViewDeps = {
      customers: async () => ['CUST1'],
      invoices: async (_t, c) => (c === 'CUST1' ? [inv('CUST1', 'inv-1', '2026-07-21', '2026-08-20', 100_000)] : []),
      outstandingMinor: async () => 100_000,
      now: () => '2026-09-30T05:00:00.000Z',
    };
    const route = receivablesViewRoutes(deps).find((r) => r.method === 'GET' && r.path === '/v1/finance/receivables')!;
    expect(route.permission).toBe('finance.period.read');
    const out = await route.handler({ tenantId: 'T', userId: 'u-acct', branchId: null, params: {}, query: {}, body: null, traceId: 't' } as never) as { status: number; body: { asAt: string; customers: { customerId: string; agrees: boolean }[]; leftDerivation: string; rightDerivation: string; agrees: boolean | null } };
    expect(out.status).toBe(200);
    expect(out.body.asAt).toBe('2026-09-30');
    expect(out.body.customers).toEqual([expect.objectContaining({ customerId: 'CUST1', agrees: true })]);
    expect(out.body.leftDerivation).toMatch(/invoice/);
    expect(out.body.rightDerivation).toMatch(/ledger/);
  });
});
