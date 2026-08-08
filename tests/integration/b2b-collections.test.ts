import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// B2B collections — structured receivables, ageing, allocation & dunning, end to end through the real
// API (M22-FR-04, API-09). The flat credit-control balance cannot be aged or chased; this surface
// records structured invoices with DUE DATES and runs the collections engine over them: ageing from the
// DUE DATE (an invoice on 30-day terms 40 days old is 10 days overdue, not 40); a disputed invoice is
// outstanding but never CHASEABLE (it belongs with a person, not a letter); a payment ALLOCATED oldest
// due first with any overpayment held UNAPPLIED and visible; and dunning that escalates to a reminder
// but RECOMMENDS stopping supply for a person to commit — date arithmetic does not end a relationship.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const invoice = (h: ApiHarness, tenantId: string, userId: string, customerId: string, invoiceId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/b2b/collections/${customerId}/invoices/${invoiceId}`, userId, tenantId, idempotencyKey: `inv-${invoiceId}`, body });
const pay = (h: ApiHarness, tenantId: string, userId: string, customerId: string, receiptId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/b2b/collections/${customerId}/payments/${receiptId}`, userId, tenantId, idempotencyKey: `pay-${receiptId}`, body });
const ageing = (h: ApiHarness, tenantId: string, userId: string, customerId: string, asOf: string) =>
  h.request({ method: 'GET', path: `/v1/b2b/collections/${customerId}/ageing`, userId, tenantId, query: { asOf } });
const dunning = (h: ApiHarness, tenantId: string, userId: string, customerId: string, asOf: string) =>
  h.request({ method: 'GET', path: `/v1/b2b/collections/${customerId}/dunning`, userId, tenantId, query: { asOf } });

interface Ageing { totalOutstandingMinor: number; overdueMinor: number; disputedMinor: number; chaseableMinor: number; buckets: Record<string, number> }
interface Dunning { step: string; needsHuman: boolean; chaseableMinor: number; worstDaysOverdue: number }
interface Pay { allocatedMinor: number; unappliedMinor: number; allocations: { invoiceId: string; appliedMinor: number }[] }

describe('b2b collections: aged from the due date, a dispute is not chased, stop-supply needs a person (M22-FR-04)', () => {
  it('ages from the due date and excludes a disputed invoice from the chaseable figure', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await invoice(h, A, 'u-owner', 'CUST1', 'inv-1', { number: 'INV-1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 100_000 });
    await invoice(h, A, 'u-owner', 'CUST1', 'inv-2', { number: 'INV-2', issuedOn: '2026-08-16', dueOn: '2026-09-15', grossMinor: 50_000 });
    await invoice(h, A, 'u-owner', 'CUST1', 'inv-3', { number: 'INV-3', issuedOn: '2026-04-01', dueOn: '2026-05-01', grossMinor: 200_000, disputed: true, disputeReason: 'short delivery' });

    const r = (await ageing(h, A, 'u-owner', 'CUST1', '2026-08-31')).body as Ageing;
    expect(r.totalOutstandingMinor).toBe(350_000);
    expect(r.chaseableMinor).toBe(100_000);   // only inv-1: inv-2 not due, inv-3 disputed
    expect(r.disputedMinor).toBe(200_000);
    expect(r.buckets['due_0_30']).toBe(100_000); // inv-1, 11 days overdue
    expect(r.buckets['not_due']).toBe(50_000);   // inv-2
  });

  it('allocates a payment oldest-due-first and holds an overpayment unapplied', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await invoice(h, A, 'u-owner', 'CUST1', 'inv-1', { number: 'INV-1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 100_000 });
    await invoice(h, A, 'u-owner', 'CUST1', 'inv-2', { number: 'INV-2', issuedOn: '2026-08-16', dueOn: '2026-09-15', grossMinor: 50_000 });

    // 120,000 named against inv-1 first, the rest spilling to the next due (inv-2).
    const p = (await pay(h, A, 'u-owner', 'CUST1', 'r1', { receivedMinor: 120_000, against: ['inv-1'] })).body as Pay;
    expect(p.allocatedMinor).toBe(120_000);
    expect(p.unappliedMinor).toBe(0);
    expect(p.allocations.find((a) => a.invoiceId === 'inv-1')?.appliedMinor).toBe(100_000);
    expect(p.allocations.find((a) => a.invoiceId === 'inv-2')?.appliedMinor).toBe(20_000);

    // Settled is projected: inv-1 gone, inv-2 down to 30,000.
    expect(((await ageing(h, A, 'u-owner', 'CUST1', '2026-09-30')).body as Ageing).totalOutstandingMinor).toBe(30_000);

    // A payment bigger than what is open is allocated to the open amount, the rest held UNAPPLIED.
    const over = (await pay(h, A, 'u-owner', 'CUST1', 'r2', { receivedMinor: 200_000 })).body as Pay;
    expect(over.allocatedMinor).toBe(30_000);
    expect(over.unappliedMinor).toBe(170_000);
  });

  it('escalates to a reminder, and recommends stopping supply for a person to commit', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await invoice(h, A, 'u-owner', 'CUST1', 'inv-1', { number: 'INV-1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 100_000 });

    // 11 days overdue on 31 Aug, above the 7-day reminder threshold, below final notice → a reminder.
    const remind = (await dunning(h, A, 'u-owner', 'CUST1', '2026-08-31')).body as Dunning;
    expect(remind.step).toBe('reminder');
    expect(remind.needsHuman).toBe(false);

    // A very old debt → stopping supply is RECOMMENDED and needs a person, never automatic.
    await invoice(h, A, 'u-owner', 'CUST1', 'inv-old', { number: 'INV-OLD', issuedOn: '2025-12-01', dueOn: '2026-01-01', grossMinor: 300_000 });
    const stop = (await dunning(h, A, 'u-owner', 'CUST1', '2026-08-31')).body as Dunning;
    expect(stop.step).toBe('stop_supply');
    expect(stop.needsHuman).toBe(true);
  });

  it('is authorized (record vs read split), per-tenant, and refuses unknown/malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // reads AR, does NOT record receivables
    await h.provisionRole(A, 'u-cash', 'cashier');
    await invoice(h, A, 'u-owner', 'CUST1', 'inv-1', { number: 'INV-1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 100_000 });

    expect((await invoice(h, A, 'u-cash', 'CUST1', 'inv-x', { number: 'X', issuedOn: '2026-08-01', dueOn: '2026-08-20', grossMinor: 1 })).status).toBe(403);
    expect((await invoice(h, A, 'u-mgr', 'CUST1', 'inv-y', { number: 'Y', issuedOn: '2026-08-01', dueOn: '2026-08-20', grossMinor: 1 })).status).toBe(403);
    expect((await ageing(h, A, 'u-mgr', 'CUST1', '2026-08-31')).status).toBe(200); // a manager may read
    expect((await ageing(h, A, 'u-cash', 'CUST1', '2026-08-31')).status).toBe(403);
    expect((await ageing(h, A, 'u-owner', 'GHOST', '2026-08-31')).status).toBe(404); // no receivables
    expect((await invoice(h, A, 'u-owner', 'CUST1', 'inv-bad', { number: 'B', issuedOn: 'not-a-date', dueOn: '2026-08-20', grossMinor: 1 })).status).toBe(400);

    await h.seedOwner(B, 'u-owner-b');
    expect((await ageing(h, B, 'u-owner-b', 'CUST1', '2026-08-31')).status).toBe(404);
  });
});
