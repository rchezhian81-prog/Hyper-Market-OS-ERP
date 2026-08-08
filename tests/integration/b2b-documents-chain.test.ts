import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// The B2B document chain, part 1 — quotation → sales order, end to end through the real API, the real
// gap-free number series and the real credit control (M22-FR-02, API-09). Two controls are proven here:
//
//   • A NUMBER IS DRAWN ONCE, AND ONLY ON SUCCESS. A rejected quotation leaves no gap in the series —
//     so the first ACCEPTED quotation is QUO-000001 even after a rejected one, because a gap in a tax
//     series is a question from an assessing officer with no good answer.
//   • CONVERSION IS AT THE QUOTED PRICE OR REFUSED — never re-priced, never past the window, and never
//     without credit control (M22-FR-01) clearing it: no account → blocked, over the limit → blocked,
//     a sufficient limit → cleared. One quote makes one order; a second conversion is refused.
//
// (Expiry of the quoted window is covered at the unit level in tests/unit/b2b-documents.test.ts, where
// the clock is injected; here the clock is the real wall clock so a fresh quote never reads as expired.)

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const LINE = { lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 };
// net 1,00,000 + tax 5,000 = gross 1,05,000.
const GROSS = 105_000;

const setLimit = (h: ApiHarness, t: string, u: string, cust: string, creditLimitMinor: number) =>
  h.request({ method: 'POST', path: `/v1/b2b/accounts/${cust}`, userId: u, tenantId: t, idempotencyKey: `lim-${cust}-${creditLimitMinor}`, body: { creditLimitMinor } });
const quote = (h: ApiHarness, t: string, u: string, cust: string, id: string, lines: unknown, validForDays?: number) =>
  h.request({ method: 'POST', path: `/v1/b2b/documents/${cust}/quotations/${id}`, userId: u, tenantId: t, idempotencyKey: `q-${id}`, body: { lines, ...(validForDays === undefined ? {} : { validForDays }) } });
const order = (h: ApiHarness, t: string, u: string, cust: string, id: string, fromQuotationId: string) =>
  h.request({ method: 'POST', path: `/v1/b2b/documents/${cust}/orders/${id}`, userId: u, tenantId: t, idempotencyKey: `o-${id}`, body: { fromQuotationId } });
const read = (h: ApiHarness, t: string, u: string, cust: string, id: string) =>
  h.request({ method: 'GET', path: `/v1/b2b/documents/${cust}/${id}`, userId: u, tenantId: t });

interface Doc { documentId: string; number: string; kind: string; derivedFrom?: string; grossMinor: number; validUntil?: string }
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('b2b document chain: a number is drawn only on success, conversion is at the quoted price with credit cleared (M22-FR-02)', () => {
  it('draws a gap-free number only on success — a rejected quotation leaves no gap', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // A quotation for zero units is refused as a business rule — well-formed, but not an offer — and
    // it draws NO number.
    const bad = await quote(h, A, 'u-owner', 'CUST1', 'q-bad', [{ ...LINE, qty: 0 }]);
    expect(bad.status).toBe(422);
    expect(codeOf(bad)).toBe('quotation_invalid_quantity');

    // The first ACCEPTED quotation is QUO-000001 — the rejected one consumed nothing.
    const q1 = await quote(h, A, 'u-owner', 'CUST1', 'q1', [LINE]);
    expect(q1.status).toBe(201);
    expect((q1.body as Doc).number).toBe('QUO-000001');
    expect((q1.body as Doc).grossMinor).toBe(GROSS);
    expect((q1.body as Doc).validUntil).toBeDefined();

    const got = await read(h, A, 'u-owner', 'CUST1', 'q1');
    expect(got.status).toBe(200);
    expect((got.body as Doc).kind).toBe('quotation');
  });

  it('converts at the quoted price once credit is cleared, and refuses a second conversion', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    expect((await setLimit(h, A, 'u-owner', 'CUST1', 200_000)).status).toBe(201);

    await quote(h, A, 'u-owner', 'CUST1', 'q1', [LINE]);

    const so = await order(h, A, 'u-owner', 'CUST1', 'so1', 'q1');
    expect(so.status).toBe(201);
    expect((so.body as Doc).number).toBe('SO-000001');
    expect((so.body as Doc).kind).toBe('sales_order');
    expect((so.body as Doc).derivedFrom).toBe('q1');   // derived from the quotation
    expect((so.body as Doc).grossMinor).toBe(GROSS);   // at the QUOTED price, not re-derived

    // One quote, one order — a second conversion of the same quotation is refused.
    const again = await order(h, A, 'u-owner', 'CUST1', 'so2', 'q1');
    expect(again.status).toBe(422);
    expect(codeOf(again)).toBe('conversion_already_converted');
  });

  it('refuses conversion until credit control clears it: no account → blocked, over-limit → blocked, sufficient → cleared', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await quote(h, A, 'u-owner', 'CUST1', 'q1', [LINE]);   // gross 1,05,000

    // No credit account set — credit control has not cleared them.
    const noAccount = await order(h, A, 'u-owner', 'CUST1', 'so-a', 'q1');
    expect(noAccount.status).toBe(422);
    expect(codeOf(noAccount)).toBe('conversion_credit_blocked');

    // A limit below the order value — still blocked (over limit, no approver).
    await setLimit(h, A, 'u-owner', 'CUST1', 50_000);
    const overLimit = await order(h, A, 'u-owner', 'CUST1', 'so-b', 'q1');
    expect(overLimit.status).toBe(422);
    expect(codeOf(overLimit)).toBe('conversion_credit_blocked');

    // A sufficient limit — now it clears and the order is drawn.
    await setLimit(h, A, 'u-owner', 'CUST1', 200_000);
    const cleared = await order(h, A, 'u-owner', 'CUST1', 'so-c', 'q1');
    expect(cleared.status).toBe(201);
    expect((cleared.body as Doc).kind).toBe('sales_order');
  });

  it('is authorized (issue vs read split), per-tenant, and refuses unknown/malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');  // issues AND reads
    await h.provisionRole(A, 'u-acct', 'accountant');    // reads, does NOT issue
    await h.provisionRole(A, 'u-cash', 'cashier');       // neither

    // A store manager runs the B2B desk — may issue a quotation.
    expect((await quote(h, A, 'u-mgr', 'CUST1', 'q1', [LINE])).status).toBe(201);
    // An accountant and a cashier may not issue.
    expect((await quote(h, A, 'u-acct', 'CUST1', 'q2', [LINE])).status).toBe(403);
    expect((await quote(h, A, 'u-cash', 'CUST1', 'q3', [LINE])).status).toBe(403);
    // An accountant may read; a cashier may not.
    expect((await read(h, A, 'u-acct', 'CUST1', 'q1')).status).toBe(200);
    expect((await read(h, A, 'u-cash', 'CUST1', 'q1')).status).toBe(403);
    // Unknown document → 404; malformed lines → 400 (not a business refusal).
    expect((await read(h, A, 'u-owner', 'CUST1', 'ghost')).status).toBe(404);
    expect((await quote(h, A, 'u-owner', 'CUST1', 'q-mal', 'not-an-array')).status).toBe(400);

    // Another tenant sees nothing of A's documents.
    await h.seedOwner(B, 'u-owner-b');
    expect((await read(h, B, 'u-owner-b', 'CUST1', 'q1')).status).toBe(404);
  });
});
