// Owner executive brief (M29 / D13) — the application model behind the owner's home
// screen (`docs/design/screens/owner-command-centre.md`). The owner's job is to
// decide, check and approve, so this is **control by exception** (P-03): it composes
// the tested engines into (a) the day's numbers, (b) the THREE things that actually
// need attention, and (c) the approvals waiting on him — never raw noise.
//
// Two honesty rules are structural here:
//   • FRESHNESS — every brief carries the data's freshness state, and a stale or
//     missing feed is labelled as such, never presented as live (P-08 / §31);
//   • DETERMINISTIC — the brief is built from committed facts by pure code, so it
//     still works with the AI narrative off (spec acceptance) and two people looking
//     at the same data always see the same brief.
//
// Alerts are GROUPED so a spike becomes one line with a count rather than an alert
// storm, and every group keeps the linked transaction ids so any number drills to
// its source (M29-FR-02).

import { salesSummary, freshness, type SaleFact, type SalesSummary, type Freshness } from '../../../packages/reporting/src/index';
import type { LpException, Severity, SignalKind } from '../../../packages/loss-prevention/src/index';

/** An approval waiting on the owner (from the maker-checker engine, M02). */
export interface PendingApproval {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly requestedBy: string;
  /** Value in minor units, or null when the request has no monetary value. */
  readonly valueMinor: number | null;
}

/** A grouped alert — one line per (kind, severity), not one per transaction. */
export interface AlertGroup {
  readonly kind: SignalKind;
  readonly severity: Severity;
  /** How many exceptions of this kind/severity were raised. */
  readonly count: number;
  /** Total observed value where the breach was value-based (minor units). */
  readonly totalValueMinor: number;
  /** Every transaction behind the group — the drill-through target. */
  readonly linkedTxnIds: readonly string[];
  /** Plain-English line for the brief. */
  readonly sentence: string;
}

/** One of the three things needing attention, in priority order. */
export interface AttentionItem {
  readonly rank: 1 | 2 | 3;
  readonly source: 'exception' | 'approval';
  readonly sentence: string;
  /** What to open when the owner taps it. */
  readonly ref: string;
}

export interface BuildBriefInput {
  readonly asOf: string;
  /** When this branch's data last reached the cloud; null if it never has. */
  readonly lastSyncedAt: string | null;
  /** Seconds after which the feed counts as stale (per-tenant). */
  readonly staleAfterSeconds: number;
  readonly sales: readonly SaleFact[];
  readonly exceptions: readonly LpException[];
  readonly approvals: readonly PendingApproval[];
  /**
   * Round 4 (P-08): today's bills the store computer could NOT cost (a product with no cost in its setup) — their takings
   * are real and are shown; only their margin is not known. Absent / zero bills = every bill was costed.
   */
  readonly uncosted?: { readonly bills: number; readonly takenMinor: number; readonly tenderMix: Readonly<Record<string, number>> };
}

export interface OwnerBrief {
  readonly asOf: string;
  /** The day's numbers, computed exactly from committed sales. */
  readonly kpis: SalesSummary;
  /**
   * Round 4: EVERY bill today and what they took, by tender — the costed ones (in `kpis`) and the ones whose margin is not
   * known (`marginUnknownBills`) together. The takings are never hidden because a cost is missing.
   */
  readonly takings: { readonly bills: number; readonly takenMinor: number; readonly tenderMix: Readonly<Record<string, number>>; readonly marginUnknownBills: number };
  /** How current the numbers are — always shown, never implied (P-08). */
  readonly freshness: Freshness;
  /** Plain-sentence summary of the day, numbers beside the words. */
  readonly headline: string;
  /** The three things needing attention (fewer if there are fewer). */
  readonly attention: readonly AttentionItem[];
  /** Grouped alerts, worst first — each drills to its transactions. */
  readonly alerts: readonly AlertGroup[];
  /** Approvals waiting on the owner, highest value first. */
  readonly approvals: readonly PendingApproval[];
}

/** Format minor units as a plain rupee string for the brief's sentences. */
function rupees(minor: number): string {
  return `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const KIND_WORDS: Readonly<Record<SignalKind, string>> = Object.freeze({
  void: 'voided bills',
  refund: 'refunds',
  discount: 'discounts',
  no_sale: 'no-sale drawer opens',
  cash_variance: 'cash variances',
});

/** Group exceptions by (kind, severity) so a spike is one line, not a storm. */
function groupAlerts(exceptions: readonly LpException[]): AlertGroup[] {
  const groups = new Map<string, { kind: SignalKind; severity: Severity; count: number; totalValueMinor: number; linked: string[] }>();

  for (const exception of exceptions) {
    const key = `${exception.kind}|${exception.severity}`;
    const existing = groups.get(key) ?? {
      kind: exception.kind,
      severity: exception.severity,
      count: 0,
      totalValueMinor: 0,
      linked: [],
    };
    existing.count += 1;
    // Only value-based breaches contribute a value; a count breach does not.
    if (exception.breach !== 'count') {
      existing.totalValueMinor += exception.observed;
    }
    for (const txnId of exception.linkedTxnIds) {
      if (!existing.linked.includes(txnId)) existing.linked.push(txnId);
    }
    groups.set(key, existing);
  }

  return [...groups.values()]
    .map((g) => ({
      kind: g.kind,
      severity: g.severity,
      count: g.count,
      totalValueMinor: g.totalValueMinor,
      linkedTxnIds: g.linked,
      // Lead with what the owner cares about: the money, then how many bills.
      sentence:
        `${g.severity === 'escalate' ? 'Urgent: ' : ''}${KIND_WORDS[g.kind]} over the limit` +
        (g.totalValueMinor > 0 ? ` — ${rupees(g.totalValueMinor)} across` : ' —') +
        ` ${g.linked.length} transaction${g.linked.length === 1 ? '' : 's'}.`,
    }))
    // Worst first: escalations, then the larger value, then the larger count.
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'escalate' ? -1 : 1;
      if (a.totalValueMinor !== b.totalValueMinor) return b.totalValueMinor - a.totalValueMinor;
      return b.count - a.count;
    });
}

/** Pick the three things that most need the owner, alerts outranking approvals. */
function pickAttention(alerts: readonly AlertGroup[], approvals: readonly PendingApproval[]): AttentionItem[] {
  const candidates: { source: 'exception' | 'approval'; sentence: string; ref: string }[] = [
    ...alerts.map((a) => ({ source: 'exception' as const, sentence: a.sentence, ref: `${a.kind}:${a.severity}` })),
    ...approvals.map((a) => ({
      source: 'approval' as const,
      sentence:
        `Approval waiting: ${a.subjectType.replace(/_/g, ' ')} from ${a.requestedBy}` +
        (a.valueMinor !== null ? ` for ${rupees(a.valueMinor)}` : '') + '.',
      ref: a.id,
    })),
  ];
  return candidates.slice(0, 3).map((c, i) => ({ rank: (i + 1) as 1 | 2 | 3, ...c }));
}

/**
 * Build the owner's brief from committed facts. Pure and deterministic — no clock,
 * no I/O, no AI — so it always renders, and it renders the same for everyone.
 */
export function buildBrief(input: BuildBriefInput): OwnerBrief {
  const kpis = salesSummary(input.sales);
  const dataFreshness = freshness(input.lastSyncedAt, input.asOf, input.staleAfterSeconds);
  const alerts = groupAlerts(input.exceptions);
  // Highest value first, so the biggest decision is at the top of the inbox.
  const approvals = [...input.approvals].sort((a, b) => (b.valueMinor ?? 0) - (a.valueMinor ?? 0));

  const staleNote =
    dataFreshness.state === 'fresh'
      ? ''
      : dataFreshness.state === 'stale'
        ? ' These numbers are NOT live — the branch has not synced recently.'
        : ' No data has synced from this branch yet.';

  const unc = input.uncosted !== undefined && input.uncosted.bills > 0 ? input.uncosted : undefined;
  const tenderMix: Record<string, number> = { ...kpis.tenderMix };
  for (const [kind, minor] of Object.entries(unc?.tenderMix ?? {})) tenderMix[kind] = (tenderMix[kind] ?? 0) + minor;
  const takings = {
    bills: kpis.basketCount + (unc?.bills ?? 0),
    takenMinor: kpis.grossSalesMinor + (unc?.takenMinor ?? 0),
    tenderMix,
    marginUnknownBills: unc?.bills ?? 0,
  };
  const plural = (n: number): string => `${n} bill${n === 1 ? '' : 's'}`;
  // Round 4 (P-08): a bill whose margin cannot be worked out is still a sale — its takings are said, and so is the fact
  // that its margin is not known. Never "No sales recorded" while the till took money.
  const headline =
    takings.bills === 0
      ? `No sales recorded yet today.${staleNote}`
      : kpis.basketCount === 0
        ? `${plural(takings.bills)} today, ${rupees(takings.takenMinor)} taken — margin not known: ` +
          `the store computer has no cost for products on ${unc!.bills === 1 ? 'this bill' : 'these bills'}.${staleNote}`
        : `${plural(kpis.basketCount)} today, ` +
          `${rupees(kpis.grossSalesMinor)} taken, ` +
          `margin ${rupees(kpis.marginMinor)} (${(kpis.marginPctBps / 100).toFixed(1)}%), ` +
          `average basket ${rupees(kpis.avgBasketMinor)}.` +
          (unc === undefined ? '' : ` Also ${plural(unc.bills)} (${rupees(unc.takenMinor)}) whose margin is not known — products with no cost.`) +
          staleNote;

  return {
    asOf: input.asOf,
    kpis,
    takings,
    freshness: dataFreshness,
    headline,
    attention: pickAttention(alerts, approvals),
    alerts,
    approvals,
  };
}
