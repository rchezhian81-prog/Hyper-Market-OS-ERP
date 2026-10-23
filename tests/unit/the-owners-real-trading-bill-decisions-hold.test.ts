import { describe, it, expect } from 'vitest';
import { checkTaxInvoiceFields, type TaxInvoiceFields } from '../../packages/finance/src/invoice-fields';
import { buildDayBook, postDayBook, DEFAULT_RETAIL_POSTING_MAP, type DayBookSale } from '../../packages/finance/src/index';
import { acceptSale, type IncomingSale } from '../../services/pos/src/index';
import { runOwnerSetup, type SetupClient, type SetupRequest } from '../../packages/migration/src/owner-steps-command';
import { parseCommandLine } from '../../scripts/lib/store-computer.mjs';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';

/**
 * **The owner's real-trading bill decisions (21 Oct 2026, in writing; the CA confirms before switch-on), downstream of the
 * till:** OB-278 — the A1 checker passes one "Invoice-cum-Bill of Supply" (Rule 46A) whose untaxed lines carry no tax, and
 * refuses an untaxed line under a plain "Tax Invoice"; OB-279 — a bill's round off (its CGST and SGST rounded to the rupee)
 * travels to head office, which banks the rounded total without calling it a mismatch, and the day book posts it to its own
 * line so every journal still balances; OB-271 — the owner's `shop` command records the store's place of business for the
 * bill. Synthetic data only.
 */

const LINE: TaxInvoiceFields = {
  supplierGstin: '33ABCDE1234F1Z5', invoiceNumber: 'L1-000123', invoiceDate: '2026-10-21', hsnCode: '070999',
  taxableMinor: 1_000, rateBps: 0, placeOfSupply: 'intra_state', taxComponents: [],
};

describe('OB-278 · A1 — the checker takes an Invoice-cum-Bill of Supply, and judges each line by what it is', () => {
  it('an untaxed line passes on an Invoice-cum-Bill of Supply, carrying no tax component', () => {
    expect(checkTaxInvoiceFields({ ...LINE, documentType: 'Invoice-cum-Bill of Supply' })).toMatchObject({ valid: true, problems: [] });
    // A taxed line on the same combined bill still needs its CGST + SGST.
    expect(checkTaxInvoiceFields({ ...LINE, documentType: 'Invoice-cum-Bill of Supply', rateBps: 500, taxComponents: ['CGST', 'SGST'] }).valid).toBe(true);
    expect(checkTaxInvoiceFields({ ...LINE, documentType: 'Invoice-cum-Bill of Supply', rateBps: 500, taxComponents: [] }).valid).toBe(false);
  });

  it('an untaxed line under a plain "Tax Invoice" is a problem, named; an untaxed line with tax is a problem; a bare "Bill of Supply" is not passed', () => {
    const plain = checkTaxInvoiceFields({ ...LINE, documentType: 'Tax Invoice' });
    expect(plain.valid).toBe(false);
    expect(plain.problems.join('; ')).toContain('an untaxed line is billed on an "Invoice-cum-Bill of Supply"');
    expect(checkTaxInvoiceFields({ ...LINE, documentType: 'Invoice-cum-Bill of Supply', taxComponents: ['CGST', 'SGST'] }).problems.join('; ')).toContain('carries no CGST');
    expect(checkTaxInvoiceFields({ ...LINE, documentType: 'Bill of Supply' }).valid).toBe(false);
  });
});

describe('OB-279 · OB-285 — the round off travels to head office, is banked as the rounded total, and posts to its own line', () => {
  // ₹1.00 at 12%: 5p + 6p of GST each round down to ₹0 — the bill is 89 paise, 11 below its line (OB-285: never above).
  const record = {
    id: 'S-R1', number: 'L1-000124', laneId: 'lane-1', cashierId: 'u-cashier', tradingDay: '2026-10-21', committedAt: '2026-10-21T05:00:00.000Z',
    lines: [{ productId: 'P-SWEET', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: 100, taxRateBps: 1_200, hsnCode: '170490' }],
    tenders: [{ kind: 'cash', amount: { minor: 89, currency: 'INR' }, status: 'settled' }],
    total: 89, netMinor: 89, taxMinor: 0, roundOffMinor: -11, currency: 'INR',
  };

  it('the box sends the round off (whole paise, below 0, at most ₹1); one that cannot be one — or is ABOVE 0 (OB-285) — is not sent', () => {
    expect(toCloudSale(record, 3)).toMatchObject({ totalMinor: 89, roundOffMinor: -11 });
    expect(toCloudSale({ ...record, roundOffMinor: -250 }, 3)).not.toHaveProperty('roundOffMinor');
    expect(toCloudSale({ ...record, roundOffMinor: 0 }, 3)).not.toHaveProperty('roundOffMinor');
    expect(toCloudSale({ ...record, total: 200, roundOffMinor: 100 }, 3)).not.toHaveProperty('roundOffMinor');
  });

  it('OB-285: head office never takes a bill above its lines — a round off above 0 is not counted, so the bill shows as not adding up', () => {
    const ctx = { catalogue: new Map(), currentPackVersion: 3, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-21T06:00:00.000Z' };
    const sent = { ...(toCloudSale(record, 3) as IncomingSale), totalMinor: 200, tenders: [{ kind: 'cash', amountMinor: 200 }], roundOffMinor: 100 } as IncomingSale;
    expect(acceptSale(sent, ctx).exceptions.map((e) => e.kind)).toContain('lines_do_not_sum_to_total');
  });

  it('head office: the lines plus the round off are the total — no "lines do not sum" finding; without it, there is one', () => {
    const ctx = { catalogue: new Map(), currentPackVersion: 3, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: '2026-10-21T06:00:00.000Z' };
    const sent = toCloudSale(record, 3) as IncomingSale;
    expect(acceptSale(sent, ctx).exceptions.map((e) => e.kind)).not.toContain('lines_do_not_sum_to_total');
    const { roundOffMinor: _gone, ...without } = sent;
    void _gone;
    expect(acceptSale(without as IncomingSale, ctx).exceptions.map((e) => e.kind)).toContain('lines_do_not_sum_to_total');
  });

  it('the day book: the sale voucher takes the rounded total; the round off posts to `round_off` (down only — OB-285); every journal balances', () => {
    const exact: DayBookSale = { saleId: 'S-R1', tradingDay: '2026-10-21', totalMinor: 10_500, lines: [{ productId: 'P-DAL', quantityMinor: 1, lineTotalMinor: 10_500, taxRateBps: 500 }], tenders: [{ kind: 'cash', amountMinor: 10_500 }] };
    const down: DayBookSale = { saleId: 'S-R2', tradingDay: '2026-10-21', totalMinor: 89, lines: [{ productId: 'P-SWEET', quantityMinor: 1, lineTotalMinor: 100, taxRateBps: 1_200 }], tenders: [{ kind: 'cash', amountMinor: 89 }], roundOffMinor: -11 };
    const book = buildDayBook({ tradingDay: '2026-10-21', sales: [exact, down], returns: [], originalSales: new Map(), taxRateOf: () => undefined, alreadyPosted: new Map() });
    expect(book.exceptions).toEqual([]);
    expect(book.aggregates.find((a) => a.kind === 'sale')?.components).toMatchObject({ total: 10_589, round_off_up: 0, round_off_down: 11 });
    const posted = postDayBook(book, DEFAULT_RETAIL_POSTING_MAP, 'INR');
    expect(posted.exceptions).toEqual([]);
    const sale = posted.journals.find((j) => j.aggregate.kind === 'sale')!.entry;
    expect(sale.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ account: 'round_off', side: 'debit', amount: expect.objectContaining({ minor: 11 }) }),
    ]));
    for (const j of posted.journals) expect(j.entry.totalDebit.minor).toBe(j.entry.totalCredit.minor);
    // A round off the lines and total do not bear out is an exception, never posted.
    const wrong = buildDayBook({ tradingDay: '2026-10-21', sales: [{ ...down, roundOffMinor: -50 }], returns: [], originalSales: new Map(), taxRateOf: () => undefined, alreadyPosted: new Map() });
    expect(wrong.exceptions.map((e) => e.reason)).toEqual(['lines_do_not_sum_to_total']);
    // OB-285: a bill ABOVE its lines is refused even when it "adds up" — ₹105 of dal booked at ₹106.
    const above = buildDayBook({ tradingDay: '2026-10-21', sales: [{ ...exact, totalMinor: 10_600, tenders: [{ kind: 'cash', amountMinor: 10_600 }], roundOffMinor: 100 }], returns: [], originalSales: new Map(), taxRateOf: () => undefined, alreadyPosted: new Map() });
    expect(above.exceptions.map((e) => e.reason)).toEqual(['lines_do_not_sum_to_total']);
  });
});

describe('OB-271 · Rule 46(a) — the owner\'s `shop` command records the store\'s place of business for the bill', () => {
  const SHOP = { as: 'u-it', approver: 'u-owner', company: 'SRE', 'legal-name': 'SRE Hyper Market Private Limited', gstin: '33AABCS1429B1Z1', store: 'SRE-MAIN', 'store-name': 'SRE Hyper Market' };
  const world = () => {
    const calls: SetupRequest[] = [];
    const client: SetupClient = { request: async (r) => { calls.push(r); return { status: 201, body: {} }; } };
    const deps = { client, confirm: async () => true, askPin: async () => '135790', verifyPin: () => 'ok' as const };
    const run = (values: Record<string, string>) => runOwnerSetup({ step: 'shop', tenantId: 'ab000000-0000-4000-8000-000000000271', targetKind: 'rehearsal', demoTenantIds: ['pilot-demo'], values, today: '2026-10-21', now: () => '2026-10-21T10:00:00.000Z' }, deps);
    return { calls, run };
  };

  it('`--place-of-business "line 1 | line 2"` is said in the plan and sent with the store, as lines', async () => {
    const w = world();
    const out = await w.run({ ...SHOP, 'place-of-business': ' 12 Main Road |  | Tiruppur 641601, Tamil Nadu ' });
    expect(out.exitCode, out.lines.join('\n')).toBe(0);
    expect(out.lines.join('\n')).toContain('its place of business for the bill: 12 Main Road, Tiruppur 641601, Tamil Nadu');
    const store = w.calls.find((c) => c.path === '/v1/org/nodes/SRE-MAIN')!;
    expect(store.body).toMatchObject({ kind: 'branch', gstin: '33AABCS1429B1Z1', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'] });
    expect(store.idempotencyKey).toMatch(/^owner-setup-store-SRE-MAIN-place-[0-9a-f]{8}$/);
  });

  it('without it the store is recorded as before; more than 4 lines, or a line over 80 characters, is refused before any call', async () => {
    const w = world();
    expect((await w.run(SHOP)).exitCode).toBe(0);
    const store = w.calls.find((c) => c.path === '/v1/org/nodes/SRE-MAIN')!;
    expect(store.body).not.toHaveProperty('placeOfBusiness');
    expect(store.idempotencyKey).toBe('owner-setup-store-SRE-MAIN');
    const w2 = world();
    const tooMany = await w2.run({ ...SHOP, 'place-of-business': 'a | b | c | d | e' });
    expect(tooMany.exitCode).toBe(2);
    expect(tooMany.lines.join('\n')).toContain('--place-of-business');
    expect((await w2.run({ ...SHOP, 'place-of-business': 'x'.repeat(81) })).exitCode).toBe(2);
    expect(w2.calls).toEqual([]);
  });

  it('the store-computer tool takes the flag on `shop`', () => {
    const parsed = parseCommandLine(['shop', '--as', 'u-owner', '--place-of-business', '12 Main Road | Tiruppur']) as { problems?: readonly string[] };
    expect(parsed.problems ?? []).toEqual([]);
  });
});
