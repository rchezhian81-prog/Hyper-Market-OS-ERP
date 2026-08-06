import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createReportingSession, undeclaredColumns, PRODUCED, RUN_REFUSAL_KINDS,
  type ReportableSale, type ReportingConfig, type ReportingPorts,
} from '../../apps/web-erp/src/reporting-session';
import {
  REPORTS, availability, exportPermission, reportCatalogue, whatWouldUnlockMost,
  type Producer,
} from '../../packages/reporting/src/index';
import { AccessControl } from '../../packages/rbac/src/index';

/**
 * **The reporting surface (D13 · M29-FR-01/02 · API-10).**
 *
 * `figure()` refuses to substitute a zero for an absent value, `salesSummary` aggregates KPIs and
 * `exportDomain` writes an audited, permission-checked file — and there has never been anywhere a
 * person could run a report, nor anywhere that stated **which reports this shop cannot run at all**.
 *
 * The controls under test are the ones a later change would remove because they look like friction:
 *   • a report nothing can produce is listed and REFUSED, never run and returned as zero;
 *   • every number carries the moment it was true;
 *   • a field nobody declared never leaves the building;
 *   • the same default-deny check that guards an action guards its export.
 */

const NOW = '2026-08-06T14:00:00.000Z';

const sale = (over: Partial<ReportableSale> = {}): ReportableSale => ({
  saleId: 'S-1', committedAt: '2026-08-06T09:15:00.000Z', cashierId: 'u-meena',
  netMinor: 100_00, taxMinor: 5_00, totalMinor: 105_00, cogsMinor: 70_00,
  units: 3, tender: 'cash',
  ...over,
});

/** What this shop actually records today: sales, costs, and its own outbox. */
const RECORDS: Producer[] = ['sales_rung_at_the_till', 'cost_prices_on_the_catalogue', 'the_boxs_own_outbox'];

const ROLES = [
  { id: 'analyst', name: 'Analyst', permissions: ['reporting.sales.export', 'reporting.operations.export'] },
  { id: 'privileged', name: 'Privileged analyst', permissions: ['reporting.sales.export', 'export.sensitive'] },
];

const access = (roleId = 'analyst'): AccessControl =>
  new AccessControl(ROLES, [{ userId: 'u-report', roleId, branchScope: ['b1'] }]);

const CONFIG: ReportingConfig = {
  tenantId: 't1', storeId: 'store-1', userId: 'u-report', currency: 'INR',
  now: NOW, laggingAfterMinutes: 5, staleAfterMinutes: 60, branchId: 'b1',
};

function ports(over: Partial<ReportingPorts> = {}): ReportingPorts {
  return {
    access: () => access(),
    records: () => RECORDS,
    sales: () => [sale(), sale({ saleId: 'S-2', cashierId: 'u-ravi', totalMinor: 200_00, netMinor: 190_00, cogsMinor: 140_00, tender: 'upi', committedAt: '2026-08-06T18:40:00.000Z' })],
    lastSyncedAt: () => '2026-08-06T13:58:00.000Z',
    unsentCount: () => 3,
    exceptions: () => [{ what: 'void spike by u-meena' }],
    exceptionRulesKnown: () => true,
    ...over,
  };
}

const session = (over: Partial<ReportingPorts> = {}, config: Partial<ReportingConfig> = {}) =>
  createReportingSession({ ...CONFIG, ...config }, ports(over));

// ── The catalogue, and what it refuses to pretend ───────────────────────────

describe('a report nothing can produce is listed, and refused', () => {
  it('lists every report D13 names, not only the ones that work', () => {
    // A screen showing only what works looks finished; somebody who cannot find shrinkage
    // concludes the shop has none.
    const all = session().catalogue();
    expect(all).toHaveLength(REPORTS.length);
    expect(all.filter((e) => !e.availability.available).length).toBeGreaterThan(10);
  });

  it('puts what works first, then what cannot yet', () => {
    const all = session().catalogue();
    const firstBlocked = all.findIndex((e) => !e.availability.available);
    expect(all.slice(0, firstBlocked).every((e) => e.availability.available)).toBe(true);
    expect(all.slice(firstBlocked).every((e) => !e.availability.available)).toBe(true);
  });

  it('refuses an unproducible report rather than returning zero', () => {
    // "Waste this month: ₹0" is a number somebody puts in a board pack, and nobody reading it can
    // tell it apart from a real one.
    const outcome = session().run('waste');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('this_shop_does_not_record_that_yet');
    expect(outcome.missing).toContain('what_is_thrown_away_recorded');
    expect(outcome.detail).toContain('what is thrown away recorded');
  });

  it('names the missing facts as things a shop does, not as tables', () => {
    // The person reading it is the person who can decide to start recording them.
    const outcome = session().run('shrinkage');
    if (outcome.ok) return;
    expect(outcome.detail).toContain('stock counted on the shelves');
    expect(outcome.detail).not.toMatch(/stream|table|producer|_events/);
  });

  it('refuses a report that does not exist at all, distinctly', () => {
    const outcome = session().run('made_up');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('no_such_report');
    expect(RUN_REFUSAL_KINDS).toHaveLength(3);
  });

  it('says what would unlock the most reports, and only counts the LAST thing missing', () => {
    // A producer that unblocks nothing on its own is not the thing to do first, however many
    // reports mention it — a list ranked by mentions sends somebody to build the wrong one.
    // A shop that only rings sales: costs unlock the margin, the outbox unlocks two more.
    const backlog = session({ records: () => ['sales_rung_at_the_till'] }).backlog();
    expect(backlog.length).toBeGreaterThan(0);
    for (const row of backlog) expect(row.unlocks).toBeGreaterThan(0);
    // Sorted worst-first.
    expect(backlog[0]?.producer).toBe('the_boxs_own_outbox');
    expect([...backlog].sort((a, b) => b.unlocks - a.unlocks)[0]?.producer).toBe(backlog[0]?.producer);

    // `invoice_differences` needs three things this shop has none of, so building any ONE of them
    // must not appear as unlocking it.
    const named = backlog.flatMap((r) => r.reports);
    expect(named).not.toContain('Invoice differences');
  });

  it('has nothing left to ask THIS shop for, without claiming every report works', () => {
    // A true and easily-missed state: everything the nine producers need is already recorded, so
    // there is nothing the owner can do next — and seventeen reports are still unrunnable. The
    // backlog being empty must never be read as "every report works".
    expect(session().backlog()).toEqual([]);
    expect(session().catalogue().some((e) => !e.availability.available)).toBe(true);
  });

  it('refuses a report this BUILD cannot compute, and does not blame the shop', () => {
    // The fault this branch closed. `shrinkage` needs stock movements and stock counts; a shop
    // that records both satisfies every stated need, and there is no code here that computes it.
    // Judged on records alone it would run, return no figures and no rows, and be read as
    // "no shrinkage" — under its real name, with a real as-at stamp on nothing.
    const withStock = session({
      records: () => [...RECORDS, 'stock_movements_recorded', 'stock_counted_on_the_shelves'],
    });
    const outcome = withStock.run('shrinkage');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toBe('this_version_cannot_produce_that_yet');
    // Nothing is asked of the shop, because the shop has already done its part.
    expect(outcome.missing).toEqual([]);
    expect(outcome.detail).toContain('this version of the software');
    expect(RUN_REFUSAL_KINDS).toHaveLength(3);
  });

  it('will not export a report this build cannot compute either', () => {
    const withStock = session({
      records: () => [...RECORDS, 'stock_movements_recorded', 'stock_counted_on_the_shelves'],
    });
    const result = withStock.export('shrinkage');
    expect('csv' in result).toBe(false);
  });

  it('has a producer for every report it claims to produce, and claims every one it has', () => {
    // Both directions. A `case` missing from `PRODUCED` hides a working report; an id in
    // `PRODUCED` with no `case` opens a blank one — and the second is the dangerous half.
    const source = readFileSync('apps/web-erp/src/reporting-session.ts', 'utf8');
    const body = source.slice(source.indexOf('const produce ='), source.indexOf('  const entries ='));
    const cases = [...body.matchAll(/^\s{6}case '([a-z_]+)':/gm)].map((m) => m[1]!);
    expect([...cases].sort()).toEqual([...PRODUCED].sort());
    // And every one of them is a real report, not a typo nobody would ever notice.
    for (const id of PRODUCED) {
      expect(REPORTS.some((r) => r.id === id), `PRODUCED names "${id}", which is not a report`).toBe(true);
    }
  });

  it('runs a report the moment its last missing fact is recorded, when there IS a producer', () => {
    // `margin` has one: the other half of the same rule, proving it does not simply refuse always.
    const noCosts = session({ records: () => ['sales_rung_at_the_till'] });
    expect(noCosts.run('margin').ok).toBe(false);
    expect(session().run('margin').ok).toBe(true);
  });
});

// ── Every number carries when it was true ───────────────────────────────────

describe('a figure never appears without the moment it was true', () => {
  it('stamps every figure it produces', () => {
    const outcome = session().run('sales_by_day');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const f of outcome.result.figures) {
      expect(f.asAt, `${f.name} has no as-at`).toBe(NOW);
      expect(f.staleness).toBe('live');
    }
  });

  it('is only as fresh as its stalest number', () => {
    const outcome = session().run('sales_by_day');
    if (!outcome.ok) return;
    expect(outcome.result.worstStaleness).toBe('live');
    expect(outcome.result.detail).toContain('all current');
  });

  it('says NEVER SYNCED rather than nought minutes ago', () => {
    // Zero minutes is the freshest possible answer, and it would be exactly wrong.
    const outcome = session({ lastSyncedAt: () => null }).run('data_freshness');
    if (!outcome.ok) return;
    const f = outcome.result.figures[0]!;
    expect(f.valueMinor).toBeUndefined();
    expect(f.notAvailableBecause).toContain('never sent anything');
  });

  it('reports how far behind the cloud is when it has spoken', () => {
    const outcome = session().run('data_freshness');
    if (!outcome.ok) return;
    expect(outcome.result.figures[0]?.valueMinor).toBe(2);
  });
});

// ── The figures the box can genuinely produce ───────────────────────────────

describe('the reports this shop can actually run', () => {
  it('adds up the day and counts the bills', () => {
    const outcome = session().run('sales_by_day');
    if (!outcome.ok) return;
    expect(outcome.result.figures.find((f) => f.name === 'Taken')?.valueMinor).toBe(305_00);
    expect(outcome.result.figures.find((f) => f.name === 'Bills')?.valueMinor).toBe(2);
    expect(outcome.rows).toHaveLength(2);
  });

  it('breaks the day into hours, cashiers and tenders', () => {
    const hours = session().run('sales_by_hour');
    if (!hours.ok) return;
    expect(hours.result.figures.map((f) => f.name)).toEqual(['09:00', '18:00']);

    const cashiers = session().run('sales_by_cashier');
    if (!cashiers.ok) return;
    expect(cashiers.result.figures.map((f) => f.name)).toEqual(['u-meena', 'u-ravi']);

    const tender = session().run('tender_mix');
    if (!tender.ok) return;
    expect(tender.result.figures.find((f) => f.name === 'upi')?.valueMinor).toBe(200_00);
  });

  it('leaves an uncostable sale OUT of the margin and counts it beside', () => {
    // Costing it at zero reports a 100% margin, which is a lie that reads as very good news.
    const outcome = session({
      sales: () => [sale(), sale({ saleId: 'S-3', cogsMinor: undefined, netMinor: 500_00 })],
    }).run('margin');
    if (!outcome.ok) return;
    expect(outcome.result.figures.find((f) => f.name === 'Margin')?.valueMinor).toBe(30_00);
    expect(outcome.result.figures.find((f) => f.name === 'Sales with no cost price')?.valueMinor).toBe(1);
  });

  it('refuses a margin outright when NO sale has a cost behind it', () => {
    const outcome = session({ sales: () => [sale({ cogsMinor: undefined })] }).run('margin');
    if (!outcome.ok) return;
    const margin = outcome.result.figures.find((f) => f.name === 'Margin')!;
    expect(margin.valueMinor).toBeUndefined();
    expect(margin.notAvailableBecause).toContain('no sale on this day has a cost price');
  });

  it('says a shop with no bills has NO average basket, not an average of zero', () => {
    const outcome = session({ sales: () => [] }).run('basket');
    if (!outcome.ok) return;
    const basket = outcome.result.figures.find((f) => f.name === 'Average basket')!;
    expect(basket.valueMinor).toBeUndefined();
    expect(basket.notAvailableBecause).toContain('no bills yet');
  });

  it('leaves a bill with no readable lines OUT of units per basket and counts it beside', () => {
    // A power-cut record keeps its takings — the till printed them — but it has no basket size.
    // `lines.length` on a record with no lines is zero, and averaging that zero in pulls the
    // shop's units-per-basket figure down by an amount nobody could ever explain.
    const outcome = session({
      sales: () => [sale({ units: 4 }), sale({ saleId: 'S-9', units: undefined, cogsMinor: undefined })],
    }).run('basket');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.figures.find((f) => f.name === 'Units per basket')?.valueMinor).toBe(4);
    expect(outcome.result.figures.find((f) => f.name === 'Bills with no readable lines')?.valueMinor).toBe(1);
    // The money average still counts it: those takings are real and reconcile against the till.
    expect(outcome.result.figures.find((f) => f.name === 'Average basket')?.valueMinor).toBe(105_00);
    // And the row says so in words rather than showing a blank a reader would take for zero.
    expect(outcome.rows.find((r) => r['saleId'] === 'S-9')?.['units']).toBe('not known');
  });

  it('has NO units per basket at all when no bill today has readable lines', () => {
    const outcome = session({ sales: () => [sale({ units: undefined, cogsMinor: undefined })] }).run('basket');
    if (!outcome.ok) return;
    const units = outcome.result.figures.find((f) => f.name === 'Units per basket')!;
    expect(units.valueMinor).toBeUndefined();
    // Distinguished from a shop that has not opened: this one HAS traded, and cannot say.
    expect(units.notAvailableBecause).toContain('no bill today has readable lines');
  });

  it('keeps an unknown basket size out of the margin figures too', () => {
    // Both are the same judgement about the same broken record, so they must not disagree.
    const outcome = session({
      sales: () => [sale(), sale({ saleId: 'S-9', units: undefined })],
    }).run('margin');
    if (!outcome.ok) return;
    expect(outcome.result.figures.find((f) => f.name === 'Sales with no cost price')?.valueMinor).toBe(1);
    expect(outcome.rows.some((r) => r['saleId'] === 'S-9')).toBe(false);
  });

  it('says nothing was checked when the shop has no loss-prevention limits', () => {
    // Zero exceptions with no rules is not a clean shop; it is a shop nobody is watching.
    const outcome = session({ exceptionRulesKnown: () => false, exceptions: () => [] }).run('exceptions');
    if (!outcome.ok) return;
    const f = outcome.result.figures[0]!;
    expect(f.valueMinor).toBeUndefined();
    expect(f.notAvailableBecause).toContain('nothing was checked');
  });

  it('reports what has not reached head office from the box’s own queue', () => {
    const outcome = session().run('sync_health');
    if (!outcome.ok) return;
    expect(outcome.result.figures[0]?.valueMinor).toBe(3);
  });

  it('hands back the rows behind the figures, for drill-through', () => {
    const outcome = session().run('sales_by_cashier');
    if (!outcome.ok) return;
    expect(outcome.rows).toEqual([
      { key: 'u-meena', totalMinor: '10500', bills: '1' },
      { key: 'u-ravi', totalMinor: '20000', bills: '1' },
    ]);
  });
});

// ── Export ──────────────────────────────────────────────────────────────────

describe('a field nobody declared never leaves the building', () => {
  it('writes a declared report out, with its schema and audit record', () => {
    const result = session().export('sales_by_cashier');
    expect('csv' in result).toBe(true);
    if (!('csv' in result)) return;
    expect(result.csv.split('\n')[0]).toBe('key,totalMinor,bills');
    expect(result.schema.columns.map((c) => c.name)).toEqual(['key', 'totalMinor', 'bills']);
    expect(result.audit.rowCount).toBe(2);
  });

  it('names a column a report produced that nobody declared', () => {
    // Deriving the spec from the rows would let a field added months later — a customer's phone
    // number appended for one screen — become a column in a file somebody emails. And dropping it
    // quietly would produce a narrower file somebody reconciles against and cannot explain, so the
    // whole export refuses.
    expect(undeclaredColumns(
      [{ key: 'u-meena', totalMinor: '100', customerPhone: '99999 11111' }],
      [{ name: 'key' }, { name: 'totalMinor' }],
    )).toEqual(['customerPhone']);
  });

  it('tripwire — the guard passes a report whose rows match its declaration', () => {
    // Otherwise a check that always fired would be turned off rather than believed.
    expect(undeclaredColumns([{ key: 'a', totalMinor: '1', bills: '1' }],
      [{ name: 'key' }, { name: 'totalMinor' }, { name: 'bills' }])).toEqual([]);
  });

  it('every shipped report’s rows match what it declares', () => {
    // The guard above is the safety net; this is the assertion that the shipped reports are right.
    const s = session();
    for (const entry of s.catalogue().filter((e) => e.availability.available)) {
      const outcome = s.run(entry.report.id);
      if (!outcome.ok) continue;
      expect(
        undeclaredColumns(outcome.rows, entry.report.columns ?? []),
        `${entry.report.id} produces a column it does not declare`,
      ).toEqual([]);
    }
  });

  it('checks the SAME default-deny control that guards the action', () => {
    // A second, simpler check written into the reporting screen would be the one that drifts, and
    // it would drift in the direction of letting more out.
    const noRights = createReportingSession(CONFIG, {
      ...ports(),
      access: () => new AccessControl(ROLES, []),
    }).export('sales_by_cashier');
    expect('csv' in noRights).toBe(false);
    if ('csv' in noRights) return;
    expect(noRights.detail).toContain('Access denied');
  });

  it('refuses to export a report nothing can produce', () => {
    const result = session().export('waste');
    expect('csv' in result).toBe(false);
    if ('csv' in result) return;
    expect(result.detail).toContain('what is thrown away recorded');
  });

  it('asks for a permission named per family, so roles can actually be written', () => {
    expect(exportPermission(REPORTS.find((r) => r.id === 'margin')!)).toBe('reporting.sales.export');
    expect(exportPermission(REPORTS.find((r) => r.id === 'sync_health')!)).toBe('reporting.operations.export');
  });

  it('refuses a family the user has no rights to, while allowing one they do', () => {
    const s = session();
    expect('csv' in s.export('sales_by_cashier')).toBe(true);
    expect('csv' in s.export('sync_health')).toBe(true);
    // `analyst` has sales and operations, and nothing else — and every other family is unavailable
    // in this shop anyway, so the honest refusal is the availability one.
    const other = s.export('gst');
    expect('csv' in other).toBe(false);
  });
});

// ── The catalogue functions on their own ────────────────────────────────────

describe('the catalogue stands on its own', () => {
  it('every producible report declares its columns; unproducible ones declare none', () => {
    for (const report of REPORTS) {
      const can = availability(report, RECORDS, PRODUCED).available;
      if (can) expect(report.columns, `${report.id} produces but declares nothing`).toBeDefined();
    }
  });

  it('every report names at least one thing the shop must record', () => {
    for (const report of REPORTS) {
      expect(report.needs.length, `${report.id} needs nothing, so it can never be honest`)
        .toBeGreaterThan(0);
    }
  });

  it('a shop that records nothing can run nothing, and is told so for each', () => {
    const nothing = reportCatalogue([], PRODUCED);
    expect(nothing.every((e) => !e.availability.available)).toBe(true);
    for (const entry of nothing) {
      if (entry.availability.available) continue;
      expect(entry.availability.why.length, `${entry.report.id} says too little`).toBeGreaterThan(20);
    }
  });

  it('a shop that records everything still cannot run what this build has no code for', () => {
    // The fault this exists to prevent, in its exact shape. Judged on the shop's records alone,
    // every report here would be "available" — and the seventeen with no producer would open with
    // no figures and no rows, under their real names, with a real as-at stamp on nothing.
    const all = [...new Set(REPORTS.flatMap((r) => r.needs))];
    const catalogue = reportCatalogue(all, PRODUCED);
    expect(catalogue.filter((e) => e.availability.available)).toHaveLength(PRODUCED.length);
    for (const entry of catalogue) {
      if (entry.availability.available) continue;
      expect(entry.availability.blockedBy).toBe('this_version_cannot_produce_it');
      expect(entry.availability.missing, `${entry.report.id} blames the shop`).toEqual([]);
      expect(entry.availability.why).toContain('this version of the software');
    }
    // And nothing is on the owner's backlog, because there is nothing left for him to record.
    expect(whatWouldUnlockMost(all, PRODUCED)).toEqual([]);
  });

  it('never puts a report this build cannot compute on the owner’s backlog', () => {
    // He would start recording expiry dates, open the report, and find it blank — having done
    // exactly what the screen told him to do.
    const named = whatWouldUnlockMost([], PRODUCED).flatMap((r) => r.reports);
    const unbuilt = REPORTS.filter((r) => !PRODUCED.includes(r.id)).map((r) => r.name);
    for (const name of named) expect(unbuilt).not.toContain(name);
  });

  it('lists what the shop can unlock ahead of what only a new version can', () => {
    const catalogue = reportCatalogue(RECORDS, PRODUCED);
    const rank = (e: (typeof catalogue)[number]): number => e.availability.available
      ? 0
      : e.availability.blockedBy === 'the_shop_does_not_record_it' ? 1 : 2;
    const ranks = catalogue.map(rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});
