import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { approvedSuppliers } from '../support/approved-supplier';
import type { ApiHarness } from '../support/api-harness';
import { STREAM } from '../../services/api/src/adapters';
import { createQuotationsSession } from '../../apps/web-erp/src/quotations-session';
import { httpQuotations } from '../../edge/store-edge/src/quotations-at-lane';
import { bootPos, type HeldBillsPort } from '../../apps/pos/src/browser-entry';
import { DsdDoorSession } from '../../apps/warehouse-app/src/dsd-door';
import { WarehouseSession } from '../../apps/warehouse-app/src/warehouse-session';
import { judgeClientVersion } from '../../packages/platform-admin/src/client-version';
import { pathFor } from '../../edge/sync-agent/src/http-transport';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { makeEvent } from '../../packages/contracts/src/event';
import type { SignedPack } from '../../services/catalogue/src/pack';

/**
 * **Round 11 · R11-A — on head office's real routes, in memory and, with DATABASE_URL, on real PostgreSQL, each with a cold
 * restart.** The gaps the independent check of rounds 6–10 found, and the "keep as built" items it asked to be proved:
 *   • OB-504 — the DSD door: a PACKED product's scan with no month of manufacture is refused by name (the product master's
 *     word, the same rule as every receiving path), directly and when the handheld's record is relayed; with it, the batch and
 *     expiry reach the stock ledger and the month stays on the check-in.
 *   • OB-501 — a barred till refuses a quotation number before the store computer converts it: head office's quotation stays
 *     open and an updated till rings it up.
 *   • OB-602 — the owner's own quotation below the floor is approved by THIS store's accountant (maker-checker); a manager's
 *     still needs the owner.
 *   • OB-603 — a barred till recalls a held basket; OB-536 — a barred handheld's put-away of goods already received is
 *     accepted by head office; OB-515 — the real role table refuses a store manager recording scrap.
 * Synthetic data only.
 */

const backings = useRestartableBackings();
const STORE = 'store-1';
const AS_OF = '2030-06-01';
const AT = '2030-06-01T06:00:00.000Z';
const POLICY = { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0', killedVersions: ['2.0.3'] };
const OLD = '1.9.9';
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const ACCT = 'u-acct'; const ACCT_ELSEWHERE = 'u-acct-s2'; const CASHIER = 'u-cash'; const BOX = 'u-box';
type Res = { status: number; body: unknown };
const decide = (h: ApiHarness, tenantId: string, checker: string, requestId: string, branchId?: string) => h.request({
  method: 'POST', path: `/v1/approvals/requests/${requestId}/decide`, userId: checker, tenantId, ...(branchId === undefined ? {} : { branchId }),
  idempotencyKey: `decide-${randomUUID()}`, body: { decision: 'approved', reason: 'checked' },
});
const code = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

/** A browser's same-origin fetch (or the box's to head office), answered by the harness as one person. */
function asPerson(get: () => ApiHarness, tenantId: string, userId: string, branchId?: string): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://screen.local');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const r = await get().request({
      method: (init?.method ?? 'GET') as 'GET', path: url.pathname, userId, tenantId, ...(branchId === undefined ? {} : { branchId }),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
      idempotencyKey: headers['idempotency-key'] ?? `k-${randomUUID()}`,
      ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
    });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}

async function quotingShop(h: ApiHarness, T: string) {
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, MANAGER, 'store_manager', [STORE]);
  await h.provisionRole(T, ACCT, 'accountant', [STORE]);
  await h.provisionRole(T, ACCT_ELSEWHERE, 'accountant', ['store-2']);
  await h.provisionRole(T, CASHIER, 'cashier', [STORE]);
  await h.provisionRole(T, BOX, 'store_computer', [STORE]);
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await ok(req('POST', '/v1/catalogue/tax-classes/07139010/rates/2017-07-01', { rateBps: 500 }), 'tax');
  await ok(req('POST', '/v1/catalogue/products/p-rice/publish', { product: { sku: 'RICE-25', name: 'Ponni rice 25 kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '07139010', lifecycle: 'draft', safety: { netQuantity: '25 kg' }, mrpHistory: [{ value: { minor: 150_000, currency: 'INR' }, effectiveFrom: '2030-01-01' }] }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), 'publish');
  await ok(req('POST', '/v1/prices/list/p-rice/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 145_000, mrpMinor: 150_000, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), 'price');
  await ok(req('POST', '/v1/catalogue/products/p-rice/barcodes/8901000000033', { kind: 'ean' }), 'barcode');
  // Rice came in at ₹1,400.00 a bag — its floor at store-1.
  await ok(req('POST', '/v1/inventory/goods-receipt/opening-rice', { warehouseId: STORE, receivedOnDate: '2030-01-02', currency: 'INR', lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: 50, countedMinor: 50, uom: 'ea', unitCost: { minor: 140_000, currency: 'INR' }, condition: 'good' }] }), 'opening rice');
  await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF }), 'publish the pack');
  const pack = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
  return { req, ok, pack };
}
const quotationOf = async (h: ApiHarness, T: string, id: string) =>
  ((await h.request({ method: 'GET', path: '/v1/pos/quotations', userId: OWNER, tenantId: T })).body as { quotations: { quotationId: string; state: string; marginApprovedBy?: string }[] }).quotations.find((q) => q.quotationId === id);

describe.each(backings)('R11-A — on $name', ({ harness }) => {
  it('OB-504 · OB-604 · OB-605: the DSD door refuses packed goods with no month and batch-tracked goods with no batch or expiry; each batch reaches the ledger as its own movement', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, 'u-recv', 'store_manager');
    await h.provisionRole(T, 'u-mgr2', 'store_manager');
    await h.provisionRole(T, BOX, 'store_computer', ['S-A']);
    await approvedSuppliers(h, T, 'sup-det');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S-A', { kind: 'branch', name: 'Store A', parentId: 'C1', companyId: 'C1' }), 'store');
    const PACKED = { categoryId: 'packed', name: 'Packed household', parentId: null, regulated: ['packed'] };
    await ok(req('POST', '/v1/catalogue/products/p-det/publish', { product: { sku: 'SKU-DET', name: 'Synthetic detergent 1kg', baseUom: 'each', primaryCategoryId: 'packed', taxClass: '34022010', lifecycle: 'active', safety: { netQuantity: '1 kg', packerDetails: 'Synthetic Packers, Chennai', countryOfOrigin: 'India', consumerCareContact: 'Synthetic Care, 1800-000-0000' }, mrpHistory: [{ value: { minor: 150_00, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [PACKED] }), 'publish packed');
    await ok(req('POST', '/v1/catalogue/products/p-brm/publish', { product: { sku: 'SKU-BRM', name: 'Synthetic broom', baseUom: 'each', primaryCategoryId: 'loose', taxClass: '96031000', lifecycle: 'active', mrpHistory: [{ value: { minor: 90_00, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'loose', name: 'Loose household', parentId: null }] }), 'publish loose');
    await ok(req('POST', '/v1/purchase/orders/po-det', { supplierId: 'sup-det', deliverToLocationId: 'S-A', lines: [{ productId: 'p-det', orderedQty: 10, unitCost: { minor: 9_000, currency: 'INR' } }, { productId: 'p-brm', orderedQty: 5, unitCost: { minor: 4_000, currency: 'INR' } }, { productId: 'p-milk', orderedQty: 3, unitCost: { minor: 3_000, currency: 'INR' } }] }, 'u-recv'), 'po');
    // OB-605: head office's published catalogue marks the milk BATCH-TRACKED (the goods receipt reads the same word).
    await h.store.append(T, STREAM.catalogue, makeEvent({ id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: '2030-06-01T00:00:00.000Z', idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: T, version: 1, builtAt: '2030-06-01T00:00:00.000Z', barcodes: [], products: [{ productId: 'p-milk', sku: 'MILK', name: 'Milk 500 ml', unitPriceMinor: 3_500, taxBps: 0, status: 'active', uom: 'each', batchTracked: true, handling: 'ambient' }] } } }));
    await ok(req('POST', '/v1/purchase/orders/po-det/approval', { reason: 'weekly' }), 'issue po');

    const open = { supplierId: 'sup-det', storeId: 'S-A', poId: 'po-det', driverName: 'Ravi', arrivedAt: '2030-06-01T06:30:00.000Z' };
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1', open, 'u-recv'), 'open');
    const bare = await req('POST', '/v1/inventory/dsd-checkins/c-1/scans/s1', { productId: 'p-det', quantityMinor: 4 }, 'u-recv');
    expect(bare.status).toBe(422);
    expect(code(bare)).toBe('manufacture_date_required');
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/scans/s1', { productId: 'p-det', quantityMinor: 4, manufacturedOn: '2030-13' }, 'u-recv'))).toBe('manufacture_date_required');
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/scans/s1', { productId: 'p-det', quantityMinor: 4, manufacturedOn: '2030-05', expiry: 'soon' }, 'u-recv'))).toBe('expiry_not_readable');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/scans/s1', { productId: 'p-det', quantityMinor: 4, batchId: 'DET-B1', expiry: '2032-04-30', manufacturedOn: '2030-05' }, 'u-recv'), 'packed scan with its month');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/scans/s2', { productId: 'p-brm', quantityMinor: 2 }, 'u-recv'), 'loose scan needs none');
    // OB-604: a second batch of the detergent — 4 + 7 = 11 against an order of 10.
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/scans/s3', { productId: 'p-det', quantityMinor: 7, batchId: 'DET-B3', expiry: '2032-05-31', manufacturedOn: '2030-06' }, 'u-recv'), 'second batch');
    // OB-605: the milk is batch-tracked — refused without its batch, then without its expiry; taken with both.
    expect(code(await req('POST', '/v1/inventory/dsd-checkins/c-1/scans/m1', { productId: 'p-milk', quantityMinor: 3 }, 'u-recv'))).toBe('batch_required');
    const noExpiry = await req('POST', '/v1/inventory/dsd-checkins/c-1/scans/m1', { productId: 'p-milk', quantityMinor: 3, batchId: 'MLK-9' }, 'u-recv');
    expect(noExpiry.status).toBe(422);
    expect(code(noExpiry)).toBe('expiry_required');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/scans/m1', { productId: 'p-milk', quantityMinor: 3, batchId: 'MLK-9', expiry: '2030-06-06' }, 'u-recv'), 'milk with batch and expiry');

    h = harness(h); // ── COLD RESTART ──
    await h.provisionRole(T, BOX, 'store_computer', ['S-A']); // the new API's harness learns which store the box's credential is for
    const kept = (await req('GET', '/v1/inventory/dsd-checkins/c-1')).body as { checkIn: { scans: { scanId: string; batchId?: string; expiry?: string; manufacturedOn?: string }[] } };
    expect(kept.checkIn.scans).toEqual([
      expect.objectContaining({ scanId: 's1', batchId: 'DET-B1', expiry: '2032-04-30', manufacturedOn: '2030-05' }),
      expect.objectContaining({ scanId: 's2' }),
      expect.objectContaining({ scanId: 's3', batchId: 'DET-B3' }),
      expect.objectContaining({ scanId: 'm1', batchId: 'MLK-9', expiry: '2030-06-06' }),
    ]);
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/close', { deliveryNote: { noteRef: 'DN-1', driverSignedName: 'Ravi' } }, 'u-recv'), 'close');
    const moved = (await h.store.readStream(T, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => e.event.payload as { movementId: string; batchId?: string; expiry?: string; quantityMinor: number });
    // OB-604: one received movement per batch — B1's 4 and 6 of B3 fill the order of 10; B3's last 1 is held for a second person.
    expect(moved.find((m) => m.movementId === 'dsd:c-1:p-det:batch:DET-B1~2032-04-30~2030-05')).toMatchObject({ batchId: 'DET-B1', expiry: '2032-04-30', quantityMinor: 4 });
    expect(moved.find((m) => m.movementId === 'dsd:c-1:p-det:batch:DET-B3~2032-05-31~2030-06')).toMatchObject({ batchId: 'DET-B3', expiry: '2032-05-31', quantityMinor: 6 });
    expect(moved.find((m) => m.movementId === 'dsd:c-1:p-milk:batch:MLK-9~2030-06-06~')).toMatchObject({ batchId: 'MLK-9', quantityMinor: 3 });
    expect(moved.some((m) => m.movementId === 'dsd:c-1:p-det')).toBe(false);
    const closedRec = (await req('GET', '/v1/inventory/dsd-checkins/c-1')).body as { checkIn: { flags: string[]; held: { state: string; lines: Record<string, unknown>[] } } };
    expect(closedRec.checkIn.held).toMatchObject({ state: 'pending', lines: [{ productId: 'p-det', quantityMinor: 1, batchId: 'DET-B3', expiry: '2032-05-31', manufacturedOn: '2030-06' }] });
    expect(closedRec.checkIn.flags).not.toContain('several_batches');
    h = harness(h); // ── COLD RESTART ──
    await h.provisionRole(T, BOX, 'store_computer', ['S-A']);
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/held/decide', { decision: 'approved', reason: 'we stock it' }, 'u-mgr2'), 'second person lets the extra in');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/held/decide', { decision: 'approved', reason: 'we stock it' }, 'u-mgr2'), 'the same decision again');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/close', { deliveryNote: { noteRef: 'DN-1', driverSignedName: 'Ravi' } }, 'u-recv'), 'close again');
    const movedAfter = (await h.store.readStream(T, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => e.event.payload as { movementId: string; batchId?: string; quantityMinor: number });
    expect(movedAfter.filter((m) => m.movementId === 'dsd:c-1:p-det:held:batch:DET-B3~2032-05-31~2030-06')).toEqual([expect.objectContaining({ batchId: 'DET-B3', quantityMinor: 1 })]);
    // Nothing posted twice: two detergent batches, the broom (no batch named — its id as before), the milk batch, the held batch.
    expect(movedAfter.filter((m) => m.movementId.startsWith('dsd:c-1:')).map((m) => m.movementId).sort()).toEqual([
      'dsd:c-1:p-brm', 'dsd:c-1:p-det:batch:DET-B1~2032-04-30~2030-05', 'dsd:c-1:p-det:batch:DET-B3~2032-05-31~2030-06',
      'dsd:c-1:p-det:held:batch:DET-B3~2032-05-31~2030-06', 'dsd:c-1:p-milk:batch:MLK-9~2030-06-06~',
    ]);

    // ── the handheld at the door, offline, then relayed by the store computer ──
    const outbox = new SyncOutbox();
    const pack = { workerId: 'u-recv', storeId: 'S-A', barcodes: [{ barcode: '890DET', productId: 'p-det', level: 'unit' as const }], packedProductIds: ['p-det'],
      openDeliveries: [{ poId: 'po-det', number: 'PO-1', supplierId: 'sup-det', ordered: [{ productId: 'p-det', quantityMinor: 6, unitCost: { minor: 9_000 } }] }] };
    const doorPhone = new DsdDoorSession(pack as never, outbox, () => '2030-06-02T06:00:00.000Z');
    doorPhone.start({ checkInId: 'c-2', poId: 'po-det', driverName: 'mobile 9876543210' });
    expect(doorPhone.scan('x0', '890DET').code).toBe('manufacture_date_required'); // refused on the phone, offline
    expect(doorPhone.scan('x1', '890DET', { batchId: 'DET-B2', manufacturedOn: '2030-06' }).code).toBe('dsd_scanned');
    doorPhone.close({ noteRef: 'NOTE-2', driverSignedName: 'mobile 9876543210' });
    const [event] = outbox.all().map((i) => i.event);
    const payload = event!.payload as Record<string, unknown>;
    // A record from a phone the box never told (no month on the scan) is refused by head office by name — nothing posted.
    const blind = { ...payload, checkInId: 'c-3', scans: [{ scanId: 'y1', productId: 'p-det', quantityMinor: 1, at: '2030-06-02T06:01:00.000Z' }] };
    const refused = await req('POST', '/v1/inventory/dsd-checkins/c-3/synced', blind, BOX);
    expect(refused.status).toBe(422);
    expect(code(refused)).toBe('manufacture_date_required');
    expect((await req('GET', '/v1/inventory/dsd-checkins/c-3')).status).toBe(404);
    expect(pathFor(event!)).toBe('/v1/inventory/dsd-checkins/c-2/synced');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-2/synced', payload, BOX), 'relayed');
    h = harness(h); // ── COLD RESTART ──
    await h.provisionRole(T, BOX, 'store_computer', ['S-A']);
    const moved2 = (await h.store.readStream(T, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => e.event.payload as { movementId: string; batchId?: string });
    expect(moved2.find((m) => m.movementId === 'dsd:c-2:p-det:batch:DET-B2~~2030-06')).toMatchObject({ batchId: 'DET-B2' });
    expect(moved2.some((m) => m.movementId.startsWith('dsd:c-3:'))).toBe(false);
  }, 120_000);

  it('OB-602: the owner\'s own below-floor quotation is made only with THIS store\'s accountant\'s approval; a manager\'s still needs the owner', async () => {
    let h = harness();
    const T = randomUUID();
    await quotingShop(h, T);
    const page = createQuotationsSession({ viewer: { userId: OWNER, permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch: asPerson(() => h, T, OWNER), newNumber: () => '16180339', now: () => AT });
    const rice = await page.line({ code: 'RICE-25', qty: '2', priceRupees: '1300' });
    if (rice.result !== 'ok') throw new Error('line');
    const form = { storeId: STORE, customerRef: 'Murugan Stores', validUntil: '2099-12-31', approvalId: '', lines: [rice.value] };
    expect(await page.make(form)).toMatchObject({ result: 'refused', status: 422, code: 'quotation_below_floor_owner_quoted_unapproved' });
    expect(page.needsAccountant()).toBe(true);
    const asked = await page.askApproval();
    expect(asked, JSON.stringify(asked)).toMatchObject({ result: 'ok', value: { kind: 'quotation_below_floor_owner_quoted' } });
    const requestId = (asked as { value: { requestId: string } }).value.requestId;
    // The owner cannot approve his own; a store manager has no word for it; an accountant of ANOTHER store decides in the
    // engine but head office does not count it at this store's quotation.
    expect((await decide(h, T, OWNER, requestId)).status).toBeGreaterThanOrEqual(400);
    expect((await decide(h, T, MANAGER, requestId, STORE)).status).toBe(403);
    expect((await decide(h, T, ACCT, requestId, STORE)).status).toBeLessThan(300);
    h = harness(h); // ── COLD RESTART ──
    const made = await page.make({ ...form, approvalId: requestId });
    expect(made, JSON.stringify(made)).toMatchObject({ result: 'ok', value: { quotationId: '16180339' } });
    expect(await quotationOf(h, T, '16180339')).toMatchObject({ state: 'issued', marginApprovedBy: ACCT });

    // An accountant of another store: the request is decided, but the quotation is refused and the approval not spent.
    const page2 = createQuotationsSession({ viewer: { userId: OWNER, permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch: asPerson(() => h, T, OWNER), newNumber: () => '16180340', now: () => AT });
    expect((await page2.make(form)).result).toBe('refused');
    const other = (await page2.askApproval()) as { value: { requestId: string } };
    expect((await decide(h, T, ACCT_ELSEWHERE, other.value.requestId, 'store-2')).status).toBeLessThan(300);
    expect(await page2.make({ ...form, approvalId: other.value.requestId })).toMatchObject({ result: 'refused', code: 'quotation_below_floor_owner_quoted_unapproved' });

    // A store manager's below-floor quotation still needs the owner: the accountant may not decide it.
    const mgr = createQuotationsSession({ viewer: { userId: MANAGER, permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch: asPerson(() => h, T, MANAGER, STORE), newNumber: () => '16180341', now: () => AT });
    expect(await mgr.make(form)).toMatchObject({ result: 'refused', code: 'quotation_below_floor_unapproved' });
    const mAsk = (await mgr.askApproval()) as unknown as { value: { requestId: string; kind: string } };
    expect(mAsk.value.kind).toBe('quotation_below_floor');
    expect((await decide(h, T, ACCT, mAsk.value.requestId, STORE)).status).toBe(403);
    expect((await decide(h, T, OWNER, mAsk.value.requestId)).status).toBeLessThan(300);
    expect(await mgr.make({ ...form, approvalId: mAsk.value.requestId })).toMatchObject({ result: 'ok' });
    expect(await quotationOf(h, T, '16180341')).toMatchObject({ marginApprovedBy: OWNER });
  }, 120_000);

  it('OB-501: a barred till refuses the quotation before the box converts it — it stays open and an updated till rings it; OB-603: a barred till recalls a held basket', async () => {
    let h = harness();
    const T = randomUUID();
    const { pack } = await quotingShop(h, T);
    const page = createQuotationsSession({ viewer: { userId: MANAGER, permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch: asPerson(() => h, T, MANAGER, STORE), newNumber: () => '48151623', now: () => AT });
    const rice = await page.line({ code: 'RICE-25', qty: '2', priceRupees: '1420' });
    if (rice.result !== 'ok') throw new Error('line');
    expect((await page.make({ storeId: STORE, customerRef: 'Murugan Stores', validUntil: '2099-12-31', approvalId: '', lines: [rice.value] })).result).toBe('ok');
    const box = httpQuotations({ baseUrl: 'https://head-office.test', token: 'box-token', fetch: asPerson(() => h, T, BOX, STORE) });
    let asked = 0;
    const quotationsPort = { convert: (i: { quotationNumber: string; billRef: string }) => { asked += 1; return box.convert({ quotationNumber: i.quotationNumber, billRef: i.billRef, laneId: 'lane-1', cashierId: CASHIER }); } };
    const held: Record<string, unknown>[] = [];
    const heldBillsPort: HeldBillsPort = {
      hold: async (b) => { held.push(b); return { held: true, billId: b['billId'] }; },
      list: async () => held.map((b) => ({ billId: String(b['billId']), laneId: 'lane-1', heldAt: AT, lines: b['lines'], ageAnswers: [] })) as never,
      recall: async (billId) => { const b = held.find((x) => x['billId'] === billId); return b === undefined ? { recalled: false } : { recalled: true, bill: { lines: b['lines'], ageAnswers: [] } }; },
      abandon: async () => ({ abandoned: true }),
    };
    const durable = async () => ({ committed: true as const, durable: true as const, detail: 'double', laneMessage: 'Sale complete.' });
    const barredTill = bootPos({ laneId: 'lane-1', cashierId: CASHIER, tradingDay: AS_OF, catalogue: pack.snapshot, appVersion: OLD, appVersionPolicy: POLICY, quotationsPort, heldBillsPort, durable });
    const refused = await barredTill.ringQuotationAtTill('48151623');
    expect(refused).toMatchObject({ ok: false, refusedBecause: 'app_version_too_old' });
    expect(refused.laneMessageTa).toBeTruthy();
    expect(asked).toBe(0);
    h = harness(h); // ── COLD RESTART ──
    expect(await quotationOf(h, T, '48151623')).toMatchObject({ state: 'issued' }); // never tied to a bill
    const updatedTill = bootPos({ laneId: 'lane-1', cashierId: CASHIER, tradingDay: AS_OF, catalogue: pack.snapshot, appVersion: '2.1.0', appVersionPolicy: POLICY, quotationsPort, heldBillsPort, durable });
    const rung = await updatedTill.ringQuotationAtTill('48151623');
    expect(rung, JSON.stringify(rung)).toMatchObject({ ok: true, quotationId: '48151623' });
    expect(asked).toBe(1);
    expect(await quotationOf(h, T, '48151623')).toMatchObject({ state: 'converted' });

    // OB-603: the basket is held on this till; the till is then barred (a newer policy arrives); the recall is finishing a
    // bill in progress, so it is allowed and more can be rung onto it — a NEW bill is still refused.
    expect((await updatedTill.holdAtTill()).ok).toBe(true);
    updatedTill.applyVersionPolicy({ ...POLICY, killedVersions: ['2.1.0'] });
    expect(() => updatedTill.scanBarcode('8901000000033')).toThrow();
    const [h1] = await updatedTill.heldAtTill();
    const recalled = await updatedTill.recallAtTill(h1!.billId);
    expect(recalled, JSON.stringify(recalled)).toMatchObject({ ok: true });
    expect(updatedTill.basket().length).toBeGreaterThan(0);
    const units = (): number => updatedTill.basket().filter((l) => !l.voided).reduce((n, l) => n + l.qty, 0);
    const before = units();
    updatedTill.scanBarcode('8901000000033');
    expect(units()).toBe(before + 1);
  }, 120_000);

  it('OB-536: a barred handheld\'s put-away of goods it already received is accepted by head office; OB-515: a store manager may not record scrap', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, 'u-worker', 'store_manager', [STORE]);
    await h.provisionRole(T, BOX, 'store_computer', [STORE]);
    expect((await h.request({ method: 'POST', path: '/v1/warehouse/bins/BIN-A', userId: OWNER, tenantId: T, idempotencyKey: `bin-${randomUUID()}`, body: { storeId: STORE, capacityMinor: 1000, pickable: true, zone: 'ambient' } })).status).toBe(201);
    const outbox = new SyncOutbox();
    const phone = new WarehouseSession({
      assignmentId: 'A-1', workerId: 'u-worker', storeId: STORE, grnId: 'g-1',
      bins: [{ binId: 'BIN-A', storeId: STORE, capacityMinor: 1000, pickable: true, zone: 'ambient' }],
      barcodes: [{ barcode: '890RICE', productId: 'p-rice', level: 'unit' }], packs: [{ productId: 'p-rice', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890RICE' }] }] as never,
    }, outbox, { now: () => AT });
    expect(phone.receive({ commandId: 'c-1', grnId: 'g-1', barcode: '890RICE', scannedQuantity: 1, source: 'po' }).result.accepted).toBe(true);
    phone.barNewWork(judgeClientVersion(OLD, POLICY, 'warehouse').words!);
    expect(phone.putAway({ commandId: 'mv-1', scannedProductId: 'p-rice', scannedBinId: 'BIN-A', batchId: null, quantityMinor: 1, uom: 'EA', at: AT }).result.accepted).toBe(true);
    const move = outbox.all().map((i) => i.event).find((e) => e.type === 'WarehouseMovementApplied')!;
    const path = pathFor(move)!;
    const relayed = await h.request({ method: 'POST', path, userId: BOX, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: move.payload });
    expect(relayed.status, JSON.stringify(relayed.body)).toBe(202);
    expect(relayed.body).toMatchObject({ accepted: true });
    h = harness(h); // ── COLD RESTART ──
    expect(((await h.request({ method: 'GET', path: '/v1/warehouse/bins/BIN-A', userId: OWNER, tenantId: T })).body as { occupancyMinor: number }).occupancyMinor).toBe(1);

    const scrap = { scrapId: 'SC-1', branchId: STORE, category: 'cardboard', disposal: 'sold', grams: 12_000, proceedsMinor: 300_00, handledBy: 'u-worker' };
    const asManager = await h.request({ method: 'POST', path: '/v1/scrap/sales', userId: 'u-worker', tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: scrap });
    expect(asManager.status).toBe(403);
    const asOwner = await h.request({ method: 'POST', path: '/v1/scrap/sales', userId: OWNER, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: scrap });
    expect(asOwner.status, JSON.stringify(asOwner.body)).toBe(201);
  }, 120_000);
});
