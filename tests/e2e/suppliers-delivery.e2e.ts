import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * **The supplier master, in a real browser (M06-FR-01 · M23-FR-01 · §28 · P-02 · P-08 — SP-7d, ADR-0013 the E2E matrix).**
 *
 * Every layer of "a person opens Suppliers, sees who needs them and approves or proposes a supplier" is unit-tested —
 * the session model, the browser's `fetchSuppliers` / `openSupplierApprovePort` / `openSupplierProposePort`, the cloud's
 * routes with real RBAC. The one thing units cannot prove is that a person at the ACTUAL screen in a browser makes the
 * read reach the cloud under their own session and render — needing-a-person first, the balance in rupees, the
 * reasons in words — and that a click on **Approve** sends exactly `{ reason }` keyed for idempotency to the right URL
 * with NO approver in the body, is refused on the screen for the reader's OWN proposal with nothing sent, shows the
 * cloud's refusal verbatim and never a fabricated "approved", that a purchase user's **Save** proposes the supplier
 * and the list is re-read from head office, and that a reader without the right sees a plain not-permitted state.
 * This drives headless Chromium against a stub cloud on ONE origin to prove exactly that.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';

interface BrowserGlobals {
  readonly suppliersSession?: { approve(id: string, reason: string): Promise<{ outcome: string }> };
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly hidden?: boolean; readonly textContent?: string; value?: string } | null;
  };
}

const AT = '2026-09-30T10:00:00.000Z';

interface CloudRow {
  supplierId: string; name: string | null; status: 'proposed' | 'active' | 'no_master_record'; blocked: boolean; proposedBy: string | null;
  bank: { accountRef: string } | null;
  totals: { invoicedMinor: number; accruedMinor: number; withheldMinor: number; debitNotesMinor: number; paidMinor: number; owedMinor: number; unmatchedInvoices: number; blockedInvoices: number; pendingReturns: number };
  needsAttention: boolean; attention: string[];
}
const totals = (owedMinor: number, over: Partial<CloudRow['totals']> = {}): CloudRow['totals'] =>
  ({ invoicedMinor: owedMinor, accruedMinor: owedMinor, withheldMinor: 0, debitNotesMinor: 0, paidMinor: 0, owedMinor, unmatchedInvoices: 0, blockedInvoices: 0, pendingReturns: 0, ...over });

/** The list a reader's screen pulls: a clean approved supplier, one proposed by the buyer (approvable by the
 *  accountant), one proposed by the accountant themselves (never approvable by them), one under a hold. The cloud
 *  lists needing-a-person first, as the real route does. */
function cloudList(): CloudRow[] {
  return [
    { supplierId: 's-2', name: 'Kaveri Foods', status: 'proposed', blocked: false, proposedBy: 'u-buyer', bank: null, totals: totals(0), needsAttention: true, attention: ['awaiting_approval'] },
    { supplierId: 's-3', name: 'Ghost & Co', status: 'proposed', blocked: false, proposedBy: 'u-acct', bank: null, totals: totals(0), needsAttention: true, attention: ['awaiting_approval', 'possible_duplicate'] },
    { supplierId: 's-4', name: 'Blocked Bros', status: 'active', blocked: true, proposedBy: 'u-buyer', bank: { accountRef: '****9876' }, totals: totals(9000, { withheldMinor: 2000 }), needsAttention: true, attention: ['blocked', 'withheld'] },
    { supplierId: 's-1', name: 'Amma Traders', status: 'active', blocked: false, proposedBy: 'u-buyer', bank: { accountRef: '****1234' }, totals: totals(4000), needsAttention: false, attention: [] },
  ];
}

interface WriteRequest { readonly method: string; readonly path: string; readonly idempotencyKey: string | undefined; readonly body: Record<string, unknown> }

interface Recorder {
  suppliersData: Record<string, unknown>;
  listStatus: number;              // status the list GET answers with (200 authorised, 403 not)
  rows: CloudRow[];
  approvalStatus: number;          // 200 approves; 422 refuses
  readonly gets: string[];
  readonly writes: WriteRequest[];
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
}

/** A server that serves the Suppliers shell (GET, reader context injected) AND answers the supplier routes on the
 *  same origin, so `credentials:'same-origin'` and a relative `/v1/purchase/...` reach it as in prod. */
async function startShellAndCloud(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/'] = (req.url ?? '/').split('?');
      const json = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && path === '/v1/purchase/suppliers') {
        rec.gets.push(path);
        const first = rec.rows.filter((r) => r.needsAttention);
        json(rec.listStatus, rec.listStatus < 400
          ? { suppliers: [...first, ...rec.rows.filter((r) => !r.needsAttention)], count: rec.rows.length, needingAttentionCount: first.length, owedMinor: rec.rows.reduce((s, r) => s + r.totals.owedMinor, 0), asAt: AT }
          : { code: 'forbidden' });
        return;
      }
      if (req.method === 'POST' && path.startsWith('/v1/purchase/suppliers/')) {
        const key = req.headers['idempotency-key'];
        const body = await readJson(req);
        rec.writes.push({ method: 'POST', path, idempotencyKey: typeof key === 'string' ? key : undefined, body });
        const [, , , , supplierId = '', action] = path.split('/'); // '', v1, purchase, suppliers, <id>, <action?>
        if (action === 'approval') {
          if (rec.approvalStatus >= 400) {
            json(rec.approvalStatus, { code: 'self_approval', whatHappened: 'u-acct proposed this supplier and cannot also approve it (§28 separation of duties).', wasItSaved: 'not_saved', nextSafeAction: 'A different person must approve it.' });
            return;
          }
          // The cloud's own state change: the approved supplier no longer needs a person on the next READ.
          rec.rows = rec.rows.map((r) => (r.supplierId === supplierId ? { ...r, status: 'active', needsAttention: false, attention: [] } : r));
          json(200, { supplier: { supplierId, status: 'active' }, alreadyApproved: false });
          return;
        }
        // Propose: a new record, proposed, needing a person.
        const name = typeof body['name'] === 'string' ? body['name'] : '';
        rec.rows = [...rec.rows, { supplierId, name, status: 'proposed', blocked: false, proposedBy: 'u-mgr', bank: null, totals: totals(0), needsAttention: true, attention: ['awaiting_approval'] }];
        json(201, { supplier: { supplierId, name, status: 'proposed', possibleDuplicates: name === 'Amma Traders' ? ['s-1'] : [] }, created: true });
        return;
      }
      const file = path === '/' || path === '/suppliers' ? 'suppliers.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let html = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.suppliersData = ${JSON.stringify(rec.suppliersData).replace(/</g, '\\u003c')};</script>`;
          html = html.replace('<!--SCREEN-DATA-->', inject);
        }
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
        res.end(html);
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

const readerWith = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({ userId, permissions });
const recorder = (over: Partial<Recorder>): Recorder => ({ suppliersData: {}, listStatus: 200, rows: cloudList(), approvalStatus: 200, gets: [], writes: [], ...over });

const waitFor = async (probe: () => boolean, ms = 5_000): Promise<boolean> => new Promise((resolve) => {
  const started = Date.now();
  const tick = (): void => {
    if (probe()) { resolve(true); return; }
    if (Date.now() - started > ms) { resolve(false); return; }
    setTimeout(tick, 50);
  };
  tick();
});

describe.skipIf(!HAVE_BROWSER)('the supplier master, end to end in a real browser (M06-FR-01 · §28)', () => {
  let browser: Browser;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (rec: Recorder) => {
    const srv = await startShellAndCloud(rec);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).suppliersSession !== undefined, undefined, { timeout: 10_000 });
    return { srv, context, page, teardown: async () => { await context.close(); await srv.stop(); } };
  };
  const rowsRendered = () => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length > 0;

  it('an accountant sees every supplier — needing a person first, the hold as an error, the balance in rupees, the reasons in words — and may approve only the one somebody else proposed', async () => {
    const rec = recorder({ suppliersData: readerWith('u-acct', ['supplier.view', 'purchase.supplier.approve']) });
    const { page, teardown } = await open(rec);
    try {
      await page.waitForFunction(rowsRendered, undefined, { timeout: 10_000 });
      // The read reached the cloud under the reader's own session.
      expect(rec.gets).toContain('/v1/purchase/suppliers');
      // Needing-a-person first: the first row is the hold (error tone), the clean one last; never colour alone.
      const order = await page.$$eval('#rows li.row', (els) => els.map((e) => (e as unknown as { dataset: Record<string, string | undefined> }).dataset['supplierId']));
      expect(order).toEqual(['s-4', 's-3', 's-2', 's-1']); // the hold, then the two proposed by name, then the clean one
      expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row.tone-error').length)).toBe(1);
      const firstAnnounced = await page.getAttribute('#rows li.row .status', 'aria-label');
      expect((firstAnnounced ?? '').length).toBeGreaterThan(0);
      const rows = (await page.textContent('#rows')) ?? '';
      expect(rows).toContain('₹90.00');
      expect(rows).toContain('Under a hold');
      expect(rows).toContain('Looks like another supplier');
      expect(rows).toContain('proposed by you — someone else must approve it'); // s-3, the accountant's own
      expect(((await page.textContent('#asof')) ?? '').toLowerCase()).toContain('as of');
      expect((await page.textContent('#summary')) ?? '').toContain('4 suppliers');
      // The approve control offers ONLY s-2 — never the reader's own s-3, never the active ones (§28).
      const options = await page.$$eval('#approve-supplier option', (els) => els.map((e) => (e as unknown as { value: string }).value));
      expect(options).toEqual(['s-2']);
      // No propose form for a reader without the manage right; a word says so.
      expect(await page.isHidden('#proposer')).toBe(true);
      expect(((await page.textContent('#no-propose')) ?? '').toLowerCase()).toContain('purchasing permission');
    } finally {
      await teardown();
    }
  });

  it('Approve POSTs exactly { reason } to the supplier\'s approval URL, keyed for idempotency, with NO approver in the body — then the list is re-read and the supplier no longer waits', async () => {
    const rec = recorder({ suppliersData: readerWith('u-acct', ['supplier.view', 'purchase.supplier.approve']) });
    const { page, teardown } = await open(rec);
    try {
      await page.waitForFunction(rowsRendered, undefined, { timeout: 10_000 });
      const readsBefore = rec.gets.length;
      await page.selectOption('#approve-supplier', 's-2');
      await page.fill('#approve-reason', 'GSTIN and bank letter checked');
      await page.click('#approve');
      expect(await waitFor(() => rec.writes.length === 1)).toBe(true);
      const w = rec.writes[0]!;
      expect(w.path).toBe('/v1/purchase/suppliers/s-2/approval');
      expect(w.body).toEqual({ reason: 'GSTIN and bank letter checked' });
      expect(w.idempotencyKey ?? '').not.toBe('');
      // The screen shows the cloud's verdict and re-reads the list: s-2 is now active and needs nobody.
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect((await page.textContent('#result-text')) ?? '').toContain('Supplier approved');
      expect(await waitFor(() => rec.gets.length > readsBefore)).toBe(true);
      await page.waitForFunction(() => {
        const d = (globalThis as unknown as BrowserGlobals).document;
        return d.querySelectorAll('#approve-supplier option').length === 0;
      }, undefined, { timeout: 10_000 });
      expect(((await page.textContent('#approve-none')) ?? '')).toContain('No supplier is waiting');
    } finally {
      await teardown();
    }
  });

  it('a self-approval is refused ON THE SCREEN with nothing sent; a cloud refusal (422) is shown verbatim and never claimed as approved', async () => {
    const rec = recorder({ suppliersData: readerWith('u-acct', ['supplier.view', 'purchase.supplier.approve']), approvalStatus: 422 });
    const { page, teardown } = await open(rec);
    try {
      await page.waitForFunction(rowsRendered, undefined, { timeout: 10_000 });
      // The accountant's own proposal is not in the control; even asked directly, the session refuses before the wire.
      const own = await page.evaluate(() => (globalThis as unknown as BrowserGlobals).suppliersSession!.approve('s-3', 'why'));
      expect(own).toEqual({ outcome: 'self_approval' });
      expect(rec.writes).toHaveLength(0);
      // The cloud refusing: the reason is shown as the cloud said it.
      await page.selectOption('#approve-supplier', 's-2');
      await page.fill('#approve-reason', 'checked');
      await page.click('#approve');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      expect(rec.writes).toHaveLength(1);
      const text = (await page.textContent('#result-text')) ?? '';
      expect(text).toContain('Head office refused the approval');
      expect(text).toContain('cannot also approve it');
      expect(text).not.toContain('Supplier approved');
    } finally {
      await teardown();
    }
  });

  it('a purchase user proposes a supplier: the POST carries the fields under the supplier code, the screen says proposed + the look-alike the cloud named, and the list is re-read', async () => {
    const rec = recorder({ suppliersData: readerWith('u-mgr', ['supplier.view', 'purchase.supplier.manage']) });
    const { page, teardown } = await open(rec);
    try {
      await page.waitForFunction(rowsRendered, undefined, { timeout: 10_000 });
      // No approve control for a reader without the approve right; a word says so.
      expect(await page.isHidden('#approver')).toBe(true);
      expect(((await page.textContent('#no-approve')) ?? '').toLowerCase()).toContain('approval permission');
      const readsBefore = rec.gets.length;
      await page.fill('#propose-code', 'SUP-9');
      await page.fill('#propose-name', 'Amma Traders');
      await page.fill('#propose-gstin', '33abcde1234f1z5');
      await page.fill('#propose-terms', '30');
      await page.click('#propose');
      expect(await waitFor(() => rec.writes.length === 1)).toBe(true);
      const w = rec.writes[0]!;
      expect(w.path).toBe('/v1/purchase/suppliers/SUP-9');
      expect(w.body).toEqual({ name: 'Amma Traders', gstin: '33abcde1234f1z5', paymentTermsDays: 30 });
      expect(w.idempotencyKey ?? '').not.toBe('');
      await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
      const text = (await page.textContent('#result-text')) ?? '';
      expect(text).toContain('Supplier proposed');
      expect(text).toContain('Looks like another supplier: s-1');
      expect(await waitFor(() => rec.gets.length > readsBefore)).toBe(true);
      await page.waitForFunction(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length === 5, undefined, { timeout: 10_000 });
      // An empty form is refused on the screen before anything is sent.
      await page.click('#propose');
      expect((await page.textContent('#result-text')) ?? '').toContain('needs a code and a name');
      expect(rec.writes).toHaveLength(1);
    } finally {
      await teardown();
    }
  });

  it('a reader WITHOUT the permission sees a plain not-permitted state, no suppliers and no controls', async () => {
    const rec = recorder({ suppliersData: readerWith('u-cash', []), listStatus: 403 });
    const { page, teardown } = await open(rec);
    try {
      await page.waitForSelector('#state:not([hidden])', { timeout: 10_000 });
      expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).document.querySelectorAll('#rows li.row').length)).toBe(0);
      expect(((await page.textContent('#state-text')) ?? '').toLowerCase()).toContain('permission');
      expect(await page.isHidden('#approver')).toBe(true);
      expect(await page.isHidden('#proposer')).toBe(true);
    } finally {
      await teardown();
    }
  });
});
