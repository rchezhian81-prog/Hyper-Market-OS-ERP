import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { writeOffCommittedEntry, eInvoiceAdapter, eWayBillAdapter } from '../../services/api/src/adapters';
import { wasteWriteOffsSectionFor, WASTE_WINDOW_DAYS } from '../../services/api/src/r2-screen-feeds';
import { gstReconciliationQueueSection, GST_SETTLED_CATEGORIES } from '../../services/api/src/round-a-pack-sections';
import { buildStorePackSections } from '../../services/api/src/store-pack-builder';
import { catalogueForViewer, PRODUCT_COMMERCIAL_PERMISSION, GLOBAL_FOR, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { startScreenServer, SCREEN_HOST } from '../../edge/store-edge/src/screen-server';
import { emptyPack, type StorePack } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/index';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { WASTE_REVIEW_COPY } from '../../apps/web-erp/src/waste-review-session';
import { GST_RECON_COPY } from '../../apps/web-erp/src/gst-reconciliation-session';
import type { StoredWriteOff } from '../../services/inventory/src/write-off';
import { createCashierProductView } from '../../apps/web-erp/src/catalogue-cashier-view';

/**
 * The owner's Round 2 answers (31 Oct 2026), each proven at its boundary:
 *   • OB-565 — the Waste page carries the last 30 SHOP days of write-offs (today is day 1): day 30 in, day 31 out, read by
 *     the shop's clock (never the UTC date); older ones stay in head office's register, and the page says so;
 *   • OB-568 — the GST queue in the store pack carries what still needs attention (any month) plus the current and the
 *     previous GST return month (the shop's calendar), never the whole history; the page says so;
 *   • OB-569 — a viewer without the right to see costs and suppliers (the cashier) is sent each product's name, price
 *     and barcode only: no cost, no margin floor, no commercial field leaves the store computer for their browser.
 */

const T = 'tenant-r2-answers';
/** 31 Oct 2026, 11:30 in the shop (Asia/Kolkata): today's trading day is 2026-10-31. */
const NOW = '2026-10-31T06:00:00.000Z';
const now = (): string => NOW;
const SHOP = { timeZone: 'Asia/Kolkata', tradingDayCutoff: '00:00' } as const;

const writeOff = (id: string, at: string, locationId = 'S-A'): StoredWriteOff => ({
  id, productId: 'OIL', locationId, lossType: 'damage', qtyRemoved: 1, uom: 'each', valueMinor: 5_000, currency: 'INR',
  reasonCode: 'damage', requiredApproval: false, evidenceRef: null, raisedBy: 'u-mgr', approvedBy: null, at,
});

describe('OB-565 — the Waste page carries the last 30 shop days of write-offs', () => {
  it('day 30 (by the shop\'s clock) is in; day 31 is out — even where the UTC date says otherwise; another store\'s never', async () => {
    const store = new InMemoryEventStore();
    const record = async (w: StoredWriteOff): Promise<void> => { const e = writeOffCommittedEntry(T, w); await store.append(T, e.stream, e.event); };
    expect(WASTE_WINDOW_DAYS).toBe(30);
    await record(writeOff('W-TODAY', NOW));
    // 19:00 UTC on 1 Oct is 00:30 on 2 Oct in the shop: day 30 (the UTC date, 1 Oct, would wrongly make it day 31).
    await record(writeOff('W-DAY30', '2026-10-01T19:00:00.000Z'));
    // 18:00 UTC on 1 Oct is 23:30 on 1 Oct in the shop: day 31.
    await record(writeOff('W-DAY31', '2026-10-01T18:00:00.000Z'));
    await record(writeOff('W-OLD', '2026-08-15T06:00:00.000Z'));
    await record(writeOff('W-ELSEWHERE', NOW, 'S-B'));
    const rows = await wasteWriteOffsSectionFor(store, now, T, 'S-A', (loc) => loc, SHOP);
    expect(rows.map((r) => r.id)).toEqual(['W-TODAY', 'W-DAY30']);
    // Nothing is deleted: head office's register still holds every write-off (append-only, hard rule #2).
    expect((await store.readStream(T, writeOffCommittedEntry(T, writeOff('x', NOW)).stream)).length).toBe(5);
  });

  it('the store pack builder applies the window with the shop\'s calendar', async () => {
    const store = new InMemoryEventStore();
    for (const w of [writeOff('W-IN', '2026-10-02T06:00:00.000Z', 'S-A'), writeOff('W-OUT', '2026-10-01T06:00:00.000Z', 'S-A')]) {
      const e = writeOffCommittedEntry(T, w); await store.append(T, e.stream, e.event);
    }
    const sections = await buildStorePackSections({ store, now, signer: undefined as never, settings: async () => undefined, storeName: async () => undefined }, T, 'S-A');
    expect((sections['wasteWriteOffs'] as { id: string }[]).map((r) => r.id)).toEqual(['W-IN']);
  });

  it('the page says plainly it shows the last 30 days, and that older ones are at head office — English and Tamil', () => {
    expect(WASTE_REVIEW_COPY.en.lead).toContain('in the last 30 days');
    expect(WASTE_REVIEW_COPY.en.lead).toContain('Older write-offs are kept in head office’s records and reports');
    expect(WASTE_REVIEW_COPY.en.stateEmpty).toMatch(/^Nothing recorded in the last 30 days/);
    expect(WASTE_REVIEW_COPY.ta.lead).toContain('கடந்த 30 நாட்களில்');
    expect(WASTE_REVIEW_COPY.ta.lead).toContain('தலைமை அலுவலகத்தின்');
    expect(WASTE_REVIEW_COPY.ta.stateEmpty).toContain('கடந்த 30 நாட்களில்');
  });
});

describe('OB-568 — the GST queue carries what needs attention plus this and last GST return month', () => {
  const IRN = 'a'.repeat(64);
  const invoice = async (store: InMemoryEventStore, id: string, documentDate: string, answer: 'registered' | 'rejected' | 'cancelled' | 'pending'): Promise<void> => {
    const einv = eInvoiceAdapter({ store, now });
    await einv.recordSubmit(T, id, { supplierGstin: '33AAAAA0000A1Z5', documentType: 'INV', documentNumber: id, documentDate, financialYear: '2026-27', taxableMinor: 100_000 } as never, NOW);
    if (answer === 'registered' || answer === 'cancelled') await einv.recordResponse(T, id, { invoiceId: id, state: 'registered', irn: IRN, signedQr: 'qr', detail: 'registered' } as never, NOW);
    if (answer === 'cancelled') await einv.recordCancel(T, id, 'duplicate', NOW);
    if (answer === 'rejected') await einv.recordResponse(T, id, { invoiceId: id, state: 'rejected', errors: ['bad GSTIN'], detail: 'rejected' } as never, NOW);
  };

  it('settled documents of the current and previous month ride; an older settled one does not; one needing attention always rides', async () => {
    expect([...GST_SETTLED_CATEGORIES].sort()).toEqual(['cancelled', 'generated', 'registered']);
    const store = new InMemoryEventStore();
    await invoice(store, 'INV-OCT', '2026-10-31', 'registered');       // current month (first day of the window's end)
    await invoice(store, 'INV-SEP-1', '2026-09-01', 'registered');     // previous month, its first day — in
    await invoice(store, 'INV-AUG-31', '2026-08-31', 'registered');    // two months back, its last day — out
    await invoice(store, 'INV-AUG-CANC', '2026-08-10', 'cancelled');   // settled, old — out
    await invoice(store, 'INV-JUN-REJ', '2026-06-05', 'rejected');     // needs attention, old — in
    await invoice(store, 'INV-MAY-WAIT', '2026-05-05', 'pending');     // still processing, old — in
    // An e-way bill the portal rejected long ago still needs a person.
    const ewb = eWayBillAdapter({ store, now });
    await ewb.recordSubmit(T, 'MV-OLD', { supplierGstin: '33AAAAA0000A1Z5', documentType: 'INV', documentNumber: 'MV-OLD', documentDate: '2026-04-02', financialYear: '2026-27', hsnCode: '1006', consignmentValueMinor: 6_000_000, supplyRoute: 'intra_state', movementReason: 'supply', fromPincode: '600001', toPincode: '600002' } as never, NOW);
    await ewb.recordResponse(T, 'MV-OLD', { movementId: 'MV-OLD', state: 'rejected', errors: ['bad pincode'], detail: 'rejected' } as never, NOW);

    const rows = await gstReconciliationQueueSection({ store, now }, T, ['2026-10', '2026-09']);
    expect(rows.map((r) => `${r.id}:${r.category}`)).toEqual([
      'INV-JUN-REJ:rejected', 'INV-MAY-WAIT:processing', 'INV-OCT:registered', 'INV-SEP-1:registered', 'MV-OLD:rejected',
    ]);
  });

  it('the store pack builder sends the current and the previous GST return month by the shop\'s calendar', async () => {
    const store = new InMemoryEventStore();
    await invoice(store, 'INV-SEP', '2026-09-15', 'registered');
    await invoice(store, 'INV-AUG', '2026-08-15', 'registered');
    // 31 Oct 19:00 UTC is 1 Nov in the shop: the current GST month is November, the previous October — September is out.
    const late = (): string => '2026-10-31T19:00:00.000Z';
    const at = async (clock: () => string): Promise<string[]> => ((await buildStorePackSections({ store, now: clock, signer: undefined as never, settings: async () => undefined, storeName: async () => undefined }, T, 'S-A'))['gstReconciliationQueue'] as { id: string }[]).map((r) => r.id);
    expect(await at(now)).toEqual(['INV-SEP']);
    expect(await at(late)).toEqual([]);
  });

  it('the page says what it shows and that the full register is at head office — English and Tamil', () => {
    expect(GST_RECON_COPY.en.lead).toContain('still needs attention, whatever its month');
    expect(GST_RECON_COPY.en.lead).toContain('this GST return month and the month before');
    expect(GST_RECON_COPY.en.lead).toContain('the full register is at head office');
    expect(GST_RECON_COPY.ta.lead).toContain('முழுப் பதிவேடு தலைமை அலுவலகத்தில் உள்ளது');
    expect(GST_RECON_COPY.ta.stateEmpty).toContain('முழுப் பதிவேடு தலைமை அலுவலகத்தில் உள்ளது');
  });
});

describe('OB-569 — a cashier is sent name, price and barcode only; costs never leave the store computer', () => {
  const FULL = {
    userId: 'u-cash', storeId: 'S-A', today: '2026-10-31', marginFloorBps: 2_000, approvers: ['u-mgr'],
    categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    products: [{ productId: 'OIL', tenantId: T, sku: 'OIL-1L', name: 'Sunflower oil 1 L', brand: 'Sunny', manufacturer: 'Sunny Oils Pvt Ltd', primaryCategoryId: 'grocery', baseUom: 'ea', taxClass: '1512', lifecycle: 'active', mrpHistory: [{ value: { minor: 18_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }], attributes: { supplier: 'sup-9' } }],
    priceEntries: [{ id: 'p1', productId: 'OIL', scope: 'store', scopeRef: 'S-A', price: { minor: 16_500, currency: 'INR' }, effectiveFrom: '2026-10-01', status: 'active', version: 1 }],
    barcodes: [{ barcode: '8901234567890', productId: 'OIL' }],
    costsMinor: { OIL: 13_250 },
  };

  it(`the right is the existing \`${PRODUCT_COMMERCIAL_PERMISSION}\`: the owner, the manager and the accountant hold it, the cashier does not`, () => {
    const holds = (role: string): boolean => ROLE_CATALOGUE.find((r) => r.id === role)!.permissions.includes(PRODUCT_COMMERCIAL_PERMISSION);
    expect(PRODUCT_COMMERCIAL_PERMISSION).toBe('supplier.view');
    expect(['owner', 'store_manager', 'accountant'].map(holds)).toEqual([true, true, true]);
    expect(holds('cashier')).toBe(false);
    // …and the cashier may open Products (the page's own word), which is why the filter is needed at all.
    expect(ROLE_CATALOGUE.find((r) => r.id === 'cashier')!.permissions).toContain('catalogue.pack.read');
  });

  it('without the right (or with rights unknown): no cost map, no margin floor, no approvers; each product keeps its id and name only', () => {
    for (const permissions of [['catalogue.pack.read'], null]) {
      const out = catalogueForViewer(FULL, permissions)!;
      expect(out).not.toHaveProperty('costsMinor');
      expect(out).not.toHaveProperty('marginFloorBps');
      expect(out).not.toHaveProperty('approvers');
      // Exactly the fields the cashier's view needs to show name, price and barcode — no code, unit, status, MRP, category,
      // tax class, brand, maker or attributes.
      expect(out['products']).toEqual([{ productId: 'OIL', name: 'Sunflower oil 1 L' }]);
      expect(Object.keys((out['products'] as object[])[0]!).sort()).toEqual(['name', 'productId']);
      expect(out['productFields']).toBe('name_price_barcode');
      expect(out['priceEntries']).toEqual(FULL.priceEntries);
      expect(out['barcodes']).toEqual(FULL.barcodes);
      expect(JSON.stringify(out)).not.toMatch(/13250|Sunny|sup-9|cost|1512|OIL-1L|mrpHistory|lifecycle|taxClass|primaryCategoryId/i);
    }
  });

  it('with the right: the payload is whole', () => {
    expect(catalogueForViewer(FULL, ['catalogue.pack.read', 'supplier.view'])).toBe(FULL);
    expect(catalogueForViewer(null, [])).toBeNull();
  });

  describe('through the store computer\'s own page server', () => {
    const stops: (() => Promise<void>)[] = [];
    afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });
    const known = <V>(value: V) => ({ known: true as const, value });
    const pack = (): StorePack => ({
      ...emptyPack('test'),
      receivedAt: NOW, version: 1,
      policies: known({ storeId: 'S-A', branchId: 'S-A', branchName: 'SRE', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, privacySlaDays: 15, warehouseId: 'S-A' }),
      pricingPolicy: known({ userId: 'u-cash', approvers: ['u-mgr'], marginFloorBps: 2_000 }),
      products: known([{ productId: 'OIL', name: 'Sunflower oil 1 L', barcodes: ['8901234567890'], unitPriceMinor: 16_500, unitCostMinor: 13_250, taxBps: 500, status: 'active', uom: 'ea' }]),
      productMaster: known([FULL.products[0]]),
      roles: known(ROLE_CATALOGUE),
      roleAssignments: known([{ userId: 'u-cash', roleId: 'cashier', branchScope: ['S-A'] }, { userId: 'u-mgr', roleId: 'store_manager', branchScope: ['S-A'] }]),
    } as unknown as StorePack);
    const serve = async (): Promise<string> => {
      const snapshot = (): ScreenInput => ({ pack: pack(), sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: NOW, tradingDay: '2026-10-31' } as unknown as ScreenInput);
      const server = await startScreenServer({ port: 0, appsDir: 'apps', snapshot, trustForwardedUser: true });
      stops.push(() => server.stop());
      return `http://${SCREEN_HOST}:${server.port}`;
    };
    const productsPage = async (base: string, who: string): Promise<{ html: string; payload: Record<string, unknown> }> => {
      const res = await fetch(`${base}/products`, { headers: { 'x-sre-user': who }, redirect: 'follow' });
      expect(res.status).toBe(200);
      const html = await res.text();
      const match = new RegExp(`<script>window\\.${GLOBAL_FOR.catalogue} = ([\\s\\S]*?);</script>`).exec(html);
      expect(match, 'the Products page carries its data').not.toBeNull();
      return { html, payload: JSON.parse(match![1]!) as Record<string, unknown> };
    };

    it('the cashier\'s page carries no cost anywhere in what the box sends; the manager\'s carries the cost', async () => {
      const base = await serve();
      const cashier = await productsPage(base, 'u-cash');
      expect(cashier.payload).not.toHaveProperty('costsMinor');
      expect(cashier.payload).not.toHaveProperty('marginFloorBps');
      expect(cashier.payload['barcodes']).toEqual([{ barcode: '8901234567890', productId: 'OIL' }]);
      expect(cashier.payload['products']).toEqual([{ productId: 'OIL', name: 'Sunflower oil 1 L' }]);
      expect(cashier.payload['productFields']).toBe('name_price_barcode');
      // Not the cost figure, not the maker or the supplier — anywhere in the page the box sent.
      expect(cashier.html).not.toMatch(/13250|costsMinor|unitCostMinor|Sunny Oils|sup-9/);

      const manager = await productsPage(base, 'u-mgr');
      expect(manager.payload['costsMinor']).toEqual({ OIL: 13_250 });
      expect(manager.payload['marginFloorBps']).toBe(2_000);
      expect(manager.payload).not.toHaveProperty('productFields');
    });
  });

  it('the cashier\'s page shows name, price and barcode: looked up by name or barcode, the price read from head office for today', async () => {
    let state: 'not_loaded' | 'loaded' = 'not_loaded';
    const entry = { id: 'p1', productId: 'OIL', scope: 'store' as const, scopeRef: 'S-A', price: { minor: 16_500, currency: 'INR' as const }, effectiveFrom: '2026-10-01T00:00:00.000Z', status: 'active' as const, version: 1 };
    const view = createCashierProductView(
      { storeId: 'S-A', today: '2026-10-31', products: [{ productId: 'OIL', name: 'Sunflower oil 1 L' }, { productId: 'SALT', name: 'Salt 1 kg' }], barcodes: [{ barcode: '8901234567890', productId: 'OIL' }] },
      { state: (id) => (id === 'OIL' ? state : 'not_loaded'), why: () => undefined, load: async () => { state = 'loaded'; return state; }, entries: () => (state === 'loaded' ? [entry] : []) },
    );
    expect(view.rows('').map((r) => r.name)).toEqual(['Salt 1 kg', 'Sunflower oil 1 L']);
    expect(view.rows('89012').map((r) => r.productId)).toEqual(['OIL']);
    expect(view.rows('salt')[0]).toEqual({ productId: 'SALT', name: 'Salt 1 kg', barcodes: [], priceState: 'not_loaded', priceMinor: null });
    expect(await view.loadPrice('OIL')).toBe('loaded');
    expect(view.rows('oil')[0]).toEqual({ productId: 'OIL', name: 'Sunflower oil 1 L', barcodes: ['8901234567890'], priceState: 'loaded', priceMinor: 16_500 });
  });
});
