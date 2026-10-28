import { describe, it, expect } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { NOTHING_RUNG_REASON, type QuotationsLanePort, type QuotationLaneAnswer } from '../../apps/pos/src/quotation-at-till';
import { httpQuotations } from '../../edge/store-edge/src/quotations-at-lane';
import { billVoidRecorder, QUOTATION_FREED_EVENT } from '../../edge/store-edge/src/bill-void-at-lane';
import { quotationsRoutes } from '../../services/pos/src/quotations';
import { issueQuotation, type Quotation } from '../../packages/suspended-sales/src/index';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import type { DurableLog } from '../../edge/store-edge/src/durability';

/**
 * **Follow-ups to OB-506 (retail quotations rung up at the till).**
 *   • A quotation is CONVERTED only at the store it was made for — its floor and approval were judged there. Another store's
 *     computer (or a caller acting at another store) is refused by head office (`quotation_for_another_store`), and the till
 *     says so in English and Tamil. The right store still rings it up.
 *   • A quotation is never left used up when NOTHING was rung: head office converts before the till tries a line, so when the
 *     till rings no line at all it frees the quotation at once through the cancelled-bill release (OB-523) — reason "nothing
 *     could be rung", kept on the store computer's disk and queued for head office (sent once) — starts a fresh bill and says
 *     the quotation is still open. A line rung at all keeps the quotation on the bill, as before.
 * Synthetic data only.
 */

const NOW = new Date().toISOString();
const CAT: CatalogueSnapshot = {
  tenantId: 't', version: 5, builtAt: NOW,
  products: [
    { productId: 'P-RICE', sku: 'RICE', name: 'Ponni rice 25 kg', baseUom: 'ea', unitPriceMinor: 1_450_00, mrpMinor: 1_500_00, taxBps: 0, status: 'active' },
    { productId: 'P-OIL', sku: 'OIL', name: 'Oil 1 L', baseUom: 'ea', unitPriceMinor: 180_00, mrpMinor: 200_00, taxBps: 500, status: 'active' },
    { productId: 'P-FLOUR', sku: 'FLOUR', name: 'Flour 1 kg', baseUom: 'ea', unitPriceMinor: 60_00, mrpMinor: 65_00, taxBps: 0, status: 'active' },
  ],
  barcodes: [{ code: '8901', productId: 'P-RICE', kind: 'standard' }, { code: '8902', productId: 'P-OIL', kind: 'standard' }],
};
const converted = (lines: { productId: string; unitPriceMinor: number; quantityMinor: number; uom?: string }[]): QuotationLaneAnswer => ({
  converted: true, quotationId: '48151623', laneMessage: '',
  lines: lines.map((l, i) => ({ lineId: `l${i + 1}`, description: l.productId, uom: 'ea', ...l })),
});
/** Every line refused at the till: a weighed one, one with no barcode in the pack, one quoted above its MRP. */
const NOTHING_RINGS = [
  { productId: 'P-ONION', unitPriceMinor: 40_00, quantityMinor: 1000, uom: 'kg' },
  { productId: 'P-FLOUR', unitPriceMinor: 58_00, quantityMinor: 2 },
  { productId: 'P-OIL', unitPriceMinor: 210_00, quantityMinor: 1 },
];
function memoryLog(): DurableLog & { records: string[] } {
  const records: string[] = [];
  return { records, capacityBytes: 1e9, usedBytes: async () => 0, append: async (r) => { records.push(r); } };
}
/** A till whose till-activity door is the store computer's real cancelled-bill recorder (on a memory disk and queue). */
function till(port: QuotationsLanePort, door?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const log = memoryLog();
  const outbox = new SyncOutbox();
  const recordBillVoid = billVoidRecorder({ tenantId: 't', keys: new Set(), log, outbox, now: () => NOW, tradingDayOf: () => NOW.slice(0, 10) });
  const posted: Record<string, unknown>[] = [];
  const pos = bootPos({
    laneId: 'lane-1', cashierId: 'u-cash', tradingDay: NOW.slice(0, 10), catalogue: CAT, quotationsPort: port,
    tillActivityPost: async (body) => { posted.push(body); return (door ?? ((b) => recordBillVoid({ laneId: 'lane-1', cashierId: 'u-cash', via: 'pin', body: b })))(body); },
    durable: async () => ({ committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }),
  });
  return { pos, posted, outbox, log, recordBillVoid };
}

describe('a quotation the till could ring nothing of is freed again at once (never left used up)', () => {
  it('every line refused → the release is kept on the store computer and queued (reason on record), a fresh bill, "still open" in English and Tamil', async () => {
    const asked: string[] = [];
    const { pos, posted, outbox } = till({ convert: async (i) => { asked.push(i.billRef); return converted(NOTHING_RINGS); } });
    const r = await pos.ringQuotationAtTill('48151623');
    expect(r).toMatchObject({ ok: true, quotationId: '48151623', added: [], quotationFreed: true });
    expect(r.notAdded?.map((n) => n.productId)).toEqual(['P-ONION', 'P-FLOUR', 'P-OIL']);
    expect(r.laneMessage).toMatch(/^Quotation 48151623: nothing could be rung — deal with each line below\. The quotation is STILL OPEN/);
    expect(r.laneMessageTa).toMatch(/விலைப்புள்ளி இன்னும் திறந்தே உள்ளது/);
    // The release names the bill head office converted it to, no lines, the quotation and the reason.
    expect(posted).toEqual([{ activityId: expect.stringMatching(/^QF-/), kind: 'bill_void', billRef: asked[0], reason: NOTHING_RUNG_REASON, lines: [], quotationIds: ['48151623'] }]);
    const queued = outbox.pending().map((i) => i.event);
    expect(queued.map((e) => e.type)).toEqual([QUOTATION_FREED_EVENT]);
    expect(queued[0]!.payload).toMatchObject({ quotationId: '48151623', saleId: asked[0], reason: 'nothing could be rung', freedBy: 'u-cash', laneId: 'lane-1' });
    // Nothing on the till, the quotation is not on the (new) bill, so a later cancel never frees it a second time.
    expect(pos.basket()).toEqual([]);
    expect(pos.currentBillRef()).not.toBe(asked[0]);
    expect(pos.quotationsOnBill()).toEqual([]);
    // Rung again later: a fresh bill is asked for, and a fresh release (its own id) is kept when nothing rings again.
    await pos.ringQuotationAtTill('48151623');
    expect(asked[1]).not.toBe(asked[0]);
    expect(posted).toHaveLength(2);
    expect(posted[1]!['activityId']).not.toBe(posted[0]!['activityId']);
    expect(outbox.pending().map((i) => (i.event.payload as Record<string, unknown>)['saleId'])).toEqual([asked[0], asked[1]]);
  });

  it('at least one line rung → the quotation stays on the bill exactly as before; nothing is released', async () => {
    const { pos, posted, outbox } = till({ convert: async () => converted([NOTHING_RINGS[1]!, { productId: 'P-RICE', unitPriceMinor: 1_400_00, quantityMinor: 1 }]) });
    const bill = pos.currentBillRef();
    const r = await pos.ringQuotationAtTill('48151623');
    expect(r).toMatchObject({ ok: true, quotationId: '48151623' });
    expect(r.quotationFreed).toBeUndefined();
    expect(r.added?.map((a) => a.description)).toEqual(['Ponni rice 25 kg']);
    expect(posted).toEqual([]);
    expect(outbox.pending()).toEqual([]);
    expect(pos.currentBillRef()).toBe(bill);
    expect(pos.quotationsOnBill()).toEqual(['48151623']);
  });

  it('the store computer cannot be reached → asked twice with the same release, said plainly; the quotation stays on the bill and cancelling the bill frees it', async () => {
    let down = true;
    const fresh = till({ convert: async () => converted(NOTHING_RINGS) });
    const { pos, posted } = till({ convert: async () => converted(NOTHING_RINGS) }, async (body) => {
      if (down) throw new TypeError('Failed to fetch');
      return fresh.recordBillVoid({ laneId: 'lane-1', cashierId: 'u-cash', via: 'pin', body });
    });
    const bill = pos.currentBillRef();
    const r = await pos.ringQuotationAtTill('48151623');
    expect(r).toMatchObject({ ok: true, quotationId: '48151623', added: [], quotationFreed: false, refusedBecause: 'lane_unreachable' });
    expect(r.laneMessage).toMatch(/nothing could be rung, and the quotation could NOT be freed now \(lane_unreachable\) — it stays on this bill\. Cancel the whole bill to free it/);
    expect(r.laneMessageTa).toMatch(/முழு பில்லையும் ரத்து செய்யுங்கள்/);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual(posted[0]);
    expect(pos.currentBillRef()).toBe(bill);
    expect(pos.quotationsOnBill()).toEqual(['48151623']);
    // The line is back: cancelling the (empty) bill frees the quotation through the same release (OB-523).
    down = false;
    const cancelled = await pos.cancelBillAtTill('wrong_quotation');
    expect(cancelled).toMatchObject({ ok: true, linesVoided: 0, quotationsFreed: ['48151623'] });
    expect(fresh.outbox.pending().map((i) => { const p = i.event.payload as Record<string, unknown>; return [i.event.type, p['saleId'], p['reason']]; })).toEqual([[QUOTATION_FREED_EVENT, bill, 'wrong_quotation']]);
  });

  it('the store computer refuses to keep it → said with its reason, the quotation stays on the bill', async () => {
    const { pos } = till({ convert: async () => converted(NOTHING_RINGS) }, async () => ({ recorded: false, refusedBecause: 'could_not_write_durably', laneMessage: 'disk' }));
    const r = await pos.ringQuotationAtTill('48151623');
    expect(r).toMatchObject({ quotationFreed: false, refusedBecause: 'could_not_write_durably' });
    expect(pos.quotationsOnBill()).toEqual(['48151623']);
  });
});

describe('a quotation is rung up only at the store it was made for', () => {
  const issued = (): Quotation => issueQuotation({
    quotationId: '48151623', tenantId: 't', storeId: 'store-1', customerRef: 'Murugan', currency: 'INR', issuedBy: 'u-mgr',
    issuedAt: '2030-06-01T06:00:00.000Z', validUntil: '2099-12-31',
    lines: [{ lineId: 'l1', productId: 'P-RICE', description: 'Rice', unitPriceMinor: 1_400_00, quantityMinor: 1, uom: 'ea', taxBps: 0 }],
  }).quotation!;
  const convert = async (who: { branchId: string | null; scope: readonly string[] | 'all' }) => {
    const recorded: Quotation[] = [issued()];
    const route = quotationsRoutes({ quotations: () => [recorded[recorded.length - 1]!], record: (_t, q) => { recorded.push(q); }, now: () => '2030-06-02T06:00:00.000Z' })
      .find((r) => r.method === 'POST' && r.path === '/v1/pos/quotations/:quotationId/convert')!;
    try {
      const out = await route.handler({ tenantId: 't', userId: 'u-box', ...who, params: { quotationId: '48151623' }, body: { saleId: 'B-1' }, query: {}, traceId: 'x' } as unknown as Parameters<typeof route.handler>[0]);
      return { status: out.status, recorded: recorded.length - 1 };
    } catch (e) {
      return { status: (e as { status?: number }).status, code: (e as { body?: { code?: string } }).body?.code, recorded: recorded.length - 1 };
    }
  };

  it('head office refuses another store\'s computer (and a company-wide caller acting at another store); the right store converts', async () => {
    expect(await convert({ branchId: 'store-2', scope: ['store-2'] })).toEqual({ status: 403, code: 'quotation_for_another_store', recorded: 0 });
    expect(await convert({ branchId: null, scope: ['store-2'] })).toEqual({ status: 403, code: 'quotation_for_another_store', recorded: 0 });
    expect(await convert({ branchId: 'store-2', scope: 'all' })).toEqual({ status: 403, code: 'quotation_for_another_store', recorded: 0 });
    expect(await convert({ branchId: 'store-1', scope: ['store-1'] })).toEqual({ status: 200, recorded: 1 });
    expect(await convert({ branchId: null, scope: 'all' })).toEqual({ status: 200, recorded: 1 });
  });

  it('the store computer says it in the cashier\'s words, English and Tamil — a plain 403 stays the general refusal', async () => {
    const box = (status: number, body: unknown) => httpQuotations({ baseUrl: 'https://ho.test', token: 't', fetch: (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch });
    const other = await box(403, { error: { code: 'quotation_for_another_store', whatHappened: 'made for another store' } }).convert({ quotationNumber: '48151623', billRef: 'B-1', laneId: 'l', cashierId: 'c' });
    expect(other).toEqual({
      converted: false, refusedBecause: 'quotation_for_another_store',
      laneMessage: 'Quotation 48151623 was made for another store, so it cannot be rung up at this store. Nothing was rung — ring it up at that store, or ask the office to quote again for this store.',
      laneMessageTa: expect.stringMatching(/^விலைப்புள்ளி 48151623 வேறு கடைக்காகத் தயாரிக்கப்பட்டது/),
    });
    expect(await box(403, { error: { code: 'outside_your_branch_scope' } }).convert({ quotationNumber: '48151623', billRef: 'B-1', laneId: 'l', cashierId: 'c' })).toMatchObject({ refusedBecause: 'head_office_refused' });
    // The till passes the box's words to the cashier unchanged, nothing rung.
    const { pos } = till({ convert: async () => ({ converted: false, refusedBecause: other.converted ? '' : other.refusedBecause, laneMessage: other.converted ? '' : other.laneMessage, laneMessageTa: other.converted ? '' : other.laneMessageTa }) });
    const r = await pos.ringQuotationAtTill('48151623');
    expect(r).toMatchObject({ ok: false, refusedBecause: 'quotation_for_another_store', laneMessage: expect.stringMatching(/made for another store/), laneMessageTa: expect.stringMatching(/வேறு கடைக்காக/) });
    expect(pos.basket()).toEqual([]);
  });
});
