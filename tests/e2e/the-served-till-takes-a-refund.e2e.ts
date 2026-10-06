import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInOnPage, pinOf } from '../support/till-operator';

/** The cashier, and the manager who approves refunds at the till with their own PIN (ADR-0021). */
const TILL_PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane cashier' }, { userId: 'u-manager', displayName: 'Manager', manager: true }];
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **The whole one-PC till, in a real browser: the box gives money back, offline.**
 *
 * The refund's end-to-end proof, the mirror of the sale's. ONE edge process serves the real POS shell
 * and owns the write socket AND the read socket; **no cloud is configured, so the box is offline** —
 * exactly the case the refund screen exists to work in (M13-FR-01). A real Chromium opens the served
 * screen, rings a sale, then refunds it through the shell's own refund surface
 * (`window.posSession.lookupRefund(...).submit(...)`). That drives, in one real browser:
 *   - the cross-origin GET to `/lane/lookup` (the screen's port → the socket's port) that finds the
 *     bill from this box's OWN durable log — no network;
 *   - the §28 manager approval (a different person from the cashier);
 *   - the durable-first refund POST to `/lane/returns`, written to the box's returns log and queued
 *     for the cloud to reconcile later;
 *   - and idempotency: the SAME refund id submitted twice gives back money ONCE (RR-F03).
 *
 * It proves a browser till refunding a real sale on a single machine with no connection, rather than
 * asserting it. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'refund', 'pc', 'signing', 'key'].join('-').padEnd(48, '0');

/** A refund outcome as the shell's surface reports it. */
interface RefundOutcome { readonly kind: string; readonly laneMessage: string; readonly refundMinor?: number }
interface ReturnableLine { readonly productId: string; readonly returnableMinor: number; readonly soldMinor: number }
interface RefundLookup {
  readonly sale: { readonly saleId: string; readonly number: string; readonly totalMinor: number };
  readonly returnable: readonly ReturnableLine[];
  readonly maxRefundMinor: number;
  needsApproval(refundMinor: number, noReceipt?: boolean): boolean;
  submit(draft: unknown): Promise<RefundOutcome>;
}

/** The slice of the served POS shell's globals this test drives — the cashier's own surface. */
interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
    signIn(cashierId: string): void;
    operator(): string | undefined;
    newSale(): void;
    lookupRefund(receipt: string): Promise<RefundLookup | null>;
    noReceiptReturn(): { capMinor: number } | null;
    approveAtTill(r: { managerId: string; pin: string; kind: 'refund' | 'no_receipt_return' | 'exchange_refund'; billRef?: string; valueMinor: number; reason: string }): Promise<{ approved: boolean; approvalId?: string; approvedBy?: string; laneMessage?: string }>;
  };
  readonly posRefundPolicy?: { approvalThresholdMinor: number; noReceiptCapMinor: number };
}

/** The store pack a one-PC install carries, WITH the service policy (the no-receipt cap) and a price list, so the till
 *  can name the item the customer is holding (SP-9b-i). Written to the box's data dir; no cloud is configured. */
const PACK_FILE_WITH_CAP = {
  version: 1,
  policies: { storeId: 'S1', branchId: 'S1', branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  products: [
    { productId: 'P1', name: 'Amul Ghee Gold 1L', categoryId: 'dairy', unitPriceMinor: 64_000, unitCostMinor: 50_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 10, taxBps: 500, status: 'active' },
    { productId: 'P2', name: 'Amul Ghee Gold 1L — premium tin', categoryId: 'dairy', unitPriceMinor: 70_000, unitCostMinor: 55_000, uom: 'ea', barcodes: ['8901234500002'], availableMinor: 10, taxBps: 500, status: 'active' },
  ],
  lossPreventionRules: [],
};

/** Wait for the keypad sheet to show a step whose title starts with the given words — the flow's steps reuse one sheet, so
 *  waiting on "visible" alone could catch the step before. */
const shows = (page: Page, panelId: string, titleId: string, startsWith: string): Promise<unknown> => page.waitForFunction(
  `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
  + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').startsWith(${JSON.stringify(startsWith)}); })()`,
  undefined, { timeout: 15_000 },
);
const sheetTitled = (page: Page, startsWith: string): Promise<unknown> => shows(page, 'sheet', 'sheet-title', startsWith);
/** The same for the choice panel (More / condition / refund method). */
const panelTitled = (page: Page, startsWith: string): Promise<unknown> => shows(page, 'pay', 'pay-title', startsWith);

describe.skipIf(!HAVE_BROWSER)('the one-PC till serves its own screen and gives money back offline', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    // Build the CURRENT POS bundle so the browser runs this branch's shell, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('a refund taken on the served screen lands on this box\'s disk and is queued — once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-refund-'));
    dirs.push(dir);
    // The edge exactly as a one-PC install runs it, with NO cloud configured — the offline case.
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, people: TILL_PEOPLE }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    expect(edge.lane?.port).toBe(8090);

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

    await signInOnPage(page); // staff ID + till PIN, checked by the box (ADR-0020)
    const result = await page.evaluate(async (managerPin) => {
      const w = globalThis as unknown as PosWindow;
      // Ring one item and take cash — a bill to refund against.
      w.posSession!.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
      await w.posSession!.tenderCash('S-1', 'R-0001', '2026-08-28T10:00:00Z');

      // Find the bill by its receipt number — the cross-origin lookup, from the box's own log.
      const bill = await w.posSession!.lookupRefund('R-0001');
      if (bill === null) return { found: false } as const;

      const draft = {
        returnId: 'RT-1', number: 'RT-0001', reasonCode: 'damaged',
        lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
        // The whole bill back: the amount actually paid — the ₹640 shelf price, the 18% GST INSIDE it (A9; F15 fixed) —
        // which is what the screen offers as the ceiling.
        refundMinor: 64_000, refundTender: 'cash',
        // Threshold defaults to 0 → every refund needs a manager (a DIFFERENT person, §28) — who approves at this till with
        // their own PIN, for this bill and this amount (ADR-0021).
        approval: await (async () => {
          const a = await w.posSession!.approveAtTill({ managerId: 'u-manager', pin: managerPin, kind: 'refund', billRef: 'S-1', valueMinor: 64_000, reason: 'checked the goods' });
          if (!a.approved) throw new Error(a.laneMessage);
          return { by: 'u-manager', reason: 'checked the goods', approvalId: a.approvalId };
        })(),
      };
      const first = await bill.submit(draft);
      // Submit the SAME refund id a second time. The money must go back ONCE: the edge refuses the
      // reused id (a fresh attempt is not byte-identical) as a conflict rather than paying again
      // (RR-F03). The lost-reply-safe idempotent RE-POST lives inside the retry loop and is proven by
      // refund-lost-reply.test.ts; here the point is that the browser cannot cause a double refund.
      const retry = await bill.submit(draft);

      return {
        found: true,
        returnableMinor: bill.returnable.find((l) => l.productId === 'P1')?.returnableMinor ?? null,
        maxRefundMinor: bill.maxRefundMinor,
        first, retry,
      } as const;
    }, pinOf('u-manager'));

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.returnableMinor).toBe(1);
    // The ceiling is what was actually PAID for the bill — the ₹640 shelf price, never the price plus GST (F15).
    expect(result.maxRefundMinor).toBe(64_000);
    // The refund settled at the lane (cash) — the cashier is told to hand it over.
    expect(result.first.kind).toBe('settled');
    // The reused id is REFUSED as a conflict, never a second settled refund — no double payout.
    expect(result.retry.kind).toBe('conflict');
    expect(result.retry.kind).not.toBe('settled');

    // Durable on THIS box's returns log — exactly once, however many times it was submitted.
    const refunds = await readLog(edge.returnsLog.path);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.ok === true && (JSON.parse(refunds[0].record) as { returnId: string }).returnId).toBe('RT-1');

    // And queued once for the cloud to reconcile when the line returns — offline-first, not lost.
    expect(edge.returnsOutbox.unsentCount()).toBe(1);
    // The sale log is untouched by the refund — separate pipelines (M13-FR-01).
    expect(await readLog(edge.log.path)).toHaveLength(1);
  });

  it('a store-credit refund carries the customer onto this box\'s disk, offline (M13-FR-03/§31)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-refund-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, people: TILL_PEOPLE }),
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

    await signInOnPage(page); // staff ID + till PIN, checked by the box (ADR-0020)
    const result = await page.evaluate(async (managerPin) => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
      await w.posSession!.tenderCash('S-3', 'R-0003', '2026-08-28T10:10:00Z');
      const bill = await w.posSession!.lookupRefund('R-0003');
      if (bill === null) return { found: false } as const;
      // Store credit chosen: the draft carries the customer it belongs to (M13-FR-03). Offline, store
      // credit settles at the lane like cash — the credit is issued at the cloud when it reconciles.
      const out = await bill.submit({
        returnId: 'RT-3', number: 'RT-0003', reasonCode: 'customer_changed_mind',
        lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
        refundMinor: 64_000, refundTender: 'store_credit',
        approval: await (async () => {
          const a = await w.posSession!.approveAtTill({ managerId: 'u-manager', pin: managerPin, kind: 'refund', billRef: 'S-3', valueMinor: 64_000, reason: 'checked the goods' });
          if (!a.approved) throw new Error(a.laneMessage);
          return { by: 'u-manager', reason: 'checked the goods', approvalId: a.approvalId };
        })(),
        customerRef: 'c-asha',
      });
      return { found: true, out } as const;
    }, pinOf('u-manager'));

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.out.kind).toBe('settled'); // store credit settles offline, like cash

    // The customer rode onto the box's returns record, so the credit can be issued to them on sync.
    const refunds = await readLog(edge.returnsLog.path);
    expect(refunds).toHaveLength(1);
    const rec = refunds[0]?.ok === true ? JSON.parse(refunds[0].record) as { refundTender: string; customerRef?: string } : null;
    expect(rec?.refundTender).toBe('store_credit');
    expect(rec?.customerRef).toBe('c-asha');
    expect(edge.returnsOutbox.unsentCount()).toBe(1);
  });

  it('a return WITHOUT a receipt, driven through the real screen: More → scan the item → quantity → reason → condition → amount under the cap → cash → manager → recorded on this box\'s disk as no-receipt, against no bill, once (SP-9b-i · M13-FR-01 · §28)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-noreceipt-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(PACK_FILE_WITH_CAP), 'utf8');
    // The box as a one-PC install runs it, with its store pack (cap + price list) and NO cloud — the offline case.
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      ...await prepareTillBox({ dir, key: KEY, people: TILL_PEOPLE, pack: PACK_FILE_WITH_CAP }),
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

    // The box told the till its policy, and the till therefore offers the return — the cap is the pack's, never a guess.
    await signInOnPage(page); // staff ID + till PIN, checked by the box (ADR-0020)
    const given = await page.evaluate(() => {
      const w = globalThis as unknown as PosWindow;
      return { policy: w.posRefundPolicy, offered: w.posSession!.noReceiptReturn() };
    });
    expect(given.policy).toEqual({ approvalThresholdMinor: 0, noReceiptCapMinor: 100_000 });
    expect(given.offered).toEqual({ capMinor: 100_000 });

    // ── The cashier's own steps, on the real screen, up to the manager — taken twice below.
    const throughToTheManager = async (): Promise<void> => {
      // ── The cashier's own steps, on the real screen. More → "Return without receipt".
      await page.click('#more');
      await panelTitled(page, 'More');
      const offers = await page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
      expect(offers).toContain('Return without receipt');
      expect(offers).toContain('Refund');
      await page.click('#pay-kinds button:text-is("Return without receipt")');

      // The item is the evidence: the scanner types the barcode and presses Enter (the shell listens on the window).
      await sheetTitled(page, 'Scan the item coming back');
      await page.keyboard.type('8901234567890');
      await page.keyboard.press('Enter');

      // Named from the lane's own price list; one is coming back.
      await sheetTitled(page, 'How many are coming back? — Amul Ghee Gold 1L');
      expect(await page.textContent('#entry')).toBe('1');
      await page.click('#sheet-ok');

      // Why (a chosen reason, M15), and in what condition (M13-FR-02).
      await sheetTitled(page, 'Why is it coming back?');
      await page.click('#reasons button:text-is("Damaged / faulty")');
      await page.click('#sheet-ok');
      await panelTitled(page, 'What condition is the item in?');
      await page.click('#pay-kinds button:text-is("Good — back on the shelf")');

      // How much — shown against the no-receipt limit, not against any bill. ₹500, under the ₹1,000 cap.
      await sheetTitled(page, 'How much to refund?');
      expect(await page.textContent('#entry-hint')).toBe('No-receipt limit: ₹1,000.00');
      for (const digit of '500') await page.click(`#keypad button:text-is("${digit}")`);
      expect(await page.textContent('#entry-hint')).toBe('Refunding: ₹500.00');
      await page.click('#sheet-ok');

      // Given back as cash.
      await panelTitled(page, 'How is the refund given?');
      await page.click('#pay-kinds button:text-is("Cash")');
    };

    // First the cashier tries to approve it HERSELF, with her own PIN: the store computer refuses (§28 · ADR-0021) — the
    // screen says so, and nothing is recorded.
    await throughToTheManager();
    await sheetTitled(page, 'Manager: scan your badge or key your staff ID');
    await page.keyboard.type('u-lanecash');
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: your till PIN');
    await page.keyboard.type(pinOf('u-lanecash'));
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: why is this refund approved?');
    await page.click('#reasons button:text-is("Damaged / faulty")');
    await page.click('#sheet-ok');
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    expect(await page.textContent('#refusal-title')).toBe('Not approved');
    expect(await page.textContent('#refusal-text')).toMatch(/not the person at the till/);
    await page.click('#refusal-ok');
    expect(await readLog(edge.returnsLog.path)).toHaveLength(0);

    // Then properly.
    await throughToTheManager();
    // A manager, ALWAYS — scanned badge or keyed staff code — then why they approve.
    await sheetTitled(page, 'Manager: scan your badge or key your staff ID');
    expect(await page.textContent('#entry-hint')).toContain('Every return without a receipt needs a manager');
    await page.keyboard.type('u-manager');
    await page.keyboard.press('Enter');
    // …then their OWN till PIN, masked, checked by the store computer for this one return (ADR-0021).
    await sheetTitled(page, 'Manager: your till PIN');
    await page.keyboard.type(pinOf('u-manager'));
    expect(await page.locator('#entry').textContent()).toBe('••••••');
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: why is this refund approved?');
    await page.click('#reasons button:text-is("Damaged / faulty")');
    await page.click('#sheet-ok');

    // The outcome, in the model's own words: recorded — hand over the refund.
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    expect(await page.textContent('#refusal-title')).toBe('Refund recorded');
    expect(await page.textContent('#refusal-text')).toContain('Hand over the refund');
    await page.click('#refusal-ok');

    // ── On THIS box's disk: one return, no receipt, against no bill, the cashier and the manager named, the item and the
    //    money as keyed — and queued once for head office to re-check when the line returns (offline-first, never lost).
    const refunds = await readLog(edge.returnsLog.path);
    expect(refunds).toHaveLength(1);
    const record = refunds[0]?.ok === true ? JSON.parse(refunds[0].record) as Record<string, unknown> : undefined;
    expect(record).toMatchObject({
      noReceipt: true, originalSaleId: null, laneId: 'lane-1', processedBy: 'u-lanecash', approvedBy: 'u-manager',
      reasonCode: 'damaged', refundMinor: 50_000, refundTender: 'cash',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
    });
    expect(edge.returnsOutbox.unsentCount()).toBe(1);
    // No sale was rung — the sale log is untouched (separate pipelines, M13-FR-01).
    expect(await readLog(edge.log.path)).toHaveLength(0);
  });

  it('an EXCHANGE driven through the real screen: the replacement rung by barcode → More → Exchange → the bill → the item coming back → the quote → the customer pays the ₹60 difference in cash → both documents on this box\'s disk, linked (SP-9b-ii · M13-FR-03)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-exchange-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(PACK_FILE_WITH_CAP), 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      ...await prepareTillBox({ dir, key: KEY, people: TILL_PEOPLE, pack: PACK_FILE_WITH_CAP }),
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

    // Yesterday's bill: one ₹640 tin, paid in cash — the bill the customer brings back.
    await signInOnPage(page); // staff ID + till PIN, checked by the box (ADR-0020)
    await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
      await w.posSession!.tenderCash('S-1', 'R-0001', '2026-08-28T10:00:00Z');
      w.posSession!.newSale(); // the shell clears the bill after every sale; done here because the sale was rung from the test
    });

    // ── The cashier's own steps. The replacement is rung FIRST, by barcode, like any sale: the ₹700 premium tin.
    await page.keyboard.type('8901234500002');
    await page.keyboard.press('Enter');
    await page.waitForFunction(`((document.getElementById('lines') || {}).textContent || '').includes('premium tin')`, undefined, { timeout: 15_000 });

    // More → Exchange.
    await page.click('#more');
    await panelTitled(page, 'More');
    expect(await page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''))).toContain('Exchange');
    await page.click('#pay-kinds button:text-is("Exchange")');

    // The bill, by its receipt number (scanned off the customer's slip).
    await sheetTitled(page, 'Scan the receipt, or key the bill number');
    await page.keyboard.type('R-0001');
    await page.keyboard.press('Enter');

    // Which item is coming back (one tin, still returnable), how many, why, in what condition.
    await panelTitled(page, 'Which item is coming back?');
    await page.click('#pay-kinds button:text-is("Amul Ghee Gold 1L — can return 1")');
    await sheetTitled(page, 'How many are coming back? — Amul Ghee Gold 1L');
    await page.click('#sheet-ok');
    await sheetTitled(page, 'Why is it coming back?');
    await page.click('#reasons button:text-is("Wrong item")');
    await page.click('#sheet-ok');
    await panelTitled(page, 'What condition is the item in?');
    await page.click('#pay-kinds button:text-is("Good — back on the shelf")');

    // The quote, in the model's figures: ₹640 credited at the bill's own price against the ₹700 rung → the customer pays ₹60.
    await panelTitled(page, 'Credit for the goods coming back: ₹640.00 — Customer pays the difference: ₹60.00');
    await page.click('#pay-kinds button:text-is("Cash")');

    // Recorded — both documents named, and what to collect.
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    expect(await page.textContent('#refusal-title')).toBe('Exchange recorded');
    const said = (await page.textContent('#refusal-text')) ?? '';
    expect(said).toContain('Collect ₹60.00 from the customer');
    await page.click('#refusal-ok');
    // The bill is cleared for the next customer.
    expect(await page.$$eval('#lines tr', (rows) => rows.length)).toBe(0);

    // ── On THIS box's disk: the return (the ₹640 credit against bill S-1, tender "exchange", the settlement naming the
    //    replacement) and the replacement sale (₹700, paid with ₹640 of exchange credit + ₹60 cash) — linked by id, each
    //    on its own durable log and queue (offline-first: no cloud is configured here).
    const refunds = await readLog(edge.returnsLog.path);
    expect(refunds).toHaveLength(1);
    const credit = refunds[0]?.ok === true ? JSON.parse(refunds[0].record) as Record<string, unknown> : undefined;
    expect(credit).toMatchObject({
      originalSaleId: 'S-1', refundTender: 'exchange', refundMinor: 64_000, processedBy: 'u-lanecash', reasonCode: 'wrong_item',
      lines: [{ productId: 'P1', quantityMinor: 1, disposition: 'resell' }],
      exchange: { replacementTotalMinor: 70_000, appliedMinor: 64_000, balance: 'top_up', balanceMinor: 6_000, topUpTenders: [{ kind: 'cash', amountMinor: 6_000 }] },
    });
    const sales = await readLog(edge.log.path);
    expect(sales).toHaveLength(2);
    const replacement = sales[1]?.ok === true ? JSON.parse(sales[1].record) as Record<string, unknown> : undefined;
    expect(replacement).toMatchObject({
      total: 70_000, cashierId: 'u-lanecash', laneId: 'lane-1',
      lines: [{ productId: 'P2', quantityMinor: 1, lineTotalMinor: 70_000 }],
      tenders: [{ kind: 'exchange_credit', amount: { minor: 64_000 } }, { kind: 'cash', amount: { minor: 6_000 } }],
    });
    expect((credit!['exchange'] as { replacementSaleId: string }).replacementSaleId).toBe(replacement!['id']);
    expect(edge.returnsOutbox.unsentCount()).toBe(1);
    expect(edge.outbox.unsentCount()).toBe(2);
  });

  it('a box that was given NO no-receipt cap offers no return without a receipt — the till never guesses a limit (fail safe)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-noreceipt-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, people: TILL_PEOPLE }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    expect(await page.evaluate(() => {
      const w = globalThis as unknown as PosWindow;
      return { policy: w.posRefundPolicy, offered: w.posSession!.noReceiptReturn() };
    })).toEqual({ policy: undefined, offered: null });
    await page.click('#more');
    await panelTitled(page, 'More');
    const offers = await page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
    expect(offers).toContain('Refund');
    expect(offers).not.toContain('Return without receipt');
  });

  it('refuses to give money back without a manager — every refund needs §28 approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-refund-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, people: TILL_PEOPLE }),
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

    await signInOnPage(page); // staff ID + till PIN, checked by the box (ADR-0020)
    const outcome = await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
      await w.posSession!.tenderCash('S-2', 'R-0002', '2026-08-28T10:05:00Z');
      const bill = await w.posSession!.lookupRefund('R-0002');
      // No approval supplied — the §28 guard must refuse before any money moves.
      return bill!.submit({
        returnId: 'RT-2', number: 'RT-0002', reasonCode: 'damaged',
        lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
        refundMinor: 64_000, refundTender: 'cash',
      });
    });

    expect(outcome.kind).toBe('approval_required');
    // Nothing was written or queued — the refund did not happen.
    expect(await readLog(edge.returnsLog.path)).toHaveLength(0);
    expect(edge.returnsOutbox.unsentCount()).toBe(0);
  });
});
