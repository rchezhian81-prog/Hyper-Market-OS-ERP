import { describe, it, expect } from 'vitest';
import { creditNoteRoutes, type CreditNoteDeps } from '../../services/finance/src/credit-notes';
import type { CreditNote, SourceInvoice } from '../../packages/finance/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';

// CORE-02 inc2: the running finance API issues GST credit notes through the tested
// packages/finance credit-note engine (CGST s.34), not a second copy — the engine had lived only in
// tests/unit/finance-credit-notes.test.ts until now. The tax law (proportional reversal, the
// cumulative cap, the s.34(2) window) is pinned there; here we prove the running route delegates to
// it, persists the note, and refuses honestly without ever touching the invoice.

const NOW = '2026-06-15T10:00:00Z';

const INVOICE: SourceInvoice = {
  invoiceId: 'INV-1', number: 'INV/2026/1', customerId: 'C-1', issuedOn: '2026-05-10',
  taxableMinor: 100_00,
  taxes: [
    { component: 'CGST', rateBps: 900, amountMinor: 9_00 },
    { component: 'SGST', rateBps: 900, amountMinor: 9_00 },
  ],
  grossMinor: 118_00,
  financialYear: '2026-27', // s.34(2) deadline → 2027-11-30
};

const ctx = (body: unknown): RequestContext => ({
  tenantId: 'sre', userId: 'acct-1', branchId: null, params: {}, query: {}, body, traceId: 't',
});

function routeWith(over: Partial<CreditNoteDeps> = {}): { route: Route; saved: CreditNote[] } {
  const saved: CreditNote[] = [];
  const deps: CreditNoteDeps = {
    alreadyCredited: () => 0,
    appendCreditNote: (_t, n) => { saved.push(n); },
    now: () => NOW,
    ...over,
  };
  const route = creditNoteRoutes(deps).find((r) => r.method === 'POST' && r.path === '/v1/finance/credit-notes');
  if (route === undefined) throw new Error('no POST /v1/finance/credit-notes');
  return { route, saved };
}

// A well-formed half-value credit note: half the goods back, tax reversed in the same proportion.
const halfNote = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  noteId: 'CN-1', number: 'CN/2026/1', kind: 'credit_note', invoice: INVOICE, customerId: 'C-1',
  reason: 'goods_returned', taxableMinor: 50_00,
  taxes: [
    { component: 'CGST', rateBps: 900, amountMinor: 4_50 },
    { component: 'SGST', rateBps: 900, amountMinor: 4_50 },
  ],
  issuedOn: NOW,
  ...over,
});

describe('POST /v1/finance/credit-notes issues via the tested engine', () => {
  it('issues a proportional credit note, persists it, and reports the return period', async () => {
    const { route, saved } = routeWith();
    const res = await route.handler(ctx(halfNote()));
    expect(res.status).toBe(201);
    const body = res.body as { note: CreditNote; taxAdjustable: boolean; declareInPeriod: string };
    expect(body.note.grossMinor).toBe(59_00); // 50_00 + 9_00 tax
    expect(body.taxAdjustable).toBe(true);
    expect(body.declareInPeriod).toBe('2026-06'); // the month ISSUED, not the invoice's month
    expect(saved).toHaveLength(1);
    expect(saved[0]!.noteId).toBe('CN-1');
  });

  it('enforces the cumulative s.34 cap across notes — refuses one that would over-credit the invoice', async () => {
    // 60,00 already credited by earlier notes; another 50,00 would exceed the 100,00 invoice.
    const { route, saved } = routeWith({ alreadyCredited: () => 60_00 });
    await expect(route.handler(ctx(halfNote()))).rejects.toMatchObject({
      status: 422, body: { code: 'exceeds_invoice' },
    });
    expect(saved).toHaveLength(0);
  });

  it('refuses reversing the goods while keeping the tax (tax not proportionate)', async () => {
    const { route } = routeWith();
    const badTax = halfNote({
      taxes: [ // full tax reversed against half the goods
        { component: 'CGST', rateBps: 900, amountMinor: 9_00 },
        { component: 'SGST', rateBps: 900, amountMinor: 9_00 },
      ],
    });
    await expect(route.handler(ctx(badTax))).rejects.toMatchObject({
      status: 422, body: { code: 'tax_not_proportionate' },
    });
  });

  it('refuses a note against a different customer than the invoice', async () => {
    const { route } = routeWith();
    await expect(route.handler(ctx(halfNote({ customerId: 'C-2' })))).rejects.toMatchObject({
      status: 422, body: { code: 'wrong_customer' },
    });
  });

  it('refuses when no invoice is supplied, and when the reason is missing', async () => {
    const { route } = routeWith();
    await expect(route.handler(ctx({ noteId: 'CN-9', reason: 'goods_returned' }))).rejects.toMatchObject({
      status: 422, body: { code: 'invoice_not_found' },
    });
    await expect(route.handler(ctx(halfNote({ reason: undefined })))).rejects.toMatchObject({
      status: 422, body: { code: 'no_reason' },
    });
  });

  it('issues after the s.34(2) window as commercial-only, tax NOT reclaimable', async () => {
    const { route, saved } = routeWith({ now: () => '2027-12-01T09:00:00Z' });
    const res = await route.handler(ctx(halfNote({ issuedOn: '2027-12-01T09:00:00Z' })));
    expect(res.status).toBe(201);
    const body = res.body as { taxAdjustable: boolean };
    expect(body.taxAdjustable).toBe(false); // past 2027-11-30 — issued, but no tax relief
    expect(saved).toHaveLength(1);
  });
});
