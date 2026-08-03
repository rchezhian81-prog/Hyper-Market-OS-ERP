// Loss-prevention anomaly rules (M15-FR-01) — "control by exception" made concrete
// (P-03). Point activity (voids, refunds, discounts, no-sales, cash variances) at a
// set of CONFIGURABLE rules and get back the risky patterns as exceptions that LINK
// to the underlying transactions — surfaced to the owner, never acted on
// automatically (an AI fraud agent may summarise/prioritise, never sanction —
// AI-NFR-12). Rules are data, so a store tunes its own thresholds "without code"
// (M15-FR-01 acceptance). Pure and deterministic: no storage, no I/O, no clock —
// it computes signals over already-synced data, so it is trivially testable and
// order-stable.

/** The activity kinds a store watches for abuse (configurable per store/role). */
export type SignalKind = 'void' | 'refund' | 'discount' | 'no_sale' | 'cash_variance';

/** One piece of activity to evaluate; `txnId` is how an exception links back. */
export interface ActivityEvent {
  readonly txnId: string;
  readonly kind: SignalKind;
  readonly cashierId: string;
  /** Value in minor units (store currency); omit for kinds with no value (no_sale). */
  readonly valueMinor?: number;
  readonly at: string; // ISO-8601 UTC (used only for linkage/reporting)
}

/** A configurable threshold rule for one signal kind (any subset of limits). */
export interface LpRule {
  readonly kind: SignalKind;
  /** Anomaly when the count of this kind (per cashier) EXCEEDS this. */
  readonly maxCount?: number;
  /** Anomaly when the total value of this kind (per cashier) EXCEEDS this. */
  readonly maxTotalValueMinor?: number;
  /** Anomaly when a SINGLE event's value exceeds this (links that one txn). */
  readonly maxSingleValueMinor?: number;
  /** Observed ≥ limit × this ⇒ 'escalate' rather than 'flag' (a spike). */
  readonly escalateAtMultiple?: number;
}

export type BreachKind = 'count' | 'total_value' | 'single_value';
export type Severity = 'flag' | 'escalate';

/** A raised anomaly — linked to the transactions that triggered it. */
export interface LpException {
  readonly cashierId: string;
  readonly kind: SignalKind;
  readonly breach: BreachKind;
  /** The observed amount that breached (a count for 'count', minor units otherwise). */
  readonly observed: number;
  /** The configured limit that was exceeded. */
  readonly limit: number;
  readonly severity: Severity;
  readonly linkedTxnIds: readonly string[];
}

function severityFor(observed: number, limit: number, escalateAtMultiple?: number): Severity {
  if (escalateAtMultiple !== undefined && limit >= 0 && observed >= limit * escalateAtMultiple) {
    return 'escalate';
  }
  return 'flag';
}

/**
 * Evaluate activity against the store's loss-prevention rules and return every
 * anomaly, most-linked first is NOT assumed — output is deterministic: ordered by
 * cashier, then by the rule order, then count → total_value → single_value.
 * Only kinds with a matching rule are evaluated; a store enables the rules it wants.
 */
export function evaluateLossPrevention(
  events: readonly ActivityEvent[],
  rules: readonly LpRule[],
): LpException[] {
  const ruleByKind = new Map<SignalKind, LpRule>();
  for (const rule of rules) {
    ruleByKind.set(rule.kind, rule);
  }

  // Group events by cashier, preserving first-seen cashier order for stable output.
  const cashierOrder: string[] = [];
  const byCashier = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    let group = byCashier.get(event.cashierId);
    if (group === undefined) {
      group = [];
      byCashier.set(event.cashierId, group);
      cashierOrder.push(event.cashierId);
    }
    group.push(event);
  }

  const exceptions: LpException[] = [];
  for (const cashierId of cashierOrder) {
    const group = byCashier.get(cashierId) ?? [];
    // Evaluate in rule order so the output is stable and predictable.
    for (const rule of rules) {
      const matching = group.filter((e) => e.kind === rule.kind);
      if (matching.length === 0) continue;

      const count = matching.length;
      const totalValue = matching.reduce((sum, e) => sum + (e.valueMinor ?? 0), 0);
      const txnIds = matching.map((e) => e.txnId);

      if (rule.maxCount !== undefined && count > rule.maxCount) {
        exceptions.push({
          cashierId,
          kind: rule.kind,
          breach: 'count',
          observed: count,
          limit: rule.maxCount,
          severity: severityFor(count, rule.maxCount, rule.escalateAtMultiple),
          linkedTxnIds: txnIds,
        });
      }

      if (rule.maxTotalValueMinor !== undefined && totalValue > rule.maxTotalValueMinor) {
        exceptions.push({
          cashierId,
          kind: rule.kind,
          breach: 'total_value',
          observed: totalValue,
          limit: rule.maxTotalValueMinor,
          severity: severityFor(totalValue, rule.maxTotalValueMinor, rule.escalateAtMultiple),
          linkedTxnIds: txnIds,
        });
      }

      if (rule.maxSingleValueMinor !== undefined) {
        for (const e of matching) {
          const value = e.valueMinor ?? 0;
          if (value > rule.maxSingleValueMinor) {
            exceptions.push({
              cashierId,
              kind: rule.kind,
              breach: 'single_value',
              observed: value,
              limit: rule.maxSingleValueMinor,
              severity: severityFor(value, rule.maxSingleValueMinor, rule.escalateAtMultiple),
              linkedTxnIds: [e.txnId],
            });
          }
        }
      }
    }
  }

  return exceptions;
}
