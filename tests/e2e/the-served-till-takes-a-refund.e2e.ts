import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
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
    lookupRefund(receipt: string): Promise<RefundLookup | null>;
  };
}

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
    for (const stop of stops.splice(0)) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('a refund taken on the served screen lands on this box\'s disk and is queued — once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-refund-'));
    dirs.push(dir);
    // The edge exactly as a one-PC install runs it, with NO cloud configured — the offline case.
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
    stops.push(() => edge.stop());
    expect(edge.lane?.port).toBe(8090);

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

    const result = await page.evaluate(async () => {
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
        // The whole bill back: the tax-inclusive amount actually paid (₹640 + 18% GST = ₹755.20),
        // which is what the screen offers as the ceiling.
        refundMinor: 75_520, refundTender: 'cash',
        // Threshold defaults to 0 → every refund needs a manager (a DIFFERENT person, §28).
        approval: { by: 'u-manager', reason: 'checked the goods' },
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
    });

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.returnableMinor).toBe(1);
    // The ceiling is what was actually PAID for the bill — the tax-inclusive total (₹755.20).
    expect(result.maxRefundMinor).toBe(75_520);
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

  it('refuses to give money back without a manager — every refund needs §28 approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-refund-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

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
