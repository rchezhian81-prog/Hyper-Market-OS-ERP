// Owner thresholds, exception alerts and the approval inbox (M29-FR-03 / §31.1 / §28).
//
// The owner carries a phone, not a dashboard. Everything here is written for someone
// who will read it in a car park, and the failure mode is not "too little information"
// — it is **too much**. An owner who gets forty alerts a day stops reading alerts, and
// the one that mattered arrives into a habit of ignoring them. So:
//
//   • **ALERTS ARE GROUPED, NOT STREAMED.** Six voided bills on one lane is *one* alert
//     with a count and a value, keeping every transaction id for the drill-through.
//     The roadmap names the five that matter (Annexure H): large discount, voided bill,
//     price override, after-hours login, cash short.
//
//   • **THRESHOLDS ARE THE OWNER'S.** Every number is configuration. A ₹500 discount is
//     routine in one shop and a scandal in another, and neither belongs in our code.
//
//   • **A PENDING APPROVAL THAT THE WORLD HAS OVERTAKEN IS FLAGGED, NOT SHOWN AS
//     LIVE** (§31.1). The owner approves a price change on Tuesday that was superseded
//     on Monday; committing it would silently undo the newer one. The inbox notices the
//     subject moved on and says so instead of offering a confident button.
//
//   • **ONE TAP COMMITS DETERMINISTICALLY, AND AI NEVER COMMITS** (hard rule #5). The
//     inbox routes to `packages/approvals`; nothing here decides anything by itself.
//
// Freshness is attached to everything (P-08): an owner looking at eight-hour-old numbers
// must be told, in the same breath, that they are eight hours old.
//
// Pure and deterministic: the clock is injected, nothing is sent from here.

export type ExceptionKind =
  | 'large_discount'
  | 'voided_bill'
  | 'price_override'
  | 'after_hours_login'
  | 'cash_short';

export interface ExceptionEvent {
  readonly eventId: string;
  readonly kind: ExceptionKind;
  readonly at: string;
  readonly branchId: string;
  /** Who did it — a named person, never a role. */
  readonly actorId: string;
  readonly laneId?: string;
  readonly valueMinor: number;
  readonly transactionRef: string;
}

/** Every threshold the owner sets. All optional; an unset kind raises no alerts. */
export interface OwnerThresholds {
  /** Discount value at or above which one discount is an alert. */
  readonly largeDiscountMinor?: number;
  /** Voided bills by one person in the window before it is an alert. */
  readonly voidedBillCount?: number;
  readonly priceOverrideCount?: number;
  /** Local hours outside which a login is "after hours", e.g. [6, 23]. */
  readonly tradingHours?: readonly [number, number];
  /** Till shortfall value at or above which it is an alert. */
  readonly cashShortMinor?: number;
}

export type AlertSeverity = 'notice' | 'attention' | 'urgent';

export interface OwnerAlert {
  readonly alertId: string;
  readonly kind: ExceptionKind;
  readonly severity: AlertSeverity;
  /** Plain English, written for a phone screen. */
  readonly headline: string;
  readonly count: number;
  readonly valueMinor: number;
  readonly branchId: string;
  readonly actorId?: string;
  /** Every underlying transaction, kept for the drill-through (M29-FR-02). */
  readonly transactionRefs: readonly string[];
  readonly firstAt: string;
  readonly lastAt: string;
}

function hourOf(at: string): number {
  return Number.parseInt(at.slice(11, 13), 10);
}

/**
 * Turn raw exception events into the small number of grouped alerts an owner will
 * actually read. Grouped by kind, branch and person — because "six voids" is one
 * conversation with one cashier, not six notifications.
 */
export function raiseOwnerAlerts(input: {
  readonly events: readonly ExceptionEvent[];
  readonly thresholds: OwnerThresholds;
}): readonly OwnerAlert[] {
  const t = input.thresholds;
  const alerts: OwnerAlert[] = [];

  const groups = new Map<string, ExceptionEvent[]>();
  for (const e of input.events) {
    const key = `${e.kind}|${e.branchId}|${e.actorId}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  for (const [key, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const first = rows[0]!;
    const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
    const value = rows.reduce((s, e) => s + e.valueMinor, 0);
    const shared = {
      alertId: `alert:${key}`,
      kind: first.kind,
      count: rows.length,
      valueMinor: value,
      branchId: first.branchId,
      actorId: first.actorId,
      transactionRefs: sorted.map((e) => e.transactionRef),
      firstAt: sorted[0]!.at,
      lastAt: sorted[sorted.length - 1]!.at,
    };

    switch (first.kind) {
      case 'large_discount': {
        if (t.largeDiscountMinor === undefined) break;
        const big = rows.filter((e) => e.valueMinor >= t.largeDiscountMinor!);
        if (big.length === 0) break;
        const bigValue = big.reduce((s, e) => s + e.valueMinor, 0);
        alerts.push({
          ...shared,
          count: big.length,
          valueMinor: bigValue,
          transactionRefs: big.map((e) => e.transactionRef),
          severity: bigValue >= t.largeDiscountMinor * 5 ? 'urgent' : 'attention',
          headline:
            big.length === 1
              ? `${first.actorId} gave a discount of ${big[0]!.valueMinor} at ${first.branchId}`
              : `${first.actorId} gave ${big.length} large discounts at ${first.branchId}, ${bigValue} in total`,
        });
        break;
      }
      case 'voided_bill': {
        if (t.voidedBillCount === undefined || rows.length < t.voidedBillCount) break;
        alerts.push({
          ...shared,
          severity: rows.length >= t.voidedBillCount * 2 ? 'urgent' : 'attention',
          headline: `${first.actorId} voided ${rows.length} bills at ${first.branchId} worth ${value}`,
        });
        break;
      }
      case 'price_override': {
        if (t.priceOverrideCount === undefined || rows.length < t.priceOverrideCount) break;
        alerts.push({
          ...shared,
          severity: 'attention',
          headline: `${first.actorId} overrode the price ${rows.length} times at ${first.branchId}`,
        });
        break;
      }
      case 'after_hours_login': {
        if (t.tradingHours === undefined) break;
        const [open, close] = t.tradingHours;
        const outside = rows.filter((e) => hourOf(e.at) < open || hourOf(e.at) >= close);
        if (outside.length === 0) break;
        alerts.push({
          ...shared,
          count: outside.length,
          transactionRefs: outside.map((e) => e.transactionRef),
          // Somebody in the system when the shop is shut is always worth a look.
          severity: 'urgent',
          headline: `${first.actorId} signed in at ${first.branchId} outside trading hours (${outside.length} time(s))`,
        });
        break;
      }
      case 'cash_short': {
        if (t.cashShortMinor === undefined) break;
        const short = rows.filter((e) => e.valueMinor >= t.cashShortMinor!);
        if (short.length === 0) break;
        const shortValue = short.reduce((s, e) => s + e.valueMinor, 0);
        alerts.push({
          ...shared,
          count: short.length,
          valueMinor: shortValue,
          transactionRefs: short.map((e) => e.transactionRef),
          severity: short.length > 1 ? 'urgent' : 'attention',
          headline:
            short.length === 1
              ? `${first.branchId} till was ${shortValue} short on ${first.actorId}'s shift`
              : `${first.actorId} was short on ${short.length} shifts at ${first.branchId}, ${shortValue} in total`,
        });
        break;
      }
    }
  }

  // Severity first, then — within a band — UNVALUED ALERTS BEFORE VALUED ONES.
  //
  // That looks backwards until you see what it prevents. An alert with no rupee figure
  // is not an alert worth nothing; it is one whose risk is not money. "Someone signed in
  // at 2:15am" carries ₹0 and is the most important thing on the list. A pure value sort
  // puts it underneath every discount and void, which is to say at the bottom, which is
  // to say nowhere — and those unpriceable ones (access, hours, identity) are precisely
  // the alerts nobody else is watching for.
  const rank: Record<AlertSeverity, number> = { urgent: 0, attention: 1, notice: 2 };
  return alerts.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      Number(a.valueMinor > 0) - Number(b.valueMinor > 0) ||
      b.valueMinor - a.valueMinor ||
      a.alertId.localeCompare(b.alertId),
  );
}

// --- the approval inbox -----------------------------------------------------------

export interface InboxApproval {
  readonly requestId: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly requestedBy: string;
  readonly branchId: string | null;
  readonly valueMinor: number | null;
  readonly requestedAt: string;
  /**
   * A fingerprint of the thing being approved as it was when the request was raised.
   * If the subject has moved on since, approving would commit against a state nobody
   * reviewed (§31.1).
   */
  readonly subjectVersion: string;
  readonly summary: string;
}

export type InboxStatus =
  | 'actionable'
  /** You raised it. You will never be able to decide it (§28). */
  | 'your_own_request'
  /** Beyond your authority — it escalates rather than offering a button that fails. */
  | 'exceeds_authority'
  | 'out_of_scope'
  /** The subject changed after this was raised. Approving would undo the newer change. */
  | 'superseded';

export interface InboxItem {
  readonly requestId: string;
  readonly status: InboxStatus;
  readonly summary: string;
  readonly valueMinor: number | null;
  readonly waitingHours: number;
  /** Why it is not actionable, in words. Never a disabled button with no reason. */
  readonly detail: string;
}

export interface InboxViewer {
  readonly userId: string;
  readonly branchScope: readonly string[] | 'all';
  /** Maximum value they may approve; null = unlimited. */
  readonly authorityLimitMinor: number | null;
}

/**
 * Build the owner's approval inbox. Ordered by value, biggest first, because that is
 * the order in which a decision matters — and every non-actionable item **says why**
 * rather than presenting a button that will fail.
 *
 * `currentSubjectVersions` is what the subjects look like **now**. An item whose
 * subject has changed since it was raised is marked `superseded`: approving it would
 * commit a review of an older state and silently undo whatever replaced it.
 */
export function buildInbox(input: {
  readonly approvals: readonly InboxApproval[];
  readonly viewer: InboxViewer;
  readonly currentSubjectVersions: Readonly<Record<string, string>>;
  readonly at: string;
}): readonly InboxItem[] {
  return input.approvals
    .map((a): InboxItem => {
      const waitingHours = Math.max(
        0,
        Math.round((Date.parse(input.at) - Date.parse(a.requestedAt)) / 3_600_000),
      );
      const base = { requestId: a.requestId, summary: a.summary, valueMinor: a.valueMinor, waitingHours };

      if (a.requestedBy === input.viewer.userId) {
        return {
          ...base,
          status: 'your_own_request',
          detail: 'you raised this — someone else must decide it (§28)',
        };
      }
      const inScope =
        input.viewer.branchScope === 'all' ||
        (a.branchId !== null && input.viewer.branchScope.includes(a.branchId));
      if (!inScope) {
        return { ...base, status: 'out_of_scope', detail: `this is for ${a.branchId ?? 'the whole company'}, which is outside your access` };
      }

      const current = input.currentSubjectVersions[a.subjectRef];
      if (current !== undefined && current !== a.subjectVersion) {
        return {
          ...base,
          status: 'superseded',
          detail: `this changed after the request was raised — approving it now would commit a review of the old version and undo the newer change. Ask for it to be raised again`,
        };
      }

      if (
        a.valueMinor !== null &&
        input.viewer.authorityLimitMinor !== null &&
        a.valueMinor > input.viewer.authorityLimitMinor
      ) {
        return {
          ...base,
          status: 'exceeds_authority',
          detail: `${a.valueMinor} is above your limit of ${input.viewer.authorityLimitMinor} — this escalates rather than waiting for a decision you cannot make`,
        };
      }

      return {
        ...base,
        status: 'actionable',
        detail: waitingHours >= 24 ? `waiting ${waitingHours} hours` : 'ready for your decision',
      };
    })
    .sort((a, b) => {
      const rank: Record<InboxStatus, number> = {
        actionable: 0,
        superseded: 1,
        exceeds_authority: 2,
        out_of_scope: 3,
        your_own_request: 4,
      };
      return (
        rank[a.status] - rank[b.status] ||
        (b.valueMinor ?? 0) - (a.valueMinor ?? 0) ||
        a.requestId.localeCompare(b.requestId)
      );
    });
}
