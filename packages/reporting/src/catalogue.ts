// The report catalogue (D13 / M29-FR-01) — what this system can report on, and what it cannot yet.
//
// D13 names about thirty report families. A handful of them can be produced from what this shop
// actually records today; most of them need a producer that does not exist yet. Both facts have to
// be on the screen, and the second one is the more important of the two.
//
// ── Why an unavailable report must be listed, not hidden ────────────────────
//
// A reporting screen showing only the reports that work looks finished. Somebody asks for shrinkage
// by category, finds nothing, and concludes the shop has no shrinkage — or that the software
// forgot. Both readings are wrong, and neither can be corrected by anybody looking at the screen.
//
// So every report D13 names is listed, and one that cannot be produced says **which fact is
// missing**, in the shop's own language: *nobody records what is thrown away yet*. That list is the
// build backlog stated in business terms, and it is the most useful thing on the screen until the
// producers exist.
//
// ── And why it is never a zero ──────────────────────────────────────────────
//
// The alternative — running the report and returning zero — is the fault this codebase keeps
// finding, in its most quotable form. "Waste this month: ₹0" is a number somebody puts in a board
// pack. `figure()` already refuses to substitute a zero for an absent value; this file refuses to
// even offer the report.
//
// Pure and deterministic: no clock, no I/O. The caller says what the shop records.

/** The families D13 groups its reports into. */
export type ReportFamily =
  | 'sales'
  | 'purchasing'
  | 'stock'
  | 'customer'
  | 'fulfilment'
  | 'finance'
  | 'operations';

/**
 * A fact the shop must be recording before a report can be produced.
 *
 * Named as **things a shop does**, not as tables or streams: the person reading the unavailable
 * list is the person who can decide to start recording them, and "no `waste_events` producer" tells
 * them nothing they can act on.
 */
export type Producer =
  | 'sales_rung_at_the_till'
  | 'cost_prices_on_the_catalogue'
  | 'departments_on_the_catalogue'
  | 'what_was_ordered_from_suppliers'
  | 'what_arrived_from_suppliers'
  | 'supplier_invoices_captured'
  | 'stock_counted_on_the_shelves'
  | 'stock_movements_recorded'
  | 'what_is_thrown_away_recorded'
  | 'expiry_dates_recorded'
  | 'customers_identified_at_the_till'
  | 'loyalty_points_accrued'
  | 'campaigns_and_complaints_recorded'
  | 'online_orders_and_deliveries'
  | 'the_boxs_own_outbox'
  | 'journals_posted_to_the_ledger'
  | 'bank_and_gateway_statements'
  | 'ai_decisions_recorded';

/** Plain-English names for the producers, for the screen and for the owner's backlog. */
export const PRODUCER_WORDS: Readonly<Record<Producer, string>> = Object.freeze({
  sales_rung_at_the_till: 'sales rung at the till',
  cost_prices_on_the_catalogue: 'cost prices on the catalogue',
  departments_on_the_catalogue: 'a department against every product on the catalogue',
  what_was_ordered_from_suppliers: 'what was ordered from suppliers',
  what_arrived_from_suppliers: 'what arrived from suppliers',
  supplier_invoices_captured: 'supplier invoices captured',
  stock_counted_on_the_shelves: 'stock counted on the shelves',
  stock_movements_recorded: 'stock movements recorded',
  what_is_thrown_away_recorded: 'what is thrown away recorded',
  expiry_dates_recorded: 'expiry dates recorded',
  customers_identified_at_the_till: 'customers identified at the till',
  loyalty_points_accrued: 'loyalty points accrued',
  campaigns_and_complaints_recorded: 'campaigns and complaints recorded',
  online_orders_and_deliveries: 'online orders and deliveries',
  the_boxs_own_outbox: 'the store box’s own queue of unsent work',
  journals_posted_to_the_ledger: 'journals posted to the ledger',
  bank_and_gateway_statements: 'bank and card-machine statements',
  ai_decisions_recorded: 'decisions the AI assistant proposed',
});

/** A column a report may write out. Declared, never inferred — see `columns` below. */
export interface ReportColumn {
  readonly name: string;
  readonly type: 'text' | 'integer' | 'money_minor' | 'date' | 'enum';
  /** PII or payment data: redacted on export unless the user may see sensitive data (PRV). */
  readonly sensitive?: boolean;
}

export interface ReportDefinition {
  readonly id: string;
  readonly family: ReportFamily;
  /** What it is called on the screen. */
  readonly name: string;
  /** The question it answers, in one sentence a shopkeeper would use. */
  readonly answers: string;
  /** Everything that must be recorded before it can be produced at all. */
  readonly needs: readonly Producer[];
  /**
   * The columns this report may write out, **declared here rather than read off the rows**.
   *
   * Deriving the export's columns from whatever the producer happened to return is how a field
   * added months later rides out of the building unnoticed — a customer's phone number appended to
   * a row for one screen becomes a column in a file somebody emails. Declaring them means a new
   * field has to be added here, in front of a reviewer, and marked sensitive if it is.
   *
   * Absent for a report nothing can produce yet: there is nothing to declare until there is.
   */
  readonly columns?: readonly ReportColumn[];
}

/**
 * The permission a report's export needs.
 *
 * Per family rather than per report — that is the grain roles are actually written at, and a
 * permission nobody can hold is a permission nobody grants correctly.
 */
export function exportPermission(report: ReportDefinition): string {
  return `reporting.${report.family}.export`;
}

/**
 * The catalogue D13 asks for.
 *
 * Deliberately complete rather than trimmed to what works: the missing half is the point. Every
 * line of §D13 is represented, so a report nobody can run is visible as a report nobody can run
 * rather than as an absence somebody has to notice.
 */
export const REPORTS: readonly ReportDefinition[] = Object.freeze([
  // ── sales ────────────────────────────────────────────────────────────────
  {
    id: 'sales_by_day', family: 'sales', name: 'Sales by day',
    answers: 'what the shop took, and on how many bills',
    needs: ['sales_rung_at_the_till'],
    columns: [{ name: 'saleId', type: 'text' }, { name: 'at', type: 'date' }, { name: 'totalMinor', type: 'money_minor' }, { name: 'tender', type: 'enum' }]
  },
  {
    id: 'sales_by_hour', family: 'sales', name: 'Sales by hour',
    answers: 'when the shop is busy, so the rota can match it',
    needs: ['sales_rung_at_the_till'],
    columns: [{ name: 'key', type: 'text' }, { name: 'totalMinor', type: 'money_minor' }, { name: 'bills', type: 'integer' }]
  },
  {
    id: 'sales_by_cashier', family: 'sales', name: 'Sales by cashier',
    answers: 'what each person on the tills took',
    needs: ['sales_rung_at_the_till'],
    columns: [{ name: 'key', type: 'text' }, { name: 'totalMinor', type: 'money_minor' }, { name: 'bills', type: 'integer' }]
  },
  {
    id: 'tender_mix', family: 'sales', name: 'How people paid',
    answers: 'how much came in as cash, card and UPI',
    needs: ['sales_rung_at_the_till'],
    columns: [{ name: 'key', type: 'enum' }, { name: 'totalMinor', type: 'money_minor' }, { name: 'bills', type: 'integer' }]
  },
  {
    id: 'basket', family: 'sales', name: 'Average basket',
    answers: 'what a customer spends in one visit',
    needs: ['sales_rung_at_the_till'],
    columns: [{ name: 'saleId', type: 'text' }, { name: 'totalMinor', type: 'money_minor' }, { name: 'units', type: 'integer' }]
  },
  {
    id: 'day_on_day', family: 'sales', name: 'Today against the last day we traded',
    answers: 'whether today is better or worse than the day before, and by how much',
    needs: ['sales_rung_at_the_till'],
    columns: [{ name: 'tradingDay', type: 'date' }, { name: 'totalMinor', type: 'money_minor' }, { name: 'bills', type: 'integer' }]
  },
  {
    id: 'units_by_category', family: 'sales', name: 'What is selling, by department',
    answers: 'how many items each department sold today',
    needs: ['sales_rung_at_the_till', 'departments_on_the_catalogue'],
    columns: [{ name: 'department', type: 'text' }, { name: 'units', type: 'integer' }]
  },
  {
    id: 'margin', family: 'sales', name: 'Margin',
    answers: 'what the shop kept after what the goods cost',
    needs: ['sales_rung_at_the_till', 'cost_prices_on_the_catalogue'],
    columns: [{ name: 'saleId', type: 'text' }, { name: 'netMinor', type: 'money_minor' }, { name: 'cogsMinor', type: 'money_minor' }, { name: 'marginMinor', type: 'money_minor' }]
  },

  // ── purchasing ───────────────────────────────────────────────────────────
  {
    id: 'purchases_by_supplier', family: 'purchasing', name: 'Purchases by supplier',
    answers: 'what the shop has ordered from each supplier',
    needs: ['what_was_ordered_from_suppliers'],
  },
  {
    id: 'supplier_service', family: 'purchasing', name: 'Supplier service',
    answers: 'who delivers what they promised, and who does not',
    needs: ['what_was_ordered_from_suppliers', 'what_arrived_from_suppliers'],
  },
  {
    id: 'invoice_differences', family: 'purchasing', name: 'Invoice differences',
    answers: 'where a supplier billed for something other than what arrived',
    needs: ['what_was_ordered_from_suppliers', 'what_arrived_from_suppliers', 'supplier_invoices_captured'],
  },

  // ── stock ────────────────────────────────────────────────────────────────
  {
    id: 'stock_on_hand', family: 'stock', name: 'Stock on hand',
    answers: 'what the shop is holding, and what it is worth',
    needs: ['stock_movements_recorded', 'cost_prices_on_the_catalogue'],
  },
  {
    id: 'shrinkage', family: 'stock', name: 'Shrinkage',
    answers: 'the difference between what the books say and what is on the shelf',
    needs: ['stock_movements_recorded', 'stock_counted_on_the_shelves'],
  },
  {
    id: 'expiry', family: 'stock', name: 'Approaching expiry',
    answers: 'what will go out of date before it sells',
    needs: ['expiry_dates_recorded', 'stock_movements_recorded'],
  },
  {
    id: 'waste', family: 'stock', name: 'Waste',
    answers: 'what was thrown away, and what it cost',
    needs: ['what_is_thrown_away_recorded', 'cost_prices_on_the_catalogue'],
  },

  // ── customer ─────────────────────────────────────────────────────────────
  {
    id: 'customer_repeat', family: 'customer', name: 'Customers coming back',
    answers: 'how many shoppers return, and how often',
    needs: ['customers_identified_at_the_till'],
  },
  {
    id: 'loyalty', family: 'customer', name: 'Loyalty',
    answers: 'points earned and spent, and what they cost the shop',
    needs: ['loyalty_points_accrued'],
  },
  {
    id: 'marketing', family: 'customer', name: 'Campaigns and complaints',
    answers: 'what the shop sent out and what came back',
    needs: ['campaigns_and_complaints_recorded'],
  },

  // ── fulfilment ───────────────────────────────────────────────────────────
  {
    id: 'orders_and_substitutions', family: 'fulfilment', name: 'Online orders',
    answers: 'what was ordered online, and what had to be swapped',
    needs: ['online_orders_and_deliveries'],
  },
  {
    id: 'delivery_sla', family: 'fulfilment', name: 'Deliveries on time',
    answers: 'how many deliveries arrived inside the slot the customer booked',
    needs: ['online_orders_and_deliveries'],
  },
  {
    id: 'delivery_contribution', family: 'fulfilment', name: 'What a delivery earns',
    answers: 'whether a delivery is worth making once the driving is paid for',
    needs: ['online_orders_and_deliveries', 'cost_prices_on_the_catalogue'],
  },

  // ── finance ──────────────────────────────────────────────────────────────
  {
    id: 'gst', family: 'finance', name: 'GST',
    answers: 'tax collected and tax paid, by rate',
    needs: ['journals_posted_to_the_ledger'],
  },
  {
    id: 'reconciliation', family: 'finance', name: 'Money in the bank',
    answers: 'whether what the till took reached the bank',
    needs: ['sales_rung_at_the_till', 'bank_and_gateway_statements'],
  },
  {
    id: 'profitability', family: 'finance', name: 'Profitability',
    answers: 'what the shop made after everything',
    needs: ['journals_posted_to_the_ledger', 'cost_prices_on_the_catalogue'],
  },

  // ── operations ───────────────────────────────────────────────────────────
  {
    id: 'sync_health', family: 'operations', name: 'Anything not sent yet',
    answers: 'work this shop has done that has not reached head office',
    needs: ['the_boxs_own_outbox'],
    columns: [{ name: 'unsent', type: 'integer' }]
  },
  {
    id: 'data_freshness', family: 'operations', name: 'How current these figures are',
    answers: 'when each number on this screen was last true',
    needs: ['the_boxs_own_outbox'],
    columns: [{ name: 'lastSyncedAt', type: 'date' }, { name: 'state', type: 'enum' }]
  },
  {
    id: 'exceptions', family: 'operations', name: 'Things that need a look',
    answers: 'voids, refunds and no-sales outside the shop’s own limits',
    needs: ['sales_rung_at_the_till'],
    columns: [{ name: 'n', type: 'integer' }, { name: 'what', type: 'text' }]
  },
  {
    id: 'ai_outcomes', family: 'operations', name: 'What the assistant suggested',
    answers: 'what the AI proposed, and what a person decided',
    needs: ['ai_decisions_recorded'],
  },
]);

/**
 * Why a report cannot be run — and **these are two different problems with two different owners.**
 *
 * `the_shop_does_not_record_it` is the shop's to fix: start recording the fact and the report
 * begins working. `this_version_cannot_produce_it` is ours: the shop records everything the report
 * needs and this build has no code that computes it. Collapsing the two into one "not available"
 * would put a job on the owner's list that no amount of work in the shop can ever complete.
 */
export type Blocker = 'the_shop_does_not_record_it' | 'this_version_cannot_produce_it';

export type Availability =
  | { readonly available: true }
  | {
    readonly available: false;
    readonly blockedBy: Blocker;
    /** The producers this shop does not have yet. Named, so the list is actionable. Empty when the shop records everything and the gap is ours. */
    readonly missing: readonly Producer[];
    /** One sentence for the screen, in the shop's own language. */
    readonly why: string;
  };

/**
 * Can this report be produced — by this shop's records **and** by this build?
 *
 * `records` is what the caller genuinely has — never a wish list. Everything absent from it is
 * reported by name, because "no data" tells the reader nothing and "nobody records what is thrown
 * away yet" tells them exactly what has to change.
 *
 * `produced` is the second half, and it is required rather than optional **on purpose**. Every
 * report here is a report D13 names; only some of them have code behind them today. A default of
 * "assume this build can compute anything" would let a report open with no figures and no rows the
 * moment a tenant started recording its facts — and an empty shrinkage report reads as *no
 * shrinkage*, which is the exact reading this whole file exists to prevent. So the caller has to
 * say what it can actually compute, and cannot get that wrong by leaving an argument off.
 */
export function availability(
  report: ReportDefinition,
  records: readonly Producer[],
  produced: readonly string[],
): Availability {
  const have = new Set(records);
  const missing = report.needs.filter((need) => !have.has(need));
  if (missing.length > 0) {
    return {
      available: false,
      blockedBy: 'the_shop_does_not_record_it',
      missing,
      why: `nothing yet records ${missing.map((m) => PRODUCER_WORDS[m]).join(', and ')}`,
    };
  }
  if (!produced.includes(report.id)) {
    return {
      available: false,
      blockedBy: 'this_version_cannot_produce_it',
      missing: [],
      why: 'this shop records everything this report needs, but this version of the software cannot work it out yet',
    };
  }
  return { available: true };
}

export interface CatalogueEntry {
  readonly report: ReportDefinition;
  readonly availability: Availability;
}

/**
 * The whole catalogue, in the order a person would read it: **what works first**, then what the
 * shop itself can unlock, then what only a new version can.
 *
 * That middle group is deliberately ahead of the last one. The first two are things the owner can
 * act on this week; the third is a job on our side that no amount of work in the shop will finish,
 * and putting it in with the rest would have him chasing something that cannot move.
 *
 * The unavailable half is never dropped. A screen showing only the reports that work looks
 * finished, and somebody who cannot find shrinkage concludes the shop has none.
 */
export function reportCatalogue(
  records: readonly Producer[],
  produced: readonly string[],
): readonly CatalogueEntry[] {
  const rank = (a: Availability): number =>
    a.available ? 0 : a.blockedBy === 'the_shop_does_not_record_it' ? 1 : 2;
  return REPORTS
    .map((report) => ({ report, availability: availability(report, records, produced) }))
    .sort((a, b) => {
      const order = rank(a.availability) - rank(b.availability);
      if (order !== 0) return order;
      if (a.report.family !== b.report.family) return a.report.family.localeCompare(b.report.family);
      return a.report.name.localeCompare(b.report.name);
    });
}

/**
 * What the shop would have to start recording to unlock the most reports.
 *
 * Ordered by how many reports each one unlocks, because that is the question the owner is actually
 * asking when they look at a list of things they cannot see: *what do I do first?*
 */
export function whatWouldUnlockMost(
  records: readonly Producer[],
  produced: readonly string[],
): readonly { readonly producer: Producer; readonly unlocks: number; readonly reports: readonly string[] }[] {
  const have = new Set(records);
  const blocked = REPORTS
    // A report this build cannot compute is left out entirely. Telling the owner that recording
    // expiry dates unlocks a report that would then open blank is worse than telling him nothing:
    // he does the work, opens the report, and finds it empty with no explanation anywhere.
    .filter((report) => produced.includes(report.id))
    .map((report) => ({ report, missing: report.needs.filter((n) => !have.has(n)) }))
    .filter((r) => r.missing.length > 0);

  const counts = new Map<Producer, string[]>();
  for (const { report, missing } of blocked) {
    // Only counts where it is the LAST thing missing. A producer that unblocks nothing on its own
    // is not the thing to do first, however many reports mention it — and a list ranked by
    // mentions would send somebody to build the one that changes nothing.
    if (missing.length !== 1) continue;
    const only = missing[0]!;
    counts.set(only, [...(counts.get(only) ?? []), report.name]);
  }

  return [...counts.entries()]
    .map(([producer, reports]) => ({ producer, unlocks: reports.length, reports }))
    .sort((a, b) => (b.unlocks === a.unlocks ? a.producer.localeCompare(b.producer) : b.unlocks - a.unlocks));
}
