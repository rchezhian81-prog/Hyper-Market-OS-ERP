// OB-288 · till-side completion — head office's wiring for the catalogue rules carried onto the till, and the till's
// delivery sale. One import line in `main.ts`; every function here is a hook spread into an existing route's deps there.
//
//   • OB-348 (B17) · OB-354 — each STORE's state, read from the store's own GSTIN (its first two digits, the GST state
//     code), rides that store's pack to its store computer and tills, and head office's sale intake judges liquor by the
//     state of the store the sale was rung at (`shopStateOf`, `tillSidePoliciesOf`). Never one business-wide setting.
//   • OB-299 (M12-FR-02) — a bill the till marked for delivery, paid in full there, becomes ONE delivery job when the sale
//     reaches head office through the store computer: an order on the orders register (state `confirmed`, delivery, the
//     goods lines), its payment recorded as made at the till so the door collects nothing, booked once on any resend
//     (`tillDeliveryOnSale`). The delivery-fee product is named in store setup and rides the store pack.
//   • OB-295 (M17-FR-01) — each member's tier and multiplier go into the till's wallet feed, off until the owner sets tiers
//     (`withWalletTiers`).
//   • OB-346 — an online order earns points once it is delivered, at the till rate (the same rule and tier), for the member
//     the app account is tied to (`earnOnDelivery`). Spending points online stays off: the storefront only shows the balance.
//
// Nothing here commits a price, a payment or stock on its own (P-05): the delivery job follows a sale the till already
// committed, and the earn follows a delivery a driver already recorded.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { SETTINGS, type TenantSetting } from '../../../packages/tenant/src/settings';
import { shopStateFromGstin } from '../../../packages/restricted-sales/src/liquor';
import type { IncomingSale } from '../../pos/src/sale-intake';
import type { PlacedOrder } from '../../orders/src/index';
import type { LoyaltyWalletDeps } from '../../customer/src/loyalty-wallets';
import { earnOnSale, type LoyaltyEffectsDeps, type LoyaltyOutcome } from '../../customer/src/loyalty-effects';
import { tierMultiplierAt } from '../../customer/src/loyalty-programme';
import type { FulfilmentApplied } from '../../fulfilment/src/order-fulfilment';
import { TILL_BILL_PAYMENT_PREFIX } from '../../fulfilment/src/order-fulfilment';
import { ordersAdapter, orgStructureAdapter, saleStockLocationOf, storeOfPack } from './adapters';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { appMemberOf, loyaltyProgrammeAdapter } from './customer-commerce-adapters';
import { recordTillDeliveryJob } from './till-delivery-adapters';

interface Base { readonly store: EventStore; readonly now: () => string }
type Settings = { value<T>(tenantId: string, setting: TenantSetting<T>): Promise<T> };

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

// ── OB-348 · OB-299: what store setup sends the store computer ──────────────────────────────────────────────────────

/**
 * OB-354: a store's state, read from the GSTIN on its own record in the organisation (the branch the place belongs to) —
 * an ISO state code, or undefined ("not set": no GSTIN on record, or none whose first two digits are a state's code).
 */
export function storeStateOf(input: Pick<Base, 'store' | 'now'>) {
  return async (tenantId: string, placeId: string): Promise<string | undefined> => {
    const nodes = await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId);
    const branchId = branchOfLocationIn(nodes)(placeId);
    const read = shopStateFromGstin(nodes.find((n) => n.nodeId === branchId)?.gstin);
    return read.known ? read.state : undefined;
  };
}

/** OB-348 · OB-354: the state of the store a sale was rung at — where its stock leaves from (the one rule) — for the intake. */
export function shopStateOf(input: Pick<Base, 'store' | 'now'>) {
  const stateOf = storeStateOf(input);
  return async (tenantId: string, sale: IncomingSale): Promise<string | undefined> => {
    const where = await saleStockLocationOf(input.store, tenantId, sale);
    return where.basis === 'unplaced' ? undefined : stateOf(tenantId, where.locationId);
  };
}

/** OB-348 · OB-354 · OB-299: the till's policies for ONE store's pack — its state (from its GSTIN) and the fee product, each only when set. */
export function tillSidePoliciesOf(settings: Settings, input: Pick<Base, 'store' | 'now'>) {
  const state = storeStateOf(input);
  return async (tenantId: string, storeId: string): Promise<{ readonly shopState?: string; readonly tillDeliveryFeeProductId?: string }> => {
    const shopState = await state(tenantId, storeId);
    const fee = text(await settings.value(tenantId, SETTINGS.TILL_DELIVERY_FEE_PRODUCT));
    return { ...(shopState === undefined ? {} : { shopState }), ...(fee === undefined ? {} : { tillDeliveryFeeProductId: fee }) };
  };
}

// ── OB-299: the till's delivery sale becomes one delivery job ───────────────────────────────────────────────────────

/** What booking a till delivery bill did — said on the sale's reply. */
export interface TillDeliveryOutcome {
  readonly outcome: 'booked' | 'already_booked' | 'no_goods';
  readonly orderId: string;
  readonly detail: string;
}

/** The order a till delivery bill is booked as — one per sale, whatever the resend. */
export const tillDeliveryOrderId = (saleId: string): string => `till-${saleId}`;

/**
 * OB-299: book a bill the till marked for delivery as ONE delivery order. The goods lines (the fee line is a charge, not
 * goods) go on the order; the bill's money is recorded as paid at the till, so the door collects nothing and the hand-over
 * posts no second sale (the till's own sale already carries the stock and the money). Idempotent on the sale id. Answers
 * undefined for a bill not marked for delivery.
 */
export function tillDeliveryOnSale(input: Base) {
  const orders = ordersAdapter({ store: input.store, now: input.now, holdMinutes: 0 });
  const recordJob = recordTillDeliveryJob(input.store);
  return async (tenantId: string, sale: IncomingSale): Promise<TillDeliveryOutcome | undefined> => {
    if (sale.delivery?.requested !== true) return undefined;
    const orderId = tillDeliveryOrderId(sale.saleId);
    const placed = await orders.placedOrder(tenantId, orderId);
    if (placed !== undefined) {
      // OB-352: the job register entry, once (a resend after a crash between the two completes it).
      await recordJob(tenantId, { orderId, saleId: sale.saleId, receiptNumber: sale.receiptNumber, locationId: placed.locationId, ...(text(sale.customerRef) === undefined ? {} : { memberRef: text(sale.customerRef)! }), bookedAt: placed.placedAt });
      return { outcome: 'already_booked', orderId, detail: `Bill ${sale.receiptNumber} is already delivery job ${orderId}; nothing was booked twice.` };
    }
    const feeProductId = text(sale.delivery.feeProductId);
    const goods = new Map<string, number>();
    for (const l of sale.lines) {
      if (l.productId === feeProductId || !Number.isSafeInteger(l.quantityMinor) || l.quantityMinor <= 0) continue;
      goods.set(l.productId, (goods.get(l.productId) ?? 0) + l.quantityMinor);
    }
    if (goods.size === 0) {
      return { outcome: 'no_goods', orderId, detail: `Bill ${sale.receiptNumber} was marked for delivery but carries no goods — no delivery job was booked. Ask the store which items were to go.` };
    }
    const locationId = text(sale.locationId) ?? (await storeOfPack(input.store, tenantId, sale.packVersion)) ?? `unplaced-lane:${sale.laneId}`;
    const order: PlacedOrder = {
      orderId, locationId, state: 'confirmed', placedAt: sale.committedAt, fulfilment: 'delivery',
      lines: [...goods.entries()].map(([productId, quantityMinor]) => ({ productId, quantityMinor })),
    };
    // The payment first, then the order: a crash between leaves a payment with no order, which the resend completes — never
    // an order the door would collect for.
    await orders.recordPayment(tenantId, {
      orderId, providerRef: `${TILL_BILL_PAYMENT_PREFIX}${sale.receiptNumber !== '' ? sale.receiptNumber : sale.saleId}`,
      amountMinor: sale.totalMinor, result: 'authorised', recordedBy: sale.cashierId !== '' ? sale.cashierId : 'store-computer', recordedAt: sale.committedAt,
    });
    await orders.recordPlaced(tenantId, order);
    // OB-352: the job waits for its address and slot — the customer's app when the bill's member has the app, else the
    // delivery desk from the till's delivery slip. The member code the bill named is kept with it (never a phone number).
    await recordJob(tenantId, { orderId, saleId: sale.saleId, receiptNumber: sale.receiptNumber, locationId, ...(text(sale.customerRef) === undefined ? {} : { memberRef: text(sale.customerRef)! }), bookedAt: sale.committedAt });
    return {
      outcome: 'booked', orderId,
      detail: `Bill ${sale.receiptNumber} (₹${(sale.totalMinor / 100).toFixed(2)}, paid in full at the till) is delivery job ${orderId} with ${goods.size} item line(s). The door collects nothing.`,
    };
  };
}

// ── OB-295: the tier multiplier in the till's wallet feed ────────────────────────────────────────────────────────────

/** OB-295: each member's tier and multiplier in the wallet feed the store computers pull — off until the owner sets tiers. */
export function withWalletTiers<D extends LoyaltyWalletDeps>(wallets: D, input: Base): D {
  const programme = loyaltyProgrammeAdapter(input);
  return {
    ...wallets,
    tierAt: async (t: string, memberRef: string, at: string) => {
      const tier = await tierMultiplierAt(programme, t, memberRef, at);
      return tier === undefined ? undefined : { tierName: tier.tierName, multiplierBps: tier.multiplierBps };
    },
  };
}

// ── OB-346: an online order earns once delivered, at the till rate ───────────────────────────────────────────────────

/**
 * OB-346 (owner, 24 Oct 2026, in writing): when an online order's hand-over posts its sale, the member the app account is
 * tied to earns on it — the till's rule and tier, once per sale (the earn is keyed on the sale). A bill paid at the till
 * (OB-299) earned at the till already and is left alone. Never throws into the fulfilment command: the outcome is returned.
 */
export function earnOnDelivery(effects: LoyaltyEffectsDeps | undefined, input: Base) {
  const orders = ordersAdapter({ store: input.store, now: input.now, holdMinutes: 0 });
  const memberOf = appMemberOf(input);
  return async (tenantId: string, applied: FulfilmentApplied | undefined): Promise<LoyaltyOutcome | undefined> => {
    const s = applied?.settlement;
    if (effects === undefined || s === undefined || s.saleId === undefined || s.keptMinor <= 0) return undefined;
    if (s.outcome !== 'delivered' && s.outcome !== 'partially_delivered' && s.outcome !== 'collected') return undefined;
    const payment = await orders.orderPayment(tenantId, s.orderId);
    if (payment?.providerRef.startsWith(TILL_BILL_PAYMENT_PREFIX) === true) return undefined;
    const placed = await orders.placedOrder(tenantId, s.orderId);
    const customerRef = text(placed?.customerRef);
    if (customerRef === undefined) return { outcome: 'no_customer', detail: `Order ${s.orderId} names no app customer — no points.` };
    const member = await memberOf(tenantId, customerRef);
    if (member === undefined) return { outcome: 'no_customer', detail: `The app account on order ${s.orderId} is not tied to a loyalty membership — no points.` };
    return earnOnSale(effects, tenantId, { saleId: s.saleId, totalMinor: s.keptMinor, committedAt: s.at, customerRef: member.memberRef, tenders: s.tenders });
  };
}
