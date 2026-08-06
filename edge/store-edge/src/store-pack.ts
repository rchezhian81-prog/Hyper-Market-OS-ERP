// What the store box was last told by the cloud — §31, P-02, P-08.
//
// The edge projects the day from its own log: it knows every sale rung at every lane because it
// wrote them. What it cannot know from its own log is everything the *rest of the business*
// decided — which products exist and what they cost, who is waiting on an approval, what is on
// today's checklist, which route the van is doing. Those arrive in a pack from cloud.
//
// ── The rule this file exists to hold ───────────────────────────────────────
//
// **A pack that never arrived is not an empty pack.** They look identical at a call site — both
// give you nothing — and they mean opposite things. "No approvals are waiting" is a fact about the
// business. "I have never been told about approvals" is a fact about this box, and the six screens
// already know the difference: the manager's day close refuses on the second and proceeds on the
// first.
//
// So every section is `Register<T>`: it is either **known**, with contents that may legitimately
// be empty, or **not known**, with the reason. There is no third state and no default. A section
// the cloud has never sent has never been sent, and that is what gets served.
//
// ── Why cost price is here and why it matters more than it looks ────────────
//
// A sale record carries what the customer paid. It cannot carry what the goods cost — that is a
// fact about the catalogue, not about the sale. So the owner's margin is only knowable where the
// pack has a cost price for every product in the basket.
//
// A product with no cost price therefore makes its sales **uncostable**, and an uncostable sale is
// excluded from the margin figures and counted, out loud, rather than costed at zero. Zero cost
// reports a 100% margin, which is a lie that reads as very good news.

/** A section of the pack: what the cloud said, or why this box does not know. */
export type Register<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly why: string };

export function known<T>(value: T): Register<T> {
  return { known: true, value };
}

export function notKnown<T>(why: string): Register<T> {
  return { known: false, why };
}

/** Read a section, or fall back — used only where an absent section genuinely has no consequence. */
export function orElse<T>(register: Register<T>, fallback: T): T {
  return register.known ? register.value : fallback;
}

/** What the edge needs to know about a product to run a shop and report on it. */
export interface PackProduct {
  readonly productId: string;
  readonly name: string;
  readonly nameTa?: string;
  readonly categoryId: string;
  readonly unitPriceMinor: number;
  /**
   * What one unit cost us, in minor units.
   *
   * Optional in the type because a real catalogue export has gaps, and a type that forbade the gap
   * would only mean somebody filling it with a zero. Absent means **this product's sales cannot be
   * costed**, which is reported rather than assumed away.
   */
  readonly unitCostMinor?: number;
  readonly uom: string;
  readonly barcodes: readonly string[];
  readonly availableMinor: number;
  readonly ageRestricted?: boolean;
}

/** One person waiting on somebody else's decision, as the cloud routed it here. */
export interface PackApproval {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly requestedBy: string;
  readonly branchId: string | null;
  readonly valueMinor: number | null;
}

/** An item on today's opening or closing checklist (D11-FR-01 / M25). */
export interface PackChecklistItem {
  readonly itemId: string;
  readonly description: string;
  readonly done: boolean;
  readonly blocking: boolean;
  readonly doneBy?: string;
}

/** The wave a picker has been assigned, as the cloud planned it. */
export interface PackWave {
  readonly waveId: string;
  readonly pickerId: string;
  readonly lines: readonly {
    readonly lineId: string;
    readonly orderRef: string;
    readonly productId: string;
    readonly description: string;
    readonly bin: string;
    readonly requiredQty: number;
    readonly uom: string;
    readonly unitPriceMinor: number;
  }[];
}

/**
 * A route somebody wrote out by hand, when there is one.
 *
 * Kept because a shop must be able to override the planner — a dispatcher who knows the bridge is
 * shut needs to be able to say so, and software that cannot be overridden gets worked around
 * instead. When this is present it **wins**, and the box says which of the two the driver is
 * holding rather than leaving them to guess.
 */
export interface PackRoute {
  readonly routeId: string;
  readonly driverId: string;
  readonly stops: readonly {
    readonly stopId: string;
    readonly orderRef: string;
    readonly area: string;
    readonly codMinor: number;
    readonly costMinor?: number;
    readonly orderValueMinor?: number;
  }[];
  readonly contributionRule?: { readonly maxCostShareBps: number };
}

/** Today's confirmed deliveries, for the box to plan into routes (M19-FR-03). */
export interface PackDelivery {
  readonly orderId: string;
  readonly slotId: string;
  readonly slotStartsAt: string;
  readonly slotEndsAt: string;
  /** Coarse area label. Never a full address record on a driver's phone (§31/§35). */
  readonly area: string;
  readonly location?: { readonly lat: number; readonly lon: number };
  readonly codMinor: number;
  readonly orderValueMinor?: number;
}

/** Who is driving today. */
export interface PackDriver {
  readonly driverId: string;
  readonly maxStops: number;
  readonly availableFrom: string;
  readonly availableUntil: string;
  /** Set when the van is off the road — the planner re-plans the day without them. */
  readonly unavailable?: boolean;
}

/** What the planner needs beyond the orders and the fleet. Per-tenant, all of it. */
export interface PackRoutingPolicy {
  readonly storeLocation: { readonly lat: number; readonly lon: number };
  readonly radiusMetres: number;
  readonly averageSpeedKmh: number;
  readonly serviceMinutesPerStop: number;
  readonly contributionRule?: { readonly maxCostShareBps: number };
}

/**
 * A purchase order this box has been told about (M06).
 *
 * Carried so the buyer's screen can compare an invoice against what was actually ordered. Without
 * it every invoiced line looks like something nobody ordered — which is a refusal, so it fails in
 * the safe direction, but it is a refusal for the wrong reason and the screen says which.
 */
export interface PackPurchaseOrder {
  readonly poId: string;
  readonly supplierId: string;
  readonly lines: readonly { readonly productId: string; readonly qty: number; readonly unitMinor: number }[];
}

/** What actually arrived against a purchase order (M07). */
export interface PackReceipt {
  readonly poId: string;
  readonly lines: readonly { readonly productId: string; readonly qty: number }[];
}

/**
 * A supplier invoice already captured.
 *
 * Here so capturing the same invoice twice is **visible**. A second capture is not a duplicate
 * record to be tidied later; it is a supplier being owed the money twice.
 */
export interface PackSupplierInvoice {
  readonly invoiceId: string;
  readonly lines: readonly {
    readonly productId: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly lineTotalMinor: number;
  }[];
}

/** Who buys, who may check them, and the tolerances this tenant matches on. All per-tenant. */
export interface PackBuyingPolicy {
  readonly buyerId: string;
  /**
   * Who may approve a capture or an order.
   *
   * The buyer must not be in this list (§28), and the box strips them out rather than trusting the
   * screen to. A separation of duties enforced only by the list somebody was shown is not enforced.
   */
  readonly approvers: readonly string[];
  /** Quantity tolerance for the three-way match, in basis points. */
  readonly quantityToleranceBps: number;
  /** Price tolerance for the three-way match, in basis points. */
  readonly priceToleranceBps: number;
  /** A difference below this is not worth a person's time. */
  readonly immaterialMinor: number;
}

/** A delivery or collection window the customer app may offer. */
export interface PackSlot {
  readonly slotId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly capacity: number;
  readonly booked: number;
  readonly kind: 'delivery' | 'pickup';
}

/** Thresholds and policies, all per-tenant and none of them constants in this codebase. */
export interface PackPolicies {
  readonly storeId: string;
  readonly branchId: string | null;
  readonly branchName: string;
  /** Where the trading day ends, "HH:MM" local (M01-FR-02). */
  readonly tradingDayCutoff: string;
  /** Seconds after which the owner's figures count as stale. */
  readonly staleAfterSeconds: number;
  /** Variance value at/above which a stock count needs a second approver (§28). */
  readonly countApprovalThresholdMinor: number;
  /** |over/short| at or above which a driver's cash handover needs the cash office. */
  readonly handoverToleranceMinor: number;
  /** Days the shop has to answer a data-subject request (PRV). */
  readonly privacySlaDays: number;
  readonly warehouseId: string;
}

/**
 * Everything the cloud last told this box.
 *
 * Every field is a `Register`, including the ones that would be convenient to default. The
 * convenience is exactly the problem: a default is how "we were never told" becomes "there is
 * nothing", silently, at the one moment somebody is deciding whether to lock a trading day.
 */
export interface StorePack {
  /** When this pack reached the box. Null means no pack has ever arrived. */
  readonly receivedAt: string | null;
  readonly version: number;
  readonly policies: Register<PackPolicies>;
  readonly products: Register<readonly PackProduct[]>;
  readonly approvals: Register<readonly PackApproval[]>;
  readonly checklist: Register<readonly PackChecklistItem[]>;
  readonly wave: Register<PackWave | null>;
  /** A hand-written route, when a dispatcher has overridden the planner. */
  readonly route: Register<PackRoute | null>;
  /** Today's confirmed deliveries, for this box to plan (M19-FR-03). */
  readonly deliveries: Register<readonly PackDelivery[]>;
  readonly drivers: Register<readonly PackDriver[]>;
  readonly routingPolicy: Register<PackRoutingPolicy>;
  readonly slots: Register<readonly PackSlot[]>;
  /** What is on order (M06) — the buyer's side of the three-way match. */
  readonly purchaseOrders: Register<readonly PackPurchaseOrder[]>;
  /** What arrived against those orders (M07). */
  readonly receipts: Register<readonly PackReceipt[]>;
  /** Supplier invoices already captured, so a second capture of one is refused (M07-FR-04). */
  readonly supplierInvoices: Register<readonly PackSupplierInvoice[]>;
  /** Who buys, who checks them, and this tenant's match tolerances (§28). */
  readonly buyingPolicy: Register<PackBuyingPolicy>;
  /** Loss-prevention thresholds — data, so a store tunes its own without code (M15-FR-01). */
  readonly lossPreventionRules: Register<readonly unknown[]>;
  /** The purposes this tenant asks a customer's consent for (M16 / PRV). */
  readonly consentPurposes: Register<readonly { readonly purpose: string; readonly channel: string; readonly required?: boolean }[]>;
}

const NEVER = 'this store box has never received a pack from the cloud';

/**
 * The pack a box holds before it has ever heard from the cloud.
 *
 * Every section says it does not know, and it says the same reason, because it is the same reason.
 * This is the state a freshly installed box is in for real, and the six screens are built to show
 * it honestly rather than to be protected from it.
 */
export function emptyPack(why: string = NEVER): StorePack {
  return {
    receivedAt: null,
    version: 0,
    policies: notKnown(why),
    products: notKnown(why),
    approvals: notKnown(why),
    checklist: notKnown(why),
    wave: notKnown(why),
    route: notKnown(why),
    deliveries: notKnown(why),
    drivers: notKnown(why),
    routingPolicy: notKnown(why),
    slots: notKnown(why),
    purchaseOrders: notKnown(why),
    receipts: notKnown(why),
    supplierInvoices: notKnown(why),
    buyingPolicy: notKnown(why),
    lossPreventionRules: notKnown(why),
    consentPurposes: notKnown(why),
  };
}

/**
 * Read a pack the cloud sent.
 *
 * A section the payload does not carry stays **not known** rather than becoming empty, and the
 * reason names the section — so "the pack has no approvals in it" is distinguishable from "no
 * approvals are waiting", which is the whole point of the file.
 */
export function readPack(payload: unknown, receivedAt: string): StorePack {
  if (payload === null || typeof payload !== 'object') {
    return emptyPack('the pack from the cloud could not be read');
  }
  const raw = payload as Record<string, unknown>;
  const section = <T>(name: string): Register<T> =>
    raw[name] === undefined
      ? notKnown(`the pack from the cloud carried no ${name.replace(/([A-Z])/g, ' $1').toLowerCase()}`)
      : known(raw[name] as T);

  return {
    receivedAt,
    version: typeof raw['version'] === 'number' ? raw['version'] : 0,
    policies: section<PackPolicies>('policies'),
    products: section<readonly PackProduct[]>('products'),
    approvals: section<readonly PackApproval[]>('approvals'),
    checklist: section<readonly PackChecklistItem[]>('checklist'),
    wave: section<PackWave | null>('wave'),
    route: section<PackRoute | null>('route'),
    deliveries: section<readonly PackDelivery[]>('deliveries'),
    drivers: section<readonly PackDriver[]>('drivers'),
    routingPolicy: section<PackRoutingPolicy>('routingPolicy'),
    slots: section<readonly PackSlot[]>('slots'),
    purchaseOrders: section<readonly PackPurchaseOrder[]>('purchaseOrders'),
    receipts: section<readonly PackReceipt[]>('receipts'),
    supplierInvoices: section<readonly PackSupplierInvoice[]>('supplierInvoices'),
    buyingPolicy: section<PackBuyingPolicy>('buyingPolicy'),
    lossPreventionRules: section<readonly unknown[]>('lossPreventionRules'),
    consentPurposes: section<readonly { purpose: string; channel: string; required?: boolean }[]>('consentPurposes'),
  };
}
