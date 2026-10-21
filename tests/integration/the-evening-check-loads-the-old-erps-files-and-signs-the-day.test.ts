import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { bootPos } from '../../apps/pos/src/browser-entry';
import { issueTillPins, managerApprovesOn, pinOf, signInTill } from '../support/till-operator';
import { dayDigestOf } from '../../packages/migration/src/parallel-day-sign';
import type { EveningDayView } from '../../edge/store-edge/src/evening-check-box';

/**
 * **OB-263 (owner, 21 Oct 2026, "Item-wise + bill-wise") — the evening check from the old ERP's two files, on a REAL store
 * computer with the office PIN (OB-259), relayed to head office — in memory and, with DATABASE_URL, on real PostgreSQL
 * with both the store computer and head office restarted cold.**
 *
 *   head office: the parallel-run terms (the owner reconciles every day, OB-254) and the department slice APPLIED (its
 *   department is the pilot's, MG-05) → the store computer pulls both → three mirror sales and one mirror refund rung on
 *   the till → the owner signs in with their own PIN and loads the two files: refused until the columns are mapped →
 *   maps each once, from the file's own header row (the mobile column is never chosen) → loads them: the differences are
 *   raised item by item and bill by bill (a sugar line short, an item not in the catalogue, an old bill not keyed, a bill
 *   number mistyped, the bill count, a credit note to explain), payments and loyalty not compared → signing is REFUSED,
 *   naming every one → a manager, nobody signed in, another site, another day's file: refused → the line is cut and both
 *   restart cold → a reason that says nothing is refused; real reasons on every one → signed, offline → the line comes
 *   back: head office has the day, each line with its subject and its reason, and the signature, sealed for the owner →
 *   the files are loaded again with a fix → the figures are replaced VISIBLY, the signature no longer applies, the history
 *   keeps both loads, the fresh differences need reasons afresh — at the store and at head office → the disk holds the
 *   figures, never the files: no phone number, no customer name. Synthetic data only.
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

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => h },
];
if (DATABASE_URL !== undefined) {
  const onPg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL, head office restarted cold', harness: onPg, restart: () => onPg() });
}

const DAY = '2026-10-21';
const ON_DAY = new Date(`${DAY}T06:00:00.000Z`);
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const CASHIER = 'u-lanecash'; const LOADER = 'u-loader';
const ROLES = [
  { id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'migration.cleaning.read', 'pos.sale.sync', 'pos.return.process'] },
  { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'migration.cleaning.read', 'pos.sale.sync', 'pos.return.process', 'pos.return.approve'] },
  { id: 'cashier', name: 'Cashier', permissions: ['pos.sale.sync', 'pos.return.process'] },
];
const PEOPLE = [{ userId: OWNER, displayName: 'Owner Person', roleId: 'owner' }, { userId: MANAGER, displayName: 'Manager Person', roleId: 'store_manager' }, { userId: CASHIER, displayName: 'Lane Cashier', roleId: 'cashier' }];
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  migrationPolicy: { cutoverId: 'CUT-1', requiredCleanDays: 2 },
  products: [
    { productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 10_500, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 500, status: 'active' },
    { productId: 'P3', name: 'Sugar 1kg', categoryId: 'grocery', unitPriceMinor: 4500, uom: 'ea', barcodes: ['8900000000003'], availableMinor: 100, taxBps: 500, status: 'active' },
    { productId: 'S1', name: 'Shampoo', categoryId: 'personal_care', unitPriceMinor: 9900, uom: 'ea', barcodes: ['8900000000099'], availableMinor: 100, taxBps: 1800, status: 'active' },
  ],
  people: PEOPLE,
  roles: ROLES,
  roleAssignments: PEOPLE.map((p) => ({ userId: p.userId, roleId: p.roleId, branchScope: ['store-1'] })),
};
const tax5 = (incl: number): number => incl - Math.round((incl * 10_000) / 10_500);
const rupees = (paise: number): string => `${Math.floor(paise / 100).toLocaleString('en-IN')}.${String(paise % 100).padStart(2, '0')}`;

/**
 * The old ERP's item-wise report for the WHOLE SHOP as Excel saves it: a title line, its own department column (OB-263 A),
 * a customer mobile column, Indian grouping, a total.
 */
const itemWise = (day = '21/10/2026', sugarQty = 2): string => ['\uFEFFSRE Hyper Market — Item wise sales 21/10/2026',
  'Item Code,Item Name,Dept,Customer Mobile,Qty,Net Amount,GST Amt,Bill Date',
  `P1,Toor dal 1kg,GROCERY,9876543210,2,"${rupees(21_000)}",${rupees(tax5(21_000))},${day}`,
  `8900000000003,Sugar 1kg,GROCERY,9123456780,${sugarQty},"${rupees(4500 * sugarQty)}",${rupees(tax5(4500 * sugarQty))},${day}`,
  `8900000000099,Shampoo,Personal Care,9988776655,1,99.00,15.10,${day}`,
  `X-999,Face cream,Personal Care,,1,250.00,38.14,${day}`,
  `X-404,Jaggery 500g,GROCERY,,1,50.00,2.38,${day}`,
  `Total,,,${sugarQty + 4},"${rupees(21_000 + 4500 * sugarQty + 9900 + 5000)}",,`].join('\r\n');
/**
 * The bill-wise list with each bill's items (semicolons — another Excel setting), the bill number on the first row only,
 * and the LINE values BEFORE TAX (OB-263 B): dal ₹210 with 5% is ₹200 before tax, sugar ₹45 is ₹42.86.
 */
const billWise = (withOld103 = true): string => ['Bill No;Date;Customer Name;Bill Amount;Item;Qty;Amount',
  'OLD/101;21/10/2026;Ravi Kumar;309.00;P1;2;200.00', ';;;;8900000000099;1;83.90',
  'OLD/102;21/10/2026;Meena;45.00;P3;1;42.86',
  ...(withOld103 ? ['OLD/103;21/10/2026;Arun;45.00;P3;1;42.86'] : []),
  'OLD/150;21/10/2026;Selvi;105.00;P1;1;100.00',
  'CN/9;21/10/2026;Ravi Kumar;-105.00;P1;-1;-100.00'].join('\n');
const ITEM_MAPPING = { columns: { item_code: 'Item Code', department: 'Dept', quantity: 'Qty', value: 'Net Amount', tax: 'GST Amt', sale_date: 'Bill Date' }, dateOrder: 'dmy', valueIncludesTax: true, pilotDepartmentValue: 'GROCERY' };
const BILL_MAPPING = { columns: { bill_number: 'Bill No', bill_date: 'Date', bill_total: 'Bill Amount', item_code: 'Item', quantity: 'Qty', line_value: 'Amount' }, dateOrder: 'dmy', lineValuesIncludeTax: false };
const REASON = 'one sugar was rung on the old till only while the new till was being restarted';

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  vi.useRealTimers();
  globalThis.fetch = savedFetch;
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe.each(backings)('OB-263 — the evening check from the old ERP\'s files, on the store computer, to head office — on $name', ({ harness, restart }) => {
  it('map once → load → differences → refused while unexplained → reasons → signed offline → relayed; a reload replaces the figures visibly', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    await h.provisionRole(T, LOADER, 'store_manager');
    let online = true;
    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
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
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });

    // ── Head office: the terms (the owner reconciles daily, OB-254) and the department slice, applied (MG-05).
    expect((await call('PUT', '/v1/migration/parallel-run/policy', OWNER, { cutoverId: 'CUT-1', dailyReconcilerUserId: OWNER, requiredCleanDays: 2, maxParallelDays: 14, startedOn: DAY })).status).toBe(201);
    const slice = { sliceDigest: 'slice-grocery-1', department: { categoryId: 'grocery', name: 'Grocery' }, counts: { 'products.csv': { rows: 2, staged: 2, quarantined: 0 } }, exceptions: [] };
    expect((await call('POST', '/v1/migration/loads/load-grocery', LOADER, slice)).status).toBe(201);
    expect((await call('POST', '/v1/migration/loads/load-grocery/exception-list/acceptance', OWNER, { sliceDigest: 'slice-grocery-1', statement: 'read the empty exception list for the grocery slice' })).status).toBeLessThan(300);
    expect((await call('POST', '/v1/migration/loads/load-grocery/applied', LOADER, { sliceDigest: 'slice-grocery-1', landed: { products: 2 }, failedSteps: 0 })).status).toBeLessThan(300);

    // ── The store computer, with the office PIN and the mirror pilot.
    const dir = await mkdtemp(join(tmpdir(), 'sre-evening-check-'));
    dirs.push(dir);
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify(PACK), 'utf8');
    await issueTillPins(dir, TEST_PACK_KEY, [OWNER, MANAGER, CASHIER]);
    const startBox = async (): Promise<EdgeProcess> => {
      const edge = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
        EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: join(dir, 'store-pack.json'), EDGE_OFFICE_SIGN_IN: 'pin',
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }),
        EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1',
      }, () => {}))!;
      stops.push(() => edge.stop());
      return edge;
    };
    const stopBox = async (edge: EdgeProcess): Promise<void> => { await edge.stop(); stops.splice(0); };
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(ON_DAY);
    let edge = await startBox();
    await edge.refreshMigrationFeed!();

    // ── The day on the till: three mirror sales, one mirror refund (OB-258).
    const till = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: edge.lane!.port, mirrorPilot: true, guestSalesOnly: true });
    await signInTill(till, CASHIER);
    const at = (): string => new Date().toISOString();
    const ring = async (lines: { productId: string; description: string; unitPriceMinor: number; qty: number }[], oldBill: string): Promise<string> => {
      for (const l of lines) till.scan(l);
      const r = await till.nextReceipt();
      expect(await till.tenderPaidOnOldErp(`S-${r}`, r, at(), oldBill)).toBe(r);
      till.newSale();
      return r;
    };
    const dal = { productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 10_500 };
    const sugar = { productId: 'P3', description: 'Sugar 1kg', unitPriceMinor: 4500 };
    await ring([{ ...dal, qty: 2 }], 'OLD/101');
    await ring([{ ...sugar, qty: 1 }], 'OLD/102');
    const mistyped = await ring([{ ...dal, qty: 1 }], 'OLD/105');
    const bill = (await till.lookupRefundByOldBill('OLD/101'))!;
    const approval = await managerApprovesOn(till, MANAGER, { kind: 'refund', billRef: bill.sale.saleId, valueMinor: 10_500, reason: 'damaged' });
    const rn = await till.nextReceipt();
    expect(await bill.submit({ returnId: `RT-${rn}`, number: rn, reasonCode: 'damaged', lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }], refundMinor: 10_500, refundTender: 'paid_on_old_erp', approval })).toMatchObject({ kind: 'settled' });

    // ── The office screen's doors: the owner's own PIN, from a page this box served.
    const base = (): string => `http://127.0.0.1:${edge.screens!.port}`;
    const signIn = async (userId: string): Promise<string> => {
      const res = await fetch(`${base()}/office/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ staffId: userId, pin: pinOf(userId), next: '/migration/' }).toString() });
      expect(res.status, `${userId} signs in`).toBe(303);
      return res.headers.get('set-cookie')!.split(';')[0]!;
    };
    let cookie = await signIn(OWNER);
    type Out = { ok: boolean; refusedBecause?: string; detail?: string; problems?: string[]; day?: EveningDayView; relayed?: boolean };
    const door = async (path: string, body?: unknown, who: string | null = cookie, extra: Record<string, string> = {}): Promise<{ status: number; out: Out }> => {
      const res = await fetch(`${base()}/migration/evening-check/${path}`, body === undefined
        ? { headers: who === null ? {} : { cookie: who } }
        : { method: 'POST', headers: { 'content-type': 'application/json', ...(who === null ? {} : { cookie: who }), ...extra }, body: JSON.stringify(body) });
      return { status: res.status, out: await res.json() as Out };
    };
    const load = (item = itemWise(), bills = billWise()) => door('load', { businessDate: DAY, itemWise: item, billWise: bills, tolerance: { valueMinor: 0, taxMinor: 0 } });

    // The page carries the pilot department from head office's register, and the evening check is offered.
    const page = await (await fetch(`${base()}/migration/`, { headers: { cookie } })).text();
    expect(page).toContain('"eveningCheck":{"department":{"categoryId":"grocery","name":"Grocery"}');

    // Not mapped yet: refused, in words.
    expect((await load()).out).toMatchObject({ ok: false, refusedBecause: 'no_mapping', detail: expect.stringContaining('Map the columns first') });
    // A mapping the file cannot satisfy is refused; then each report is mapped once from its own header row.
    expect((await door('mapping', { report: 'item_wise', mapping: { ...ITEM_MAPPING, valueIncludesTax: undefined }, header: ['Item Code', 'Qty'] })).out).toMatchObject({ ok: false, refusedBecause: 'mapping_refused' });
    expect((await door('mapping', { report: 'item_wise', mapping: ITEM_MAPPING, header: ['Item Code', 'Item Name', 'Dept', 'Customer Mobile', 'Qty', 'Net Amount', 'GST Amt', 'Bill Date'] })).out).toMatchObject({ ok: true, mapping: { setBy: OWNER, mapping: { pilotDepartmentValue: 'GROCERY' } } });
    // OB-263 A · B: a department column with no pilot value, and item lines with no tax answer, are refused.
    expect((await door('mapping', { report: 'item_wise', mapping: { ...ITEM_MAPPING, pilotDepartmentValue: undefined } })).out).toMatchObject({ ok: false, problems: [expect.stringContaining('which value of the department column')] });
    expect((await door('mapping', { report: 'bill_wise', mapping: { ...BILL_MAPPING, lineValuesIncludeTax: undefined } })).out).toMatchObject({ ok: false, problems: [expect.stringContaining('already include the tax')] });
    expect((await door('mapping', { report: 'bill_wise', mapping: BILL_MAPPING, header: ['Bill No', 'Date', 'Customer Name', 'Bill Amount', 'Item', 'Qty', 'Amount'] })).out).toMatchObject({ ok: true });

    // Another day's report is refused whole; nobody signed in, another site, a manager — each refused.
    expect((await load(itemWise('20/10/2026'))).out).toMatchObject({ ok: false, refusedBecause: 'wrong_day', problems: [expect.stringContaining('not 2026-10-21')] });
    expect((await door('load', {}, null)).status).toBe(401);
    expect((await door('load', {}, cookie, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const managerCookie = await signIn(MANAGER);
    expect(await door('load', { businessDate: DAY, itemWise: itemWise(), billWise: billWise() }, managerCookie)).toMatchObject({ status: 403, out: { refusedBecause: 'not_the_named_reconciler' } });

    // ── Loaded: the differences, item by item and bill by bill.
    const loaded = await load();
    expect(loaded.out.ok, JSON.stringify(loaded.out)).toBe(true);
    const day = loaded.out.day!;
    const c = day.current!.check;
    expect(c.department).toEqual({ categoryId: 'grocery', name: 'Grocery' });
    expect(c.items.map((i) => [i.productId, i.differs])).toEqual([['P1', []], ['P3', ['quantity', 'value', 'tax']]]);
    // OB-263 A: the file's own department column kept the pilot department; the other department's rows (one of them not
    // in the new catalogue at all) are set aside — counted and said — and never become differences.
    expect(day.current!.files.itemWise.department).toEqual({ pilotValue: 'GROCERY', otherDepartmentRows: 2, noDepartmentRows: 0 });
    expect(c.otherDepartments).toEqual({ rows: 0, valueMinor: 0 });
    // OB-263 B: the bill lines are before tax, so both sides are compared without tax — and OLD/101, OLD/102 agree.
    expect(c.bills).toMatchObject({ checked: 'lines', valueBasis: 'without_tax', valueNotKnown: 0, matched: 2 });
    expect(c.notInCatalogue.map((x) => x.code)).toEqual(['X-404']);
    expect(c.totals.bills).toEqual({ old: { known: true, minor: 4 }, new: 3 });
    expect(c.bills.differences.map((b) => [b.billNumber, b.kind])).toEqual([['OLD/103', 'not_keyed'], ['OLD/150', 'not_keyed'], ['OLD/105', 'not_on_old']]);
    expect(c.explain.map((e) => e.subject)).toEqual(['bill:CN/9']);
    expect(c.notCompared.map((x) => x.area)).toEqual(['payments', 'loyalty']);
    expect(day.differences.map((d) => [d.area, d.subject ?? ''])).toEqual([
      ['sales_value', ''], ['tax', ''], ['sales_count', ''], ['stock_movement', 'ea'],
      ['item_quantity', 'P3'], ['item_value', 'P3'], ['item_tax', 'P3'], ['item_not_in_catalogue', 'X-404'],
      ['bill_not_keyed', 'OLD/103'], ['bill_not_keyed', 'OLD/150'], ['bill_not_on_old', 'OLD/105'], ['old_return', 'bill:CN/9'],
    ]);
    expect(c.bills.differences.find((b) => b.kind === 'not_on_old')!.newBill).toBe(mistyped);

    // Signing is REFUSED while any has no reason — and the refusal names every one.
    const early = await door('sign', { businessDate: DAY, statement: 'compared both old reports with the new till, line by line' });
    expect(early).toMatchObject({ status: 422, out: { ok: false, refusedBecause: 'unexplained_material_difference' } });
    expect(early.out.problems).toHaveLength(12);
    expect(early.out.problems).toEqual(expect.arrayContaining([expect.stringContaining('bill not on old · OLD/105')]));

    // ── The line is cut; both restart cold. Everything is on the store computer's own disk.
    online = false;
    await stopBox(edge);
    h = restart(h);
    edge = await startBox();
    cookie = await signIn(OWNER);
    const back = (await door(`day?date=${DAY}`)).out as Out & { day: EveningDayView };
    expect(back.day.differences).toHaveLength(12);
    expect(back.day.newTillChangedSinceLoad).toBe(false);

    // A reason that says nothing is refused; then a real reason on every difference; then signed — all offline.
    expect((await door('reasons', { businessDate: DAY, reasons: [{ differenceId: day.differences[0]!.differenceId, explanation: 'ok' }] })).out).toMatchObject({ ok: false, refusedBecause: 'reason_says_nothing' });
    const explained = await door('reasons', { businessDate: DAY, reasons: day.differences.map((d) => ({ differenceId: d.differenceId, explanation: `${REASON} (${d.area})`, wrongSide: 'new' })) });
    expect(explained.out).toMatchObject({ ok: true, day: { unexplained: [] } });
    expect((await door('sign', { businessDate: DAY, statement: 'ok' })).out).toMatchObject({ ok: false, refusedBecause: 'statement_says_nothing' });
    const signed = await door('sign', { businessDate: DAY, statement: 'compared both old reports with the new till, line by line, bill by bill' });
    expect(signed.out).toMatchObject({ ok: true, relayed: true, day: { signature: { signedBy: OWNER, dayDigest: day.current!.dayDigest } } });
    expect((await door('sign', { businessDate: DAY, statement: 'compared both old reports with the new till, again' })).out).toMatchObject({ ok: false, refusedBecause: 'already_signed' });

    // ── The line comes back: head office has the day, each line with its subject and its reason, and the signature.
    online = true;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    const feed = (await call('GET', '/v1/migration/screen', OWNER)).body as {
      parallelDays: { businessDate: string; comparisons: { area: string; subject?: string }[] }[];
      parallelDifferences: { businessDate: string; area: string; subject?: string; status: string; explanation?: string; ownerUserId?: string }[];
      parallelDaySignatures: { businessDate: string; signedBy: string; stillApplies: boolean; dayDigest: string }[];
      refusedDecisions: unknown[]; pilotDepartment: { categoryId: string };
    };
    expect(feed.refusedDecisions).toEqual([]);
    expect(feed.pilotDepartment).toMatchObject({ categoryId: 'grocery', name: 'Grocery', loadId: 'load-grocery' });
    const cloudDay = feed.parallelDays.find((d) => d.businessDate === DAY)!;
    expect(dayDigestOf(cloudDay.comparisons as never)).toBe(day.current!.dayDigest);
    const cloudDiffs = feed.parallelDifferences.filter((d) => d.businessDate === DAY);
    expect(cloudDiffs.map((d) => [d.area, d.subject ?? '', d.status, d.ownerUserId])).toEqual(day.differences.map((d) => [d.area, d.subject ?? '', 'resolved', OWNER]));
    expect(cloudDiffs.find((d) => d.subject === 'OLD/105')!.explanation).toBe(`${REASON} (bill_not_on_old)`);
    expect(feed.parallelDaySignatures).toEqual([expect.objectContaining({ businessDate: DAY, signedBy: OWNER, stillApplies: true })]);

    // ── Loaded again, with a fix (OLD/103 was another day's bill): the figures are replaced VISIBLY; the signature over
    // the old figures no longer applies; the history keeps both loads; the fresh differences need reasons afresh.
    const again = await load(itemWise(), billWise(false));
    expect(again.out.ok).toBe(true);
    const now = again.out.day!;
    expect(now.signature).toBeUndefined();
    expect(now.voidedSignatures).toEqual([expect.objectContaining({ signedBy: OWNER, dayDigest: day.current!.dayDigest })]);
    expect(now.history.map((x) => [x.current, x.signedBy ?? null])).toEqual([[false, OWNER], [true, null]]);
    expect(now.unexplained.length).toBe(now.differences.length);
    expect(now.differences.some((d) => d.subject === 'OLD/103')).toBe(false);
    expect(now.differences[0]!.differenceId).toMatch(/^PD-[0-9a-f]{8}-2026-10-21-001$/);
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    const feed2 = (await call('GET', '/v1/migration/screen', OWNER)).body as typeof feed;
    expect(feed2.parallelDaySignatures).toEqual([expect.objectContaining({ businessDate: DAY, stillApplies: false })]);
    const current = feed2.parallelDifferences.filter((d) => d.businessDate === DAY);
    expect(current.map((d) => [d.area, d.subject ?? '', d.status])).toEqual(now.differences.map((d) => [d.area, d.subject ?? '', 'open']));
    expect(feed2.refusedDecisions).toEqual([]);
    const sig = await call('POST', `/v1/migration/parallel-run/days/${DAY}/signature`, OWNER, { statement: 'compared both old reports with the new till, line by line' });
    expect((sig.body as { error?: { code?: string } }).error?.code).toBe('unexplained_material_difference');

    // ── The disk holds the figures, never the files: no customer's phone number or name anywhere on it.
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.log')) continue;
      const text = await readFile(join(dir, f), 'utf8');
      for (const personal of ['9876543210', '9123456780', '9988776655', 'Ravi Kumar', 'Meena', 'Selvi', 'Customer Mobile']) expect(text, `${f} holds ${personal}`).not.toContain(personal);
    }
    const evening = (await readLog(join(dir, 'evening-check.log'))).map((r) => (r.ok ? JSON.parse(r.record) as { kind: string } : { kind: 'unreadable' }));
    expect(evening.map((r) => r.kind)).toEqual(['mapping_set', 'mapping_set', 'day_loaded', 'reasons_given', 'day_signed', 'day_loaded']);
  }, 180_000);

  it('a store computer that asks no office PIN cannot tell who is loading, so it saves nothing; off the mirror pilot the doors are shut', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-evening-nogate-'));
    dirs.push(dir);
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify({ ...PACK, migrationPolicy: { ...PACK.migrationPolicy, dailyReconcilerUserId: OWNER } }), 'utf8');
    const boxWith = async (mirror: boolean): Promise<string> => {
      const edge = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-nogate', PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
        EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: join(dir, 'store-pack.json'), ...(mirror ? { EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1' } : {}),
      }, () => {}))!;
      stops.push(() => edge.stop());
      return `http://127.0.0.1:${edge.screens!.port}`;
    };
    const base = await boxWith(true);
    const res = await fetch(`${base}/migration/evening-check/mapping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report: 'item_wise', mapping: ITEM_MAPPING }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, refusedBecause: 'no_sign_in', detail: expect.stringContaining('Nothing was saved') });
    expect((await readLog(join(dir, 'evening-check.log')))).toEqual([]);
    for (const s of stops.splice(0).reverse()) await s();
    const off = await boxWith(false);
    expect((await fetch(`${off}/migration/evening-check/day?date=${DAY}`)).status).toBe(404);
  }, 60_000);
});
