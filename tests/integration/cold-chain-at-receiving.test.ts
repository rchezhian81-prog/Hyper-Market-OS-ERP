import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { receiptRuleFor } from '../../services/inventory/src/goods-receipt';
import { COLD_CHAIN_CLASS_DEFAULTS } from '../../packages/fulfilment/src/packing';

/**
 * **SF-07 — receiving takes the cold-chain rule from head office's PRODUCT MASTER and requires temperature evidence; a
 * delivery with none, or out of range, is HELD for a second person (Wave 3 · audit step 3 · M07-FR-02 · M10-FR-02 ·
 * D05-FR-04 · §28 · P-01 · P-08 · owner decision 9 Oct 2026, "3 and A").**
 *
 * The audit's case: a chilled, batch-tracked product received with a future expiry and NO temperature — the receiving rule
 * carried only `batchTracked`, so the delivery was 201 and all 10 sellable; the master's handling class and limits were never
 * read. Now the rule is resolved from the product master: a cold class (chilled / frozen / raw meat) or a product with limits
 * of its own is a cold-chain item, judged by its own limits else the approved class default (the SAME table the pack uses).
 * Owner's decision: a cold-chain line with no temperature is RECEIVED but HELD in quarantine — never sellable — until a second
 * person (never the receiver) releases or returns it; too warm, or too cold, is held the same way. A product whose master
 * names no handling class is received normally and the record SAYS `handling_unknown` ("A"). Synthetic data (hard rule #7).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-09T09:00:00.000Z';
const WH = 'wh-1';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

interface Grn {
  grnId: string; availableMinor: number; governanceFlags: string[];
  captured: { requiresApproval: boolean; lines: { lineId: string; disposition: string; sellableMinor: number; quarantinedMinor: number }[]; discrepancies: { kind: string; detail: string; requiresApproval: boolean }[] };
}

const req = (h: ApiHarness, method: 'POST' | 'GET', path: string, userId: string, key?: string, body?: unknown, query?: Readonly<Record<string, string>>) =>
  h.request({ method, path, userId, tenantId: A, ...(key === undefined ? {} : { idempotencyKey: key }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
const line = (productId: string, extra: Record<string, unknown> = {}) =>
  ({ lineId: 'L1', productId, orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 4000, currency: 'INR' }, condition: 'good', ...extra });
const receive = (h: ApiHarness, grnId: string, lines: Record<string, unknown>[], userId = 'u-recv') =>
  req(h, 'POST', `/v1/inventory/goods-receipt/${grnId}`, userId, grnId, { warehouseId: WH, receivedOnDate: '2026-10-09', currency: 'INR', lines });
const grnOf = (res: { body: unknown }): Grn => (res.body as { grn: Grn }).grn;
const onHand = async (h: ApiHarness, productId: string): Promise<number> =>
  ((await req(h, 'GET', '/v1/inventory/availability', 'u-owner', undefined, undefined, { productId })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);

const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const masterProduct = (sku: string, name: string, extra: Record<string, unknown>) =>
  ({ sku, name, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft', ...extra });

/**
 * The cast; the published catalogue (batch tracking — paneer is batch-tracked, as in the audit's fixture); and head office's
 * PRODUCT MASTER: paneer chilled with its own limits (−2 °C to 4 °C), ice cream frozen with no limits of its own (the approved
 * frozen default, −15 °C), dal ambient. `p-mystery` is on the catalogue but the master names no handling class for it.
 */
async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-recv', 'store_manager'); // receives — never releases their own delivery
  await h.provisionRole(A, 'u-boss', 'store_manager'); // the second person
  await h.provisionRole(A, 'u-box', 'cashier');        // the store computer's sync identity
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' }, barcodes: [], products: [
      { productId: 'p-paneer', sku: 'p-paneer', name: 'Fresh paneer 200g', unitPriceMinor: 9_000, taxBps: 500, status: 'active', uom: 'ea', batchTracked: true },
      { productId: 'p-icecream', sku: 'p-icecream', name: 'Vanilla ice cream 1L', unitPriceMinor: 25_000, taxBps: 1800, status: 'active', uom: 'ea', batchTracked: false },
      { productId: 'p-dal', sku: 'p-dal', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
      { productId: 'p-mystery', sku: 'p-mystery', name: 'New line, not yet classified', unitPriceMinor: 5_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
    ] } },
  }));
  const publish = async (productId: string, product: Record<string, unknown>) =>
    expect((await req(h, 'POST', `/v1/catalogue/products/${productId}/publish`, 'u-owner', `pub-${productId}`, { product, categories: [GROCERY] })).status).toBe(201);
  await publish('p-paneer', masterProduct('p-paneer', 'Fresh paneer 200g', { handling: 'chilled', coldChain: { minTenthsC: -20, maxTenthsC: 40 } }));
  await publish('p-icecream', masterProduct('p-icecream', 'Vanilla ice cream 1L', { handling: 'frozen' }));
  await publish('p-dal', masterProduct('p-dal', 'Toor dal 1kg', { handling: 'ambient' }));
  expect((await req(h, 'POST', '/v1/inventory/receipt-policy', 'u-owner', 'pol', { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 })).status).toBe(201);
  return h;
}

const PANEER = (extra: Record<string, unknown> = {}) => line('p-paneer', { batchId: 'B-1', expiry: '2026-10-20', ...extra });

describe('SF-07 — the cold-chain rule comes from the product master', () => {
  it('the audit\'s case — a chilled, batch-tracked delivery with a future expiry and NO temperature — is received but HELD: nothing sellable, a second person must decide', async () => {
    const h = await seeded();
    const res = await receive(h, 'g-audit', [PANEER()]);
    expect(res.status).toBe(201); // never refused at the dock: the goods are in the building
    const g = grnOf(res);
    expect(g.availableMinor).toBe(0);
    expect(g.captured.lines[0]).toMatchObject({ disposition: 'quarantine', sellableMinor: 0, quarantinedMinor: 10 });
    expect(g.captured.discrepancies).toEqual([expect.objectContaining({ kind: 'temperature_not_recorded', requiresApproval: true })]);
    expect(g.governanceFlags).toEqual(['no_purchase_order']);
    expect(await onHand(h, 'p-paneer')).toBe(0);
    // It waits on the review list for a disposition.
    expect(((await req(h, 'GET', '/v1/inventory/goods-receipt/g-audit', 'u-owner')).body as { awaitingDisposition: string[] }).awaitingDisposition).toEqual(['L1']);
  });

  it('a second person — never the receiver — checks the goods and RELEASES them to stock, once; or returns them, and nothing reaches the shelf', async () => {
    const h = await seeded();
    await receive(h, 'g-release', [PANEER()]);
    const dispose = (userId: string, disposition: string, key: string) =>
      req(h, 'POST', '/v1/inventory/goods-receipt/g-release/lines/L1/disposition', userId, key, { disposition, reason: 'probed at 3 °C on the dock; packs cold and sealed' });
    expect(codeOf(await dispose('u-recv', 'accept', 'd-self'))).toBe('self_approval');
    expect(await onHand(h, 'p-paneer')).toBe(0);
    expect((await dispose('u-boss', 'accept', 'd-ok')).status).toBe(200);
    expect(await onHand(h, 'p-paneer')).toBe(10);

    await receive(h, 'g-return', [PANEER({ batchId: 'B-2' })]);
    expect((await req(h, 'POST', '/v1/inventory/goods-receipt/g-return/lines/L1/disposition', 'u-boss', 'd-ret', { disposition: 'return', reason: 'no reading and the van was warm' })).status).toBe(200);
    expect(await onHand(h, 'p-paneer')).toBe(10); // the returned delivery never reached the shelf
  });

  it('judged by the PRODUCT\'s own limits: 3 °C sells; 4.5 °C (above its 4 °C) is held; −5 °C (below its −2 °C, frozen solid) is held', async () => {
    const h = await seeded();
    expect(grnOf(await receive(h, 'g-cold-ok', [PANEER({ temperatureC: 3 })]))).toMatchObject({ availableMinor: 10 });
    const warm = grnOf(await receive(h, 'g-warm', [PANEER({ batchId: 'B-2', temperatureC: 4.5 })]));
    expect(warm.availableMinor).toBe(0);
    expect(warm.captured.discrepancies).toEqual([expect.objectContaining({ kind: 'temperature_breach', requiresApproval: true })]);
    expect(warm.captured.discrepancies[0]!.detail).toContain('above the 4°C limit');
    const frozenSolid = grnOf(await receive(h, 'g-frozen-solid', [PANEER({ batchId: 'B-3', temperatureC: -5 })]));
    expect(frozenSolid.availableMinor).toBe(0);
    expect(frozenSolid.captured.discrepancies[0]!.detail).toContain('below the -2°C limit');
    expect(await onHand(h, 'p-paneer')).toBe(10);
  });

  it('a frozen product with no limits of its own takes the approved FROZEN default (−15 °C): −18 °C sells, −10 °C is held, none recorded is held', async () => {
    const h = await seeded();
    expect(grnOf(await receive(h, 'g-ice-ok', [line('p-icecream', { temperatureC: -18 })]))).toMatchObject({ availableMinor: 10 });
    const soft = grnOf(await receive(h, 'g-ice-soft', [line('p-icecream', { temperatureC: -10 })]));
    expect(soft.availableMinor).toBe(0);
    expect(soft.captured.discrepancies[0]!.detail).toContain('above the -15°C limit');
    expect(grnOf(await receive(h, 'g-ice-none', [line('p-icecream')])).captured.discrepancies[0]).toMatchObject({ kind: 'temperature_not_recorded' });
    expect(await onHand(h, 'p-icecream')).toBe(10);
  });

  it('an ambient product needs no temperature; a product whose master names no handling class is received normally and the record SAYS handling_unknown', async () => {
    const h = await seeded();
    const dal = await receive(h, 'g-dal', [line('p-dal')]);
    expect(grnOf(dal)).toMatchObject({ availableMinor: 10, governanceFlags: ['no_purchase_order'] });
    const mystery = await receive(h, 'g-mystery', [line('p-mystery')]);
    expect(grnOf(mystery)).toMatchObject({ availableMinor: 10, governanceFlags: ['no_purchase_order', 'handling_unknown'] });
    expect(await onHand(h, 'p-mystery')).toBe(10);
  });

  it('the store computer\'s relayed delivery of a frozen product (its screen records no temperature yet) is HELD the same way — the store keeps trading, the stock waits for a check', async () => {
    const h = await seeded();
    const relayed = await req(h, 'POST', '/v1/inventory/goods-receipt/g-relay/synced', 'u-box', 'relay-1', {
      grnId: 'g-relay', number: 'DN-1', poId: null, lineCount: 1, warehouseId: WH, receivedBy: 'u-recv', receivedAt: AT,
      // Ice cream, not batch-tracked: the relayed shape carries no expiry, so a batch-tracked item is refused there for traceability (M10), as before.
      lines: [{ productId: 'p-icecream', quantityMinor: 10, uom: 'ea', batchId: null }], storeId: 'store-1', source: 'manager-screen',
    });
    expect(relayed.status).toBe(202);
    expect(grnOf(relayed).availableMinor).toBe(0);
    expect(grnOf(relayed).captured.discrepancies).toEqual([expect.objectContaining({ kind: 'temperature_not_recorded' })]);
    expect(await onHand(h, 'p-icecream')).toBe(0);
  });

  it('the handheld\'s scans of a frozen product (it records no temperature yet) put the stock on-hand; the assembled receipt holds the line AND says cold_chain_held_but_on_hand — never silent', async () => {
    const h = await seeded();
    const scan = await req(h, 'POST', '/v1/inventory/receiving-scans/c-ice/synced', 'u-box', 'scan-c-ice', {
      commandId: 'c-ice', grnId: 'g-hand', productId: 'p-icecream', batchId: null, quantityMinor: 10, uom: 'EA', source: 'po', poId: null,
      state: 'on_hand', expiry: null, receivedBy: 'u-recv', storeId: 'store-1', at: AT,
    });
    expect(scan.status).toBe(202);
    const done = await req(h, 'POST', '/v1/inventory/goods-receipt/g-hand/assembled', 'u-box', 'done-g-hand', {
      grnId: 'g-hand', poId: null, completedBy: 'u-recv', storeId: 'store-1', at: AT, scanCount: 1, commandIds: ['c-ice'], source: 'warehouse-handheld',
    });
    expect(done.status).toBe(202);
    const g = grnOf(done);
    expect(g.captured.discrepancies).toEqual([expect.objectContaining({ kind: 'temperature_not_recorded' })]);
    expect(g.governanceFlags).toContain('cold_chain_held_but_on_hand');
    // Honest limit until the handheld records a temperature (Wave 3 SF-07, part 3): the scans had already put the 10 on-hand.
    expect(await onHand(h, 'p-icecream')).toBe(10);
  });

  it('a temperature that is not a number is refused by name — nothing is received', async () => {
    const h = await seeded();
    const bad = await receive(h, 'g-bad', [PANEER({ temperatureC: 'cold' })]);
    expect(bad.status).toBe(400);
    expect(codeOf(bad)).toBe('not_readable_as_a_goods_receipt');
    expect(await onHand(h, 'p-paneer')).toBe(0);
  });
});

describe('SF-07 — the receiving rule, as a pure resolution', () => {
  it('own limits win and say so; a cold class takes its approved default; ambient is no cold chain; nothing known is undefined', () => {
    const d = COLD_CHAIN_CLASS_DEFAULTS;
    expect(receiptRuleFor('p', { batchTracked: true }, { handling: 'chilled', coldChain: { minTenthsC: -20, maxTenthsC: 40 } }, d))
      .toEqual({ productId: 'p', batchTracked: true, handling: 'chilled', coldChain: true, coldChainMaxC: 4, coldChainMinC: -2, coldChainSource: 'product' });
    expect(receiptRuleFor('p', undefined, { handling: 'frozen' }, d))
      .toEqual({ productId: 'p', batchTracked: false, handling: 'frozen', coldChain: true, coldChainMaxC: -15, coldChainSource: 'class_default' });
    expect(receiptRuleFor('p', { batchTracked: false }, { handling: 'ambient' }, d)).toEqual({ productId: 'p', batchTracked: false, handling: 'ambient' });
    expect(receiptRuleFor('p', { batchTracked: false }, undefined, d)).toEqual({ productId: 'p', batchTracked: false });
    // The catalogue's class stands in where the master is silent; the master's word wins where both speak.
    expect(receiptRuleFor('p', { batchTracked: false, handling: 'chilled' }, undefined, d)).toMatchObject({ handling: 'chilled', coldChain: true, coldChainSource: 'class_default' });
    expect(receiptRuleFor('p', { batchTracked: false, handling: 'chilled' }, { handling: 'ambient' }, d)).toEqual({ productId: 'p', batchTracked: false, handling: 'ambient' });
    expect(receiptRuleFor('p', undefined, undefined, d)).toBeUndefined();
  });
});
