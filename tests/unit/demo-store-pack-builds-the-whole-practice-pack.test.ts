import { describe, it, expect } from 'vitest';
import { buildDemoStorePack, type DemoStorePackInput } from '../../db/seed/pilot/store-pack';
import { PILOT_CATALOGUE, PILOT_FOUNDATION, PILOT_TRADING_PARTNERS, PILOT_TRANSACTIONS, PILOT_DEMO_BRANCH, PILOT_DEMO_WAREHOUSE, PILOT_MACHINE_USERS } from '../../db/seed/pilot/dataset';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { readPack } from '../../edge/store-edge/src/store-pack';
import { buyingPayload, checklistPayload, countsPayload, driverPayload, managerPayload, ownerPayload, pickerPayload, warehousePayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { navigationPayload } from '../../edge/store-edge/src/screen-navigation';
import { screenOfPath } from '../../edge/store-edge/src/screen-server';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **DF-2 (OB-12, 4 Oct 2026): the demo store box gets the WHOLE practice pack, built — never retyped.**
 *
 * Until now `demo:store-pack` wrote the products section only, so every other screen on the demo box said "not
 * known" — the owner's "blog page". The hand-written file of runbook §4.3 (policies, a named manager, a delivery,
 * a wave, a route) is now built from the seed dataset, the cloud's role catalogue and the cloud's own records, and
 * the result is proven HERE through the box's own reader and the box's own screen payloads — exactly what the demo
 * box does at boot — so a section the box would refuse cannot be written. What is not proven here: the live reads
 * (tests/integration/pilot-seed-hosted.test.ts, against the real API) and the box on the hosted demo (the owner).
 */

const AT = '2026-10-04T18:30:00.000Z';
const taxOf = new Map(PILOT_CATALOGUE.taxRates.map((t) => [t.hsnCode, t.rateBps] as const));
const snapshot: CatalogueSnapshot = {
  tenantId: PILOT_FOUNDATION.tenantId,
  version: 3,
  builtAt: AT,
  products: PILOT_CATALOGUE.products.map((p) => ({ productId: p.productId, sku: p.sku, name: p.name, baseUom: p.baseUom, unitPriceMinor: p.price.priceMinor, taxBps: taxOf.get(p.taxClass) ?? 0, status: 'active' as const })),
  barcodes: PILOT_CATALOGUE.products.flatMap((p) => (p.barcode === undefined ? [] : [{ code: p.barcode.code, productId: p.productId, kind: 'standard' as const }])),
} as CatalogueSnapshot;
const master = PILOT_CATALOGUE.products.map((p) => ({ productId: p.productId, primaryCategoryId: p.primaryCategoryId }));
const availability = PILOT_TRADING_PARTNERS.goodsReceipts.flatMap((g) => g.lines.map((l) => ({ productId: l.productId, onHandMinor: l.countedMinor })));

const cloud: DemoStorePackInput['cloud'] = {
  purchaseOrders: [
    { poId: 'po-demo-7', supplierId: 'sup-demo-foods', status: 'issued', lines: [{ productId: 'prod-rice', orderedQty: 10, unitCost: { minor: 5000 } }, { productId: 'prod-oil', orderedQty: 6, unitCost: { minor: 9000 } }], receivedByProduct: { 'prod-rice': 4 } },
    { poId: 'po-demo-8', supplierId: 'sup-demo-household', status: 'proposed', lines: [{ productId: 'prod-soap', orderedQty: 48, unitCost: { minor: 2000 } }], receivedByProduct: {} },
  ],
  supplierInvoices: [{ invoice: { invoiceId: 'inv-demo-3', lines: [{ productId: 'prod-rice', quantity: 4, unitPriceMinor: 5000, lineTotalMinor: 20_000 }] } }],
  approvalDecisions: [
    { requestId: 'apr-demo-1', subjectType: 'purchase_order', subjectRef: 'po-demo-8', requestedBy: 'pilot-manager', branchId: PILOT_DEMO_BRANCH, value: { minor: 96_000 }, status: 'pending' },
    { requestId: 'apr-demo-0', subjectType: 'price_change', subjectRef: 'prod-rice', requestedBy: 'pilot-manager', branchId: PILOT_DEMO_BRANCH, value: { minor: 500 }, status: 'approved' },
  ],
  counts: [{ countId: 'cnt-demo-1', productId: 'prod-rice', locationId: PILOT_DEMO_WAREHOUSE, counterId: 'pilot-manager', expectedMinor: 200_000, countedMinor: 199_000, varianceMinor: -1000, approvedBy: null, status: 'posted' }],
};

const input = (over: Partial<DemoStorePackInput> = {}): DemoStorePackInput => ({
  snapshot, master, availability,
  foundation: PILOT_FOUNDATION, trading: PILOT_TRADING_PARTNERS, transactions: PILOT_TRANSACTIONS,
  roles: ROLE_CATALOGUE, cloud, builtBy: 'test-operator', builtAt: AT, ...over,
});

/** Through the box's own reader — a JSON round trip, as the file on disk is — then its screen input. */
function boxInput(pack: unknown): ScreenInput {
  return { pack: readPack(JSON.parse(JSON.stringify(pack)) as unknown, AT), sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: AT, tradingDay: '2026-10-04' } as unknown as ScreenInput;
}

describe('DF-2 — the whole practice pack, from what exists', () => {
  const built = buildDemoStorePack(input());
  const box = boxInput(built);

  it('keeps the products section exactly as DF-1 proved it: published prices, master categories, ledger on hand, no cost', () => {
    expect(built.products.map((p) => p['productId'])).toEqual(PILOT_CATALOGUE.products.map((p) => p.productId));
    for (const p of built.products) {
      expect(p).not.toHaveProperty('unitCostMinor');
      expect(p['categoryId']).not.toBe('uncategorised');
    }
    expect(built.products.find((p) => p['productId'] === 'prod-rice')?.['availableMinor']).toBe(200_000);
    expect(built.version).toBe(3);
  });

  it('the manager\'s screen names the manager, the store and the day\'s approvals, checklist and limits — nothing "not known"', () => {
    const m = managerPayload(box);
    expect(m['userId']).toBe('pilot-manager');
    expect(m['approvalLimitMinor']).toBe(500_000);
    expect(m['storeId']).toBe(PILOT_DEMO_BRANCH);
    expect(m['warehouseId']).toBe(PILOT_DEMO_WAREHOUSE);
    // Only the PENDING request reaches the manager — a decided one is history, not work.
    expect(m['approvals']).toEqual([{ id: 'apr-demo-1', subjectType: 'purchase_order', subjectRef: 'po-demo-8', requestedBy: 'pilot-manager', branchId: PILOT_DEMO_BRANCH, value: { minor: 96_000, currency: 'INR' }, status: 'pending' }]);
    expect(box.pack.checklist.known && box.pack.checklist.value.length).toBe(5);
    expect(box.pack.checklist.known && box.pack.checklist.value.filter((i) => i.blocking).length).toBe(2);
    expect(box.pack.lossPreventionRules.known).toBe(true);
    expect(m['openExceptions']).toEqual([]); // the rules are known and nothing breached them — a clean day, said as one
  });

  it('the owner\'s, buyer\'s and counts screens are fed: the cloud\'s orders, what was received on them, its invoices and its count records', () => {
    expect(ownerPayload(box)).not.toBeNull();
    const b = buyingPayload(box);
    expect(b).not.toBeNull();
    expect(b!['buyerId']).toBe('pilot-manager');
    expect(b!['approvers']).toEqual(['pilot-owner']);
    expect(JSON.stringify(b)).toContain('po-demo-7');
    expect(box.pack.purchaseOrders.known && box.pack.purchaseOrders.value).toEqual([
      { poId: 'po-demo-7', supplierId: 'sup-demo-foods', lines: [{ productId: 'prod-rice', qty: 10, unitMinor: 5000 }, { productId: 'prod-oil', qty: 6, unitMinor: 9000 }] },
      { poId: 'po-demo-8', supplierId: 'sup-demo-household', lines: [{ productId: 'prod-soap', qty: 48, unitMinor: 2000 }] },
    ]);
    // A receipt is what the ORDER says was received, per product; an order nothing arrived on has no receipt row.
    expect(box.pack.receipts.known && box.pack.receipts.value).toEqual([{ poId: 'po-demo-7', lines: [{ productId: 'prod-rice', qty: 4 }] }]);
    expect(box.pack.supplierInvoices.known && box.pack.supplierInvoices.value).toEqual([{ invoiceId: 'inv-demo-3', lines: [{ productId: 'prod-rice', quantity: 4, unitPriceMinor: 5000, lineTotalMinor: 20_000 }] }]);
    const c = countsPayload(box);
    expect(c).not.toBeNull();
    expect((c!['rows'] as unknown[]).length).toBe(1);
    expect(c!['permissions']).toContain('count.view');
    expect(checklistPayload(box)).not.toBeNull();
  });

  it('the back store, the picker and the driver get one practice delivery, one wave and one route, from the published products and the seeded bins and costs', () => {
    const w = warehousePayload(box);
    expect(w).not.toBeNull();
    const ordered = w!['ordered'] as Array<{ productId: string; quantityMinor: number; unitCost: { minor: number; currency: string } }>;
    expect(ordered.map((o) => o.productId)).toEqual(PILOT_CATALOGUE.products.map((p) => p.productId));
    expect(ordered.find((o) => o.productId === 'prod-rice')?.unitCost).toEqual({ minor: 5000, currency: 'INR' }); // the seeded receipt's cost, not a guess
    expect((w!['barcodes'] as unknown[]).length).toBe(PILOT_CATALOGUE.products.length);
    expect((w!['bins'] as Array<{ binId: string }>).map((b) => b.binId)).toEqual(['bin-demo-a1', 'bin-demo-c1']);
    expect(w!['grnId']).toBe('practice-grn-20261004');

    const p = pickerPayload(box);
    expect(p).not.toBeNull();
    const lines = p!['lines'] as Array<{ productId: string; requiredQty: number; bin: string }>;
    expect(lines.map((l) => [l.productId, l.requiredQty, l.bin])).toEqual([['prod-rice', 2, 'bin-demo-a1'], ['prod-soap', 1, 'bin-demo-a1'], ['prod-biscuit', 2, 'bin-demo-a1']]);
    expect(box.pack.wave.known && box.pack.wave.value?.lines.find((l) => l.productId === 'prod-rice')?.unitPriceMinor).toBe(6800); // the published price
    expect(String(p!['assignedBy'])).toContain('written by hand'); // the pack file is the override; head office's assignment is the normal source (HA-1)

    const d = driverPayload(box);
    expect(d).not.toBeNull();
    const stops = d!['stops'] as Array<{ stopId: string; codMinor: number; area: string }>;
    expect(stops.map((s) => s.stopId)).toEqual(['s1', 's2']);
    expect(stops[0]!.codMinor).toBe(2 * 6800 + 1 * 3500 + 2 * 3000); // cash on delivery = the wave's lines at published prices
    expect(stops.every((s) => s.area.endsWith('(demo)'))).toBe(true);
  });

  it('the people are the cloud\'s role catalogue and the seeded assignments, so the store computer can draw every person\'s menu — the rail appears', () => {
    expect(box.pack.roles.known && box.pack.roles.value).toEqual(ROLE_CATALOGUE); // the file is a JSON copy of the catalogue, word for word
    const assignments = (box.pack.roleAssignments.known ? box.pack.roleAssignments.value : []) as Array<{ userId: string; roleId: string; branchScope: unknown }>;
    expect(assignments.find((a) => a.userId === 'pilot-owner')).toEqual({ userId: 'pilot-owner', roleId: 'owner', branchScope: 'all' });
    expect(assignments.find((a) => a.userId === 'pilot-manager')).toEqual({ userId: 'pilot-manager', roleId: 'store_manager', branchScope: [PILOT_DEMO_BRANCH] });

    const nav = navigationPayload({ screen: 'manager', pack: box.pack, payload: managerPayload(box), screenOf: screenOfPath });
    expect(nav.userId).toBe('pilot-manager');
    expect(nav.groups.length).toBeGreaterThan(0);
    const items = nav.groups.flatMap((g) => g.items);
    expect(items.some((i) => i.current)).toBe(true);
    expect(items.map((i) => i.id)).toContain('counts');

    const counts = navigationPayload({ screen: 'counts', pack: box.pack, payload: countsPayload(box), screenOf: screenOfPath });
    expect(counts.groups.flatMap((g) => g.items).filter((i) => i.current).map((i) => i.id)).toEqual(['counts']);
  });

  it('every screen with a named viewer names a SEEDED person with that person\'s permissions from the catalogue — never a stand-in, never the box\'s machine identity', () => {
    const people = new Set([PILOT_FOUNDATION.genesisOwner, ...PILOT_FOUNDATION.users].map((u) => u.userId));
    const roleOf = new Map([PILOT_FOUNDATION.genesisOwner, ...PILOT_FOUNDATION.users].map((u) => [u.userId, u.role] as const));
    const policies = Object.entries(built).filter(([k, v]) => k.endsWith('Policy') && typeof v === 'object' && v !== null) as Array<[string, Record<string, unknown>]>;
    expect(policies.length).toBeGreaterThanOrEqual(35);
    for (const [name, policy] of policies) {
      const who = (policy['userId'] ?? policy['buyerId']) as string;
      expect(people.has(who), `${name} names ${who}`).toBe(true);
      expect(PILOT_MACHINE_USERS, `${name} names the machine`).not.toContain(who);
      if (Array.isArray(policy['permissions'])) {
        expect(policy['permissions'], `${name}'s permissions`).toEqual(ROLE_CATALOGUE.find((r) => r.id === roleOf.get(who))!.permissions);
      }
    }
    // The practice script's cast (runbook §7): the accountant on the cash office and the books; the owner on the controls.
    expect((built['cashOfficePolicy'] as { userId: string }).userId).toBe('pilot-accountant');
    expect((built['dayBookPolicy'] as { userId: string }).userId).toBe('pilot-accountant');
    expect((built['adminPolicy'] as { userId: string }).userId).toBe('pilot-owner');
    expect((built['financePolicy'] as { period: string }).period).toBe('2026-10');
  });

  it('a cloud read that did not answer leaves its section OUT — the screen says it was not told; nothing is invented', () => {
    const silent = buildDemoStorePack(input({ cloud: { purchaseOrders: null, supplierInvoices: null, approvalDecisions: null, counts: null } }));
    for (const section of ['approvals', 'purchaseOrders', 'receipts', 'supplierInvoices', 'countsQueue']) expect(silent).not.toHaveProperty(section);
    const pack = boxInput(silent).pack;
    expect(pack.approvals.known).toBe(false);
    expect(pack.purchaseOrders.known).toBe(false);
    expect(pack.countsQueue.known).toBe(false);
    // and the practice work that needs no cloud read is still there
    expect(pack.warehouse.known && pack.wave.known && pack.route.known && pack.checklist.known).toBe(true);
    // a cloud that answered "nothing waiting" is KNOWN empty — zero approvals is an answer
    const quiet = buildDemoStorePack(input({ cloud: { ...cloud, approvalDecisions: [] } }));
    expect(boxInput(quiet).pack.approvals).toEqual({ known: true, value: [] });
  });

  it('is a plain JSON file for the box, says what it is, and names no secret', () => {
    const text = JSON.stringify(built);
    expect(built._comment).toMatch(/DEMO store pack .*synthetic data only/);
    expect(built._comment).toContain('test-operator');
    expect(text).not.toMatch(/password|secret|token|BEGIN (RSA|OPENSSH)/i);
    expect(JSON.parse(text)).toEqual(built);
  });

  it('refuses a dataset with no branch, and a viewer who is not a seeded person', () => {
    expect(() => buildDemoStorePack(input({ foundation: { ...PILOT_FOUNDATION, org: [] } }))).toThrow(/names no branch/);
    expect(() => buildDemoStorePack(input({ foundation: { ...PILOT_FOUNDATION, users: PILOT_FOUNDATION.users.filter((u) => u.userId !== 'pilot-manager') } }))).toThrow(/not a seeded person/);
  });
});
