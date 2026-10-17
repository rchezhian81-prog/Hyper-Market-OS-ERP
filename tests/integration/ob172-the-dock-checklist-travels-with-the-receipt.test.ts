import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useBackings } from '../support/backings';
import { deliveryPlaces } from '../support/approved-supplier';
import { defineReceivingCheck, RECEIVING_CHECK_ID } from '../support/receiving-checklist';
import { sealedDecision } from '../support/store-seal';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import type { ApiHarness } from '../support/api-harness';

/**
 * **OB-172 "A" (owner, 17 Oct 2026, in writing, "Checklist on handheld") at head office — on the in-memory store and on
 * real PostgreSQL.** A chilled, frozen or raw-meat delivery booked on the manager's store screen (relayed `GoodsReceived`)
 * or declared complete on the warehouse handheld (assembled `ReceivingCompleted`) carries its D-6 receiving checklist INSIDE
 * the receipt, sealed with it by the store computer for the person it verified:
 *
 *   • sealed for the person who booked it, done by that person, a checklist head office holds, passing the D-6 rules →
 *     head office keeps it as its own D-6 record (`rc-<grn>`, in the doer's name, sealed in the audit trail) and the receipt
 *     is booked COMPLETE — the checklist on file, no `receiving_checklist_missing`; a failed check with its corrective
 *     action is kept as a failure, never turned green;
 *   • unsealed, changed after the seal, done by someone else, a failure with nothing done, a checklist head office does not
 *     hold → the delivery is still booked (the goods are in the building, P-01) and SAID: `receiving_checklist_not_accepted`
 *     with the reason, and `receiving_checklist_missing` exactly as before;
 *   • none carried → booked and flagged `receiving_checklist_missing` (OB-164, unchanged);
 *   • a re-sent receipt is the same receipt: one GRN, one D-6 record.
 * Synthetic data only (hard rule #7).
 */

const backings = useBackings();
const AT = '2026-10-17T06:30:00.000Z';
const WH = 'wh-1';
type Res = { status: number; body: unknown };
interface Grn { grnId: string; governanceFlags: string[]; receivingChecklist?: { recordId: string; checkId: string; outcome: string; performedBy: string }; receivingChecklistNotAccepted?: string }
const grnOf = (r: Res): Grn => (r.body as { grn: Grn }).grn;

async function seeded(h: ApiHarness, A: string): Promise<void> {
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-recv', 'store_manager');
  await h.provisionRole(A, 'u-worker', 'store_manager');
  await deliveryPlaces(h, A, 'store-1', WH);
  await h.provisionRole(A, 'u-box', 'store_computer', ['store-1']);
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: `pack-${A}-1`, type: 'CataloguePublished', occurredAt: AT, idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: A, version: 1, builtAt: AT, scope: { tenantId: A, storeId: 'store-1' }, barcodes: [], products: [
      { productId: 'p-paneer', sku: 'p-paneer', name: 'Fresh paneer 200g', unitPriceMinor: 9_000, taxBps: 500, status: 'active', uom: 'ea', batchTracked: false },
      { productId: 'p-icecream', sku: 'p-icecream', name: 'Vanilla ice cream 1L', unitPriceMinor: 25_000, taxBps: 1800, status: 'active', uom: 'ea', batchTracked: false },
      { productId: 'p-chicken', sku: 'p-chicken', name: 'Chicken curry cut 500g', unitPriceMinor: 15_000, taxBps: 0, status: 'active', uom: 'ea', batchTracked: false },
    ] } },
  }));
  const publish = async (productId: string, handling: string) => {
    const r = await h.request({ method: 'POST', path: `/v1/catalogue/products/${productId}/publish`, userId: 'u-owner', tenantId: A, idempotencyKey: `pub-${productId}`,
      body: { product: { sku: productId, name: productId, baseUom: 'each', primaryCategoryId: 'fresh', taxClass: '04061000', lifecycle: 'draft', handling }, categories: [{ categoryId: 'fresh', name: 'Fresh', parentId: null }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  await publish('p-paneer', 'chilled');
  await publish('p-icecream', 'frozen');
  await publish('p-chicken', 'raw_meat');
  await defineReceivingCheck(h, A, 'u-owner');
}

describe.each(backings)('OB-172 — the dock checklist travels with the receipt and is booked as complete — on $name', ({ harness }) => {
  async function headOffice() {
    const h = harness();
    const A = randomUUID();
    await seeded(h, A);
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: A, ...(body === undefined ? {} : { body, idempotencyKey: key ?? randomUUID() }), ...(query === undefined ? {} : { query }) });
    const checklist = (over: Record<string, unknown> = {}) => ({ checkId: RECEIVING_CHECK_ID, performedBy: 'u-recv', performedAt: AT, itemResults: { temp: 'pass', pack: 'pass' }, readingTenthsC: 30, ...over });
    const receipt = (grnId: string, productId: string, over: Record<string, unknown> = {}) => ({
      grnId, number: `DN-${grnId}`, poId: null, lineCount: 1, warehouseId: WH, receivedBy: 'u-recv', receivedAt: AT,
      lines: [{ productId, quantityMinor: 10, uom: 'ea', batchId: null, temperatureC: 3 }], storeId: 'store-1', source: 'manager-screen', ...over,
    });
    /** As the store computer relays it: sealed for the manager it verified (the box seals only that person). */
    const relay = (body: Record<string, unknown>, sealed = true, key?: string) =>
      call('POST', `/v1/inventory/goods-receipt/${String(body['grnId'])}/synced`, 'u-box', sealed ? sealedDecision(A, 'GoodsReceived', body) : body, key);
    const records = async () => ((await call('GET', '/v1/facilities/food-safety/status', 'u-owner', undefined, undefined, { asOf: '2026-10-17T12:00:00.000Z', from: '2026-10-16T00:00:00.000Z' })).body as { receiving: { recordId: string; subjectRef: string; performedBy: string; outcome: string; correctiveAction?: string }[] }).receiving;
    return { h, A, call, checklist, receipt, relay, records };
  }

  it('the store setup carries the receiving checklist and the cold-chain products (head office\'s master) to the store computer, signed', async () => {
    const { call } = await headOffice();
    const settings = await call('POST', '/v1/stores/store-1/settings', 'u-owner', { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30, warehouseId: WH });
    expect(settings.status, JSON.stringify(settings.body)).toBe(201);
    const pull = await call('GET', '/v1/store-packs/store-1', 'u-box');
    expect(pull.status, JSON.stringify(pull.body)).toBe(200);
    const section = (pull.body as { sections: Record<string, unknown> }).sections['receivingChecklist'] as { checks: { checkId: string; kind: string; items: { itemId: string }[] }[]; coldChainProductIds: string[] };
    expect(section.checks.map((c) => [c.checkId, c.kind, c.items.map((i) => i.itemId)])).toEqual([[RECEIVING_CHECK_ID, 'receiving', ['temp', 'pack']]]);
    expect(section.coldChainProductIds).toEqual(['p-chicken', 'p-icecream', 'p-paneer']);
  });

  it('the manager screen: a sealed receipt carrying a passing checklist is booked COMPLETE, its checklist head office\'s own D-6 record in the manager\'s name', async () => {
    const { call, checklist, receipt, relay, records } = await headOffice();
    const res = await relay(receipt('g-ok', 'p-paneer', { receivingChecklist: checklist() }), true, 'k-ok');
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const grn = grnOf(res);
    expect(grn.receivingChecklist).toMatchObject({ recordId: 'rc-g-ok', checkId: RECEIVING_CHECK_ID, outcome: 'pass', performedBy: 'u-recv' });
    expect(grn.governanceFlags).not.toContain('receiving_checklist_missing');
    expect(grn.governanceFlags).not.toContain('receiving_checklist_not_accepted');
    expect(await records()).toEqual([expect.objectContaining({ recordId: 'rc-g-ok', subjectRef: 'g-ok', performedBy: 'u-recv', outcome: 'pass' })]);
    // Sealed into the tamper-evident trail in the DOER's name.
    const trail = (await call('GET', '/v1/audit/trail', 'u-owner', undefined, undefined, { objectType: 'food_safety_check' })).body as { matches: { actorId: string; action: string; objectId: string }[] };
    expect(trail.matches.some((e) => e.actorId === 'u-recv' && e.action === 'food_safety.check.passed' && e.objectId === RECEIVING_CHECK_ID)).toBe(true);
    expect(((await call('GET', '/v1/audit/trail/verify', 'u-owner')).body as { intact: boolean }).intact).toBe(true);
    // The same receipt again (a re-sync after a lost reply): the same receipt, one D-6 record.
    const again = await relay(receipt('g-ok', 'p-paneer', { receivingChecklist: checklist() }), true, 'k-ok-2');
    expect(again.status).toBe(200);
    expect((again.body as { alreadyReceived: boolean }).alreadyReceived).toBe(true);
    expect((await records()).filter((r) => r.subjectRef === 'g-ok')).toHaveLength(1);
  });

  it('a failed check with its corrective action is kept as a FAILURE, with what was done — never turned green', async () => {
    const { checklist, receipt, relay, records } = await headOffice();
    const res = await relay(receipt('g-fail', 'p-icecream', { receivingChecklist: checklist({ itemResults: { temp: 'fail', pack: 'pass' }, correctiveAction: 'Two tubs soft — refused and sent back with the driver' }) }));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(grnOf(res).receivingChecklist).toMatchObject({ outcome: 'fail', performedBy: 'u-recv' });
    expect(grnOf(res).governanceFlags).not.toContain('receiving_checklist_missing');
    expect((await records()).find((r) => r.subjectRef === 'g-fail')).toMatchObject({ outcome: 'fail', correctiveAction: 'Two tubs soft — refused and sent back with the driver' });
  });

  it('a checklist head office cannot accept is SAID — not sealed, changed after the seal, done by someone else, a failure with nothing done, one it does not hold — and the delivery is still booked', async () => {
    const { h, A, checklist, receipt, relay, records } = await headOffice();
    const cases: { grnId: string; body: Record<string, unknown>; sealed: boolean; why: RegExp }[] = [
      { grnId: 'g-unsealed', body: receipt('g-unsealed', 'p-paneer', { receivingChecklist: checklist() }), sealed: false, why: /did not seal this receipt for u-recv/ },
      { grnId: 'g-other', body: receipt('g-other', 'p-chicken', { receivingChecklist: checklist({ performedBy: 'u-worker' }) }), sealed: true, why: /names u-worker, but u-recv booked the delivery in/ },
      { grnId: 'g-noaction', body: receipt('g-noaction', 'p-paneer', { receivingChecklist: checklist({ itemResults: { temp: 'fail', pack: 'pass' } }) }), sealed: true, why: /write down the corrective action/ },
      { grnId: 'g-half', body: receipt('g-half', 'p-paneer', { receivingChecklist: checklist({ itemResults: { temp: 'pass' } }) }), sealed: true, why: /not ticked: Packaging intact/ },
      { grnId: 'g-unknown', body: receipt('g-unknown', 'p-paneer', { receivingChecklist: checklist({ checkId: 'nobody-defined-this' }) }), sealed: true, why: /no active receiving checklist "nobody-defined-this"/ },
    ];
    for (const c of cases) {
      const res = await relay(c.body, c.sealed);
      expect(res.status, `${c.grnId} ${JSON.stringify(res.body)}`).toBe(202);
      const grn = grnOf(res);
      expect(grn.governanceFlags, c.grnId).toEqual(expect.arrayContaining(['receiving_checklist_not_accepted', 'receiving_checklist_missing']));
      expect(grn.receivingChecklist, c.grnId).toBeUndefined();
      expect(grn.receivingChecklistNotAccepted, c.grnId).toMatch(c.why);
    }
    // Changed after the store computer sealed it: a tick turned from fail to pass on the way.
    const sealed = sealedDecision(A, 'GoodsReceived', receipt('g-tampered', 'p-paneer', { receivingChecklist: checklist({ itemResults: { temp: 'fail', pack: 'pass' }, correctiveAction: 'moved to the chiller' }) }));
    const tampered = { ...sealed, receivingChecklist: checklist() };
    const res = await h.request({ method: 'POST', path: '/v1/inventory/goods-receipt/g-tampered/synced', userId: 'u-box', tenantId: A, idempotencyKey: randomUUID(), body: tampered });
    expect(res.status).toBe(202);
    expect(grnOf(res).governanceFlags).toContain('receiving_checklist_not_accepted');
    expect(grnOf(res).receivingChecklistNotAccepted).toMatch(/changed after the store computer sealed it/);
    // None of them reached the D-6 register.
    expect(await records()).toEqual([]);
    // And none carried at all: booked, flagged missing exactly as before (OB-164).
    const bare = await relay(receipt('g-bare', 'p-icecream'));
    expect(grnOf(bare).governanceFlags).toContain('receiving_checklist_missing');
    expect(grnOf(bare).governanceFlags).not.toContain('receiving_checklist_not_accepted');
  });

  it('the handheld: scans + a sealed "delivery complete" carrying the checklist assemble into ONE receipt booked COMPLETE; without it, flagged missing', async () => {
    const { call, A, checklist, records } = await headOffice();
    const scan = (commandId: string, grnId: string, productId: string) => call('POST', `/v1/inventory/receiving-scans/${commandId}/synced`, 'u-box', {
      commandId, grnId, productId, batchId: null, quantityMinor: 6, uom: 'EA', source: 'po', poId: null, state: 'on_hand', expiry: null,
      receivedBy: 'u-worker', storeId: 'store-1', at: AT, temperatureC: -19,
    }, `scan-${commandId}`);
    expect((await scan('c-1', 'g-hh', 'p-icecream')).status).toBeLessThan(300);
    const completion = { grnId: 'g-hh', poId: null, completedBy: 'u-worker', storeId: 'store-1', at: AT, scanCount: 1, commandIds: ['c-1'], source: 'warehouse-handheld',
      receivingChecklist: checklist({ performedBy: 'u-worker', readingTenthsC: -190 }) };
    const done = await call('POST', '/v1/inventory/goods-receipt/g-hh/assembled', 'u-box', sealedDecision(A, 'ReceivingCompleted', completion));
    expect(done.status, JSON.stringify(done.body)).toBe(202);
    expect(grnOf(done).receivingChecklist).toMatchObject({ recordId: 'rc-g-hh', outcome: 'pass', performedBy: 'u-worker' });
    expect(grnOf(done).governanceFlags).not.toContain('receiving_checklist_missing');
    expect((await records()).find((r) => r.subjectRef === 'g-hh')).toMatchObject({ performedBy: 'u-worker' });

    expect((await scan('c-2', 'g-hh-bare', 'p-chicken')).status).toBeLessThan(300);
    const bare = await call('POST', '/v1/inventory/goods-receipt/g-hh-bare/assembled', 'u-box', sealedDecision(A, 'ReceivingCompleted', { ...completion, grnId: 'g-hh-bare', commandIds: ['c-2'], receivingChecklist: undefined }));
    expect(bare.status, JSON.stringify(bare.body)).toBe(202);
    expect(grnOf(bare).governanceFlags).toContain('receiving_checklist_missing');
    // A completion sealed for someone else than the checklist's doer is not accepted.
    expect((await scan('c-3', 'g-hh-other', 'p-paneer')).status).toBeLessThan(300);
    const other = await call('POST', '/v1/inventory/goods-receipt/g-hh-other/assembled', 'u-box', sealedDecision(A, 'ReceivingCompleted', { ...completion, grnId: 'g-hh-other', commandIds: ['c-3'], receivingChecklist: checklist({ performedBy: 'u-recv' }) }));
    expect(grnOf(other).governanceFlags).toEqual(expect.arrayContaining(['receiving_checklist_not_accepted', 'receiving_checklist_missing']));
  });
});
