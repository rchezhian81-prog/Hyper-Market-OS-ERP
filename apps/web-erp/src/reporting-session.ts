// The reporting surface (D13 · M29-FR-01/02 · API-10 · §32 · P-08).
//
// The pieces exist and are tested: `packages/reporting` aggregates sale facts into KPIs and
// classifies freshness, `services/reporting` wraps every number in a `Figure` that **cannot be
// constructed without the time it is true as of**, and `packages/export` writes an audited,
// permission-checked, PII-redacted file. What has never existed is anywhere a person can run a
// report — and what has never been stated anywhere is **which reports this shop cannot run at all**.
//
// ── The decision this surface is built around ───────────────────────────────
//
// A reporting screen that lists only the reports that work looks finished. Somebody asks for
// shrinkage, finds nothing, and concludes either that the shop has none or that the software forgot.
// Both readings are wrong and neither is correctable by anybody looking at the screen.
//
// So **every report D13 names is listed**, and one that cannot be produced says which fact is
// missing in the shop's own words: *nobody records what is thrown away yet*. That list is the build
// backlog in business language, and until the producers exist it is the most useful thing here.
//
// ── And the two that follow from it ─────────────────────────────────────────
//
// **A number never appears without the time it was true.** `figure()` makes that structural — there
// is no way to build one without an `asAt` — and a stale figure says so in the figure rather than in
// a banner somebody has learned to ignore.
//
// **A figure that cannot be computed is absent, never zero.** "Waste this month: ₹0" is a number
// somebody puts in a board pack. This surface will not offer the report at all.
//
// ── The half of that which is OUR gap, not the shop's ───────────────────────
//
// A report is runnable only when both halves hold: the shop records the facts, AND this build has
// code that computes it. `PRODUCED` below is that second half, and it is checked against the
// catalogue by a test — because the failure it prevents is silent. Nine of D13's reports have a
// producer here; the rest do not. Judge availability on the shop's records alone and a tenant who
// starts recording stock counts opens *Shrinkage* and gets a page with no figures and no rows on
// it, which reads as **no shrinkage** and is the exact fault this whole surface exists to prevent.
//
// So the two gaps are told apart and say so: *nothing yet records what is thrown away* is the
// owner's to fix, and *this version cannot work it out yet* is ours.

import { type CurrencyCode } from '../../../packages/contracts/src/money';
import {
  exportPermission, freshness, reportCatalogue, salesSummary, whatWouldUnlockMost,
  type CatalogueEntry, type Freshness, type Producer, type ReportDefinition, type SaleFact,
} from '../../../packages/reporting/src/index';
import { AccessDeniedError, type AccessControl } from '../../../packages/rbac/src/index';
import { figure, dashboard, type Dashboard, type Figure } from '../../../services/reporting/src/index';
import { exportDomain, type ExportContext, type ExportResult, type ExportSpec } from '../../../packages/export/src/index';

/** One sale as this screen reads it, with the facts a report is built from. */
export interface ReportableSale {
  readonly saleId: string;
  readonly committedAt: string;
  readonly cashierId: string;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  /** Absent when the shop has no cost price for something in the basket — never zero. */
  readonly cogsMinor?: number;
  /**
   * How many lines were on the bill. **Absent when the record carried no readable lines** — never
   * zero, for the same reason `cogsMinor` is never zero: a basket of nothing is not a fact about
   * the shop, it is a fact about a half-written record, and averaging it in moves a real figure.
   */
  readonly units?: number;
  readonly tender: string;
}

/** What this surface can see about the shop, and what it honestly cannot. */
export interface ReportingPorts {
  /**
   * The shop's own access control.
   *
   * A real `AccessControl` rather than a list of permission strings, so **the same default-deny
   * check that guards an action guards its export** — a second, simpler check written here would
   * be the one that drifts, and it would drift in the direction of letting more out.
   */
  access(): AccessControl;
  /** What the shop actually records today. Never a wish list — the gaps are the point. */
  records(): readonly Producer[];
  /** Today's sales from this box's own log. */
  sales(): readonly ReportableSale[];
  /** When the cloud pack last reached this box. `null` means never. */
  lastSyncedAt(): string | null;
  /** Work this box has done that has not reached head office. */
  unsentCount(): number;
  /** Voids, refunds and no-sales outside the shop's own limits, as the box judged them. */
  exceptions(): readonly { readonly what: string }[];
  /** True when the shop's own loss-prevention rules were known — an empty list is not a clean shop. */
  exceptionRulesKnown(): boolean;
  /**
   * One row per trading day this box holds, most recent first.
   *
   * **Only days it actually holds.** A box installed on Thursday has no Wednesday, and a comparison
   * against a Wednesday of nought would report the shop as having doubled its takings overnight.
   */
  dayTotals(): readonly DayTotal[];
  /** Units sold today per department id. Units, not money — see the payload builder for why. */
  unitsByCategory(): Readonly<Record<string, number>>;
  /** Units sold today whose product the catalogue places in no department. Never folded into one. */
  unitsWithNoCategory(): number;
  /** Department id → the name a person would recognise. Absent means the box was never told. */
  categoryNames(): Readonly<Record<string, string>> | undefined;
}

/** What one trading day took, as this box recorded it. */
export interface DayTotal {
  readonly tradingDay: string;
  readonly totalMinor: number;
  readonly bills: number;
}

export interface ReportingConfig {
  readonly tenantId: string;
  readonly storeId: string;
  /**
   * Who is looking, as the shop's own access control knows them.
   *
   * `null` means **the box has not been told**, which is a different thing from a person with no
   * rights. Substituting a made-up id here would put a name nobody holds into the audit record of
   * every file this screen wrote out, and that record is the only evidence of who took the data.
   */
  readonly userId: string | null;
  readonly currency: CurrencyCode;
  /** Now, injected. No clock in here — every figure is judged against it. */
  readonly now: string;
  /** Minutes after which a figure is lagging. Per-tenant (§32). */
  readonly laggingAfterMinutes: number;
  /** Minutes after which it should not be relied on. Per-tenant. */
  readonly staleAfterMinutes: number;
  /** The branch this export is for; null = company-wide, which needs an "all"-scope grant. */
  readonly branchId: string | null;
  /**
   * The trading day these figures are for, as the SHOP reckons it.
   *
   * Not derived from `now`: the shop's day runs to its own cutoff (two in the morning here), so a
   * sale rung at half past midnight belongs to the day before and slicing on the calendar date
   * would move it. The box already works this out; the screen is told, not left to guess.
   */
  readonly tradingDay: string;
}

/**
 * The report ids this build actually computes — the `case` labels of `produce` below, stated once
 * so the catalogue can be honest about the rest.
 *
 * A test asserts this list and that switch agree in both directions, so adding a `case` without
 * listing it here (the report stays hidden) and listing one without a `case` (the report opens
 * blank) are both caught. The second is the dangerous one.
 */
export const PRODUCED: readonly string[] = Object.freeze([
  'sales_by_day', 'sales_by_hour', 'sales_by_cashier', 'tender_mix', 'basket', 'margin',
  'day_on_day', 'units_by_category', 'sync_health', 'data_freshness', 'exceptions',
]);

export type RunRefusal =
  | 'no_such_report'
  | 'this_shop_does_not_record_that_yet'
  | 'this_version_cannot_produce_that_yet';

export type RunOutcome =
  | {
    readonly ok: true;
    readonly report: ReportDefinition;
    readonly result: Dashboard;
    /** The rows behind the figures, for drill-through (M29-FR-02). */
    readonly rows: readonly Readonly<Record<string, string>>[];
  }
  | {
    readonly ok: false;
    readonly refusal: RunRefusal;
    readonly detail: string;
    /** Named producers, so the refusal is something somebody can act on. */
    readonly missing: readonly Producer[];
  };

const RUN_REFUSALS: Readonly<Record<RunRefusal, RunRefusal>> = Object.freeze({
  no_such_report: 'no_such_report',
  this_shop_does_not_record_that_yet: 'this_shop_does_not_record_that_yet',
  this_version_cannot_produce_that_yet: 'this_version_cannot_produce_that_yet',
});

export const RUN_REFUSAL_KINDS: readonly RunRefusal[] = Object.freeze(Object.values(RUN_REFUSALS));

/**
 * Column names a report produced that nobody declared.
 *
 * Exported so it can be tested on its own, because the case it exists for is one that cannot be
 * reached through the shipped reports while they are correct — and a guard nobody can exercise is
 * a guard nobody can trust.
 */
export function undeclaredColumns(
  rows: readonly Readonly<Record<string, string>>[],
  declared: readonly { readonly name: string }[],
): readonly string[] {
  const allowed = new Set(declared.map((c) => c.name));
  const found = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!allowed.has(key)) found.add(key);
  }
  return [...found];
}

export interface ReportingSession {
  /** Every report D13 names — the ones that work first, then the ones that cannot yet. */
  catalogue(): readonly CatalogueEntry[];

  /** What the shop would have to start recording to unlock the most reports. */
  backlog(): ReturnType<typeof whatWouldUnlockMost>;

  /** How current the figures on this screen are. */
  freshness(): Freshness;

  /** Run one report, or refuse and name what is missing. */
  run(reportId: string): RunOutcome;

  /** Write a report out, with the permission check, branch scope and PII redaction of M30-FR-02. */
  export(reportId: string): ExportResult | { readonly ok: false; readonly detail: string };
}

export function createReportingSession(
  config: ReportingConfig,
  ports: ReportingPorts,
): ReportingSession {
  /**
   * Sale facts for the KPI engine.
   *
   * **A sale with no cost price is left out of the margin figures rather than costed at zero**, and
   * the count of those is reported beside the margin. Zero cost reports a 100% margin, which is a
   * lie that reads as very good news — the same rule the owner's brief already holds.
   */
  const costableFacts = (): { facts: SaleFact[]; uncostable: number } => {
    const facts: SaleFact[] = [];
    let uncostable = 0;
    for (const sale of ports.sales()) {
      // Both are the same judgement: a bill whose lines could not be read has neither a cost
      // behind it nor a basket size, and there is nothing to substitute for either.
      if (sale.cogsMinor === undefined || sale.units === undefined) {
        uncostable += 1;
        continue;
      }
      facts.push({
        saleId: sale.saleId,
        netMinor: sale.netMinor,
        taxMinor: sale.taxMinor,
        totalMinor: sale.totalMinor,
        cogsMinor: sale.cogsMinor,
        units: sale.units,
        tender: sale.tender,
        currency: config.currency,
      });
    }
    return { facts, uncostable };
  };

  /** Every figure carries the moment it is true as of — the type will not let it not. */
  const at = (name: string, valueMinor: number | undefined, unit: Figure['unit'], because?: string): Figure =>
    figure({
      name,
      ...(valueMinor === undefined ? {} : { valueMinor }),
      unit,
      // The box computes at request time from its own log, so there is nothing between this figure
      // and the sales it came from to go stale. The sync clock is reported separately, because that
      // is a different question: how current is what the CLOUD told us.
      asAt: config.now,
      now: config.now,
      laggingAfterMinutes: config.laggingAfterMinutes,
      staleAfterMinutes: config.staleAfterMinutes,
      ...(because === undefined ? {} : { notAvailableBecause: because }),
    });

  const byKey = (
    keyOf: (sale: ReportableSale) => string,
  ): { figures: Figure[]; rows: Record<string, string>[] } => {
    const totals = new Map<string, { total: number; bills: number }>();
    for (const sale of ports.sales()) {
      const key = keyOf(sale);
      const held = totals.get(key) ?? { total: 0, bills: 0 };
      totals.set(key, { total: held.total + sale.totalMinor, bills: held.bills + 1 });
    }
    const ordered = [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return {
      figures: ordered.map(([key, t]) => at(key, t.total, 'minor_currency')),
      rows: ordered.map(([key, t]) => ({ key, totalMinor: String(t.total), bills: String(t.bills) })),
    };
  };

  /** The figures and rows for a report this shop CAN produce. */
  const produce = (reportId: string): { figures: Figure[]; rows: Record<string, string>[] } => {
    const sales = ports.sales();
    const { facts, uncostable } = costableFacts();
    const summary = salesSummary(facts, config.currency);

    switch (reportId) {
      case 'sales_by_day':
        return {
          figures: [
            at('Taken', sales.reduce((t, s) => t + s.totalMinor, 0), 'minor_currency'),
            at('Bills', sales.length, 'count'),
          ],
          rows: sales.map((s) => ({
            saleId: s.saleId, at: s.committedAt, totalMinor: String(s.totalMinor), tender: s.tender,
          })),
        };

      case 'sales_by_hour':
        // The hour in the shop's own recorded instant. Reading a local hour here would need a
        // timezone this screen has not been given, and a wrong one moves the evening peak.
        return byKey((s) => `${s.committedAt.slice(11, 13)}:00`);

      case 'sales_by_cashier':
        return byKey((s) => s.cashierId);

      case 'tender_mix':
        return byKey((s) => s.tender);

      case 'basket': {
        // Averaged only over the bills whose lines could actually be read. A record with no lines
        // still has real takings, so it counts towards the money average — but counting it as a
        // basket of zero items would pull the units figure down by an amount nobody could explain.
        const counted = sales.filter((s) => s.units !== undefined);
        const unitsTotal = counted.reduce((t, s) => t + (s.units as number), 0);
        return {
          figures: [
            at('Average basket', sales.length === 0
              ? undefined
              : Math.round(sales.reduce((t, s) => t + s.totalMinor, 0) / sales.length),
              'minor_currency',
              // No bills is not an average of zero. A shop that has not opened yet has no average
              // basket, and ₹0 would be quoted as one.
              sales.length === 0 ? 'the shop has taken no bills yet, so there is no average' : undefined),
            at('Units per basket', counted.length === 0
              ? undefined
              : Math.round(unitsTotal / counted.length),
              'count',
              counted.length === 0
                ? (sales.length === 0
                  ? 'the shop has taken no bills yet'
                  : 'no bill today has readable lines behind it')
                : undefined),
            // Reported beside it, never folded in, exactly as the margin report does.
            at('Bills with no readable lines', sales.length - counted.length, 'count'),
          ],
          rows: sales.map((s) => ({
            saleId: s.saleId,
            totalMinor: String(s.totalMinor),
            units: s.units === undefined ? 'not known' : String(s.units),
          })),
        };
      }

      case 'day_on_day': {
        // **The comparison, and the two ways it must refuse.**
        //
        // A number on its own says almost nothing: ₹1,40,000 is a good Saturday and a frightening
        // Tuesday, and the figure is identical. But a comparison invented out of a day that is not
        // there is worse than no comparison — a box installed yesterday would report the shop as
        // having doubled overnight, against a zero nobody put there.
        const days = ports.dayTotals();
        const today = days.find((d) => d.tradingDay === config.tradingDay);
        // Days strictly BEFORE today, so a box holding only future-dated junk cannot become the
        // thing today is measured against.
        const previous = days.filter((d) => d.tradingDay < config.tradingDay)[0];
        const why = today === undefined
          ? 'the shop has taken nothing today yet, so there is nothing to compare'
          : previous === undefined
            ? 'this store box holds no earlier trading day, so there is nothing to compare today against'
            : undefined;
        const change = why === undefined ? today!.totalMinor - previous!.totalMinor : undefined;
        return {
          figures: [
            at('Today', today?.totalMinor, 'minor_currency',
              today === undefined ? 'the shop has taken nothing today yet' : undefined),
            at(previous === undefined ? 'The day before' : `${previous.tradingDay}`,
              previous?.totalMinor, 'minor_currency',
              previous === undefined ? 'this store box holds no earlier trading day' : undefined),
            // Up or down in money, not as a percentage: a percentage off a small day is a big
            // number that means nothing, and this is a screen people quote from.
            at('Up or down', change, 'minor_currency', why),
          ],
          rows: days.map((d) => ({
            tradingDay: d.tradingDay, totalMinor: String(d.totalMinor), bills: String(d.bills),
          })),
        };
      }

      case 'units_by_category': {
        const units = ports.unitsByCategory();
        const names = ports.categoryNames();
        const unplaced = ports.unitsWithNoCategory();
        const ordered = Object.entries(units).sort((a, b) => b[1] - a[1]);
        return {
          figures: [
            ...ordered.map(([id, n]) => at(names?.[id] ?? id, n, 'count')),
            // Never folded into a department. A product the catalogue does not place is a catalogue
            // problem, and hiding it inside Grocery is how it stays one.
            ...(unplaced === 0 ? [] : [at('Items in no department', unplaced, 'count')]),
          ],
          rows: [
            ...ordered.map(([id, n]) => ({ department: names?.[id] ?? id, units: String(n) })),
            ...(unplaced === 0 ? [] : [{ department: 'in no department', units: String(unplaced) }]),
          ],
        };
      }

      case 'margin':
        return {
          figures: [
            at('Margin', facts.length === 0 ? undefined : summary.marginMinor, 'minor_currency',
              facts.length === 0 ? 'no sale on this day has a cost price behind it' : undefined),
            at('Margin %', facts.length === 0 ? undefined : summary.marginPctBps, 'basis_points',
              facts.length === 0 ? 'no sale on this day has a cost price behind it' : undefined),
            // Reported alongside, never folded in. The margin is over a subset and the reader is
            // told how big the subset is, rather than shown one number that is quietly both.
            at('Sales with no cost price', uncostable, 'count'),
          ],
          rows: facts.map((f) => ({
            saleId: f.saleId, netMinor: String(f.netMinor), cogsMinor: String(f.cogsMinor),
            marginMinor: String(f.netMinor - f.cogsMinor),
          })),
        };

      case 'sync_health':
        return {
          figures: [at('Not sent yet', ports.unsentCount(), 'count')],
          rows: [{ unsent: String(ports.unsentCount()) }],
        };

      case 'data_freshness': {
        const state = freshness(ports.lastSyncedAt(), config.now, config.staleAfterMinutes * 60);
        return {
          figures: [
            at('Minutes since head office last spoke to this shop',
              state.ageSeconds === null ? undefined : Math.round(state.ageSeconds / 60), 'count',
              // Never synced is not "0 minutes ago", which is the freshest possible answer.
              state.ageSeconds === null ? 'head office has never sent anything to this shop' : undefined),
          ],
          rows: [{ lastSyncedAt: state.lastSyncedAt ?? '', state: state.state }],
        };
      }

      case 'exceptions': {
        // Zero exceptions with no rules is not a clean shop; it is a shop nobody is watching.
        const known = ports.exceptionRulesKnown();
        const found = ports.exceptions();
        return {
          figures: [
            at('Things to look at', known ? found.length : undefined, 'count',
              known ? undefined : 'this shop has no loss-prevention limits set, so nothing was checked'),
          ],
          rows: found.map((e, i) => ({ n: String(i + 1), what: e.what })),
        };
      }

      default:
        // Unreachable: `run` and `export` both refuse before they get here, because `PRODUCED`
        // says what this switch handles and the catalogue is built from it. Throwing rather than
        // returning `{ figures: [], rows: [] }` is the whole point — an empty dashboard is
        // indistinguishable from a shop with nothing to report, and it would be served under the
        // report's real name with its real as-at stamp on nothing.
        throw new Error(`no producer for report "${reportId}" — it must not be in PRODUCED`);
    }
  };

  const entries = (): readonly CatalogueEntry[] => reportCatalogue(ports.records(), PRODUCED);

  return {
    catalogue: entries,

    backlog: () => whatWouldUnlockMost(ports.records(), PRODUCED),

    freshness: () => freshness(ports.lastSyncedAt(), config.now, config.staleAfterMinutes * 60),

    run: (reportId) => {
      const entry = entries().find((e) => e.report.id === reportId);
      if (entry === undefined) {
        return {
          ok: false, refusal: 'no_such_report', missing: [],
          detail: `there is no report called "${reportId}".`,
        };
      }
      if (!entry.availability.available) {
        // Refused rather than run and returned as zero. "Waste this month: ₹0" is a number
        // somebody puts in a board pack, and nobody reading it can tell it apart from a real one.
        //
        // Which of the two gaps it is decides who can do anything about it, so it is carried
        // through rather than flattened: the owner can start recording a fact, and no amount of
        // work in the shop writes the code for a report this build cannot compute.
        return {
          ok: false,
          refusal: entry.availability.blockedBy === 'the_shop_does_not_record_it'
            ? RUN_REFUSALS.this_shop_does_not_record_that_yet
            : RUN_REFUSALS.this_version_cannot_produce_that_yet,
          missing: entry.availability.missing,
          detail: `${entry.report.name} cannot be produced: ${entry.availability.why}.`,
        };
      }

      const { figures, rows } = produce(reportId);
      return { ok: true, report: entry.report, result: dashboard(figures, config.now), rows };
    },

    export: (reportId) => {
      // **Before anything else: does this box know who is asking?**
      //
      // Every file written here carries an audit record naming who took the data, and that record
      // is the only evidence of it afterwards. A default id would make the check pass or fail on a
      // name nobody holds — and on the day somebody asks who exported the customer list, the
      // answer would be a word this code made up.
      const userId = config.userId;
      if (userId === null) {
        return {
          ok: false,
          detail: 'this store box has not been told who is using this screen, so nothing can be written out. Nobody can be named in the record of who took it.',
        };
      }
      const entry = entries().find((e) => e.report.id === reportId);
      if (entry === undefined) return { ok: false, detail: `there is no report called "${reportId}".` };
      if (!entry.availability.available) {
        return { ok: false, detail: `${entry.report.name} cannot be produced: ${entry.availability.why}.` };
      }
      const declared = entry.report.columns;
      if (declared === undefined) {
        return { ok: false, detail: `${entry.report.name} has no declared columns, so there is nothing it may write out.` };
      }

      const { rows } = produce(reportId);

      // **A field nobody declared never leaves the building.**
      //
      // Deriving the spec from `Object.keys(rows[0])` would let a column added months later — a
      // customer's phone number appended for one screen — become a column in a file somebody
      // emails, with no reviewer ever seeing it. So an undeclared key refuses the whole export
      // rather than being dropped quietly: a silently narrower file is a file somebody reconciles
      // against and cannot explain.
      const undeclared = undeclaredColumns(rows, declared);
      if (undeclared.length > 0) {
        return {
          ok: false,
          detail: `${entry.report.name} produced ${undeclared.join(', ')}, which nobody has declared. Add it to the report's columns — and say whether it is personal data — before it can be exported.`,
        };
      }

      const spec: ExportSpec = {
        domain: entry.report.id,
        columns: declared.map((c) => ({
          name: c.name,
          type: c.type,
          ...(c.sensitive === undefined ? {} : { sensitive: c.sensitive }),
        })),
        requires: exportPermission(entry.report),
      };
      const context: ExportContext = {
        userId,
        branchId: config.branchId,
        at: config.now,
      };
      try {
        return exportDomain(spec, rows, ports.access(), context);
      } catch (e) {
        // Default-deny said no. Said plainly rather than thrown at a person who pressed a button.
        if (e instanceof AccessDeniedError) return { ok: false, detail: e.message };
        throw e;
      }
    },
  };
}
