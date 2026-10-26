import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { TillRuleRefusedError } from '../../apps/pos/src/session';
import { signInTill, signInAtLane, receiptNumberAt, operatorHeader } from '../support/till-operator';
import { backingsFor, headOffice, linkBoxTo, startBox, storePack, type Box, type Link } from '../support/till-bill-world';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **B12 · OB-325 (owner, 23 Oct 2026: "build, switched ON") — from head office's product master to a sale refused at the
 * till with the cable out, on the in-memory store AND real PostgreSQL, head office and the store computer each restarted
 * COLD.**
 *
 *   head office: a "Packaged drinking water" category marked BIS-controlled; a product in it with no BIS licence is NOT
 *   published (said why); one with a current licence and one whose licence has run out are; the signed pack carries both
 *   licences; the store computer pulls it, then the line is cut:
 *   the till sells the current one, refuses the lapsed one at the scan (offline, in words); a record posted straight to the
 *   box's socket with the lapsed one is refused before the box's disk; after a cold restart of the box (still offline) the
 *   same refusals hold from the pack it kept; the line comes back and head office has exactly the one sale.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const STORE = 'store-1';
const TODAY = shopDateIn(new Date().toISOString());
const PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }];
const boxes: Box[] = [];
let link: Link | undefined;
afterEach(async () => {
  link?.restore();
  for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); }
});

describe.each(backings)('B12 — BIS goods need a current licence, refused offline at the till and the box — on $name', (backing) => {
  it('unlicensed product not published; current one sells, lapsed one refused at the scan and at the socket, across cold restarts', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }]);
    const water = [{ categoryId: 'water', name: 'Packaged drinking water', parentId: null, regulated: ['bis_controlled'] }];
    await ho.ok('POST', '/v1/catalogue/tax-classes/2201/rates/2017-07-01', 'u-owner', { rateBps: 1_800 });
    const publish = (id: string, safety: Record<string, unknown> | undefined) => ho.call('POST', `/v1/catalogue/products/${id}/publish`, 'u-owner', {
      product: { sku: id.toUpperCase(), name: `Drinking water ${id}`, baseUom: 'ea', primaryCategoryId: 'water', taxClass: '2201', lifecycle: 'active', ...(safety === undefined ? {} : { safety }) },
      categories: water,
    });
    const none = await publish('p-none', undefined);
    expect(none.status).toBe(422);
    expect(JSON.stringify(none.body)).toContain('no BIS licence number');
    expect((await publish('p-good', { bisLicenceNo: 'CM/L-7654321098', bisLicenceValidUntil: '2099-12-31' })).status).toBe(201);
    expect((await publish('p-lapsed', { bisLicenceNo: 'CM/L-1111111111', bisLicenceValidUntil: '2020-03-31' })).status).toBe(201);
    for (const [id, code] of [['p-good', '8901000000019'], ['p-lapsed', '8901000000026']] as const) {
      await ho.ok('POST', `/v1/prices/list/${id}/entries/e1`, 'u-owner', { scope: 'store', scopeRef: STORE, priceMinor: 2_000, mrpMinor: 2_000, costMinor: 1_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY });
      await ho.ok('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, 'u-owner', { kind: 'ean' });
    }
    await ho.ok('POST', '/v1/catalogue/pack', 'u-owner', { storeId: STORE, asOf: TODAY });
    ho.restartCold(); // ── head office COLD ─────────────────────────────────────────────────────────────────────────────

    link = linkBoxTo(ho, 'u-box', STORE);
    const box = await startBox({ tenantId: ho.tenantId, people: PEOPLE, pack: storePack(STORE), cloud: { boxUser: 'u-box', storeId: STORE } });
    boxes.push(box);
    expect(await box.edge.refreshPack!()).toMatchObject({ status: 'updated' });
    const products = box.edge.node.pack()!.snapshot.products;
    expect(products.map((p) => p.productId).sort()).toEqual(['p-good', 'p-lapsed']);
    expect(products.find((p) => p.productId === 'p-lapsed')?.regulatedFlags).toMatchObject({ bisControlled: true, bisLicenceNo: 'CM/L-1111111111', bisLicenceValidUntil: '2020-03-31' });

    link.online = false; // ── the line is cut ────────────────────────────────────────────────────────────────────────────
    const ring = async (): Promise<void> => {
      const till = bootPos({ laneId: 'lane-1', lanePort: box.edge.lane!.port, catalogue: box.edge.node.pack()!.snapshot });
      await signInTill(till, 'u-lanecash');
      expect(() => till.scanBarcode('8901000000026')).toThrow(TillRuleRefusedError);
      try { till.scanBarcode('8901000000026'); } catch (e) { expect((e as TillRuleRefusedError).laneMessage).toMatch(/BIS \(ISI mark\) licence CM\/L-1111111111 ran out on 2020-03-31/); }
      expect(till.basket()).toHaveLength(0);
      // A record from an older till, posted straight to the socket: refused before the box's disk.
      const token = await signInAtLane(box.edge.lane!.port, 'u-lanecash');
      const number = await receiptNumberAt(box.edge.lane!.port, token);
      const raw = await (await fetch(`http://127.0.0.1:${box.edge.lane!.port}/lane/sales`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
        body: JSON.stringify({
          id: `S-${number}`, number, laneId: 'lane-1', cashierId: 'u-lanecash', tradingDay: TODAY, committedAt: new Date().toISOString(),
          lines: [{ productId: 'p-lapsed', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_000, lineTotalMinor: 2_000, taxRateBps: 1_800 }],
          tenders: [{ kind: 'cash', amount: { minor: 2_000, currency: 'INR' }, status: 'settled' }], total: 2_000, currency: 'INR',
        }),
      })).json() as Record<string, unknown>;
      expect(raw).toMatchObject({ committed: false, refusedBecause: 'bis_licence_expired', productId: 'p-lapsed' });
    };
    await ring();
    // The current one sells, offline.
    const till = bootPos({ laneId: 'lane-1', lanePort: box.edge.lane!.port, catalogue: box.edge.node.pack()!.snapshot });
    await signInTill(till, 'u-lanecash');
    till.scanBarcode('8901000000019');
    const n = await till.nextReceipt();
    await till.tenderCash(`S-${n}`, n, new Date().toISOString());
    expect(await readLog(box.edge.log.path)).toHaveLength(1);

    // ── the store computer restarts COLD, still offline: the same refusals, from the pack it kept on its disk.
    await box.restartCold();
    expect(box.edge.node.pack()!.snapshot.products.find((p) => p.productId === 'p-lapsed')?.regulatedFlags?.['bisLicenceValidUntil']).toBe('2020-03-31');
    await ring();
    const kept = (await readLog(box.edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { lines: { productId: string }[] }] : []));
    expect(kept.map((s) => s.lines.map((l) => l.productId))).toEqual([['p-good']]);

    // ── the line returns: head office has the one sale, nothing of the lapsed product.
    link.online = true;
    expect(await box.edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    ho.restartCold();
    const sale = await ho.call('GET', `/v1/sales/S-${n}`, 'u-owner');
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    expect(JSON.stringify(sale.body)).not.toContain('p-lapsed');
  }, 90_000);
});
