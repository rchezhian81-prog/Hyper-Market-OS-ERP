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
interface Dunning { step?: string; stepsSet: boolean; needsHuman: boolean; chaseableMinor: number; worstDaysOverdue: number; detail: string }
const setSteps = (h: ApiHarness, tenantId: string, userId: string, body: Record<string, unknown>, key = `steps-${JSON.stringify(body)}`) =>
  h.request({ method: 'POST', path: '/v1/b2b/collections/chasing-steps', userId, tenantId, idempotencyKey: key, body });
// The owner's own chasing steps (synthetic numbers — OB-686: head office has none of its own).
const OWNER_STEPS = { minimumChaseMinor: 50_000, reminderAfterDays: 7, finalNoticeAfterDays: 60, stopSupplyAfterDays: 90 };
interface Pay { allocatedMinor: number; unappliedMinor: number; allocations: { invoiceId: string; appliedMinor: number }[] }

describe('b2b collections: aged from the due date, a dispute is not chased, stop-supply needs a person (M22-FR-04)', () => {
  it('ages from the due date and excludes a disputed invoice from the chaseable figure', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'b2b'); // this shop's plan includes B2B (M36-FR-01)
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
    await h.enableFeature(A, 'b2b'); // this shop's plan includes B2B (M36-FR-01)
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
    await h.enableFeature(A, 'b2b'); // this shop's plan includes B2B (M36-FR-01)
    await invoice(h, A, 'u-owner', 'CUST1', 'inv-1', { number: 'INV-1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 100_000 });
    expect((await setSteps(h, A, 'u-owner', OWNER_STEPS)).status).toBe(201);

    // 11 days overdue on 31 Aug, above the owner's 7-day reminder, below final notice → a reminder.
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
    await h.enableFeature(A, 'b2b'); // this shop's plan includes B2B (M36-FR-01)
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
    await h.enableFeature(B, 'b2b'); // this shop's plan includes B2B (M36-FR-01)
    expect((await ageing(h, B, 'u-owner-b', 'CUST1', '2026-08-31')).status).toBe(404);
  });
});

// W5 · OB-686 (owner, 3 Nov 2026) · M22-FR-04: the business-customer chasing steps are the OWNER's. The programmers' ₹500 floor
// and 7 / 60 / 90 days are gone: with none set the dunning read says "not set by the owner" and gives no step; once he sets
// them, his numbers — not the old ones — decide the step.
describe('OB-686: no built-in chasing steps — the owner sets his own', () => {
  it('not set → no step, said in words; only the owner sets them; a bad set is refused; his numbers then decide', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'b2b');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    await h.provisionRole(A, 'u-acct', 'accountant');
    await invoice(h, A, 'u-owner', 'CUST1', 'inv-1', { number: 'INV-1', issuedOn: '2026-07-21', dueOn: '2026-08-20', grossMinor: 30_000 });

    // Not set: the facts are shown, but no step (the old built-in would have said "statement" for ₹300 under its ₹500 floor).
    const none = (await dunning(h, A, 'u-mgr', 'CUST1', '2026-08-31')).body as Dunning;
    expect(none).toEqual({ customerId: 'CUST1', stepsSet: false, chaseableMinor: 30_000, worstDaysOverdue: 11, needsHuman: false, detail: expect.stringMatching(/^The chasing steps are not set by the owner — no reminder, final notice or stop-supply step is given/) });
    expect(none.step).toBeUndefined();
    expect(((await h.request({ method: 'GET', path: '/v1/b2b/collections/chasing-steps', userId: 'u-mgr', tenantId: A })).body as { state: string })).toMatchObject({ state: 'not_set' });

    // Only the owner sets them; the four numbers together, the days rising.
    expect((await setSteps(h, A, 'u-mgr', OWNER_STEPS)).status).toBe(403);
    expect((await setSteps(h, A, 'u-acct', OWNER_STEPS)).status).toBe(403);
    for (const bad of [
      { ...OWNER_STEPS, minimumChaseMinor: -1 }, { ...OWNER_STEPS, reminderAfterDays: 0 }, { ...OWNER_STEPS, finalNoticeAfterDays: 5 },
      { ...OWNER_STEPS, stopSupplyAfterDays: 60 }, { minimumChaseMinor: 0 }, { ...OWNER_STEPS, reminderAfterDays: 7.5 },
    ]) {
      const r = await setSteps(h, A, 'u-owner', bad);
      expect([r.status, (r.body as { error: { code: string } }).error.code], JSON.stringify(bad)).toEqual([400, 'not_readable_as_chasing_steps']);
    }

    // The owner's own numbers: nothing is too small to chase, a reminder after 10 days.
    const set = await setSteps(h, A, 'u-owner', { minimumChaseMinor: 0, reminderAfterDays: 10, finalNoticeAfterDays: 30, stopSupplyAfterDays: 45 });
    expect(set.status).toBe(201);
    expect((set.body as { steps: { setBy: string } }).steps.setBy).toBe('u-owner');
    const mine = (await dunning(h, A, 'u-mgr', 'CUST1', '2026-08-31')).body as Dunning;
    expect(mine).toMatchObject({ stepsSet: true, step: 'reminder' }); // ₹300 is chased: the old ₹500 floor no longer applies
    // 35 days overdue: under the old 60 days it would be a reminder; under his 30 it is a final notice.
    expect(((await dunning(h, A, 'u-mgr', 'CUST1', '2026-09-24')).body as Dunning).step).toBe('final_notice');
    // 50 days overdue: past his 45 → stopping supply is recommended and needs a person (old 90 would not have).
    expect(((await dunning(h, A, 'u-mgr', 'CUST1', '2026-10-09')).body as Dunning)).toMatchObject({ step: 'stop_supply', needsHuman: true });

    // He changes them; the newest applies, the earlier stays on record. Another shop is untouched.
    expect((await setSteps(h, A, 'u-owner', { minimumChaseMinor: 0, reminderAfterDays: 20, finalNoticeAfterDays: 30, stopSupplyAfterDays: 45 })).status).toBe(201);
    expect(((await dunning(h, A, 'u-mgr', 'CUST1', '2026-08-31')).body as Dunning).step).toBe('statement');
    await h.seedOwner(B, 'u-owner-b');
    await h.enableFeature(B, 'b2b');
    expect(((await h.request({ method: 'GET', path: '/v1/b2b/collections/chasing-steps', userId: 'u-owner-b', tenantId: B })).body as { state: string }).state).toBe('not_set');
  });
});
