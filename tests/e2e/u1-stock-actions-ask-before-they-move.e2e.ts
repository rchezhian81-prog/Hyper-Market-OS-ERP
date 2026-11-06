import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startOfficeShop, PEOPLE, S1, type OfficeShop } from './lib/office-shop';
import { askedThenConfirmed, writeCounter } from './lib/confirm-sheet';

/**
 * **U1 · OB-691 — five stock-moving office actions ask the consequence-and-confirm sheet before anything moves, on the
 * REAL store computer fed by the REAL head office (in memory), in a real browser (design system §1.3, §27.1).**
 *
 * The five pages' own browser tests run on PostgreSQL in CI; this one proves the sheet on this box too, with the same
 * routes seeding the same kinds of record:
 *   • Transfers — "Send it": the sheet names the lines and the route; Go back sends nothing; Confirm sends once and the
 *     transfer is on the road;
 *   • Count plans — "Approve": the sheet names the count, its place, its loss and gain; the approval posts once;
 *   • Store events — "Record the event": the sheet says the event and its effect in plain words ("50% higher");
 *   • Returned goods to decide — a write-off: the sheet names the unit and the reason (danger tone);
 *   • Recalls & trace — "Start the recall": the sheet names the batch (danger tone).
 * Every sheet is read in English and, after the toggle, in Tamil. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DESK = { viewport: { width: 1280, height: 860 } };
const AT = new Date(Date.now() - 3_600_000).toISOString();
const MAKER = PEOPLE.maker; // a second owner: proposes and counts, so the manager may send and approve (§28)

const says = async (page: Page, id: string, like: RegExp): Promise<void> => {
  await page.waitForFunction(([i, src]) => new RegExp(src as string).test((globalThis as unknown as { document: { getElementById(x: string): { textContent: string } | null } }).document.getElementById(i as string)?.textContent ?? ''), [id, like.source], { timeout: 15_000 });
};

describe.skipIf(!existsSync(CHROMIUM))('U1: stock-moving office actions ask the sheet before they move', () => {
  let browser: Browser;
  let shop: OfficeShop;
  let n = 0;
  const post = async (path: string, userId: string, body: unknown, allow: number[] = [200, 201, 202]): Promise<unknown> => {
    const r = await shop.h.request({ method: 'POST', path, userId, tenantId: shop.tenantId, idempotencyKey: `u1-${n++}`, body });
    if (!allow.includes(r.status)) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    shop = await startOfficeShop(browser);
    // The back store, stock with a known cost (and a batch), and the records the five pages act on.
    await post('/v1/org/nodes/S1-BACK', PEOPLE.owner, { kind: 'warehouse', name: 'Back store', parentId: S1, companyId: 'C1' });
    await post('/v1/inventory/movements', PEOPLE.owner, { movementId: 'u1-rx-back', productId: 'p-milk', locationId: 'S1-BACK', kind: 'received', quantityMinor: 50, uom: 'ea', occurredAt: AT, enteredBy: PEOPLE.owner, unitCostMinor: 2_000 });
    await post('/v1/inventory/movements', PEOPLE.owner, { movementId: 'u1-rx-floor', productId: 'p-milk', locationId: S1, kind: 'received', quantityMinor: 40, uom: 'ea', occurredAt: AT, enteredBy: PEOPLE.owner, unitCostMinor: 2_000, batchId: 'B-77' });
    await post('/v1/warehouse/transfers/t-u1', MAKER, { fromLocationId: 'S1-BACK', toLocationId: S1, lines: [{ productId: 'p-milk', quantityMinor: 10, uom: 'ea' }] });
    await post('/v1/inventory/count-plans/cp-u1', MAKER, { locationId: 'S1-BACK', productIds: ['p-milk'], recountThresholdMinor: 100_000_000 });
    await post('/v1/inventory/count-plans/cp-u1/open', MAKER, {});
    await post('/v1/inventory/count-plans/cp-u1/counts/c-u1', MAKER, { productId: 'p-milk', locationId: 'S1-BACK', uom: 'ea', countedMinor: 49 });
    // A returned unit held for a decision: sold, refunded with a second person's approval, back in damaged.
    await post('/v1/sales', PEOPLE.owner, {
      saleId: 'S-U1', receiptNumber: 'R-U1', laneId: 'lane-1', locationId: S1, cashierId: PEOPLE.owner, tradingDay: '2026-10-09', committedAt: AT,
      totalMinor: 1_000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p-milk', quantityMinor: 1, uom: 'ea', unitPriceMinor: 1_000, lineTotalMinor: 1_000, batchId: 'B-77', batchExpiry: '2026-12-31' }], tenders: [{ kind: 'cash', amountMinor: 1_000 }],
    });
    const approval = await post('/v1/pos/refund-approvals', MAKER, { kind: 'refund', saleId: 'S-U1', valueMinor: 1_000, requestedBy: PEOPLE.owner, reason: 'torn pack' }) as { approvalId: string };
    await post('/v1/sales/S-U1/returns', PEOPLE.owner, {
      approvalId: approval.approvalId, returnId: 'RT-U1', reasonCode: 'damaged_in_use', refundMinor: 1_000, refundTender: 'cash',
      lines: [{ productId: 'p-milk', uom: 'ea', quantityMinor: 1, disposition: 'damaged', condition: 'torn pack' }],
    });
  }, 300_000);
  afterAll(async () => { await shop?.stop(); await browser?.close(); });

  const open = async (path: string, ready: string) => {
    const s = await shop.asPerson(PEOPLE.manager, DESK);
    await s.page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    await s.page.waitForFunction('globalThis.sreOffice !== undefined && typeof globalThis.sreOffice.confirm === "function"');
    await s.page.waitForSelector(ready, { timeout: 15_000 });
    return s;
  };

  it('Count plans: "Approve" names the count, the place, the loss and the gain', async () => {
    const s = await open('/count-plans', '#register tbody tr[data-plan="cp-u1"]');
    const writes = writeCounter(s.page);
    await s.page.locator('#register tbody tr[data-plan="cp-u1"] button[data-act="view"]').click();
    await says(s.page, 'd-title', /^cp-u1$/);
    await s.page.locator('#d-approve:not([hidden])').waitFor({ timeout: 15_000 });
    await s.page.fill('#d-reason', 'aisle 1 counted');
    const title = await askedThenConfirmed(s.page, () => s.page.click('#d-approve'), /Approve count cp-u1 at S1-BACK: 1 of 1 products counted, loss ₹/, writes);
    expect(title).toContain('gain ₹');
    await says(s.page, 'd-status', /./);
    expect(writes()).toBe(1);
    expect(s.errors).toEqual([]);
    await s.context.close();
  });

  it('Transfers: "Send it" names the lines and the route; Go back sends nothing; Confirm sends once', async () => {
    const s = await open('/transfers', '#register tbody tr[data-transfer="t-u1"]');
    const writes = writeCounter(s.page);
    await s.page.locator('#register tbody tr[data-transfer="t-u1"] button[data-act="view"]').click();
    await says(s.page, 'd-title', /^t-u1$/);
    const title = await askedThenConfirmed(s.page, () => s.page.click('#d-dispatch'), /p-milk × 10 .*will leave .*S1-BACK → .*S1/, writes);
    expect(title).toMatch(/^p-milk × 10/);
    await says(s.page, 'd-state', /On the road/);
    expect(writes()).toBe(1);
    expect(s.errors).toEqual([]);
    await s.context.close();
  });

  it('Store events: "Record the event" says the event and its effect in plain words', async () => {
    const s = await open('/demand-events', '#save');
    const writes = writeCounter(s.page);
    await s.page.fill('#store', S1); await s.page.fill('#label', 'Pongal'); await s.page.selectOption('#kind', 'festival');
    await s.page.fill('#ev-from', '14/01/2027'); await s.page.fill('#ev-to', '15/01/2027'); await s.page.fill('#effect', '1.5');
    await askedThenConfirmed(s.page, () => s.page.click('#save'), /Record Pongal \(Festival\), 2027-01-14 to 2027-01-15: orders will be proposed 50% higher for all products/, writes);
    await says(s.page, 'record-status', /Recorded/);
    expect(writes()).toBe(1);
    expect(s.errors).toEqual([]);
    await s.context.close();
  });

  it('Returned goods to decide: a write-off names the unit and the reason before it leaves stock', async () => {
    const s = await open('/held-returns', '#rows .row');
    const writes = writeCounter(s.page);
    const row = s.page.locator('#rows .row', { hasText: 'torn pack' });
    await row.locator('select.decision').selectOption('write_off');
    await row.locator('select.waste-reason').selectOption('damage');
    await row.locator('input.reason').fill('contents spilt');
    await askedThenConfirmed(s.page, () => row.locator('button.record').click(), /Write off p-milk × 1 .*as Damaged/, writes);
    await s.page.locator('#result:not([hidden])').waitFor({ timeout: 15_000 });
    expect(await s.page.textContent('#result')).toMatch(/Recorded: p-milk/);
    expect(writes()).toBe(1);
    expect(s.errors).toEqual([]);
    await s.context.close();
  });

  it('Recalls & trace: "Start the recall" names the batch, in English and Tamil; nothing starts on Escape or Go back', async () => {
    const s = await open('/recall-trace', '#r-start');
    const writes = writeCounter(s.page);
    await s.page.fill('#r-batch', 'B-77'); await s.page.fill('#r-reason', 'supplier notice (synthetic)');
    // In Tamil the sheet is drawn in Tamil; Escape is Go back and sends nothing.
    await s.page.click('#lang');
    await s.page.click('#r-start');
    await s.page.waitForSelector('#sre-confirm:not([hidden])');
    const tamil = (await s.page.textContent('#sre-confirm-title')) ?? '';
    expect(tamil).toMatch(/B-77/);
    expect(tamil).toMatch(/[\u0B80-\u0BFF]/);
    expect(tamil).not.toMatch(/Recall batch/);
    await s.page.keyboard.press('Escape');
    await s.page.waitForSelector('#sre-confirm', { state: 'hidden' });
    expect(writes(), 'Escape sends nothing').toBe(0);
    await s.page.click('#lang');
    await askedThenConfirmed(s.page, () => s.page.click('#r-start'), /Recall batch B-77: every till of every store will refuse it/, writes);
    await s.page.locator('#result').waitFor({ timeout: 15_000 });
    expect(writes()).toBe(1);
    expect(s.errors).toEqual([]);
    await s.context.close();
  });
});
