import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';
import type { ApiHarness } from '../support/api-harness';

// OB-288 P5 — the migration controls, through the real routes (synthetic data, a rehearsal target — hard rule #7):
//   • MG-09 (owner decision OB-309): two full exports of the old ERP compared — every added, changed and removed record a
//     BLOCKING exception on the register, nothing applied, a customer's personal values never shown; the same files again
//     are the same run; other files under the same id refused; an unreadable export refused whole;
//   • MG-10: the books side of a parallel day — the old purchase register, supplier outstanding, closing stock and gross
//     profit against head office's own registers; a figure head office cannot work out is NOT COMPARED and the day
//     cannot be signed; each difference needs its reason first;
//   • MG-11: the owner's four rollback limits ("not set" until he enters them, frozen once GO is given), the backup check,
//     and the night check that raises the rollback trigger by itself, once, to the owner.
// In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const DAY = new Date().toISOString().slice(0, 10); // the receipts land now, so the day is today
const DMY = `${DAY.slice(8, 10)}-${DAY.slice(5, 7)}-${DAY.slice(0, 4)}`;
const DMY_BEFORE = DAY.slice(8, 10) === '01' ? `02-${DAY.slice(5, 7)}-${DAY.slice(0, 4)}` : `01-${DAY.slice(5, 7)}-${DAY.slice(0, 4)}`;

const csv = (rows: readonly (readonly (string | number)[])[]): string => rows.map((r) => r.map((c) => (typeof c === 'string' && /[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : String(c))).join(',')).join('\r\n') + '\r\n';

describe.each(backings)('migration controls MG-09 · MG-10 · MG-11 (OB-288 P5) — on $name', ({ harness }) => {
  it('MG-09: two full exports become blocking exceptions to decide — nothing applied, nothing deleted, personal values never shown', async () => {
    const h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    // The old ERP's own column names — mapped once onto our fields.
    const itemMap = { item_code: 'Item Code', name: 'Item Name', hsn: 'HSN' };
    const loaded = csv([['Item list as on 01-10-2026'], ['Item Code', 'Item Name', 'HSN'], ['P-DAL', 'Toor dal 1kg', '0713'], ['P-OIL', 'Groundnut oil 1L', '1508'], ['P-SALT', 'Salt 1kg', '2501'], ['Grand Total', '', '']]);
    const latest = csv([['Item Code', 'Item Name', 'HSN'], ['P-DAL', 'Toor dal 1 kg (new pack)', '0713'], ['P-OIL', 'Groundnut oil 1L', '1508'], ['P-GHEE', 'Ghee 500ml', '0405']]);
    const items = await call('POST', '/v1/migration/export-diffs/delta-items-1', 'u-owner', { domain: 'items', mapping: itemMap, baseline: { csv: loaded, label: 'final extract 01-10' }, latest: { csv: latest, label: 'export 20-10' } });
    expect(items.status, JSON.stringify(items.body)).toBe(201);
    const ib = items.body as { run: { counts: Record<string, number>; exceptionIds: string[] }; outstanding: { blockingUnresolved: { kind: string; legacyIds: string[] }[] } };
    expect(ib.run.counts).toEqual({ baseline: 3, latest: 3, added: 1, changed: 1, removed: 1, unchanged: 1 });
    expect(ib.outstanding.blockingUnresolved.map((e) => [e.kind, e.legacyIds[0]]).sort()).toEqual([['delta_added', 'P-GHEE'], ['delta_changed', 'P-DAL'], ['delta_removed', 'P-SALT']]);
    // The same files again: the same run, nothing recorded twice. Other files under the same id: refused.
    expect((await call('POST', '/v1/migration/export-diffs/delta-items-1', 'u-owner', { domain: 'items', mapping: itemMap, baseline: { csv: loaded }, latest: { csv: latest } })).body).toMatchObject({ alreadyRecorded: true });
    expect(codeOf(await call('POST', '/v1/migration/export-diffs/delta-items-1', 'u-owner', { domain: 'items', mapping: itemMap, baseline: { csv: loaded }, latest: { csv: loaded } }))).toBe('diff_id_used');
    // An export with a key twice is refused whole, naming the line; a column not mapped is refused; a cashier cannot.
    const twice = csv([['Item Code', 'Item Name', 'HSN'], ['P-DAL', 'a', '0713'], ['P-DAL', 'b', '0713']]);
    const refused = await call('POST', '/v1/migration/export-diffs/delta-items-2', 'u-owner', { domain: 'items', mapping: itemMap, baseline: { csv: loaded }, latest: { csv: twice } });
    expect(codeOf(refused)).toBe('export_not_readable');
    expect(JSON.stringify(refused.body)).toMatch(/P-DAL appears twice/);
    expect(codeOf(await call('POST', '/v1/migration/export-diffs/delta-items-3', 'u-owner', { domain: 'items', mapping: { item_code: 'Item Code' }, baseline: { csv: loaded }, latest: { csv: latest } }))).toBe('export_not_readable');
    expect((await call('POST', '/v1/migration/export-diffs/delta-items-4', 'u-cash', { domain: 'items', mapping: itemMap, baseline: { csv: loaded }, latest: { csv: latest } })).status).toBe(403);

    // Prices: a price change carries the money at stake. Customers: a phone change is said, never shown.
    const prices = await call('POST', '/v1/migration/export-diffs/delta-prices-1', 'u-owner', {
      domain: 'prices', mapping: { item_code: 'Code', selling_price: 'Rate', mrp: 'MRP' },
      baseline: { csv: csv([['Code', 'Rate', 'MRP'], ['P-DAL', '140.00', '150'], ['P-OIL', '210.50', '220']]) },
      latest: { csv: csv([['Code', 'Rate', 'MRP'], ['P-DAL', '145.00', '150'], ['P-OIL', '210.50', '220']]) },
    });
    expect((prices.body as { changed: { key: string; changes: { field: string; before: string; after: string }[] }[] }).changed).toEqual([{ key: 'P-DAL', changes: [{ field: 'selling_price', before: '14000', after: '14500', personal: false }] }]);
    const customers = await call('POST', '/v1/migration/export-diffs/delta-customers-1', 'u-owner', {
      domain: 'customers', mapping: { customer_code: 'Cust No', name: 'Customer', phone: 'Mobile' },
      baseline: { csv: csv([['Cust No', 'Customer', 'Mobile'], ['C-1', 'Synthetic One', '90000 00001']]) },
      latest: { csv: csv([['Cust No', 'Customer', 'Mobile'], ['C-1', 'Synthetic One', '90000 00009']]) },
    });
    expect(customers.status).toBe(201);
    expect(JSON.stringify(customers.body)).not.toContain('90000');
    const register = (await call('GET', '/v1/migration/exceptions', 'u-owner')).body as { exceptions: { exceptionId: string; kind: string; evidence: string; valueMinor?: number }[] };
    expect(register.exceptions.find((e) => e.kind === 'delta_changed' && e.evidence.includes('selling price'.replace('selling price', 'Selling price')))).toMatchObject({ valueMinor: 500 });
    const phone = register.exceptions.find((e) => e.evidence.includes('C-1'))!;
    expect(phone.evidence).toMatch(/Phone changed \(personal — not shown\)/);
    expect(JSON.stringify(register)).not.toContain('90000');

    // A person decides one; it stays on the register (never deleted) and the run says how many are left to decide.
    const dal = register.exceptions.find((e) => e.kind === 'delta_changed' && e.evidence.includes('P-DAL') && e.evidence.includes('Item name'))!;
    expect((await call('POST', `/v1/migration/exceptions/${dal.exceptionId}/resolution`, 'u-owner', { action: 'migrate_as_is', reason: 'the new pack name is right — load it' })).status).toBe(200);
    const runs = (await call('GET', '/v1/migration/export-diffs', 'u-owner')).body as { runs: { diffId: string; undecided: number }[] };
    expect(runs.runs.find((r) => r.diffId === 'delta-items-1')!.undecided).toBe(2);
    const after = (await harness(h).request({ method: 'GET', path: '/v1/migration/exceptions', userId: 'u-owner', tenantId: T })).body as { exceptions: unknown[] };
    expect(after.exceptions).toHaveLength(register.exceptions.length);
  }, 120_000);

  it('MG-10 books side and MG-11 limits: purchases, balances, stock compared; margin not compared holds the signature; the limits raise the trigger once', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    for (const [id, qty] of [['a', 10], ['b', 6]] as const) {
      const lines = [{ productId: 'rice', qty, unitMinor: 5_000 }];
      await issuedOrder(call, `po-${id}`, lines);
      await received(call, `grn-${id}`, `po-${id}`, lines);
      await capturedAndMatched(call, `inv-${id}`, `po-${id}`, lines, undefined, 'sup-1', DAY);
    }
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    expect((await req('PUT', '/v1/migration/parallel-run/policy', P3.OWNER, { cutoverId: 'C-1', dailyReconcilerUserId: P3.BUYER, requiredCleanDays: 3, maxParallelDays: 14, startedOn: '2026-10-01' })).status).toBe(201);
    const reports = {
      purchase_register: { mapping: { supplier_code: 'Party', bill_number: 'Bill No', bill_date: 'Date', bill_value: 'Amount' }, csv: csv([[`Purchase register ${DMY}`], ['Party', 'Bill No', 'Date', 'Amount'], ['sup-1', 'inv-a', DMY, '500.00'], ['sup-1', 'inv-b', DMY, '310.00'], ['sup-1', 'inv-z', DMY, '99.00'], ['Total', '', '', '909.00']]) },
      supplier_balances: { mapping: { supplier_code: 'Party', balance: 'Outstanding' }, csv: csv([['Party', 'Outstanding'], ['sup-1', '800.00']]) },
      stock_balance: { mapping: { item_code: 'Item', quantity: 'Qty' }, csv: csv([['Item', 'Qty'], ['rice', '16'], ['dal', '3']]) },
      margin: { mapping: { sales_value: 'Net Sales', cost_value: 'Cost' }, csv: csv([['Net Sales', 'Cost'], ['0.00', '0.00']]) },
    };
    expect((await req('POST', `/v1/migration/parallel-run/days/${DAY}/books`, P3.CASHIER, { reports })).status).toBe(403);
    expect(codeOf(await req('POST', `/v1/migration/parallel-run/days/${DAY}/books`, P3.RECEIVER, { reports }))).toBe('not_the_named_reconciler');
    const wrongDay = { purchase_register: { ...reports.purchase_register, csv: csv([['Party', 'Bill No', 'Date', 'Amount'], ['sup-1', 'inv-a', DMY_BEFORE, '500.00']]) } };
    expect(codeOf(await req('POST', `/v1/migration/parallel-run/days/${DAY}/books`, P3.BUYER, { reports: wrongDay }))).toBe('books_reports_not_readable');
    const books = await req('POST', `/v1/migration/parallel-run/days/${DAY}/books`, P3.BUYER, { reports });
    expect(books.status, JSON.stringify(books.body)).toBe(201);
    const bb = books.body as { comparisons: { area: string; subject?: string; legacyValue: number; newValue: number }[]; notCompared: { area: string }[]; notGiven: string[] };
    const lines = bb.comparisons.map((c) => [c.area, c.subject ?? '', c.legacyValue, c.newValue]);
    expect(lines).toEqual(expect.arrayContaining([
      ['purchase_bill_value', 'sup-1/inv-b', 31_000, 30_000],
      ['purchase_bill_not_on_new', 'sup-1/inv-z', 1, 0],
      ['purchases_value', '', 90_900, 80_000],
      ['supplier_balance_total', '', 80_000, 80_000],
      ['stock_quantity', 'dal', 3_000, 0],
    ]));
    expect(lines.some((l) => l[0] === 'stock_quantity' && l[1] === 'rice'), JSON.stringify(lines)).toBe(false); // 16 against 16 — agrees
    expect(bb.notCompared.map((n) => n.area)).toEqual(['margin_sales_net']); // the day book holds no sales for the day
    expect(bb.notGiven).toEqual(['customer_balances']);
    // The day cannot be signed while a figure is not compared.
    expect(codeOf(await req('POST', `/v1/migration/parallel-run/days/${DAY}/signature`, P3.BUYER, { statement: 'checked the books side' }))).toBe('books_not_compared');
    // Recorded again without the margin report: nothing left un-compared, so the differences themselves hold the signature.
    const withoutMargin = { purchase_register: reports.purchase_register, supplier_balances: reports.supplier_balances, stock_balance: reports.stock_balance };
    expect((await req('POST', `/v1/migration/parallel-run/days/${DAY}/books`, P3.BUYER, { reports: withoutMargin })).status).toBe(201);
    expect(codeOf(await req('POST', `/v1/migration/parallel-run/days/${DAY}/signature`, P3.BUYER, { statement: 'checked the books side' }))).toBe('unexplained_material_difference');
    const run = (await req('GET', '/v1/migration/parallel-run', P3.OWNER)).body as { differences?: { differenceId: string; businessDate: string; status: string }[] };
    expect(JSON.stringify(run)).toContain('purchase_bill_not_on_new');
    const day = (await req('GET', `/v1/migration/parallel-run/days/${DAY}/books`, P3.OWNER)).body as { record: { notCompared: unknown[]; reports: string[] } };
    expect(day.record).toMatchObject({ notCompared: [], reports: ['purchase_register', 'supplier_balances', 'stock_balance'] });

    // ── MG-11: the owner's limits are "not set" until he enters them; nobody else may.
    const limitsNow = async (hh: ApiHarness = h) => (await hh.request({ method: 'GET', path: '/v1/migration/cutover/rollback-limits', userId: P3.OWNER, tenantId: T })).body as { limits: unknown; notSet: string[]; backup: { state: string; evidence: string }; raisedTriggers: { limit: string }[] };
    expect((await limitsNow()).notSet).toEqual(['controlTotalDifferenceMinor', 'edgeOutageMinutes', 'windowMinutes', 'backupMaxAgeHours']);
    expect((await limitsNow()).backup.state).toBe('not_known');
    const body = { controlTotalDifferenceMinor: 1_000, edgeOutageMinutes: 30, windowMinutes: null, backupMaxAgeHours: 6 };
    expect((await req('PUT', '/v1/migration/cutover/rollback-limits', P3.MATCHER, body)).status).toBe(403);
    await h.provisionOwner(T, 'u-owner-2'); // another holder of the owner role is still not THE owner whose numbers these are
    expect(codeOf(await req('PUT', '/v1/migration/cutover/rollback-limits', 'u-owner-2', body))).toBe('owner_only');
    expect(codeOf(await req('PUT', '/v1/migration/cutover/rollback-limits', P3.OWNER, { ...body, windowMinutes: -1 }))).toBe('not_readable_as_rollback_limits');
    expect((await req('PUT', '/v1/migration/cutover/rollback-limits', P3.OWNER, body)).status).toBe(200);
    expect((await limitsNow()).notSet).toEqual(['windowMinutes']);
    expect((await limitsNow()).backup).toMatchObject({ state: 'failed', evidence: expect.stringMatching(/never reported a backup/) });
    // The night check: a money control total ₹25 out against an agreed ₹10 raises the trigger — once — to the owner.
    expect((await req('POST', '/v1/migration/control-totals', P3.OWNER, { totals: [{ totalId: 'CT-AR', kind: 'financial', name: 'Customer outstanding', unit: 'minor_currency', legacyValue: 100_000, loadedValue: 102_500, legacyDerivation: 'old ERP outstanding report', loadedDerivation: 'sum of loaded opening balances' }] })).status).toBe(201);
    const night = (await req('POST', '/v1/migration/cutover/night-check', P3.OWNER, {})).body as { crossed: { trigger: string; observed: number; limitValue: number }[]; notKnown: string[]; newlyRaised: unknown[]; rollBackNow: boolean };
    // The shop's store computer has never reported a complete sync either: a store head office cannot hear from counts
    // as cut off — the second agreed limit is crossed too.
    expect(night.crossed).toEqual([
      expect.objectContaining({ trigger: 'control_total_failed', observed: 2_500, limitValue: 1_000 }),
      expect.objectContaining({ trigger: 'edge_cannot_trade', limitValue: 30 }),
    ]);
    expect(night.rollBackNow).toBe(true);
    expect(night.notKnown.join(' ')).toMatch(/after GO \(minutes\): not set/);
    expect(night.newlyRaised).toHaveLength(2);
    expect(((await req('POST', '/v1/migration/cutover/night-check', P3.OWNER, {})).body as { newlyRaised: unknown[] }).newlyRaised).toEqual([]);
    expect(JSON.stringify((await req('GET', '/v1/platform/alerts', P3.OWNER)).body)).toContain('rollback-trigger:');
    expect((await req('POST', '/v1/migration/cutover/night-check', P3.CASHIER, {})).status).toBe(403);

    // A cold restart reads the same limits, the same raised trigger and the same books record.
    const h2 = harness(h);
    expect(await limitsNow(h2)).toMatchObject({ notSet: ['windowMinutes'], raisedTriggers: expect.arrayContaining([expect.objectContaining({ limit: 'controlTotalDifferenceMinor' }), expect.objectContaining({ limit: 'edgeOutageMinutes' })]) });
    expect(((await h2.request({ method: 'GET', path: `/v1/migration/parallel-run/days/${DAY}/books`, userId: P3.OWNER, tenantId: T })).body as { history: unknown[] }).history).toHaveLength(2);
  }, 120_000);
});
