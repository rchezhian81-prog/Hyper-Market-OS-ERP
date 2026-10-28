import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { decide } from '../support/approval-request';
import type { ApiHarness } from '../support/api-harness';
import { createQuotationsSession } from '../../apps/web-erp/src/quotations-session';
import { httpQuotations } from '../../edge/store-edge/src/quotations-at-lane';
import { billVoidRecorder, heldQuotationReleaser, QUOTATION_FREED_EVENT } from '../../edge/store-edge/src/bill-void-at-lane';
import { HeldBills } from '../../edge/store-edge/src/held-bills';
import { httpTransport } from '../../edge/sync-agent/src/http-transport';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { bootPos, type HeldBillsPort, type HeldBasket } from '../../apps/pos/src/browser-entry';
import { fetchGoodsReceipt, goodsReceiptPortsFromData } from '../../apps/web-erp/src/browser-entry';
import { createGoodsReceiptSession } from '../../apps/web-erp/src/goods-receipt-session';
import { openGrnBillMatchPort } from '../../apps/web-erp/src/goods-receipt-bill-match';
import type { SignedPack } from '../../services/catalogue/src/pack';
import type { DurableLog } from '../../edge/store-edge/src/durability';

/**
 * **Round 9 · R9-A — by the owner's decisions of 28 Oct 2026, on head office's real routes — in memory and, with DATABASE_URL,
 * on real PostgreSQL, each with a cold restart.**
 *   • OB-532: a quotation for a product with no known floor needs the OWNER's approval (maker-checker); the quoter, another
 *     manager, and an owner of ANOTHER store cannot make it count.
 *   • OB-533: a quotation rung up on a bill that is then HELD travels with the basket on the store computer; recalling keeps it
 *     attached; giving the held basket up frees it with the reason — on the box's disk while head office is out of reach,
 *     sent ONCE — and a later bill rings it up. A recalled basket cancelled frees it from the bill it was rung up on.
 *   • OB-534: "Match the bill" on the goods-receipt screen, through the real route; the person who received the goods is
 *     refused (on the screen and by head office); the matched bill is shown afterwards, and after a restart.
 * Synthetic data only.
 */

const backings = useRestartableBackings();
const savedFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(async () => { globalThis.fetch = savedFetch; for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const STORE = 'store-1';
const AS_OF = '2030-06-01';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const MANAGER2 = 'u-mgr2'; const OWNER_ELSEWHERE = 'u-owner-s2'; const CASHIER = 'u-cash'; const BOX = 'u-box';
type Res = { status: number; body: unknown };

/** A browser's same-origin fetch (or the box's to head office), answered by the harness as one person. */
function asPerson(get: () => ApiHarness, tenantId: string, userId: string, branchId?: string): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://screen.local');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const r = await get().request({
      method: (init?.method ?? 'GET') as 'GET', path: url.pathname, userId, tenantId, ...(branchId === undefined ? {} : { branchId }),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
      ...(headers['idempotency-key'] === undefined ? {} : { idempotencyKey: headers['idempotency-key'] }),
      ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
    });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}
const memoryLog = (): DurableLog & { records: string[] } => {
  const records: string[] = [];
  return { records, capacityBytes: 1e9, usedBytes: async () => 0, append: async (r) => { records.push(r); } };
};
interface Q { quotationId: string; state: string; convertedSaleId?: string; marginApprovedBy?: string; floorNotKnown?: string[]; releases?: { freeId: string; saleId: string; freedBy: string; reason: string; laneId: string; relayedBy: string }[] }

async function quotingShop(h: ApiHarness, T: string) {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MANAGER, 'store_manager', [STORE]);
  await h.provisionRole(T, MANAGER2, 'store_manager', [STORE]);
  await h.provisionRole(T, OWNER_ELSEWHERE, 'owner', ['store-2']);
  await h.provisionRole(T, CASHIER, 'cashier', [STORE]);
  await h.provisionRole(T, BOX, 'store_computer', [STORE]);
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER, branchId?: string): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(branchId === undefined ? {} : { branchId }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await ok(req('POST', '/v1/catalogue/tax-classes/07139010/rates/2017-07-01', { rateBps: 500 }), 'tax');
  for (const [id, sku, name, code, price, mrp] of [['p-rice', 'RICE-25', 'Ponni rice 25 kg', '8901000000033', 145_000, 150_000], ['p-oil', 'OIL-1L', 'New brand oil 1 L', '8901000000057', 18_000, 20_000]] as const) {
    await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '07139010', lifecycle: 'draft', safety: { netQuantity: '1 pack' }, mrpHistory: [{ value: { minor: mrp, currency: 'INR' }, effectiveFrom: '2030-01-01' }] }, categories: [GROCERY] }), `publish ${id}`);
    await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: price, mrpMinor: mrp, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), `price ${id}`);
    await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }), `barcode ${id}`);
  }
  // Rice came in at ₹1,400.00 a bag (its floor at store-1). The new oil was NEVER received at a cost: its floor is not known.
  await ok(req('POST', '/v1/inventory/goods-receipt/opening-rice', { warehouseId: STORE, receivedOnDate: '2030-01-02', currency: 'INR', lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: 50, countedMinor: 50, uom: 'ea', unitCost: { minor: 140_000, currency: 'INR' }, condition: 'good' }] }), 'opening rice');
  await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF }), 'publish the pack');
  const pack = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
  return { req, pack };
}
const listed = async (h: ApiHarness, T: string): Promise<Map<string, Q>> =>
  new Map(((await h.request({ method: 'GET', path: '/v1/pos/quotations', userId: OWNER, tenantId: T })).body as { quotations: Q[] }).quotations.map((q) => [q.quotationId, q]));

describe.each(backings)('R9-A — on $name', ({ harness }) => {
  it('OB-532: a quotation on a product with no known floor is made only with the OWNER\'s approval; it survives a restart', async () => {
    let h = harness();
    const T = randomUUID();
    await quotingShop(h, T);
    const page = createQuotationsSession({ viewer: { userId: MANAGER, permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch: asPerson(() => h, T, MANAGER, STORE), newNumber: () => '27182818', now: () => '2030-06-01T06:00:00.000Z' });
    const oil = await page.line({ code: 'OIL-1L', qty: '10', priceRupees: '170' });
    if (oil.result !== 'ok') throw new Error('line');
    const form = { storeId: STORE, customerRef: 'Murugan Stores', validUntil: '2099-12-31', approvalId: '', lines: [oil.value] };
    expect(await page.make(form)).toMatchObject({ result: 'refused', status: 422, code: 'quotation_floor_not_known_unapproved' });
    expect(page.needsOwner()).toBe(true);
    const ask = async (): Promise<string> => {
      const asked = await page.askApproval();
      expect(asked.result, JSON.stringify(asked)).toBe('ok');
      expect(asked).toMatchObject({ value: { kind: 'quotation_floor_not_known' } });
      return (asked as { value: { requestId: string } }).value.requestId;
    };
    const first = await ask();
    // The quoter cannot decide it; nor another store manager (the word is the owner's alone).
    expect((await decide(h, T, MANAGER, first)).status).toBe(403);
    expect((await decide(h, T, MANAGER2, first)).status).toBe(403);
    // An owner of ANOTHER store does not decide it either.
    expect((await decide(h, T, OWNER_ELSEWHERE, first)).status).toBe(403);
    // The approval still waiting is refused at the quotation; the owner of THIS store decides a request in his own session.
    expect(await page.make({ ...form, approvalId: first })).toMatchObject({ result: 'refused', code: 'approval_still_waiting' });
    const second = await ask();
    expect((await decide(h, T, OWNER, second)).status).toBeLessThan(300);
    const made = await page.make({ ...form, approvalId: second });
    expect(made, JSON.stringify(made)).toMatchObject({ result: 'ok', value: { quotationId: '27182818', floorNotKnown: ['p-oil'] } });
    // The approval was spent once: it cannot make another quotation.
    const reuse = await h.request({ method: 'POST', path: '/v1/pos/quotations/27182899', userId: MANAGER, tenantId: T, branchId: STORE, idempotencyKey: `k-${randomUUID()}`, body: { storeId: STORE, customerRef: 'x', currency: 'INR', validUntil: '2099-12-31', approvalId: second, lines: [{ lineId: 'l1', productId: 'p-oil', description: 'o', unitPriceMinor: 17_000, quantityMinor: 1, uom: 'ea', taxBps: 500 }] } });
    expect(reuse.status).toBe(422);
    // Cold restart: the quotation, who approved it, and the not-known floor are on record.
    h = harness(h);
    expect((await listed(h, T)).get('27182818')).toMatchObject({ state: 'issued', marginApprovedBy: OWNER, floorNotKnown: ['p-oil'] });
  }, 120_000);

  it('OB-533: the held basket carries the quotation — recall keeps it; giving it up frees it offline, sent once; cancel after recall too', async () => {
    let h = harness();
    const T = randomUUID();
    const { req, pack } = await quotingShop(h, T);
    // The manager quotes rice at ₹1,420 a bag — above its floor, nothing to approve.
    const page = createQuotationsSession({ viewer: { userId: MANAGER, permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch: asPerson(() => h, T, MANAGER, STORE), newNumber: () => '48151623', now: () => '2030-06-01T06:00:00.000Z' });
    const rice = await page.line({ code: 'RICE-25', qty: '2', priceRupees: '1420' });
    if (rice.result !== 'ok') throw new Error('line');
    expect((await page.make({ storeId: STORE, customerRef: 'Murugan Stores', validUntil: '2099-12-31', approvalId: '', lines: [rice.value] })).result).toBe('ok');

    // The store computer: its quotation door, its till-activity door and its held-basket register (with the releaser).
    const dir = await mkdtemp(join(tmpdir(), 'sre-r9a-int-'));
    dirs.push(dir);
    const quotes = httpQuotations({ baseUrl: 'https://head-office.test', token: 'box-token', fetch: asPerson(() => h, T, BOX, STORE) });
    const log = memoryLog();
    const outbox = new SyncOutbox();
    const deps = { tenantId: T, keys: new Set<string>(), log, outbox, now: () => new Date().toISOString(), tradingDayOf: () => AS_OF };
    const recordBillVoid = billVoidRecorder(deps);
    const register = await HeldBills.open({ dataDir: dir, capacityBytes: 1_048_576, tenantId: T, policy: () => null, storeId: () => STORE, freeQuotations: heldQuotationReleaser(deps) });
    const heldPort: HeldBillsPort = {
      hold: async (b) => ({ ...(await register.hold({ laneId: 'lane-1', cashierId: CASHIER, billId: b['billId'], lines: b['lines'], ageAnswers: b['ageAnswers'], tradingDay: b['tradingDay'], reason: b['reason'], quotations: b['quotations'] })) }),
      list: async () => register.list('lane-1') as readonly HeldBasket[],
      recall: async (billId) => ({ ...(await register.recall({ laneId: 'lane-1', byUserId: CASHIER, billId })) }),
      abandon: async (billId, reason) => ({ ...(await register.abandon({ laneId: 'lane-1', byUserId: CASHIER, billId, reason })) }),
    };
    const till = bootPos({
      laneId: 'lane-1', cashierId: CASHIER, tradingDay: AS_OF, catalogue: pack.snapshot, heldBillsPort: heldPort,
      quotationsPort: { convert: (i) => quotes.convert({ quotationNumber: i.quotationNumber, billRef: i.billRef, laneId: 'lane-1', cashierId: CASHIER }) },
      tillActivityPost: (body) => recordBillVoid({ laneId: 'lane-1', cashierId: CASHIER, via: 'pin', body }),
      durable: async () => ({ committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }),
    });
    const transport = httpTransport({ baseUrl: 'https://head-office.test', token: 'box-token', fetch: asPerson(() => h, T, BOX, STORE) });
    const sendQueue = async (): Promise<void> => {
      for (const item of outbox.pending()) {
        const sent = await transport.send(item.event);
        expect(sent.status, `${item.event.type}: ${JSON.stringify(sent)}`).toBe('accepted');
        outbox.acknowledge(item.key);
      }
    };

    // ── Rung up, then HELD: the basket goes to the box with the quotation; the fresh bill has none.
    expect((await till.ringQuotationAtTill('48151623')).ok).toBe(true);
    const firstBill = till.currentBillRef();
    expect((await till.holdAtTill()).ok).toBe(true);
    expect(till.quotationsOnBill()).toEqual([]);
    expect((await listed(h, T)).get('48151623')).toMatchObject({ state: 'converted', convertedSaleId: firstBill });
    // ── RECALLED: the quotation comes back attached, with the quoted price and its evidence on the line.
    const [h1] = await till.heldAtTill();
    const recalled = await till.recallAtTill(h1!.billId);
    expect(recalled).toMatchObject({ ok: true, quotationsAttached: ['48151623'] });
    expect(till.quotationsOnBill()).toEqual(['48151623']);
    expect(till.basket()[0]).toMatchObject({ unitPriceMinor: 142_000 });
    // ── HELD again, then GIVEN UP with head office out of reach: the box keeps the release; nothing reached head office.
    expect((await till.holdAtTill()).ok).toBe(true);
    const [h2] = await till.heldAtTill();
    const givenUp = await till.abandonAtTill(h2!.billId, 'customer_left');
    expect(givenUp).toMatchObject({ ok: true, quotationsFreed: ['48151623'] });
    expect(givenUp.laneMessageTa).toContain('48151623');
    expect(outbox.pending().map((i) => i.event.type)).toEqual([QUOTATION_FREED_EVENT]);
    expect((await listed(h, T)).get('48151623')).toMatchObject({ state: 'converted', convertedSaleId: firstBill });
    // ── The line is back: sent ONCE; head office frees it from the bill it was rung up on, with who and why.
    await sendQueue();
    expect((await listed(h, T)).get('48151623')).toMatchObject({ state: 'issued', releases: [{ freeId: `${h2!.billId}-48151623`, saleId: firstBill, freedBy: CASHIER, reason: 'customer_left', laneId: 'lane-1', relayedBy: BOX }] });
    // The same give-up again (a lost reply) writes nothing new; the release re-sent is the same release.
    expect((await till.abandonAtTill(h2!.billId, 'customer_left')).ok).toBe(true);
    expect(outbox.pending()).toHaveLength(0);
    const freeBody = (JSON.parse(log.records[0]!) as { payload: Record<string, unknown> }).payload;
    expect((await req('POST', '/v1/pos/quotations/48151623/free/synced', freeBody, BOX, STORE)).body).toMatchObject({ alreadyFreed: true });

    // ── A later bill rings it up; it is held and recalled; then CANCELLED: freed from the bill it was rung up on.
    expect((await till.ringQuotationAtTill('48151623')).ok).toBe(true);
    const secondBill = till.currentBillRef();
    expect((await till.holdAtTill()).ok).toBe(true);
    const [h3] = await till.heldAtTill();
    expect((await till.recallAtTill(h3!.billId)).ok).toBe(true);
    expect(till.currentBillRef()).not.toBe(secondBill);
    const cancelled = await till.cancelBillAtTill('customer_left');
    expect(cancelled, JSON.stringify(cancelled)).toMatchObject({ ok: true, quotationsFreed: ['48151623'] });
    await sendQueue();
    const freedTwice = (await listed(h, T)).get('48151623')!;
    expect(freedTwice.state).toBe('issued');
    expect(freedTwice.releases?.map((r) => r.saleId)).toEqual([firstBill, secondBill]);

    // ── Cold restart: both releases on record; the box's held register reads back the given-up basket's quotation.
    h = harness(h);
    expect((await listed(h, T)).get('48151623')!.releases?.map((r) => [r.saleId, r.reason])).toEqual([[firstBill, 'customer_left'], [secondBill, 'customer_left']]);
    await register.close();
    const reopened = await HeldBills.open({ dataDir: dir, capacityBytes: 1_048_576, tenantId: T, policy: () => null, storeId: () => STORE });
    expect(reopened.list('lane-1')).toEqual([]);
    await reopened.close();
  }, 120_000);

  it('OB-534: "Match the bill" on the goods-receipt screen — the receiver is refused; the matched bill is shown, after a restart too', async () => {
    let h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    expect((await call('POST', '/v1/catalogue/products/p-brm/publish', P3.OWNER, { product: { sku: 'SKU-BRM', name: 'Synthetic broom', baseUom: 'each', primaryCategoryId: 'loose', taxClass: '96031000', lifecycle: 'active', mrpHistory: [{ value: { minor: 90_00, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'loose', name: 'Loose household', parentId: null }] })).status).toBe(201);
    await issuedOrder(call, 'po-1', [{ productId: 'p-brm', qty: 10, unitMinor: 4_000 }]);
    await received(call, 'grn-1', 'po-1', [{ productId: 'p-brm', qty: 10, unitMinor: 4_000 }]);
    await capturedAndMatched(call, 'INV-1', 'po-1', [{ productId: 'p-brm', qty: 10, unitMinor: 4_200 }]);

    const screenFor = async (userId: string) => {
      globalThis.fetch = asPerson(() => h, T, userId);
      const data = await fetchGoodsReceipt();
      expect(data).not.toBeNull();
      return createGoodsReceiptSession({ userId }, goodsReceiptPortsFromData({ userId, permissions: ['inventory.availability.read', 'purchase.invoice.match'] }, data!, undefined, undefined, openGrnBillMatchPort()));
    };
    // The person who RECEIVED the goods sees why not; pressing it sends nothing. Head office refuses them too.
    const receiver = await screenFor(P3.RECEIVER);
    const g = (s: Awaited<ReturnType<typeof screenFor>>) => s.view('en').receipts.find((r) => r.grnId === 'grn-1')!;
    expect(g(receiver).billMatch).toEqual({ matched: [], canMatch: false, receivedByYou: true });
    expect(await receiver.matchBill({ grnId: 'grn-1', invoiceId: 'INV-1' })).toEqual({ outcome: 'received_by_you' });
    expect(await openGrnBillMatchPort().post({ grnId: 'grn-1', invoiceId: 'INV-1' })).toMatchObject({ result: 'self_match' });

    // The owner (who did not receive it) matches it from the screen: an unknown bill is said by name; then the bill.
    const owner = await screenFor(P3.OWNER);
    expect(g(owner).billMatch.canMatch).toBe(true);
    expect(await owner.matchBill({ grnId: 'grn-1', invoiceId: 'INV-404' })).toMatchObject({ outcome: 'bill_unknown' });
    const out = await owner.matchBill({ grnId: 'grn-1', invoiceId: 'INV-1' });
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'matched', matched: [{ lineId: 'L1', invoiceId: 'INV-1', unitCostMinor: 4_200, matchedBy: P3.OWNER, costWasKnown: true }] });
    expect(g(owner).billMatch).toEqual({ matched: [{ invoiceId: 'INV-1', label: 'Bill INV-1 matched: p-brm at ₹42.00 each — by u-owner (cost already known from the order — matched to compare prices)' }], canMatch: false, receivedByYou: false });
    // Read again from head office: the matched bill is on the receipt; nothing is left to match.
    const reread = await screenFor(P3.OWNER);
    expect(g(reread).billMatch.matched.map((m) => m.invoiceId)).toEqual(['INV-1']);
    expect(g(reread).billMatch.canMatch).toBe(false);
    // The price-difference report now compares this receipt with its own bill (OB-530).
    const ppv = (await h.request({ method: 'GET', path: '/v1/purchase/price-variance', userId: P3.OWNER, tenantId: T, query: { from: '2026-01-01', to: '2030-12-31' } })).body as { lines: { grnId: string; invoiceId: string | null }[] };
    expect(ppv.lines.find((l) => l.grnId === 'grn-1')?.invoiceId).toBe('INV-1');

    // Cold restart: the screen reads the same matched bill, in Tamil too.
    h = harness(h);
    const after = await screenFor(P3.OWNER);
    expect(after.view('ta').receipts.find((r) => r.grnId === 'grn-1')!.billMatch.matched[0]!.label).toBe('பில் INV-1 பொருத்தப்பட்டது: p-brm ஒன்றுக்கு ₹42.00 — பொருத்தியவர் u-owner (விலை ஆர்டரிலிருந்தே தெரியும் — விலை ஒப்பிடப் பொருத்தப்பட்டது)');
  }, 240_000);
});
