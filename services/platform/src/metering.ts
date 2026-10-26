// Usage metering per shop, and the plan change judged before it happens (M36-FR-01 · D12-FR-06 · R8-2 · OB-321 · P-01 ·
// P-08 · hard rule #2).
//
// OB-321 (owner, 23 Oct 2026, in writing): meter STORES, LANES, USERS and AI SPEND per shop, FOR INFORMATION ONLY; pricing
// is decided before any outside shop signs up, and no price is invented — the meter says "not set".
//
//   • WHAT IS COUNTED, AND FROM WHERE. Stores: the branches head office holds that are active. Lanes: the tills
//     registered in the devices register that are not retired. Users: the people holding a role here now (machine
//     identities and outside parties — customers, suppliers, business customers — are not staff users). AI spend: the
//     metered cost of every AI run and model call this month, in paise. Each figure names its source.
//   • A DAILY RECORD. The ops-alert worker records the shop's figures once an hour (append-only `UsageMetered`, keyed by
//     the hour, so a replay is the same record); a month's peak is the highest record, its AI spend the latest
//     month-to-date. A month with no record says so — never a zero that looks like a measurement (P-08).
//   • INFORMATION, NEVER A CHARGE, NEVER A STOP. No charge is worked out here and no limit is enforced: `price` is
//     "not set" (OB-321) and `mayContinueTrading` is always true. A plan's limits, when the shop has a plan, are shown
//     beside the figures for information only.
//   • A PLAN CHANGE IS JUDGED FIRST. `POST …/plan-change/preview` runs the tested `assessPlanChange`: the features that
//     would switch off, the ones gained, the limits current usage already exceeds — and that no data is deleted. A change
//     that switches features off is refused at the subscribe route until the person names exactly those features
//     (`acceptFeaturesLost`), so nobody loses a feature by surprise.

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { meterUsage, assessPlanChange, type Plan, type UsageRecord, type MeteredDimension, type PlanChangeResult } from '../../../packages/platform/src/plans';
import { DEFAULT_SHOP_CALENDAR, shopDateIn, shopMonthIn } from '../../../packages/calendar/src/shop-clock';

/** One hour's measured figures for a shop. AI spend is month-to-date (it only grows within a month). */
export interface UsageSnapshot {
  readonly tenantId: string;
  /** YYYY-MM-DDTHH (UTC) — the hour it was measured in; one record per hour. */
  readonly hour: string;
  readonly stores: number;
  readonly lanes: number;
  readonly users: number;
  readonly aiSpendMinor: number;
  readonly at: string;
}

export interface LiveFigures {
  readonly stores: number;
  readonly lanes: number;
  readonly users: number;
  /** Month-to-date, in paise. */
  readonly aiSpendMinor: number;
}

export interface MeteringDeps {
  /** The shop's figures right now, for a month (AI spend is that month's). */
  readonly live: (tenantId: string, month: string) => Promise<LiveFigures>;
  readonly snapshots: (tenantId: string) => Promise<readonly UsageSnapshot[]>;
  readonly recordSnapshot: (tenantId: string, s: UsageSnapshot) => Promise<void>;
  /** The plan the shop is on (from its subscription), or undefined when it has none. */
  readonly currentPlanId: (tenantId: string) => Promise<string | undefined>;
  readonly plans: () => Promise<readonly Plan[]> | readonly Plan[];
  readonly now: () => string;
}

export const METERING_SOURCES = Object.freeze({
  stores: 'active branches in the organisation register',
  lanes: 'till lanes in the devices register that are not retired',
  users: 'people holding a role now (machine identities, customers, suppliers and business customers are not counted)',
  aiSpendMinor: 'the metered cost of every AI run and model call this month, in paise',
});

/** OB-321: no price is invented — the meter is for information, and the price is decided before any outside shop signs. */
export const PRICE_NOT_SET = Object.freeze({
  set: false as const,
  words: 'not set',
  why: 'OB-321 (owner, 23 Oct 2026): usage is metered for information only; pricing is decided before any outside shop signs up.',
});

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DIMENSION_OF: Readonly<Record<'stores' | 'lanes' | 'users', MeteredDimension>> = { stores: 'branches', lanes: 'lanes', users: 'named_users' };

/** The month's records as the plans engine's usage records (peaks; AI spend is not a plan dimension). */
export function usageRecordsOf(tenantId: string, snapshots: readonly UsageSnapshot[], month: string, timeZone: string = DEFAULT_SHOP_CALENDAR.timeZone): readonly UsageRecord[] {
  // R1b (M01-FR-02): a snapshot belongs to the shop's month and date, never the UTC ones (00:00–05:30 IST on the 1st).
  return snapshots.filter((s) => s.tenantId === tenantId && shopMonthIn(s.at, timeZone) === month).flatMap((s) => (['stores', 'lanes', 'users'] as const)
    .map((k) => ({ tenantId, dimension: DIMENSION_OF[k], units: s[k], onDate: shopDateIn(s.at, timeZone) })));
}

/** Record this hour's figures (the ops-alert worker's pass). Idempotent by the hour; answers whether a record was new. */
export async function recordUsageHour(deps: Pick<MeteringDeps, 'live' | 'snapshots' | 'recordSnapshot'>, tenantId: string, at: string): Promise<boolean> {
  const hour = at.slice(0, 13);
  if ((await deps.snapshots(tenantId)).some((s) => s.hour === hour)) return false;
  const live = await deps.live(tenantId, shopMonthIn(at));
  await deps.recordSnapshot(tenantId, { tenantId, hour, ...live, at });
  return true;
}

export function meteringRoutes(deps: MeteringDeps): readonly Route[] {
  const monthOf = (ctx: RequestContext): string => {
    const m = (ctx.query['month'] ?? shopMonthIn(deps.now())).trim();
    if (!MONTH.test(m)) throw apiError(400, { code: 'not_a_month', whatHappened: `"${m}" is not a month (YYYY-MM).`, wasItSaved: 'not_saved', nextSafeAction: 'Ask for ?month=YYYY-MM, or leave it out for this month.' });
    return m;
  };
  const planOf = async (planId: string | undefined): Promise<Plan | undefined> =>
    (planId === undefined ? undefined : (await deps.plans()).find((p) => p.planId === planId));

  return [
    {
      // The shop's metered figures — now, and for the month — FOR INFORMATION. Price "not set" (OB-321).
      api: 'API-11', method: 'GET', path: '/v1/platform/metering',
      permission: 'platform.metering.read',
      handler: async (ctx): Promise<HandlerResult> => {
        const month = monthOf(ctx);
        const at = deps.now();
        const thisMonth = month === shopMonthIn(at);
        const [all, planId] = await Promise.all([deps.snapshots(ctx.tenantId), deps.currentPlanId(ctx.tenantId)]);
        const inMonth = all.filter((s) => shopMonthIn(s.at) === month);
        const live = thisMonth ? await deps.live(ctx.tenantId, month) : undefined;
        const peak = (k: 'stores' | 'lanes' | 'users'): number | null => (inMonth.length === 0 ? null : Math.max(...inMonth.map((s) => s[k])));
        const latest = inMonth.reduce<UsageSnapshot | undefined>((l, s) => (l === undefined || s.at > l.at ? s : l), undefined);
        const plan = await planOf(planId);
        // A plan's limits beside the month's peaks — for information only: no overage is priced and nothing is enforced.
        const againstPlan = plan === undefined ? null : meterUsage({
          subscription: { tenantId: ctx.tenantId, planId: plan.planId, startedOn: `${month}-01` },
          plan: { ...plan, monthlyPriceMinor: 0, overageMinor: {} },
          usage: usageRecordsOf(ctx.tenantId, all, month), from: `${month}-01`, to: `${month}-31`,
        }).dimensions.map((d) => ({ dimension: d.dimension, used: d.used, limit: d.limit, overBy: d.overBy, notify: d.notify }));
        return {
          status: 200,
          body: {
            shop: ctx.tenantId, month, forInformationOnly: true, mayContinueTrading: true, price: PRICE_NOT_SET,
            sources: METERING_SOURCES,
            now: live === undefined ? null : { ...live, asOf: at },
            monthRecorded: inMonth.length === 0
              ? { recorded: false, words: 'not recorded yet — the hourly meter has no record for this month' }
              : { recorded: true, hoursRecorded: inMonth.length, peakStores: peak('stores'), peakLanes: peak('lanes'), peakUsers: peak('users'), aiSpendMinor: latest!.aiSpendMinor, lastRecordedAt: latest!.at },
            plan: plan === undefined ? null : { planId: plan.planId, name: plan.name, limitsForInformation: againstPlan },
          },
        };
      },
    },
    {
      // A plan change judged BEFORE it happens: features off, features gained, limits already exceeded — no data deleted.
      api: 'API-11', method: 'POST', path: '/v1/platform/subscription/plan-change/preview',
      permission: 'platform.plan.read', idempotent: true,
      handler: async (ctx) => ({ status: 200, body: await previewPlanChange(deps, ctx.tenantId, (ctx.body as { planId?: unknown } | null)?.planId) }),
    },
  ];
}

/** The plan-change assessment (shared by the preview route and the subscribe guard). */
export async function previewPlanChange(deps: MeteringDeps, tenantId: string, planIdRaw: unknown): Promise<PlanChangeResult & { readonly subscribed: boolean; readonly dataDeleted: false; readonly price: typeof PRICE_NOT_SET }> {
  const plans = await deps.plans();
  const target = typeof planIdRaw === 'string' ? plans.find((p) => p.planId === planIdRaw) : undefined;
  if (target === undefined) {
    throw apiError(404, { code: 'unknown_plan', whatHappened: `There is no plan "${String(planIdRaw ?? '')}".`, wasItSaved: 'not_saved', nextSafeAction: `Choose one of: ${plans.map((p) => p.planId).join(', ') || '(none configured)'}.` });
  }
  const currentId = await deps.currentPlanId(tenantId);
  const current = plans.find((p) => p.planId === currentId) ?? { planId: 'none', name: 'no plan', grants: [], limits: {}, monthlyPriceMinor: 0 };
  const at = deps.now();
  const usage = usageRecordsOf(tenantId, await deps.snapshots(tenantId), shopMonthIn(at));
  const live = await deps.live(tenantId, shopMonthIn(at));
  const today = shopDateIn(at);
  const nowUsage: UsageRecord[] = [
    { tenantId, dimension: 'branches', units: live.stores, onDate: today },
    { tenantId, dimension: 'lanes', units: live.lanes, onDate: today },
    { tenantId, dimension: 'named_users', units: live.users, onDate: today },
  ];
  const result = assessPlanChange({ subscription: { tenantId, planId: current.planId, startedOn: today }, current, target, currentUsage: [...usage, ...nowUsage], asAt: at });
  return { ...result, subscribed: currentId !== undefined, dataDeleted: false, price: PRICE_NOT_SET };
}

/**
 * The subscribe route, guarded (M36-FR-01 plan change): a change that switches features OFF goes through only when the
 * body names exactly those features (`acceptFeaturesLost`). Nothing else about subscribing changes.
 */
export function guardPlanChange(inner: Route['handler'], deps: MeteringDeps): Route['handler'] {
  return async (ctx) => {
    const b = (ctx.body ?? {}) as { planId?: unknown; acceptFeaturesLost?: unknown };
    const plans = await deps.plans();
    const currentId = await deps.currentPlanId(ctx.tenantId);
    if (currentId === undefined || typeof b.planId !== 'string' || !plans.some((p) => p.planId === b.planId) || b.planId === currentId) return inner(ctx);
    const assessed = await previewPlanChange(deps, ctx.tenantId, b.planId);
    const accepted = Array.isArray(b.acceptFeaturesLost) ? [...new Set(b.acceptFeaturesLost.filter((f): f is string => typeof f === 'string'))].sort() : [];
    if (assessed.featuresLost.length > 0 && JSON.stringify(accepted) !== JSON.stringify([...assessed.featuresLost])) {
      throw apiError(409, {
        code: 'plan_change_loses_features',
        whatHappened: `Moving from ${currentId} to ${b.planId} switches OFF ${assessed.featuresLost.join(', ')}. No data is deleted — taking the plan back brings them back with their history.`,
        wasItSaved: 'not_saved',
        nextSafeAction: `Read the preview (POST /v1/platform/subscription/plan-change/preview), then send again with acceptFeaturesLost: ${JSON.stringify(assessed.featuresLost)}. Nothing was changed.`,
      });
    }
    const out = await inner(ctx);
    return { ...out, body: { ...(out.body as Record<string, unknown>), planChange: assessed } };
  };
}
