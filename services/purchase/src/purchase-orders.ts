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
import { apiError, notFound } from '../../kernel/src/index';
import {
  issuePurchaseOrder, computeOpenCommitment, BlockedSupplierError,
  type PurchaseOrderLineInput, type OpenCommitment,
} from '../../../packages/purchasing/src/index';
import { requestApproval, decide, type Approver } from '../../../packages/approvals/src/index';
import { money, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import { unitCostFromPackCost, UnknownPackLevelError, type PackHierarchy } from '../../../packages/product/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { assertLocationInScope, stockReadScope, locationIsItsOwnBranch, type LocationBranches } from '../../inventory/src/location-scope';
import { normaliseUom, valueAtUnitCost, minorPerUnitOf } from '../../../packages/contracts/src/quantity';

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
}

export interface PurchaseOrderDeps {
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
  readonly issue: (tenantId: string, poId: string, approvedBy: string, issuedAt: string, reason: string, key: string) => Promise<void> | void;
  /** Set a supplier's block state. Append-only; latest wins. */
  readonly setSupplierBlocked: (tenantId: string, supplierId: string, blocked: boolean, reason: string, by: string, at: string, key: string) => Promise<void> | void;
  /** Amend an issued PO's lines (approved). Append-only — the prior lines stay on the ledger (hard rule #2). */
  readonly amend: (tenantId: string, poId: string, amendmentId: string, lines: readonly PurchaseOrderLineInput[], reason: string, by: string, at: string) => Promise<void> | void;
  /** Record an approved cancellation of quantity per product against a PO. Accumulates. */
  readonly cancel: (tenantId: string, poId: string, cancellationId: string, cancelledByProduct: Readonly<Record<string, number>>, reason: string, by: string, at: string) => Promise<void> | void;
  /** Post received quantity per product against a PO (in the PO's ordering units). Accumulates. */
  readonly postReceipt: (tenantId: string, poId: string, receiptId: string, receivedByProduct: Readonly<Record<string, number>>, by: string, at: string) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isMinor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

interface RawLine {
  readonly productId: string; readonly orderedQty: number; readonly unitCost: { readonly minor: number; readonly currency: string };
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
 * exactly — a pack cost that does not divide into whole paise is REFUSED by name rather than rounded into a price nobody
 * agreed. A line without `pack` passes through untouched.
 */
async function expandPackedLines(deps: PurchaseOrderDeps, tenantId: string, raw: unknown): Promise<unknown> {
  if (!Array.isArray(raw)) return raw;
  const out: unknown[] = [];
  for (const v of raw) {
    if (!isObj(v) || v['pack'] === undefined) { out.push(v); continue; }
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
    const per = normaliseUom(hierarchy.baseUom) ?? hierarchy.baseUom;
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
    if (!converted.exact) {
      throw apiError(422, {
        code: 'pack_cost_not_whole_paise',
        whatHappened: `One ${pack['level']} of ${productId} holds ${converted.unitsPerPack} ${per}; ${packCost['minor'] as number} paise for it is ${((packCost['minor'] as number) / converted.unitsPerPack).toFixed(4)} paise per ${per} — not a whole number of paise. The cost per ${per} is what stock is valued at, so it is never rounded silently.`,
        wasItSaved: 'not_saved',
        nextSafeAction: `Ask the supplier for the cost per ${per} in whole paise and order in the base unit, or agree a pack cost that divides exactly. Nothing was saved.`,
      });
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
async function requireApprovedSupplier(deps: PurchaseOrderDeps, tenantId: string, supplierId: string): Promise<void> {
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
async function requireDeliverTo(deps: PurchaseOrderDeps, ctx: Parameters<Route['handler']>[0], value: unknown): Promise<string> {
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
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = await expandPackedLines(deps, ctx.tenantId, b['lines']); // SF-11: a line ordered by the case, in base units
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
        // FUL-11 (M04-FR-01): the effective range is enforced at ordering — a store that has a range does not order what
        // it does not carry (delisted), what it is selling down (clearance) or what it never ranged. A store with no range
        // recorded yet is not judged (there is nothing to enforce) — the range screen is where that starts.
        if (deps.rangeStatus !== undefined) {
          const branches = deps.locationBranches === undefined ? undefined : await deps.locationBranches(ctx.tenantId);
          const storeId = branches?.(deliverToLocationId) ?? deliverToLocationId;
          const today = deps.now().slice(0, 10);
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
        // OB-31: each line in the product's own unit (orderedQty in its smallest steps — grams for kg), priced per whole unit.
        const poLines: PurchaseOrderLineInput[] = [];
        for (const l of lines as RawLine[]) {
          const master = deps.productUom === undefined ? undefined : await deps.productUom(ctx.tenantId, l.productId);
          const uom = master === undefined ? undefined : normaliseUom(master) ?? master;
          poLines.push({
            productId: l.productId, orderedQty: l.orderedQty, unitCost: money(l.unitCost.minor, currency), ...(uom === undefined ? {} : { uom }),
            // SF-11: the order as the buyer placed it, by the pack — kept beside the base-unit figures it was converted to.
            ...(l.ordered === undefined ? {} : { ordered: { ...l.ordered, packCost: money(l.ordered.packCost.minor, currency) } }),
          });
        }
        const totalMinor = poLines.reduce((s, l) => s + valueAtUnitCost(l.orderedQty, l.uom ?? 'ea', l.unitCost.minor), 0);
        const po: StoredPurchaseOrder = {
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
        };
        await deps.propose(ctx.tenantId, po, ctx.idempotencyKey ?? poId);
        // Seal the purchase commitment — who ordered what, from whom, for how much — attributed to the
        // acting buyer. Aggregates only; no card/tender data exists on a PO (hard rule #3).
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'purchase.order.place', objectType: 'purchase-order', objectId: poId,
          at: po.at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            supplierId: po.supplierId, totalMinor: String(po.totalMinor), currency: po.currency,
            lineCount: String(po.lines.length), status: po.status, deliverTo: deliverToLocationId,
          },
          correlationId: poId,
        });
        return { status: 201, body: { order: po, openCommitment: null } };
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
        const issuedAt = deps.now();
        await deps.issue(ctx.tenantId, poId, ctx.userId, issuedAt, reason, ctx.idempotencyKey ?? poId);
        const issued: StoredPurchaseOrder = { ...po, status: 'issued', approvedBy: ctx.userId, issuedAt };
        return { status: 200, body: { order: issued, openCommitment: openOf(issued) } };
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
        const po = await deps.order(ctx.tenantId, poId);
        if (po === undefined) throw notFound(`purchase order ${poId}`);
        if (po.status !== 'issued') throw poNotIssued(poId, 'amended');
        const currency = (rawLines[0] as RawLine).unitCost.currency;
        if (currency !== po.currency || !(rawLines as RawLine[]).every((l) => l.unitCost.currency === po.currency)) {
          throw apiError(422, {
            code: 'amendment_currency_mismatch',
            whatHappened: `An amendment must stay in the PO's currency (${po.currency}).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Price the amended lines in the PO currency and send again.',
          });
        }
        const lines: PurchaseOrderLineInput[] = (rawLines as RawLine[]).map((l) => ({
          productId: l.productId, orderedQty: l.orderedQty, unitCost: money(l.unitCost.minor, po.currency),
        }));
        await deps.amend(ctx.tenantId, poId, amendmentId, lines, reason, ctx.userId, deps.now());
        const updated = await deps.order(ctx.tenantId, poId);
        return { status: 200, body: { order: updated, openCommitment: updated ? openOf(updated) : null } };
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
        const open = openDeliveriesFor(orders, storeId, branchOf);
        const scope = await stockReadScope(ctx, deps.locationBranches);
        const storeNotNamed = orders
          .filter((p) => p.status === 'issued' && p.deliverToLocationId === undefined && scope.everything)
          .map((p) => ({ poId: p.poId, number: p.number, supplierId: p.supplierId, deliverTo: STORE_NOT_NAMED }));
        return { status: 200, body: { storeId, deliveries: open, count: open.length, storeNotNamed, asAt: deps.now() } };
      },
    },
  ];
}
