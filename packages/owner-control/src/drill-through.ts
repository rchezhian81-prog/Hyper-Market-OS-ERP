// KPI comparison and drill-through (M29-FR-02 / NFR-15 / §28).
//
// The owner sees "margin down 4% in Fresh" and asks the only question worth asking:
// **show me.** Everything in this file exists to make that answer trustworthy, because
// a drill-through that looks right and is wrong is worse than no drill-through at all —
// the owner acts on it.
//
// Three properties, and each one is a decision the roadmap forces:
//
//   • **THE DRILL REACHES THE IMMUTABLE SOURCE** (NFR-15). It lists the actual
//     transactions from the append-only ledger, not rows from a summary table that
//     might have been rebuilt differently. A cached aggregate can drift from the events
//     behind it; the events cannot drift from themselves.
//
//   • **THE DRILL MUST RECONCILE TO THE KPI.** The transactions you land on must add up
//     to the number you clicked. If they do not, this module says so **loudly** instead
//     of showing a plausible list — a list that nearly explains the number is how an
//     owner spends a fortnight chasing a difference that was a reporting bug.
//
//   • **SCOPE IS ENFORCED ON THE DRILL, AND THE NUMBER CHANGES WITH IT.** A branch
//     manager drilling a company KPI sees their branch only — and the total they see
//     is recomputed to match, **with a line saying what was withheld and why**. Showing
//     a company total over a filtered list is how someone concludes their branch is
//     losing money that another branch actually made.
//
// Comparisons use the same governed metric definitions as the KPI itself, so "margin"
// means one thing everywhere (M29-FR-01).
//
// Pure and deterministic: transactions in, answer out. No clock, no I/O.

export type Dimension = 'branch' | 'category' | 'vendor' | 'staff';

/** One transaction as the immutable ledger holds it. */
export interface SourceTransaction {
  readonly transactionId: string;
  readonly at: string;
  readonly branchId: string;
  readonly categoryId?: string;
  readonly vendorId?: string;
  readonly staffId?: string;
  /** The measured amount in integer minor units (§29.1). */
  readonly amountMinor: number;
  readonly description: string;
}

/** What the viewer is allowed to see (§28). `'all'` is company-wide authority. */
export interface DataScope {
  readonly userId: string;
  readonly branchScope: readonly string[] | 'all';
}

export interface DrillRequest {
  readonly metric: string;
  /** The headline figure the owner clicked. */
  readonly kpiValueMinor: number;
  readonly transactions: readonly SourceTransaction[];
  readonly scope: DataScope;
}

export interface DrillResult {
  readonly metric: string;
  /** The transactions the viewer is entitled to see, newest first. */
  readonly transactions: readonly SourceTransaction[];
  /** Sum of the transactions actually shown. */
  readonly shownTotalMinor: number;
  /** The headline the owner clicked. */
  readonly kpiValueMinor: number;
  /** True when what is shown adds up to what was clicked. */
  readonly reconciles: boolean;
  readonly withheldCount: number;
  readonly withheldTotalMinor: number;
  readonly detail: string;
  /** Set when the shown rows do NOT add up to the headline. Never silent. */
  readonly discrepancy?: string;
}

function visibleTo(scope: DataScope, branchId: string): boolean {
  return scope.branchScope === 'all' || scope.branchScope.includes(branchId);
}

/**
 * Drill from a KPI to the transactions behind it, within the viewer's scope.
 *
 * When scope hides rows, the shown total is **recomputed** and the difference is stated
 * explicitly — the viewer is told a number exists that they cannot see, which is very
 * different from being shown a number that does not match its own list.
 */
export function drillThrough(request: DrillRequest): DrillResult {
  const allowed = request.transactions.filter((t) => visibleTo(request.scope, t.branchId));
  const withheld = request.transactions.filter((t) => !visibleTo(request.scope, t.branchId));

  const shownTotalMinor = allowed.reduce((s, t) => s + t.amountMinor, 0);
  const withheldTotalMinor = withheld.reduce((s, t) => s + t.amountMinor, 0);
  const sorted = [...allowed].sort((a, b) => b.at.localeCompare(a.at) || a.transactionId.localeCompare(b.transactionId));

  // Within scope, the rows must add up to the headline. Out of scope, the headline is
  // legitimately larger — and by exactly what was withheld.
  const expected = request.kpiValueMinor - withheldTotalMinor;
  const reconciles = shownTotalMinor === expected;

  const base = {
    metric: request.metric,
    transactions: sorted,
    shownTotalMinor,
    kpiValueMinor: request.kpiValueMinor,
    withheldCount: withheld.length,
    withheldTotalMinor,
    reconciles,
  };

  if (!reconciles) {
    // Loud, not silent. A list that nearly explains a number is worse than no list.
    const gap = shownTotalMinor - expected;
    return {
      ...base,
      detail: `${sorted.length} transaction(s), totalling ${shownTotalMinor}`,
      discrepancy: `THESE TRANSACTIONS DO NOT ADD UP TO THE FIGURE THEY CAME FROM: ${shownTotalMinor} shown against ${expected} expected, a gap of ${gap}. Do not act on this until it is explained — the reporting is wrong, or the drill is looking at the wrong thing.`,
    };
  }

  return {
    ...base,
    detail:
      withheld.length === 0
        ? `${sorted.length} transaction(s), totalling ${shownTotalMinor} — exactly the figure you clicked`
        : `${sorted.length} transaction(s) you can see, totalling ${shownTotalMinor}. A further ${withheld.length} transaction(s) worth ${withheldTotalMinor} are in branches outside your access and are not shown — the headline figure includes them`,
  };
}

export interface ComparisonRow {
  readonly key: string;
  readonly label: string;
  readonly valueMinor: number;
  readonly transactionCount: number;
  /** Share of the visible total, in basis points — exact, never a float percentage. */
  readonly shareBps: number;
}

export interface ComparisonResult {
  readonly dimension: Dimension;
  readonly metric: string;
  readonly rows: readonly ComparisonRow[];
  readonly totalMinor: number;
  /** True when the rows sum to the total. Always checked, never assumed. */
  readonly reconciles: boolean;
  readonly detail: string;
}

function keyOf(t: SourceTransaction, dimension: Dimension): string | undefined {
  switch (dimension) {
    case 'branch':
      return t.branchId;
    case 'category':
      return t.categoryId;
    case 'vendor':
      return t.vendorId;
    case 'staff':
      return t.staffId;
  }
}

/**
 * Rank a metric across a dimension. **Comparisons reconcile to the KPI** — the rows are
 * built from the same transactions the drill would show, so ranking and drilling can
 * never disagree.
 *
 * Transactions with no value for the dimension are grouped as `unattributed` rather than
 * dropped: quietly discarding them makes the rows sum to less than the total, and
 * whoever notices assumes the missing money went somewhere specific.
 */
export function compareBy(input: {
  readonly dimension: Dimension;
  readonly metric: string;
  readonly transactions: readonly SourceTransaction[];
  readonly scope: DataScope;
  readonly labels?: Readonly<Record<string, string>>;
}): ComparisonResult {
  const allowed = input.transactions.filter((t) => visibleTo(input.scope, t.branchId));
  const groups = new Map<string, SourceTransaction[]>();
  for (const t of allowed) {
    const key = keyOf(t, input.dimension) ?? 'unattributed';
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  const totalMinor = allowed.reduce((s, t) => s + t.amountMinor, 0);
  const rows = [...groups]
    .map(([key, rowTransactions]): ComparisonRow => {
      const valueMinor = rowTransactions.reduce((s, t) => s + t.amountMinor, 0);
      return {
        key,
        label:
          input.labels?.[key] ??
          (key === 'unattributed' ? 'Unattributed — no value recorded for this dimension' : key),
        valueMinor,
        transactionCount: rowTransactions.length,
        // Exact basis points via BigInt, never a floating-point percentage (§29.1).
        shareBps: totalMinor === 0 ? 0 : Number((BigInt(valueMinor) * 10_000n) / BigInt(totalMinor)),
      };
    })
    .sort((a, b) => b.valueMinor - a.valueMinor || a.key.localeCompare(b.key));

  const rowSum = rows.reduce((s, r) => s + r.valueMinor, 0);
  const reconciles = rowSum === totalMinor;

  return {
    dimension: input.dimension,
    metric: input.metric,
    rows,
    totalMinor,
    reconciles,
    detail: reconciles
      ? `${rows.length} ${input.dimension} group(s) totalling ${totalMinor}`
      : `the ${input.dimension} rows total ${rowSum} against ${totalMinor} — they do not reconcile and must not be published`,
  };
}

export interface DrillAudit {
  readonly userId: string;
  readonly metric: string;
  readonly at: string;
  readonly transactionsShown: number;
  readonly transactionsWithheld: number;
  readonly reconciled: boolean;
}

/**
 * Every drill is logged (M29-FR-02 audit). Drilling reaches individual transactions and,
 * through them, individual people's work — so who looked at what is itself a record
 * worth keeping.
 */
export function auditDrill(result: DrillResult, scope: DataScope, at: string): DrillAudit {
  return {
    userId: scope.userId,
    metric: result.metric,
    at,
    transactionsShown: result.transactions.length,
    transactionsWithheld: result.withheldCount,
    reconciled: result.reconciles,
  };
}
