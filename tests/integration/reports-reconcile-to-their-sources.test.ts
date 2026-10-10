import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startRealCloud, type RealCloud } from '../support/real-store';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';
import { TEST_IDP } from '../support/api-harness';

/**
 * **Every head-office report equals the sum of the source records behind it — on the REAL API over REAL PostgreSQL
 * (audit EA-06 · EA-02 · EA-01 · M29-FR-01/02 · D13).**
 *
 * The source transactions are built through the production routes a shop uses — the catalogue publish, opening stock on
 * the stock ledger, loyalty enrolment, sales posted by the till's sync identity (one paid card + cash), purchase orders
 * raised by the buyer — and then every store-core report is read through `GET /v1/reports/:name` and asserted to be
 * EXACTLY the sum of those sources, to the paisa: sales by day, by tender (split by amount), by cashier, by department,
 * stock on hand (against the inventory engine's own valuation route), purchases by supplier, and the loyalty liability
 * (against the points ledger's own balance route). A branch-limited manager sees only their branch; an unknown report is
 * refused, and a report this version cannot produce is refused by name — never answered with the dashboard's figures.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run. Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

const KEY = ['reports', 'reconcile', 'signing', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner';
const CASHIER = 'u-cash';
const MANAGER = 'u-mgr';
const S2_MANAGER = 'u-mgr-s2';
const MOBILE = '98400 55555';
const MEMBER = memberRefFor(loyaltyMemberKey(KEY), MOBILE)!;

interface Reply { status: number; body: unknown }
interface Fig { name: string; valueMinor?: number; asAt: string | null; staleness: string; notAvailableBecause?: string }
interface Report { figures: Fig[]; rows: Record<string, string>[]; sources: { source: string; lastEventAt: string | null }[]; asAt: string | null; readAt: string; tradingDay?: string }

describeOrSkip('head-office reports reconcile to their source records — real API, real PostgreSQL (EA-06 · EA-02 · EA-01)', () => {
  let cloud: RealCloud;
  const today = new Date().toISOString().slice(0, 10);
  const at = (hhmm: string): string => `${today}T${hhmm}:00.000Z`;
  /** Sales are rung a little in the past, so none is "from the future" against the read. */
  const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Reply> =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  const ok = async (p: Promise<Reply>, ...statuses: number[]): Promise<Reply> => {
    const r = await p;
    expect(statuses, JSON.stringify(r.body)).toContain(r.status);
    return r;
  };
  const report = async (name: string, userId = OWNER, query = ''): Promise<Report> =>
    (await ok(call('GET', `/v1/reports/${name}${query}`, userId), 200)).body as Report;
  /** A request signed in AT a branch — the way a branch manager's sign-in carries it (§28). */
  const atBranch = async (userId: string, branchId: string, path: string): Promise<Reply> => {
    const res = await fetch(`${cloud.baseUrl}${path}`, { headers: { authorization: `Bearer ${TEST_IDP.issue({ sub: userId, tenantId: cloud.tenantId, branchId })}` } });
    return { status: res.status, body: await res.json() as unknown };
  };
  const fig = (r: Report, name: string): number | undefined => r.figures.find((f) => f.name === name)?.valueMinor;

  // ── The sources ────────────────────────────────────────────────────────────────────────────────────────────────
  const SALES = [
    // ₹550 at S1: one rice at ₹480 and two milk at ₹35 — paid ₹500 card + ₹50 cash, by a loyalty member (rung after
    // they joined, so it earns).
    { saleId: `A-${randomUUID()}`, locationId: 'S1', mins: 0, lines: [['P-RICE', 1, 48_000], ['P-MILK', 2, 3_500]] as const, tenders: [['card', 50_000], ['cash', 5_000]] as const, member: true },
    // ₹105 at S1: three milk, UPI.
    { saleId: `B-${randomUUID()}`, locationId: 'S1', mins: 20, lines: [['P-MILK', 3, 3_500]] as const, tenders: [['upi', 10_500]] as const, member: false },
    // ₹480 at S2: one rice, cash.
    { saleId: `C-${randomUUID()}`, locationId: 'S2', mins: 10, lines: [['P-RICE', 1, 48_000]] as const, tenders: [['cash', 48_000]] as const, member: false },
  ];
  const totalOf = (s: (typeof SALES)[number]): number => s.lines.reduce((t, [, q, p]) => t + q * p, 0);

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(MANAGER, 'store_manager');
    // A manager of ONE branch (S2) — asked for by u-hr, approved by the owner (two acts, PA-03).
    const gid = `grant-${S2_MANAGER}`;
    await ok(call('POST', '/v1/identity/grants', 'u-hr', { grantId: gid, userId: S2_MANAGER, roleId: 'store_manager', branchScope: ['S2'], reason: 'S2 only' }, `${gid}-ask`), 202);
    await ok(call('POST', `/v1/identity/grants/${gid}/approve`, OWNER, {}, `${gid}-approve`), 201);

    await ok(call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' }, 'tz'), 200);
    await ok(call('PUT', '/v1/platform/setup/loyalty.points_per_100_inr', OWNER, { value: 1 }, 'loy-rate'), 200);
    await ok(call('PUT', '/v1/platform/setup/loyalty.point_value_paise', OWNER, { value: 50 }, 'loy-value'), 200);

    // The product master: two products in two departments.
    for (const [id, sku, name, dept] of [['P-RICE', 'RICE-5', 'Rice 5kg', 'grocery'], ['P-MILK', 'MILK-500', 'Milk 500ml', 'dairy']] as const) {
      await ok(call('POST', `/v1/catalogue/products/${id}/publish`, OWNER, {
        product: { sku, name, baseUom: 'ea', primaryCategoryId: dept, taxClass: '1006', lifecycle: 'active' },
        categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }, { categoryId: 'dairy', name: 'Dairy', parentId: null }],
      }, `publish-${id}`), 200, 201);
    }
    // Opening stock on the stock ledger, at cost.
    for (const [mv, product, loc, qty, cost] of [['mv-r1', 'P-RICE', 'S1', 10, 40_000], ['mv-m1', 'P-MILK', 'S1', 20, 3_000], ['mv-r2', 'P-RICE', 'S2', 5, 40_000]] as const) {
      await ok(call('POST', '/v1/inventory/movements', OWNER, {
        movementId: mv, productId: product, locationId: loc, kind: 'received', quantityMinor: qty, uom: 'ea',
        occurredAt: at('00:30'), enteredBy: OWNER, unitCostMinor: cost,
      }, mv), 202);
    }
    // A loyalty member, enrolled at the desk with consent and a checked number.
    await ok(call('POST', '/v1/loyalty/members', MANAGER, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' }, 'enrol'), 201);
    // The day's sales, posted by the till's sync identity.
    for (const s of SALES) {
      await ok(call('POST', '/v1/sales', CASHIER, {
        saleId: s.saleId, receiptNumber: `R-${s.saleId}`, laneId: `lane-${s.locationId}`, locationId: s.locationId, cashierId: CASHIER,
        tradingDay: today, committedAt: minutesAgo(s.mins), totalMinor: totalOf(s), currency: 'INR', packVersion: 1,
        lines: s.lines.map(([productId, q, p]) => ({ productId, quantityMinor: q, uom: 'ea', unitPriceMinor: p, lineTotalMinor: q * p })),
        tenders: s.tenders.map(([kind, amountMinor]) => ({ kind, amountMinor })),
        ...(s.member ? { customerRef: MEMBER } : {}),
      }, `sale-${s.saleId}`), 202);
    }
    // Purchase orders raised for two suppliers.
    for (const [po, supplier, product, qty, cost] of [['PO-1', 'SUP-A', 'P-RICE', 10, 40_000], ['PO-2', 'SUP-B', 'P-MILK', 50, 3_000], ['PO-3', 'SUP-A', 'P-MILK', 10, 3_000]] as const) {
      await ok(call('POST', `/v1/purchase/orders/${po}`, OWNER, { supplierId: supplier, lines: [{ productId: product, orderedQty: qty, unitCost: { minor: cost, currency: 'INR' } }] }, `po-${po}`), 201);
    }
  }, 120_000);
  afterAll(async () => { await cloud?.stop(); });

  it('sales by day = Σ bills; by tender = Σ each payment by kind (split by amount); by cashier and by department reconcile', async () => {
    const takings = SALES.reduce((t, s) => t + totalOf(s), 0); // 55,000 + 10,500 + 48,000 paise
    expect(takings).toBe(113_500);

    const byDay = await report('sales_by_day');
    expect(fig(byDay, 'Taken')).toBe(takings);
    expect(fig(byDay, 'Bills')).toBe(SALES.length);
    expect(byDay.rows.reduce((t, r) => t + Number(r['totalMinor']), 0)).toBe(takings);
    expect(byDay.tradingDay).toBe(today);

    const tenders = await report('tender_mix');
    const expected: Record<string, number> = {};
    for (const s of SALES) for (const [k, a] of s.tenders) expected[k] = (expected[k] ?? 0) + a;
    expect(expected).toEqual({ card: 50_000, cash: 53_000, upi: 10_500 });
    for (const [kind, minor] of Object.entries(expected)) expect(fig(tenders, kind)).toBe(minor);
    expect(tenders.figures.reduce((t, f) => t + (f.valueMinor ?? 0), 0)).toBe(takings);
    expect(tenders.rows.find((r) => r['key'] === 'cash')?.['bills']).toBe('2');

    const cashiers = await report('sales_by_cashier');
    expect(fig(cashiers, CASHIER)).toBe(takings);

    const depts = await report('units_by_category');
    expect(fig(depts, 'grocery')).toBe(2 * 48_000);
    expect(fig(depts, 'dairy')).toBe(5 * 3_500);
    expect(depts.figures.reduce((t, f) => t + (f.valueMinor ?? 0), 0)).toBe(takings);
    expect(depts.rows.find((r) => r['department'] === 'dairy')?.['units']).toBe('5');

    // The dashboard agrees with the reports, and its tender figures add back to its takings (EA-02).
    const dash = (await ok(call('GET', '/v1/reports/dashboard', OWNER), 200)).body as Report;
    expect(fig(dash, 'Sales today')).toBe(takings);
    expect(dash.figures.filter((f) => f.name.startsWith('Sales today — ') && f.name !== 'Sales today — receipts')
      .reduce((t, f) => t + (f.valueMinor ?? 0), 0)).toBe(takings);
  });

  it('every figure is as at its source (EA-01): the newest sale from each store, not the read time', async () => {
    const byDay = await report('sales_by_day');
    expect(byDay.sources.map((s) => s.source).sort()).toEqual(['store:S1', 'store:S2']);
    for (const s of byDay.sources) expect(s.lastEventAt).not.toBeNull();
    // The figure is as current as the STALEST store (S2's only sale was rung 10 minutes ago; S1's newest just now).
    const s2 = byDay.sources.find((s) => s.source === 'store:S2')!.lastEventAt!;
    const s1 = byDay.sources.find((s) => s.source === 'store:S1')!.lastEventAt!;
    expect(Date.parse(s2)).toBeLessThan(Date.parse(s1));
    expect(byDay.figures.find((f) => f.name === 'Taken')?.asAt).toBe(s2);
    expect(byDay.asAt).toBe(s2);
    expect(Date.parse(byDay.readAt)).toBeGreaterThan(Date.parse(s2));
  });

  it('stock on hand = the inventory engine\'s own valuation, and = Σ received − Σ sold at cost', async () => {
    const stock = await report('stock_on_hand');
    // S1 rice 10 − 1 = 9 × ₹400; S1 milk 20 − 5 = 15 × ₹30; S2 rice 5 − 1 = 4 × ₹400.
    const bySource = 9 * 40_000 + 15 * 3_000 + 4 * 40_000;
    expect(fig(stock, 'Value on hand')).toBe(bySource);
    const valuation = (await ok(call('GET', '/v1/inventory/valuation', OWNER), 200)).body as { rows: { onHandMinor: number; value: { minor: number } }[] };
    expect(valuation.rows.filter((r) => r.onHandMinor !== 0).reduce((t, r) => t + r.value.minor, 0)).toBe(bySource);
    expect(stock.rows.reduce((t, r) => t + Number(r['valueMinor']), 0)).toBe(bySource);
    expect(stock.rows.find((r) => r['productId'] === 'P-MILK' && r['locationId'] === 'S1')?.['onHandMinor']).toBe('15');
  });

  it('purchases by supplier = Σ ordered value per supplier on the order register', async () => {
    const purchases = await report('purchases_by_supplier');
    expect(fig(purchases, 'SUP-A')).toBe(10 * 40_000 + 10 * 3_000);
    expect(fig(purchases, 'SUP-B')).toBe(50 * 3_000);
    expect(purchases.rows.find((r) => r['supplierId'] === 'SUP-A')?.['orders']).toBe('2');
  });

  it('the loyalty liability = the points ledger\'s own balance × the owner\'s point value', async () => {
    const loyalty = await report('loyalty');
    const balance = ((await ok(call('GET', `/v1/customers/${MEMBER}/points`, OWNER), 200)).body as { pointsBalance: number }).pointsBalance;
    expect(balance).toBe(5); // ₹550 at 1 point per ₹100, whole points
    expect(fig(loyalty, 'Points outstanding')).toBe(balance);
    expect(fig(loyalty, 'What the points are worth')).toBe(balance * 50);
    expect(fig(loyalty, 'Members')).toBe(1);
  });

  it('a branch-limited manager sees only their branch, and cannot ask for another', async () => {
    const mine = (await ok(atBranch(S2_MANAGER, 'S2', '/v1/reports/sales_by_day'), 200)).body as Report;
    expect(fig(mine, 'Taken')).toBe(48_000);
    expect(fig(mine, 'Bills')).toBe(1);
    expect(mine.sources.map((s) => s.source)).toEqual(['store:S2']);
    const other = await atBranch(S2_MANAGER, 'S2', '/v1/reports/sales_by_day?scope=S1');
    expect(other.status).toBe(403);
    // The company-wide registers are not shown in part to a branch reader — they are refused in words.
    const loyalty = (await ok(atBranch(S2_MANAGER, 'S2', '/v1/reports/loyalty'), 200)).body as Report;
    expect(loyalty.figures[0]?.valueMinor).toBeUndefined();
    expect(loyalty.figures[0]?.notAvailableBecause).toMatch(/company-wide/);
  });

  it('a governed drill (EA-05) reaches the exact source bills behind a figure — loaded by head office, never sent', async () => {
    const cash = await ok(call('POST', '/v1/reporting/drill/governed', OWNER, { reportId: 'tender_mix', figure: 'cash' }, 'drill-cash'), 200);
    const body = cash.body as { provenance: string; reconciles: boolean; kpiValueMinor: number; shownTotalMinor: number; transactions: { transactionId: string; amountMinor: number }[] };
    expect(body.provenance).toBe('governed');
    expect(body.reconciles).toBe(true);
    expect(body.kpiValueMinor).toBe(53_000);
    // The split bill's ₹50 cash part and the ₹480 cash bill — the very sales posted, by their own ids.
    expect(body.transactions.map((t) => [t.transactionId, t.amountMinor]).sort()).toEqual(
      [[SALES[0]!.saleId, 5_000], [SALES[2]!.saleId, 48_000]].sort(),
    );
    const dairy = (await ok(call('POST', '/v1/reporting/drill/governed', OWNER, { reportId: 'units_by_category', figure: 'dairy' }, 'drill-dairy'), 200)).body as { reconciles: boolean; shownTotalMinor: number; transactions: unknown[] };
    expect(dairy).toMatchObject({ reconciles: true, shownTotalMinor: 5 * 3_500 });
    expect(dairy.transactions).toHaveLength(2); // the two milk lines
    // The drill is logged with who reached what.
    const audits = (await ok(call('GET', '/v1/reporting/drill-audits', OWNER), 200)).body as { audits: { userId: string; metric: string; reconciled: boolean }[] };
    expect(audits.audits.map((a) => a.metric)).toEqual(expect.arrayContaining(['tender_mix:cash', 'units_by_category:dairy']));
    // A figure with no records behind it is refused, and nothing the caller sends can stand in for head office's rows.
    expect((await call('POST', '/v1/reporting/drill/governed', OWNER, { reportId: 'tender_mix', figure: 'cheque' }, 'drill-x')).status).toBe(404);
    const forged = await call('POST', '/v1/reporting/drill/governed', OWNER, { reportId: 'tender_mix', figure: 'cash', kpiValueMinor: 1, transactions: [] }, 'drill-forged');
    expect((forged.body as { kpiValueMinor: number }).kpiValueMinor).toBe(53_000);
  });

  it('an unknown report is refused (404); one this version cannot produce is refused by name (409) — never the dashboard', async () => {
    const unknown = await call('GET', '/v1/reports/nonsense', OWNER);
    expect(unknown.status).toBe(404);
    expect((unknown.body as { error: { code: string } }).error.code).toBe('no_such_report');
    // Waste: the shop records no thrown-away goods at head office yet.
    const waste = await call('GET', '/v1/reports/waste', OWNER);
    expect(waste.status).toBe(409);
    expect((waste.body as { error: { code: string } }).error.code).toBe('the_shop_does_not_record_it');
    // Margin: head office records costs and sales, but this version cannot work out a cloud margin yet.
    const margin = await call('GET', '/v1/reports/margin', OWNER);
    expect(margin.status).toBe(409);
    expect((margin.body as { error: { code: string } }).error.code).toBe('this_version_cannot_produce_it');
  });
});
