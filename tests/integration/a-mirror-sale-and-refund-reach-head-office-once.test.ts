import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { PAID_ON_OLD_ERP_WORDS } from '../../packages/tender/src/paid-on-old-erp';
import { prepareTillBox, signInTill, managerApprovesOn, pinOf } from '../support/till-operator';

/**
 * **OB-256 · OB-258 (owner, 20 Oct 2026) — a mirror-pilot sale and its refund, "Paid on old system", from the till's own
 * model through a real store computer to head office: each reaches head office EXACTLY ONCE across a cold restart, the
 * cash-up expects NO drawer money from them, the day close is not held by them, and the books and reports show them as
 * their own line — never as cash, card or UPI — with the sale's GST worked out as for any bill.** In memory and, with
 * DATABASE_URL, on real PostgreSQL (there head office restarts too: a fresh process, fresh memory, the same database).
 *
 *   the box is set for the mirror pilot AND guest sales only → the cashier signs in and takes a ₹500 float →
 *   2 × dal at ₹105 (5% GST inside) "Paid on old system": saved on the box, no card attempt → it reaches head office →
 *   one dal comes back: the manager approves with their own PIN (the second-person rule as today), refunded "Paid on old
 *   system" → the line is cut; the box and head office both restart cold → the line returns: the refund arrives once; the
 *   sale relayed again is already banked → the blind count: ₹710 is ₹210 OVER (the box expected only the float), ₹500
 *   closes with no difference → next morning the day closes → the accountant posts the day book: `tender:paid_on_old_erp`
 *   and `refund:paid_on_old_erp`, no cash/card/UPI line, every journal balanced, the sale's CGST + SGST as for any bill.
 *
 * Synthetic data only (hard rule #7).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

/** Each backing: a head office, and that head office started again cold — on PostgreSQL a fresh process over the same database. */
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => h },
];
if (DATABASE_URL !== undefined) {
  const onPg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL, head office restarted cold', harness: onPg, restart: () => onPg() });
}

const PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }];
const PACK = {
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  // Every refund needs a second person (threshold 0) — the rule as today, unchanged by the mirror pilot.
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
};
const DAY_D = '2026-10-05';
const ON_DAY_D = new Date(`${DAY_D}T05:00:00.000Z`);
const NEXT_MORNING = new Date('2026-10-06T03:00:00.000Z');

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  vi.useRealTimers();
  globalThis.fetch = savedFetch;
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe.each(backings)('OB-256 · OB-258 — a mirror sale and its refund reach head office once — on $name', ({ harness, restart }) => {
  it('"Paid on old system": once at head office across a cold restart, no drawer money, the day closes, its own line in the books', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-lanecash', 'cashier');
    await h.provisionRole(T, 'u-acct', 'accountant');
    let online = true;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });

    const dir = await mkdtemp(join(tmpdir(), 'sre-mirror-ho-'));
    dirs.push(dir);
    const ready = await prepareTillBox({ dir, key: TEST_PACK_KEY, people: PEOPLE, pack: PACK });
    const startBox = async (): Promise<EdgeProcess> => {
      const edge = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
        EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }),
        // The mirror pilot AND guest sales only, both on the store computer (OB-256 · OB-252).
        EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1', ...ready,
      }, () => {}))!;
      stops.push(() => edge.stop());
      return edge;
    };
    const stopBox = async (edge: EdgeProcess): Promise<void> => { await edge.stop(); stops.splice(0); };

    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(ON_DAY_D);
    let edge = await startBox();
    let till = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: edge.lane!.port, mirrorPilot: true, guestSalesOnly: true });
    await signInTill(till, 'u-lanecash');
    const at = (): string => new Date().toISOString();
    expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: 50_000, at: at(), movementId: 'cm-float' })).toMatchObject({ committed: true });

    // ── The mirror sale: 2 × dal at ₹105, GST inside. Cash is refused before the disk; "Paid on old system" is saved.
    till.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 10_500, qty: 2 });
    const r1 = await till.nextReceipt();
    await expect(till.tenderCash(`S-${r1}`, r1, at())).rejects.toMatchObject({ laneMessage: PAID_ON_OLD_ERP_WORDS.saleNeedsIt });
    expect(await till.tenderPaidOnOldErp(`S-${r1}`, r1, at(), 'OLD/4471')).toBe(r1);
    till.newSale();
    const saleId = `S-${r1}`;
    const [onDisk] = (await readLog(edge.log.path)).map((r) => (r.ok ? JSON.parse(r.record) as Record<string, unknown> : {}));
    expect(onDisk).toMatchObject({ id: saleId, total: 21_000, taxMinor: 1_000, netMinor: 20_000, tenders: [{ kind: 'paid_on_old_erp', status: 'settled' }] });
    expect(onDisk!['customerRef']).toBeUndefined();
    expect((await edge.syncOnce!()).dead).toBe(0);
    expect((await call('GET', `/v1/sales/${saleId}`, 'u-owner')).body).toMatchObject({ saleId, banked: true });

    // ── The refund, rung on both (OB-258): the manager approves with their own PIN; back to "Paid on old system".
    const bill = (await till.lookupRefund(r1))!;
    expect(bill.sale).toMatchObject({ saleId, totalMinor: 21_000 });
    expect(bill.needsApproval(10_500)).toBe(true);
    const approval = await managerApprovesOn(till, 'u-mgr', { kind: 'refund', billRef: saleId, valueMinor: 10_500, reason: 'damaged' });
    const rn = await till.nextReceipt();
    const refunded = await bill.submit({
      returnId: `RT-${rn}`, number: rn, reasonCode: 'damaged',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
      refundMinor: 10_500, refundTender: 'paid_on_old_erp', approval,
    });
    expect(refunded).toMatchObject({ kind: 'settled', refundMinor: 10_500, laneMessage: PAID_ON_OLD_ERP_WORDS.refundDone });

    // ── The line is cut before it goes; the box and head office both restart cold.
    online = false;
    expect((await edge.syncOnce!()).sent).toBe(0);
    await stopBox(edge);
    h = restart(h);
    edge = await startBox();
    online = true;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });

    // ── Exactly once at head office: the refund once, the sale once — relayed again it is the same bill, already banked.
    expect(((await call('GET', `/v1/sales/${saleId}/returnable`, 'u-owner')).body as { refundableMinor: number }).refundableMinor).toBe(10_500);
    // (Under the store computer's own store-bound sign-in, as the box sends it — a fresh key, so only the bill can match.)
    const relayed = await h.raw({ method: 'POST', path: '/v1/sales', token: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), idempotencyKey: `again-${randomUUID()}`, body: toCloudSale(onDisk, 0, 'store-1', 'lane-1') });
    expect((relayed.body as { alreadyBanked?: boolean }).alreadyBanked, JSON.stringify([relayed.status, relayed.body])).toBe(true);
    const mix = (await call('GET', '/v1/reports/tender_mix', 'u-owner', undefined, { day: DAY_D })).body as { figures: { name: string; valueMinor?: number }[] };
    expect(mix.figures.find((f) => f.name === 'paid_on_old_erp')?.valueMinor).toBe(21_000); // once, never 42,000
    expect(mix.figures.map((f) => f.name)).not.toEqual(expect.arrayContaining(['cash']));
    expect(mix.figures.some((f) => f.name === 'card' || f.name === 'upi')).toBe(false);

    // ── The blind count: the box expected the float alone — ₹710 is ₹210 over; ₹500 closes with no difference.
    till = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: edge.lane!.port, mirrorPilot: true, guestSalesOnly: true });
    await signInTill(till, 'u-lanecash');
    expect(await till.till.close({ shiftId: 'sh-over', closedAt: at(), countedMinor: 71_000 })).toMatchObject({ closed: false, refusedBecause: 'material_variance_needs_a_reason', varianceMinor: 21_000 });
    expect(await till.till.close({ shiftId: 'sh-1', closedAt: at(), countedMinor: 50_000 })).toMatchObject({ closed: true, varianceMinor: 0 });
    expect((await edge.syncOnce!()).dead).toBe(0);

    // ── Next morning the day closes: nothing about "Paid on old system" holds it (no card/UPI attempt waits on it).
    vi.setSystemTime(NEXT_MORNING);
    await stopBox(edge);
    edge = await startBox();
    const closed = await edge.closeDay({ dayCloseId: `dc-${DAY_D}`, closedBy: 'u-mgr', closerPin: pinOf('u-mgr') });
    expect(closed, JSON.stringify(closed)).toMatchObject({ closed: true, tradingDay: DAY_D, locked: true });
    expect((await edge.syncOnce!()).dead).toBe(0);

    // ── The books: its own tender and refund lines, posted with the suggested map; the sale's GST as for any bill.
    expect((await call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP)).status).toBeLessThan(300);
    const posted = await call('POST', `/v1/finance/day-book/${DAY_D}/post`, 'u-acct');
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    const book = posted.body as { journals: { kind: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(book.exceptions).toEqual([]);
    expect(book.journals.map((j) => j.kind).sort()).toEqual(['refund:paid_on_old_erp', 'sale', 'sale_return', 'tender:paid_on_old_erp']);
    for (const j of book.journals) expect(j.lines.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0), j.kind).toBe(0);
    const lineOf = (kind: string, account: string) => book.journals.find((j) => j.kind === kind)!.lines.find((l) => l.accountCode === account);
    expect(lineOf('sale', 'gst_output_cgst')?.creditMinor).toBe(500);
    expect(lineOf('sale', 'gst_output_sgst')?.creditMinor).toBe(500);
    expect(lineOf('tender:paid_on_old_erp', 'paid_on_old_erp_clearing')?.debitMinor).toBe(21_000);
    expect(lineOf('refund:paid_on_old_erp', 'paid_on_old_erp_clearing')?.creditMinor).toBe(10_500);
    expect(JSON.stringify(book.journals)).not.toMatch(/cash_in_hand|card_receivable|upi_receivable/);
    // Only the accountant posts the books: a cashier is refused.
    expect((await call('POST', `/v1/finance/day-book/${DAY_D}/post`, 'u-lanecash')).status).toBe(403);
  }, 120_000);
});
