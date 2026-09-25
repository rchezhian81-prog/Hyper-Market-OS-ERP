import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  captureConcessionTagIdempotent,
  reverseConcessionTag,
  concessionTagTotals,
  type CaptureInput,
  type CommissionSchemeSnapshot,
  type ConcessionTag,
} from '../../packages/concession/src/index';

/**
 * **Till-side concession tagging, end to end in a real browser (M27, Item 3 slice 3b).**
 *
 * The piece a unit test cannot prove: that a cashier at the actual till PANEL records a partner-counter
 * line, and a supervisor corrects one, against a backend running the production `@sre/concession` engine.
 * The served page holds no money logic; the Node server here plays the POS/concession API the way the
 * cloud will, wiring the SAME engine (`captureConcessionTagIdempotent`, `reverseConcessionTag`,
 * `concessionTagTotals`) — so no pricing/commission code ever enters the browser.
 *
 * It proves, through Chromium:
 *   • a cashier records a concession line from an approved source → it lands in the append-only stream
 *     with the commission the engine computed;
 *   • a resend carrying the same idempotency key does NOT charge twice (the stream does not grow);
 *   • a CASHIER reversal is refused server-side (SoD §28) — the line is untouched, the refusal recorded;
 *   • a SUPERVISOR reversal backs the line out — a negated tag is appended and the net total returns to 0.
 *
 * Self-skips where no browser is present, like every other e2e.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/pos/web';
const TENANT = 't-sre';

const SCHEME: CommissionSchemeSnapshot = { contractId: 'ct-1', basis: 'revenue_share', commissionOn: 'gross', revenueShareBps: 1_500 };

interface TagBackend {
  base: string;
  stop: () => Promise<void>;
  tagCount: () => number;
}

/** A local Node server that serves the till panel AND plays the concession API with the production engine. */
async function startBackend(): Promise<TagBackend> {
  const tags: ConcessionTag[] = [];
  const reversed = new Set<string>();
  let seq = 0;

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += String(c); });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}') as Record<string, unknown>); } catch { resolve({}); } });
    });
  const sendJson = (res: ServerResponse, body: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const isoNow = (): string => new Date().toISOString();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');

      if (req.method === 'POST' && path === '/concession/tag/capture') {
        const b = await readBody(req);
        seq += 1;
        const input: CaptureInput = {
          tenantId: TENANT,
          tagId: `tag-${seq}`,
          kind: 'sale',
          saleId: String(b['saleId'] ?? 'sale-1'),
          lineId: String(b['lineId'] ?? `line-${seq}`),
          concessionaireId: String(b['concessionaireId'] ?? ''),
          counterId: String(b['counterId'] ?? ''),
          branchId: 'br-1',
          tillId: 'till-3',
          shiftId: 'shift-a',
          productId: String(b['productId'] ?? ''),
          qty: Number(b['qty'] ?? 1),
          grossMinor: Number(b['grossMinor'] ?? 0),
          discountMinor: Number(b['discountMinor'] ?? 0),
          taxMinor: Number(b['taxMinor'] ?? 0),
          scheme: SCHEME,
          capturedBy: String(b['capturedBy'] ?? 'cashier-anita'),
          byRole: (String(b['byRole'] ?? 'cashier')) as CaptureInput['byRole'],
          source: String(b['source'] ?? ''),
          idempotencyKey: String(b['idempotencyKey'] ?? `k-${seq}`),
          at: isoNow(),
        };
        const result = captureConcessionTagIdempotent(input, tags);
        if (result.captured && result.tag !== undefined) tags.push(result.tag);
        sendJson(res, { ok: true, captured: result.captured, tag: result.tag, existing: result.existing, refusal: result.refusal });
        return;
      }

      if (req.method === 'POST' && path === '/concession/tag/reverse') {
        const b = await readBody(req);
        const tagId = String(b['tagId'] ?? '');
        const idx = tags.findIndex((t) => t.tagId === tagId);
        if (idx === -1) { sendJson(res, { ok: false, refusal: 'not_found' }); return; }
        seq += 1;
        const result = reverseConcessionTag({
          original: tags[idx]!,
          newTagId: `tag-${seq}`,
          by: String(b['by'] ?? ''),
          byRole: (String(b['byRole'] ?? 'cashier')) as CaptureInput['byRole'],
          reasonCode: String(b['reasonCode'] ?? 'CORRECTION'),
          now: isoNow(),
          alreadyReversed: reversed.has(tagId),
        });
        tags[idx] = result.original; // keep the original, now carrying the correction in its history
        if (result.corrected && result.correction !== undefined) {
          tags.push(result.correction);
          reversed.add(tagId);
        }
        sendJson(res, { ok: true, corrected: result.corrected, correction: result.correction, refusal: result.refusal });
        return;
      }

      if (req.method === 'GET' && path === '/concession/tag/stream') {
        sendJson(res, { tags, totals: concessionTagTotals({ tags, tenantId: TENANT }) });
        return;
      }

      // Otherwise serve a static file from the POS web dir.
      const file = path === '/' || path === '/concession-tag' ? 'concession-tag.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(buf);
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
      resolve({
        base: `http://127.0.0.1:${port}`,
        stop: () => new Promise((done) => { server.close(() => { done(); }); }),
        tagCount: () => tags.length,
      });
    });
  });
}

describe.skipIf(!HAVE_BROWSER)('till-side concession tagging, end to end in a real browser (M27)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('records a line, ignores a duplicate, refuses a cashier reversal, and lets a supervisor back it out', async () => {
    const backend = await startBackend();
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    try {
      await page.goto(`${backend.base}/concession-tag`, { waitUntil: 'load' });

      // 1) A cashier records a concession line from the approved docket.
      await page.fill('#grossMinor', '100000');
      await page.fill('#taxMinor', '3000');
      await page.click('#record');
      await page.locator('#status', { hasText: 'commission 15000' }).waitFor({ timeout: 10_000 });
      expect(await page.locator('#t-net').textContent()).toBe('100000');
      expect(await page.locator('#t-commission').textContent()).toBe('15000');
      expect(backend.tagCount()).toBe(1);

      // 2) A resend with the SAME idempotency key must not charge twice.
      const dup = await page.evaluate(async () => {
        const g = globalThis as unknown as { fetch(i: string, x: unknown): Promise<{ json(): Promise<{ captured: boolean; refusal?: string }> }> };
        const r = await g.fetch('/concession/tag/capture', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idempotencyKey: 'till-3:sale-1:line-1', saleId: 'sale-1', lineId: 'line-1', concessionaireId: 'jeweller-1', counterId: 'counter-gold', productId: 'ring-22k', qty: 1, grossMinor: 100000, discountMinor: 0, taxMinor: 3000, capturedBy: 'cashier-anita', byRole: 'cashier', source: 'docket-8842' }),
        });
        return r.json();
      });
      expect(dup.captured).toBe(false);
      expect(dup.refusal).toBe('duplicate_idempotency_key');
      expect(backend.tagCount()).toBe(1); // stream did not grow

      // 3) A CASHIER cannot reverse a posted line — refused server-side (SoD §28).
      await page.locator('button[data-reverse]').first().click();
      await page.locator('#status', { hasText: 'Only a supervisor may reverse' }).waitFor({ timeout: 10_000 });
      await page.locator('#t-net', { hasText: '100000' }).waitFor({ timeout: 10_000 }); // untouched
      expect(backend.tagCount()).toBe(1);

      // 4) A SUPERVISOR reversal backs the line out — a negated tag is appended, net returns to 0.
      await page.selectOption('#role', 'supervisor');
      await page.locator('button[data-reverse]').first().click();
      await page.locator('#status', { hasText: 'Reversed' }).waitFor({ timeout: 10_000 });
      await page.locator('#t-net', { hasText: /^0$/ }).waitFor({ timeout: 10_000 });
      expect(await page.locator('#t-commission').textContent()).toBe('0');
      expect(backend.tagCount()).toBe(2); // sale + reversal, both kept (append-only)
    } finally {
      await context.close();
      await backend.stop();
    }
  }, 60_000);
});
