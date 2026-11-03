import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from 'playwright-core';
import { CONNECTED, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { says } from './lib/r4c-box-page';
import { setUpPracticeStores } from '../support/real-store';
import { approveSupplierWith, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';

/**
 * **W5 · bundle 5 (store operations) — ONE connected run: ten office pages in Chromium, served by a REAL store computer, every
 * `/v1` call reaching the PRODUCTION API on real PostgreSQL as the signed-in person.** Synthetic data, a fresh tenant.
 *
 *   • Settings — the OWNER's numbers (M13-FR-01/02/03 · M28-FR-01 · SP-2b · SP-7b): each reads "Not set" (head office's own
 *     safe rule said beside it); the owner sets the refund threshold and the no-receipt cap; head office holds them; Tamil.
 *   • Indents (M09-FR-03): the owner rejects the manager's indent (§28 — not his own); on a delivered indent he sends 3 back
 *     to the back store and it is listed as waiting for the back store's handheld.
 *   • Goods receipts (OB-141): the bread a route delivery held is kept by the owner — not the person who received it.
 *   • Stock health (OB-147): "not set" until the owner sets the minimum days; then it judges.
 *   • Recalls and trace (M10-FR-03): a trace request is recorded with its 24-hour deadline and answered with its fingerprint.
 *   • Production costs (M11-FR-02): an ingredient's cost is registered per smallest unit.
 *   • Warehouse (M09-FR-01): a bin is set up on the box's own store and read back empty.
 *   • Facilities set-up (M26-FR-04): an estimated energy reading is said to be estimated; a generator that failed to start is
 *     recorded and the power report read.
 *   • Loss prevention (M15-FR-04): evidence sealed onto a case; Return governance (M13-FR-01): the no-receipt report.
 * Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const STORE = 'br-1';
const BACK = 'br-1-back';
const MGR = 'u-mgr';

describe.skipIf(!CONNECTED)('W5 · store operations on the store computer over PostgreSQL', () => {
  let shop: BoxCloudShop;
  const as = (method: 'POST' | 'PUT', path: string, body: unknown, who = OWNER) => ok(shop.call(method, path, who, body), path);

  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'w5-store-ops', store: STORE,
      people: [{ userId: OWNER, branchId: STORE }, { userId: MGR, branchId: STORE }],
      pack: {
        policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE, warehouseId: BACK },
        indentsPolicy: { permissions: [] }, goodsReceiptPolicy: { permissions: [] }, stockHealthPolicy: { permissions: [] },
        expiryPolicy: { userId: OWNER, permissions: [] }, lossPreventionPolicy: { permissions: [] }, returnGovernancePolicy: { permissions: [] },
        warehouse: { assignmentId: 'wa-1', workerId: MGR, storeId: STORE, bins: [] },
      },
      seed: async (cloud) => {
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        let n = 0;
        const req = (method: 'POST' | 'PUT', path: string, body: unknown, userId = OWNER) => ok(cloud.request({ method, path, userId, branchId: STORE, idempotencyKey: `seed-${n += 1}`, body }), path);
        await req('POST', `/v1/org/nodes/${BACK}`, { kind: 'warehouse', name: 'Back store', parentId: STORE, companyId: 'C-PRACTICE' });
        await cloud.grant(MGR, 'store_manager', undefined, [STORE]);
        await cloud.grant(SUPPLIER_MAKER, 'store_manager');
        await cloud.grant(SUPPLIER_CHECKER, 'accountant');
        await approveSupplierWith((method, path, userId, body, idempotencyKey) => cloud.request({ method, path, userId, body, idempotencyKey }), 'sup-bread');
        await req('POST', '/v1/inventory/movements', { movementId: 'rx-RICE', productId: 'RICE', locationId: BACK, kind: 'received', quantityMinor: 50, uom: 'ea', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: OWNER, unitCostMinor: 5_000 });
        // The manager's indent (the owner rejects it on the page), and a delivered one (the owner sends some back on the page).
        await req('POST', '/v1/floor/indents/ind-1', { fromLocationId: BACK, toLocationId: STORE, lines: [{ productId: 'RICE', quantityMinor: 5, uom: 'ea' }] }, MGR);
        await req('POST', '/v1/floor/indents/ind-2', { fromLocationId: BACK, toLocationId: STORE, lines: [{ productId: 'RICE', quantityMinor: 10, uom: 'ea' }] }, MGR);
        await req('POST', '/v1/floor/indents/ind-2/approval', {});
        await req('POST', '/v1/floor/indents/ind-2/issues/is-1', { lines: [{ productId: 'RICE', quantityMinor: 10 }] });
        await req('POST', '/v1/floor/indents/ind-2/issues/is-1/receipt', { counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }] }, MGR);
        // A bread route delivery the manager checked in at the door: everything kept waits for a second person.
        await req('POST', '/v1/inventory/dsd-routes/r-bread', { supplierId: 'sup-bread', storeId: STORE, lines: [{ productId: 'BREAD', expectedMinor: 30, unitCostMinor: 2_000 }] }, MGR);
        await req('POST', '/v1/inventory/dsd-checkins/dsd-1', { supplierId: 'sup-bread', storeId: STORE, routeId: 'r-bread', driverName: 'Mani', arrivedAt: new Date().toISOString() }, MGR);
        await req('POST', '/v1/inventory/dsd-checkins/dsd-1/scans/b1', { productId: 'BREAD', quantityMinor: 30 }, MGR);
        await req('POST', '/v1/inventory/dsd-checkins/dsd-1/close', { deliveryNote: { noteRef: 'R-1', driverSignedName: 'Mani' } }, MGR);
        // A loss-prevention case to seal evidence onto.
        await req('POST', '/v1/loss-prevention/cases/case-1', { raisedFromRef: 'void_burst:lane-1', subjectRef: 'lane-1', summary: 'Voids after close', valueMinor: 12_000, assignedTo: OWNER });
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  const fill = async (page: Page, base: string, values: Record<string, string>) => {
    for (const [k, v] of Object.entries(values)) {
      const sel = `#${base}-${k}`;
      if (await page.evaluate((s) => (globalThis as unknown as { document: { querySelector(q: string): { tagName: string } | null } }).document.querySelector(s)?.tagName === 'SELECT', sel)) await page.selectOption(sel, v);
      else await page.fill(sel, v);
    }
    await page.click(`#${base}-go`);
  };

  it('Settings: every owner number reads "Not set" until he sets it; he sets two; head office holds them; Tamil too', async () => {
    const p = await shop.open(OWNER, '/settings');
    await says(p.page, '#w5-policy-heading', /^The owner's shop rules — the numbers$/);
    await says(p.page, '#w5-policy-read-rows li[data-key="refund-threshold"]', /^Refund approval threshold: Not set by the owner — until it is, every refund needs a manager's approval/);
    await says(p.page, '#w5-policy-read-rows li[data-key="no-receipt-cap"]', /Not set by the owner — returns without a bill are switched off until it is set\./);
    await says(p.page, '#w5-policy-read-rows li[data-key="write-off-threshold"]', /Not set by the owner — until it is, head office uses its built-in ₹500\.00\./);
    await says(p.page, '#w5-policy-read-rows li[data-key="match-policy"]', /Not set by the owner/);
    expect(await p.page.inputValue('#w5-policy-set-refund-threshold-amount')).toBe('');
    await fill(p.page, 'w5-policy-set-refund-threshold', { amount: 'lots' });
    await says(p.page, '#w5-policy-set-refund-threshold-said', /^Type an amount in rupees/);
    await fill(p.page, 'w5-policy-set-refund-threshold', { amount: '2000' });
    await says(p.page, '#w5-policy-set-refund-threshold-said', /^Saved\. The newest number applies from now/);
    await says(p.page, '#w5-policy-read-rows li[data-key="refund-threshold"]', /^Refund approval threshold: ₹2,000\.00 — a refund at or above this needs a manager's approval\.$/);
    await fill(p.page, 'w5-policy-set-no-receipt-cap', { amount: '300' });
    await says(p.page, '#w5-policy-read-rows li[data-key="no-receipt-cap"]', /₹300\.00 — the most one return without a bill may refund\./);
    await p.page.click('#lang');
    await says(p.page, '#w5-policy-heading', /^உரிமையாளரின் கடை விதிகள் — எண்கள்$/);
    await says(p.page, '#w5-policy-read-rows li[data-key="return-window"]', /உரிமையாளர் அமைக்கவில்லை/);
    expect(p.writes).toEqual(['POST /v1/pos/refund-threshold', 'POST /v1/pos/no-receipt-cap']);
    expect(p.errors).toEqual([]);
    await p.close();
    expect((await shop.call('GET', '/v1/pos/refund-threshold', OWNER)).body).toMatchObject({ thresholdMinor: 200_000, isDefault: false });
    expect((await shop.call('GET', '/v1/pos/no-receipt-cap', OWNER)).body).toMatchObject({ capMinor: 30_000, isSet: true });
  });

  it('Indents: the owner rejects the manager\'s indent and sends 3 back on a delivered one — it waits for the back store\'s handheld', async () => {
    const p = await shop.open(OWNER, '/indents');
    await says(p.page, '#w5-indent-changes-heading', /^Change an indent$/);
    await fill(p.page, 'w5-indent-changes-reject', { indent: 'ind-1', reason: 'shelf is full' });
    await says(p.page, '#w5-indent-changes-reject-said', /^Indent ind-1 is rejected\. Nothing moved\.$/);
    await fill(p.page, 'w5-indent-changes-return', { indent: 'ind-2', product: 'RICE', qty: '3', reason: 'overstock' });
    await says(p.page, '#w5-indent-changes-return-said', /on indent ind-2 is recorded\. The back store counts it in on the warehouse handheld\.$/);
    await says(p.page, '#w5-indent-changes-waiting-rows', /ind-2 · return ret-\w+ — 3 × RICE — sent back by u-owner: overstock/);
    expect(p.errors).toEqual([]);
    await p.close();
    const ind1 = (await shop.call('GET', '/v1/floor/indents/ind-1', OWNER)).body as { state: string };
    expect(ind1.state).toBe('rejected');
    const ind2 = (await shop.call('GET', '/v1/floor/indents/ind-2', OWNER)).body as { returns: { state: string; lines: { quantityMinor: number }[] }[] };
    expect(ind2.returns).toEqual([expect.objectContaining({ state: 'requested', lines: [expect.objectContaining({ quantityMinor: 3 })] })]);
  });

  it('Goods receipts: the bread a route delivery held is kept by the owner, not the person who received it', async () => {
    const p = await shop.open(OWNER, '/goods-receipt');
    await says(p.page, '#w5-dsd-held-held-rows li[data-key="dsd-1"]', /dsd-1 · sup-bread · received by u-mgr — 30 × BREAD/);
    await fill(p.page, 'w5-dsd-held-decide', { checkIn: 'dsd-1', decision: 'approved', reason: 'we sell it' });
    await says(p.page, '#w5-dsd-held-decide-said', /^Kept: the held goods on dsd-1 are in stock now\.$/);
    await says(p.page, '#w5-dsd-held-held-said', /^No direct delivery holds goods for a decision\.$/);
    expect(p.errors).toEqual([]);
    await p.close();
    expect(((await shop.call('GET', '/v1/inventory/dsd-checkins/dsd-1', OWNER)).body as { checkIn: { held: { state: string; decidedBy: string } } }).checkIn.held).toMatchObject({ state: 'approved', decidedBy: OWNER });
  });

  it('Stock health and Recalls: OSA says "not set" until the owner sets the minimum; a trace request is recorded and answered', async () => {
    const s = await shop.open(OWNER, '/stock-health');
    await says(s.page, '#w5-osa-suspects-said', /^The owner has not set the minimum days yet — nothing is judged until he does\.$/);
    await fill(s.page, 'w5-osa-minimum', { days: '7' });
    await says(s.page, '#w5-osa-minimum-said', /^Saved: an item is suspected after 7 day\(s\) without a sale\.$/);
    await says(s.page, '#w5-osa-suspects-said', /Owner's minimum: 7 day\(s\)\./);
    expect(s.errors).toEqual([]);
    await s.close();

    const r = await shop.open(OWNER, '/recall-trace');
    await says(r.page, '#w5-trace-requests-requests-said', /^No trace request is on file\.$/);
    await fill(r.page, 'w5-trace-requests-ask', { batch: 'RICE-B1', askedBy: 'Food safety officer', why: 'a complaint' });
    await says(r.page, '#w5-trace-requests-ask-said', /^Request tr-\w+ is recorded\. Answer it by \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/);
    const id = ((await r.page.textContent('#w5-trace-requests-ask-said')) ?? '').match(/Request (tr-\w+)/)![1]!;
    await says(r.page, `#w5-trace-requests-requests-rows li[data-key="${id}"]`, /batch RICE-B1 — asked by Food safety officer \(a complaint\) — open, answer by/);
    await fill(r.page, 'w5-trace-requests-answer', { request: id });
    await says(r.page, '#w5-trace-requests-answer-said', /^Answered: \d+ line\(s\) in the trace, \d+ gap\(s\)\. Fingerprint [0-9a-f]{12}\.$/);
    expect(r.errors).toEqual([]);
    await r.close();
  });

  it('Production costs, Warehouse bins and Facilities records reach head office as the owner', async () => {
    const c = await shop.open(OWNER, '/production-costs');
    await fill(c.page, 'w5-ingredient-cost-register', { product: 'YEAST', cost: '0.04' });
    await says(c.page, '#w5-ingredient-cost-register-said', /^YEAST is now costed at ₹0\.04 per smallest unit for production\.$/);
    expect(c.errors).toEqual([]);
    await c.close();

    const w = await shop.open(OWNER, '/warehouse-supervisor/');
    await fill(w.page, 'w5-bins-register', { bin: 'A-01', capacity: '100', pickable: 'yes', zone: 'ambient' });
    await says(w.page, '#w5-bins-register-said', /^Bin A-01 is set up: capacity 100, pickable\.$/);
    await fill(w.page, 'w5-bins-holds', { bin: 'A-01' });
    await says(w.page, '#w5-bins-holds-said', /^Bin A-01: 0 of 100 used — pickable Bin A-01 is empty\.$/);
    expect(w.errors).toEqual([]);
    await w.close();

    const f = await shop.open(OWNER, '/facilities-setup');
    await f.page.waitForSelector('#w5-facilities');
    await fill(f.page, 'w5-facilities-energy', { kwh: '40', cost: '320', source: 'estimate' });
    await says(f.page, '#w5-facilities-energy-said', /^Reading kwh-\w+ recorded \(Estimated\)\.$/);
    await f.page.click('#w5-facilities-energy-report-go');
    await says(f.page, '#w5-facilities-energy-report-said', /^40 kWh costing ₹320\.00 — 100\.0% of the cost estimated, not metered$/);
    await fill(f.page, 'w5-facilities-power', { kind: 'dg_failed_to_start', at: '2026-11-02T21:15' });
    await says(f.page, '#w5-facilities-power-said', /^Power event pwr-\w+ recorded: Generator FAILED to start\.$/);
    await says(f.page, '#w5-facilities-power-report-said', /minute\(s\) with no power and nothing behind it\./);
    expect(f.errors).toEqual([]);
    await f.close();
    const power = (await shop.call('GET', `/v1/facilities/power?branchId=${STORE}&asOf=${encodeURIComponent(new Date().toISOString())}`, OWNER)).body as { branchId: string };
    expect(power.branchId).toBe(STORE);
  });

  it('Loss prevention seals evidence onto a case; Return governance reads the no-receipt report', async () => {
    const l = await shop.open(OWNER, '/loss-prevention');
    await says(l.page, '#w5-lp-feedback-said', /^No investigation has closed yet\.$/);
    expect(await l.page.inputValue('#w5-lp-evidence-collectedBy')).toBe(OWNER);
    await fill(l.page, 'w5-lp-evidence', { case: 'case-1', kind: 'transaction_record', ref: 'bill-77', description: 'three voids after close', collectedFrom: 'lane-1 journal' });
    await says(l.page, '#w5-lp-evidence-said', /^Sealed onto case case-1 as item 1 — seal [0-9a-f]{12}\. It can never be edited or removed\.$/);
    await fill(l.page, 'w5-lp-over-returns', { sale: 'no-such-bill' });
    await says(l.page, '#w5-lp-over-returns-said', /^Head office refused: /);
    expect(l.errors).toEqual([]);
    await l.close();
    const kase = (await shop.call('GET', '/v1/loss-prevention/cases/case-1', OWNER)).body as { evidence: { ref: string; collectedBy: string }[]; chain: { intact?: boolean; valid?: boolean } };
    expect(kase.evidence).toEqual([expect.objectContaining({ ref: 'bill-77', collectedBy: OWNER })]);

    const g = await shop.open(OWNER, '/return-governance');
    await says(g.page, '#w5-no-receipt-report-said', /^No return has been taken without a bill\.$/);
    expect(g.writes).toEqual([]);
    expect(g.errors).toEqual([]);
    await g.close();
  });
});
