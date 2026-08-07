// Cross-domain fraud signals (M15-FR-02 / A07 authority boundary / AI-NFR-12).
//
// `loss-prevention.ts` watches the till. This watches everything the till cannot see:
// coupons, loyalty points, cash on delivery, and what suppliers charge. Those four are
// grouped together for a reason — they are the places where value leaves the business
// **without a cashier touching anything**, which is exactly why they go unnoticed.
//
// Two rules govern the whole module, and both are constraints rather than features:
//
//   • **A SIGNAL IS NOT A VERDICT.** Every finding here is a *reason to look*, carrying
//     the evidence that produced it and the transactions it came from. Nothing is
//     blocked, sanctioned, cancelled or reversed. The roadmap is explicit about the
//     A07 fraud agent: it **summarises and prioritises only** (§7 authority, hard rule
//     #5, AI-NFR-12). A system that suspends a customer's loyalty account on a
//     statistical hunch will one day suspend a regular who did nothing wrong, and the
//     shop will never hear the end of it.
//
//   • **THE THRESHOLD IS ALWAYS THE TENANT'S.** A 20-coupon month is fraud in a corner
//     shop and a Tuesday in a hypermarket. Nothing here contains a number that a store
//     did not choose; the defaults exist so a new tenant is not defenceless on day one,
//     and every one of them is overridable.
//
// Signals carry a **confidence**, and low-confidence ones say so in words rather than
// being quietly suppressed — a hidden weak signal is how a pattern goes unseen for a
// year, and a weak signal presented as strong is how an honest employee gets accused.
//
// Pure and deterministic: everything is passed in, including the clock.

export type FraudDomain = 'coupon' | 'loyalty' | 'delivery' | 'supplier';

export type FraudSignalKind =
  | 'coupon_beyond_limit'
  | 'coupon_concentrated_on_one_account'
  | 'loyalty_earn_without_sale'
  | 'loyalty_burn_spike'
  | 'cod_short_repeatedly'
  | 'cod_collected_but_not_banked'
  | 'supplier_price_out_of_history'
  | 'supplier_quantity_out_of_history';

export type Confidence = 'weak' | 'probable' | 'strong';

export interface FraudSignal {
  readonly signalId: string;
  readonly domain: FraudDomain;
  readonly kind: FraudSignalKind;
  /** Who or what the signal is about — an account, a driver, a supplier. */
  readonly subjectRef: string;
  readonly confidence: Confidence;
  /** Money at stake, where it can be valued. Zero where it genuinely cannot. */
  readonly valueMinor: number;
  /** The transactions behind it, so a human can check rather than take our word. */
  readonly evidenceRefs: readonly string[];
  readonly detail: string;
  /**
   * Always false. Present as a field, and asserted in the tests, so that "the fraud
   * module blocks things" would have to be written down before it could be true.
   */
  readonly actionTaken: false;
}

/** Every threshold, per tenant. The defaults keep a new store safe, nothing more. */
export interface FraudThresholds {
  /** Coupon uses by one account in the window before it is odd. Default 5. */
  readonly couponUsesPerAccount?: number;
  /** Share of ALL coupon uses concentrated on one account. Default 30 (percent). */
  readonly couponConcentrationPercent?: number;
  /**
   * Total coupon uses needed before a *share* means anything. Default 20.
   *
   * Without this, a quiet Tuesday with four coupon uses makes whoever used three of
   * them "75% of all coupon activity" — and the shop starts investigating its regulars
   * for shopping on a slow day. A percentage of a tiny number is not evidence.
   */
  readonly couponConcentrationMinimumTotal?: number;
  /** Loyalty points burned in one day against the account's own average. Default 5×. */
  readonly loyaltyBurnSpikeMultiple?: number;
  /** COD shortfalls by one driver in the window. Default 3. */
  readonly codShortCount?: number;
  /** Hours after which collected COD not banked is a signal. Default 24. */
  readonly codBankingHours?: number;
  /** Percent a supplier price may move from its own history. Default 25. */
  readonly supplierPriceDriftPercent?: number;
  /** Percent a supplier line quantity may move from its own history. Default 50. */
  readonly supplierQuantityDriftPercent?: number;
  /** Observations needed before history means anything. Default 5. */
  readonly minimumHistory?: number;
}

const T = {
  couponUsesPerAccount: 5,
  couponConcentrationPercent: 30,
  couponConcentrationMinimumTotal: 20,
  loyaltyBurnSpikeMultiple: 5,
  codShortCount: 3,
  codBankingHours: 24,
  supplierPriceDriftPercent: 25,
  supplierQuantityDriftPercent: 50,
  minimumHistory: 5,
} as const;

function thresholds(t: FraudThresholds = {}): Required<FraudThresholds> {
  return {
    couponUsesPerAccount: t.couponUsesPerAccount ?? T.couponUsesPerAccount,
    couponConcentrationPercent: t.couponConcentrationPercent ?? T.couponConcentrationPercent,
    couponConcentrationMinimumTotal:
      t.couponConcentrationMinimumTotal ?? T.couponConcentrationMinimumTotal,
    loyaltyBurnSpikeMultiple: t.loyaltyBurnSpikeMultiple ?? T.loyaltyBurnSpikeMultiple,
    codShortCount: t.codShortCount ?? T.codShortCount,
    codBankingHours: t.codBankingHours ?? T.codBankingHours,
    supplierPriceDriftPercent: t.supplierPriceDriftPercent ?? T.supplierPriceDriftPercent,
    supplierQuantityDriftPercent: t.supplierQuantityDriftPercent ?? T.supplierQuantityDriftPercent,
    minimumHistory: t.minimumHistory ?? T.minimumHistory,
  };
}

// --- coupons ----------------------------------------------------------------------

export interface CouponUse {
  readonly useId: string;
  readonly couponCode: string;
  readonly accountRef: string;
  readonly saleId: string;
  readonly discountMinor: number;
  readonly at: string;
  /** The abuse limit the promotion itself declared (M05-FR-04 / D06-FR-04). */
  readonly limitPerAccount?: number;
}

/**
 * Coupon abuse. Two different shapes, deliberately separated: **one account past a
 * declared limit** (a rule was broken, so this is strong), and **one account holding
 * an implausible share of every coupon in the shop** (no rule was broken, so this is
 * only ever probable — it might be one very keen customer).
 */
export function detectCouponAbuse(
  uses: readonly CouponUse[],
  config: FraudThresholds = {},
): readonly FraudSignal[] {
  const t = thresholds(config);
  const signals: FraudSignal[] = [];

  const byAccountAndCoupon = new Map<string, CouponUse[]>();
  const byAccount = new Map<string, CouponUse[]>();
  for (const use of uses) {
    const key = `${use.accountRef}|${use.couponCode}`;
    byAccountAndCoupon.set(key, [...(byAccountAndCoupon.get(key) ?? []), use]);
    byAccount.set(use.accountRef, [...(byAccount.get(use.accountRef) ?? []), use]);
  }

  for (const [key, rows] of [...byAccountAndCoupon].sort(([a], [b]) => a.localeCompare(b))) {
    const first = rows[0]!;
    const limit = first.limitPerAccount ?? t.couponUsesPerAccount;
    if (rows.length > limit) {
      signals.push({
        signalId: `coupon-limit:${key}`,
        domain: 'coupon',
        kind: 'coupon_beyond_limit',
        subjectRef: first.accountRef,
        // A declared limit was exceeded. That is a fact, not an inference.
        confidence: 'strong',
        valueMinor: rows.reduce((s, r) => s + r.discountMinor, 0),
        evidenceRefs: rows.map((r) => r.saleId),
        detail: `${first.accountRef} used coupon ${first.couponCode} ${rows.length} times against a limit of ${limit}`,
        actionTaken: false,
      });
    }
  }

  // A share of a small number is not evidence — see `couponConcentrationMinimumTotal`.
  const total = uses.length;
  if (total >= t.couponConcentrationMinimumTotal) {
    for (const [account, rows] of [...byAccount].sort(([a], [b]) => a.localeCompare(b))) {
      const share = Math.round((rows.length / total) * 100);
      if (share >= t.couponConcentrationPercent && rows.length >= 3) {
        const alreadyFlagged = signals.some(
          (s) => s.subjectRef === account && s.kind === 'coupon_beyond_limit',
        );
        if (alreadyFlagged) continue;
        signals.push({
          signalId: `coupon-share:${account}`,
          domain: 'coupon',
          kind: 'coupon_concentrated_on_one_account',
          subjectRef: account,
          // Nothing was broken. It might simply be a very keen customer.
          confidence: 'probable',
          valueMinor: rows.reduce((s, r) => s + r.discountMinor, 0),
          evidenceRefs: rows.map((r) => r.saleId),
          detail: `${account} accounts for ${share}% of all coupon use (${rows.length} of ${total}) — worth a look, but a keen regular looks the same`,
          actionTaken: false,
        });
      }
    }
  }

  return signals;
}

// --- loyalty ----------------------------------------------------------------------

export interface LoyaltyMovement {
  readonly movementId: string;
  readonly accountRef: string;
  readonly kind: 'earn' | 'burn' | 'reverse';
  readonly points: number;
  readonly at: string;
  /** The sale that justifies an earn. Absent = points from nowhere. */
  readonly saleId?: string;
  readonly staffId?: string;
}

/**
 * Loyalty manipulation. The one that matters is **points earned with no sale behind
 * them** — that is not a pattern, it is a transaction that should not exist, and it
 * usually has a staff id on it.
 */
export function detectLoyaltyManipulation(
  movements: readonly LoyaltyMovement[],
  config: FraudThresholds = {},
): readonly FraudSignal[] {
  const t = thresholds(config);
  const signals: FraudSignal[] = [];

  const orphanEarns = movements.filter((m) => m.kind === 'earn' && m.saleId === undefined);
  const byStaff = new Map<string, LoyaltyMovement[]>();
  for (const m of orphanEarns) {
    const staff = m.staffId ?? 'unattributed';
    byStaff.set(staff, [...(byStaff.get(staff) ?? []), m]);
  }
  for (const [staff, rows] of [...byStaff].sort(([a], [b]) => a.localeCompare(b))) {
    signals.push({
      signalId: `loyalty-orphan:${staff}`,
      domain: 'loyalty',
      kind: 'loyalty_earn_without_sale',
      subjectRef: staff,
      confidence: 'strong',
      // Points are money-like (M17-FR-01), but their rupee value depends on the burn
      // rate, so this is deliberately reported in points and left unvalued rather than
      // guessed at.
      valueMinor: 0,
      evidenceRefs: rows.map((r) => r.movementId),
      detail: `${rows.reduce((s, r) => s + r.points, 0)} points issued by ${staff} with no sale behind them across ${rows.length} movement(s) — points that came from nowhere`,
      actionTaken: false,
    });
  }

  // A burn far outside an account's own history. Compared against the account's own
  // behaviour, never a shop-wide average — a big spender is not a suspect.
  const burnsByAccount = new Map<string, LoyaltyMovement[]>();
  for (const m of movements.filter((x) => x.kind === 'burn')) {
    burnsByAccount.set(m.accountRef, [...(burnsByAccount.get(m.accountRef) ?? []), m]);
  }
  for (const [account, rows] of [...burnsByAccount].sort(([a], [b]) => a.localeCompare(b))) {
    if (rows.length < t.minimumHistory) continue;
    const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
    const latest = sorted[sorted.length - 1]!;
    const history = sorted.slice(0, -1);
    const average = history.reduce((s, r) => s + r.points, 0) / history.length;
    if (average > 0 && latest.points > average * t.loyaltyBurnSpikeMultiple) {
      signals.push({
        signalId: `loyalty-spike:${account}`,
        domain: 'loyalty',
        kind: 'loyalty_burn_spike',
        subjectRef: account,
        confidence: 'weak',
        valueMinor: 0,
        evidenceRefs: [latest.movementId],
        detail: `${account} burned ${latest.points} points against an own average of ${Math.round(average)} — this is a weak signal on its own; a saved-up redemption looks identical`,
        actionTaken: false,
      });
    }
  }

  return signals;
}

// --- delivery / COD ---------------------------------------------------------------

export interface CodRecord {
  readonly stopId: string;
  readonly driverRef: string;
  readonly orderId: string;
  readonly expectedMinor: number;
  readonly collectedMinor: number;
  readonly collectedAt: string;
  /** When the driver handed the cash in. Absent = still holding it. */
  readonly bankedAt?: string;
}

/**
 * Cash on delivery. The money is in someone's pocket between the doorstep and the
 * safe, which is the only point in the business where that is true — so both the
 * **shortfall** and the **delay** are watched, and the delay is watched separately
 * because cash held overnight is a risk even when every rupee eventually arrives.
 */
export function detectCodAnomalies(
  records: readonly CodRecord[],
  at: string,
  config: FraudThresholds = {},
): readonly FraudSignal[] {
  const t = thresholds(config);
  const signals: FraudSignal[] = [];

  const byDriver = new Map<string, CodRecord[]>();
  for (const r of records) byDriver.set(r.driverRef, [...(byDriver.get(r.driverRef) ?? []), r]);

  for (const [driver, rows] of [...byDriver].sort(([a], [b]) => a.localeCompare(b))) {
    const short = rows.filter((r) => r.collectedMinor < r.expectedMinor);
    if (short.length >= t.codShortCount) {
      signals.push({
        signalId: `cod-short:${driver}`,
        domain: 'delivery',
        kind: 'cod_short_repeatedly',
        subjectRef: driver,
        confidence: short.length >= t.codShortCount * 2 ? 'strong' : 'probable',
        valueMinor: short.reduce((s, r) => s + (r.expectedMinor - r.collectedMinor), 0),
        evidenceRefs: short.map((r) => r.orderId),
        detail: `${driver} came back short on ${short.length} of ${rows.length} stops — one is a customer dispute, ${short.length} is a pattern`,
        actionTaken: false,
      });
    }

    const unbanked = rows.filter(
      (r) =>
        r.bankedAt === undefined &&
        r.collectedMinor > 0 &&
        (Date.parse(at) - Date.parse(r.collectedAt)) / 3_600_000 > t.codBankingHours,
    );
    if (unbanked.length > 0) {
      signals.push({
        signalId: `cod-unbanked:${driver}`,
        domain: 'delivery',
        kind: 'cod_collected_but_not_banked',
        subjectRef: driver,
        confidence: 'strong',
        valueMinor: unbanked.reduce((s, r) => s + r.collectedMinor, 0),
        evidenceRefs: unbanked.map((r) => r.orderId),
        detail: `${driver} collected on ${unbanked.length} order(s) more than ${t.codBankingHours}h ago and has not handed the cash in`,
        actionTaken: false,
      });
    }
  }

  return signals;
}

// --- suppliers --------------------------------------------------------------------

export interface SupplierInvoiceLine {
  readonly invoiceId: string;
  readonly supplierId: string;
  readonly productId: string;
  readonly unitPriceMinor: number;
  readonly quantityMinor: number;
  readonly at: string;
}

/**
 * Supplier price and quantity anomalies (ties M06 / M07). Compared against **this
 * supplier's own history for this product**, never a market figure we do not have —
 * and only once there is enough history to mean anything, because two observations is
 * not a baseline, it is a coincidence.
 */
export function detectSupplierAnomalies(
  input: {
    readonly lines: readonly SupplierInvoiceLine[];
    readonly history: readonly SupplierInvoiceLine[];
  },
  config: FraudThresholds = {},
): readonly FraudSignal[] {
  const t = thresholds(config);
  const signals: FraudSignal[] = [];

  for (const line of [...input.lines].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))) {
    const past = input.history.filter(
      (h) => h.supplierId === line.supplierId && h.productId === line.productId,
    );
    if (past.length < t.minimumHistory) continue;

    const avgPrice = Math.round(past.reduce((s, h) => s + h.unitPriceMinor, 0) / past.length);
    const priceDrift = avgPrice === 0 ? 0 : Math.round(((line.unitPriceMinor - avgPrice) / avgPrice) * 100);
    if (Math.abs(priceDrift) >= t.supplierPriceDriftPercent) {
      signals.push({
        signalId: `supplier-price:${line.invoiceId}:${line.productId}`,
        domain: 'supplier',
        kind: 'supplier_price_out_of_history',
        subjectRef: line.supplierId,
        confidence: Math.abs(priceDrift) >= t.supplierPriceDriftPercent * 2 ? 'strong' : 'probable',
        valueMinor: Math.abs(line.unitPriceMinor - avgPrice) * line.quantityMinor,
        evidenceRefs: [line.invoiceId, ...past.map((h) => h.invoiceId)],
        detail: `${line.productId} invoiced at ${line.unitPriceMinor} against this supplier's own average of ${avgPrice} — ${priceDrift > 0 ? 'up' : 'down'} ${Math.abs(priceDrift)}%`,
        actionTaken: false,
      });
    }

    const avgQty = Math.round(past.reduce((s, h) => s + h.quantityMinor, 0) / past.length);
    const qtyDrift = avgQty === 0 ? 0 : Math.round(((line.quantityMinor - avgQty) / avgQty) * 100);
    if (Math.abs(qtyDrift) >= t.supplierQuantityDriftPercent) {
      signals.push({
        signalId: `supplier-qty:${line.invoiceId}:${line.productId}`,
        domain: 'supplier',
        kind: 'supplier_quantity_out_of_history',
        subjectRef: line.supplierId,
        confidence: 'weak',
        valueMinor: Math.abs(line.quantityMinor - avgQty) * line.unitPriceMinor,
        evidenceRefs: [line.invoiceId],
        detail: `${line.productId} invoiced at ${line.quantityMinor} against an average of ${avgQty} — ${qtyDrift > 0 ? 'up' : 'down'} ${Math.abs(qtyDrift)}%; a seasonal order looks the same, so check before asking`,
        actionTaken: false,
      });
    }
  }

  return signals;
}

/**
 * Everything, prioritised. Strong before probable before weak, then by value — so the
 * first thing a manager reads is the biggest thing they can actually be sure about.
 *
 * This is the whole output of the fraud layer: **a sorted list to read.** There is no
 * function anywhere in this module that blocks, suspends, cancels or reverses, and the
 * tests assert that absence (hard rule #5 / AI-NFR-12).
 */
export function prioritiseSignals(signals: readonly FraudSignal[]): readonly FraudSignal[] {
  const rank: Record<Confidence, number> = { strong: 0, probable: 1, weak: 2 };
  return [...signals].sort(
    (a, b) =>
      rank[a.confidence] - rank[b.confidence] ||
      b.valueMinor - a.valueMinor ||
      a.signalId.localeCompare(b.signalId),
  );
}
