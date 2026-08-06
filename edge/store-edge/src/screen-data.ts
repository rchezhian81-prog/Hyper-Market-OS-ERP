// What the store box serves to each of the six screens — §31, P-08, P-02.
//
// Every screen in this product was built to be told the truth, including the truth that the box
// does not know something. This is where that promise is kept: each payload is assembled from what
// the box actually has, and a section it has not got is **absent**, which every screen already
// renders as *not known* with the reason.
//
// ── The one rule, restated because it is the only one that matters here ─────
//
// **Never substitute an empty answer for a missing one.** It is one character of code — `?? []` —
// and it converts "the cloud has never told this box about approvals" into "no approvals are
// waiting". The manager's day close is built to refuse the first and proceed on the second, so
// that one character is the difference between a trading day that locks correctly and one that
// locks on nothing at all.
//
// The screens hold that line. This file has to hold it too, on the other side of the socket, and
// a guardrail checks that no payload builder here contains that idiom.
//
// ── What each screen gets, and from where ───────────────────────────────────
//
//   • the till       — the catalogue pack, so it can scan and price with no line at all
//   • the manager    — exceptions and unsent items projected HERE (the two gates on a day close),
//                      plus approvals, tasks and product costs from the cloud pack
//   • the owner      — the day's figures from this box's own log, with margin only where it can
//                      genuinely be worked out
//   • the picker     — the wave the cloud assigned
//   • the driver     — the route the cloud assigned
//   • the customer   — the published catalogue and the slots that can actually be had
//   • the buyer      — what is on order, what arrived, which invoices are already captured, and
//                      who is allowed to check the buyer's work
//   • the catalogue  — the master records, the tenant's own department rules, what things cost and
//                      every price ever set
//   • merchandising  — the shelf plan, every count ever taken, the stockroom, the range and what
//                      each part of the floor earns
//   • reporting      — the day's sales facts, the outbox, the exception register, and WHICH FACTS
//                      this shop does not record, so a report it cannot run refuses by name

import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { assessChecklist } from '../../../packages/workforce/src/index';
import type { LpRule } from '../../../packages/loss-prevention/src/index';
import { planDispatch, type DispatchPlan } from '../../../packages/fulfilment/src/routing';
import { ShelfMap, type ShelfLocation } from '../../../packages/merchandising/src/index';
import {
  basketUnits, costTheDay, exceptionsFor, activityFrom, lineCostMinor, salesOn, tradingDaysHeld,
  type LoggedSale,
} from './read-model';
import type { StorePack } from './store-pack';

/** The screens this box serves. Named so a route, a test and a payload cannot drift apart. */
export const SCREENS = Object.freeze([
  'pos', 'manager', 'owner', 'picker', 'driver', 'customer', 'buying', 'catalogue', 'merchandising',
  'reporting',
] as const);
export type ScreenName = (typeof SCREENS)[number];

export interface ScreenInput {
  readonly pack: StorePack;
  readonly sales: readonly LoggedSale[];
  /** Records on the disk that could not be read at all. Surfaced, never silently dropped. */
  readonly unreadableRecords: number;
  /** The store's real outbox — the only honest source for "has everything reached the cloud?". */
  readonly outbox: SyncOutbox;
  readonly now: string;
  readonly tradingDay: string;
}

/**
 * The till's payload: the catalogue, and nothing else.
 *
 * A lane needs to scan a barcode and price it with no line to anywhere, so this is the one screen
 * whose payload is pure pack. Absent, the shell already says the lane has no price list and cannot
 * scan — which is correct, and is not something to paper over with an empty catalogue that would
 * make every scan an unknown-barcode error instead.
 */
export function posPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.products.known) return null;
  return {
    version: input.pack.version,
    products: input.pack.products.value.map((p) => ({
      productId: p.productId,
      name: p.name,
      ...(p.nameTa === undefined ? {} : { nameTa: p.nameTa }),
      barcodes: p.barcodes,
      unitPriceMinor: p.unitPriceMinor,
      uom: p.uom,
      ...(p.ageRestricted === undefined ? {} : { ageRestricted: p.ageRestricted }),
    })),
  };
}

/**
 * The manager's payload.
 *
 * Two of its four registers are the gates on a day close, and **both are produced here rather than
 * fetched**, which is the point of the whole file:
 *
 *   • `unsentItems` is this box's own outbox. Nothing else in the system knows what has not reached
 *     the cloud — by definition, the cloud does not.
 *   • `openExceptions` is the day evaluated against the store's own thresholds. Waiting for the
 *     cloud to notice a void spike would blank the register exactly when the line is down, which is
 *     when a shop is least supervised.
 *
 * The other two come from the pack, and stay absent when the pack has not carried them.
 */
export function managerPayload(input: ScreenInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  // Every pending item, whatever it is. The manager's screen lists them, so a sale and a stock
  // adjustment both belong here — "3 things have not reached the cloud" is the honest count.
  payload['unsentItems'] = input.outbox.pending().map((item) => ({
    id: item.key,
    what: item.event.type,
  }));

  const rules = input.pack.lossPreventionRules.known
    ? (input.pack.lossPreventionRules.value as readonly LpRule[])
    : undefined;
  // TODAY's activity, not the whole log. A "no more than two refunds" limit counted against every
  // refund since the box was installed breaches on day three and never stops breaching, and the
  // day close gates on this register — so the shop would eventually be unable to close a clean day.
  const today = salesOn(input.sales, input.tradingDay);
  const day = exceptionsFor(activityFrom(today.sales), rules);
  if (day.rulesKnown) {
    const items = day.exceptions.map((e) => ({
      id: `${e.cashierId}:${e.kind}:${e.breach}`,
      what: `${e.kind.replace(/_/g, ' ')} by ${e.cashierId}: ${e.observed} against a limit of ${e.limit}`,
    }));
    // A record nobody can read is an exception in its own right. It is evidence that something
    // went wrong on this disk, and it must not be quietly excluded from the day's figures and then
    // also excluded from the list of things wrong with the day (hard rule #6).
    if (input.unreadableRecords > 0) {
      items.push({
        id: 'edge:unreadable-records',
        what: `${input.unreadableRecords} record(s) on this box could not be read — most likely a power cut mid-write`,
      });
    }
    // Same reasoning, different cause: a sale that names no trading day cannot be put in one, so it
    // is out of every day's figures. Silently out of the total somebody reconciles against the till
    // roll is exactly the kind of gap that gets blamed on a cashier.
    if (today.undated > 0) {
      items.push({
        id: 'edge:undated-sales',
        what: `${today.undated} sale(s) on this box name no trading day, so they are in nobody's figures — they need looking at`,
      });
    }

    // An order that could not be put on a route is a customer who ordered, paid and is waiting.
    // It belongs on the manager's exception register — and therefore holds the day close, which is
    // correct: a day should not lock with somebody's shopping still in the building and nobody
    // having told them (M19-FR-03).
    const plan = dispatchPlanFor(input);
    if (plan !== null) {
      for (const unplanned of plan.unplanned) {
        items.push({ id: `dispatch:${unplanned.orderId}`, what: unplanned.detail });
      }
      // Flagged for a look, not raised as an exception: an expensive stop is a question about
      // whether to keep taking that order, not something wrong with today (D09).
      for (const flag of plan.contributionFlags) {
        items.push({ id: `contribution:${flag.orderId}`, what: flag.detail });
      }
    }
    payload['openExceptions'] = items;
  }
  // else: the section is ABSENT. No rules means nobody is watching, and a manager must not be able
  // to close a day on a register that was never checked.

  if (input.pack.approvals.known) {
    // **Shaped for the manager's engine, not passed through.**
    //
    // The pack carries `valueMinor`, because a number over a wire is a number. The approval engine
    // takes `Money` — an amount with its currency — and a screen handed the wrong shape reads
    // `value.currency` off `undefined` and the whole inbox throws. The lane socket had exactly
    // this fault once (`saleId` against `id`) and refused every real sale with "could not read".
    //
    // Converting here rather than at six call sites means one place can be wrong instead of six.
    payload['approvals'] = input.pack.approvals.value.map((a) => ({
      id: a.id,
      subjectType: a.subjectType,
      subjectRef: a.subjectRef,
      requestedBy: a.requestedBy,
      branchId: a.branchId,
      value: a.valueMinor === null ? null : { minor: a.valueMinor, currency: 'INR' },
      status: 'pending',
    }));
  }

  if (input.pack.checklist.known) {
    const result = assessChecklist({
      checklistId: `${input.tradingDay}-closing`,
      kind: 'closing',
      items: input.pack.checklist.value.map((i) => ({
        itemId: i.itemId,
        description: i.description,
        done: i.done,
        blocking: i.blocking,
        ...(i.doneBy === undefined ? {} : { doneBy: i.doneBy }),
      })),
      signedBy: 'not signed yet',
    });
    payload['tasks'] = result.outstanding.map((i) => ({
      id: i.itemId,
      what: i.blocking ? `${i.description} (the shop cannot close without this)` : i.description,
    }));
  }

  if (input.pack.products.known) {
    payload['products'] = input.pack.products.value
      .filter((p) => p.unitCostMinor !== undefined)
      .map((p) => ({ id: p.productId, valuePerUnitMinor: p.unitCostMinor! }));
  }

  return payload;
}

/**
 * The owner's payload.
 *
 * **Margin is only served where it can genuinely be worked out.** A sale containing a product the
 * pack has no cost price for is left out of the figures and counted; the count is then raised as an
 * exception on the owner's own screen, naming the products, because the person who can fix a
 * missing cost price is exactly the person reading it.
 */
export function ownerPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.policies.known) return null;
  const policies = input.pack.policies.value;
  const products = input.pack.products.known ? input.pack.products.value : [];
  // TODAY. The log holds every day the box has ever traded, so this brief reported the whole
  // week's takings as the day's — on a phone, as one number, with nothing to say it was wrong.
  const today = salesOn(input.sales, input.tradingDay);
  const day = costTheDay(today.sales, products);

  const exceptions: { cashierId: string; kind: string; breach: string; observed: number; limit: number; severity: string; linkedTxnIds: string[] }[] = [];
  const rules = input.pack.lossPreventionRules.known
    ? (input.pack.lossPreventionRules.value as readonly LpRule[])
    : undefined;
  for (const e of exceptionsFor(activityFrom(today.sales), rules).exceptions) {
    exceptions.push({ ...e, linkedTxnIds: [...e.linkedTxnIds] });
  }

  return {
    ownerId: 'owner',
    staleAfterSeconds: policies.staleAfterSeconds,
    privacySlaDays: policies.privacySlaDays,
    branches: [{
      branchId: policies.branchId ?? policies.storeId,
      name: policies.branchName,
      // The box's own clock, because the box is where the sales are. If the cloud were asked when
      // this branch last synced, a box with no line would report nothing and the owner would see
      // "never synced" about the shop that has been trading all day in front of him.
      lastSyncedAt: input.now,
      sales: day.facts,
      exceptions,
      // Out of every day's figures, so it is named where the owner will see it rather than
      // becoming an unexplained difference against the till roll.
      ...(today.undated === 0 ? {} : { undatedSales: today.undated }),
      approvals: input.pack.approvals.known
        ? input.pack.approvals.value.map((a) => ({
          id: a.id,
          subjectType: a.subjectType,
          subjectRef: a.subjectRef,
          requestedBy: a.requestedBy,
          valueMinor: a.valueMinor,
        }))
        : [],
    }],
    // Reported alongside, not folded in. The owner is told the takings are complete and the margin
    // is over a subset, rather than being shown one number that is quietly both.
    uncostable: {
      sales: day.uncostableSales,
      takenMinor: day.takenMinor,
      billCount: day.billCount,
      products: day.productsWithoutCost,
    },
  };
}

/**
 * This store's shelf map, or `null` when it has none (M04-FR-02).
 *
 * Built here rather than in the cloud for the same reason the routes are: a picker walks the shop
 * whether or not the internet is up, and a shop whose pick lists could only be sequenced online
 * would go back to walking dairy-then-rice-then-dairy on the afternoon the router dies.
 */
export function shelfMapFor(input: ScreenInput): ShelfMap | null {
  if (!input.pack.shelfLocations.known || !input.pack.shelfAssignments.known) return null;
  const storeId = input.pack.policies.known ? input.pack.policies.value.storeId : 'store-1';
  const zoneOrder = input.pack.shelfPolicy.known ? input.pack.shelfPolicy.value.zoneOrder : undefined;
  const map = new ShelfMap(storeId, input.pack.shelfLocations.value, [], zoneOrder);
  // Assignments one at a time: a pack carrying two primaries for one product is a contradiction
  // about where an item lives, and the map refuses it. Refusing the WHOLE map over one bad row
  // would take the picker's route down for every other product in the shop, so the bad row is
  // dropped and the rest still sequences — the product simply reads as unmapped, which is exactly
  // what it is until somebody says where it lives.
  for (const assignment of input.pack.shelfAssignments.value) {
    if (assignment.storeId !== storeId) continue;
    try {
      map.assign(assignment);
    } catch {
      continue;
    }
  }
  return map;
}

/**
 * The picker's payload: the wave the cloud assigned, or nothing when none was.
 *
 * **The wave is put into shelf order here.** `ShelfMap.routeFor` has existed and been tested since
 * the module was written, and nothing had ever called it — so every wave was walked in whatever
 * order the cloud happened to send, which on an online grocery order is the order the customer
 * typed: dairy, rice, back to dairy. The roadmap's audit calls picking time the largest
 * controllable cost in this business, and it is decided here.
 *
 * The screen is told **which ordering it is holding**, the same way the driver is told whether a
 * dispatcher wrote their route by hand — a picker who thinks a list is sequenced when it is not
 * walks it trusting an order that was never applied.
 */
export function pickerPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.wave.known || input.pack.wave.value === null) return null;
  const wave = input.pack.wave.value;

  const lines = wave.lines.map((l) => ({
    lineId: l.lineId,
    orderRef: l.orderRef,
    productId: l.productId,
    description: l.description,
    bin: l.bin,
    requiredQty: l.requiredQty,
    uom: l.uom,
    unitPrice: { minor: l.unitPriceMinor, currency: 'INR' },
  }));

  const map = shelfMapFor(input);
  if (map === null) {
    return {
      waveId: wave.waveId,
      pickerId: wave.pickerId,
      lines,
      orderedBy: 'the order the list arrived in — this store has no shelf map',
      unmapped: [],
    };
  }

  const walk = map.routeFor(lines);
  return {
    waveId: wave.waveId,
    pickerId: wave.pickerId,
    // The shelf address travels with the line, so the handheld can show where to go rather than
    // only which bin to scan. An unmapped line keeps its place at the end of the list and says so.
    lines: walk.lines.map((l) => {
      const { location, unmapped, ...line } = l as typeof l & { location?: ShelfLocation };
      return {
        ...line,
        ...(location === undefined ? {} : { shelf: shelfAddress(location) }),
        unmapped,
      };
    }),
    orderedBy: walk.ordering,
    unmapped: walk.unmapped,
  };
}

/** The address a picker reads on the aisle sign, or the numbers when there is no sign. */
function shelfAddress(location: ShelfLocation): string {
  const base = location.label ?? `${location.aisle}-${location.rack}-${location.bay}-${location.shelf}`;
  return location.zone === undefined || location.zone === 'ambient' ? base : `${base} (${location.zone})`;
}

/**
 * Plan today's deliveries on this box (M19-FR-03).
 *
 * **Dispatch runs here rather than in the cloud, and that is the whole reason it is in this file.**
 * Vans go out whether or not the line is up. A shop whose routes could only be planned when the
 * internet was working would be a shop that stops delivering on the afternoon the router dies —
 * which is precisely the day it can least afford to (P-01).
 *
 * Returns `null` when the box has not been told the orders, the fleet or the rules to plan by. Not
 * an empty plan: an empty plan says *nobody has any deliveries today*, and that is a different
 * sentence from *I have not been told what today's deliveries are*.
 */
export function dispatchPlanFor(input: ScreenInput): DispatchPlan | null {
  if (!input.pack.deliveries.known || !input.pack.drivers.known || !input.pack.routingPolicy.known) {
    return null;
  }
  const policy = input.pack.routingPolicy.value;
  return planDispatch({
    runDate: input.tradingDay,
    orders: input.pack.deliveries.value,
    // A van off the road simply is not in the fleet for the day. The planner then re-plans around
    // it rather than having somebody's stops appended to another driver's run in whatever order
    // they happened to be in (M19-FR-03, "partner unavailable → reassign").
    drivers: input.pack.drivers.value.filter((d) => d.unavailable !== true),
    policy: {
      storeLocation: policy.storeLocation,
      radiusMetres: policy.radiusMetres,
      averageSpeedKmh: policy.averageSpeedKmh,
      serviceMinutesPerStop: policy.serviceMinutesPerStop,
      ...(policy.contributionRule === undefined ? {} : { contributionRule: policy.contributionRule }),
    },
  });
}

/**
 * The driver's payload — the route this box planned, or the one a dispatcher wrote by hand.
 *
 * **A hand-written route wins.** A dispatcher who knows the bridge is shut has to be able to say
 * so, and software that cannot be overridden gets worked around instead — which means a driver with
 * a piece of paper and a screen that disagrees with it. The screen is told **which of the two** it
 * is showing rather than leaving the driver to work it out.
 */
export function driverPayload(input: ScreenInput, driverId?: string): Record<string, unknown> | null {
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;
  const tolerance = policies === undefined ? {} : { handoverToleranceMinor: policies.handoverToleranceMinor };

  if (input.pack.route.known && input.pack.route.value !== null) {
    const route = input.pack.route.value;
    return {
      routeId: route.routeId,
      driverId: route.driverId,
      stops: route.stops,
      plannedBy: 'a dispatcher, by hand',
      ...(route.contributionRule === undefined ? {} : { contributionRule: route.contributionRule }),
      ...tolerance,
    };
  }

  const plan = dispatchPlanFor(input);
  if (plan === null) return null;

  // Whose route this is. Absent a named driver the box serves the first planned run, which is what
  // a single-van shop wants; a fleet passes the driver.
  const route = driverId === undefined ? plan.routes[0] : plan.routes.find((r) => r.driverId === driverId);
  if (route === undefined) return null;

  return {
    routeId: route.routeId,
    driverId: route.driverId,
    plannedBy: 'this store box',
    // Carried through so the screen can say it, rather than presenting a straight-line estimate as
    // a road distance. There is no map here and a river between two stops makes the order wrong.
    distancesAre: plan.distancesAre,
    stops: route.stops.map((s) => ({
      stopId: s.stopId,
      orderRef: s.orderId,
      area: s.area,
      codMinor: s.codMinor,
      ...(s.orderValueMinor === undefined ? {} : { orderValueMinor: s.orderValueMinor }),
      // The straight-line leg, used by the contribution rule the driver's own session applies.
      costMinor: s.legMetres,
    })),
    estimatedReturnAt: route.estimatedReturnAt,
    totalCodMinor: route.totalCodMinor,
    ...tolerance,
  };
}

/**
 * The customer's payload.
 *
 * The pack version travels with it, and that is not decoration: the app ties its basket review to
 * the version it was priced against, and paying against an older one is refused rather than quietly
 * repriced (P-02). Serving prices without the version would remove that check entirely.
 */
export function customerPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.products.known) return null;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;
  return {
    ...(policies === undefined ? {} : { tenantId: policies.storeId, privacySlaDays: policies.privacySlaDays }),
    packVersion: input.pack.version,
    products: input.pack.products.value.map((p) => ({
      productId: p.productId,
      name: p.name,
      ...(p.nameTa === undefined ? {} : { nameTa: p.nameTa }),
      categoryId: p.categoryId,
      unitPriceMinor: p.unitPriceMinor,
      uom: p.uom,
      barcodes: p.barcodes,
      status: 'active',
      availableMinor: p.availableMinor,
      ...(p.ageRestricted === undefined ? {} : { ageRestricted: p.ageRestricted }),
    })),
    ...(input.pack.slots.known ? { slots: input.pack.slots.value } : {}),
    ...(input.pack.consentPurposes.known ? { consentPurposes: input.pack.consentPurposes.value } : {}),
  };
}

/**
 * Fold a list of documents into a map keyed by their reference, summing quantities per product.
 *
 * Two goods receipts against one purchase order is an ordinary Tuesday — half the order on Monday
 * and the rest on Thursday. Keying by the order number and letting the second overwrite the first
 * would quietly report that only Thursday's half ever arrived, and the three-way match would then
 * withhold payment for goods that are sitting on the shelf.
 *
 * So they accumulate. The same fold is used for orders and for captured invoices, where a repeated
 * reference is a producer fault rather than a real second document — and there it fails toward
 * *blocked*, because a doubled invoiced quantity exceeds what was received and the match refuses.
 * Wrong, and refusing, is survivable. Wrong, and paying, is not.
 */
function foldByReference<TLine extends { readonly productId: string }>(
  documents: readonly { readonly reference: string; readonly lines: readonly TLine[] }[],
  merge: (into: TLine, next: TLine) => TLine,
): Record<string, TLine[]> {
  const out: Record<string, TLine[]> = {};
  for (const doc of documents) {
    const lines = out[doc.reference];
    const target = lines === undefined ? (out[doc.reference] = []) : lines;
    for (const line of doc.lines) {
      const index = target.findIndex((l) => l.productId === line.productId);
      const existing = index === -1 ? undefined : target[index];
      if (existing === undefined) target.push(line);
      else target[index] = merge(existing, line);
    }
  }
  return out;
}

/**
 * The buyer's payload (M06 · M07 · §28).
 *
 * `null` when this box has never been told who buys or what this tenant's match tolerances are —
 * because a buying screen that invented its own tolerances would be deciding, on its own authority,
 * how much of a price difference is worth nobody's attention.
 *
 * The three document sets are each served **only when the pack carried them**. The buyer's screen
 * then names each one it did not get, in a sentence, on the page. That matters more here than
 * anywhere else in this file: every missing set fails toward a refusal rather than a false
 * all-clear, so the danger is not a wrong answer, it is a buyer who cannot tell a supplier who
 * genuinely overcharged from a box that was never told what the order said.
 */
export function buyingPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.buyingPolicy.known) return null;
  const policy = input.pack.buyingPolicy.value;

  const payload: Record<string, unknown> = {
    buyerId: policy.buyerId,
    // The buyer is removed here rather than trusted to leave themselves alone. Separation of duties
    // enforced only by the list somebody was shown is not enforced at all (§28); the session model
    // refuses a self-approval as well, and this stops it ever being offered.
    approvers: policy.approvers.filter((who) => who !== policy.buyerId),
    quantityToleranceBps: policy.quantityToleranceBps,
    priceToleranceBps: policy.priceToleranceBps,
    immaterialMinor: policy.immaterialMinor,
  };

  if (input.pack.products.known) {
    payload['productIds'] = input.pack.products.value.map((p) => p.productId);
  }
  if (input.pack.purchaseOrders.known) {
    payload['ordered'] = foldByReference(
      input.pack.purchaseOrders.value.map((po) => ({ reference: po.poId, lines: po.lines })),
      (into, next) => ({ ...into, qty: into.qty + next.qty }),
    );
  }
  if (input.pack.receipts.known) {
    payload['received'] = foldByReference(
      input.pack.receipts.value.map((r) => ({ reference: r.poId, lines: r.lines })),
      (into, next) => ({ ...into, qty: into.qty + next.qty }),
    );
  }
  if (input.pack.supplierInvoices.known) {
    payload['captured'] = foldByReference(
      input.pack.supplierInvoices.value.map((i) => ({ reference: i.invoiceId, lines: i.lines })),
      (into, next) => ({
        ...into,
        quantity: into.quantity + next.quantity,
        lineTotalMinor: into.lineTotalMinor + next.lineTotalMinor,
      }),
    );
  }

  return payload;
}

/**
 * The product-and-pricing payload (M03 · M05 · D01 · §28).
 *
 * `null` when this box has never been told who prices or what margin this tenant will not go below
 * — a screen that invented its own margin floor would be deciding, on its own authority, how much
 * of the shop's profit is worth nobody's attention.
 *
 * **What things cost is served from the pack's own cost prices, and a product with none is simply
 * absent from the map.** Not zero. A cost of zero makes every price look like a 100% margin, so the
 * floor check passes loudly and wrongly at the moment somebody is relying on it — the screen turns
 * an absent cost into a refusal that needs an approver, which is the honest answer.
 */
export function cataloguePayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.pricingPolicy.known) return null;
  const policy = input.pack.pricingPolicy.value;

  const payload: Record<string, unknown> = {
    userId: policy.userId,
    storeId: input.pack.policies.known ? input.pack.policies.value.storeId : 'store-1',
    // The shop's own trading day, not the browser's clock. A device whose date is a day out would
    // otherwise activate tomorrow's price today.
    today: input.tradingDay,
    marginFloorBps: policy.marginFloorBps,
    // The setter is removed here rather than trusted to leave themselves alone (§28). The session
    // model refuses a self-approval as well; this stops it ever being offered.
    approvers: policy.approvers.filter((who) => who !== policy.userId),
  };

  if (input.pack.categories.known) payload['categories'] = input.pack.categories.value;
  if (input.pack.productMaster.known) payload['products'] = input.pack.productMaster.value;
  if (input.pack.priceEntries.known) {
    payload['priceEntries'] = input.pack.priceEntries.value.map((e) => ({
      id: e.id,
      productId: e.productId,
      scope: e.scope,
      scopeRef: e.scopeRef,
      // The wire carries minor units; the engine takes Money. Converting here rather than at every
      // call site means one place can be wrong instead of six — the same fault the manager's
      // approval inbox had once, where a bare number met code expecting `value.currency`.
      price: { minor: e.priceMinor, currency: 'INR' },
      effectiveFrom: e.effectiveFrom,
      ...(e.effectiveTo === undefined ? {} : { effectiveTo: e.effectiveTo }),
      status: e.status,
      version: e.version,
    }));
  }
  if (input.pack.products.known) {
    payload['barcodes'] = input.pack.products.value.flatMap((p) =>
      p.barcodes.map((barcode) => ({ barcode, productId: p.productId })));
    // Only the products that HAVE a cost. An entry of zero for the rest would be the whole point,
    // missed: the screen must be able to tell "it cost us nothing" from "nobody has told me".
    const costs: Record<string, number> = {};
    for (const product of input.pack.products.value) {
      if (product.unitCostMinor !== undefined) costs[product.productId] = product.unitCostMinor;
    }
    payload['costsMinor'] = costs;
  }

  // The shelf map, served as its parts rather than as a built map — the screen builds its own so
  // that anything assigned on it is kept while the person carries on working.
  if (input.pack.shelfLocations.known) payload['shelfLocations'] = input.pack.shelfLocations.value;
  if (input.pack.shelfAssignments.known) payload['shelfAssignments'] = input.pack.shelfAssignments.value;
  if (input.pack.shelfPolicy.known && input.pack.shelfPolicy.value.zoneOrder !== undefined) {
    payload['zoneOrder'] = input.pack.shelfPolicy.value.zoneOrder;
  }

  return payload;
}

/**
 * The merchandising payload (M04 · D02).
 *
 * `null` when this box has never been told the refill level or how long a count stays worth acting
 * on — a screen inventing those would be deciding, on its own authority, when a shelf is empty
 * enough to walk to and how old a reading may be before it is a waste of somebody's time.
 *
 * **Every other section is served only when the pack carried it**, and the screen names each gap.
 * The two that matter most: an absent planogram makes the check refuse outright rather than report
 * a clean shop, and an absent stockroom figure turns every refill task into a wish.
 */
export function merchandisingPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.merchandisingPolicy.known) return null;
  const policy = input.pack.merchandisingPolicy.value;

  const payload: Record<string, unknown> = {
    storeId: input.pack.policies.known ? input.pack.policies.value.storeId : 'store-1',
    // The shop's own trading day and the box's own clock. A tablet whose date is a day out would
    // otherwise judge every count as stale — or, worse, a three-day-old one as fresh.
    today: input.tradingDay,
    now: input.now,
    refillAtBp: policy.refillAtBp,
    countStaleAfterMinutes: policy.countStaleAfterMinutes,
    refillRole: policy.refillRole,
  };

  if (input.pack.shelfLocations.known) payload['shelfLocations'] = input.pack.shelfLocations.value;
  if (input.pack.shelfAssignments.known) payload['shelfAssignments'] = input.pack.shelfAssignments.value;
  if (input.pack.planogram.known) payload['planogram'] = input.pack.planogram.value;
  if (input.pack.shelfCounts.known) payload['shelfCounts'] = input.pack.shelfCounts.value;
  if (input.pack.backstock.known) payload['backstock'] = input.pack.backstock.value;
  if (input.pack.assortment.known) payload['assortment'] = input.pack.assortment.value;
  if (input.pack.products.known) {
    // On-hand from the catalogue pack's own availability. **This is the figure that decides whether
    // dropping an item deletes it or routes it to clearance**, so serving nothing here would be the
    // dangerous default: every drop would delist, and the stock still on the shelf would become
    // invisible — not counted, not replenished, not sold, eventually written off.
    const onHand: Record<string, number> = {};
    for (const product of input.pack.products.value) onHand[product.productId] = product.availableMinor;
    payload['onHand'] = onHand;
  }
  if (input.pack.spaceAreas.known) payload['spaceAreas'] = input.pack.spaceAreas.value;
  if (input.pack.salesByAreaMinor.known) payload['salesByAreaMinor'] = input.pack.salesByAreaMinor.value;
  if (input.pack.marginByAreaMinor.known) payload['marginByAreaMinor'] = input.pack.marginByAreaMinor.value;
  if (input.pack.displayContracts.known) payload['displayContracts'] = input.pack.displayContracts.value;
  if (input.pack.fundingReceivedMinor.known) payload['fundingReceivedMinor'] = input.pack.fundingReceivedMinor.value;
  if (input.pack.stillOccupying.known) payload['stillOccupying'] = input.pack.stillOccupying.value;

  // Everything this box has ever recorded selling — deliberately the whole log rather than today,
  // because the question the range check asks is *has this shop ever sold something it does not
  // range?*, and an item that sold last Tuesday is exactly as much evidence as one that sold this
  // morning. A sale record with no readable lines contributes nothing rather than defaulting,
  // because "this sale had no lines" is a broken record, not a sale of nothing.
  const sold = new Set<string>();
  for (const sale of input.sales) {
    if (sale.lines === undefined) continue;
    for (const line of sale.lines) sold.add(line.productId);
  }
  payload['soldProductIds'] = [...sold];

  return payload;
}

/**
 * The reporting payload (D13 · M29-FR-01/02 · §32).
 *
 * `null` when the box has never been told when a figure stops being current — a screen inventing
 * its own staleness thresholds would be deciding, on its own authority, how old a number may be
 * before somebody should stop making decisions on it.
 *
 * **`reportingRecords` is the important one.** It is what the shop actually records, and everything
 * absent from it makes its reports refuse **by name** rather than run and come back as zero. Served
 * only when the pack carried it: a box that was never told runs nothing and says so for each
 * report, which is the honest state for a shop that has just been switched on.
 */
export function reportingPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.reportingPolicy.known) return null;
  const policy = input.pack.reportingPolicy.value;
  const policies = input.pack.policies.known ? input.pack.policies.value : undefined;

  const payload: Record<string, unknown> = {
    storeId: policies?.storeId ?? 'store-1',
    branchId: policies?.branchId ?? null,
    // The box's own clock. A device an hour out would quietly relabel a stale figure as live.
    now: input.now,
    laggingAfterMinutes: policy.laggingAfterMinutes,
    staleAfterMinutes: policy.staleAfterMinutes,
    // This box's own queue and its own log — the two facts the cloud cannot supply, by definition.
    unsentCount: input.outbox.pending().length,
    lastSyncedAt: input.pack.receivedAt,
  };

  // Served only when the pack named one. Not defaulted: an export's audit record names who took
  // the data, and a made-up id there is worse than no export at all.
  if (policy.userId !== undefined) payload['userId'] = policy.userId;

  if (input.pack.reportingRecords.known) payload['records'] = input.pack.reportingRecords.value;
  if (input.pack.roles.known) payload['roles'] = input.pack.roles.value;
  if (input.pack.roleAssignments.known) payload['roleAssignments'] = input.pack.roleAssignments.value;

  // **TODAY's** sales, reduced to reporting facts. The log is never rotated, so this was the whole
  // history — "Sales by day: Taken ₹2,245" on a day the shop took ₹145, with nothing saying so.
  const today = salesOn(input.sales, input.tradingDay);
  payload['tradingDay'] = input.tradingDay;
  if (today.undated > 0) payload['undatedSales'] = today.undated;

  // A sale whose products have no cost price carries NO cogs rather than a zero — zero cost
  // reports a 100% margin, and the margin report leaves it out and counts it instead.
  const products = input.pack.products.known ? input.pack.products.value : [];
  const costOf = new Map(products.filter((p) => p.unitCostMinor !== undefined)
    .map((p) => [p.productId, p.unitCostMinor!] as const));
  payload['sales'] = today.sales.map((sale) => {
    // A record with no readable lines keeps its takings — the till printed them and they are real —
    // but it carries NO basket size. A zero would be averaged into "units per basket" and quietly
    // drag the shop's figure down by an amount nobody could explain.
    //
    // The costing and the basket size both come from `read-model`, which is where this box already
    // works them out for the owner's brief. Writing them again here is how the two screens end up
    // quoting different margins for the same day.
    const lines = sale.lines;
    let cogs = 0;
    let costable = lines !== undefined && lines.length > 0;
    if (lines !== undefined) {
      for (const line of lines) {
        const unit = costOf.get(line.productId);
        if (unit === undefined) { costable = false; break; }
        cogs += lineCostMinor(unit, line);
      }
    }
    return {
      saleId: sale.id,
      committedAt: sale.committedAt ?? input.now,
      cashierId: sale.cashierId ?? 'unknown',
      netMinor: sale.netMinor ?? 0,
      taxMinor: sale.taxMinor ?? 0,
      totalMinor: sale.total ?? 0,
      ...(costable ? { cogsMinor: cogs } : {}),
      ...(lines === undefined ? {} : { units: basketUnits(lines) }),
      tender: sale.tenders?.[0]?.kind ?? 'unknown',
    };
  });

  // ── What today is compared against (M29-FR-02) ────────────────────────────
  //
  // A number on its own says almost nothing to a shopkeeper. ₹1,40,000 is a good Saturday and a
  // frightening Tuesday, and the figure is identical. So every trading day this box holds is
  // summarised — one small row each, rather than shipping the whole log to a browser — and today
  // is compared against the one before it.
  //
  // **Only the days this box actually holds.** A box installed on Thursday has no Wednesday, and
  // a comparison against a Wednesday of zero would report the shop as having doubled its takings
  // overnight. Absent is absent, and the report says so by name.
  const perDay = new Map<string, { total: number; bills: number }>();
  for (const sale of input.sales) {
    if (sale.tradingDay === undefined) continue;
    const held = perDay.get(sale.tradingDay) ?? { total: 0, bills: 0 };
    perDay.set(sale.tradingDay, { total: held.total + (sale.total ?? 0), bills: held.bills + 1 });
  }
  payload['dayTotals'] = tradingDaysHeld(input.sales).map((tradingDay) => ({
    tradingDay,
    totalMinor: perDay.get(tradingDay)!.total,
    bills: perDay.get(tradingDay)!.bills,
  }));

  // What sold, by department, in UNITS.
  //
  // Units rather than money on purpose: the log records a quantity per line but **no money per
  // line**, so revenue by department could only be reconstructed from list prices — and a bill
  // with a promotion on it would then produce a department revenue that does not add up to the
  // day's takings. A figure that nearly reconciles is worse than one that is honestly a count.
  const categoryOf = new Map(products.map((p) => [p.productId, p.categoryId] as const));
  const unitsByCategory: Record<string, number> = {};
  let unitsWithNoCategory = 0;
  for (const sale of today.sales) {
    if (sale.lines === undefined) continue;
    for (const line of sale.lines) {
      const units = line.uom === 'ea' ? line.quantityMinor : 1;
      const category = categoryOf.get(line.productId);
      if (category === undefined) { unitsWithNoCategory += units; continue; }
      unitsByCategory[category] = (unitsByCategory[category] ?? 0) + units;
    }
  }
  payload['unitsByCategory'] = unitsByCategory;
  // Counted, not folded into a department. A product the catalogue does not place is a catalogue
  // problem, and hiding it inside "Grocery" is how it stays one.
  if (unitsWithNoCategory > 0) payload['unitsWithNoCategory'] = unitsWithNoCategory;
  if (input.pack.categories.known) {
    payload['categoryNames'] = Object.fromEntries(
      input.pack.categories.value.map((c) => [c.categoryId, c.name] as const),
    );
  }

  // The exception register, and whether the shop's limits were known at all. Zero exceptions with
  // no rules is not a clean shop; it is a shop nobody is watching.
  const rules = input.pack.lossPreventionRules.known
    ? (input.pack.lossPreventionRules.value as readonly LpRule[])
    : undefined;
  const day = exceptionsFor(activityFrom(today.sales), rules);
  payload['exceptionRulesKnown'] = day.rulesKnown;
  payload['exceptions'] = day.exceptions.map((e) => ({
    what: `${e.kind.replace(/_/g, ' ')} by ${e.cashierId}: ${e.observed} against a limit of ${e.limit}`,
  }));

  return payload;
}

/** The global each screen's bundle reads at boot. One name per screen, and they must not drift. */
export const GLOBAL_FOR: Readonly<Record<ScreenName, string>> = Object.freeze({
  pos: 'posCatalogue',
  manager: 'managerData',
  owner: 'ownerData',
  picker: 'pickerData',
  driver: 'driverData',
  customer: 'shopData',
  buying: 'buyingData',
  catalogue: 'catalogueData',
  merchandising: 'merchandisingData',
  reporting: 'reportingData',
});

const BUILDERS: Readonly<Record<ScreenName, (input: ScreenInput) => Record<string, unknown> | null>> = Object.freeze({
  pos: posPayload,
  manager: managerPayload,
  owner: ownerPayload,
  picker: pickerPayload,
  driver: driverPayload,
  customer: customerPayload,
  buying: buyingPayload,
  catalogue: cataloguePayload,
  merchandising: merchandisingPayload,
  reporting: reportingPayload,
});

/** Build one screen's payload. `null` means this box has nothing to give it, and says so. */
export function payloadFor(screen: ScreenName, input: ScreenInput): Record<string, unknown> | null {
  return BUILDERS[screen](input);
}
