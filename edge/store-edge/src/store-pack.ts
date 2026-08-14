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
  /**
   * Tax rate in basis points, from the product's HSN / tax class.
   *
   * Absent means this product **cannot be priced safely at a lane** and is excluded from the
   * catalogue the till is given, counted rather than shipped at a guessed rate.
   */
  readonly taxBps?: number;
  /** `active`, `clearance`, `discontinued`… Absent means the lane cannot judge it sellable. */
  readonly status?: string;
  /**
   * **Stops sale everywhere, honoured offline (M10-FR-04).**
   *
   * The lane's catalogue has refused a recall-blocked scan since it was written — *even offline*,
   * the loudest safety claim in this codebase. The flag had no field to arrive in, so it never
   * reached a till and the refusal was unreachable. This is that field.
   */
  readonly recallBlock?: boolean;
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
  /**
   * Customer-facing delivery-slot policy (M20-FR-03), sharing the SAME `storeLocation` and
   * `radiusMetres` the driver dispatch uses — one commerce truth (§6.2), not a second copy. All
   * optional and provided together: when set, the customer app offers `deliverySlotsPerDay` equal
   * windows spanning `[deliveryWindowOpen, deliveryWindowClose]` local time (offset by
   * `deliveryUtcOffsetMinutes`) at `deliverySlotCapacity` orders each; when absent, the app offers
   * only the concrete slots the pack carried, or none — never an invented slot.
   */
  readonly deliverySlotsPerDay?: number;
  readonly deliveryWindowOpen?: string; // "HH:MM" local
  readonly deliveryWindowClose?: string; // "HH:MM" local
  readonly deliverySlotCapacity?: number;
  readonly deliveryUtcOffsetMinutes?: number;
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

/**
 * A department, as this tenant defines it (M03-FR-01).
 *
 * The attributes and the regulated flags are **the tenant's own declaration**, never ours: which
 * fields a hypermarket in Tamil Nadu must record for its chilled aisle is a question about that
 * shop and its licences, and a product screen that answered it from a constant in this repository
 * would be wrong for every second tenant.
 */
export interface PackCategory {
  readonly categoryId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly attributes?: readonly {
    readonly key: string;
    readonly label: string;
    readonly type: 'text' | 'number' | 'boolean' | 'enum' | 'date';
    readonly required?: boolean;
    readonly allowed?: readonly string[];
  }[];
  readonly regulated?: readonly string[];
}

/**
 * The product MASTER record (M03) — a different, richer thing from the lane's catalogue slice.
 *
 * `PackProduct` above is what a till needs: a name, a price, some barcodes. This is what the person
 * maintaining the catalogue needs: the department, the HSN code, the effective-dated MRP, the
 * safety content the law asks of a regulated department. A box that only feeds tills never has to
 * carry this at all, and says so rather than serving a thin record as if it were the whole one.
 */
export interface PackMasterProduct {
  readonly productId: string;
  readonly tenantId: string;
  readonly sku: string;
  readonly name: string;
  readonly brand?: string;
  readonly manufacturer?: string;
  readonly primaryCategoryId: string | null;
  readonly parentProductId?: string | null;
  readonly baseUom: string;
  /** HSN / tax class code. Nothing publishes without one. */
  readonly taxClass: string | null;
  readonly mrpHistory?: readonly { readonly value: { readonly minor: number; readonly currency: 'INR' }; readonly effectiveFrom: string }[];
  readonly attributes?: Readonly<Record<string, string>>;
  readonly safety?: {
    readonly ingredients?: string;
    readonly allergens?: readonly string[];
    readonly countryOfOrigin?: string;
    readonly storageConditions?: string;
    readonly netQuantity?: string;
    readonly packerDetails?: string;
    readonly minimumAge?: number;
  };
  readonly lifecycle: 'draft' | 'new' | 'active' | 'clearance' | 'discontinued';
  readonly recallBlocked?: boolean;
}

/** A price entry the cloud has recorded — every one ever set, any status (M05-FR-01). */
export interface PackPriceEntry {
  readonly id: string;
  readonly productId: string;
  readonly scope: 'customer' | 'channel' | 'zone' | 'store';
  readonly scopeRef: string;
  readonly priceMinor: number;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  readonly status: 'draft' | 'active' | 'rolled_back';
  readonly version: number;
}

/** Who sets prices, who checks them, and the margin this tenant will not go below. */
export interface PackPricingPolicy {
  readonly userId: string;
  /** Who may approve a below-floor price or a margin-losing offer. Never the setter (§28). */
  readonly approvers: readonly string[];
  /** Minimum gross margin in basis points. Per-tenant policy, never a constant (M05-FR-02). */
  readonly marginFloorBps: number;
}

/**
 * Where something sits, in the order you walk past it (M04-FR-02).
 *
 * Every field is a **number** rather than a label like "A12", because "A10" sorts before "A9" as
 * text and a picker sent up and down an aisle twice never knows why. The label is for the sign on
 * the aisle; the numbers are what the route is built from.
 */
export interface PackShelfLocation {
  readonly storeId: string;
  readonly locationId: string;
  readonly aisle: number;
  readonly rack: number;
  readonly bay: number;
  readonly shelf: number;
  readonly position: number;
  readonly label?: string;
  readonly zone?: 'ambient' | 'chilled' | 'frozen' | 'secure';
}

/** Which product lives where, and how many fit (M04-FR-02). */
export interface PackShelfAssignment {
  readonly storeId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly capacityMinor: number;
  /** Exactly one primary per product per store; extras are secondary displays. */
  readonly primary: boolean;
}

/**
 * How this store wants its shop walked.
 *
 * `zoneOrder` is the cold-chain decision, and it is **the store's**, not ours: which zones it has,
 * how far apart they are and how long a trolley of chilled goods may stand out are questions about
 * a particular shop and its licences. Absent, the walk is ordered by position only and every screen
 * says so rather than implying a cold chain that was never applied.
 */
export interface PackShelfPolicy {
  readonly zoneOrder?: readonly string[];
}

/**
 * Merchandising thresholds, both per-tenant and neither of them ours to guess.
 *
 * `refillAtBp` decides when a facing is worth walking to: refilling at 90% wastes the staff's day,
 * refilling at 0% means the customer already found the gap. `countStaleAfterMinutes` decides how
 * long a shelf count stays worth acting on — a shop that counts twice a day and one that counts on
 * Sundays need different numbers, and acting on a three-day-old reading wastes a walk.
 */
/** When a figure stops being current, and when it stops being usable (§32). Per-tenant. */
export interface PackReportingPolicy {
  readonly laggingAfterMinutes: number;
  readonly staleAfterMinutes: number;
  /**
   * Who this box's reporting screen acts as, named in the shop's own role assignments.
   *
   * Optional on purpose. Absent means the box does not know who is looking, and the screen then
   * shows every report and **writes nothing out** — because the audit record of an export names
   * who took the data, and it is the only evidence of that afterwards. A default here would put a
   * name nobody holds into that record.
   */
  readonly userId?: string;
}

/** The desk's own limits — every one per-tenant, none of them a constant (M13 / M21). */
export interface PackServicePolicy {
  /** How many days after the sale a return may still be taken. */
  readonly returnWindowDays: number;
  /** Refund value at or above which a DIFFERENT person must approve (M13-FR-03, §28). */
  readonly approvalThresholdMinor: number;
  /** The ceiling on a return with no receipt, which always needs approval too (M13-FR-01). */
  readonly noReceiptCapMinor: number;
  /** What one agent may give away on a case alone; above it, a second signature (M21-FR-03). */
  readonly agentAuthorityMinor: number;
  /** The desk's absolute ceiling for compensation, whoever signs. */
  readonly compensationCapMinor: number;
  /** Who is on the desk. Absent means the box was not told, and nothing may be committed. */
  readonly userId?: string;
}

/** How this shop judges "near expiry". Per-tenant: bread and tinned goods are not one question. */
export interface PackExpiryPolicy {
  readonly nearExpiryDays: number;
  /** Who is on the quality/recall screen. Absent means nothing may be started or closed. */
  readonly userId?: string;
}

/** This shop's own chart-of-accounts headings and who closes its months (M23). */
export interface PackFinancePolicy {
  /** The month being worked on, e.g. "2026-07". */
  readonly period: string;
  readonly tradingDayCutoff: string;
  /**
   * Which journal references belong to which control total — per-tenant.
   *
   * Never a constant: one shop's chart of accounts is not another's, and a heading guessed here
   * would file a shop's takings where its accountant does not look for them.
   */
  readonly journalPrefixes: {
    readonly takings: string;
    readonly tax: string;
    readonly refunds: string;
  };
  /** Who is on the finance screen. Absent means nothing may be closed. */
  readonly userId?: string;
}

/**
 * Who is on the GST reconciliation screen, and what they may do there (API-09 · A20/A23).
 *
 * The permissions travel with the payload so the screen gates itself the SAME way the server does —
 * `finance.einvoice.read` to see the queue, `finance.einvoice.generate` to run a portal action. A
 * screen inventing its own permission set would be deciding, on its own authority, who may chase up
 * a stuck e-invoice.
 */
export interface PackGstReconciliationPolicy {
  /** Who is looking. Absent means the queue is read-only and says so. */
  readonly userId?: string;
  /** The permission codes this user holds — never defaulted; an absent grant denies. */
  readonly permissions: readonly string[];
}

/** Who is on the category-rules screen and what they may do (M03-FR-01·CAT-POLICY). */
export interface PackCategoryPolicyPolicy {
  readonly userId?: string;
  /** The permission codes this user holds — `catalogue.pack.read` to see the rules. Never defaulted. */
  readonly permissions: readonly string[];
}

/** Who is on the GST-returns screen and what they may do (owner directive item 3; M23). */
export interface PackGstReturnsPolicy {
  readonly userId?: string;
  /** The permission codes this user holds — `finance.gstr.read` to see the filing queue. Never defaulted. */
  readonly permissions: readonly string[];
}

/** Who is on the waste & write-off review screen and what they may do (M28-FR-01). */
export interface PackWastePolicy {
  readonly userId?: string;
  /** The permission codes this user holds — `waste.view` to review losses. Never defaulted. */
  readonly permissions: readonly string[];
}

/** Who is on the stock-count review screen and what they may do (M09-FR-04). */
export interface PackCountsPolicy {
  readonly userId?: string;
  /** The permission codes this user holds — `count.view` to review counts. Never defaulted. */
  readonly permissions: readonly string[];
}

/** Who administers this shop, and the windows it judges accounts and devices by. */
export interface PackAdminPolicy {
  /** Days without a login after which an account is stale enough to review. Per-tenant. */
  readonly dormantAfterDays: number;
  /** Who is on the admin screen. Absent means nothing privileged may be done. */
  readonly userId?: string;
}

/** Who is at the AI control screen, and how long a draft stays fit to accept. All per-tenant. */
export interface PackAiPolicy {
  /**
   * Minutes after which a draft must be regenerated against fresh figures.
   *
   * Per-tenant on purpose: a shop that reprices weekly and one that reprices hourly do not agree
   * on when yesterday's reasoning stopped being reasoning.
   */
  readonly staleAfterMinutes: number;
  /** The month spend is summarised over, e.g. "2026-08". */
  readonly period: string;
  /**
   * The owner's own platform runtime ceiling in minor units (D3).
   *
   * **Absent means the owner has never agreed one**, and the screen shows no summary at all
   * rather than reporting every assistant comfortably inside a limit nobody set.
   */
  readonly platformCeilingMinor?: number;
  /** Who is on the AI screen. Absent means nothing may be stopped and nothing may be accepted. */
  readonly userId?: string;
}

/** Who is on the migration screen, and the thresholds this shop's cutover is judged by. */
export interface PackMigrationPolicy {
  readonly cutoverId: string;
  /**
   * Consecutive clean parallel-run days this shop requires before a cutover (§34.1).
   *
   * Per-tenant on purpose: three days is a sensible starting figure and it is not a rule of
   * nature, and a shop with a busier weekend may want its run to span one.
   */
  readonly requiredCleanDays: number;
  /**
   * Who ran the load.
   *
   * **Absent means nothing can be signed at all** (§28) — a signer who is also the loader is
   * checking their own work, and a separation that cannot be checked is not a separation.
   */
  readonly loadOperator?: string;
  /** Whether the cutover has been accepted, for the retirement assessment (MG-12). */
  readonly cutoverAccepted?: boolean;
  /** When the delta since the final extract was applied (MG-09). */
  readonly deltaAppliedAt?: string;
  /** When a rollback was **performed**. A designed one leaves this absent, deliberately. */
  readonly rollbackDemonstratedAt?: string;
  /** Who is on the night, with a role each. Absent means nobody has been asked. */
  readonly namedTeam?: readonly { readonly userId: string; readonly role: string }[];
  /** When the owner gave GO. */
  readonly ownerGoBy?: string;
  /** Assessments still open that could need the legacy records (MG-12). Absent is not nought. */
  readonly openAssessments?: number;
  /** Who is on the migration screen. Absent means nothing may be signed, decided or rolled back. */
  readonly userId?: string;
}

export interface PackMerchandisingPolicy {
  readonly refillAtBp: number;
  readonly countStaleAfterMinutes: number;
  /** The role that picks up a refill task. A task with no owner is not a task (M25). */
  readonly refillRole: string;
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

/** A storage bin the warehouse handheld can put stock into (M09 / OA-9). */
export interface PackWarehouseBin {
  readonly binId: string;
  readonly storeId: string;
  readonly locationId?: string;
  /** Units this bin holds. Zero means "not a storage bin" and is refused at put-away. */
  readonly capacityMinor: number;
  /** A pickable bin feeds the shop floor or an order; bad stock is kept out of it. */
  readonly pickable: boolean;
  readonly zone?: 'ambient' | 'chilled' | 'frozen' | 'secure' | 'quarantine';
}

/** Goods received and awaiting put-away — the handheld's worklist, per product+batch. */
export interface PackWarehouseGoodsIn {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  /** The condition the stock is in (a `StockState`; kept as a string to stay dependency-free). */
  readonly state: string;
  /** The batch's expiry, so put-away can keep expired stock out of a pickable bin. */
  readonly expiry: string | null;
  readonly recalled?: boolean;
}

/** Which barcode identifies which product, and at what pack level — for scanning at goods-in. */
export interface PackWarehouseBarcode {
  readonly barcode: string;
  readonly productId: string;
  readonly level: string;
}

/** What is on order, as the receiver sees it — so an over-delivery or an off-order item is caught. */
export interface PackWarehouseOrdered {
  readonly productId: string;
  readonly quantityMinor: number;
  readonly unitCostMinor: number;
  readonly currency: string;
}

/** A pending warehouse approval the supervisor may decide (§28) — a stock-adjustment, count variance,
 *  or over-delivery raised by the floor. The maker is `requestedBy`; the supervisor cannot be them. */
export interface PackWarehouseApproval {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly requestedBy: string;
  readonly branchId?: string | null;
  readonly valueMinor?: number;
  readonly currency?: string;
}

/** Who the supervisor is, for the maker-checker check: their id, branch scope and approval limit. */
export interface PackWarehouseSupervisor {
  readonly userId: string;
  readonly branchScope: readonly string[] | 'all';
  readonly authorityLimitMinor?: number;
  readonly currency?: string;
}

/**
 * The warehouse work the cloud assigned this box (M09 / OA-9) — the bins, the catalogue for
 * scanning, what is on order, what is awaiting put-away and what is under recall. The offline
 * Warehouse PWA boots on exactly this; the same authoritative rules decide every scan.
 */
export interface PackWarehouse {
  readonly assignmentId: string;
  readonly workerId: string;
  readonly storeId: string;
  readonly bins: readonly PackWarehouseBin[];
  /** Current bin contents, per `binId|productId|batchId` — for supervisory stock visibility & occupancy. */
  readonly contents?: Readonly<Record<string, number>>;
  readonly goodsIn?: readonly PackWarehouseGoodsIn[];
  readonly barcodes?: readonly PackWarehouseBarcode[];
  readonly ordered?: readonly PackWarehouseOrdered[];
  readonly grnId?: string;
  readonly recalledProductIds?: readonly string[];
  readonly recalledBatchIds?: readonly string[];
  /** Pending §28 approvals the supervisor may decide, and who the supervisor is. */
  readonly approvals?: readonly PackWarehouseApproval[];
  readonly supervisor?: PackWarehouseSupervisor;
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
  /** The tenant's own department hierarchy (M03-FR-01). Without it nothing can be scored. */
  readonly categories: Register<readonly PackCategory[]>;
  /** The full master records (M03) — richer than the lane's slice, and not every box holds them. */
  readonly productMaster: Register<readonly PackMasterProduct[]>;
  /** Every price ever set, any status — the append-only history (M05-FR-01). */
  readonly priceEntries: Register<readonly PackPriceEntry[]>;
  /** Who prices, who approves, and the margin floor (M05-FR-02, §28). */
  readonly pricingPolicy: Register<PackPricingPolicy>;
  /** The shop's physical shelf addresses — what sequences the picker's walk (M04-FR-02). */
  readonly shelfLocations: Register<readonly PackShelfLocation[]>;
  /** Which product lives on which shelf, and how many fit. */
  readonly shelfAssignments: Register<readonly PackShelfAssignment[]>;
  /** How this store wants its shop walked — the cold-chain order is the store's decision. */
  readonly shelfPolicy: Register<PackShelfPolicy>;
  /** What should be on each shelf (M04-FR-03). Absent means this store has never published one. */
  readonly planogram: Register<unknown | null>;
  /** Every shelf count ever taken — append-only, a recount is a new observation. */
  readonly shelfCounts: Register<readonly unknown[]>;
  /** What the stockroom holds, per product — the difference between a task and a wish. */
  readonly backstock: Register<Readonly<Record<string, number>>>;
  /** The range, as effective-dated decisions (M04-FR-01). */
  readonly assortment: Register<readonly unknown[]>;
  /** The floor in named areas with their square footage (M04-FR-04). */
  readonly spaceAreas: Register<readonly unknown[]>;
  /** Sales and margin per area, in minor units. Absent for an area means it cannot be ranked. */
  readonly salesByAreaMinor: Register<Readonly<Record<string, number>>>;
  readonly marginByAreaMinor: Register<Readonly<Record<string, number>>>;
  /** Supplier display-space contracts, what finance received, and what is still on the floor. */
  readonly displayContracts: Register<readonly unknown[]>;
  readonly fundingReceivedMinor: Register<Readonly<Record<string, number>>>;
  readonly stillOccupying: Register<readonly string[]>;
  /** Merchandising thresholds — the refill level and how long a count stays actionable. */
  readonly merchandisingPolicy: Register<PackMerchandisingPolicy>;
  /**
   * What this shop actually records (D13).
   *
   * The gaps are the point: a report whose fact is absent here **refuses by name** rather than
   * running and coming back as zero. Absent altogether means the box can run nothing at all and
   * says so for each report, which is honest for a shop that has just been switched on.
   */
  readonly reportingRecords: Register<readonly string[]>;
  /** The shop's own roles and who holds them, so an export runs the SAME default-deny check. */
  readonly roles: Register<readonly unknown[]>;
  readonly roleAssignments: Register<readonly unknown[]>;
  /** Reporting freshness thresholds (§32), per-tenant. */
  readonly reportingPolicy: Register<PackReportingPolicy>;
  /**
   * What the desk needs to take goods back (M13) and run its cases (M21).
   *
   * `returnHistory` is the returns the CLOUD knows about — another branch's, or ones taken before
   * this box was installed. It is merged with the box's own durable return log, never replaced by
   * it: the cloud alone leaves the at-most-once guard blind exactly when the line is down, and the
   * box alone cannot see a return taken at the other shop.
   */
  readonly returnHistory: Register<readonly unknown[]>;
  /** Open and recent service cases (M21-FR-03). */
  readonly serviceCases: Register<readonly unknown[]>;
  /** Satisfaction responses, reported WITH their response rate and never as a bare average. */
  readonly satisfaction: Register<readonly unknown[]>;
  /** The desk's own SLA targets. Absent means this shop has never agreed any (M21-FR-04). */
  readonly slaPolicy: Register<unknown>;
  /** Return windows, refund thresholds and compensation limits — all per-tenant. */
  readonly servicePolicy: Register<PackServicePolicy>;
  /**
   * Every batch this box knows of, with its expiry (M10-FR-01).
   *
   * Absent means the shop does not track batches at all, and the screen says exactly that rather
   * than showing an empty expiry list — which reads as *nothing is going out of date*.
   */
  readonly batches: Register<readonly unknown[]>;
  /** Recalls already started, so one is never started twice and closure is auditable (M10-FR-04). */
  readonly recalls: Register<readonly unknown[]>;
  /** The near-expiry window and who is on the desk. Per-tenant. */
  readonly expiryPolicy: Register<PackExpiryPolicy>;
  /**
   * What the accounts actually received for the period, in whatever state each posting reached.
   *
   * **Absent means the box has never been told**, which is not the same as the accounts having
   * received nothing — and a control total whose posted side is a substituted nought would
   * disagree with the ledger by the whole month's takings, which is at least loud.
   */
  readonly tallyPostings: Register<readonly unknown[]>;
  /** What the shop's own record says it took in the period — the ledger side of every total. */
  readonly financeLedger: Register<unknown>;
  /** Whether the period is already closed, and by whom. */
  readonly periodState: Register<unknown>;
  /** The shop's own chart-of-accounts headings and the month being worked on. */
  readonly financePolicy: Register<PackFinancePolicy>;
  /**
   * The last-synced GST reconciliation queue (e-invoices + e-way bills), as rows the screen renders.
   *
   * **Absent means the box has never been told**, which the screen shows as its sample stand-in — not
   * an empty queue, which would read as "every document is settled" (P-08).
   */
  readonly gstReconciliationQueue: Register<readonly unknown[]>;
  /** Who is on the GST reconciliation screen and what they may do there. */
  readonly gstReconciliationPolicy: Register<PackGstReconciliationPolicy>;
  /** The categories and their effective-dated policy histories, for the category-rules screen. */
  readonly categoryPolicyCategories: Register<readonly unknown[]>;
  /** Who is on the category-rules screen and what they may do there. */
  readonly categoryPolicyPolicy: Register<PackCategoryPolicyPolicy>;
  /**
   * Every GSTR-1 filing period folded to its current submission state, for the GST-returns screen.
   *
   * **Absent means the box has never been told**, shown as the sample stand-in — not an empty queue, which
   * would read as "every return filed" (P-08).
   */
  readonly gstReturnsQueue: Register<readonly unknown[]>;
  /** Who is on the GST-returns screen and what they may do there. */
  readonly gstReturnsPolicy: Register<PackGstReturnsPolicy>;
  /**
   * Every recorded write-off folded to a review row, for the waste screen.
   *
   * **Absent means the box has never been told**, shown as the sample stand-in — not an empty list, which
   * would read as "no losses today" (P-08).
   */
  readonly wasteWriteOffs: Register<readonly unknown[]>;
  /** Who is on the waste review screen and what they may do there. */
  readonly wastePolicy: Register<PackWastePolicy>;
  /**
   * Every reconciled blind count folded to a review row, for the stock-count screen (M09-FR-04).
   *
   * **Absent means the box has never been told**, shown as the sample stand-in — not an empty list, which
   * would read as "every count matched" (P-08).
   */
  readonly countsQueue: Register<readonly unknown[]>;
  /** Who is on the stock-count review screen and what they may do there. */
  readonly countsPolicy: Register<PackCountsPolicy>;
  /** Every account, so joiners, movers and leavers can be reviewed (M02-FR-04). */
  readonly accounts: Register<readonly unknown[]>;
  /**
   * Every support session ever granted — **never pruned.** Somebody outside the business saw this
   * tenant's live data, and that record is the only evidence of it (hard rule #6).
   */
  readonly supportSessions: Register<readonly unknown[]>;
  /** The tills, handhelds and phones this shop runs on (M33). */
  readonly devices: Register<readonly unknown[]>;
  /** Minimum versions this tenant enforces. **Absent means nothing is being enforced.** */
  readonly versionPolicy: Register<unknown>;
  /** Audit records in scope for a retention review, the shop's policies, and any legal holds. */
  readonly auditRecords: Register<readonly unknown[]>;
  readonly retentionPolicies: Register<readonly unknown[]>;
  readonly legalHolds: Register<readonly unknown[]>;
  /** Who administers this shop and the windows it judges by. */
  readonly adminPolicy: Register<PackAdminPolicy>;
  /**
   * Every kill switch ever pulled, lifted or not — **never pruned** (hard rule #6).
   *
   * Absent means the box has never been told, which is not the same as no switch being pulled: a
   * substituted empty list would show ten assistants running while one of them is stopped.
   */
  readonly killSwitches: Register<readonly unknown[]>;
  /** Per-agent spending ceilings. An agent missing here has none, and cannot make a call at all. */
  readonly agentBudgets: Register<readonly unknown[]>;
  /**
   * Every model call ever metered, each carrying its own period.
   *
   * **The only source of what an assistant has spent.** There was briefly a second — a carried
   * map of per-agent totals with no period on it — and on a box that had been running for a
   * month the two disagreed by an entire budget: the assistants tab read 95,000 spent while the
   * cost tab beside it read nought. One number, one source.
   */
  readonly aiUsage: Register<readonly unknown[]>;
  /** Drafts waiting for a named human. AI drafts; a person commits (P-05, hard rule #5). */
  readonly aiPending: Register<readonly unknown[]>;
  /** The last evaluation per agent. **An agent absent here has never been evaluated.** */
  readonly aiEvaluations: Register<Readonly<Record<string, { readonly passed: number; readonly total: number; readonly at: string }>>>;
  /** Who is on the AI screen, the month, and the owner's platform ceiling. */
  readonly aiPolicy: Register<PackAiPolicy>;
  /**
   * The migration (MG-01…MG-12). Every section absent by default, and each absence is meaningful.
   *
   * **`migrationTotals` absent is not a reconciliation with nothing wrong**, and
   * `migrationExceptions` absent is not clean data. The cutover gate treats an unanswerable
   * check as a failure, which is the only safe reading: the alternative is a shop switching
   * systems on the strength of questions nobody asked.
   */
  readonly migrationSources: Register<readonly unknown[]>;
  /** Every exception ever raised — **never pruned.** A resolved one is the evidence (#6). */
  readonly migrationExceptions: Register<readonly unknown[]>;
  readonly migrationTotals: Register<readonly unknown[]>;
  readonly parallelDays: Register<readonly unknown[]>;
  readonly parallelDifferences: Register<readonly unknown[]>;
  readonly historyExclusions: Register<readonly unknown[]>;
  readonly legacyArchive: Register<unknown>;
  readonly migrationPolicy: Register<PackMigrationPolicy>;
  /** Loss-prevention thresholds — data, so a store tunes its own without code (M15-FR-01). */
  readonly lossPreventionRules: Register<readonly unknown[]>;
  /** The purposes this tenant asks a customer's consent for (M16 / PRV). */
  readonly consentPurposes: Register<readonly { readonly purpose: string; readonly channel: string; readonly required?: boolean }[]>;
  /** The warehouse work assigned to this box — bins, catalogue, orders, goods-in, recalls (M09 / OA-9). */
  readonly warehouse: Register<PackWarehouse>;
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
    categories: notKnown(why),
    productMaster: notKnown(why),
    priceEntries: notKnown(why),
    pricingPolicy: notKnown(why),
    shelfLocations: notKnown(why),
    shelfAssignments: notKnown(why),
    shelfPolicy: notKnown(why),
    planogram: notKnown(why),
    shelfCounts: notKnown(why),
    backstock: notKnown(why),
    assortment: notKnown(why),
    spaceAreas: notKnown(why),
    salesByAreaMinor: notKnown(why),
    marginByAreaMinor: notKnown(why),
    displayContracts: notKnown(why),
    fundingReceivedMinor: notKnown(why),
    stillOccupying: notKnown(why),
    merchandisingPolicy: notKnown(why),
    reportingRecords: notKnown(why),
    roles: notKnown(why),
    roleAssignments: notKnown(why),
    reportingPolicy: notKnown(why),
    returnHistory: notKnown(why),
    serviceCases: notKnown(why),
    satisfaction: notKnown(why),
    slaPolicy: notKnown(why),
    servicePolicy: notKnown(why),
    batches: notKnown(why),
    recalls: notKnown(why),
    expiryPolicy: notKnown(why),
    tallyPostings: notKnown(why),
    financeLedger: notKnown(why),
    periodState: notKnown(why),
    financePolicy: notKnown(why),
    gstReconciliationQueue: notKnown(why),
    gstReconciliationPolicy: notKnown(why),
    categoryPolicyCategories: notKnown(why),
    categoryPolicyPolicy: notKnown(why),
    gstReturnsQueue: notKnown(why),
    gstReturnsPolicy: notKnown(why),
    wasteWriteOffs: notKnown(why),
    wastePolicy: notKnown(why),
    countsQueue: notKnown(why),
    countsPolicy: notKnown(why),
    accounts: notKnown(why),
    supportSessions: notKnown(why),
    devices: notKnown(why),
    versionPolicy: notKnown(why),
    auditRecords: notKnown(why),
    retentionPolicies: notKnown(why),
    legalHolds: notKnown(why),
    adminPolicy: notKnown(why),
    killSwitches: notKnown(why),
    agentBudgets: notKnown(why),
    aiUsage: notKnown(why),
    aiPending: notKnown(why),
    aiEvaluations: notKnown(why),
    aiPolicy: notKnown(why),
    migrationSources: notKnown(why),
    migrationExceptions: notKnown(why),
    migrationTotals: notKnown(why),
    parallelDays: notKnown(why),
    parallelDifferences: notKnown(why),
    historyExclusions: notKnown(why),
    legacyArchive: notKnown(why),
    migrationPolicy: notKnown(why),
    lossPreventionRules: notKnown(why),
    consentPurposes: notKnown(why),
    warehouse: notKnown(why),
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
    categories: section<readonly PackCategory[]>('categories'),
    productMaster: section<readonly PackMasterProduct[]>('productMaster'),
    priceEntries: section<readonly PackPriceEntry[]>('priceEntries'),
    pricingPolicy: section<PackPricingPolicy>('pricingPolicy'),
    shelfLocations: section<readonly PackShelfLocation[]>('shelfLocations'),
    shelfAssignments: section<readonly PackShelfAssignment[]>('shelfAssignments'),
    shelfPolicy: section<PackShelfPolicy>('shelfPolicy'),
    planogram: section<unknown | null>('planogram'),
    shelfCounts: section<readonly unknown[]>('shelfCounts'),
    backstock: section<Readonly<Record<string, number>>>('backstock'),
    assortment: section<readonly unknown[]>('assortment'),
    spaceAreas: section<readonly unknown[]>('spaceAreas'),
    salesByAreaMinor: section<Readonly<Record<string, number>>>('salesByAreaMinor'),
    marginByAreaMinor: section<Readonly<Record<string, number>>>('marginByAreaMinor'),
    displayContracts: section<readonly unknown[]>('displayContracts'),
    fundingReceivedMinor: section<Readonly<Record<string, number>>>('fundingReceivedMinor'),
    stillOccupying: section<readonly string[]>('stillOccupying'),
    merchandisingPolicy: section<PackMerchandisingPolicy>('merchandisingPolicy'),
    reportingRecords: section<readonly string[]>('reportingRecords'),
    roles: section<readonly unknown[]>('roles'),
    roleAssignments: section<readonly unknown[]>('roleAssignments'),
    reportingPolicy: section<PackReportingPolicy>('reportingPolicy'),
    returnHistory: section<readonly unknown[]>('returnHistory'),
    serviceCases: section<readonly unknown[]>('serviceCases'),
    satisfaction: section<readonly unknown[]>('satisfaction'),
    slaPolicy: section<unknown>('slaPolicy'),
    servicePolicy: section<PackServicePolicy>('servicePolicy'),
    batches: section<readonly unknown[]>('batches'),
    recalls: section<readonly unknown[]>('recalls'),
    expiryPolicy: section<PackExpiryPolicy>('expiryPolicy'),
    tallyPostings: section<readonly unknown[]>('tallyPostings'),
    financeLedger: section<unknown>('financeLedger'),
    periodState: section<unknown>('periodState'),
    financePolicy: section<PackFinancePolicy>('financePolicy'),
    gstReconciliationQueue: section<readonly unknown[]>('gstReconciliationQueue'),
    gstReconciliationPolicy: section<PackGstReconciliationPolicy>('gstReconciliationPolicy'),
    categoryPolicyCategories: section<readonly unknown[]>('categoryPolicyCategories'),
    categoryPolicyPolicy: section<PackCategoryPolicyPolicy>('categoryPolicyPolicy'),
    gstReturnsQueue: section<readonly unknown[]>('gstReturnsQueue'),
    gstReturnsPolicy: section<PackGstReturnsPolicy>('gstReturnsPolicy'),
    wasteWriteOffs: section<readonly unknown[]>('wasteWriteOffs'),
    wastePolicy: section<PackWastePolicy>('wastePolicy'),
    countsQueue: section<readonly unknown[]>('countsQueue'),
    countsPolicy: section<PackCountsPolicy>('countsPolicy'),
    accounts: section<readonly unknown[]>('accounts'),
    supportSessions: section<readonly unknown[]>('supportSessions'),
    devices: section<readonly unknown[]>('devices'),
    versionPolicy: section<unknown>('versionPolicy'),
    auditRecords: section<readonly unknown[]>('auditRecords'),
    retentionPolicies: section<readonly unknown[]>('retentionPolicies'),
    legalHolds: section<readonly unknown[]>('legalHolds'),
    adminPolicy: section<PackAdminPolicy>('adminPolicy'),
    killSwitches: section<readonly unknown[]>('killSwitches'),
    agentBudgets: section<readonly unknown[]>('agentBudgets'),
    aiUsage: section<readonly unknown[]>('aiUsage'),
    aiPending: section<readonly unknown[]>('aiPending'),
    aiEvaluations: section<Readonly<Record<string, { readonly passed: number; readonly total: number; readonly at: string }>>>('aiEvaluations'),
    aiPolicy: section<PackAiPolicy>('aiPolicy'),
    migrationSources: section<readonly unknown[]>('migrationSources'),
    migrationExceptions: section<readonly unknown[]>('migrationExceptions'),
    migrationTotals: section<readonly unknown[]>('migrationTotals'),
    parallelDays: section<readonly unknown[]>('parallelDays'),
    parallelDifferences: section<readonly unknown[]>('parallelDifferences'),
    historyExclusions: section<readonly unknown[]>('historyExclusions'),
    legacyArchive: section<unknown>('legacyArchive'),
    migrationPolicy: section<PackMigrationPolicy>('migrationPolicy'),
    lossPreventionRules: section<readonly unknown[]>('lossPreventionRules'),
    consentPurposes: section<readonly { purpose: string; channel: string; required?: boolean }[]>('consentPurposes'),
    warehouse: section<PackWarehouse>('warehouse'),
  };
}
