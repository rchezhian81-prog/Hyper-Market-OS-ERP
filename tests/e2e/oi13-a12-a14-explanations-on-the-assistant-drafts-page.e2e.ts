import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Pool } from 'pg';
import { chromium, type Browser, type Page } from 'playwright-core';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';
import { assessShiftClose } from '../../packages/till/src/index';
import type { HttpRequest } from '../../services/kernel/src/index';

/**
 * **CR-01 OI-13-A12 and OI-13-A14 (OB-763 B) in a real browser — the Assistant drafts page, on the production API surface**
 * (`buildSurface` through the real router; over real PostgreSQL when DATABASE_URL is set). The shell plays only the
 * sign-in front's part: the person named by the `who` cookie, and the identity-only payload the store box injects, with
 * the permission words each real role holds. Synthetic data only. Through Chromium:
 *
 *   • while A12 is switched off (it starts off), "Explain the bills now" says so in plain words and nothing is drafted;
 *   • the owner switches both on; "Explain the bills now" shows the real bill that does not match, line by line, with
 *     the supplier query drafted; "Explain the tills now" shows the till ₹500 short with the ₹500 cash bill first — and
 *     the person who counted is named nowhere on the page;
 *   • the manager (who may decide but not run) sees the explain buttons greyed with the reason; "Not right" without a
 *     reason is refused on the page; with a reason it is recorded; "Agree" on the bill is recorded — neither changes the
 *     bill or the till;
 *   • the page follows the language toggle into Tamil, the reasons included.
 * Without the pre-installed Chromium the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const DATABASE_URL = process.env['DATABASE_URL'];
const WEB_DIR = 'apps/web-erp/web';
const OWNER = 'u-owner'; const MGR = 'u-mgr'; const BUYER = 'u-buyer';
// The permission words each real role holds for this page (services/api/src/roles.ts): the owner runs and decides; the
// store manager reads and decides, and runs no assistant.
const PERMISSIONS: Record<string, string[]> = {
  [OWNER]: ['ai.proposal.read', 'ai.agent.run', 'ai.proposal.decide'],
  [MGR]: ['ai.proposal.read', 'ai.proposal.decide'],
};
const today = new Date().toISOString().slice(0, 10);

async function startShell(h: ApiHarness, tenantId: string): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const who = /(?:^|;\s*)who=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? OWNER;
      if (url.pathname.startsWith('/v1/')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const reply = await h.raw({
          method: (req.method ?? 'GET') as HttpRequest['method'], path: url.pathname, query: Object.fromEntries(url.searchParams),
          token: TEST_IDP.issue({ sub: who, tenantId }),
          ...(req.headers['idempotency-key'] === undefined ? {} : { idempotencyKey: String(req.headers['idempotency-key']) }),
          ...(chunks.length === 0 ? {} : { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }),
        });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
        return;
      }
      const file = url.pathname.replace(/^\//, '') || 'ai-drafts.html';
      try {
        let body = (await readFile(join(WEB_DIR, file))).toString('utf8');
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        if (file === 'ai-drafts.html') body = body.replace('<!--SCREEN-DATA-->', `<script>window.aiDraftsData = ${JSON.stringify({ userId: who, permissions: PERMISSIONS[who] ?? [] })};</script>`);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('A12 and A14 on the Assistant drafts page, in a real browser on the production API surface (CR-01 OI-13)', () => {
  let browser: Browser;
  let pool: Pool | undefined;
  let h: ApiHarness;
  let shell: { base: string; stop: () => Promise<void> };
  const T = randomUUID();
  const act = (method: 'POST' | 'PUT', path: string, userId: string, body: unknown) => h.request({ method, path, userId, tenantId: T, idempotencyKey: `seed-${randomUUID()}`, body });
  const okAct = async (method: 'POST' | 'PUT', path: string, userId: string, body: unknown): Promise<void> => {
    const r = await act(method, path, userId, body);
    expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };

  beforeAll(async () => {
    if (DATABASE_URL !== undefined) {
      pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
      await runMigrations(pgPoolClient(pool), readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join('db/migrations', name), 'utf8') })));
      const sql = pgPoolClient(pool);
      h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) });
    } else {
      h = apiHarness();
    }
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, BUYER, 'store_manager');
    await h.provisionRole(T, MGR, 'store_manager');
    await approvedSuppliers(h, T, 'sup-demo-foods');
    await deliveryPlaces(h, T, 'store-1');
    // A bill that does not match: ordered 50 at ₹12.36, received 48, billed 50 at ₹12.48 — matched and held back.
    await okAct('POST', '/v1/purchase/orders/po-demo-1', BUYER, { supplierId: 'sup-demo-foods', deliverToLocationId: 'store-1', lines: [{ productId: 'p-oil', orderedQty: 50, unitCost: { minor: 1_236, currency: 'INR' } }] });
    await okAct('POST', '/v1/purchase/orders/po-demo-1/approval', OWNER, { reason: 'synthetic order' });
    await okAct('POST', '/v1/inventory/goods-receipt/grn-demo-1', OWNER, { warehouseId: 'store-1', receivedOnDate: today, currency: 'INR', poId: 'po-demo-1', lines: [{ lineId: 'L1', productId: 'p-oil', orderedMinor: 50, countedMinor: 48, uom: 'ea', unitCost: { minor: 1_236, currency: 'INR' }, condition: 'good' }] });
    await okAct('POST', '/v1/purchase/invoices/INV-DF-101/capture', BUYER, { supplierId: 'sup-demo-foods', poId: 'po-demo-1', declaredTotalMinor: 62_400, lines: [{ productId: 'p-oil', quantity: 50, unitPriceMinor: 1_248, lineTotalMinor: 62_400 }] });
    await okAct('POST', '/v1/purchase/invoices/INV-DF-101/match', MGR, {});
    // A till ₹500 short, relayed by the store box, and the till's own ₹500 sale recorded as cash.
    const figures = { openingFloatMinor: 50_000, cashSalesMinor: 1_000_000, pickupsMinor: 500_000, cashRefundsMinor: 0, countedCashMinor: 500_000, toleranceMinor: 500 };
    const d = assessShiftClose({ ...figures, reasonCode: 'short' });
    const { countedCashMinor, ...rest } = figures;
    await okAct('POST', '/v1/shifts/SH-DEMO-1/close/synced', OWNER, {
      ...rest, tillId: 'T1', laneId: 'T1', cashierId: 'cashier-demo-7', tradingDay: today, reasonCode: 'short',
      openedAt: `${today}T03:00:00.000Z`, closedAt: `${today}T15:00:00.000Z`,
      countedMinor: countedCashMinor, expectedMinor: d.expectedMinor, varianceMinor: d.varianceMinor, exceptionRaised: d.exceptionRaised,
    });
    await h.store.append(T, STREAM.sales, makeEvent({
      id: `sale-${T}-demo-r1001`, type: 'SaleCommitted', occurredAt: `${today}T09:00:00.000Z`, idempotencyKey: `sale-${T}-demo-r1001`, source: 'test/synthetic-sale',
      payload: { saleId: 'sale-demo-r1001', receiptNumber: 'R-1001', laneId: 'T1', cashierId: 'cashier-demo-7', tradingDay: today, committedAt: `${today}T09:00:00.000Z`, totalMinor: 50_000, lines: [], tenders: [{ kind: 'cash', amountMinor: 50_000 }] },
    }));
    await okAct('PUT', '/v1/ai/kill-switch', OWNER, { on: false, reason: 'e2e' });
    await okAct('PUT', '/v1/ai/budget', OWNER, { capMinor: 100_000, periodEnds: '2099-01-01T00:00:00.000Z' });
    shell = await startShell(h, T);
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await shell?.stop(); await pool?.end(); });

  const pageAs = async (who: string): Promise<{ page: Page; close: () => Promise<void> }> => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'who', value: who, url: shell.base }]);
    const page = await context.newPage();
    await page.goto(`${shell.base}/ai-drafts.html`, { waitUntil: 'load' });
    return { page, close: () => context.close() };
  };
  const textOf = async (page: Page, selector: string): Promise<string> => (await page.textContent(selector)) ?? '';

  it('switched off, it says so; switched on, the owner sees the bill and the till explained — and nobody named', async () => {
    const { page, close } = await pageAs(OWNER);
    try {
      await page.waitForFunction("(document.querySelector('#bills-list')?.textContent ?? '').includes('No supplier bill needs explaining')", undefined, { timeout: 10_000 });
      // Starts OFF: asking now says so, and nothing is drafted.
      await page.click('#ask-bills');
      await page.waitForFunction("(document.querySelector('#bills-status')?.textContent ?? '').includes('switched off')", undefined, { timeout: 10_000 });
      expect(await page.$('#bills-list .card')).toBeNull();

      await okAct('PUT', '/v1/ai/agents/enabled', OWNER, { expected: [], agents: ['A12', 'A14'] });
      await page.click('#ask-bills');
      await page.waitForSelector('#bills-list .card', { timeout: 10_000 });
      const bill = await textOf(page, '#bills-list .card');
      expect(bill).toContain('Bill INV-DF-101');
      expect(bill).toContain('p-oil: the bill says 50, we received 48 — 2 more billed than received.');
      expect(bill).toContain('p-oil: the bill price is ₹0.12 a unit higher than the order.');
      expect(bill).toContain('Please send a corrected bill or a credit note');
      expect(bill).toContain('the accounts person');

      await page.click('#ask-tills');
      await page.waitForSelector('#tills-list .card[data-proposal="a14-till:SH-DEMO-1"]', { timeout: 10_000 });
      const till = await textOf(page, '#tills-list .card');
      expect(till).toContain('Till close SH-DEMO-1');
      expect(till).toContain('₹500.00 short');
      expect(await textOf(page, '#tills-list .card li[data-reason="cash_sale_may_be_upi_or_card"]')).toContain('Bill R-1001 was recorded as cash');
      // Records, not people: the person who counted the drawer is nowhere on the page.
      expect(await page.textContent('body')).not.toContain('cashier-demo-7');
    } finally {
      await close();
    }
  }, 60_000);

  it('the manager may not run them (greyed, with the reason) but decides: "not right" needs a reason; "agree" commits nothing; Tamil', async () => {
    const before = (await h.store.readStream(T, STREAM.purchase)).length;
    const { page, close } = await pageAs(MGR);
    try {
      await page.waitForSelector('#tills-list .card[data-proposal="a14-till:SH-DEMO-1"]', { timeout: 10_000 });
      expect(await page.getAttribute('#ask-bills', 'disabled')).not.toBeNull();
      expect(await textOf(page, '#ask-bills + .sre-why')).toBe('Your role may not do this.');

      const tillCard = '#tills-list .card[data-proposal="a14-till:SH-DEMO-1"]';
      await page.click(`${tillCard} button[data-decide="rejected"]`);
      await page.waitForFunction(`(document.querySelector('${tillCard} .status')?.textContent ?? '').includes('Say why it is not right first')`, undefined, { timeout: 10_000 });
      await page.fill(`${tillCard} input`, 'R-1001 was paid in cash; the drawer was recounted and it is a pickup slip that was not entered');
      await page.click(`${tillCard} button[data-decide="rejected"]`);
      await page.waitForFunction(`(document.querySelector('${'#tills-list .card'}')?.textContent ?? '').includes('Marked not right by ${MGR}')`, undefined, { timeout: 10_000 });

      await page.click('#bills-list .card button[data-decide="approved"]');
      await page.waitForFunction(`(document.querySelector('#bills-list .card')?.textContent ?? '').includes('Agreed by ${MGR}')`, undefined, { timeout: 10_000 });
      // Agreeing changed nothing on the purchase side — the bill's own routes still decide.
      expect((await h.store.readStream(T, STREAM.purchase)).length).toBe(before);

      // Tamil follows the one toggle — the headings and every reason.
      await page.click('#lang');
      expect(await textOf(page, '#bills-h')).toBe('பொருந்தாத விநியோகஸ்தர் பில்கள்');
      expect(await textOf(page, '#tills-h')).toBe('கூடுதல் அல்லது குறைவான கவுண்டர்கள்');
      expect(await textOf(page, '#bills-list .card li[data-reason="billed_more_than_received"]')).toBe('p-oil: பில்லில் 50, நாம் பெற்றது 48 — பெற்றதை விட 2 அதிகமாகப் பில் செய்யப்பட்டுள்ளது.');
      expect(await textOf(page, '#tills-list .card li[data-reason="cash_sale_may_be_upi_or_card"]')).toContain('UPI அல்லது கார்டு');
      expect(await textOf(page, '#bills-list .card')).toContain('ஒப்புக்கொண்டவர் u-mgr');
    } finally {
      await close();
    }
  }, 60_000);
});
