// API-03 Purchase orders — the front door of buying (M06-FR-01/02/04). A purchase order is a
// *controlled, approved commitment*, and this is the cloud boundary that makes one durable:
//
//   • a PO is PROPOSED by a buyer (the requisitioner is the authenticated user, never a client
//     field), then ISSUED only by a SECOND person — the approver cannot be the requisitioner (§28,
//     hard rule #5). Both identities are server-attributed, so separation of duties cannot be spoofed
//     by sending someone else's name in the body. The tested `decide` (packages/approvals) builds the
//     approval and refuses a self-approval; the tested `issuePurchaseOrder` (packages/purchasing)
//     re-checks it and refuses a blocked supplier (M06-FR-01) and an empty/negative line;
//   • a blocked supplier can never be issued a PO — the block is its own append-only, latest-wins
//     record, so "this supplier is under a hold" is a fact the boundary reads, not a client claim;
//   • the OPEN COMMITMENT (M06-FR-04) — what the shop is on the hook to pay for and has not yet
//     received — is computed from the issued POs by the tested `computeOpenCommitment`. Until a PO
//     exists this figure is *not known* (see the `/commitments` route), which is a different answer
//     from zero; once POs are issued it is a real number an owner can buy against.
//
// The rules are the tested engines in `@sre/purchasing` and `@sre/approvals` (the
// `services-run-on-their-tested-engine` guardrail); this file is the persistence + HTTP skin.
// Proposing/issuing is gated distinctly (`purchase.order.propose` vs `purchase.order.approve`, the
// same split as price.change and catalogue.merge); reads are `purchase.commitment.read`. Receipt-
// and cancellation-netting of the open figure is the next increment — the engine already takes both.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, concurrentChange, scopeOf } from '../../kernel/src/index';
import { judgeBuyingScope, type BuyingScope } from '../../../packages/purchasing/src/buying-scope';
import {
  issuePurchaseOrder, computeOpenCommitment, BlockedSupplierError,
  type PurchaseOrderLineInput, type OpenCommitment,
} from '../../../packages/purchasing/src/index';
import { requestApproval, decide, type Approver } from '../../../packages/approvals/src/index';
import { mayApproveValue, authorityWords, type Authority } from '../../../packages/approvals/src/authority-rules';
import { money, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import { unitCostFromPackCost, UnknownPackLevelError, type PackHierarchy } from '../../../packages/product/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { assertLocationInScope, stockReadScope, locationIsItsOwnBranch, type LocationBranches } from '../../inventory/src/location-scope';
import { normaliseUom, valueAtCost, minorPerUnitOf } from '../../../packages/contracts/src/quantity';
import { checkOrderAgainstBudget, judgeApprovalOnBudget, openToBuyGuardKey, valueByCategory, type OpenToBuyDeps, type BudgetCheck } from './open-to-buy';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import { segregationConflict } from '../../../packages/purchasing/src/segregation';
import { segregationRefusal, type SegregationPort } from './segregation-of-duties';
import { shopClock, shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

/** A durable purchase order — proposed by a buyer, and (once a second person approves) issued. */
export interface StoredPurchaseOrder {
  readonly poId: string;
  readonly number: string;
  readonly supplierId: string;
  /**
   * OB-37 "A" (owner, 10 Oct 2026): the store the order is delivered to — a location in head office's org hierarchy. Required
   * on every new order; an order raised before the rule has none and is listed as "store not named", never guessed.
   */
  readonly deliverToLocationId?: string;
  /** The buyer who raised it — the authenticated user, not a client field (§28). */
  readonly requisitionedBy: string;
  readonly at: string;
  readonly lines: readonly PurchaseOrderLineInput[];
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  readonly status: 'proposed' | 'issued';
  /** The approver, once issued — always someone other than the requisitioner (§28). */
  readonly approvedBy: string | null;
  readonly issuedAt: string | null;
  /** Received quantity per product against this PO — folded from posted receipts (M06-FR-04). */
  readonly receivedByProduct: Readonly<Record<string, number>>;
  /** Cancelled quantity per product — folded from approved cancellations (M06-FR-04). */
  readonly cancelledByProduct: Readonly<Record<string, number>>;
  /** How many times the PO's lines have been amended (the history is retained in the ledger). */
  readonly amendmentCount: number;
  /** WF-03 · D02-FR-01 (round 8): the open-to-buy check made when the order was proposed — the approver sees it. */
  readonly budgetCheck?: BudgetCheck;
  /** M06-FR-02 (OB-288 P3): the blanket agreement this order is a call-off release of — priced at the agreement's cost. */
  readonly blanketAgreementId?: string;
  /** WF-03 (OB-288 P3): the requisition this order was raised from, when the buyer named one (its raiser is on record). */
  readonly requisitionId?: string;
  /**
   * M06-FR-04 · OB-289 (D-6 "Both, per order"): central via the warehouse, central direct to the store, or local — named by
   * the buyer or derived from who raised it and where it goes (`buyingScopeSource`). Absent only on an order raised before
   * the rule; it is then reported as "scope not recorded", never guessed.
   */
  readonly buyingScope?: BuyingScope;
  readonly buyingScopeSource?: 'named' | 'derived';
  /**
   * OB-290 (integration follow-up, owner 23 Oct 2026 "an over-limit PO routes to the owner"): the order's value is above
   * the purchase-order limit of the person who raised it (the owner's server-held rule) — so it is the OWNER's to decide,
   * said on the order from the moment it is raised. Absent when the raiser's own limit covers it (or none is wired).
   */
  readonly routedToOwner?: { readonly raiserLimitMinor: number | null; readonly raiserLimitFrom: string | null; readonly valueMinor: number; readonly rulesVersion: number };
}

/**
 * M06-FR-02 (OB-288 P3): the blanket-agreement side of a call-off release. A release is an ordinary purchase order that
 * names `blanketAgreementId`: its prices are the agreement's, it is judged against the agreement's validity and ceiling
 * when it is proposed AND again when a second person issues it, and both writes land only while the agreement's own write
 * guard still holds (two releases at once cannot both spend the same headroom). The tested `judgeCallOff` decides.
 */
export interface BlanketReleaseHooks {
  readonly judge: (tenantId: string, input: {
    readonly agreementId: string; readonly poId: string; readonly supplierId: string | undefined; readonly onDate: string;
    readonly lines: readonly { readonly productId: string; readonly quantity: number }[];
  }) => Promise<
    | { readonly ok: true; readonly supplierId: string; readonly currency: CurrencyCode; readonly lines: readonly PurchaseOrderLineInput[]; readonly deliverToLocationId?: string; readonly guard: { readonly key: string; readonly expectedVersion: number } }
    | { readonly ok: false; readonly status: number; readonly code: string; readonly detail: string }>;
  /** Record the proposed release under the agreement's guard (else `ConcurrencyConflictError`). */
  readonly propose: (tenantId: string, po: StoredPurchaseOrder, guard: { readonly key: string; readonly expectedVersion: number }) => Promise<void>;
  /** Issue the release under the agreement's guard and, when a budget governs it, the month's open-to-buy guard too. */
  readonly issue: (tenantId: string, poId: string, approvedBy: string, issuedAt: string, reason: string,
    guard: { readonly key: string; readonly expectedVersion: number }, budgetGuard?: { readonly key: string; readonly expectedVersion: number }) => Promise<void>;
}

/**
 * M02-FR-02 · OB-290: a person's money authority for a kind of decision, from the owner's limits held on head office's
 * server (identity's `authorityOf`, services/api/src/p1-identity-adapters.ts) — never a figure in a request. The PO routes
 * read it twice: the RAISER's limit (a local order within it is theirs; above it the order goes to the owner) and the
 * APPROVER's (an order above it is refused for them by name — it goes to the owner). Absent on a bare stub: no limit is
 * known there, as before, and nothing here invents one.
 */
export type AuthorityOf = (tenantId: string, userId: string, subjectType: string) => Promise<Authority> | Authority;

export interface PurchaseOrderDeps {
  /** R1b · R1c (M01-FR-02): the shop's calendar — "today" for a release or a range check, and a PO's budget month. */
  readonly calendar?: ShopCalendarOf;
  /** SF-11: the product's pack hierarchy (case → inner → base), so a line ordered by the case converts exactly. Optional on a stub. */
  readonly packOf?: (tenantId: string, productId: string) => Promise<PackHierarchy | undefined> | PackHierarchy | undefined;
  /** One PO by id, folded to its current state, or undefined. */
  readonly order: (tenantId: string, poId: string) => Promise<StoredPurchaseOrder | undefined> | StoredPurchaseOrder | undefined;
  /** Every PO — the buying review surface. */
  readonly all: (tenantId: string) => Promise<readonly StoredPurchaseOrder[]> | readonly StoredPurchaseOrder[];
  /** Whether this supplier is currently under a hold (latest-wins block record). */
  readonly supplierBlocked: (tenantId: string, supplierId: string) => Promise<boolean> | boolean;
  /**
   * OB-32 "A" (owner, 10 Oct 2026): the supplier master's status for this supplier — `active` once finance approved it,
   * `proposed` while it waits, `undefined` when the master does not know it. A purchase order is refused by name for an
   * unknown or not-yet-approved supplier. Optional only so a bare stub may omit it; the running system provides it.
   */
  /** OB-37: the org node a "deliver to" names (kind and status), or undefined when the hierarchy has no such place. */
  readonly orgLocation?: (tenantId: string, locationId: string) => Promise<{ readonly kind: string; readonly status: string } | undefined> | { readonly kind: string; readonly status: string } | undefined;
  /** OB-37 · PA-01-r1: which branch a location belongs to — the deliver-to store must be inside the buyer's branches. */
  readonly locationBranches?: LocationBranches;
  /** OB-31: the unit the product master counts a product in (orderedQty is in its smallest steps), or undefined. */
  readonly productUom?: (tenantId: string, productId: string) => Promise<string | undefined> | string | undefined;
  /** FUL-11: a product's range status at a store on a date (`rangeStatusOf`) — the order refuses what the store does not range. */
  readonly rangeStatus?: (tenantId: string, storeId: string, productId: string, onDate: string) => Promise<'no_range' | 'not_ranged' | 'listed' | 'clearance' | 'delisted'>;
  /**
   * D-16 (R3, OB-189): the product MASTER's lifecycle (`draft` · `new` · `active` · `clearance` · `discontinued`), or
   * undefined when the master does not know the product. A discontinued or clearance product is refused on an order
   * whatever the store's range says — including a store with no range recorded (`no_range`). Optional on a bare stub.
   */
  readonly masterLifecycle?: (tenantId: string, productId: string) => Promise<string | undefined> | string | undefined;
  readonly supplierStatus?: (tenantId: string, supplierId: string) => Promise<'active' | 'proposed' | undefined> | 'active' | 'proposed' | undefined;
  /** Record a proposed PO. Idempotent on the PO id. */
  readonly propose: (tenantId: string, po: StoredPurchaseOrder, key: string) => Promise<void> | void;
  /**
   * Seal a placed purchase order into the tamper-evident domain audit trail (M34-FR-01), attributed to
   * the acting buyer. Optional — the running system provides it; a bare deps stub may omit it. The actor
   * is ALWAYS the caller (`ctx.userId`), never client-supplied; a PO commits the shop to spend, so it is
   * the "who ordered what, from whom, for how much" record an auditor comes looking for. No card/tender
   * data exists on a purchase order (hard rule #3).
   */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** Record the issue decision (the approver + reason). Idempotent on the PO id. */
  readonly issue: (tenantId: string, poId: string, approvedBy: string, issuedAt: string, reason: string, key: string,
    /** WF-03 (round 10): issue only while this write guard (the month's open-to-buy) still holds — else `ConcurrencyConflictError`. */
    budgetGuard?: { readonly key: string; readonly expectedVersion: number }) => Promise<void> | void;
  /** Set a supplier's block state. Append-only; latest wins. */
  readonly setSupplierBlocked: (tenantId: string, supplierId: string, blocked: boolean, reason: string, by: string, at: string, key: string) => Promise<void> | void;
  /** Amend an issued PO's lines (approved). Append-only — the prior lines stay on the ledger (hard rule #2). */
  readonly amend: (tenantId: string, poId: string, amendmentId: string, lines: readonly PurchaseOrderLineInput[], reason: string, by: string, at: string,
    /** OB-63: an amendment that raises the order's value lands only while the month's open-to-buy guard still holds. */
    budgetGuard?: { readonly key: string; readonly expectedVersion: number },
    /** Round 13 (verifier A4): the order's own guard version read BEFORE the order — the amendment lands only on the order
     *  it was judged on; any change since (another amendment, a receipt, a cancellation) refuses it (never re-tried). */
    orderVersion?: number) => Promise<void> | void;
  /** Round 13 (verifier A4): the version of the order's own write guard — read before the order an amendment is judged on. */
  readonly orderVersion?: (tenantId: string, poId: string) => Promise<number> | number;
  /** Record an approved cancellation of quantity per product against a PO. Accumulates. */
  readonly cancel: (tenantId: string, poId: string, cancellationId: string, cancelledByProduct: Readonly<Record<string, number>>, reason: string, by: string, at: string) => Promise<void> | void;
  /** Post received quantity per product against a PO (in the PO's ordering units). Accumulates. */
  readonly postReceipt: (tenantId: string, poId: string, receiptId: string, receivedByProduct: Readonly<Record<string, number>>, by: string, at: string) => Promise<void> | void;
  /** WF-03 · D02-FR-01 (round 8): category purchase budgets — checked at proposal, gated at approval. Optional on a stub. */
  readonly openToBuy?: OpenToBuyDeps;
  /** M06-FR-02 (OB-288 P3): blanket agreements — a release is judged and written under the agreement's guard. */
  readonly blanket?: BlanketReleaseHooks;
  /** M02-FR-02 · OB-290: the server-held money authority (identity's `authorityOf`); absent ⇒ no limit known here. */
  readonly authorityOf?: AuthorityOf;
  /** WF-03 (OB-288 P3): a requisition the buyer names, so the order carries it (its raiser is the requisition act, §28). */
  readonly requisitionExists?: (tenantId: string, requisitionId: string) => Promise<boolean> | boolean;
  /** OB-288 P3 (M06-FR-02 · §28): who did each step of the order — a receipt posted by its buyer, matcher or payer is refused. */
  readonly segregation?: Pick<SegregationPort, 'actorsOf'>;
  /** OB-288 P3 (M07-FR-01): the accepted advance ship notice for an order, offered with its open delivery. */
  readonly asnOf?: (tenantId: string, poId: string) => Promise<DeliveryAsn | undefined>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const rupees = (m: number): string => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isMinor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

interface RawLine {
  readonly productId: string; readonly orderedQty: number; readonly unitCost: { readonly minor: number; readonly currency: string; readonly per?: number };
  readonly uom?: string;
  readonly ordered?: { readonly level: string; readonly quantity: number; readonly unitsPerPack: number; readonly packCost: { readonly minor: number; readonly currency: string } };
}

const isRawLine = (v: unknown): v is RawLine =>
  isObj(v) && isStr(v['productId']) && isPosInt(v['orderedQty'])
  && isObj(v['unitCost']) && isMinor((v['unitCost'] as Record<string, unknown>)['minor'])
  && typeof (v['unitCost'] as Record<string, unknown>)['currency'] === 'string'
  && (v['uom'] === undefined || isStr(v['uom']));

/**
 * SF-11 (M03-FR-02 · OB-31): a line ordered BY THE PACK — `{ productId, pack: { level, quantity }, packCost }` — becomes a line
 * in the product's smallest steps through its own pack hierarchy (OB-31 rule 5: a level counts in whole base units): 5 cases of
 * 24 is 120 items; 4 sacks of 25 kg is 100 kg = 100 000 g. The cost per whole unit (an item; a kilo) is the pack cost divided
 * exactly — and (OB-46) a pack cost that does not divide into whole paise is carried as the pack's cost, never rounded per unit. A line without `pack` passes through untouched.
 */
async function expandPackedLines(deps: PurchaseOrderDeps, tenantId: string, raw: unknown): Promise<unknown> {
  if (!Array.isArray(raw)) return raw;
  const out: unknown[] = [];
  for (const v of raw) {
    if (!isObj(v) || v['pack'] === undefined) {
      // OB-46: a cost "per N units" is only ever the pack conversion's own — never taken from a line typed in base units.
      if (isObj(v) && isObj(v['unitCost']) && 'per' in v['unitCost']) {
        out.push({ ...v, unitCost: Object.fromEntries(Object.entries(v['unitCost']).filter(([k]) => k !== 'per')) });
      } else out.push(v);
      continue;
    }
    const pack = v['pack'];
    const packCost = v['packCost'];
    if (!isStr(v['productId']) || !isObj(pack) || !isStr(pack['level']) || !isPosInt(pack['quantity'])
      || !isObj(packCost) || !isMinor(packCost['minor']) || (packCost['minor'] as number) < 0 || typeof packCost['currency'] !== 'string') {
      throw apiError(400, {
        code: 'not_readable_as_a_pack_line',
        whatHappened: 'A line ordered by the pack needs { productId, pack: { level, quantity (whole, more than 0) }, packCost: { minor, currency } } — the cost of ONE pack at that level.',
        wasItSaved: 'not_saved',
        nextSafeAction: 'Send the pack level, how many, and what one pack costs. Nothing was saved.',
      });
    }
    const productId = v['productId'];
    const hierarchy = await deps.packOf?.(tenantId, productId);
    if (hierarchy === undefined) {
      throw apiError(422, {
        code: 'no_pack_hierarchy',
        whatHappened: `Product ${productId} has no pack hierarchy defined, so "${pack['level']}" cannot be turned into a number of units.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Define the product\'s packs first (POST /v1/catalogue/products/:productId/pack), or order it in its base unit. Nothing was saved.',
      });
    }
    let converted;
    try {
      converted = unitCostFromPackCost(hierarchy, pack['level'], packCost['minor'] as number);
    } catch (err) {
      if (err instanceof UnknownPackLevelError) {
        throw apiError(422, {
          code: 'unknown_pack_level',
          whatHappened: `Product ${productId}'s pack has no level "${pack['level']}" (it has ${hierarchy.levels.map((l) => l.level).join(', ')}).`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Order in one of the levels the product\'s pack defines. Nothing was saved.',
        });
      }
      throw err;
    }
    // OB-46 "A" (owner, 11 Oct 2026): a pack cost that does not divide into whole paise per unit is CARRIED as the cost of the
    // pack — `{ minor: pack cost, per: units in the pack }` — and every value is units × pack cost ÷ units per pack, rounded
    // once. Never refused, never rounded per unit.
    if (!converted.exact) {
      out.push({
        productId, orderedQty: (pack['quantity'] as number) * converted.unitsPerPack * minorPerUnitOf(hierarchy.baseUom),
        unitCost: { minor: packCost['minor'], currency: packCost['currency'], per: converted.unitsPerPack }, uom: hierarchy.baseUom,
        ordered: { level: pack['level'], quantity: pack['quantity'], unitsPerPack: converted.unitsPerPack, packCost: { minor: packCost['minor'], currency: packCost['currency'] } },
      });
      continue;
    }
    out.push({
      productId, orderedQty: (pack['quantity'] as number) * converted.unitsPerPack * minorPerUnitOf(hierarchy.baseUom),
      unitCost: { minor: converted.unitCostMinor, currency: packCost['currency'] }, uom: hierarchy.baseUom,
      ordered: { level: pack['level'], quantity: pack['quantity'], unitsPerPack: converted.unitsPerPack, packCost: { minor: packCost['minor'], currency: packCost['currency'] } },
    });
  }
  return out;
}

/**
 * The open-commitment view an issued PO carries (M06-FR-04): ordered − received − cancelled, valued
 * at the PO unit cost, netting the posted receipts and approved cancellations. A proposed PO is not a
 * commitment yet, so it has none.
 */
const openOf = (po: StoredPurchaseOrder): OpenCommitment | null =>
  po.status === 'issued' ? computeOpenCommitment(po.lines, po.receivedByProduct, po.cancelledByProduct) : null;

/** A `{ productId: quantity }` map with whole, non-negative quantities and at least one entry. */
const isQtyMap = (v: unknown): v is Record<string, number> =>
  isObj(v) && Object.keys(v).length > 0
  && Object.entries(v).every(([k, n]) => k.trim() !== '' && typeof n === 'number' && Number.isSafeInteger(n) && n >= 0);

/** Amendments, cancellations and receipts only apply to an ISSUED commitment — a proposed PO is refused. */
const poNotIssued = (poId: string, verb: string) => apiError(409, {
  code: 'purchase_order_not_issued',
  whatHappened: `Purchase order ${poId} is not issued, so it cannot be ${verb} — only an issued commitment can be.`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Approve and issue the PO first (a second person), then try again. Nothing was changed.',
});

/** OB-32 "A": refuse a purchase order for a supplier the master does not know, or one finance has not yet approved. */
export async function requireApprovedSupplier(deps: Pick<PurchaseOrderDeps, 'supplierStatus'>, tenantId: string, supplierId: string): Promise<void> {
  if (deps.supplierStatus === undefined) return;
  const status = await deps.supplierStatus(tenantId, supplierId);
  if (status === undefined) {
    throw apiError(422, {
      code: 'supplier_unknown',
      whatHappened: `There is no supplier "${supplierId}" in the supplier master — a purchase order is only raised to a supplier the shop has on record (OB-32).`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Add the supplier to the supplier master and have finance approve it, then raise the order. Nothing was recorded.',
    });
  }
  if (status !== 'active') {
    throw apiError(422, {
      code: 'supplier_not_approved',
      whatHappened: `Supplier "${supplierId}" is still waiting for finance to approve it — a purchase order is only raised to an approved supplier (OB-32).`,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Have finance approve the supplier, then raise or issue the order. Nothing was recorded.',
    });
  }
}

/** OB-37: "store not named" — an order raised before every order had to name its store (never guessed). */
export const STORE_NOT_NAMED = 'store_not_named';

/** An order as every read presents it: its deliver-to store, or said to have none (OB-37). */
export const presentOrder = (po: StoredPurchaseOrder): StoredPurchaseOrder & { readonly deliverTo: string } =>
  ({ ...po, deliverTo: po.deliverToLocationId ?? STORE_NOT_NAMED });

/** One open delivery a store expects: an ISSUED order to it with something still to come (OB-37 · for the store pack). */
export interface OpenDelivery {
  readonly poId: string;
  readonly number: string;
  readonly supplierId: string;
  readonly deliverToLocationId: string;
  readonly issuedAt: string | null;
  readonly lines: readonly { readonly productId: string; readonly orderedQty: number; readonly receivedQty: number; readonly cancelledQty: number; readonly openQty: number }[];
  /** OB-288 P3 (M07-FR-01): the supplier's advance ship notice a buyer accepted for this order — offered to the receiver. */
  readonly asn?: DeliveryAsn;
}

/** OB-288 P3: an advance ship notice as the receiving phone carries it (cached, so it can be received against offline). */
export interface DeliveryAsn {
  readonly asnId: string;
  readonly expectedAt: string;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly uom: string }[];
}

/**
 * OB-37: the deliveries a STORE is waiting for — issued orders whose deliver-to location belongs to that store (its branch in
 * the hierarchy, or the place itself), with at least one line not yet fully received or cancelled. Pure; Batch 1's store-pack
 * builder reads it through `GET /v1/purchase/deliveries/open?storeId=` or calls this directly. Orders with no store named
 * are NOT any store's — they are returned separately by the route as `storeNotNamed` for a person to fix.
 */
export function openDeliveriesFor(orders: readonly StoredPurchaseOrder[], storeId: string, branchOf: (locationId: string) => string = (l) => l): readonly OpenDelivery[] {
  const out: OpenDelivery[] = [];
  for (const po of orders) {
    if (po.status !== 'issued' || po.deliverToLocationId === undefined) continue;
    if (po.deliverToLocationId !== storeId && branchOf(po.deliverToLocationId) !== storeId) continue;
    const byProduct = new Map<string, number>();
    for (const l of po.lines) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + l.orderedQty);
    const lines = [...byProduct].map(([productId, orderedQty]) => {
      const receivedQty = po.receivedByProduct[productId] ?? 0;
      const cancelledQty = po.cancelledByProduct[productId] ?? 0;
      return { productId, orderedQty, receivedQty, cancelledQty, openQty: Math.max(0, orderedQty - receivedQty - cancelledQty) };
    });
    if (!lines.some((l) => l.openQty > 0)) continue;
    out.push({ poId: po.poId, number: po.number, supplierId: po.supplierId, deliverToLocationId: po.deliverToLocationId, issuedAt: po.issuedAt, lines });
  }
  return out;
}

/** OB-37: a new order must name a store head office has in its hierarchy, inside the buyer's own branches. */
export async function requireDeliverTo(deps: Pick<PurchaseOrderDeps, 'orgLocation' | 'locationBranches'>, ctx: Parameters<Route['handler']>[0], value: unknown): Promise<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    throw apiError(422, {
      code: 'deliver_to_store_required',
      whatHappened: 'A purchase order must name the store it is delivered to (deliverToLocationId) — the place the receiving staff will expect it (OB-37).',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Choose the store this order is for, then raise it again. Nothing was recorded.',
    });
  }
  const locationId = value.trim();
  if (deps.orgLocation !== undefined) {
    const node = await deps.orgLocation(ctx.tenantId, locationId);
    if (node === undefined || node.status === 'closed' || node.kind === 'company') {
      throw apiError(422, {
        code: 'unknown_location',
        whatHappened: `"${locationId}" is not an open store, warehouse or department in head office's organisation — an order cannot be delivered to a place nobody receives at (OB-37).`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Pick the store from the organisation list, then raise the order again. Nothing was recorded.',
      });
    }
  }
  await assertLocationInScope(ctx, locationId, deps.locationBranches); // PA-01-r1: only to a store inside the buyer's branches
  return locationId;
}

/**
 * M06-FR-04 · OB-289 / OB-290: judge (or derive) the order's buying scope with the tested `judgeBuyingScope` — who raised it
 * (company-wide = head office), where it goes (a warehouse that belongs to no store, or a store), and the raiser's local
 * limit through the seam. Refused by name.
 */
/** OB-290: a person's PO limit as the buying-scope engine reads it — a number, `null` unlimited, `undefined` none held. */
export const poLimitOf = (a: Authority): number | null | undefined =>
  a.state === 'unlimited' || a.state === 'not_value_limited' ? null : a.state === 'limit' ? a.limitMinor ?? 0 : undefined;

async function buyingScopeFor(deps: PurchaseOrderDeps, ctx: Parameters<Route['handler']>[0], named: unknown, deliverTo: string, valueMinor: number, raiser: Authority | undefined): Promise<{ readonly scope: BuyingScope; readonly source: 'named' | 'derived' }> {
  const node = deps.orgLocation === undefined ? undefined : await deps.orgLocation(ctx.tenantId, deliverTo);
  const branchOf = deps.locationBranches === undefined ? undefined : await deps.locationBranches(ctx.tenantId);
  const standaloneWarehouse = node?.kind === 'warehouse' && (branchOf === undefined || branchOf(deliverTo) === deliverTo);
  const companyWide = scopeOf(ctx) === 'all';
  const needsLimit = named === 'local' || ((named === undefined || named === null) && !companyWide);
  const limit = !needsLimit || raiser === undefined ? undefined : poLimitOf(raiser);
  const judged = judgeBuyingScope({ named, raiserCompanyWide: companyWide, destination: standaloneWarehouse ? 'central_warehouse' : 'store', valueMinor, localLimitMinor: limit });
  if (!judged.ok) {
    throw apiError(judged.refusal === 'unknown_buying_scope' ? 400 : 422, {
      code: judged.refusal,
      whatHappened: `${judged.detail} (M06-FR-04 · OB-289/OB-290).`,
      wasItSaved: 'not_saved',
      nextSafeAction: judged.refusal === 'local_limit_unknown'
        ? 'The owner sets a purchase-order limit for your role on the Approval rules page, or head office raises a central order. Nothing was ordered.'
        : 'Choose the buying scope that fits who is buying and where the goods go. Nothing was ordered.',
    });
  }
  return { scope: judged.scope, source: judged.source };
}

/** A release's lines as sent: { productId, orderedQty } only — a price, a pack or a unit cost on a release is refused. */
const isReleaseLine = (v: unknown): v is { productId: string; orderedQty: number } =>
  isObj(v) && isStr(v['productId']) && isPosInt(v['orderedQty']) && v['unitCost'] === undefined && v['pack'] === undefined && v['packCost'] === undefined;

type JudgedRelease = Extract<Awaited<ReturnType<BlanketReleaseHooks['judge']>>, { ok: true }> & { readonly agreementId: string };

/** M06-FR-02 (OB-288 P3): judge a proposal that names a blanket agreement; undefined for an ordinary order. */
async function judgeRelease(deps: PurchaseOrderDeps, tenantId: string, poId: string, b: Record<string, unknown>): Promise<JudgedRelease | undefined> {
  if (b['blanketAgreementId'] === undefined) return undefined;
  const agreementId = isStr(b['blanketAgreementId']) ? b['blanketAgreementId'].trim() : '';
  const lines = b['lines'];
  if (poId === '' || agreementId === '' || !Array.isArray(lines) || lines.length === 0 || !lines.every(isReleaseLine)) {
    throw apiError(400, {
      code: 'not_readable_as_a_release',
      whatHappened: 'A call-off release needs { blanketAgreementId, lines[] (each { productId, orderedQty } — whole, more than 0) }. The price is the agreement\'s: a release carries none of its own.',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Send the agreement and the quantities to call off. Nothing was ordered.',
    });
  }
  if (deps.blanket === undefined) {
    throw apiError(409, { code: 'blanket_agreements_unavailable', whatHappened: 'Blanket agreements are not wired here, so a release cannot be judged.', wasItSaved: 'not_saved', nextSafeAction: 'Raise an ordinary purchase order. Nothing was ordered.' });
  }
  const judged = await deps.blanket.judge(tenantId, {
    agreementId, poId, supplierId: isStr(b['supplierId']) ? b['supplierId'] : undefined, onDate: await shopToday(deps, tenantId),
    lines: (lines as { productId: string; orderedQty: number }[]).map((l) => ({ productId: l.productId, quantity: l.orderedQty })),
  });
  if (!judged.ok) {
    throw apiError(judged.status, { code: judged.code, whatHappened: `${judged.detail}.`, wasItSaved: 'not_saved', nextSafeAction: 'Change the release to fit the agreement, or raise an ordinary purchase order. Nothing was ordered.' });
  }
  return { ...judged, agreementId };
}

/** M06-FR-02 (OB-288 P3): a release judged again at issue, on today's date, with every other release counted. */
async function rejudgeReleaseAtIssue(deps: PurchaseOrderDeps, tenantId: string, po: StoredPurchaseOrder): Promise<JudgedRelease> {
  const agreementId = po.blanketAgreementId ?? '';
  if (deps.blanket === undefined) {
    throw apiError(409, { code: 'blanket_agreements_unavailable', whatHappened: `Purchase order ${po.poId} is a release of blanket agreement ${agreementId}, which cannot be judged here.`, wasItSaved: 'not_saved', nextSafeAction: 'Try again later. Nothing was issued.' });
  }
  const byProduct = new Map<string, number>();
  for (const l of po.lines) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + l.orderedQty);
  const judged = await deps.blanket.judge(tenantId, {
    agreementId, poId: po.poId, supplierId: po.supplierId, onDate: await shopToday(deps, tenantId),
    lines: [...byProduct].map(([productId, quantity]) => ({ productId, quantity })),
  });
  if (!judged.ok) {
    throw apiError(judged.status, { code: judged.code, whatHappened: `${judged.detail}.`, wasItSaved: 'not_saved', nextSafeAction: 'This release no longer fits its agreement; cancel it or raise an ordinary purchase order. Nothing was issued.' });
  }
  return { ...judged, agreementId };
}

export function purchaseOrderRoutes(deps: PurchaseOrderDeps): readonly Route[] {
  return [
    {
      // Propose a purchase order. Body: { number?, supplierId, lines[] each { productId, orderedQty,
      // unitCost{minor,currency} } }. The requisitioner is the authenticated buyer. Idempotent on the
      // PO id — a re-sent proposal returns the existing PO unchanged (hard rule #2).
      api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId',
      permission: 'purchase.order.propose', idempotent: true,
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const sent = (ctx.body ?? {}) as Record<string, unknown>;
        // M06-FR-02 (OB-288 P3): a CALL-OFF RELEASE of a blanket agreement names `blanketAgreementId` and its lines as
        // { productId, orderedQty } only — the price is the agreement's, never the release's. A re-sent release returns the
        // order it already made; a new one is judged here (validity, the products on it, the ceiling) and written under the
        // agreement's guard. Everything below then applies to it exactly as to any order.
        const already = sent['blanketAgreementId'] === undefined || poId === '' ? undefined : await deps.order(ctx.tenantId, poId);
        if (already !== undefined) {
          return { status: 200, body: { order: presentOrder(already), openCommitment: openOf(already), alreadyProposed: true } };
        }
        const release = await judgeRelease(deps, ctx.tenantId, poId, sent);
        const b: Record<string, unknown> = release === undefined ? sent : {
          ...sent, supplierId: release.supplierId,
          ...(sent['deliverToLocationId'] === undefined && release.deliverToLocationId !== undefined ? { deliverToLocationId: release.deliverToLocationId } : {}),
          lines: release.lines.map((l) => ({ productId: l.productId, orderedQty: l.orderedQty, unitCost: { ...l.unitCost }, ...(l.uom === undefined ? {} : { uom: l.uom }) })),
        };
        const lines = release === undefined ? await expandPackedLines(deps, ctx.tenantId, b['lines']) : b['lines']; // SF-11: a line ordered by the case, in base units
        if (poId === '' || !isStr(b['supplierId']) || !Array.isArray(lines) || lines.length === 0 || !lines.every(isRawLine)) {
          throw apiError(400, {
            code: 'not_readable_as_a_purchase_order',
            whatHappened: 'A purchase order needs a poId in the path and { supplierId, lines[] (each with productId, a positive whole orderedQty, and unitCost { minor, currency }) } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the supplier and at least one line with a positive quantity and a unit cost.',
          });
        }
        const currency = (lines[0] as RawLine).unitCost.currency;
        if (!isCurrencyCode(currency) || !(lines as RawLine[]).every((l) => l.unitCost.currency === currency)) {
          throw apiError(422, {
            code: 'purchase_order_currency_mismatch',
            whatHappened: `Every line on a purchase order must be priced in the same known currency (${currency}).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Price all lines in one currency the system knows (e.g. INR), then send again.',
          });
        }
        // Idempotent: a re-sync of the same PO returns it unchanged rather than raising a second one.
        const existing = await deps.order(ctx.tenantId, poId);
        if (existing !== undefined) {
          return { status: 200, body: { order: presentOrder(existing), openCommitment: openOf(existing), alreadyProposed: true } };
        }
        await requireApprovedSupplier(deps, ctx.tenantId, b['supplierId']);
        const deliverToLocationId = await requireDeliverTo(deps, ctx, b['deliverToLocationId']);
        // D-16 (R3, OB-189): the product master's lifecycle stops ordering first — a discontinued or clearance product is
        // never put on a purchase order, even where the store's range is silent (no range) or still lists it.
        if (deps.masterLifecycle !== undefined) {
          for (const l of lines as RawLine[]) {
            const lifecycle = await deps.masterLifecycle(ctx.tenantId, l.productId);
            if (lifecycle !== 'discontinued' && lifecycle !== 'clearance') continue;
            throw apiError(422, {
              code: 'product_lifecycle_stops_ordering',
              whatHappened: `${l.productId} is marked ${lifecycle} on the product master, so it cannot be put on a purchase order${lifecycle === 'clearance' ? ' — it is being sold down, never reordered' : ''} (D-16). This holds whatever the store's range says.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Take the line off the order. If the product should be bought again, change its lifecycle on the product master first. Nothing was ordered.',
            });
          }
        }
        // FUL-11 (M04-FR-01): the effective range is enforced at ordering — a store that has a range does not order what
        // it does not carry (delisted), what it is selling down (clearance) or what it never ranged. A store with no range
        // recorded yet is not judged (there is nothing to enforce) — the range screen is where that starts.
        if (deps.rangeStatus !== undefined) {
          const branches = deps.locationBranches === undefined ? undefined : await deps.locationBranches(ctx.tenantId);
          const storeId = branches?.(deliverToLocationId) ?? deliverToLocationId;
          const today = await shopToday(deps, ctx.tenantId);
          for (const l of lines as RawLine[]) {
            const status = await deps.rangeStatus(ctx.tenantId, storeId, l.productId, today);
            if (status === 'no_range' || status === 'listed') continue;
            throw apiError(422, {
              code: 'not_in_range',
              whatHappened: `${l.productId} is ${status === 'not_ranged' ? 'not in' : `${status} in`} ${storeId}'s range today — an order for it would put on the shelf what the store has decided not to carry${status === 'clearance' ? ' (it is being sold down, never reordered)' : ''}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Take the line off the order, or list the product in the store\'s range first. Nothing was ordered.',
            });
          }
        }
        // WF-03 (OB-288 P3): the requisition this order is raised from, when named — it must be on head office's register.
        const requisitionId = isStr(b['requisitionId']) ? b['requisitionId'].trim() : undefined;
        if (b['requisitionId'] !== undefined && (requisitionId === undefined || deps.requisitionExists === undefined || !(await deps.requisitionExists(ctx.tenantId, requisitionId)))) {
          throw apiError(422, {
            code: 'requisition_unknown',
            whatHappened: `There is no requisition "${String(b['requisitionId'])}" on head office's register, so this order cannot say it was raised from one.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Name a requisition the buying worklist holds, or raise the order without one. Nothing was ordered.',
          });
        }
        // OB-31: each line in the product's own unit (orderedQty in its smallest steps — grams for kg), priced per whole unit.
        // A release's lines are the agreement's own (its unit, and an OB-46 per-pack cost), exactly as judged.
        const poLines: PurchaseOrderLineInput[] = release === undefined ? [] : [...release.lines];
        for (const l of release === undefined ? lines as RawLine[] : []) {
          const master = deps.productUom === undefined ? undefined : await deps.productUom(ctx.tenantId, l.productId);
          const uom = master === undefined ? undefined : normaliseUom(master) ?? master;
          poLines.push({
            productId: l.productId, orderedQty: l.orderedQty, ...(uom === undefined ? {} : { uom }),
            // OB-46: a case cost carried exactly (only ever set by the pack conversion above, never taken from a plain line).
            unitCost: l.ordered !== undefined && isPosInt(l.unitCost.per) && l.unitCost.per > 1 ? { ...money(l.unitCost.minor, currency), per: l.unitCost.per } : money(l.unitCost.minor, currency),
            // SF-11: the order as the buyer placed it, by the pack — kept beside the base-unit figures it was converted to.
            ...(l.ordered === undefined ? {} : { ordered: { ...l.ordered, packCost: money(l.ordered.packCost.minor, currency) } }),
          });
        }
        const totalMinor = poLines.reduce((s, l) => s + valueAtCost(l.orderedQty, l.uom ?? 'ea', l.unitCost), 0);
        // OB-290: the RAISER's purchase-order limit, from the owner's rules on the server. Above it the order goes to the owner.
        const raiser = deps.authorityOf === undefined ? undefined : await deps.authorityOf(ctx.tenantId, ctx.userId, 'purchase_order');
        // M06-FR-04 · OB-289 / OB-290: the order's buying scope — central (head office only) or local.
        const scope = await buyingScopeFor(deps, ctx, b['buyingScope'], deliverToLocationId, totalMinor, raiser);
        const routedToOwner = raiser === undefined || mayApproveValue(raiser, totalMinor) ? undefined
          : { raiserLimitMinor: raiser.state === 'limit' ? raiser.limitMinor : null, raiserLimitFrom: raiser.fromRole, valueMinor: totalMinor, rulesVersion: raiser.rulesVersion };
        const proposed: StoredPurchaseOrder = {
          poId,
          number: isStr(b['number']) ? b['number'] : poId,
          supplierId: b['supplierId'],
          deliverToLocationId,
          requisitionedBy: ctx.userId, // server-attributed — the buyer the kernel authenticated
          at: deps.now(),
          lines: poLines,
          totalMinor,
          currency,
          status: 'proposed',
          approvedBy: null,
          issuedAt: null,
          receivedByProduct: {},
          cancelledByProduct: {},
          amendmentCount: 0,
          ...(release === undefined ? {} : { blanketAgreementId: release.agreementId }),
          ...(requisitionId === undefined ? {} : { requisitionId }),
          buyingScope: scope.scope, buyingScopeSource: scope.source,
          ...(routedToOwner === undefined ? {} : { routedToOwner }),
        };
        // WF-03 (round 8): the open-to-buy check rides on the order — never a refusal here; the approval escalates if over.
        const po: StoredPurchaseOrder = deps.openToBuy === undefined ? proposed : { ...proposed, budgetCheck: await checkOrderAgainstBudget(deps.openToBuy, ctx.tenantId, proposed) };
        if (release === undefined) await deps.propose(ctx.tenantId, po, ctx.idempotencyKey ?? poId);
        else {
          try {
            await deps.blanket!.propose(ctx.tenantId, po, release.guard);
          } catch (err) {
            if (err instanceof ConcurrencyConflictError) throw concurrentChange(`blanket agreement ${release.agreementId} (another release was raised or issued against it a moment ago)`);
            throw err;
          }
        }
        // Seal the purchase commitment — who ordered what, from whom, for how much — attributed to the
        // acting buyer. Aggregates only; no card/tender data exists on a PO (hard rule #3).
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'purchase.order.place', objectType: 'purchase-order', objectId: poId,
          at: po.at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            supplierId: po.supplierId, totalMinor: String(po.totalMinor), currency: po.currency,
            lineCount: String(po.lines.length), status: po.status, deliverTo: deliverToLocationId,
            ...(po.blanketAgreementId === undefined ? {} : { blanketAgreementId: po.blanketAgreementId }),
            ...(po.requisitionId === undefined ? {} : { requisitionId: po.requisitionId }),
            buyingScope: scope.scope,
            ...(routedToOwner === undefined ? {} : { routedTo: 'owner', raiserLimitMinor: String(routedToOwner.raiserLimitMinor ?? 'not_set') }),
          },
          correlationId: poId,
        });
        return {
          status: 201,
          body: {
            order: po, openCommitment: null,
            ...(routedToOwner === undefined ? {} : { approval: { routedTo: 'owner', why: `This order is ${rupees(totalMinor)}; ${ctx.userId}'s purchase-order limit is ${authorityWords(raiser!)}. An order above the raiser's limit is the owner's to decide.` } }),
          },
        };
      },
    },
    {
      // Approve and issue a proposed PO — the SECOND person. Body: { reason }. §28 is enforced twice:
      // the tested `decide` refuses a self-approval, and `issuePurchaseOrder` re-checks the approver is
      // not the requisitioner. A blocked supplier is refused. Idempotent — a re-issue returns the PO.
      api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId/approval',
      permission: 'purchase.order.approve', idempotent: true,
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const reason = isStr(b['reason']) ? b['reason'].trim() : '';
        const po = await deps.order(ctx.tenantId, poId);
        if (po === undefined) throw notFound(`purchase order ${poId}`);
        if (po.status === 'issued') {
          return { status: 200, body: { order: po, openCommitment: openOf(po), alreadyIssued: true } };
        }
        if (reason === '') {
          throw apiError(422, {
            code: 'reason_required',
            whatHappened: 'Issuing a purchase order needs a reason for the audit trail — why this order, at this value, is approved.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "reason": "…" } and issue again. Nothing was issued.',
          });
        }
        // Build the approval server-side from the stored proposal — the value is the PO total, the
        // maker is the recorded requisitioner, and the approver is THIS authenticated user.
        const request = requestApproval({
          id: poId, subjectType: 'purchase_order', subjectRef: poId,
          requestedBy: po.requisitionedBy, value: money(po.totalMinor, po.currency),
        });
        // M02-FR-02 · OB-290: the APPROVER's own purchase-order limit, from the owner's rules on the server (never the body).
        // An order above it is not theirs to issue — it goes to the owner (whose authority is unlimited).
        const authority = deps.authorityOf === undefined ? undefined : await deps.authorityOf(ctx.tenantId, ctx.userId, 'purchase_order');
        if (authority !== undefined && ctx.userId !== po.requisitionedBy && !mayApproveValue(authority, po.totalMinor)) {
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'purchase.order.routed_to_owner', objectType: 'purchase-order', objectId: poId,
            at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { status: po.status },
            after: { status: po.status, totalMinor: String(po.totalMinor), approverLimit: authorityWords(authority), routedTo: 'owner' }, correlationId: poId,
          });
          throw apiError(422, {
            code: 'above_your_limit_goes_to_owner',
            whatHappened: `Purchase order ${poId} is ${rupees(po.totalMinor)}; ${ctx.userId}'s purchase-order limit is ${authorityWords(authority)}. An order above a person's limit goes to the owner (OB-290).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The owner decides it. Nothing was issued.',
          });
        }
        const approver: Approver = { userId: ctx.userId, branchScope: 'all', authorityLimit: null };
        const outcome = decide(request, approver, 'approved', reason, deps.now());
        if (!outcome.ok) {
          if (outcome.refusal === 'self_approval_forbidden') {
            throw apiError(409, {
              code: 'proposer_cannot_approve',
              whatHappened: `${ctx.userId} raised this purchase order and cannot also approve it — a PO is a spend commitment and needs a second person (§28).`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Have a different authorised person approve it. Nothing was issued.',
            });
          }
          throw apiError(422, {
            code: outcome.refusal,
            whatHappened: `The approval was refused: ${outcome.refusal}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Resolve the reason above and issue again. Nothing was issued.',
          });
        }
        await requireApprovedSupplier(deps, ctx.tenantId, po.supplierId);
        const blocked = await deps.supplierBlocked(ctx.tenantId, po.supplierId);
        // WF-03 (round 10): the month's open-to-buy guard is read BEFORE the orders the budget is judged on, and the order
        // issues only while it still holds — two approvals at the same moment cannot both spend the same remaining budget.
        const period = await shopClock(deps.calendar).monthOf(ctx.tenantId, po.at); // R1b: the PO's month in the shop
        const budgetVersion = blocked || deps.openToBuy?.budgetVersion === undefined ? undefined : await deps.openToBuy.budgetVersion(ctx.tenantId, period);
        // WF-03 (round 8): checked again now — an order over open-to-buy escalates to a person who may exceed the budget.
        const judged = blocked || deps.openToBuy === undefined ? undefined
          : await judgeApprovalOnBudget(deps.openToBuy, { tenantId: ctx.tenantId, userId: ctx.userId, branchId: ctx.branchId ?? null }, po, b['overBudgetReason']);
        const budgetAtApproval = judged?.check;
        // Only an order a budget governs takes the guard (an order in categories with no budget spends no open-to-buy).
        const budgetGuard = budgetVersion === undefined || budgetAtApproval === undefined || budgetAtApproval.categories.every((c) => c.budgetMinor === null)
          ? undefined : { key: openToBuyGuardKey(period), expectedVersion: budgetVersion };
        try {
          issuePurchaseOrder({
            id: po.poId, number: po.number, supplierId: po.supplierId,
            requisitionedBy: po.requisitionedBy, at: po.at, lines: po.lines,
            supplierBlocked: blocked, approval: outcome.request,
          });
        } catch (err) {
          if (err instanceof BlockedSupplierError) {
            throw apiError(409, {
              code: 'supplier_blocked',
              whatHappened: `Supplier ${po.supplierId} is under a hold and cannot be issued a purchase order (M06-FR-01).`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Lift the supplier hold (with a reason) if it is resolved, then issue again. Nothing was issued.',
            });
          }
          throw err;
        }
        // M06-FR-02 (OB-288 P3): a call-off release is judged AGAIN at issue — the agreement still approved, still valid today,
        // and the ceiling still holding with every other release counted — and issued under the agreement's guard.
        const releaseAtIssue = po.blanketAgreementId === undefined ? undefined : await rejudgeReleaseAtIssue(deps, ctx.tenantId, po);
        const issuedAt = deps.now();
        try {
          if (releaseAtIssue === undefined) await deps.issue(ctx.tenantId, poId, ctx.userId, issuedAt, reason, ctx.idempotencyKey ?? poId, budgetGuard);
          else await deps.blanket!.issue(ctx.tenantId, poId, ctx.userId, issuedAt, reason, releaseAtIssue.guard, budgetGuard);
        } catch (err) {
          if (err instanceof ConcurrencyConflictError && releaseAtIssue !== undefined && err.key === releaseAtIssue.guard.key) throw concurrentChange(`blanket agreement ${po.blanketAgreementId ?? ''} (another release was raised or issued against it a moment ago)`);
          if (err instanceof ConcurrencyConflictError) throw concurrentChange(`${period}'s purchase budget (another order was issued against it a moment ago)`);
          throw err;
        }
        // Issued: only now is an over-budget override put on the record.
        await judged?.recordOverride?.();
        const issued: StoredPurchaseOrder = { ...po, status: 'issued', approvedBy: ctx.userId, issuedAt };
        return { status: 200, body: { order: issued, openCommitment: openOf(issued), ...(budgetAtApproval === undefined ? {} : { budgetAtApproval }) } };
      },
    },
    {
      // Put a supplier under a hold, or lift it (M06-FR-01). Append-only, latest wins, reason mandatory.
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/block-status',
      permission: 'purchase.supplier.block', idempotent: true,
      handler: async (ctx) => {
        const supplierId = (ctx.params['supplierId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const blocked = b['blocked'];
        const reason = isStr(b['reason']) ? b['reason'].trim() : '';
        if (supplierId === '' || typeof blocked !== 'boolean' || reason === '') {
          throw apiError(400, {
            code: 'not_readable_as_a_block_status',
            whatHappened: 'A supplier hold needs a supplierId in the path and { blocked: true|false, reason } in the body — a hold and its removal both need a reason for the audit trail.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "blocked": true, "reason": "…" } to hold, or { "blocked": false, "reason": "…" } to lift.',
          });
        }
        await deps.setSupplierBlocked(ctx.tenantId, supplierId, blocked, reason, ctx.userId, deps.now(),
          ctx.idempotencyKey ?? `${supplierId}-${blocked}`);
        return { status: 200, body: { supplierId, blocked } };
      },
    },
    {
      // Amend an issued PO's lines (M06-FR-04) — an approved change that keeps the prior lines on the
      // ledger (hard rule #2). Body: { amendmentId, lines[], reason }. The open commitment re-nets against
      // the amended quantities. Idempotent on the amendment id.
      api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId/amendments',
      permission: 'purchase.order.approve', idempotent: true,
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const amendmentId = isStr(b['amendmentId']) ? b['amendmentId'].trim() : '';
        const reason = isStr(b['reason']) ? b['reason'].trim() : '';
        const rawLines = b['lines'];
        if (amendmentId === '' || reason === '' || !Array.isArray(rawLines) || rawLines.length === 0 || !rawLines.every(isRawLine)) {
          throw apiError(400, {
            code: 'not_readable_as_an_amendment',
            whatHappened: 'A PO amendment needs { amendmentId, reason, lines[] (each with productId, a positive orderedQty, and unitCost { minor, currency }) }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the full amended line set with a reason. Nothing was changed.',
          });
        }
        // Round 13 (verifier A4): the order's guard is read BEFORE the order, so "does this raise it?" is judged on the order
        // exactly as it stands when the amendment lands — an amendment decided on an older copy is refused, never re-tried.
        const orderVersion = deps.orderVersion === undefined ? undefined : await deps.orderVersion(ctx.tenantId, poId);
        const po = await deps.order(ctx.tenantId, poId);
        if (po === undefined) throw notFound(`purchase order ${poId}`);
        if (po.status !== 'issued') throw poNotIssued(poId, 'amended');
        // M06-FR-02 (OB-288 P3): a call-off release keeps the agreement's prices and products; it is reduced by cancelling
        // part of it, and more is called off as a new release — never re-priced or enlarged past the agreement by amendment.
        if (po.blanketAgreementId !== undefined) {
          throw apiError(409, {
            code: 'release_amendment_not_allowed',
            whatHappened: `Purchase order ${poId} is a call-off release of blanket agreement ${po.blanketAgreementId}; its lines are the agreement's and are not amended.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Cancel the quantity no longer needed (POST …/cancellations), or raise another call-off for more. Nothing was changed.',
          });
        }
        const currency = (rawLines[0] as RawLine).unitCost.currency;
        if (currency !== po.currency || !(rawLines as RawLine[]).every((l) => l.unitCost.currency === po.currency)) {
          throw apiError(422, {
            code: 'amendment_currency_mismatch',
            whatHappened: `An amendment must stay in the PO's currency (${po.currency}).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Price the amended lines in the PO currency and send again.',
          });
        }
        // OB-31: each amended line in the product's own unit, as at ordering (an amended kg line is valued per kg, never per item).
        // (OB-290: a LOCAL order amended above its raiser's limit is refused below, once the amended value is known.)
        const lines: PurchaseOrderLineInput[] = [];
        for (const l of rawLines as RawLine[]) {
          const master = deps.productUom === undefined ? undefined : await deps.productUom(ctx.tenantId, l.productId);
          const uom = master === undefined ? undefined : normaliseUom(master) ?? master;
          lines.push({ productId: l.productId, orderedQty: l.orderedQty, ...(uom === undefined ? {} : { uom }), unitCost: money(l.unitCost.minor, po.currency) });
        }
        // OB-290: an amendment that takes the order above the AMENDER's own purchase-order limit (the owner's server-held
        // rule) is not theirs — it goes to the owner, whose authority is unlimited.
        const amendedMinor = lines.reduce((s, l) => s + valueAtCost(l.orderedQty, l.uom ?? 'ea', l.unitCost), 0);
        const amender = deps.authorityOf === undefined ? undefined : await deps.authorityOf(ctx.tenantId, ctx.userId, 'purchase_order');
        if (amender !== undefined && amendedMinor > po.totalMinor && !mayApproveValue(amender, amendedMinor)) {
          throw apiError(422, {
            code: 'above_your_limit_goes_to_owner',
            whatHappened: `Order ${poId} would be ${rupees(amendedMinor)} after this amendment; ${ctx.userId}'s purchase-order limit is ${authorityWords(amender)}. An order above a person's limit goes to the owner (OB-290).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The owner makes this amendment. Nothing was changed.',
          });
        }
        // OB-63 · WF-03: an amendment that RAISES the order's value (in any category) is judged against open-to-buy exactly as
        // an approval is — over budget it escalates to a person allowed to exceed it (the owner) with a reason, recorded — and
        // lands only while the month's open-to-buy guard (read BEFORE the orders are) still holds. A lowering amendment spends
        // no budget and is not judged.
        const period = await shopClock(deps.calendar).monthOf(ctx.tenantId, po.at); // R1b: the PO's month in the shop
        let judged: Awaited<ReturnType<typeof judgeApprovalOnBudget>> | undefined;
        let budgetGuard: { key: string; expectedVersion: number } | undefined;
        if (deps.openToBuy !== undefined) {
          const budgetVersion = deps.openToBuy.budgetVersion === undefined ? undefined : await deps.openToBuy.budgetVersion(ctx.tenantId, period);
          const amended: StoredPurchaseOrder = { ...po, lines, totalMinor: lines.reduce((s, l) => s + valueAtCost(l.orderedQty, l.uom ?? 'ea', l.unitCost), 0) };
          const [before, after] = await Promise.all([valueByCategory(deps.openToBuy, ctx.tenantId, po), valueByCategory(deps.openToBuy, ctx.tenantId, amended)]);
          if ([...after].some(([c, v]) => v > (before.get(c) ?? 0))) {
            judged = await judgeApprovalOnBudget(deps.openToBuy, { tenantId: ctx.tenantId, userId: ctx.userId, branchId: ctx.branchId ?? null }, amended, b['overBudgetReason'], { amendmentId });
            if (budgetVersion !== undefined && !judged.check.categories.every((c) => c.budgetMinor === null)) budgetGuard = { key: openToBuyGuardKey(period), expectedVersion: budgetVersion };
          }
        }
        try {
          await deps.amend(ctx.tenantId, poId, amendmentId, lines, reason, ctx.userId, deps.now(), budgetGuard, orderVersion);
        } catch (err) {
          if (err instanceof ConcurrencyConflictError && budgetGuard !== undefined && err.key === budgetGuard.key) throw concurrentChange(`${period}'s purchase budget (another order was issued or raised against it a moment ago)`);
          if (err instanceof ConcurrencyConflictError) throw concurrentChange(`purchase order ${poId} (it was amended, received against or cancelled a moment ago — this amendment was judged on the order as it stood before)`);
          throw err;
        }
        // Amended: only now is an over-budget override put on the record.
        await judged?.recordOverride?.();
        const updated = await deps.order(ctx.tenantId, poId);
        return { status: 200, body: { order: updated, openCommitment: updated ? openOf(updated) : null, ...(judged === undefined ? {} : { budgetAtAmendment: judged.check }) } };
      },
    },
    {
      // Cancel quantity against an issued PO (M06-FR-04) — an approved, audited reduction of the open
      // commitment. Body: { cancellationId, cancelledByProduct: { productId: qty }, reason }. Accumulates.
      api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId/cancellations',
      permission: 'purchase.order.approve', idempotent: true,
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const cancellationId = isStr(b['cancellationId']) ? b['cancellationId'].trim() : '';
        const reason = isStr(b['reason']) ? b['reason'].trim() : '';
        if (cancellationId === '' || reason === '' || !isQtyMap(b['cancelledByProduct'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_cancellation',
            whatHappened: 'A cancellation needs { cancellationId, reason, cancelledByProduct: { "<productId>": <whole qty ≥ 0> } }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the per-product cancelled quantities with a reason. Nothing was cancelled.',
          });
        }
        const po = await deps.order(ctx.tenantId, poId);
        if (po === undefined) throw notFound(`purchase order ${poId}`);
        if (po.status !== 'issued') throw poNotIssued(poId, 'cancelled');
        await deps.cancel(ctx.tenantId, poId, cancellationId, b['cancelledByProduct'], reason, ctx.userId, deps.now());
        const updated = await deps.order(ctx.tenantId, poId);
        return { status: 200, body: { order: updated, openCommitment: updated ? openOf(updated) : null } };
      },
    },
    {
      // Post received quantity against an issued PO (M06-FR-04) — reconciles the open commitment to what
      // actually arrived, in the PO's ordering units. Body: { receiptId, receivedByProduct }. Accumulates.
      // SP-6 (F01): a goods receipt now posts this ITSELF, atomically with the GRN (`receiptId` = the GRN id), so this
      // route is the MANUAL reconciliation for a receipt recorded outside the GRN path (an opening position, a
      // migration). A caller reconciling a GRN by hand must use the GRN id as `receiptId` so the two collapse to one.
      api: 'API-03', method: 'POST', path: '/v1/purchase/orders/:poId/receipts',
      permission: 'purchase.order.receive', idempotent: true,
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const receiptId = isStr(b['receiptId']) ? b['receiptId'].trim() : '';
        if (receiptId === '' || !isQtyMap(b['receivedByProduct'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_po_receipt',
            whatHappened: 'A PO receipt needs { receiptId, receivedByProduct: { "<productId>": <whole qty ≥ 0> } }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the per-product received quantities. Nothing was posted.',
          });
        }
        const po = await deps.order(ctx.tenantId, poId);
        if (po === undefined) throw notFound(`purchase order ${poId}`);
        if (po.status !== 'issued') throw poNotIssued(poId, 'received against');
        // OB-288 P3 (§28): this route RECONCILES a receipt recorded outside head office (an opening position carried over at
        // cutover, a migration) — it books no stock. Its poster counts as a receiver of the order (so they may never match or
        // pay it), and a person who already matched or paid the order may not post one. Raising the order and carrying what
        // the old system already received is the cutover operator's one job, so that pair alone is not refused here; real
        // receiving (the goods-receipt routes) refuses it.
        if (deps.segregation !== undefined) {
          const conflict = segregationConflict({ ...(await deps.segregation.actorsOf(ctx.tenantId, poId)), requisition: [] }, 'receipt', ctx.userId);
          if (conflict !== undefined) throw segregationRefusal(conflict);
        }
        await deps.postReceipt(ctx.tenantId, poId, receiptId, b['receivedByProduct'], ctx.userId, deps.now());
        const updated = await deps.order(ctx.tenantId, poId);
        return { status: 200, body: { order: updated, openCommitment: updated ? openOf(updated) : null } };
      },
    },
    {
      // Read one PO — its state and (once issued) its open commitment. 404 when unknown.
      api: 'API-03', method: 'GET', path: '/v1/purchase/orders/:poId',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const poId = (ctx.params['poId'] ?? '').trim();
        const po = await deps.order(ctx.tenantId, poId);
        if (po === undefined) throw notFound(`purchase order ${poId}`);
        return { status: 200, body: { order: presentOrder(po), openCommitment: openOf(po) } };
      },
    },
    {
      // Every PO — the ones still awaiting a second person's approval first (control by exception, P-03).
      api: 'API-03', method: 'GET', path: '/v1/purchase/orders',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const all = [...(await deps.all(ctx.tenantId))];
        const awaiting = all.filter((p) => p.status === 'proposed');
        const ordered = [...awaiting, ...all.filter((p) => p.status !== 'proposed')].map(presentOrder);
        return { status: 200, body: { orders: ordered, count: ordered.length, awaitingApprovalCount: awaiting.length, storeNotNamedCount: ordered.filter((o) => o.deliverTo === STORE_NOT_NAMED).length } };
      },
    },
    {
      // OB-37: the deliveries a store is waiting for — issued, not fully received — for the warehouse phone and the store pack
      // (Batch 1). `?storeId=` is required; a store outside the caller's branches is refused by name (PA-01-r1). Orders that
      // name no store are listed apart as `storeNotNamed`, never guessed into a store.
      api: 'API-03', method: 'GET', path: '/v1/purchase/deliveries/open',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const storeId = (ctx.query['storeId'] ?? '').trim();
        if (storeId === '') {
          throw apiError(400, { code: 'store_required', whatHappened: 'Say which store\'s open deliveries to read: ?storeId=.', wasItSaved: 'not_saved', nextSafeAction: 'Send the store id. Nothing was changed.' });
        }
        await assertLocationInScope(ctx, storeId, deps.locationBranches);
        const branchOf = await (deps.locationBranches ?? locationIsItsOwnBranch)(ctx.tenantId);
        const orders = await deps.all(ctx.tenantId);
        const listed = openDeliveriesFor(orders, storeId, branchOf);
        // OB-288 P3 (M07-FR-01): each delivery with the supplier's advance ship notice, when a buyer accepted one.
        const open = deps.asnOf === undefined ? listed : await Promise.all(listed.map(async (d) => {
          const asn = await deps.asnOf!(ctx.tenantId, d.poId);
          return asn === undefined ? d : { ...d, asn };
        }));
        const scope = await stockReadScope(ctx, deps.locationBranches);
        const storeNotNamed = orders
          .filter((p) => p.status === 'issued' && p.deliverToLocationId === undefined && scope.everything)
          .map((p) => ({ poId: p.poId, number: p.number, supplierId: p.supplierId, deliverTo: STORE_NOT_NAMED }));
        return { status: 200, body: { storeId, deliveries: open, count: open.length, storeNotNamed, asAt: deps.now() } };
      },
    },
  ];
}
