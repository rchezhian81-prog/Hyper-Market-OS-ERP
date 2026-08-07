import { describe, it, expect } from 'vitest';
import {
  scopeToCustomer,
  ageReceivables,
  allocatePayment,
  decideDunning,
  reconcileAr,
  type B2BSession,
  type Receivable,
} from '../../packages/b2b/src/collections';

// M22-FR-04 acceptance: "a B2B customer sees only its own invoices/outstanding; a payment
// reduces the outstanding and reconciles to finance; overdue accounts are flagged."

const session = (over: Partial<B2BSession> = {}): B2BSession => ({
  sessionId: 's-1',
  customerId: 'c-school',
  tenantId: 't-sre',
  userId: 'u-bursar',
  grants: ['place_order', 'view_invoices', 'view_statement', 'make_payment'],
  ...over,
});

const invoice = (over: Partial<Receivable>): Receivable => ({
  invoiceId: 'i-1',
  number: 'INV00001',
  customerId: 'c-school',
  tenantId: 't-sre',
  issuedOn: '2026-06-25',
  dueOn: '2026-07-25',
  grossMinor: 500_000,
  settledMinor: 0,
  ...over,
});

describe('a B2B customer sees only its own data (M22-FR-04)', () => {
  const rows = [
    invoice({}),
    invoice({ invoiceId: 'i-2', number: 'INV00002' }),
    invoice({ invoiceId: 'i-9', customerId: 'c-caterer', number: 'INV00009' }),
  ];

  it('scopes from the session, not from the request', () => {
    const result = scopeToCustomer({ session: session(), rows, grant: 'view_invoices' });
    expect(result.rows.map((r) => r.invoiceId)).toEqual(['i-1', 'i-2']);
    expect(result.detail).toContain('filtered server-side from the session');
  });

  it('REFUSES a request naming a rival and records it as a security event', () => {
    const result = scopeToCustomer({
      session: session(), rows, grant: 'view_invoices', requestedCustomerId: 'c-caterer',
    });
    expect(result.allowed).toBe(false);
    expect(result.outcome).toBe('not_your_data');
    expect(result.securityEvent).toBe(true);
    expect(result.rows).toEqual([]);
  });

  it('will not cross a tenant boundary for the same customer id', () => {
    const cross = [invoice({}), invoice({ invoiceId: 'i-x', tenantId: 't-other' })];
    expect(scopeToCustomer({ session: session(), rows: cross, grant: 'view_invoices' }).rows).toHaveLength(1);
  });

  it('refuses a grant the login does not hold', () => {
    const result = scopeToCustomer({
      session: session({ grants: ['place_order'] }), rows, grant: 'view_statement',
    });
    expect(result.outcome).toBe('no_grant');
    expect(result.securityEvent).toBe(false);
  });
});

describe('ageing runs from the DUE DATE, not the invoice date', () => {
  it('an invoice on 30-day terms issued 40 days ago is 10 days overdue, not 40', () => {
    const report = ageReceivables({
      customerId: 'c-school',
      invoices: [invoice({ issuedOn: '2026-06-25', dueOn: '2026-07-25' })],
      asAt: '2026-08-04',
    });
    expect(report.items[0]?.daysOverdue).toBe(10);
    expect(report.items[0]?.bucket).toBe('due_0_30');
    // Ageing from the invoice date would have put this in 31–60 and made every account
    // on terms look delinquent.
    expect(report.buckets.due_31_60).toBe(0);
  });

  it('an invoice inside its terms is not_due, and says how long is left', () => {
    const report = ageReceivables({
      customerId: 'c-school', invoices: [invoice({ dueOn: '2026-08-25' })], asAt: '2026-08-04',
    });
    expect(report.items[0]?.bucket).toBe('not_due');
    expect(report.overdueMinor).toBe(0);
    expect(report.items[0]?.detail).toContain('not due for another 21 day(s)');
  });

  it('buckets by how long past due, and drops fully-settled invoices', () => {
    const report = ageReceivables({
      customerId: 'c-school',
      invoices: [
        invoice({ invoiceId: 'i-a', dueOn: '2026-07-25' }),
        invoice({ invoiceId: 'i-b', dueOn: '2026-05-25' }),
        invoice({ invoiceId: 'i-c', dueOn: '2026-01-25' }),
        invoice({ invoiceId: 'i-paid', dueOn: '2026-01-25', settledMinor: 500_000 }),
      ],
      asAt: '2026-08-04',
    });
    expect(report.items.map((i) => i.bucket)).toEqual(['due_90_plus', 'due_61_90', 'due_0_30']);
    expect(report.totalOutstandingMinor).toBe(1_500_000);
  });

  it('a DISPUTED invoice is outstanding but NOT chaseable', () => {
    const report = ageReceivables({
      customerId: 'c-school',
      invoices: [
        invoice({ invoiceId: 'i-ok', dueOn: '2026-07-01' }),
        invoice({ invoiceId: 'i-q', dueOn: '2026-07-01', disputed: true, disputeReason: 'short delivery' }),
      ],
      asAt: '2026-08-04',
    });
    expect(report.overdueMinor).toBe(1_000_000);
    expect(report.disputedMinor).toBe(500_000);
    // The number a dunning run may act on excludes what the customer has queried.
    expect(report.chaseableMinor).toBe(500_000);
    expect(report.items.find((i) => i.invoiceId === 'i-q')?.detail).toContain('not a reminder letter');
  });

  it('ignores another customer\'s invoices entirely', () => {
    const report = ageReceivables({
      customerId: 'c-school', invoices: [invoice({ customerId: 'c-caterer' })], asAt: '2026-08-04',
    });
    expect(report.totalOutstandingMinor).toBe(0);
  });
});

describe('a payment is ALLOCATED, never absorbed into a balance', () => {
  const open: readonly Receivable[] = [
    invoice({ invoiceId: 'i-old', number: 'INV1', dueOn: '2026-05-25', grossMinor: 300_000 }),
    invoice({ invoiceId: 'i-mid', number: 'INV2', dueOn: '2026-06-25', grossMinor: 400_000 }),
    invoice({ invoiceId: 'i-new', number: 'INV3', dueOn: '2026-07-25', grossMinor: 500_000 }),
  ];

  it('applies oldest due first and names each invoice it touched', () => {
    const result = allocatePayment({
      receiptId: 'r-1', customerId: 'c-school', receivedMinor: 500_000, invoices: open,
    });
    expect(result.allocations.map((a) => `${a.invoiceId}:${a.appliedMinor}`)).toEqual([
      'i-old:300000', 'i-mid:200000',
    ]);
    expect(result.allocations[1]?.stillOpenMinor).toBe(200_000);
    expect(result.unappliedMinor).toBe(0);
  });

  it('honours the invoice the customer NAMED before anything else', () => {
    const result = allocatePayment({
      receiptId: 'r-2', customerId: 'c-school', receivedMinor: 500_000, invoices: open,
      against: ['i-new'],
    });
    expect(result.allocations[0]?.invoiceId).toBe('i-new');
    expect(result.allocations[0]?.appliedMinor).toBe(500_000);
    expect(result.allocations).toHaveLength(1);
  });

  it('holds an overpayment as UNAPPLIED rather than netting it away', () => {
    const result = allocatePayment({
      receiptId: 'r-3', customerId: 'c-school', receivedMinor: 1_500_000, invoices: open,
    });
    expect(result.allocatedMinor).toBe(1_200_000);
    expect(result.unappliedMinor).toBe(300_000);
    expect(result.detail).toContain('it is not netted into a balance');
  });

  it('does NOT absorb a payment into a disputed invoice unless told to', () => {
    const withDispute = [...open, invoice({ invoiceId: 'i-q', dueOn: '2026-01-01', disputed: true })];
    const guarded = allocatePayment({
      receiptId: 'r-4', customerId: 'c-school', receivedMinor: 100_000, invoices: withDispute,
    });
    expect(guarded.allocations[0]?.invoiceId).toBe('i-old');

    const explicit = allocatePayment({
      receiptId: 'r-5', customerId: 'c-school', receivedMinor: 100_000, invoices: withDispute,
      allocateToDisputed: true,
    });
    expect(explicit.allocations[0]?.invoiceId).toBe('i-q');
  });

  it('never allocates to another customer\'s invoice', () => {
    const result = allocatePayment({
      receiptId: 'r-6', customerId: 'c-school', receivedMinor: 100_000,
      invoices: [invoice({ customerId: 'c-caterer' })],
    });
    expect(result.allocations).toEqual([]);
    expect(result.unappliedMinor).toBe(100_000);
  });
});

describe('stopping supply is RECOMMENDED, never automatic', () => {
  const ageing = (dueOn: string, over: Partial<Receivable> = {}) =>
    ageReceivables({
      customerId: 'c-school', invoices: [invoice({ dueOn, ...over })], asAt: '2026-08-04',
    });

  it('needs a human before it would cut a customer off', () => {
    const decision = decideDunning({ ageing: ageing('2026-04-01') });
    expect(decision.step).toBe('stop_supply');
    expect(decision.needsHuman).toBe(true);
    expect(decision.detail).toContain('the morning of their function');
  });

  it('escalates through statement, reminder and final notice', () => {
    expect(decideDunning({ ageing: ageing('2026-08-01') }).step).toBe('statement');
    expect(decideDunning({ ageing: ageing('2026-07-20') }).step).toBe('reminder');
    expect(decideDunning({ ageing: ageing('2026-05-20') }).step).toBe('final_notice');
  });

  it('does not send a letter for a trivial amount', () => {
    const decision = decideDunning({ ageing: ageing('2026-05-01', { grossMinor: 20_000 }) });
    expect(decision.step).toBe('statement');
    expect(decision.detail).toContain('below the chase threshold');
  });

  it('chases NOTHING when the only overdue invoice is disputed', () => {
    const decision = decideDunning({ ageing: ageing('2026-04-01', { disputed: true }) });
    expect(decision.step).toBe('none');
    expect(decision.chaseableMinor).toBe(0);
    expect(decision.detail).toContain('belongs with a person, not a reminder letter');
  });

  it('is quiet on an account with nothing overdue', () => {
    expect(decideDunning({ ageing: ageing('2026-09-01') }).step).toBe('none');
  });
});

describe('the portal must agree with the ledger (M23)', () => {
  const report = ageReceivables({
    customerId: 'c-school', invoices: [invoice({ grossMinor: 500_000 })], asAt: '2026-08-04',
  });

  it('agrees exactly or says which way it differs', () => {
    expect(reconcileAr({ customerId: 'c-school', ageing: report, financeOutstandingMinor: 500_000 }).agrees).toBe(true);

    const under = reconcileAr({ customerId: 'c-school', ageing: report, financeOutstandingMinor: 620_000 });
    expect(under.differenceMinor).toBe(-120_000);
    expect(under.detail).toContain('they will pay the smaller one');

    const over = reconcileAr({ customerId: 'c-school', ageing: report, financeOutstandingMinor: 400_000 });
    expect(over.differenceMinor).toBe(100_000);
    expect(over.detail).toContain('money the books do not record');
  });
});
