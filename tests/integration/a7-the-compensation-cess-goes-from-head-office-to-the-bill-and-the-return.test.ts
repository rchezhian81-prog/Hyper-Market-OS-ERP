import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { splitInclusiveWithCess } from '../../packages/finance/src/cess';
import { signInTill } from '../support/till-operator';
import { backingsFor, headOffice, linkBoxTo, startBox, storePack, type Box, type Link } from '../support/till-bill-world';

/**
 * **A7 — the GST Compensation Cess from head office's per-HSN schedule to the till's bill and the GST return: in memory AND
 * on real PostgreSQL, head office and the store computer each restarted COLD, the till selling with the line cut.**
 *
 *   head office sets 28% GST and a 60% cess for pan masala's HSN (synthetic stand-in rates — the CA confirms the real ones);
 *   a cashier may not set a cess (403); a malformed one is refused (400); a different cess on the same date is refused
 *   (409); the pack carries the cess, signed → the box pulls it → offline, the till sells three packets: the line freezes
 *   the cess, net + GST + cess = the bill → the box restarts cold and sends it → head office's GSTR-1 from the till's sales
 *   files the cess in its own column (GSTN `csamt`), and the GST and the cess add back to the MRP.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const STORE = 'store-1';
const TODAY = new Date().toISOString().slice(0, 10);
const HSN = '21069020';
const PAN = { advaloremBps: 6_000, specificPerQuantityMinor: 0, perQuantity: 1 };
const boxes: Box[] = [];
let link: Link | undefined;
afterEach(async () => {
  link?.restore();
  for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); }
});

describe.each(backings)('A7 — the cess goes from head office to the bill and the return — on $name', (backing) => {
  it('set (owner only), carried in the pack, charged offline inside the MRP, filed on GSTR-1 in csamt', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }, { userId: 'u-meena', role: 'cashier' }]);
    await ho.ok('POST', `/v1/catalogue/tax-classes/${HSN}/rates/2017-07-01`, 'u-owner', { rateBps: 2_800 });
    // Who may set it, and what is refused.
    expect((await ho.call('POST', `/v1/catalogue/tax-classes/${HSN}/cess/2017-07-01`, 'u-meena', PAN)).status).toBe(403);
    expect((await ho.call('POST', `/v1/catalogue/tax-classes/${HSN}/cess/2017-07-01`, 'u-owner', { advaloremBps: 12.5 })).status).toBe(400);
    expect((await ho.call('POST', `/v1/catalogue/tax-classes/${HSN}/cess/2017-07-01`, 'u-owner', PAN)).status).toBe(201);
    expect((await ho.call('POST', `/v1/catalogue/tax-classes/${HSN}/cess/2017-07-01`, 'u-owner', { ...PAN, advaloremBps: 6_500 })).status).toBe(409);
    expect(await ho.ok('GET', `/v1/catalogue/tax-classes/${HSN}/cess`, 'u-owner', undefined, { on: TODAY })).toMatchObject({ cessLiable: true, inForce: PAN });

    await ho.ok('POST', '/v1/catalogue/products/p-pan/publish', 'u-owner', {
      product: { sku: 'PAN-10', name: 'Pan masala 10g', baseUom: 'ea', primaryCategoryId: 'pan', taxClass: HSN, lifecycle: 'active' },
      categories: [{ categoryId: 'pan', name: 'Pan masala', parentId: null }],
    });
    await ho.ok('POST', '/v1/prices/list/p-pan/entries/e1', 'u-owner', { scope: 'store', scopeRef: STORE, priceMinor: 1_000, mrpMinor: 1_000, costMinor: 600, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY });
    await ho.ok('POST', '/v1/catalogue/products/p-pan/barcodes/8903000000013', 'u-owner', { kind: 'ean' });
    await ho.ok('POST', '/v1/catalogue/pack', 'u-owner', { storeId: STORE, asOf: TODAY });
    ho.restartCold(); // ── head office COLD ─────────────────────────────────────────────────────────────────────────────

    link = linkBoxTo(ho, 'u-box', STORE);
    const box = await startBox({ tenantId: ho.tenantId, people: [{ userId: 'u-meena', displayName: 'Meena' }], pack: storePack(STORE), cloud: { boxUser: 'u-box', storeId: STORE }, env: { EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps' } });
    boxes.push(box);
    expect(await box.edge.refreshPack!()).toMatchObject({ status: 'updated' });
    expect(box.edge.node.pack()!.snapshot.products[0]?.cess).toEqual(PAN);
    link.online = false; // ── the line is cut ────────────────────────────────────────────────────────────────────────────

    // The till boots from the page the box SERVES it — the real lane's catalogue, as the box builds it from its signed pack
    // (before the integration fix the served catalogue dropped the cess, and the served till charged none).
    const html = await (await fetch(`http://127.0.0.1:${box.edge.screens!.port}/pos/`)).text();
    const served = JSON.parse(/<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html)![1]!) as CatalogueSnapshot;
    const till = bootPos({ laneId: 'lane-1', lanePort: box.edge.lane!.port, catalogue: served });
    await signInTill(till, 'u-meena');
    for (let i = 0; i < 3; i += 1) till.scanBarcode('8903000000013');
    const n = await till.nextReceipt();
    await till.tenderCash(`S-${n}`, n, new Date().toISOString());
    // Three scans, three lines of one packet each — every line splits on its own.
    const one = splitInclusiveWithCess({ grossMinor: 1_000, gstRateBps: 2_800, cess: PAN, quantity: 1 });
    const expected = { taxableMinor: 3 * one.taxableMinor, gstMinor: 3 * one.gstMinor, cessMinor: 3 * one.cessMinor };
    const read = async () => (await readLog(box.edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { lines: { cess?: unknown; cessMinor?: number }[]; netMinor: number; taxMinor: number; cessMinor?: number; total: number }] : []));
    const [sale] = await read();
    expect(sale?.lines).toHaveLength(3);
    for (const l of sale!.lines) expect(l).toMatchObject({ cess: PAN, cessMinor: one.cessMinor });
    expect(sale).toMatchObject({ netMinor: expected.taxableMinor, taxMinor: expected.gstMinor, cessMinor: expected.cessMinor, total: 3_000 });

    // ── the store computer restarts COLD; the record is the same; the line returns; head office has it.
    await box.restartCold();
    expect((await read())[0]).toEqual(sale);
    link.online = true;
    expect(await box.edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    ho.restartCold();

    const gstr1 = await ho.ok('POST', '/v1/finance/gstr1/from-sales/table-12', 'u-owner', { from: TODAY, to: TODAY, annualTurnoverMinor: 100_00_00_000_00, gstin: '33AABCS1429B1Z1', fp: `${TODAY.slice(5, 7)}${TODAY.slice(0, 4)}` }) as {
      table12: { rows: { hsnCode: string; taxableMinor: number; cgstMinor: number; sgstMinor: number; cessMinor?: number }[]; totalCessMinor?: number };
      gstn: { b2cs: { rt: number; txval: number; csamt?: number }[]; hsn: { data: { hsn_sc: string; csamt?: number }[] } };
    };
    const row = gstr1.table12.rows.find((r) => r.hsnCode === HSN)!;
    expect(row).toMatchObject({ taxableMinor: expected.taxableMinor, cessMinor: expected.cessMinor });
    expect(row.taxableMinor + row.cgstMinor + row.sgstMinor + (row.cessMinor ?? 0)).toBe(3_000); // GST + cess reconcile to the MRP
    expect(gstr1.gstn.b2cs.find((b) => b.rt === 28)?.csamt).toBe(expected.cessMinor / 100);
    expect(gstr1.gstn.hsn.data.find((d) => d.hsn_sc === HSN)?.csamt).toBe(expected.cessMinor / 100);
  }, 90_000);
});
