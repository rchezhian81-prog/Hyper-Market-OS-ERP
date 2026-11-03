import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CONNECTED, OWNER, startBoxPageOnCloud, ok, type BoxCloudShop } from './lib/box-page-on-cloud';
import { says } from './lib/r4c-box-page';

/**
 * **W4 · M23-FR-03 (+ M14-FR-03 · C14): ONE connected run of the Card, UPI and bank page — a real browser, served by a REAL
 * store computer, over the PRODUCTION API on real PostgreSQL.** The W3 test of this page
 * (`w3-card-upi-and-bank-are-reconciled-on-their-page.e2e.ts`) runs over an in-memory head office; this one runs the same
 * steps where every `/v1` call reaches the real cloud under the accountant's own token, and reads the results back from
 * head office's records on PostgreSQL:
 *   • the box serves the page to the accountant because head office's own answer for him holds its words; nothing is
 *     written on open; no statement, no deposit, no dispute yet — said;
 *   • the provider's settlement file is loaded (head office checks it adds up); the same file again is refused in head
 *     office's words;
 *   • the check of card and UPI takings shows the matched bill and the one the provider never paid, with its value; a case is
 *     opened on it with a named owner and an answer-by day, evidence added, and closed with an outcome and a note;
 *   • the bank's statement (CSV) is loaded; a cash deposit shows "in the bank" against the statement's credit naming its
 *     slip; the same slip again is refused by name; a wrong one is cancelled with a reason and stays on file;
 *   • a UPI payment dispute is recorded (reply-by worked out by head office), answered and recorded lost;
 *   • the page speaks Tamil; a cashier (head office's words for her hold none of this page's) is not served the page.
 * Synthetic data only; no live bank or provider. Needs DATABASE_URL and Chromium; else it SKIPS.
 */

const ACCT = 'u-acct'; const CASH = 'u-cash';

const cardSale = (saleId: string, ref: string, amountMinor: number, kind = 'card') => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: OWNER, tradingDay: '2026-09-01', committedAt: '2026-09-01T10:00:00.000Z',
  totalMinor: amountMinor, currency: 'INR', packVersion: 1,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: amountMinor, lineTotalMinor: amountMinor }],
  tenders: [{ kind, amountMinor, ref }],
});
// The provider paid PAY-1 (₹1,000) and never PAY-2 (₹500, UPI).
const BATCH = {
  batchId: 'PB-0903', providerId: 'test-acquirer', currency: 'INR', settlementDate: '2026-09-03',
  lines: [{ id: 'l1', ref: 'PAY-1', amountMinor: 100_000 }],
  declaredGrossMinor: 100_000, declaredFeesMinor: 1_000, declaredNetMinor: 99_000,
};
const CSV = ['Date,Reference,Narrative,Debit,Credit', '03/09/2026,UTR778899 PB-0903,ACQUIRER SETTLEMENT,,990.00', '05/09/2026,DS-4471,CASH DEPOSIT BY SELF,,"25,000.00"'].join('\n');

describe.skipIf(!CONNECTED)('M23-FR-03 connected: Card, UPI and bank on the store computer, over the real cloud on PostgreSQL', () => {
  let shop: BoxCloudShop;
  beforeAll(async () => {
    shop = await startBoxPageOnCloud({
      name: 'm23-settlement',
      people: [{ userId: ACCT }, { userId: CASH, branchId: 'store-1' }],
      seed: async (cloud, h, store) => {
        await cloud.grant(ACCT, 'accountant');
        await cloud.grant(CASH, 'cashier', undefined, [store]);
        for (const [s, ref, amt, kind] of [['S1', 'PAY-1', 100_000, 'card'], ['S2', 'PAY-2', 50_000, 'upi']] as const) {
          const r = await h.request({ method: 'POST', path: '/v1/sales', userId: OWNER, tenantId: cloud.tenantId, idempotencyKey: `sale-${s}`, body: cardSale(s, ref, amt, kind) });
          if (r.status !== 202) throw new Error(`sale ${s}: ${r.status} ${JSON.stringify(r.body)}`);
        }
      },
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); });

  it('the accountant loads the files, works the difference, records a deposit and a dispute — all held by head office on PostgreSQL', async () => {
    const a = await shop.open(ACCT, '/settlement');
    expect(a.status).toBe(200);
    await says(a.page, '#statement-rows', /No bank statement loaded yet\./);
    await says(a.page, '#deposit-rows', /No cash deposit recorded yet\./);
    await says(a.page, '#dispute-rows', /No payment dispute recorded\./);
    await says(a.page, '#case-rows', /No open case\./);
    expect(a.writes, 'nothing is written on open').toEqual([]);

    // ── The provider's settlement file ────────────────────────────────────────────────────────────────────────
    await a.page.setInputFiles('#batch-file', { name: 'acquirer-2026-09-03.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(BATCH)) });
    await a.page.click('#batch-load');
    await says(a.page, '#batch-status', /^Loaded — head office checked it adds up and holds it\.$/);
    await a.page.click('#batch-load');
    await says(a.page, '#batch-status', /^Head office refused: .*PB-0903/);

    // ── The check: PAY-1 matched, PAY-2 never paid (late, valued) → a case, evidence, closed with an outcome ──────
    await a.page.fill('#rv-date', '2026-09-10');
    await a.page.fill('#rv-cycle', '2');
    await a.page.click('#rv-go');
    await says(a.page, '#rv-tiles [data-tile="matched"]', /1 · ₹1,000\.00/);
    await says(a.page, '#exception-rows li[data-ref="PAY-2"]', /Not paid — past the provider's days · PAY-2 · ₹500\.00/);
    const row = a.page.locator('#exception-rows li[data-ref="PAY-2"]');
    await row.locator('input.case-owner').fill(ACCT);
    await row.locator('input.case-due').fill('2026-12-31');
    await row.locator('button[data-act="open"]').click();
    await says(a.page, '#exception-rows li[data-ref="PAY-2"] .row-status', /^Case opened\.$/);
    await says(a.page, '#case-rows', /PAY-2 · ₹500\.00/);
    const kase = a.page.locator('#case-rows li[data-case]').first();
    await kase.locator('input.case-evidence').fill('email from acquirer 2026-09-11');
    await kase.locator('button[data-act="evidence"]').click();
    await says(a.page, '#case-rows li[data-case] .row-status', /^Evidence added\.$/);
    await kase.locator('select.case-outcome').selectOption('timing_only');
    await kase.locator('input.case-note').fill('paid in the next file');
    await kase.locator('button[data-act="resolve"]').click();
    await says(a.page, '#rv-status', /: Case closed\.$/);
    await says(a.page, '#case-rows', /No open case\./);

    // ── The bank statement, then a cash deposit matched to its credit ───────────────────────────────────────────
    await a.page.fill('#st-id', 'HDFC-2026-09'); await a.page.fill('#st-account', 'HDFC-current-1');
    await a.page.fill('#st-from', '2026-09-01'); await a.page.fill('#st-to', '2026-09-30');
    await a.page.fill('#st-opening', '50,000'); await a.page.fill('#st-closing', '75,990');
    await a.page.setInputFiles('#st-file', { name: 'hdfc-sep.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await a.page.click('#st-load');
    await says(a.page, '#st-status', /^Loaded — head office checked it adds up to its balances\.$/);
    await says(a.page, '#statement-rows li[data-statement="HDFC-2026-09"]', /2 lines · loaded by u-acct · hdfc-sep\.csv/);

    await a.page.fill('#dep-on', '2026-09-05'); await a.page.fill('#dep-amount', '25,000');
    await a.page.fill('#dep-slip', 'DS-4471'); await a.page.fill('#dep-account', 'HDFC-current-1');
    await a.page.click('#dep-record');
    await says(a.page, '#dep-status', /^Recorded\.$/);
    await says(a.page, '#deposit-rows li[data-state="in_bank"]', /In the bank · HDFC-2026-09 2026-09-05/);
    await a.page.fill('#dep-on', '2026-09-06'); await a.page.fill('#dep-amount', '100'); await a.page.fill('#dep-slip', 'DS-4471'); await a.page.fill('#dep-account', 'HDFC-current-1');
    await a.page.click('#dep-record');
    await says(a.page, '#dep-status', /^Head office refused: Slip DS-4471 on HDFC-current-1 is already recorded/);
    await a.page.fill('#dep-on', '2026-09-07'); await a.page.fill('#dep-amount', '120'); await a.page.fill('#dep-slip', 'DS-4480'); await a.page.fill('#dep-account', 'HDFC-current-1');
    await a.page.click('#dep-record');
    await says(a.page, '#deposit-rows li[data-state="not_in_bank"]', /Not in the bank yet/);
    const wrong = a.page.locator('#deposit-rows li[data-state="not_in_bank"]');
    await wrong.locator('input.cancel-why').fill('slip was for the café account');
    await wrong.locator('button[data-act="cancel"]').click();
    await says(a.page, '#dep-status', /^Cancelled — the record stays on file with your reason\.$/);
    await says(a.page, '#deposit-rows li[data-state="cancelled"]', /Cancelled · slip was for the café account \(u-acct\)/);

    // ── A UPI payment dispute: recorded, answered, lost ───────────────────────────────────────────────────────
    await a.page.fill('#d-id', 'DSP-1'); await a.page.selectOption('#d-instrument', 'upi');
    await a.page.fill('#d-ref', 'NPCI-CASE-889'); await a.page.fill('#d-amount', '500'); await a.page.fill('#d-received', '2026-10-25');
    await a.page.fill('#d-reason', 'customer says not received'); await a.page.fill('#d-sale', 'S2');
    await a.page.click('#d-record');
    await says(a.page, '#d-status', /^Dispute recorded\.$/);
    await says(a.page, '#dispute-rows li[data-dispute="DSP-1"]', /Reply by 2026-11-09 · S2/);
    const d = a.page.locator('#dispute-rows li[data-dispute="DSP-1"]');
    await d.locator('input.d-responded').fill('2026-10-28'); await d.locator('input.d-evidence').fill('PACK-77');
    await d.locator('button[data-act="answer"]').click();
    await says(a.page, '#d-status', /^DSP-1: Answer recorded\.$/);
    await a.page.locator('#dispute-rows li[data-dispute="DSP-1"][data-state="answered"]').waitFor();
    await a.page.locator('#dispute-rows li[data-dispute="DSP-1"] input.d-decided').fill('2026-11-01');
    await a.page.locator('#dispute-rows li[data-dispute="DSP-1"] button[data-act="lost"]').click();
    await says(a.page, '#dispute-rows li[data-dispute="DSP-1"]', /Lost/);

    await a.page.click('#lang');
    await says(a.page, '#page-h', /^அட்டை, UPI மற்றும் வங்கி$/);
    expect(a.errors).toEqual([]);
    await a.close();

    // ── Head office holds every one of these on PostgreSQL, read back under the accountant's own token ─────────────
    const deposits = (await ok(shop.call('GET', '/v1/finance/cash-deposits', ACCT), 'deposits')) as { deposits: { slipRef?: string; state: string }[] };
    expect(deposits.deposits.map((x) => x.state)).toEqual(['in_bank', 'cancelled']);
    const disputes = JSON.stringify(await ok(shop.call('GET', '/v1/finance/payment-disputes', ACCT), 'disputes'));
    expect(disputes).toContain('DSP-1');
    expect(disputes).toContain('NPCI-CASE-889');
  }, 180_000);

  it('a cashier: head office\'s words for her hold none of this page\'s, so the store computer does not serve it and nothing reaches head office', async () => {
    const c = await shop.open(CASH, '/settlement');
    expect(c.status).toBe(403);
    expect([...c.reads, ...c.writes]).toEqual([]);
    await c.close();
  }, 60_000);
});
