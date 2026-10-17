import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useBackings } from '../support/backings';
import { deliveryPlaces } from '../support/approved-supplier';
import { recordReceivingChecklist } from '../support/receiving-checklist';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import type { ApiHarness } from '../support/api-harness';

/**
 * **OB-164 "A" (owner, 16 Oct 2026, in writing, "Chilled and frozen only") — a chilled or frozen goods receipt needs its
 * D-6 receiving checklist recorded before it is booked into stock; dry goods do not.** Which goods are chilled or frozen is
 * the PRODUCT MASTER's handling class and cold-chain limits (SF-07), never the sender's word. On the real API in memory and
 * on PostgreSQL:
 *   • a chilled delivery (paneer) and a frozen one (ice cream) with no checklist on file are refused by name — no goods
 *     receipt, no stock — and the refusal names the products and how to record the checklist;
 *   • a dry delivery (dal) is booked with no checklist (optional);
 *   • once the receiving checklist is recorded against the goods receipt id, the same delivery is booked and the receipt
 *     names the checklist on file;
 *   • a delivery booked at the store with no network and relayed later (the goods are already in the building, P-01) is
 *     booked and FLAGGED `receiving_checklist_missing` — never silently passed.
 */

const backings = useBackings();
const AT = '2026-10-09T09:00:00.000Z';
const WH = 'wh-1';
type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Grn { grnId: string; governanceFlags: string[]; receivingChecklist?: { recordId: string; checkId: string; outcome: string; performedBy: string } }

async function seeded(h: ApiHarness, A: string): Promise<void> {
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-recv', 'store_manager');
  await deliveryPlaces(h, A, 'store-1', WH);
  await h.provisionRole(A, 'u-box', 'store_computer', ['store-1']);
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' }, barcodes: [], products: [
      { productId: 'p-paneer', sku: 'p-paneer', name: 'Fresh paneer 200g', unitPriceMinor: 9_000, taxBps: 500, status: 'active', uom: 'ea', batchTracked: false },
      { productId: 'p-icecream', sku: 'p-icecream', name: 'Vanilla ice cream 1L', unitPriceMinor: 25_000, taxBps: 1800, status: 'active', uom: 'ea', batchTracked: false },
      { productId: 'p-dal', sku: 'p-dal', name: 'Toor dal 1kg', unitPriceMinor: 16_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
    ] } },
  }));
  const publish = async (productId: string, handling: string, extra: Record<string, unknown> = {}) => {
    const r = await h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: 'u-owner', tenantId: A, idempotencyKey: `pub-${productId}`,
      body: { product: { sku: productId, name: productId, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft', handling, ...extra }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  await publish('p-paneer', 'chilled', { coldChain: { minTenthsC: -20, maxTenthsC: 40 } });
  await publish('p-icecream', 'frozen');
  await publish('p-dal', 'ambient');
}

describe.each(backings)('OB-164 — a chilled or frozen delivery is checked before it is booked — on $name', ({ harness }) => {
  it('refuses a chilled or frozen receipt with no checklist by name; books dry goods; books it once the checklist is on file; flags a relayed one', async () => {
    const h = harness();
    const A = randomUUID();
    await seeded(h, A);
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: A, ...(body === undefined ? {} : { body, idempotencyKey: randomUUID() }), ...(query === undefined ? {} : { query }) });
    const line = (lineId: string, productId: string, temperatureC?: number) => ({ lineId, productId, orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 4_000, currency: 'INR' }, condition: 'good', ...(temperatureC === undefined ? {} : { temperatureC }) });
    const receive = (grnId: string, lines: unknown[]) => call('POST', `/v1/inventory/goods-receipt/${grnId}`, 'u-recv', { warehouseId: WH, receivedOnDate: '2026-10-09', currency: 'INR', lines });
    const onHand = async (productId: string): Promise<number> =>
      ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, { productId })).body as { rows: { onHandMinor: number }[] }).rows.reduce((s, r) => s + r.onHandMinor, 0);

    // Chilled, and a mixed delivery carrying frozen: refused by name, nothing booked.
    const chilled = await receive('g-chilled', [line('L1', 'p-paneer', 3)]);
    expect(chilled.status).toBe(422);
    expect(codeOf(chilled)).toBe('receiving_checklist_required');
    expect((chilled.body as { error: { whatHappened: string; nextSafeAction: string } }).error.whatHappened).toMatch(/chilled or frozen goods \(p-paneer\)/);
    expect((chilled.body as { error: { nextSafeAction: string } }).error.nextSafeAction).toMatch(/subjectRef "g-chilled"/);
    const mixed = await receive('g-mixed', [line('L1', 'p-dal'), line('L2', 'p-icecream', -18)]);
    expect(codeOf(mixed)).toBe('receiving_checklist_required');
    expect((mixed.body as { error: { whatHappened: string } }).error.whatHappened).toMatch(/\(p-icecream\)/);
    expect((await call('GET', '/v1/inventory/goods-receipt/g-chilled', 'u-owner')).status).toBe(404);
    expect(await onHand('p-paneer')).toBe(0);
    expect(await onHand('p-icecream')).toBe(0);

    // Dry goods: the checklist is optional.
    const dry = await receive('g-dry', [line('L1', 'p-dal')]);
    expect(dry.status, JSON.stringify(dry.body)).toBe(201);
    expect((dry.body as { grn: Grn }).grn.receivingChecklist).toBeUndefined();

    // The checklist recorded against the receipt at the door; the same delivery is booked and names it.
    await recordReceivingChecklist(h, A, 'g-chilled', 'u-recv');
    const booked = await receive('g-chilled', [line('L1', 'p-paneer', 3)]);
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect((booked.body as { grn: Grn }).grn.receivingChecklist).toMatchObject({ recordId: 'rc-g-chilled', outcome: 'pass', performedBy: 'u-recv' });
    expect(await onHand('p-paneer')).toBe(10);

    // Booked at the store with no network and relayed: in the building already — booked and SAID.
    const relayed = await call('POST', '/v1/inventory/goods-receipt/g-relay/synced', 'u-box', {
      grnId: 'g-relay', number: 'DN-1', poId: null, lineCount: 1, warehouseId: WH, receivedBy: 'u-recv', receivedAt: AT,
      lines: [{ productId: 'p-icecream', quantityMinor: 10, uom: 'ea', batchId: null, temperatureC: -18 }], storeId: 'store-1', source: 'manager-screen',
    });
    expect(relayed.status, JSON.stringify(relayed.body)).toBe(202);
    expect((relayed.body as { grn: Grn }).grn.governanceFlags).toContain('receiving_checklist_missing');
    // A relayed dry delivery carries no such flag.
    const relayedDry = await call('POST', '/v1/inventory/goods-receipt/g-relay-dry/synced', 'u-box', {
      grnId: 'g-relay-dry', number: 'DN-2', poId: null, lineCount: 1, warehouseId: WH, receivedBy: 'u-recv', receivedAt: AT,
      lines: [{ productId: 'p-dal', quantityMinor: 5, uom: 'ea', batchId: null }], storeId: 'store-1', source: 'manager-screen',
    });
    expect((relayedDry.body as { grn: Grn }).grn.governanceFlags).not.toContain('receiving_checklist_missing');
  });
});
