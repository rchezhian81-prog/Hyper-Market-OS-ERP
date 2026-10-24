import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { P3, p3Shop, issuedOrder, received, capturedAndMatched, type Call } from '../support/p3-purchase';
import { approvedBody, sentWithApproval } from '../support/approval-request';
import { withApprovals } from '../support/refund-approval';
import { schemaProblems } from '../support/json-schema-check';
import { DECLARED_BODIES, MONEY_ROUTES } from '../../services/platform/src/api-body-schemas';
import { buildSurface } from '../../services/api/src/main';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

// M32-FR-01 (§30.1 "OpenAPI/AsyncAPI or equivalent machine-readable contract") — the finance lane's remaining limit: the
// MONEY routes declare their request and reply body schemas (sales intake, refunds, supplier payments and advances,
// purchase orders, journals and the day book). This drives every one of them through the real API, the way the tills,
// the desk and the accountant do, and checks each body SENT against the declared request schema and each reply GOT
// against the declared reply schema — so a declared schema cannot drift from its handler. And it proves a card number on a
// tender is outside the contract (hard rule #3). Synthetic data.

const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD = TODAY.slice(0, 7);
const PACK_KEY = ['sre', 'local', 'test', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const leg = (account: string, side: 'debit' | 'credit') => ({ account, side, component: 'amount' });
const MAP = {
  rules: [
    ...DEFAULT_RETAIL_POSTING_MAP.rules,
    { kind: 'supplier_advance', legs: [leg('supplier_advances', 'debit'), leg('bank_clearing', 'credit')] },
    { kind: 'supplier_advance_applied', legs: [leg('supplier_payable', 'debit'), leg('supplier_advances', 'credit')] },
  ],
};

/** The declared route a concrete call is, by its template. */
const templates = Object.keys(DECLARED_BODIES).map((key) => {
  const [method, path] = key.split(' ') as [string, string];
  return { key, method, re: new RegExp(`^${path.replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`) };
});
const declaredFor = (method: string, path: string): string | undefined => templates.find((t) => t.method === method && t.re.test(path))?.key;

describe('the money routes\' declared body schemas match their handlers (M32-FR-01)', () => {
  it('names only routes the head office serves, and every money route has a request (where it reads one) and a reply', () => {
    const served = new Set(buildSurface({ signingKey: PACK_KEY, migrationTargetKind: 'rehearsal' }).map((r) => `${r.method} ${r.path}`));
    for (const key of MONEY_ROUTES) expect(served.has(key), key).toBe(true);
    for (const must of ['POST /v1/sales', 'POST /v1/sales/:saleId/returns', 'POST /v1/purchase/suppliers/:supplierId/payments/:paymentId', 'POST /v1/purchase/orders/:poId', 'POST /v1/finance/journals']) {
      expect(DECLARED_BODIES[must]?.request, must).toBeDefined();
      expect(DECLARED_BODIES[must]?.reply, must).toBeDefined();
    }
  });

  it('every body sent and every success reply got — sale, refund, journal, day book, order, advance, payment — fits the declared schema', async () => {
    const h = apiHarness();
    const T = randomUUID();
    await p3Shop(h, T);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const seen = new Map<string, { requests: number; replies: number }>();
    const send = async (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, key?: string) => {
      const declared = method === 'GET' ? undefined : declaredFor(method, path);
      const d = declared === undefined ? undefined : DECLARED_BODIES[declared]!;
      if (d?.request !== undefined) expect(schemaProblems(body ?? {}, d.request as Record<string, unknown>), `${declared} request`).toEqual([]);
      const res = await h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
      if (d !== undefined && declared !== undefined) {
        const s = seen.get(declared) ?? { requests: 0, replies: 0 };
        if (d.request !== undefined) s.requests += 1;
        const success = String(res.status) === d.reply.status || String(res.status) === d.reply.alsoStatus;
        if (success) {
          expect(schemaProblems(res.body, d.reply.schema as Record<string, unknown>), `${declared} reply ${res.status}: ${JSON.stringify(res.body)}`).toEqual([]);
          s.replies += 1;
        }
        seen.set(declared, s);
      }
      return res;
    };
    const call: Call = (method, path, userId, body, key) => send(method, path, userId, body, key);
    const ok = async (p: Promise<{ status: number; body: unknown }>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // ── Sales intake and a refund against it.
    const sale = {
      saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: P3.CASHIER, locationId: P3.STORE, tradingDay: TODAY, committedAt: `${TODAY}T05:00:00.000Z`,
      totalMinor: 23_600, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p-soap', quantityMinor: 2, uom: 'EA', unitPriceMinor: 11_800, lineTotalMinor: 23_600, hsnCode: '34011190', taxRateBps: 1800 }],
      tenders: [{ kind: 'cash', amountMinor: 23_600 }],
    };
    await ok(send('POST', '/v1/sales', P3.CASHIER, sale), 'sale');
    await ok(send('POST', '/v1/sales', P3.CASHIER, sale), 'the same sale again'); // a resend: the same reply shape
    const refund = await withApprovals(h, T, P3.OWNER, 'S-1', {
      returnId: 'RT-1', number: 'RT-1', reasonCode: 'changed_mind', refundMinor: 11_800, refundTender: 'cash', approvedBy: 'u-mgr', processedAt: `${TODAY}T07:00:00Z`,
      lines: [{ productId: 'p-soap', quantityMinor: 1, uom: 'EA', disposition: 'resell' }],
    });
    await ok(send('POST', '/v1/sales/S-1/returns', P3.OWNER, refund), 'refund');

    // ── Journals: the accountant's mapping, the day book, and a hand journal.
    await ok(send('PUT', '/v1/finance/posting-map', P3.MATCHER, MAP), 'map');
    await ok(send('POST', `/v1/finance/day-book/${TODAY}/post`, P3.MATCHER, {}), 'day book');
    await ok(send('POST', `/v1/finance/day-book/${TODAY}/post`, P3.MATCHER, {}), 'day book again (nothing new)');
    await ok(send('POST', '/v1/finance/journals', P3.MATCHER, {
      entryId: 'PC-1', period: PERIOD, documentDate: TODAY, narrative: 'Shop cleaning paid from petty cash, voucher PC-1 (synthetic)', postedBy: P3.MATCHER,
      lines: [{ accountCode: 'shop_expenses', debitMinor: 1_000, creditMinor: 0 }, { accountCode: 'cash_in_hand', debitMinor: 0, creditMinor: 1_000 }],
    }), 'journal');

    // ── Purchase orders (raised, issued), a bill, an advance set against it, and the balance paid.
    const lines = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];
    await issuedOrder(call, 'po-1', lines);
    await received(call, 'grn-1', 'po-1', lines);
    await capturedAndMatched(call, 'inv-1', 'po-1', lines, undefined, 'sup-1', TODAY);
    const advance = { supplierId: 'sup-1', amountMinor: 20_000, paidOn: TODAY, method: 'bank_transfer', reference: 'NEFT-ADV-1', poId: 'po-1' };
    const adv = await approvedBody(h, T, P3.PAYER, P3.PAY_APPROVER, 'supplier_payment', 'advance:adv-1', advance, { advanceId: 'adv-1' }, 20_000);
    await ok(send('POST', '/v1/finance/supplier-advances/adv-1', P3.PAYER, adv), 'advance');
    await ok(send('POST', '/v1/finance/supplier-advances/adv-1', P3.PAYER, adv), 'advance again (already recorded)');
    await ok(send('POST', '/v1/finance/supplier-advances/adv-1/applications/app-1', P3.MATCHER, { amountMinor: 20_000, invoiceId: 'inv-1', appliedOn: TODAY }), 'application');
    const payment = { amountMinor: 30_000, paidOn: TODAY, method: 'cash', reference: 'CASH-PAY-1' };
    const paid = await sentWithApproval(h, T, P3.PAYER, P3.PAY_APPROVER, { kind: 'supplier_payment', subjectRef: 'sup-1/pay-1', pathIds: { supplierId: 'sup-1', paymentId: 'pay-1' }, valueMinor: 30_000 }, payment,
      (b) => send('POST', '/v1/purchase/suppliers/sup-1/payments/pay-1', P3.PAYER, b, 'pay-1'));
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);

    // Every declared route was driven: its request checked (where it reads one) and a success reply checked.
    for (const key of MONEY_ROUTES) {
      expect(seen.get(key)?.replies ?? 0, `${key}: no success reply was checked`).toBeGreaterThan(0);
      if (DECLARED_BODIES[key]!.request !== undefined) expect(seen.get(key)?.requests ?? 0, `${key}: no request was checked`).toBeGreaterThan(0);
    }
  }, 120_000);

  it('a card number on a tender is outside the contract (hard rule #3) — only the token, the last four and the network', () => {
    const request = DECLARED_BODIES['POST /v1/sales']!.request as Record<string, unknown>;
    const base = { saleId: 'S', totalMinor: 100, committedAt: `${TODAY}T05:00:00Z`, packVersion: 1, lines: [{ productId: 'p', quantityMinor: 1, uom: 'EA', unitPriceMinor: 100, lineTotalMinor: 100 }] };
    expect(schemaProblems({ ...base, tenders: [{ kind: 'card', amountMinor: 100, card: { tokenRef: 'tok_1', last4: '4242', network: 'visa' } }] }, request)).toEqual([]);
    expect(schemaProblems({ ...base, tenders: [{ kind: 'card', amountMinor: 100, card: { tokenRef: 'tok_1', last4: '4242', network: 'visa', pan: '4111111111111111' } }] }, request))
      .toEqual(['$.tenders[0].card: "pan" is not allowed']);
    // A body without what the handler refuses without fails the declared schema too.
    expect(schemaProblems({ saleId: 'S' }, request)).toEqual(expect.arrayContaining(['$: missing required "totalMinor"', '$: missing required "lines"']));
  });
});
