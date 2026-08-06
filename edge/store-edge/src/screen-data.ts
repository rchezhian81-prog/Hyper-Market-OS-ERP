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

import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { assessChecklist } from '../../../packages/workforce/src/index';
import type { LpRule } from '../../../packages/loss-prevention/src/index';
import { planDispatch, type DispatchPlan } from '../../../packages/fulfilment/src/routing';
import { costTheDay, exceptionsFor, activityFrom, type LoggedSale } from './read-model';
import type { StorePack } from './store-pack';

/** The six screens this box serves. Named so a route, a test and a payload cannot drift apart. */
export const SCREENS = Object.freeze(['pos', 'manager', 'owner', 'picker', 'driver', 'customer'] as const);
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
  const day = exceptionsFor(activityFrom(input.sales), rules);
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
  const day = costTheDay(input.sales, products);

  const exceptions: { cashierId: string; kind: string; breach: string; observed: number; limit: number; severity: string; linkedTxnIds: string[] }[] = [];
  const rules = input.pack.lossPreventionRules.known
    ? (input.pack.lossPreventionRules.value as readonly LpRule[])
    : undefined;
  for (const e of exceptionsFor(activityFrom(input.sales), rules).exceptions) {
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

/** The picker's payload: the wave the cloud assigned, or nothing when none was. */
export function pickerPayload(input: ScreenInput): Record<string, unknown> | null {
  if (!input.pack.wave.known || input.pack.wave.value === null) return null;
  const wave = input.pack.wave.value;
  return {
    waveId: wave.waveId,
    pickerId: wave.pickerId,
    lines: wave.lines.map((l) => ({
      lineId: l.lineId,
      orderRef: l.orderRef,
      productId: l.productId,
      description: l.description,
      bin: l.bin,
      requiredQty: l.requiredQty,
      uom: l.uom,
      unitPrice: { minor: l.unitPriceMinor, currency: 'INR' },
    })),
  };
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

/** The global each screen's bundle reads at boot. One name per screen, and they must not drift. */
export const GLOBAL_FOR: Readonly<Record<ScreenName, string>> = Object.freeze({
  pos: 'posCatalogue',
  manager: 'managerData',
  owner: 'ownerData',
  picker: 'pickerData',
  driver: 'driverData',
  customer: 'shopData',
});

const BUILDERS: Readonly<Record<ScreenName, (input: ScreenInput) => Record<string, unknown> | null>> = Object.freeze({
  pos: posPayload,
  manager: managerPayload,
  owner: ownerPayload,
  picker: pickerPayload,
  driver: driverPayload,
  customer: customerPayload,
});

/** Build one screen's payload. `null` means this box has nothing to give it, and says so. */
export function payloadFor(screen: ScreenName, input: ScreenInput): Record<string, unknown> | null {
  return BUILDERS[screen](input);
}
