import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { issueTillPins, pinOf, signInTill } from '../support/till-operator';
import { departmentOf } from '../../packages/migration/src/bpal-slice';
import type { EveningDayView } from '../../edge/store-edge/src/evening-check-box';

/**
 * **OB-800 (owner, 15 Nov 2026): no pilot department — the WHOLE store runs alongside Bpal, and the evening check compares
 * every department, on a REAL store computer, with the office PIN (OB-259).**
 *
 *   head office: the parallel-run terms only (the owner reconciles every day) — NO department slice applied, because there
 *   is no pilot department → the store computer pulls them → the till rings packed goods of two departments and a loose
 *   item WEIGHED on a verified scale (1.250 kg) → the owner maps the whole-shop reports (no department kept) and loads
 *   them: it is not refused "pilot department not known"; every department's totals are shown, and the whole store's;
 *   the weighed item agrees to the gram; an item Bpal sold that the new catalogue lacks is a difference → Bpal said
 *   1.240 kg: loaded again, the 10 g is its own difference (no tolerance invented), the earlier load is kept in the
 *   history → a manager is refused (only the named reconciler). Synthetic data only.
 */

const DAY = '2026-11-16';
const ON_DAY = new Date(`${DAY}T06:00:00.000Z`);
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const CASHIER = 'u-lanecash';
const ROLES = [
  { id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'migration.cleaning.read', 'pos.sale.sync', 'pos.return.process'] },
  { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'migration.cleaning.read', 'pos.sale.sync', 'pos.return.process', 'pos.return.approve'] },
  { id: 'cashier', name: 'Cashier', permissions: ['pos.sale.sync', 'pos.return.process'] },
];
const PEOPLE = [{ userId: OWNER, displayName: 'Owner Person', roleId: 'owner' }, { userId: MANAGER, displayName: 'Manager Person', roleId: 'store_manager' }, { userId: CASHIER, displayName: 'Lane Cashier', roleId: 'cashier' }];
// Each product's department is the one the Bpal load gives it from its HSN (OB-800's published table).
const GROCERY = departmentOf('1006')!; const CARE = departmentOf('3305')!; const LOOSE = departmentOf('0713', 'loose_kg')!;
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  migrationPolicy: { cutoverId: 'CUT-1', requiredCleanDays: 2 },
  weighingScales: [{ assetId: 'SCALE-1', laneIds: ['lane-1'], reverificationDueOn: '2099-12-31' }],
  products: [
    { productId: 'P1', name: 'Ponni rice 5kg', categoryId: GROCERY.categoryId, unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 500, status: 'active' },
    { productId: 'S1', name: 'Shampoo 180ml', categoryId: CARE.categoryId, unitPriceMinor: 15_000, uom: 'ea', barcodes: ['8900000000099'], availableMinor: 100, taxBps: 500, status: 'active' },
    { productId: 'L1', name: 'Loose toor dal', categoryId: LOOSE.categoryId, unitPriceMinor: 14_000, uom: 'kg', barcodes: [], availableMinor: 100_000, taxBps: 500, status: 'active' },
  ],
  people: PEOPLE,
  roles: ROLES,
  roleAssignments: PEOPLE.map((p) => ({ userId: p.userId, roleId: p.roleId, branchScope: ['store-1'] })),
};
const tax5 = (incl: number): number => incl - Math.round((incl * 10_000) / 10_500);
const rupees = (paise: number): string => `${Math.floor(paise / 100).toLocaleString('en-IN')}.${String(paise % 100).padStart(2, '0')}`;
const DAL = 17_500; // 1.250 kg × ₹140.00 / kg

/** Bpal's item-wise report for the WHOLE SHOP: every department, a loose item in kg to three decimals, an item not loaded. */
const itemWise = (dalKg = '1.250'): string => ['Item Code,Item Name,Dept,Qty,Net Amount,GST Amt,Bill Date',
  `8901234567890,Ponni rice 5kg,GROCERY,2,"${rupees(96_000)}",${rupees(tax5(96_000))},16/11/2026`,
  `S1,Shampoo 180ml,COSMETICS,1,${rupees(15_000)},${rupees(tax5(15_000))},16/11/2026`,
  `L1,Loose toor dal,LOOSE,${dalKg},${rupees(DAL)},${rupees(tax5(DAL))},16/11/2026`,
  `X-77,Agarbathi,POOJA,1,30.00,1.43,16/11/2026`].join('\r\n');
const billWise = (): string => ['Bill No,Date,Bill Amount',
  `OLD/301,16/11/2026,${rupees(96_000 + 15_000)}`,
  `OLD/302,16/11/2026,${rupees(DAL)}`,
  'OLD/303,16/11/2026,30.00'].join('\n');
const ITEM_MAPPING = { columns: { item_code: 'Item Code', quantity: 'Qty', value: 'Net Amount', tax: 'GST Amt', sale_date: 'Bill Date' }, dateOrder: 'dmy', valueIncludesTax: true };
const BILL_MAPPING = { columns: { bill_number: 'Bill No', bill_date: 'Date', bill_total: 'Bill Amount' }, dateOrder: 'dmy' };

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  vi.useRealTimers();
  globalThis.fetch = savedFetch;
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('OB-800 — the evening check compares the whole store, on the store computer', () => {
  it('no pilot department: every department and the whole store; a weighed item to the gram; a 10 g difference is its own line', async () => {
    const h: ApiHarness = apiHarness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    // Head office: the parallel-run terms only. No department slice is applied — there is no pilot department.
    expect((await h.request({ method: 'PUT', path: '/v1/migration/parallel-run/policy', userId: OWNER, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body: { cutoverId: 'CUT-1', dailyReconcilerUserId: OWNER, requiredCleanDays: 2, maxParallelDays: 14, startedOn: DAY } })).status).toBe(201);

    const dir = await mkdtemp(join(tmpdir(), 'sre-evening-whole-'));
    dirs.push(dir);
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify(PACK), 'utf8');
    await issueTillPins(dir, TEST_PACK_KEY, [OWNER, MANAGER, CASHIER]);
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(ON_DAY);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: join(dir, 'store-pack.json'), EDGE_OFFICE_SIGN_IN: 'pin',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }),
      EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1',
    }, () => {}))!;
    stops.push(() => edge.stop());
    await edge.refreshMigrationFeed!();

    // ── The day on the till: packed goods of two departments, and loose dal weighed on a verified scale.
    const till = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: edge.lane!.port, mirrorPilot: true, guestSalesOnly: true, laneScales: { known: true, scales: [{ assetId: 'SCALE-1', reverificationDueOn: '2099-12-31' }] } });
    await signInTill(till, CASHIER);
    const ring = async (lines: { productId: string; description: string; unitPriceMinor: number; qty: number; uom?: string }[], oldBill: string): Promise<string> => {
      for (const l of lines) till.scan(l);
      const r = await till.nextReceipt();
      expect(await till.tenderPaidOnOldErp(`S-${r}`, r, new Date().toISOString(), oldBill)).toBe(r);
      till.newSale();
      return r;
    };
    await ring([{ productId: 'P1', description: 'Ponni rice 5kg', unitPriceMinor: 48_000, qty: 2 }, { productId: 'S1', description: 'Shampoo 180ml', unitPriceMinor: 15_000, qty: 1 }], 'OLD/301');
    await ring([{ productId: 'L1', description: 'Loose toor dal', unitPriceMinor: 14_000, qty: 1_250, uom: 'kg' }], 'OLD/302');

    // ── The office screen, with the owner's own PIN.
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const signIn = async (userId: string): Promise<string> => {
      const res = await fetch(`${base}/office/sign-in`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ staffId: userId, pin: pinOf(userId), next: '/migration/' }).toString() });
      expect(res.status, `${userId} signs in`).toBe(303);
      return res.headers.get('set-cookie')!.split(';')[0]!;
    };
    const cookie = await signIn(OWNER);
    type Out = { ok: boolean; refusedBecause?: string; detail?: string; day?: EveningDayView };
    const door = async (path: string, body: unknown, who = cookie): Promise<{ status: number; out: Out }> => {
      const res = await fetch(`${base}/migration/evening-check/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: who }, body: JSON.stringify(body) });
      return { status: res.status, out: await res.json() as Out };
    };
    const page = await (await fetch(`${base}/migration/`, { headers: { cookie } })).text();
    expect(page).toContain('"eveningCheck":{"scope":"whole_store"');
    expect((await door('mapping', { report: 'item_wise', mapping: ITEM_MAPPING })).out).toMatchObject({ ok: true });
    expect((await door('mapping', { report: 'bill_wise', mapping: BILL_MAPPING })).out).toMatchObject({ ok: true });

    // ── Loaded: the whole store, never "pilot department not known".
    const loaded = await door('load', { businessDate: DAY, itemWise: itemWise(), billWise: billWise(), tolerance: { valueMinor: 0, taxMinor: 0 } });
    expect(loaded.out.ok, JSON.stringify(loaded.out)).toBe(true);
    const c = loaded.out.day!.current!.check;
    expect(c.scope).toBe('whole_store');
    expect(c.items.map((i) => [i.productId, i.uom, i.differs])).toEqual([['L1', 'kg', []], ['P1', 'ea', []], ['S1', 'ea', []]]);
    expect(c.items.find((i) => i.productId === 'L1')).toMatchObject({ old: { quantityMinor: 1250, valueMinor: DAL }, new: { quantityMinor: 1250, valueMinor: DAL } });
    expect(c.departments!.map((d) => [d.name, d.value.old, d.value.new])).toEqual([
      [GROCERY.name, 96_000, 96_000], [CARE.name, 15_000, 15_000], [LOOSE.name, DAL, DAL], ['Not in the new catalogue', 3000, 0],
    ]);
    expect(c.totals.value).toEqual({ old: 96_000 + 15_000 + DAL + 3000, new: 96_000 + 15_000 + DAL });
    expect(c.totals.quantity).toEqual([{ uom: 'ea', old: 3, new: 3 }, { uom: 'kg', old: 1250, new: 1250 }]);
    // Every old bill is rung on both: OLD/303 (the agarbathi) was not keyed — a difference, like the item.
    expect(c.totals.bills).toEqual({ old: { known: true, minor: 3 }, new: 2 });
    expect(loaded.out.day!.differences.map((d) => [d.area, d.subject ?? ''])).toEqual([
      ['sales_value', ''], ['tax', ''], ['sales_count', ''], ['item_not_in_catalogue', 'X-77'], ['bill_not_keyed', 'OLD/303'],
    ]);

    // ── Bpal said 1.240 kg: loaded again, the 10 g is its own difference — to the gram, no tolerance invented.
    const again = await door('load', { businessDate: DAY, itemWise: itemWise('1.240'), billWise: billWise(), tolerance: { valueMinor: 0, taxMinor: 0 } });
    expect(again.out.ok).toBe(true);
    const day = again.out.day!;
    expect(day.current!.comparisons).toEqual(expect.arrayContaining([
      { area: 'item_quantity', subject: 'L1', legacyValue: 1240, newValue: 1250, toleranceMinor: 0 },
      { area: 'stock_movement', subject: 'kg', legacyValue: 1240, newValue: 1250, toleranceMinor: 0 },
    ]));
    expect(day.current!.check.departments!.find((d) => d.categoryId === LOOSE.categoryId)).toMatchObject({ itemsDiffering: 1, quantity: [{ uom: 'kg', old: 1240, new: 1250 }] });
    expect(day.history.map((x) => x.current)).toEqual([false, true]);

    // ── Its permissions are unchanged: only the named reconciler, signed in with their own PIN.
    const manager = await signIn(MANAGER);
    expect(await door('load', { businessDate: DAY, itemWise: itemWise(), billWise: billWise() }, manager)).toMatchObject({ status: 403, out: { refusedBecause: 'not_the_named_reconciler' } });
  }, 120_000);
});
