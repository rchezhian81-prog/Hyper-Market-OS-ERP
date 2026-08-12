import { describe, it, expect } from 'vitest';
import {
  acceptSale, summariseIntake, posRoutes,
  type IncomingSale, type IntakeContext, type SaleException, type PosDeps,
} from '../../services/pos/src/index';
import { buildRouter, handle, MemoryIdempotencyStore, type HttpRequest } from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import type { CatalogueProduct } from '../../packages/catalogue/src/catalogue';

// API-05 · §31.1 · hard rules #1, #2, #10 · P-08 · M12–M15.
// The endpoint a till talks to AFTER it has already sold something.

const product = (id: string, over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  productId: id, sku: `SKU-${id}`, name: `Product ${id}`, baseUom: 'each',
  unitPriceMinor: 5_000, taxBps: 500, mrpMinor: 9_000, status: 'active', ...over,
});

const CATALOGUE = new Map<string, CatalogueProduct>([
  ['P1', product('P1')],
  ['P2', product('P2', { unitPriceMinor: 2_500 })],
  ['P3', product('P3', { recallBlock: true })],
  ['P4', product('P4', { batchTracked: true })], // perishable/lot-tracked: a sale must carry its batch
]);

const sale = (over: Partial<IncomingSale> = {}): IncomingSale => ({
  saleId: 'S-001', receiptNumber: 'R-001', laneId: 'lane-1', cashierId: 'u-meena',
  tradingDay: '2026-08-07', committedAt: '2026-08-07T10:00:00Z',
  totalMinor: 5_000, currency: 'INR', packVersion: 10,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }],
  tenders: [{ kind: 'cash', amountMinor: 5_000 }],
  ...over,
});

const ctx = (over: Partial<IntakeContext> = {}): IntakeContext => ({
  catalogue: CATALOGUE, currentPackVersion: 10,
  // Two answers, not two collections to search. The port used to hand over every receipt number
  // the shop had ever issued and every sale it had ever banked so that one lookup could be run
  // against each — a performance defect written into a type, paid on every scan at the lane.
  saleHoldingThisReceipt: undefined, alreadyBanked: false,
  now: '2026-08-07T12:00:00Z', ...over,
});

const kinds = (e: readonly SaleException[]): string[] => e.map((x) => x.kind);

describe('the server does not get to say no', () => {
  it('banks a clean sale', () => {
    const r = acceptSale(sale(), ctx());
    const banked: true = r.banked;
    expect(banked).toBe(true);
    expect(r.exceptions).toEqual([]);
    expect(r.detail).toContain('nothing to report');
  });

  it('banks a sale for a product the catalogue has never heard of', () => {
    // By the time this arrives the money is in the drawer and the customer has gone. A refusal
    // the till acts on deletes a sale that really happened while the cash for it sits in the till.
    const r = acceptSale(sale({
      lines: [{ productId: 'P-UNKNOWN', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }],
    }), ctx());
    expect(r.banked).toBe(true);
    expect(kinds(r.exceptions)).toContain('product_not_in_catalogue');
    expect(r.exceptions[0]?.ownerAction).toContain('The sale stands either way');
  });

  it('banks a sale whose tenders do not add up, and says whose day will not balance', () => {
    const r = acceptSale(sale({ tenders: [{ kind: 'cash', amountMinor: 4_500 }] }), ctx());
    expect(r.banked).toBe(true);
    const e = r.exceptions.find((x) => x.kind === 'tender_does_not_sum_to_total')!;
    expect(e.differenceMinor).toBe(-500);
    expect(e.ownerAction).toContain('before the cash is banked');
  });

  it('banks a sale whose lines do not add up to its total', () => {
    const r = acceptSale(sale({
      totalMinor: 5_000,
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 4_000 }],
      tenders: [{ kind: 'cash', amountMinor: 5_000 }],
    }), ctx());
    expect(kinds(r.exceptions)).toContain('lines_do_not_sum_to_total');
    expect(r.banked).toBe(true);
  });

  it('reports EVERY finding at once rather than the first', () => {
    const r = acceptSale(sale({
      packVersion: 2,
      lines: [
        { productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 4_000, lineTotalMinor: 4_000 },
        { productId: 'P-GONE', quantityMinor: 1, uom: 'each', unitPriceMinor: 1_000, lineTotalMinor: 1_000 },
      ],
      totalMinor: 5_000, tenders: [{ kind: 'cash', amountMinor: 4_000 }],
    }), ctx());
    expect(new Set(kinds(r.exceptions))).toEqual(new Set([
      'tender_does_not_sum_to_total', 'sold_a_recalled_product',
      'price_differs_from_catalogue', 'product_not_in_catalogue', 'sold_on_a_stale_pack',
    ]));
  });

  it('offers no way to correct a sale (hard rule #2)', async () => {
    // The customer paid what the till charged. Rewriting it to the catalogue price makes the books
    // agree with the catalogue and disagree with reality; a correction is a compensating document.
    const service = await import('../../services/pos/src/index');
    for (const name of Object.keys(service)) {
      expect(name).not.toMatch(/correctSale|updateSale|adjustSale|amendSale|repriceSale|voidSale/i);
    }
  });
});

describe('a recall outranks every number on the list', () => {
  it('marks a recalled product CRITICAL and puts it first', () => {
    const r = acceptSale(sale({
      packVersion: 8, totalMinor: 9_000,
      lines: [
        { productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000 },
        { productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 4_000, lineTotalMinor: 4_000 },
      ],
      tenders: [{ kind: 'cash', amountMinor: 8_000 }],
    }), ctx());

    // The tender is out by ₹10 and the recall is about a person. The recall goes first.
    expect(r.exceptions[0]?.kind).toBe('sold_a_recalled_product');
    expect(r.exceptions[0]?.severity).toBe('critical');
    expect(r.exceptions[0]?.ownerAction).toContain('ACT NOW');
    expect(r.exceptions[0]?.ownerAction).toContain('in a customer\'s hands');
  });

  it('says the lane\'s pack predated the block, so the lane is not blamed', () => {
    const r = acceptSale(sale({
      packVersion: 8,
      lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }],
    }), ctx());
    expect(r.exceptions[0]?.detail).toContain('its pack (v8) predates the block');
  });
});

describe('a batch-tracked good must carry its batch for the recall trace (M10-FR-03)', () => {
  const p4Line = (over: Record<string, unknown> = {}) => ({ productId: 'P4', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000, ...over });

  it('flags a batch-tracked product sold with no batch — banked, but a material finding', () => {
    const r = acceptSale(sale({ lines: [p4Line()] }), ctx());
    expect(r.banked).toBe(true); // never refused
    const e = r.exceptions.find((x) => x.kind === 'batch_tracked_sold_without_batch')!;
    expect(e.severity).toBe('material');
    expect(e.ownerAction).toContain('capturing the batch');
  });

  it('does NOT flag when the batch is captured', () => {
    const r = acceptSale(sale({ lines: [p4Line({ batchId: 'LOT-42', batchExpiry: '2026-12-31' })] }), ctx());
    expect(kinds(r.exceptions)).not.toContain('batch_tracked_sold_without_batch');
  });

  it('treats an empty-string batch as no batch', () => {
    const r = acceptSale(sale({ lines: [p4Line({ batchId: '   ' })] }), ctx());
    expect(kinds(r.exceptions)).toContain('batch_tracked_sold_without_batch');
  });

  it('does NOT flag a non-batch-tracked product sold without a batch (P1)', () => {
    const r = acceptSale(sale(), ctx());
    expect(kinds(r.exceptions)).not.toContain('batch_tracked_sold_without_batch');
  });
});

describe('a price above MRP is a legal breach, not a variance (B1 / M03·M12)', () => {
  it('flags a line charged above MRP as CRITICAL and banks it (the money is in the drawer)', () => {
    // P1: MRP 9000, charged 9500.
    const r = acceptSale(sale({
      totalMinor: 9_500,
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 9_500, lineTotalMinor: 9_500 }],
      tenders: [{ kind: 'cash', amountMinor: 9_500 }],
    }), ctx());
    expect(r.banked).toBe(true);
    const e = r.exceptions.find((x) => x.kind === 'sold_above_mrp')!;
    expect(e.severity).toBe('critical');
    expect(e.ownerAction).toContain('ACT NOW');
    expect(e.differenceMinor).toBe(500);
  });

  it('subsumes the ordinary price-difference finding for that line (the overcharge is not buried)', () => {
    const r = acceptSale(sale({
      totalMinor: 9_500,
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 9_500, lineTotalMinor: 9_500 }],
      tenders: [{ kind: 'cash', amountMinor: 9_500 }],
    }), ctx());
    expect(kinds(r.exceptions)).toContain('sold_above_mrp');
    expect(kinds(r.exceptions)).not.toContain('price_differs_from_catalogue');
  });

  it('ranks the MRP breach first, even above a tender mismatch', () => {
    const r = acceptSale(sale({
      totalMinor: 9_500,
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 9_500, lineTotalMinor: 9_500 }],
      tenders: [{ kind: 'cash', amountMinor: 9_400 }], // also out by ₹1
    }), ctx());
    expect(r.exceptions[0]?.kind).toBe('sold_above_mrp');
    expect(r.exceptions[0]?.severity).toBe('critical');
  });

  it('does NOT flag a line at or below MRP', () => {
    expect(kinds(acceptSale(sale({
      totalMinor: 9_000, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 9_000, lineTotalMinor: 9_000 }],
      tenders: [{ kind: 'cash', amountMinor: 9_000 }],
    }), ctx()).exceptions)).not.toContain('sold_above_mrp'); // exactly MRP is allowed
  });

  it('cannot breach an MRP the product does not carry', () => {
    const noMrp = new Map(CATALOGUE);
    noMrp.set('P1', product('P1', { mrpMinor: undefined }));
    const r = acceptSale(sale({
      totalMinor: 99_999, lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 99_999, lineTotalMinor: 99_999 }],
      tenders: [{ kind: 'cash', amountMinor: 99_999 }],
    }), ctx({ catalogue: noMrp }));
    expect(kinds(r.exceptions)).not.toContain('sold_above_mrp');
  });
});

describe('a price difference is usually nobody\'s fault', () => {
  it('is informational when the lane was behind — it charged what it held', () => {
    // Pricing from the pack it holds is exactly what a lane is supposed to do offline.
    const r = acceptSale(sale({
      packVersion: 7,
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 4_500, lineTotalMinor: 4_500 }],
      totalMinor: 4_500, tenders: [{ kind: 'cash', amountMinor: 4_500 }],
    }), ctx());
    const e = r.exceptions.find((x) => x.kind === 'price_differs_from_catalogue')!;
    expect(e.severity).toBe('informational');
    expect(e.ownerAction).toContain('the ordinary explanation');
    expect(e.differenceMinor).toBe(-500);
  });

  it('is MATERIAL when the lane was on the current pack and still differed', () => {
    const r = acceptSale(sale({
      packVersion: 10,
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 4_500, lineTotalMinor: 4_500 }],
      totalMinor: 4_500, tenders: [{ kind: 'cash', amountMinor: 4_500 }],
    }), ctx());
    const e = r.exceptions.find((x) => x.kind === 'price_differs_from_catalogue')!;
    expect(e.severity).toBe('material');
    expect(e.ownerAction).toContain('That is not a timing difference');
  });

  it('lets the owner set a tolerance below which nobody is told', () => {
    const r = acceptSale(sale({
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 4_999, lineTotalMinor: 4_999 }],
      totalMinor: 4_999, tenders: [{ kind: 'cash', amountMinor: 4_999 }],
    }), ctx({ priceToleranceMinor: 100 }));
    expect(kinds(r.exceptions)).not.toContain('price_differs_from_catalogue');
  });
});

describe('what the lane\'s own state says', () => {
  it('flags a lane that has not taken a pack in a long time, and says it is still selling', () => {
    const r = acceptSale(sale({ packVersion: 3 }), ctx());
    const e = r.exceptions.find((x) => x.kind === 'sold_on_a_stale_pack')!;
    expect(e.ownerAction).toContain('It is still selling — that is by design');
    expect(e.ownerAction).toContain('Check why its updates are not arriving');
  });

  it('does not flag a lane one or two versions behind — that is normal', () => {
    expect(kinds(acceptSale(sale({ packVersion: 8 }), ctx()).exceptions)).not.toContain('sold_on_a_stale_pack');
  });

  it('flags a lane whose clock is ahead of the server', () => {
    const r = acceptSale(sale({ committedAt: '2026-08-09T10:00:00Z' }), ctx());
    const e = r.exceptions.find((x) => x.kind === 'committed_in_the_future')!;
    expect(e.ownerAction).toContain('land in the wrong trading day');
  });

  it('does NOT flag a sale that arrives days late — late is not wrong', () => {
    // A lane back from three days offline sends hundreds of old sales. That is the design working.
    const r = acceptSale(sale({ committedAt: '2026-08-04T10:00:00Z' }), ctx());
    expect(r.exceptions).toEqual([]);
  });

  it('flags two sales claiming one receipt number', () => {
    const r = acceptSale(sale({ saleId: 'S-002' }), ctx({ saleHoldingThisReceipt: 'S-001' }));
    const e = r.exceptions.find((x) => x.kind === 'receipt_number_reused')!;
    expect(e.detail).toContain('S-001');
    expect(e.ownerAction).toContain('Both sales stand');
  });
});

describe('a resend is not a second sale (§31.1)', () => {
  it('recognises a sale it has already banked', () => {
    const r = acceptSale(sale(), ctx({ alreadyBanked: true }));
    expect(r.alreadyBanked).toBe(true);
    expect(r.banked).toBe(true);
    expect(r.detail).toContain('a resend, not a second sale');
  });
});

describe('a batch from a lane back after three days offline', () => {
  // Two versions behind: every line differs in price, and all of it is explained by the pack the
  // lane held. Exactly the shape of a lane coming back from a long weekend offline.
  const results = Array.from({ length: 40 }, (_, i) => acceptSale(sale({
    saleId: `S-${i}`, receiptNumber: `R-${i}`, packVersion: 8,
    lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 4_500, lineTotalMinor: 4_500 }],
    totalMinor: 4_500, tenders: [{ kind: 'cash', amountMinor: 4_500 }],
  }), ctx()));

  it('COUNTS the informational findings rather than listing them', () => {
    // Forty sales priced from the pack the lane held produce forty identical explained findings.
    // Printing them buries the one that is not explained.
    const s = summariseIntake(results);
    expect(s.banked).toBe(40);
    expect(s.informational).toBe(40);
    expect(s.critical).toEqual([]);
    expect(s.ownerAction).toBe('nothing — every sale came in clean');
  });

  it('lifts a single critical finding out of forty ordinary ones', () => {
    const withRecall = [...results, acceptSale(sale({
      saleId: 'S-99', receiptNumber: 'R-99', packVersion: 8,
      lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }],
    }), ctx())];
    const s = summariseIntake(withRecall);
    expect(s.critical).toHaveLength(1);
    expect(s.ownerAction).toContain('need acting on now, not at day end');
  });

  it('collapses resends without counting them as sales', () => {
    const s = summariseIntake([
      ...results.slice(0, 3),
      acceptSale(sale({ saleId: 'S-0' }), ctx({ alreadyBanked: true })),
    ]);
    expect(s.banked).toBe(3);
    expect(s.resends).toBe(1);
  });
});

describe('the service on the kernel', () => {
  const ACCESS = new AccessControl(
    [{ id: 'lane', name: 'Lane', permissions: ['pos.sale.sync', 'pos.sale.read', 'pos.exception.read'] }],
    [{ userId: 'lane-1', roleId: 'lane', branchScope: ['b-main'] }],
  );

  const makeKernel = () => {
    const banked = new Set<string>();
    const recorded: SaleException[] = [];
    const deps: PosDeps = {
      catalogue: () => CATALOGUE,
      currentPackVersion: () => 10,
      saleHoldingReceipt: () => undefined,
      isBanked: (_t, saleId) => banked.has(saleId),
      bankSale: (_t, s) => { banked.add(s.saleId); },
      recordExceptions: (_t, e) => { recorded.push(...e); },
      openExceptions: () => recorded,
      now: () => '2026-08-07T12:00:00Z',
    };
    const built = buildRouter(posRoutes(deps));
    expect(built.ok, built.refusals.map((r) => r.detail).join('; ')).toBe(true);
    return {
      opts: {
        router: built.router!,
        authenticate: () => ({ tenantId: 't-sre', userId: 'lane-1', branchId: 'b-main' }),
        access: ACCESS, idempotency: new MemoryIdempotencyStore(), newTraceId: () => 'trace-1',
      },
      banked, recorded,
    };
  };

  const post = (body: unknown, key = 'k-1'): HttpRequest => ({
    method: 'POST', path: '/v1/sales', body,
    headers: { authorization: 'Bearer good', 'idempotency-key': key },
  });

  it('answers 202 — banked, with work attached — never 4xx for a sale that happened', async () => {
    const k = makeKernel();
    const res = await handle(k.opts, post(sale({
      lines: [{ productId: 'P-GONE', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }],
    })));
    expect(res.status).toBe(202);
    expect((res.body as { banked: boolean }).banked).toBe(true);
    expect(k.banked.has('S-001')).toBe(true);
    expect(k.recorded).toHaveLength(1);
  });

  it('banks an above-MRP sale (202) and records the critical breach for the day-end review', async () => {
    const k = makeKernel();
    const res = await handle(k.opts, post(sale({
      totalMinor: 9_500,
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 9_500, lineTotalMinor: 9_500 }],
      tenders: [{ kind: 'cash', amountMinor: 9_500 }],
    })));
    expect(res.status).toBe(202); // the sale happened; it is never refused
    expect(k.recorded.some((e) => e.kind === 'sold_above_mrp' && e.severity === 'critical')).toBe(true);
  });

  it('refuses only what cannot be READ as a sale, and tells the lane to keep it', async () => {
    const k = makeKernel();
    const res = await handle(k.opts, post({ nonsense: true }));
    expect(res.status).toBe(400);
    const err = (res.body as { error: { code: string; nextSafeAction: string } }).error;
    expect(err.code).toBe('not_readable_as_a_sale');
    expect(err.nextSafeAction).toContain('Do not discard it at the lane');
  });

  it('banks one sale however many times the lane resends it', async () => {
    const k = makeKernel();
    const req = post(sale());
    await handle(k.opts, req);
    await handle(k.opts, req);
    await handle(k.opts, req);
    expect(k.banked.size).toBe(1);
    expect(k.recorded).toHaveLength(0);
  });

  it('takes sales in any order, because a lane back from offline sends them in none', async () => {
    const k = makeKernel();
    for (const id of ['S-9', 'S-3', 'S-7', 'S-1']) {
      const res = await handle(k.opts, post(sale({ saleId: id, receiptNumber: `R-${id}` }), `k-${id}`));
      expect(res.status).toBe(202);
    }
    expect(k.banked.size).toBe(4);
  });

  it('serves the open exceptions with the critical ones lifted out', async () => {
    const k = makeKernel();
    await handle(k.opts, post(sale({
      lines: [{ productId: 'P3', quantityMinor: 1, uom: 'each', unitPriceMinor: 5_000, lineTotalMinor: 5_000 }],
    })));
    const res = await handle(k.opts, {
      method: 'GET', path: '/v1/sales/exceptions', headers: { authorization: 'Bearer good' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { critical: unknown[] }).critical).toHaveLength(1);
  });
});
