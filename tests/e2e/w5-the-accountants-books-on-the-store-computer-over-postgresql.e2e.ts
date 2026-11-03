import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { CONNECTED, OWNER, ok, startBoxPageOnCloud, type BoxCloudShop } from './lib/box-page-on-cloud';
import { says } from './lib/r4c-box-page';
import { setUpPracticeStores } from '../support/real-store';
import { creditLimitWithApproval } from '../support/approved-credit-limit';
import { customerListPrice, unpriced } from '../support/b2b-price-on-record';
import { sentWithApproval } from '../support/approval-request';
import { pinTheEveningClock, pinThePageClock } from '../support/evening-clock';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import type { Page } from 'playwright-core';

/**
 * **W5 · the accountant's books — ONE connected run: the Month-end, Accounts and Tally names, and Business customers pages in
 * Chromium, served by a REAL store computer, head office the PRODUCTION API on real PostgreSQL.** Synthetic data only. The
 * head-office routes these sections call had no screen before W5.
 *
 *   • M23-FR-01 · M22-FR-02 — "Into the books": a business customer's tax invoice is in the register and not in the books;
 *     posting with no ledger mapping is REFUSED in head office's words (nothing posted); once the accountant's mapping is
 *     defined, one click posts it — head office's B2B postings show nothing unposted — and a second click posts nothing
 *     twice. The fleet register says which kinds the map does not name (not posted, not zero). Count differences and
 *     losses read as empty registers. D02-FR-06: a display-funding receipt is recorded against its contract and head office
 *     reconciles it to the ledger.
 *   • M23-FR-04 · D10-FR-01 — "For the CA": the month's independent checks are read (none this month, said so); a line from
 *     another outside source is compared; the pack is refused without the shop's day cut-off and then prepared — stating the
 *     cut-off and both sides — writing nothing; the cost and profit centres are read against the ledger.
 *   • M23-FR-01 — account classes: "not set yet" with head office's suggestion only shown; the accountant gives two accounts
 *     their class and saves; head office holds exactly those, and the month's profit and loss then reads.
 *   • M22-FR-01/02/04 · M23 — Business customers: the dunning step for an overdue customer (a reminder; nothing sent),
 *     what the customer is shown against what the books hold (head office's own figures), an order delivered and not
 *     billed, and no portal login trying doors; Tamil words.
 * The test process and each page run at the shop's small hours (pinned evening clock). Needs DATABASE_URL and Chromium.
 */

const STORE = 'br-1';
const ACCT = 'u-acct-w5';
const CUST = 'CAT-W5';
const LINE = { lineId: 'l1', productId: 'rice', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 };
const evening = pinTheEveningClock();
const TODAY = evening.shopDate;
const MONTH = TODAY.slice(0, 7);
const daysBefore = (n: number): string => shopDateIn(new Date(Date.parse(`${TODAY}T06:30:00.000Z`) - n * 86_400_000).toISOString());

describe.skipIf(!CONNECTED)('W5 · the accountant\'s books on the store computer over PostgreSQL (M23-FR-01/04 · D10-FR-01 · M22-FR-01/02/04)', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'w5-books', store: STORE,
      people: [{ userId: OWNER }, { userId: ACCT }],
      seed: async (cloud, h) => {
        await setUpPracticeStores(cloud, OWNER, [STORE]);
        await cloud.grant(ACCT, 'accountant');
        let n = 0;
        const as = (method: 'POST' | 'PUT', path: string, body: unknown, userId = OWNER) => ok(cloud.request({ method, path, userId, idempotencyKey: `w5-seed-${n += 1}`, body }), path);
        await as('PUT', '/v1/platform/entitlements/b2b', { enabled: true });
        await ok(creditLimitWithApproval((r) => cloud.request(r), OWNER, ACCT, CUST, { creditLimitMinor: 5_000_000, paymentTermsDays: 30 }, 'w5-acc'), 'credit account');
        // An old invoice, overdue by 10 days: on the customer's AR ledger and in collections, the same ₹1,000.
        await as('POST', `/v1/b2b/accounts/${CUST}/receivables`, { movementId: 'ar-old', kind: 'invoice', amountMinor: 100_000, ref: 'INV-OLD' });
        await as('POST', `/v1/b2b/collections/${CUST}/invoices/inv-old`, { number: 'INV-OLD', issuedOn: daysBefore(40), dueOn: daysBefore(10), grossMinor: 100_000 });
        // Two orders of ten bags each: the first delivered and billed (a postable invoice), the second delivered, not billed.
        const listed = customerListPrice('rice', CUST, LINE.unitPriceMinor);
        await as('POST', listed.path, listed.body);
        await as('POST', '/v1/inventory/movements', { movementId: 'rice-in', productId: 'rice', locationId: STORE, kind: 'received', quantityMinor: 50, uom: 'ea', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: OWNER });
        for (const k of ['1', '2']) {
          await as('POST', `/v1/b2b/documents/${CUST}/quotations/q${k}`, { lines: unpriced([LINE]), locationId: STORE });
          await as('POST', `/v1/b2b/documents/${CUST}/orders/so${k}`, { fromQuotationId: `q${k}`, locationId: STORE });
          await as('POST', `/v1/b2b/documents/${CUST}/challans/dc${k}`, { fromOrderId: `so${k}`, dispatched: { l1: 10 } });
        }
        await as('POST', `/v1/b2b/documents/${CUST}/invoices/inv1`, { fromOrderId: 'so1' });
        // A supplier's display space, funded ₹600 — recorded by the owner and approved by finance (a second person).
        const year = Number(TODAY.slice(0, 4));
        const contract = { storeId: STORE, supplierId: 'sup-tea', description: 'tea end-cap by the door', fundingAmount: { minor: 60_000, currency: 'INR' }, startsOn: `${year}-01-01`, endsOn: `${year + 1}-12-31`, locationIds: ['END-1'] };
        const recorded = await sentWithApproval(h, cloud.tenantId, OWNER, ACCT, { kind: 'display_contract', subjectRef: 'dc-tea', pathIds: { contractId: 'dc-tea' }, valueMinor: 60_000 },
          contract, (b) => h.request({ method: 'POST', path: '/v1/merchandising/display-contracts/dc-tea', userId: OWNER, tenantId: cloud.tenantId, idempotencyKey: 'w5-dc-tea', body: b }));
        if (recorded.status >= 300) throw new Error(`display contract: ${recorded.status} ${JSON.stringify(recorded.body)}`);
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); vi.useRealTimers(); });

  const open = async (who: string, path: string) => {
    const s = await shop.open(who, path);
    // Let the first load finish its reads before the reload, so nothing of it is cut off half-way.
    await s.page.waitForLoadState('networkidle');
    await pinThePageClock(s.page.context());
    await s.page.reload({ waitUntil: 'load' });
    return s;
  };
  const tiles = (page: Page, stream: string) => page.locator(`#bk-${stream}-tiles`).innerText();

  it('M23-FR-01 · D02-FR-06: into the books — refused with no mapping, posted once with it, nothing twice; a display-funding receipt reconciles', async () => {
    const a = await open(ACCT, '/finance-close');
    expect(a.status).toBe(200);
    await a.page.waitForSelector('#tab-books:not([hidden])');
    expect(a.writes, 'nothing is written when the page opens').toEqual([]);
    await a.page.fill('#period', MONTH); await a.page.dispatchEvent('#period', 'change');
    await a.page.click('#tab-books');
    await a.page.waitForSelector('#view-books:not([hidden])');

    // B2B: the tax invoice is in the register, not in the books.
    await a.page.click('#bk-b2b-read');
    await expect.poll(() => tiles(a.page, 'b2b'), { timeout: 15_000 }).toMatch(/In the register\s*1[\s\S]*In the books\s*0[\s\S]*Not yet in the books\s*1/);
    await says(a.page, '#bk-b2b-rows', /inv1.*not yet in the books|not yet in the books/);
    // No ledger mapping: refused in head office's words, nothing posted.
    await a.page.click('#bk-b2b-post');
    await says(a.page, '#bk-b2b-status', /^Head office refused: No ledger mapping has been defined/);
    expect(((await ok(shop.call('GET', '/v1/finance/b2b/postings', ACCT), 'postings')) as { journals: unknown[] }).journals).toEqual([]);

    // The accountant defines the mapping (her decision, outside this section); one click posts the invoice, once.
    await ok(shop.call('PUT', '/v1/finance/posting-map', ACCT, DEFAULT_RETAIL_POSTING_MAP), 'posting map');
    await a.page.click('#bk-b2b-post');
    await says(a.page, '#bk-b2b-status', /^1 entr\(ies\) put in the books\.$/);
    await expect.poll(() => tiles(a.page, 'b2b'), { timeout: 15_000 }).toMatch(/In the books\s*1[\s\S]*Not yet in the books\s*0/);
    const postings = (await ok(shop.call('GET', '/v1/finance/b2b/postings', ACCT), 'postings')) as { journals: { postedBy: string }[]; unposted: string[] };
    expect(postings.unposted).toEqual([]);
    expect(postings.journals.map((j) => j.postedBy)).toEqual([ACCT]);
    await a.page.click('#bk-b2b-post');
    await says(a.page, '#bk-b2b-status', /^Nothing new was posted\.$/);
    expect(((await ok(shop.call('GET', '/v1/finance/b2b/postings', ACCT), 'again')) as { journals: unknown[] }).journals).toHaveLength(1);

    // The other registers: empty here, and the fleet's unmapped kinds said by name.
    for (const s of ['stock', 'losses']) { await a.page.click(`#bk-${s}-read`); await says(a.page, `#bk-${s}-rows`, /Nothing in this register yet\./); }
    await a.page.click('#bk-fleet-read');
    await says(a.page, '#bk-fleet-status', /no rule for delivery_fleet:approved and delivery_fleet:paid/);

    // Display funding: ₹250 of the ₹600 arrives; head office records it as one journal and reconciles it to the ledger.
    await a.page.click('#bk-display-read');
    const row = a.page.locator('#bk-display-rows li[data-contract="dc-tea"]');
    await row.waitFor({ timeout: 15_000 });
    await row.locator('.rc-record').click();
    await says(a.page, '#bk-display-rows li[data-contract="dc-tea"] .rc-status', /^Type the amount in rupees/);
    await row.locator('.rc-amount').fill('250');
    await row.locator('.rc-on').fill(TODAY);
    await row.locator('.rc-ref').fill('NEFT-W5-1');
    await row.locator('.rc-record').click();
    await says(a.page, '#bk-display-status', /^Recorded\. Still to come: ₹350\.00\.$/);
    const df = (await ok(shop.call('GET', '/v1/finance/display-funding', ACCT), 'display funding')) as { lines: { contractId: string; receivedMinor: number; ledgerMinor: number; agrees: boolean }[] };
    expect(df.lines.find((l) => l.contractId === 'dc-tea')).toMatchObject({ receivedMinor: 25_000, ledgerMinor: 25_000, agrees: true });
    expect(a.writes.filter((x) => x.startsWith('POST /v1/finance/display-funding/')).length).toBe(1);
    expect(a.errors).toEqual([]);
    await a.close();
  }, 240_000);

  it('M23-FR-04 · D10-FR-01: for the CA — the month\'s checks, a compared line, the pack (refused with no cut-off, then prepared), the centres', async () => {
    const a = await open(ACCT, '/finance-close');
    await a.page.waitForSelector('#tab-ca:not([hidden])');
    await a.page.fill('#period', MONTH); await a.page.dispatchEvent('#period', 'change');
    await a.page.click('#tab-ca');
    // Head office's own independent check: the credit-customer ledger (₹2,050 — the old hand-keyed ₹1,000 and the ₹1,050
    // invoice) against the receivables the books hold (₹1,050 — only the posted invoice). A difference, said with both sides.
    const ev = (await ok(shop.call('GET', `/v1/finance/periods/${MONTH}/independent-evidence`, ACCT), 'evidence')) as { checks: { name: string; leftMinor: number; rightMinor: number }[] };
    expect(ev.checks.length).toBeGreaterThan(0);
    await a.page.click('#ca-evidence');
    for (const c of ev.checks) await says(a.page, '#ca-checks', new RegExp(c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await says(a.page, '#ca-checks', /Credit-customer receivables[\s\S]*does not agree[\s\S]*From the books: ₹2,050\.00[\s\S]*From outside: ₹1,050\.00/);
    // A line typed from another outside source must be whole before anything is sent.
    await a.page.click('#ca-extra summary');
    await a.page.fill('#ca-x-name', 'GSTR-3B output tax (synthetic)');
    await a.page.fill('#ca-x-books', '50');
    await a.page.click('#ca-totals');
    await says(a.page, '#ca-pack-status', /^Each added line needs/);
    await a.page.fill('#ca-x-outside', '50');
    await a.page.fill('#ca-x-method', 'the books | the filed return');
    await a.page.click('#ca-totals');
    await says(a.page, '#ca-pack-status', /^Some control totals do not agree/);
    await says(a.page, '#ca-results', /GSTR-3B output tax \(synthetic\)[\s\S]*agrees/);
    await says(a.page, '#ca-results', /Credit-customer receivables[\s\S]*differs by/);
    await a.page.click('#ca-pack');
    await says(a.page, '#ca-pack-status', /^Type the time the shop's day ends/);
    await a.page.fill('#ca-cutoff', '02:00');
    await a.page.click('#ca-pack');
    // The pack is still produced, and says plainly it may not be signed (P-08).
    await says(a.page, '#ca-pack-status', /^NOT signable — .*does not reconcile — NOT signable$/);
    await says(a.page, '#ca-statement', /These accounts are NOT complete for the period/);
    await says(a.page, '#ca-statement', /aligned to the trading-day cut-off of 02:00/);
    await says(a.page, '#ca-statement', /Prepared by u-acct-w5/);
    expect(a.writes.filter((x) => !/control-totals|evidence-pack/.test(x)), 'comparing and the pack are reads: nothing else is sent').toEqual([]);

    await a.page.click('#centres-show');
    await says(a.page, '#centres-status', /add up to the ledger|NOT add up to the ledger|nothing to place in a centre/);
    const centres = (await ok(shop.call('GET', `/v1/finance/periods/${MONTH}/centres`, ACCT), 'centres')) as { detail: string };
    expect(await a.page.locator('#centres-status').innerText()).toContain(centres.detail);
    expect(a.errors).toEqual([]);
    await a.close();
  }, 180_000);

  it('M23-FR-01: account classes — not set, the suggestion only shown; the accountant sets two and head office holds exactly those', async () => {
    const a = await open(ACCT, '/posting-map');
    await a.page.waitForSelector('#classes:not([hidden])');
    await a.page.click('#classes-show');
    await says(a.page, '#classes-state', /^Not set yet/);
    const rev = a.page.locator('#classes-rows li[data-account="sales_revenue"]');
    await rev.waitFor({ timeout: 15_000 });
    expect(await rev.innerText()).toMatch(/Set by the accountant: Not set · Head office suggests: Income/);
    expect(await rev.locator('select').inputValue(), 'the suggestion is never chosen for her').toBe('');
    await rev.locator('select').selectOption('income');
    await a.page.locator('#classes-rows li[data-account="inventory_write_off"] select').selectOption('expense');
    await a.page.click('#classes-save');
    await says(a.page, '#classes-status', /^Account classes saved by u-acct-w5\.$/);
    await says(a.page, '#classes-state', /^Set by the accountant$/);
    const held = (await ok(shop.call('GET', '/v1/finance/account-classes', ACCT), 'classes')) as { defined: boolean; classes: Record<string, string> };
    expect(held).toMatchObject({ defined: true, classes: { sales_revenue: 'income', inventory_write_off: 'expense' } });
    expect(Object.keys(held.classes).sort()).toEqual(['inventory_write_off', 'sales_revenue']);
    expect((await shop.call('GET', `/v1/finance/periods/${MONTH}/profit-and-loss`, ACCT)).status).toBe(200);
    expect(a.errors).toEqual([]);
    await a.close();
  }, 120_000);

  it('M22-FR-01/02/04 · M23: Business customers — the dunning step, the customer against the books, the order chain, no probing; Tamil', async () => {
    const a = await open(ACCT, '/b2b');
    await a.page.waitForSelector('#bk:not([hidden])');
    expect(await a.page.inputValue('#bk-asof'), 'the shop\'s own date').toBe(TODAY);
    await a.page.fill('#bk-customer', CUST);
    await a.page.click('#bk-dunning');
    await says(a.page, '#bk-figs', /Send a reminder/);
    await says(a.page, '#bk-figs', /Oldest overdue \(days\)\s*10/);
    const ar = (await ok(shop.call('GET', `/v1/b2b/collections/${CUST}/reconciliation?asOf=${TODAY}`, ACCT), 'ar')) as { portalOutstandingMinor: number; financeOutstandingMinor: number; agrees: boolean };
    await a.page.click('#bk-reconcile');
    const rupees = (m: number) => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    await says(a.page, '#bk-figs', new RegExp(`What the customer is shown\\s*${rupees(ar.portalOutstandingMinor).replace(/[.]/g, '\\.')}`));
    await says(a.page, '#bk-figs', new RegExp(`What the books hold\\s*${rupees(ar.financeOutstandingMinor).replace(/[.]/g, '\\.')}`));
    await says(a.page, '#bk-rows', ar.agrees ? /agrees exactly/ : /does not agree/);
    await a.page.fill('#bk-order', 'so2');
    await a.page.click('#bk-chain');
    await says(a.page, '#bk-figs', /Delivered, not billed\s*₹1,050\.00/);
    await a.page.fill('#bk-order', 'so1');
    await a.page.click('#bk-chain');
    await says(a.page, '#bk-rows', /ordered, delivered and billed agree/);
    await a.page.click('#bk-probing');
    await says(a.page, '#bk-rows', /No portal login has reached the pattern head office watches for \(3 refusals\)\./);
    expect(a.writes, 'every one of these is a read').toEqual([]);
    await a.page.click('#lang');
    await says(a.page, '#bk-h', /வசூல்/);
    expect(a.errors).toEqual([]);
    await a.close();
  }, 120_000);
});
