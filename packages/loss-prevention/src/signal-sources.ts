// The fraud signals over what the shop has STORED (M15-FR-02 · audit-2 P4: "nothing feeds it from the real coupon
// redemptions, points movements, COD handovers or supplier invoices"; acceptance: "cross-domain signals reconcile to
// their source").
//
// `fraud-signals.ts` holds the four detectors and runs over whatever it is handed. This module is the other half: it
// turns the shop's own records — every coupon redemption on the coupon register, every points movement on a member's
// points ledger, every cash-on-delivery stop on a route and the counted handover that settled it, every supplier bill
// captured — into the detectors' inputs, runs them over one window with the shop's own thresholds, and then CHECKS
// every signal back against the records it came from:
//
//   • **Every evidence reference is a record that exists.** A signal naming a sale, a movement, an order or a bill the
//     sources do not hold is marked `reconciles: false` and said — a signal that cannot be traced to its source is
//     not evidence, and the screen shows it as such rather than hiding it.
//   • **Every source says how much it read.** "No coupon signal" over zero redemptions read is not the same as over two
//     thousand; each domain reports how many records it read and the window, and a domain whose register is not
//     reachable says `known: false`, never a zero (P-08).
//   • **What cannot be valued is not valued.** A percentage coupon's rupee value depends on the basket; where the
//     register does not hold it, the use is counted and valued at nothing, and the source says how many such uses it
//     read — never a made-up figure.
//
// Detect-only, like everything in this package: the output is a list to read (hard rule #5 · AI-NFR-12).

import {
  detectCouponAbuse, detectLoyaltyManipulation, detectCodAnomalies, detectSupplierAnomalies, prioritiseSignals,
  type FraudSignal, type FraudThresholds, type CouponUse, type LoyaltyMovement, type CodRecord, type SupplierInvoiceLine, type FraudDomain,
} from './fraud-signals';

/** A coupon redemption as the coupon register holds it, with the coupon it redeemed (when the register has it). */
export interface StoredCouponRedemption {
  readonly redemptionId: string;
  readonly code: string;
  readonly customerRef?: string;
  readonly saleId: string;
  readonly at: string;
  /** The coupon's own definition: its money off (amount coupons) and how many uses each customer may make. */
  readonly coupon?: { readonly kind: string; readonly valueMinor?: number; readonly maxPerCustomer?: number };
}

/** A points movement as a member's points ledger holds it, with who issued it by hand (when that was recorded). */
export interface StoredPointsMovement {
  readonly movementId: string;
  readonly customerId: string;
  readonly delta: number;
  readonly reason: string;
  readonly sourceRef: string | null;
  readonly at: string;
  readonly issuedBy?: string;
}

/** One cash-on-delivery stop as the route register holds its latest outcome, and when its cash was handed in. */
export interface StoredCodStop {
  readonly routeId: string;
  readonly stopId: string;
  readonly driverId: string;
  readonly orderRef: string;
  readonly state: string;
  readonly codExpectedMinor: number;
  readonly codCollectedMinor: number;
  readonly codMethod: string | null;
  readonly at: string;
  /** When the route's counted cash handover was recorded; absent = the driver has not handed in. */
  readonly handedInAt?: string;
}

/** One supplier bill as captured. */
export interface StoredSupplierBill {
  readonly invoiceId: string;
  readonly supplierId: string;
  readonly capturedAt: string;
  readonly lines: readonly { readonly productId: string; readonly quantity: number; readonly unitPriceMinor: number }[];
}

/** What each domain's register gave, or that it could not be read. */
export type Readings<T> = { readonly known: true; readonly records: readonly T[] } | { readonly known: false; readonly why: string };

export interface SourceSummary {
  readonly domain: FraudDomain;
  readonly register: string;
  readonly known: boolean;
  /** Records read inside the window (and, for suppliers, the history before it). */
  readonly read: number;
  readonly history?: number;
  /** Uses counted but not valued (a percentage coupon), said beside the count. */
  readonly notValued?: number;
  readonly why?: string;
}

export interface ReconciledSignal extends FraudSignal {
  /** True when every evidence reference is a record the source holds. */
  readonly reconciles: boolean;
  /** Evidence references the sources do not hold — said, never dropped. */
  readonly unmatchedEvidence: readonly string[];
}

export interface StoredSignalsReport {
  readonly from: string;
  readonly to: string;
  readonly signals: readonly ReconciledSignal[];
  readonly sources: readonly SourceSummary[];
  /** Every signal traced to its records. */
  readonly allReconcile: boolean;
  readonly actionTaken: false;
}

const within = (at: string, from: string, to: string): boolean => {
  const t = Date.parse(at);
  return !Number.isNaN(t) && t >= Date.parse(from) && t <= Date.parse(to);
};

/** Coupon uses from the register; the account is the customer named (a walk-in use is its own "walk-in" account). */
export function couponUsesFrom(rows: readonly StoredCouponRedemption[]): { readonly uses: readonly CouponUse[]; readonly notValued: number } {
  let notValued = 0;
  const uses = rows.map((r): CouponUse => {
    const amount = r.coupon?.kind === 'amount_off' && Number.isInteger(r.coupon.valueMinor) ? r.coupon.valueMinor! : undefined;
    if (amount === undefined) notValued += 1;
    return {
      useId: r.redemptionId, couponCode: r.code, accountRef: r.customerRef ?? 'walk-in', saleId: r.saleId, discountMinor: amount ?? 0, at: r.at,
      ...(r.coupon?.maxPerCustomer === undefined ? {} : { limitPerAccount: r.coupon.maxPerCustomer }),
    };
  });
  return { uses, notValued };
}

/** Points movements as the detector reads them: an earn names its sale (its source); a burn spends; the rest reverse. */
export function loyaltyMovementsFrom(rows: readonly StoredPointsMovement[]): readonly LoyaltyMovement[] {
  return rows.map((m): LoyaltyMovement => {
    const kind: LoyaltyMovement['kind'] = m.reason === 'earn' ? 'earn' : m.reason === 'burn' ? 'burn' : 'reverse';
    // An earn names the sale behind it; a migration load's opening points name the load — that is a source too.
    const saleId = m.sourceRef === null || m.sourceRef.trim() === '' ? undefined : m.sourceRef;
    return { movementId: m.movementId, accountRef: m.customerId, kind, points: Math.abs(m.delta), at: m.at, ...(saleId === undefined ? {} : { saleId }), ...(m.issuedBy === undefined ? {} : { staffId: m.issuedBy }) };
  });
}

/** Cash-on-delivery stops: the delivered (or part-delivered) cash stops, each banked when the route's cash was handed in. */
export function codRecordsFrom(rows: readonly StoredCodStop[]): readonly CodRecord[] {
  return rows
    .filter((s) => (s.state === 'delivered' || s.state === 'partially_delivered') && s.codMethod === 'cash' && s.codExpectedMinor > 0)
    .map((s): CodRecord => ({
      stopId: `${s.routeId}:${s.stopId}`, driverRef: s.driverId, orderId: s.orderRef,
      expectedMinor: s.codExpectedMinor, collectedMinor: s.codCollectedMinor, collectedAt: s.at,
      ...(s.handedInAt === undefined ? {} : { bankedAt: s.handedInAt }),
    }));
}

/** Supplier bill lines, one per product line, timed by when the bill was captured. */
export function supplierLinesFrom(rows: readonly StoredSupplierBill[]): readonly SupplierInvoiceLine[] {
  return rows.flatMap((b) => b.lines.map((l): SupplierInvoiceLine => ({
    invoiceId: b.invoiceId, supplierId: b.supplierId, productId: l.productId, unitPriceMinor: l.unitPriceMinor, quantityMinor: l.quantity, at: b.capturedAt,
  })));
}

/**
 * Run the four detectors over the stored registers in one window, with the shop's thresholds, and reconcile every
 * signal to its records. `at` is when the report is read (the COD banking delay is measured to it).
 */
export function storedFraudSignals(input: {
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly thresholds: FraudThresholds;
  readonly coupons: Readings<StoredCouponRedemption>;
  readonly points: Readings<StoredPointsMovement>;
  readonly cod: Readings<StoredCodStop>;
  readonly supplierBills: Readings<StoredSupplierBill>;
}): StoredSignalsReport {
  const { from, to, thresholds: t } = input;
  const signals: FraudSignal[] = [];
  const sources: SourceSummary[] = [];
  const known = new Map<FraudDomain, Set<string>>();

  if (input.coupons.known) {
    const rows = input.coupons.records.filter((r) => within(r.at, from, to));
    const { uses, notValued } = couponUsesFrom(rows);
    signals.push(...detectCouponAbuse(uses, t));
    known.set('coupon', new Set(rows.flatMap((r) => [r.saleId, r.redemptionId])));
    sources.push({ domain: 'coupon', register: 'the coupon register (every redemption of every coupon)', known: true, read: rows.length, notValued });
  } else sources.push({ domain: 'coupon', register: 'the coupon register', known: false, read: 0, why: input.coupons.why });

  if (input.points.known) {
    const rows = input.points.records.filter((r) => within(r.at, from, to));
    signals.push(...detectLoyaltyManipulation(loyaltyMovementsFrom(rows), t));
    known.set('loyalty', new Set(rows.map((r) => r.movementId)));
    sources.push({ domain: 'loyalty', register: 'each member\'s points ledger', known: true, read: rows.length });
  } else sources.push({ domain: 'loyalty', register: 'the points ledgers', known: false, read: 0, why: input.points.why });

  if (input.cod.known) {
    const rows = input.cod.records.filter((r) => within(r.at, from, to));
    const recs = codRecordsFrom(rows);
    signals.push(...detectCodAnomalies(recs, input.at, t));
    known.set('delivery', new Set(recs.map((r) => r.orderId)));
    sources.push({ domain: 'delivery', register: 'the delivery routes (each stop\'s cash and the counted handover)', known: true, read: recs.length });
  } else sources.push({ domain: 'delivery', register: 'the delivery routes', known: false, read: 0, why: input.cod.why });

  if (input.supplierBills.known) {
    const inWindow = input.supplierBills.records.filter((b) => within(b.capturedAt, from, to));
    const before = input.supplierBills.records.filter((b) => !Number.isNaN(Date.parse(b.capturedAt)) && Date.parse(b.capturedAt) < Date.parse(from));
    signals.push(...detectSupplierAnomalies({ lines: supplierLinesFrom(inWindow), history: supplierLinesFrom(before) }, t));
    known.set('supplier', new Set(input.supplierBills.records.map((b) => b.invoiceId)));
    sources.push({ domain: 'supplier', register: 'the supplier bills captured', known: true, read: inWindow.length, history: before.length });
  } else sources.push({ domain: 'supplier', register: 'the supplier bills', known: false, read: 0, why: input.supplierBills.why });

  const reconciled = prioritiseSignals(signals).map((s): ReconciledSignal => {
    const held = known.get(s.domain) ?? new Set<string>();
    const unmatchedEvidence = s.evidenceRefs.filter((r) => !held.has(r));
    return { ...s, reconciles: unmatchedEvidence.length === 0, unmatchedEvidence };
  });
  return { from, to, signals: reconciled, sources, allReconcile: reconciled.every((s) => s.reconciles), actionTaken: false };
}
