import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **The floor indent screen, in a real browser (SP-8b · F08 · WF-06 · WF-07 · M09-FR-03 · M08-FR-02 · §28 · §31 · P-01 ·
 * P-03 · P-08 — ADR-0013 the E2E matrix).**
 *
 * The audit's F08, at the surface: no served screen let the floor ask the back store for stock or count in what came, and
 * what a screen did save lived in page memory. Every layer below the browser is unit-tested — the session model, the
 * browser's `fetchIndents` / `openIndentApprovePort` / `openIndentsRelay`, the cloud's direct and synced routes with real
 * RBAC, the box → cloud relay. The one thing units cannot prove is that a person at the ACTUAL screen in a browser:
 *
 *   • RAISES an indent on the REAL box (`startEdge` serving the real shell with `window.laneWriteBase` injected) and it is
 *     on the DURABLE device queue before the screen says saved, then WITH THE STORE COMPUTER — on its fsync'd device-events
 *     log and in its queue for head office — and RELOADING the page still lists it, sends nothing twice; with the box's
 *     socket gone it stays "saved on this device … trying again", never sent, never refused, and survives the reload;
 *   • against a stub cloud on ONE origin: reads the register under their own session (needing a person first, four figures
 *     a line, every state in words), sees Approve offered ONLY for asks somebody else raised, has a click on Approve send
 *     exactly `{ reason }` keyed for idempotency with NO approver in the body, is refused on the screen for their OWN ask
 *     with nothing sent, sees the cloud's refusal verbatim, COUNTS IN an issue somebody else sent (queued, handed to the
 *     box, "posted" only on the box's word), and — without the rights — sees no control and a plain not-permitted state.
 *
 * Head office delivery from the box is proven by `tests/integration/floor-indents-synced.test.ts`.
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const WEB_DIR = 'apps/web-erp/web';
const KEY = ['floor', 'indents', 'reload', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const AT = '2026-09-30T10:00:00.000Z';

interface IndentsWindow {
  readonly laneWriteBase?: string;
  readonly indentsRelay?: unknown;
  readonly indentsSession?: {
    approve(id: string, reason: string): Promise<{ outcome: string }>;
    savedWork(): { kind: string; id: string; what: string; state: string; reason?: string }[];
    view(lang: 'en' | 'ta'): { approvable: { indentId: string }[]; receivable: { indentId: string; issue: { issueId: string } }[] };
  };
  readonly document: {
    querySelectorAll(selector: string): { readonly length: number };
    getElementById(id: string): { readonly hidden?: boolean; readonly textContent?: string; value?: string } | null;
  };
}

/** The box's pack for the floor: who is looking and what they hold, the floor and the back store, one product to ask for. */
const PACK_JSON = JSON.stringify({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1', warehouseId: 'S1-BACK' },
  indentsPolicy: { userId: 'u-floor', permissions: ['inventory.indent.read', 'inventory.indent.request', 'inventory.movement.append'] },
  products: [{ productId: 'RICE', name: 'Rice 5kg', nameTa: 'அரிசி 5கி', categoryId: 'grocery', unitPriceMinor: 45_000, uom: 'EA', barcodes: [], availableMinor: 50, taxBps: 0, status: 'active' }],
  lossPreventionRules: [],
});

// ── the stub cloud + stub box socket, on one origin ──────────────────────────────────────────────────────────────

interface CloudLine { productId: string; uom: string; requestedMinor: number; allocatedMinor: number; issuedMinor: number; receivedMinor: number; inTransitMinor: number; shortfallMinor: number; outstandingMinor: number }
interface CloudIssue { issueId: string; issuedBy: string; issuedAt: string; state: 'in_transit' | 'received'; lines: { productId: string; batchId: string | null; quantityMinor: number }[] }
interface CloudRow {
  indentId: string; state: string; requestedBy: string; requestedAt: string; approvedBy: string | null; fromLocationId: string; toLocationId: string; reason: string | null;
  flags: string[]; attention: string[]; needsAttention: boolean; totals: { lines: CloudLine[] }; issues: CloudIssue[];
}
const cloudLine = (over: Partial<CloudLine> = {}): CloudLine => ({ productId: 'RICE', uom: 'EA', requestedMinor: 20, allocatedMinor: 0, issuedMinor: 0, receivedMinor: 0, inTransitMinor: 0, shortfallMinor: 0, outstandingMinor: 0, ...over });
/** The register head office answers: the floor's ask (approvable by the manager), the manager's OWN ask (never by them), one on the trolley issued by u-back. */
function cloudList(): CloudRow[] {
  return [
    { indentId: 'ind-1', state: 'requested', requestedBy: 'u-floor', requestedAt: '2026-09-30T08:00:00.000Z', approvedBy: null, fromLocationId: 'S1-BACK', toLocationId: 'S1', reason: 'shelf 4 empty', flags: [], attention: ['awaiting_approval'], needsAttention: true, totals: { lines: [cloudLine()] }, issues: [] },
    { indentId: 'ind-3', state: 'requested', requestedBy: 'u-mgr', requestedAt: '2026-09-30T09:00:00.000Z', approvedBy: null, fromLocationId: 'S1-BACK', toLocationId: 'S1', reason: null, flags: [], attention: ['awaiting_approval'], needsAttention: true, totals: { lines: [cloudLine({ productId: 'OIL', uom: 'LTR', requestedMinor: 6 })] }, issues: [] },
    { indentId: 'ind-2', state: 'issuing', requestedBy: 'u-floor', requestedAt: '2026-09-30T07:00:00.000Z', approvedBy: 'u-mgr', fromLocationId: 'S1-BACK', toLocationId: 'S1', reason: null, flags: ['partial_issue'], attention: ['owed_by_back_store', 'on_the_trolley'], needsAttention: true,
      totals: { lines: [cloudLine({ allocatedMinor: 20, issuedMinor: 12, inTransitMinor: 12, outstandingMinor: 8 })] },
      issues: [{ issueId: 'is-1', issuedBy: 'u-back', issuedAt: '2026-09-30T07:30:00.000Z', state: 'in_transit', lines: [{ productId: 'RICE', batchId: null, quantityMinor: 12 }] }] },
  ];
}

interface WriteRequest { readonly path: string; readonly idempotencyKey: string | undefined; readonly body: Record<string, unknown> }
interface HandedItem { readonly key: string; readonly event: { type: string; payload: Record<string, unknown> } }
interface Recorder {
  indentsData: Record<string, unknown>;
  listStatus: number;          // the register GET: 200 authorised, 403 not
  rows: CloudRow[];
  approvalStatus: number;      // 200 approves; 422 refuses
  readonly gets: string[];
  readonly writes: WriteRequest[];
  readonly handed: HandedItem[]; // what the screen handed to the (stub) box socket
}
const recorder = (over: Partial<Recorder>): Recorder => ({ indentsData: {}, listStatus: 200, rows: cloudList(), approvalStatus: 200, gets: [], writes: [], handed: [], ...over });

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
}

/** Serves the Indents shell (reader context + `window.laneWriteBase` = this origin injected), the cloud's indent routes
 *  AND the box's `/lane/outbox` socket on one origin, so `credentials:'same-origin'` and relative paths work as in prod. */
async function startShellCloudAndSocket(rec: Recorder): Promise<{ base: string; stop: () => Promise<void> }> {
  let base = '';
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const [path = '/', query = ''] = (req.url ?? '/').split('?');
      const json = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && path === '/v1/floor/indents') {
        rec.gets.push(path);
        json(rec.listStatus, rec.listStatus < 400
          ? { indents: rec.rows, count: rec.rows.length, needingAttentionCount: rec.rows.filter((r) => r.needsAttention).length, inTransitMinor: 12, outstandingMinor: 8, asAt: AT }
          : { code: 'forbidden' });
        return;
      }
      if (req.method === 'POST' && path.startsWith('/v1/floor/indents/')) {
        const key = req.headers['idempotency-key'];
        const body = await readJson(req);
        rec.writes.push({ path, idempotencyKey: typeof key === 'string' ? key : undefined, body });
        const [, , , , indentId = ''] = path.split('/'); // '', v1, floor, indents, <id>, approval
        if (rec.approvalStatus >= 400) {
          json(rec.approvalStatus, { code: 'nothing_allocated', whatHappened: 'None of RICE is at S1-BACK, so nothing could be allocated.', wasItSaved: 'not_saved', nextSafeAction: 'Reject the indent, or wait for stock.' });
          return;
        }
        // The cloud's own state change: the approved ask no longer awaits a person on the next READ.
        rec.rows = rec.rows.map((r) => (r.indentId === indentId ? { ...r, state: 'approved', approvedBy: 'u-mgr', attention: ['owed_by_back_store'], totals: { lines: r.totals.lines.map((l) => ({ ...l, allocatedMinor: l.requestedMinor, outstandingMinor: l.requestedMinor })) } } : r));
        json(200, { indent: { indentId, state: 'approved' }, alreadyApproved: false });
        return;
      }
      // The (stub) box socket: takes the batch, acks each item accepted, and — asked later — says every handed key is posted.
      if (req.method === 'POST' && path === '/lane/outbox') {
        const body = await readJson(req);
        const items = (Array.isArray(body['items']) ? body['items'] : []) as HandedItem[];
        rec.handed.push(...items);
        json(200, { acks: items.map((i) => ({ key: i.key, status: 'accepted' })) });
        return;
      }
      if (req.method === 'GET' && path === '/lane/outbox/status') {
        const keys = decodeURIComponent(query.replace(/^keys=/, '')).split(',').filter((k) => k !== '');
        json(200, { items: keys.map((key) => ({ key, state: 'posted', attempts: 1 })) });
        return;
      }
      const file = path === '/' || path === '/indents' ? 'indents.html' : path.replace(/^\//, '');
      try {
        const buf = await readFile(join(WEB_DIR, file));
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        let html = buf.toString('utf8');
        if (file.endsWith('.html')) {
          const inject = `<script>window.indentsData = ${JSON.stringify(rec.indentsData).replace(/</g, '\\u003c')}; window.laneWriteBase = ${JSON.stringify(base)};</script>`;
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
      base = `http://127.0.0.1:${port}`;
      resolve({ base, stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }) });
    });
  });
}

const readerWith = (userId: string, permissions: readonly string[]): Record<string, unknown> => ({
  userId, permissions, storeId: 'S1', backStoreId: 'S1-BACK', products: [{ productId: 'RICE', name: 'Rice 5kg', uom: 'EA' }, { productId: 'OIL', name: 'Oil 1l', uom: 'LTR' }],
});
const waitFor = async (probe: () => boolean, ms = 5_000): Promise<boolean> => new Promise((resolve) => {
  const started = Date.now();
  const tick = (): void => {
    if (probe()) { resolve(true); return; }
    if (Date.now() - started > ms) { resolve(false); return; }
    setTimeout(tick, 50);
  };
  tick();
});

describe.skipIf(!HAVE_BROWSER)('the floor indent screen, end to end in a real browser (SP-8b · F08 · §28 · §31)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const ready = (page: Page) => page.waitForFunction(() => (globalThis as unknown as IndentsWindow).indentsSession !== undefined && typeof (globalThis as unknown as IndentsWindow).laneWriteBase === 'string', undefined, { timeout: 15_000 });

  // ── on the REAL box ─────────────────────────────────────────────────────────────────────────────────────────

  async function box(): Promise<{ edge: EdgeProcess; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-indents-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return { edge, base: `http://127.0.0.1:${edge.screens!.port}` };
  }
  async function openOnBox(base: string): Promise<Page> {
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}/indents`, { waitUntil: 'load' });
    await ready(page);
    return page;
  }
  /** Ask the back store for 20 RICE: product, quantity, add the line, save. */
  async function raiseRice(page: Page): Promise<void> {
    await page.waitForSelector('#raiser:not([hidden])');
    await page.fill('#raise-product', 'RICE');
    await page.fill('#raise-qty', '20');
    await page.click('#raise-add');
    await page.waitForSelector('#raise-lines li[data-product-id="RICE"]');
    await page.click('#raise');
    await page.waitForSelector('#result:not([hidden])');
  }
  const savedState = (page: Page) => page.evaluate(() => (globalThis as unknown as IndentsWindow).indentsSession!.savedWork()[0]?.state);

  it('on the real box: an ask raised in the browser is on the durable device queue → with the store computer (on its fsync\'d log, in the requester\'s name) → still listed after a reload, sent once', async () => {
    const { edge, base } = await box();
    const page = await openOnBox(base);
    expect(await page.evaluate(() => (globalThis as unknown as IndentsWindow).indentsRelay !== undefined)).toBe(true);
    // No cloud here: the register could not be read, the screen says so in words, and still offers the ask (P-01).
    expect(await page.isVisible('#state')).toBe(true);
    expect(((await page.textContent('#state-text')) ?? '').length).toBeGreaterThan(0);

    await raiseRice(page);
    expect((await page.textContent('#result-text')) ?? '').toContain('Indent saved');
    // Saved on this device before anything else; within a moment WITH the store computer — the box has it on its fsync'd
    // device-events log and in its queue for head office. This is what F08 said existed nowhere.
    await page.waitForSelector('#saved li.saved[data-kind="request"]');
    await page.waitForFunction(() => (globalThis as unknown as IndentsWindow).indentsSession!.savedWork()[0]?.state === 'handed_to_box', undefined, { timeout: 10_000 });
    await page.waitForSelector('#saved li.saved[data-state="handed_to_box"]');
    expect((await page.textContent('#saved li.saved .pill')) ?? '').toContain('With the store computer');
    const pending = edge.deviceEventsOutbox.pending();
    expect(pending.map((i) => i.event.type)).toEqual(['FloorIndentRequested']);
    const indentId = (pending[0]!.event.payload as { indentId: string }).indentId;
    expect(pending[0]!.key).toBe(`indent:${indentId}`);
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ indentId, fromLocationId: 'S1-BACK', toLocationId: 'S1', requestedBy: 'u-floor', storeId: 'S1', source: 'indents-screen', lines: [{ productId: 'RICE', quantityMinor: 20, uom: 'EA' }] });

    // RELOAD. The ask is still listed with its state; nothing was re-sent (the box already acknowledged it).
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector(`#saved li.saved[data-kind="request"][data-id="${indentId}"]`);
    expect(await savedState(page)).toBe('handed_to_box');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(1);
  });

  it('on the real box with its socket gone: the ask stays saved on this device — trying again, never sent, never refused — and survives a reload', async () => {
    const { edge, base } = await box();
    const page = await openOnBox(base);
    await edge.lane!.stop(); // the socket goes away AFTER the page learned its address

    await raiseRice(page);
    await page.waitForFunction(() => (globalThis as unknown as IndentsWindow).indentsSession!.savedWork()[0]?.state === 'retrying', undefined, { timeout: 10_000 });
    await page.waitForSelector('#saved li.saved[data-state="retrying"]');
    expect((await page.textContent('#saved li.saved .pill')) ?? '').toContain('trying again');
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);

    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('#saved li.saved[data-kind="request"]');
    expect(['saved_here', 'retrying']).toContain(await savedState(page));
    expect(edge.deviceEventsOutbox.all()).toHaveLength(0);
  });

  // ── against a stub cloud, on one origin ─────────────────────────────────────────────────────────────────────

  const open = async (rec: Recorder) => {
    const srv = await startShellCloudAndSocket(rec);
    stops.push(srv.stop);
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await ready(page);
    return page;
  };
  const rowsRendered = () => (globalThis as unknown as IndentsWindow).document.querySelectorAll('#rows li.row').length > 0;

  it('a manager sees the register — the asks first, four figures a line, every state in words — may approve only the ask somebody else raised, and may count in only what somebody else sent', async () => {
    const rec = recorder({ indentsData: readerWith('u-mgr', ['inventory.indent.read', 'inventory.indent.approve', 'inventory.movement.append']) });
    const page = await open(rec);
    await page.waitForFunction(rowsRendered, undefined, { timeout: 10_000 });
    expect(rec.gets).toContain('/v1/floor/indents');
    const order = await page.$$eval('#rows li.row', (els) => els.map((e) => (e as unknown as { dataset: Record<string, string | undefined> }).dataset['indentId']));
    expect(order).toEqual(['ind-1', 'ind-3', 'ind-2']); // the undecided asks, oldest first; then the one on the trolley
    expect((await page.getAttribute('#rows li.row .status', 'aria-label') ?? '').length).toBeGreaterThan(0);
    const rows = (await page.textContent('#rows')) ?? '';
    expect(rows).toContain('Waiting for approval');
    expect(rows).toContain('On the trolley');
    expect(rows).toContain('Issued in parts'); // the flag, in words
    expect(rows).toContain('u-back');
    const trolley = await page.$$eval('#rows li.row[data-indent-id="ind-2"] table.lines td.n', (els) => els.map((e) => (e as unknown as { textContent: string }).textContent));
    expect(trolley).toEqual(['20', '20', '12', '12', '0', '0', '8']); // asked · allocated · issued · on the trolley · on the shelf · short · still owed
    expect((await page.textContent('#summary')) ?? '').toContain('3 indents');
    expect(((await page.textContent('#asof')) ?? '').toLowerCase()).toContain('as of');
    // Approve offers ONLY ind-1 — never the manager's own ind-3 (§28); Count in offers ONLY the issue u-back sent.
    expect(await page.$$eval('#approve-indent option', (els) => els.map((e) => (e as unknown as { value: string }).value))).toEqual(['ind-1']);
    expect(await page.$$eval('#receive-issue option', (els) => els.map((e) => (e as unknown as { value: string }).value))).toEqual(['ind-2|is-1']);
    // No raise form for a reader without the request right; a word says so.
    expect(await page.isHidden('#raiser')).toBe(true);
    expect(((await page.textContent('#no-request')) ?? '').length).toBeGreaterThan(0);
  });

  it('Approve POSTs exactly { reason } to the indent\'s approval URL, keyed for idempotency, with NO approver in the body — then the register is re-read and the ask no longer waits', async () => {
    const rec = recorder({ indentsData: readerWith('u-mgr', ['inventory.indent.read', 'inventory.indent.approve']) });
    const page = await open(rec);
    await page.waitForFunction(rowsRendered, undefined, { timeout: 10_000 });
    const readsBefore = rec.gets.length;
    await page.selectOption('#approve-indent', 'ind-1');
    await page.fill('#approve-reason', 'shelf checked, back store has it');
    await page.click('#approve');
    expect(await waitFor(() => rec.writes.length === 1)).toBe(true);
    expect(rec.writes[0]).toMatchObject({ path: '/v1/floor/indents/ind-1/approval', body: { reason: 'shelf checked, back store has it' } });
    expect(rec.writes[0]!.idempotencyKey ?? '').not.toBe('');
    await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
    expect((await page.textContent('#result-text')) ?? '').toContain('Indent approved');
    expect(await waitFor(() => rec.gets.length > readsBefore)).toBe(true);
    await page.waitForFunction(() => (globalThis as unknown as IndentsWindow).document.querySelectorAll('#approve-indent option').length === 0, undefined, { timeout: 10_000 });
    expect(((await page.textContent('#approve-none')) ?? '').length).toBeGreaterThan(0);
    expect(await page.$$eval('#rows li.row[data-indent-id="ind-1"]', (els) => els.map((e) => (e as unknown as { dataset: Record<string, string | undefined> }).dataset['state']))).toEqual(['approved']);
  });

  it('a self-approval is refused ON THE SCREEN with nothing sent; a cloud refusal (422) is shown verbatim and never claimed as approved', async () => {
    const rec = recorder({ indentsData: readerWith('u-mgr', ['inventory.indent.read', 'inventory.indent.approve']), approvalStatus: 422 });
    const page = await open(rec);
    await page.waitForFunction(rowsRendered, undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => (globalThis as unknown as IndentsWindow).indentsSession!.approve('ind-3', 'mine'))).toEqual({ outcome: 'self_approval' });
    expect(rec.writes).toHaveLength(0);
    await page.selectOption('#approve-indent', 'ind-1');
    await page.click('#approve');
    await page.waitForSelector('#result:not([hidden])', { timeout: 10_000 });
    expect(rec.writes).toHaveLength(1);
    const text = (await page.textContent('#result-text')) ?? '';
    expect(text).toContain('Head office refused');
    expect(text).toContain('nothing could be allocated');
    expect(text).not.toContain('Indent approved');
  });

  it('Count in: what the floor counted is queued durably, handed to the box socket as a FloorIndentReceived in the counter\'s name, and shown "posted" only on the box\'s word; the issue is offered no second time', async () => {
    const rec = recorder({ indentsData: readerWith('u-floor2', ['inventory.indent.read', 'inventory.movement.append']) });
    const page = await open(rec);
    await page.waitForFunction(rowsRendered, undefined, { timeout: 10_000 });
    await page.selectOption('#receive-issue', 'ind-2|is-1');
    await page.waitForSelector('#receive-lines li[data-product-id="RICE"] input.counted');
    await page.fill('#receive-lines li[data-product-id="RICE"] input.counted', '10');
    await page.click('#receive');
    await page.waitForSelector('#result:not([hidden])');
    expect((await page.textContent('#result-text')) ?? '').toContain('Count saved');
    // Handed to the box: exactly one FloorIndentReceived, the counter named, only what was counted.
    expect(await waitFor(() => rec.handed.length === 1)).toBe(true);
    expect(rec.handed[0]).toMatchObject({ key: 'indent-receipt:ind-2:is-1', event: { type: 'FloorIndentReceived', payload: { indentId: 'ind-2', issueId: 'is-1', receivedBy: 'u-floor2', counted: [{ productId: 'RICE', batchId: null, quantityMinor: 10 }], storeId: 'S1', source: 'indents-screen' } } });
    expect(rec.writes).toHaveLength(0); // nothing went to the cloud from the browser — the box carries it
    // The box's word makes it posted — the list says so in words.
    await page.waitForSelector('#saved li.saved[data-kind="receipt"][data-state="posted"]', { timeout: 10_000 });
    expect((await page.textContent('#saved li.saved .pill')) ?? '').toContain('Posted at head office');
    // The issue is no longer offered; the session refuses a second count of it.
    expect(await page.$$eval('#receive-issue option', (els) => els.length)).toBe(0);
    expect(await page.evaluate(() => (globalThis as unknown as IndentsWindow).indentsSession!.view('en').receivable)).toEqual([]);
    // A second look in Tamil says the same state in Tamil.
    await page.click('#lang');
    expect((await page.textContent('#saved li.saved .pill')) ?? '').toContain('தலைமை அலுவலகத்தில்');
  });

  it('a reader without the rights: with only the read right sees the register and no control; with none sees a plain not-permitted state', async () => {
    const readOnly = await open(recorder({ indentsData: readerWith('u-x', ['inventory.indent.read']) }));
    await readOnly.waitForFunction(rowsRendered, undefined, { timeout: 10_000 });
    expect(await readOnly.isHidden('#raiser')).toBe(true);
    expect(await readOnly.isHidden('#approver')).toBe(true);
    expect(await readOnly.isHidden('#receiver')).toBe(true);
    for (const id of ['no-request', 'no-approve', 'no-receive']) expect(((await readOnly.textContent(`#${id}`)) ?? '').length, id).toBeGreaterThan(0);

    const rec = recorder({ indentsData: readerWith('u-none', []), listStatus: 403 });
    const denied = await open(rec);
    await denied.waitForSelector('#state:not([hidden])');
    expect((await denied.textContent('#state-text')) ?? '').toContain('permission to see floor indents');
    expect(await denied.evaluate(() => (globalThis as unknown as IndentsWindow).document.querySelectorAll('#rows li.row').length)).toBe(0);
    expect(await denied.isHidden('#raiser')).toBe(true);
    expect(await denied.isHidden('#approver')).toBe(true);
    expect(await denied.isHidden('#receiver')).toBe(true);
  });
});
