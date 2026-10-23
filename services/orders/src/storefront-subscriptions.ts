// API-07 Repeat online orders (M17-FR-02 "subscriptions" · owner decision OB-303 · M18-FR-01 · hard rules #3, #6, #10).
//
//   • THE CUSTOMER'S PLAN. A signed-in customer keeps a plan — what, which store, which days, pickup or delivery — and can
//     pause, resume or cancel it in one tap. Each change is a fact on the record, never an edit (hard rule #2).
//   • HEAD OFFICE PLACES EACH DAY'S ORDER. On the day before it is due (or on the day), the run places it as an ORDINARY
//     online order through the storefront's own placement — the same listing check, delivery-slot binding, promise and
//     reservation, the same price — under an id made from the plan and the day, so it is placed once however often the
//     run comes round. No card is kept (hard rule #3): the order waits for the customer to pay in the app.
//   • NOTHING IS SKIPPED SILENTLY (P-08). A day the shop could not place — not listed, no slot left, out of stock — is
//     recorded with the shop's own words, for the customer and for staff; so is a day the run never reached.
// The run is on head office's timer (the ops worker) and on demand for staff.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  readSubscriptionPlan, subscriptionStateAt, dueToPlace, nextOccurrences, occurrenceOrderId,
  type SubscriptionPlan, type SubscriptionChange, type SubscriptionState,
} from '../../../packages/storefront/src/subscriptions';

export interface SubscriptionOccurrence {
  readonly subscriptionId: string;
  readonly day: string;
  readonly orderId: string;
  readonly outcome: 'placed' | 'not_placed' | 'missed';
  readonly at: string;
  /** The shop's own words — what was placed, or why not. */
  readonly detail: string;
  /** What the customer pays for it (the shop's quote), when placed and priced. */
  readonly payableMinor?: number;
  readonly shortages?: readonly { readonly productId: string; readonly requestedMinor: number; readonly promisedMinor: number }[];
}

export type PlaceAttempt =
  | { readonly placed: true; readonly payableMinor?: number; readonly shortages?: SubscriptionOccurrence['shortages']; readonly detail: string }
  | { readonly placed: false; readonly why: string };

export interface SubscriptionDeps {
  readonly plans: (tenantId: string) => Promise<readonly SubscriptionPlan[]>;
  readonly recordPlan: (tenantId: string, plan: SubscriptionPlan) => Promise<void>;
  readonly changes: (tenantId: string) => Promise<readonly SubscriptionChange[]>;
  readonly recordChange: (tenantId: string, c: SubscriptionChange) => Promise<void>;
  readonly occurrences: (tenantId: string) => Promise<readonly SubscriptionOccurrence[]>;
  readonly recordOccurrence: (tenantId: string, o: SubscriptionOccurrence) => Promise<void>;
  /** Place one day's order through the storefront's own placement, as the customer. */
  readonly placeOrder: (tenantId: string, input: { readonly orderId: string; readonly plan: SubscriptionPlan; readonly day: string }) => Promise<PlaceAttempt>;
  /** Today in the shop's own calendar. */
  readonly today: (tenantId: string) => Promise<string>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

const SAY: Readonly<Record<SubscriptionState, { readonly en: string; readonly ta: string }>> = {
  active: { en: 'On — the shop places each order the day before it is due; you pay for each in the app.', ta: 'இயக்கத்தில் — ஒவ்வொரு ஆர்டரையும் உரிய நாளுக்கு முந்தைய நாள் கடை வைக்கும்; ஒவ்வொன்றுக்கும் செயலியில் பணம் செலுத்துவீர்கள்.' },
  paused: { en: 'Paused — no order is placed until you resume it.', ta: 'இடைநிறுத்தப்பட்டது — மீண்டும் தொடங்கும் வரை எந்த ஆர்டரும் வைக்கப்படாது.' },
  cancelled: { en: 'Cancelled — no more orders will be placed.', ta: 'ரத்து செய்யப்பட்டது — இனி ஆர்டர்கள் வைக்கப்படாது.' },
};

/** One plan as the customer and staff see it: its state, its next days, and what happened on each day so far. */
function planView(plan: SubscriptionPlan, changes: readonly SubscriptionChange[], occurrences: readonly SubscriptionOccurrence[], today: string, now: string) {
  const mine = changes.filter((c) => c.subscriptionId === plan.subscriptionId);
  const state = subscriptionStateAt(mine, now);
  return {
    ...plan, state, say: SAY[state],
    nextDays: state === 'cancelled' ? [] : nextOccurrences(plan, today, 5),
    changes: mine,
    occurrences: occurrences.filter((o) => o.subscriptionId === plan.subscriptionId).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 30),
  };
}

export interface RunOutcome { readonly placed: number; readonly notPlaced: number; readonly missed: number; readonly outcomes: readonly SubscriptionOccurrence[] }

/** One pass over every plan: place what is due, say what could not be placed and what was missed. Once per day each. */
export async function runSubscriptions(deps: SubscriptionDeps, tenantId: string): Promise<RunOutcome> {
  const today = await deps.today(tenantId);
  const now = deps.now();
  const changes = await deps.changes(tenantId);
  const done = new Map<string, Set<string>>();
  for (const o of await deps.occurrences(tenantId)) {
    const set = done.get(o.subscriptionId) ?? new Set<string>();
    set.add(o.day);
    done.set(o.subscriptionId, set);
  }
  const outcomes: SubscriptionOccurrence[] = [];
  for (const plan of await deps.plans(tenantId)) {
    const due = dueToPlace({ plan, changes: changes.filter((c) => c.subscriptionId === plan.subscriptionId), done: done.get(plan.subscriptionId) ?? new Set(), today, now });
    for (const day of due.missed) {
      const o: SubscriptionOccurrence = { subscriptionId: plan.subscriptionId, day, orderId: occurrenceOrderId(plan.subscriptionId, day), outcome: 'missed', at: now, detail: `The repeat order for ${day} was not placed in time — nothing was charged. Please order it yourself if you still need it.` };
      await deps.recordOccurrence(tenantId, o);
      outcomes.push(o);
    }
    for (const day of due.place) {
      const orderId = occurrenceOrderId(plan.subscriptionId, day);
      const attempt = await deps.placeOrder(tenantId, { orderId, plan, day });
      const o: SubscriptionOccurrence = attempt.placed
        ? { subscriptionId: plan.subscriptionId, day, orderId, outcome: 'placed', at: now, detail: attempt.detail, ...(attempt.payableMinor === undefined ? {} : { payableMinor: attempt.payableMinor }), ...(attempt.shortages === undefined || attempt.shortages.length === 0 ? {} : { shortages: attempt.shortages }) }
        : { subscriptionId: plan.subscriptionId, day, orderId, outcome: 'not_placed', at: now, detail: attempt.why };
      await deps.recordOccurrence(tenantId, o);
      outcomes.push(o);
    }
  }
  return { placed: outcomes.filter((o) => o.outcome === 'placed').length, notPlaced: outcomes.filter((o) => o.outcome === 'not_placed').length, missed: outcomes.filter((o) => o.outcome === 'missed').length, outcomes };
}

export function subscriptionRoutes(deps: SubscriptionDeps): readonly Route[] {
  const ownOr = async (ctx: RequestContext): Promise<SubscriptionPlan> => {
    const id = ctx.params['subscriptionId'] ?? '';
    const plan = (await deps.plans(ctx.tenantId)).find((p) => p.subscriptionId === id);
    if (plan === undefined) throw notFound(`repeat order ${id}`);
    if (plan.customerRef !== ctx.userId) {
      throw apiError(403, { code: 'not_your_repeat_order', whatHappened: 'This repeat order is not yours. You can only see and change your own.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
    }
    return plan;
  };
  const change = (kind: SubscriptionChange['change']): Route['handler'] => async (ctx) => {
    const plan = await ownOr(ctx);
    const changes = (await deps.changes(ctx.tenantId)).filter((c) => c.subscriptionId === plan.subscriptionId);
    const state = subscriptionStateAt(changes, deps.now());
    const target: SubscriptionState = kind === 'paused' ? 'paused' : kind === 'resumed' ? 'active' : 'cancelled';
    if (state === 'cancelled' && kind !== 'cancelled') {
      throw apiError(409, { code: 'repeat_order_cancelled', whatHappened: 'This repeat order was cancelled; it cannot be paused or resumed. Make a new one if you want it again.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
    }
    if (state !== target) {
      const reason = ((ctx.body ?? {}) as Record<string, unknown>)['reason'];
      await deps.recordChange(ctx.tenantId, { subscriptionId: plan.subscriptionId, change: kind, at: deps.now(), by: ctx.userId, ...(isStr(reason) ? { reason: reason.trim().slice(0, 200) } : {}) });
    }
    return { status: 200, body: planView(plan, await deps.changes(ctx.tenantId), await deps.occurrences(ctx.tenantId), await deps.today(ctx.tenantId), deps.now()) };
  };
  return [
    {
      // My repeat orders: each plan, on / paused / cancelled, its next days, and what happened on each day.
      api: 'API-07', method: 'GET', path: '/v1/me/subscriptions',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const [plans, changes, occurrences, today] = await Promise.all([deps.plans(ctx.tenantId), deps.changes(ctx.tenantId), deps.occurrences(ctx.tenantId), deps.today(ctx.tenantId)]);
        const mine = plans.filter((p) => p.customerRef === ctx.userId).map((p) => planView(p, changes, occurrences, today, deps.now()));
        return { status: 200, body: { subscriptions: mine, count: mine.length, paysBy: 'You pay for each repeat order in the app when it is placed — the shop keeps no card.' } };
      },
    },
    {
      // Start a repeat order. Body: { lines, locationId, schedule, startsOn, fulfilment, delivery? }. Created once.
      api: 'API-07', method: 'POST', path: '/v1/me/subscriptions/:subscriptionId',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const id = ctx.params['subscriptionId'] ?? '';
        if (!ID.test(id)) throw apiError(400, { code: 'not_readable_as_a_repeat_order', whatHappened: 'A repeat order id is letters, digits, - or _ (up to 40).', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was saved.' });
        const read = readSubscriptionPlan(ctx.body);
        if (!read.ok) throw apiError(400, { code: 'not_readable_as_a_repeat_order', whatHappened: read.detail, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was saved. Choose again.' });
        const existing = (await deps.plans(ctx.tenantId)).find((p) => p.subscriptionId === id);
        if (existing !== undefined) {
          if (existing.customerRef !== ctx.userId) throw apiError(409, { code: 'repeat_order_id_in_use', whatHappened: 'That repeat order id is taken.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was saved. Try again.' });
          return { status: 200, body: { ...planView(existing, await deps.changes(ctx.tenantId), await deps.occurrences(ctx.tenantId), await deps.today(ctx.tenantId), deps.now()), alreadySaved: true } };
        }
        const today = await deps.today(ctx.tenantId);
        if (read.plan.startsOn < today) throw apiError(400, { code: 'starts_in_the_past', whatHappened: `A repeat order starts today (${today}) or later.`, wasItSaved: 'not_saved', nextSafeAction: 'Choose a start day from today. Nothing was saved.' });
        const plan: SubscriptionPlan = { ...read.plan, subscriptionId: id, customerRef: ctx.userId, createdAt: deps.now() };
        await deps.recordPlan(ctx.tenantId, plan);
        return { status: 201, body: planView(plan, [], [], today, deps.now()) };
      },
    },
    { api: 'API-07', method: 'POST', path: '/v1/me/subscriptions/:subscriptionId/pause', permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true, handler: change('paused') },
    { api: 'API-07', method: 'POST', path: '/v1/me/subscriptions/:subscriptionId/resume', permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true, handler: change('resumed') },
    { api: 'API-07', method: 'POST', path: '/v1/me/subscriptions/:subscriptionId/cancel', permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true, handler: change('cancelled') },
    {
      // Staff: every repeat order and every day not placed — the exceptions first.
      api: 'API-07', method: 'GET', path: '/v1/repeat-orders',
      permission: 'order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const [plans, changes, occurrences, today] = await Promise.all([deps.plans(ctx.tenantId), deps.changes(ctx.tenantId), deps.occurrences(ctx.tenantId), deps.today(ctx.tenantId)]);
        const notPlaced = occurrences.filter((o) => o.outcome !== 'placed').sort((a, b) => b.day.localeCompare(a.day));
        return { status: 200, body: { subscriptions: plans.map((p) => planView(p, changes, occurrences, today, deps.now())), notPlaced, detail: notPlaced.length === 0 ? 'Every repeat order due so far was placed.' : `${notPlaced.length} day(s) were not placed — each says why.` } };
      },
    },
    {
      // Staff: run the placement now (it also runs on head office's timer).
      api: 'API-07', method: 'POST', path: '/v1/repeat-orders/run',
      permission: 'order.exception.manage', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => ({ status: 200, body: await runSubscriptions(deps, ctx.tenantId) }),
    },
  ];
}
