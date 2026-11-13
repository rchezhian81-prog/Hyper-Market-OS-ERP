import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { approvedBody, decide } from '../support/approval-request';
import { approvedSuppliers, deliveryPlaces, SUPPLIER_MAKER, SUPPLIER_CHECKER } from '../support/approved-supplier';
import { P3, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import { pinTheEveningClock, pinThePageClock } from '../support/evening-clock';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { askedThenConfirmed, confirmIt, writeCounter } from './lib/confirm-sheet';

/**
 * **W5 · the commercial ledgers — the Concessions, Buying, Suppliers and Supplier submissions pages in Chromium, served by a
 * REAL store computer, every `/v1` call reaching head office's production route set as the person signed in — on real
 * PostgreSQL when DATABASE_URL is set.** Synthetic data only. The head-office routes these sections call had no screen.
 *
 *   • M27-FR-03 · M27-FR-02/04 — a docket line recorded at the desk for the gold counter (an incomplete one refused before
 *     anything is sent), its commission under the contract; reversed by the store manager with a reason — a NEW line naming
 *     the old, the original untouched (hard rule #2); the shop day's lines marked as in the charge; no breaches; the store's
 *     own stock valued without the concessions'.
 *   • M15-FR-03 · OB-301 — the buyer checks an order whose supplier is on the owner's related-party list: told the matched
 *     FACT (GSTIN), never the person, and offered no approval; the owner approves it in writing (a reason is required).
 *   • M23-FR-01 · §28 — a supplier payment: the payer asks, a DIFFERENT person approves in their own session, the payer
 *     records exactly what was approved — head office's balance owed comes down; a payment above the balance is refused in
 *     head office's words and nothing is recorded. No money moves from the page.
 *   • M24-FR-02/03/04 — a supplier's papers on the shop's day (its food licence has lapsed: blocked, by name), its statement
 *     with the disputed line kept apart, and no portal login trying doors.
 * The test process and each page run at the shop's small hours (pinned evening clock). Needs Chromium.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER = P3.OWNER; const ACCT = 'u-acct-w5c'; const BUYER = P3.BUYER;
const GSTIN = '33ABCDE1234F1Z5';
const evening = pinTheEveningClock();
const TODAY = evening.shopDate;
const year = Number(TODAY.slice(0, 4));
const LINES = [{ productId: 'p-dal', qty: 10, unitMinor: 5_000 }];

describe.skipIf(!HAVE_BROWSER)('W5 · concessions, buying and suppliers on the store computer (M27-FR-02/03/04 · M15-FR-03 · M23-FR-01 · M24-FR-02/03/04)', () => {
  let shop: BoxPageShop;
  let pool: Pool | undefined;
  beforeAll(async () => {
    let harness: { store: SqlEventStore; idempotency: SqlIdempotencyStore } | undefined;
    if (DATABASE_URL !== undefined) {
      pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
      const dir = 'db/migrations';
      await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
      const sql = pgPoolClient(pool);
      harness = { store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) };
    }
    shop = await startBoxPageShop({
      name: 'w5-commercial',
      // The Buying and Suppliers screens are served only where the pack carries their policies (the signed-in person is filled
      // in by the box); no tolerance is invented here — zero, as the neighbouring Buying test sets it.
      pack: { buyingPolicy: { quantityToleranceBps: 0, priceToleranceBps: 0, immaterialMinor: 0, approvers: [] }, suppliersPolicy: { permissions: [] } },
      ...(harness === undefined ? {} : { harness }),
      people: [
        { userId: OWNER, permissions: ['concession.charge.read', 'concession.tag.record', 'concession.contract.manage', 'purchase.commitment.read', 'purchase.relatedparty.approve', 'purchase.order.propose', 'supplier.portal.review', 'supplier.view'] },
        { userId: BUYER, permissions: ['purchase.commitment.read', 'purchase.order.propose', 'inventory.availability.read', 'supplier.portal.review'] },
        { userId: P3.PAYER, permissions: ['supplier.view', 'purchase.supplier.pay'] },
      ],
      seed: async (h, T, store) => {
        const call = caller(h, T);
        const ok = async (p: Promise<{ status: number; body: unknown }>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
        await h.seedOwner(T, OWNER);
        await aBranch(h, T, OWNER, store);
        await h.provisionRole(T, ACCT, 'accountant');
        for (const [u, r] of [[BUYER, 'store_manager'], [P3.RECEIVER, 'store_manager'], [P3.MATCHER, 'accountant'], [P3.PAYER, 'accountant'], [P3.PAY_APPROVER, 'accountant'], [SUPPLIER_MAKER, 'store_manager'], [SUPPLIER_CHECKER, 'accountant']] as const) await h.provisionRole(T, u, r);
        // ── Concessions: the gold counter, in date.
        await ok(h.request({ method: 'PUT', path: '/v1/platform/entitlements/dept.concession', userId: OWNER, tenantId: T, idempotencyKey: 'ent-conc', body: { enabled: true } }), 'entitlement');
        const terms = { concessionaireId: 'cx-gold', name: 'Gold counter', branchId: store, startsOn: `${year - 1}-01-01`, endsOn: `${year + 1}-12-31`, basis: 'revenue_share', revenueShareBps: 1_500, depositMinor: 5_000_000, insuranceUntil: `${year + 1}-12-31`, licenceUntil: `${year + 1}-12-31` };
        await ok(h.request({ method: 'POST', path: '/v1/concession/contracts/ct-gold', userId: OWNER, tenantId: T, idempotencyKey: 'ct-gold', body: await approvedBody(h, T, OWNER, ACCT, 'concession_contract', 'ct-gold', terms, { contractId: 'ct-gold' }) }), 'contract');
        // ── Buying: a supplier whose GSTIN is on the owner's related-party list, and an order proposed with it.
        await deliveryPlaces(h, T, store, P3.BACK);
        await ok(call('POST', '/v1/purchase/suppliers/sup-kumar', SUPPLIER_MAKER, { name: 'Kumar Wholesale', gstin: GSTIN }), 'supplier');
        await ok(call('POST', '/v1/purchase/suppliers/sup-kumar/approval', SUPPLIER_CHECKER, { reason: 'documents checked' }), 'supplier approval');
        await ok(call('POST', '/v1/loss-prevention/related-parties/RP-1', OWNER, { name: 'Kumar Traders', kind: 'firm', relation: "owner's brother's firm", gstins: [GSTIN] }), 'related party');
        await ok(call('POST', '/v1/purchase/orders/po-rp', BUYER, { supplierId: 'sup-kumar', deliverToLocationId: P3.BACK, lines: [{ productId: 'p-rice', orderedQty: 10, unitCost: { minor: 5_000, currency: 'INR' } }] }), 'order');
        // ── Suppliers: a delivery received and its bill matched, so the shop owes sup-1 ₹500.
        await approvedSuppliers(h, T, 'sup-1');
        await issuedOrder(call, 'po-9', LINES, 'sup-1');
        await received(call, 'grn-9', 'po-9', LINES);
        await capturedAndMatched(call, 'inv-9', 'po-9', LINES);
        // ── Supplier submissions: sup-kumar on the portal — its food licence ran out last year; a statement with one disputed line.
        await ok(call('POST', '/v1/supplier-portal/partners/sup-kumar', BUYER, {
          grants: ['view_statement', 'view_orders'], requiredDocuments: ['fssai_licence'], logins: [],
          documents: [{ documentId: 'doc-1', partnerId: 'sup-kumar', kind: 'fssai_licence', reference: 'FSSAI-1', validFrom: `${year - 2}-01-01`, validUntil: `${year - 1}-12-31`, verifiedBy: BUYER, verifiedAt: `${year - 2}-01-02T05:00:00.000Z` }],
        }), 'partner');
        await ok(call('POST', '/v1/supplier-portal/partners/sup-kumar/statement/opening', BUYER, { openingMinor: 10_000 }), 'opening');
        await ok(call('POST', '/v1/supplier-portal/partners/sup-kumar/statement/lines/BILL-1', BUYER, { kind: 'invoice', date: TODAY, amountMinor: 50_000 }), 'line');
        await ok(call('POST', '/v1/supplier-portal/partners/sup-kumar/statement/lines/BILL-2', BUYER, { kind: 'invoice', date: TODAY, amountMinor: 7_000, status: 'disputed' }), 'disputed');
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await pool?.end(); vi.useRealTimers(); });

  const open = async (who: string, path: string) => {
    const s = await shop.open(who, path);
    await s.page.waitForLoadState('networkidle');
    await pinThePageClock(s.page.context());
    await s.page.reload({ waitUntil: 'load' });
    return s;
  };

  it('M27-FR-03: a docket line recorded at the desk, reversed as a new line naming it, the shop day\'s lines marked; M27-FR-02/04: no breach, the store\'s own stock', async () => {
    const o = await open(OWNER, '/concessions');
    await o.page.waitForSelector('#tags:not([hidden])');
    expect(o.writes, 'nothing is written when the page opens').toEqual([]);
    await o.page.fill('#tg-contract', 'ct-gold');
    await o.page.click('#tg-record summary');
    const fill = async (values: Record<string, string>) => { for (const [k, v] of Object.entries(values)) await o.page.fill(`#tg-f-${k}`, v); };
    await fill({ saleId: 'S-W5-1', lineId: '1', productId: 'ring-22k', qty: '1', counterId: 'gold-1', tillId: 'desk', shiftId: 'sh-1', grossRs: '20,000', discountRs: '', taxRs: '600', source: '' });
    await o.page.click('#tg-record-go');
    await says(o.page, '#tg-record-status', /^Every field of the docket line is needed/);
    expect(o.writes).toEqual([]);
    await fill({ source: 'docket-77' });
    await o.page.click('#tg-record-go');
    await says(o.page, '#tg-record-status', /^Recorded\.$/);
    const row = o.page.locator('#tg-rows li[data-kind="sale"]');
    await row.waitFor({ timeout: 15_000 });
    expect(await row.innerText()).toMatch(/sale · ring-22k × 1 · ₹20,000\.00/);
    expect(await row.innerText()).toMatch(/Commission ₹3,000\.00 · not yet in a charge/);
    const tagId = await row.getAttribute('data-tag');

    // The store manager reverses it with a reason: a NEW line naming the old one.
    await row.locator('details.tg-correct summary').click();
    await row.locator('.tg-reverse').click();
    await says(o.page, `#tg-rows li[data-tag="${tagId}"] .tg-correct-status`, /^Say why\.$/);
    await row.locator('.tg-reason').fill('rung on the wrong counter');
    await row.locator('.tg-reverse').click();
    await says(o.page, '#tg-status', /^Correction recorded as a new line\.$/);
    await says(o.page, '#tg-rows', new RegExp(`reversal[\\s\\S]*corrects ${tagId}`));
    await says(o.page, '#tg-figs', /lines\s*2[\s\S]*Gross\s*₹0\.00/);
    const held = (await shop.call('GET', '/v1/concession/contracts/ct-gold/tags', OWNER)).body as { tags: { tagId: string; kind: string; grossMinor: number; correctsTagId?: string }[] };
    expect(held.tags.map((t) => [t.kind, t.grossMinor, t.correctsTagId ?? null])).toEqual([['sale', 2_000_000, null], ['reversal', -2_000_000, tagId]]);

    // The shop's day: today's lines are found by the SHOP's date (at 01:00 in the shop, the UTC date is still yesterday).
    await o.page.fill('#tg-from', TODAY); await o.page.fill('#tg-to', TODAY);
    await o.page.click('#tg-show');
    await says(o.page, '#tg-figs', /lines\s*2/);
    await o.page.click('#tg-mark-charge');
    await says(o.page, '#tg-status', /^2 line\(s\) marked\.$/);
    await says(o.page, '#tg-rows', /in a charge/);

    await o.page.click('#tg-breaches');
    await says(o.page, '#tg-breach-rows', /No sale was recorded on a day a counter could not trade\./);
    await o.page.fill('#tg-branch', shop.store);
    await o.page.click('#tg-val');
    await says(o.page, '#tg-val-figs', /The store owns\s*₹0\.00 \(0 lots\)/);
    expect(o.errors).toEqual([]);
    await o.close();
  }, 180_000);

  it('M15-FR-03 · OB-301: the buyer is told the matched fact and offered no approval; the owner approves in writing', async () => {
    const b = await open(BUYER, '/buying/');
    await b.page.click('#tab-budget');
    await b.page.waitForSelector('#rpo:not([hidden])');
    await b.page.fill('#rpo-po', 'po-rp');
    await b.page.click('#rpo-check');
    await says(b.page, '#rpo-status', /^Supplier sup-kumar matches the related-party list on: GSTIN\. Not approved by the owner yet/);
    expect(await b.page.locator('#rpo').innerText()).not.toMatch(/Kumar Traders|brother/);
    expect(await b.page.isVisible('#rpo-approve'), 'a buyer is offered no approval').toBe(false);
    expect(b.errors).toEqual([]);
    await b.close();

    const o = await open(OWNER, '/buying/');
    await o.page.click('#tab-budget');
    await o.page.fill('#rpo-po', 'po-rp');
    await o.page.click('#rpo-check');
    await o.page.waitForSelector('#rpo-approve:not([hidden])');
    await o.page.click('#rpo-approve-go');
    await says(o.page, '#rpo-approve-status', /^Write the reason for approving\.$/);
    await o.page.fill('#rpo-reason', 'best rate this month; I know the firm');
    await o.page.click('#rpo-approve-go');
    await says(o.page, '#rpo-approve-status', /^Approved\. The order can now be issued/);
    await says(o.page, '#rpo-status', /The owner approved this order \(u-owner, .+\): best rate this month; I know the firm/);
    const pos = (await shop.call('GET', '/v1/purchase/orders/po-rp/related-party', BUYER)).body;
    expect(pos).toMatchObject({ needed: true, matchedOn: 'GSTIN', approved: true, approval: { approvedBy: OWNER, via: 'approval_route' } });
    expect(o.writes).toEqual(['POST /v1/purchase/orders/po-rp/related-party-approval']);
    expect(o.errors).toEqual([]);
    await o.close();
  }, 120_000);

  it('M23-FR-01 · §28: a supplier payment asked, approved by a second person, recorded as approved; one above the balance refused', async () => {
    const p = await open(P3.PAYER, '/suppliers');
    await p.page.waitForSelector('#pay:not([hidden])');
    // U7 · OB-724: the day is the shop's shared date field — it shows the shop's own day as dd/mm/yyyy and reads back as ISO.
    await p.page.waitForFunction('globalThis.sreOffice !== undefined && document.querySelector("#pay-on")?.dataset.shopDate === "on"');
    expect(await p.page.inputValue('#pay-on'), 'the shop\'s own date, as a shop person writes it').toBe(`${TODAY.slice(8, 10)}/${TODAY.slice(5, 7)}/${TODAY.slice(0, 4)}`);
    expect(await p.page.evaluate(() => (globalThis as unknown as { sreOffice: { dateOf(id: string): string | null } }).sreOffice.dateOf('pay-on')), 'the shop\'s own date').toBe(TODAY);
    const sent = writeCounter(p.page);
    await p.page.click('#pay-ask');
    await says(p.page, '#pay-status', /^Type the supplier, the amount/);
    await p.page.fill('#pay-supplier', 'sup-1');
    await p.page.fill('#pay-amount', '200');
    await p.page.selectOption('#pay-method', 'cash');
    await p.page.fill('#pay-ref', 'CASH-W5-1');
    await p.page.click('#pay-ask');
    await says(p.page, '#pay-status', /^Asked\./);
    const asked = p.page.locator('#pay-asks li[data-status="waiting"]');
    await asked.waitFor({ timeout: 15_000 });
    expect(await asked.locator('.pay-record').count(), 'nothing to record until someone else approves').toBe(0);
    // A DIFFERENT person who may pay suppliers approves it, in their own session.
    const requestId = await asked.getAttribute('data-ask');
    expect((await decide(shop.ho, shop.tenantId, P3.PAY_APPROVER, requestId!)).status).toBe(201);
    await p.page.click('#pay-asks-show');
    const ready = p.page.locator(`#pay-asks li[data-ask="${requestId}"][data-status="approved"] .pay-record`);
    await ready.waitFor({ timeout: 15_000 });
    // U7 · OB-698: recording a payment is money — the confirm sheet says the rupees and the supplier first; Go back sends nothing.
    await askedThenConfirmed(p.page, async () => { await ready.click(); }, /₹200\.00 paid to .*sup-1.* will be recorded/, sent);
    await says(p.page, '#pay-status', /^Recorded\. Still owed to the supplier: ₹300\.00\.$/);
    const account = (await shop.call('GET', '/v1/purchase/suppliers/sup-1', P3.PAYER)).body as { account: { totals: { owedMinor: number } } };
    expect(account.account.totals.owedMinor).toBe(30_000);

    // ₹400 against ₹300 owed: asked and approved, then refused by head office — nothing recorded.
    await p.page.fill('#pay-amount', '400'); await p.page.fill('#pay-ref', 'CASH-W5-2');
    await p.page.click('#pay-ask');
    await says(p.page, '#pay-status', /^Asked\./);
    const second = p.page.locator('#pay-asks li[data-status="waiting"]');
    await second.waitFor({ timeout: 15_000 });
    expect((await decide(shop.ho, shop.tenantId, P3.PAY_APPROVER, (await second.getAttribute('data-ask'))!)).status).toBe(201);
    await p.page.click('#pay-asks-show');
    await p.page.locator('#pay-asks li[data-status="approved"] .pay-record').click();
    await confirmIt(p.page);
    await says(p.page, '#pay-status', /^Head office refused: .*would pay more than/);
    expect(((await shop.call('GET', '/v1/purchase/suppliers/sup-1', P3.PAYER)).body as { account: { totals: { owedMinor: number } } }).account.totals.owedMinor).toBe(30_000);
    expect(p.writes.every((x) => x === 'POST /v1/approvals/requests' || x.startsWith('POST /v1/purchase/suppliers/sup-1/payments/'))).toBe(true);
    expect(p.errors).toEqual([]);
    await p.close();
  }, 180_000);

  it('M24-FR-02/03/04: a supplier\'s papers (its lapsed licence blocks), its statement (the disputed line apart), no probing; Tamil', async () => {
    const b = await open(BUYER, '/supplier-submissions');
    await b.page.waitForSelector('#sp:not([hidden])');
    expect(await b.page.inputValue('#sp-asof')).toBe(TODAY);
    await b.page.fill('#sp-partner', 'sup-kumar');
    await b.page.click('#sp-papers');
    await says(b.page, '#sp-rows', /Not every paper is in order — blocked by: fssai_licence\./);
    await says(b.page, '#sp-rows li[data-doc="fssai_licence"]', /expired/);
    await b.page.click('#sp-statement');
    await says(b.page, '#sp-rows li[data-fig="closing"]', /Closing balance: ₹600\.00/);
    await says(b.page, '#sp-rows li[data-fig="disputed"]', /Disputed \(kept apart\): ₹70\.00/);
    await says(b.page, '#sp-rows', /The statement adds up a second way\./);
    await b.page.click('#sp-probe');
    await says(b.page, '#sp-probe-rows', /Counted from 3 refusals — built-in, not yet set by the owner/); // OB-686
    await says(b.page, '#sp-probe-rows', /No supplier login has reached the pattern head office watches for \(3 refusals\)\./);
    expect(b.writes, 'every one of these is a read').toEqual([]);
    await b.page.click('#lang');
    await says(b.page, '#sp-h', /சப்ளையரின்/);
    expect(b.errors).toEqual([]);
    await b.close();
  }, 120_000);
});

// The shop's own date at the pinned evening is the day AFTER the UTC date — the case the window above proves.
it('the pinned evening is a shop day ahead of the UTC date', () => { expect(shopDateIn(evening.at)).toBe(TODAY); expect(evening.utcDate < TODAY).toBe(true); });
