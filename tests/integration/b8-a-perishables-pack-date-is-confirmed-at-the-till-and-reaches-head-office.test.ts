import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { PackDateCheckRequiredError } from '../../apps/pos/src/session';
import { signInTill, signInAtLane, receiptNumberAt, operatorHeader } from '../support/till-operator';
import { backingsFor, headOffice, linkBoxTo, startBox, storePack, type Box, type Link } from '../support/till-bill-world';

/**
 * **B8 · OB-298 (owner, 23 Oct 2026) — a perishable's printed pack date, confirmed with one tap at the till, from head
 * office's product master to head office's sale record: in memory AND on real PostgreSQL, head office and the store
 * computer each restarted COLD, the till trading with the line cut.**
 *
 *   head office marks milk perishable and publishes it → the signed pack carries the flag → the box pulls it → offline:
 *   the till refuses to add the milk until the cashier confirms the date on the pack; the confirmation rides on the line to
 *   the box's disk; a basket held on the box with a confirmed milk line comes back WITH its check after a cold restart of
 *   the box and sells; an older till's record with no check is kept (hard rule #1) → the line returns → head office has the
 *   checked line with no finding, and the unchecked one flagged `perishable_sold_without_date_check`.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const STORE = 'store-1';
const TODAY = new Date().toISOString().slice(0, 10);
const MILK_CODE = '8902000000016';
const boxes: Box[] = [];
let link: Link | undefined;
afterEach(async () => {
  link?.restore();
  for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); }
});

describe.each(backings)('B8 — the pack date is confirmed at the till and reaches head office — on $name', (backing) => {
  it('asked before the line is added; kept on the line, on a held basket across a cold restart, and at head office', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }, { userId: 'u-meena', role: 'cashier' }]);
    await ho.ok('POST', '/v1/catalogue/tax-classes/0401/rates/2017-07-01', 'u-owner', { rateBps: 0 });
    await ho.ok('POST', '/v1/catalogue/products/p-milk/publish', 'u-owner', {
      product: { sku: 'MILK-500', name: 'Milk 500ml', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active', safety: { perishable: true } },
      categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }],
    });
    await ho.ok('POST', '/v1/prices/list/p-milk/entries/e1', 'u-owner', { scope: 'store', scopeRef: STORE, priceMinor: 3_000, mrpMinor: 3_000, costMinor: 2_500, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY });
    await ho.ok('POST', `/v1/catalogue/products/p-milk/barcodes/${MILK_CODE}`, 'u-owner', { kind: 'ean' });
    await ho.ok('POST', '/v1/catalogue/pack', 'u-owner', { storeId: STORE, asOf: TODAY });
    ho.restartCold();

    link = linkBoxTo(ho, 'u-box', STORE);
    const box = await startBox({ tenantId: ho.tenantId, people: [{ userId: 'u-meena', displayName: 'Meena' }], pack: storePack(STORE), cloud: { boxUser: 'u-box', storeId: STORE } });
    boxes.push(box);
    expect(await box.edge.refreshPack!()).toMatchObject({ status: 'updated' });
    expect(box.edge.node.pack()!.snapshot.products[0]?.regulatedFlags).toEqual({ perishable: true });
    link.online = false; // ── the line is cut ──────────────────────────────────────────────────────────────────────────

    const till = bootPos({ laneId: 'lane-1', lanePort: box.edge.lane!.port, catalogue: box.edge.node.pack()!.snapshot });
    await signInTill(till, 'u-meena');
    expect(() => till.scanBarcode(MILK_CODE)).toThrow(PackDateCheckRequiredError);
    expect(till.basket()).toHaveLength(0);
    const at = new Date().toISOString();
    till.confirmPackDate('p-milk', at);
    till.scanBarcode(MILK_CODE);
    const n1 = await till.nextReceipt();
    await till.tenderCash(`S-${n1}`, n1, new Date().toISOString());

    // A held basket with a confirmed milk line, held ON THE BOX.
    till.newSale();
    till.confirmPackDate('p-milk', at);
    till.scanBarcode(MILK_CODE);
    expect(await till.holdAtTill('fetching wallet')).toMatchObject({ ok: true });

    // An older till's record with no check, straight to the socket: kept — the goods are gone (hard rule #1).
    const token = await signInAtLane(box.edge.lane!.port, 'u-meena');
    const n3 = await receiptNumberAt(box.edge.lane!.port, token);
    const old = await (await fetch(`http://127.0.0.1:${box.edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({
        id: `S-${n3}`, number: n3, laneId: 'lane-1', cashierId: 'u-meena', tradingDay: TODAY, committedAt: new Date().toISOString(),
        lines: [{ productId: 'p-milk', quantityMinor: 1, uom: 'ea', unitPriceMinor: 3_000, lineTotalMinor: 3_000, taxRateBps: 0 }],
        tenders: [{ kind: 'cash', amount: { minor: 3_000, currency: 'INR' }, status: 'settled' }], total: 3_000, currency: 'INR',
      }),
    })).json() as Record<string, unknown>;
    expect(old).toMatchObject({ committed: true });

    // ── the store computer restarts COLD, still offline; a fresh till recalls the held basket WITH its check, and sells.
    await box.restartCold();
    const after = bootPos({ laneId: 'lane-1', lanePort: box.edge.lane!.port, catalogue: box.edge.node.pack()!.snapshot });
    await signInTill(after, 'u-meena');
    const held = await after.heldAtTill();
    expect(held).toHaveLength(1);
    expect(await after.recallAtTill(held[0]!.billId)).toMatchObject({ ok: true });
    const n2 = await after.nextReceipt();
    await after.tenderCash(`S-${n2}`, n2, new Date().toISOString());
    const onDisk = (await readLog(box.edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { id: string; lines: { packDateCheck?: unknown }[] }] : []));
    expect(onDisk.find((s) => s.id === `S-${n1}`)?.lines[0]?.packDateCheck).toEqual({ confirmedBy: 'u-meena', confirmedAt: at });
    expect(onDisk.find((s) => s.id === `S-${n2}`)?.lines[0]?.packDateCheck).toEqual({ confirmedBy: 'u-meena', confirmedAt: at });

    // ── the line returns: head office has the checked lines with no finding, and flags the unchecked one.
    link.online = true;
    expect(await box.edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    ho.restartCold();
    const register = (await ho.call('GET', '/v1/sales/exceptions', 'u-owner')).body as { material: { kind: string; saleId: string }[] };
    // Only the older till's sale is flagged for the pack date; the two checked ones are not.
    expect(register.material.filter((e) => e.kind === 'perishable_sold_without_date_check').map((e) => e.saleId)).toEqual([`S-${n3}`]);
    // Head office's own record of the sale (its append-only sales stream) carries the check on the line.
    const banked = (await ho.h.store.readStream(ho.tenantId, 'sales', { type: 'SaleCommitted' }))
      .map((e) => e.event.payload as { saleId?: string; lines?: { packDateCheck?: unknown }[] });
    expect(banked.find((s) => s.saleId === `S-${n1}`)?.lines?.[0]?.packDateCheck).toEqual({ confirmedBy: 'u-meena', confirmedAt: at });
    expect(banked.find((s) => s.saleId === `S-${n3}`)?.lines?.[0]?.packDateCheck).toBeUndefined();
  }, 90_000);
});
