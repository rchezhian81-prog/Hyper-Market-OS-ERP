// API-04 Stock-count PLANS (WF-08 · M09-FR-04 · D05-FR-05 · M08-FR-03 · §28 · §31 · P-08 · hard rules #2 #10) — round 8.
//
// WF-08's path is "plan/freeze rules → blind count → recount → variance cause → approval → adjustment/accounting". The
// blind count, the held variance and its second-person decision already existed (counts.ts); this file adds the steps
// around them, on the SAME count register and the SAME decide step:
//
//   • PLAN — a manager names the place, the products to count, the movement kinds FROZEN at that place for those products
//     while the count is open, and the RECOUNT threshold (a variance worth at least this is counted again before anyone
//     may approve it). No default is invented for either: the planner chooses, and the plan records who chose. A till
//     sale or a till return can never be frozen (hard rule #1 — the till never waits on head office).
//   • OPEN — the freeze starts. A frozen kind typed on the plain movements route is refused by name; one that lands any
//     other way (a delivery booked on a device while the line was down, which must never be refused into the void) is a
//     visible exception on the plan, and the product it touched must be counted again after it (hard rule #10).
//   • BLIND COUNT — the counter sends only what they saw. Head office works out the expected figure AS OF the moment
//     counted (every movement dated up to then), so a sale that reaches head office late is not mistaken for a loss.
//     Every variance is HELD for the plan; nothing is applied line by line. A counter's sheet never shows the expected.
//   • RECOUNT — a variance worth the recount threshold or more (or one head office cannot value) must be recounted; the
//     recount supersedes the first count. So must a count whose expected figure moved after it was taken.
//   • CAUSE — every variance that will post carries a root cause from the fixed adjustment list (damaged, expired,
//     miscount, found, theft_suspected, other) set by a manager, with a note.
//   • APPROVAL — one act by a person who counted none of the variances they approve (§28): every final variance posts ONE
//     compensating M08 movement (`count:<countId>`) through `decideCount`; every superseded count is closed as such.
//   • ACCOUNTING — the posted variances are valued records the accountant's posting run turns into journals (stock loss /
//     stock gain against inventory) through the mapping — `services/finance/src/stock-losses.ts`.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { InvalidCountError } from '../../../packages/counts/src/counts';
import { ADJUSTMENT_REASON_CODES, isAdjustmentReason } from '../../../packages/adjustment/src/adjustment';
import { reconcileBlindCount, decideCount, type CountsDeps, type CountFlag, type StoredReconciliation } from './counts';
import { assertLocationInScope, stockReadScope } from './location-scope';

/** The movement kinds a plan may freeze. Till sales and till returns are never among them (hard rule #1). */
export const FREEZABLE_KINDS = Object.freeze([
  'received', 'transferred_in', 'transferred_out', 'adjusted', 'wasted', 'returned_to_supplier',
  'produced', 'consumed_in_production', 'counted',
] as const);
export type FreezableKind = (typeof FREEZABLE_KINDS)[number];
const NEVER_FROZEN = Object.freeze(['sold', 'returned']);

export type CountPlanState = 'planned' | 'counting' | 'approved' | 'cancelled';

export interface CountPlan {
  readonly planId: string;
  readonly locationId: string;
  readonly productIds: readonly string[];
  /** The movement kinds that must not happen at this place, for these products, while the count is open. */
  readonly frozenKinds: readonly FreezableKind[];
  /** A variance worth at least this (minor units, head office's cost) is counted again before anyone may approve it. */
  readonly recountThresholdMinor: number;
  readonly note: string | null;
  readonly plannedBy: string;
  readonly plannedAt: string;
  readonly state: CountPlanState;
  readonly openedBy?: string;
  readonly openedAt?: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly approvalReason?: string;
  readonly cancelledBy?: string;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
}

/** A variance's root cause, set by a manager (D05-FR-05 "variance root cause"). Latest per count wins; never edited. */
export interface VarianceCause {
  readonly planId: string;
  readonly countId: string;
  readonly causeCode: string;
  readonly note: string;
  readonly setBy: string;
  readonly setAt: string;
}

/** A movement head office holds at the plan's place — what the freeze and the as-of expected figure are judged on. */
export interface PlaceMovement {
  readonly movementId: string;
  readonly productId: string;
  readonly kind: string;
  /** Signed effect on on-hand (+ in, − out). */
  readonly effectMinor: number;
  readonly occurredAt: string;
}

export interface CountPlanDeps extends CountsDeps {
  readonly plan: (tenantId: string, planId: string) => Promise<CountPlan | undefined> | CountPlan | undefined;
  readonly plans: (tenantId: string) => Promise<readonly CountPlan[]> | readonly CountPlan[];
  /** Append the plan's new state (created / opened / approved / cancelled) — a new event each time, never an edit. */
  readonly recordPlan: (tenantId: string, plan: CountPlan, step: 'created' | 'opened' | 'approved' | 'cancelled') => Promise<void> | void;
  readonly causes: (tenantId: string, planId: string) => Promise<readonly VarianceCause[]> | readonly VarianceCause[];
  readonly recordCause: (tenantId: string, cause: VarianceCause) => Promise<void> | void;
  /** Every count recorded under this plan (the count register's records carrying `planId`), latest state per count. */
  readonly planCounts: (tenantId: string, planId: string) => Promise<readonly StoredReconciliation[]> | readonly StoredReconciliation[];
  /** Every M08 movement at this location for these products — the as-of expected figure and the freeze check read it. */
  readonly movementsAt: (tenantId: string, locationId: string, productIds: readonly string[]) => Promise<readonly PlaceMovement[]> | readonly PlaceMovement[];
  /** Who holds which permissions — a relayed count's counter is re-verified (flag, never silent). */
  readonly permissionsOfUser?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** Head office's on-hand for a product at the place, AS OF a moment: every movement dated up to then (the plan's own corrections excluded). */
export const onHandAsOf = (moves: readonly PlaceMovement[], productId: string, at: string, excludeIds: ReadonlySet<string> = new Set()): number =>
  moves.filter((m) => m.productId === productId && m.occurredAt <= at && !excludeIds.has(m.movementId)).reduce((s, m) => s + m.effectMinor, 0);

export type LineState = 'not_counted' | 'matched' | 'recount_required' | 'cause_required' | 'ready';
export type RecountReason = 'over_recount_threshold' | 'value_unknown' | 'moved_during_freeze' | 'expected_changed';

/** One product's position in the plan: its counts, the one that stands, and what it still needs. */
export interface PlanLine {
  readonly productId: string;
  readonly state: LineState;
  readonly finalCountId: string | null;
  readonly counts: readonly StoredReconciliation[];
  readonly recountBecause: readonly RecountReason[];
  readonly frozenMovements: readonly PlaceMovement[];
  readonly cause: VarianceCause | null;
  readonly varianceMinor: number;
  readonly valueMinor: number;
}

/**
 * Where every product of the plan stands (pure). The count that STANDS for a product is its latest count that nothing
 * recounted. It needs a recount when: its variance is worth the recount threshold or more and it is not itself a recount;
 * head office cannot value it; a FROZEN movement landed at the place for the product after it was counted (it no longer
 * describes the shelf under the freeze); or head office's figure as of the moment counted is no longer the one it was
 * judged against (a movement dated before the count arrived after it). A variance that will post needs a cause.
 */
export function planPosition(plan: CountPlan, counts: readonly StoredReconciliation[], causes: readonly VarianceCause[], moves: readonly PlaceMovement[]): readonly PlanLine[] {
  const own = new Set(counts.map((c) => `count:${c.countId}`));
  const recounted = new Set(counts.map((c) => c.recountOf).filter((x): x is string => x !== undefined));
  const causeOf = new Map<string, VarianceCause>();
  for (const c of causes) causeOf.set(c.countId, c);
  const frozen = new Set<string>(plan.frozenKinds);
  return plan.productIds.map((productId) => {
    const mine = counts.filter((c) => c.productId === productId);
    const standing = mine.filter((c) => !recounted.has(c.countId));
    const final = standing[standing.length - 1];
    const base = { productId, counts: mine, cause: null as VarianceCause | null, recountBecause: [] as RecountReason[], frozenMovements: [] as PlaceMovement[] };
    if (final === undefined) return { ...base, state: 'not_counted' as const, finalCountId: null, varianceMinor: 0, valueMinor: 0 };
    const countedAt = final.countedAt ?? final.at;
    const because: RecountReason[] = [];
    const flags = final.governanceFlags ?? [];
    if (final.varianceMinor !== 0 && flags.includes('value_unknown')) because.push('value_unknown');
    else if (final.varianceMinor !== 0 && final.recountOf === undefined && final.valueMinor >= plan.recountThresholdMinor) because.push('over_recount_threshold');
    const movedAfter = plan.openedAt === undefined ? [] : moves.filter((m) => m.productId === productId && frozen.has(m.kind) && !own.has(m.movementId)
      && m.occurredAt >= (plan.openedAt as string) && m.occurredAt >= countedAt);
    if (movedAfter.length > 0) because.push('moved_during_freeze');
    if (onHandAsOf(moves, productId, countedAt, own) !== final.expectedMinor) because.push('expected_changed');
    const cause = causeOf.get(final.countId) ?? null;
    const state: LineState = because.length > 0 ? 'recount_required'
      : final.varianceMinor === 0 ? 'matched'
        : cause === null ? 'cause_required' : 'ready';
    return { ...base, state, finalCountId: final.countId, recountBecause: because, frozenMovements: movedAfter, cause, varianceMinor: final.varianceMinor, valueMinor: final.valueMinor };
  });
}

/** Every frozen-kind movement that landed at the place for a planned product while the plan was open — the plan's exceptions. */
export function freezeBreaches(plan: CountPlan, moves: readonly PlaceMovement[], ownIds: ReadonlySet<string>): readonly PlaceMovement[] {
  if (plan.openedAt === undefined) return [];
  const frozen = new Set<string>(plan.frozenKinds);
  const scope = new Set(plan.productIds);
  const until = plan.approvedAt ?? plan.cancelledAt;
  return moves.filter((m) => scope.has(m.productId) && frozen.has(m.kind) && !ownIds.has(m.movementId)
    && m.occurredAt >= (plan.openedAt as string) && (until === undefined || m.occurredAt <= until));
}

/**
 * Is a movement of this kind, at this place, for this product, frozen by an open plan right now? The plain movements route
 * asks before it appends (the freeze's refusal); answers the plan that freezes it, or undefined.
 */
export async function frozenBy(deps: Pick<CountPlanDeps, 'plans'>, tenantId: string, locationId: string, productId: string, kind: string): Promise<CountPlan | undefined> {
  return (await deps.plans(tenantId)).find((p) => p.state === 'counting' && p.locationId === locationId && p.productIds.includes(productId) && (p.frozenKinds as readonly string[]).includes(kind));
}

/** A planned count as it arrives — from a screen (direct) or relayed from a device through the box. */
export interface PlannedCountInput {
  readonly planId: string;
  readonly countId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly uom: string;
  readonly countedMinor: number;
  readonly counterId: string;
  readonly countedAt: string;
  readonly recountOf: string | null;
  readonly counterFlags: readonly CountFlag[];
  readonly relayed?: { readonly relayedBy: string; readonly source: string; readonly storeId: string | null };
}

export type PlannedCountOutcome =
  | { readonly ok: true; readonly record: StoredReconciliation; readonly alreadyRecorded: boolean }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly detail: string };

/**
 * Record one blind count under a plan — the ONE path the screen and the relayed device count take. Refused by name: an
 * unknown plan, a plan not open for counting, a place or product outside the plan, a second first-count of a product
 * (a recount names the count it recounts), a recount of something that is not the count standing for that product.
 * The expected figure is head office's as of `countedAt`; every variance is held for the plan.
 */
export async function recordPlannedCount(deps: CountPlanDeps, tenantId: string, c: PlannedCountInput): Promise<PlannedCountOutcome> {
  if (await deps.countExists(tenantId, c.countId)) {
    const prior = await deps.reconciliation(tenantId, c.countId);
    if (prior !== undefined && prior.planId === c.planId) return { ok: true, record: prior, alreadyRecorded: true };
    return { ok: false, status: 409, code: 'count_already_reconciled', detail: `Count ${c.countId} is already on file — a count id is used once.` };
  }
  const plan = await deps.plan(tenantId, c.planId);
  if (plan === undefined) return { ok: false, status: 404, code: 'count_plan_unknown', detail: `No count plan ${c.planId} is on file here.` };
  if (plan.state !== 'counting') return { ok: false, status: 409, code: 'count_plan_not_open', detail: `Count plan ${c.planId} is ${plan.state}; counts are taken only while it is open for counting.` };
  if (plan.locationId !== c.locationId) return { ok: false, status: 422, code: 'not_this_plans_place', detail: `Count plan ${c.planId} counts ${plan.locationId}, not ${c.locationId}.` };
  if (!plan.productIds.includes(c.productId)) return { ok: false, status: 422, code: 'not_in_this_plan', detail: `${c.productId} is not on count plan ${c.planId}.` };
  const counts = await deps.planCounts(tenantId, c.planId);
  const recounted = new Set(counts.map((x) => x.recountOf).filter((x): x is string => x !== undefined));
  const standing = counts.filter((x) => x.productId === c.productId && !recounted.has(x.countId));
  const current = standing[standing.length - 1];
  if (c.recountOf === null && current !== undefined) {
    return { ok: false, status: 409, code: 'already_counted_in_this_plan', detail: `${c.productId} was already counted in this plan (count ${current.countId}); a second count is a RECOUNT of it.` };
  }
  if (c.recountOf !== null && (current === undefined || current.countId !== c.recountOf)) {
    return { ok: false, status: 409, code: 'not_the_standing_count', detail: `Count ${c.recountOf} is not the count standing for ${c.productId} in this plan${current === undefined ? '' : ` (that is ${current.countId})`}.` };
  }
  const moves = await deps.movementsAt(tenantId, plan.locationId, [c.productId]);
  const own = new Set(counts.map((x) => `count:${x.countId}`));
  const expectedBase = onHandAsOf(moves, c.productId, c.countedAt, own);
  let rec: StoredReconciliation;
  try {
    rec = await reconcileBlindCount(deps, tenantId, {
      countId: c.countId, productId: c.productId, locationId: c.locationId, binId: null, uom: c.uom,
      countedMinor: c.countedMinor, reasonCode: c.recountOf === null ? 'planned_count' : 'planned_recount', counterId: c.counterId,
      counterFlags: c.counterFlags, ...(c.relayed === undefined ? {} : { relayed: c.relayed }),
      planned: { planId: c.planId, recountOf: c.recountOf, countedAt: c.countedAt, expectedBase },
    });
  } catch (e) {
    if (e instanceof InvalidCountError) return { ok: false, status: 400, code: 'invalid_count', detail: e.message };
    throw e;
  }
  await deps.recordReconciliation(tenantId, rec);
  return { ok: true, record: rec, alreadyRecorded: false };
}

/** What the counter's sheet shows: the products and whether each still needs counting — never an expected figure. */
const sheetOf = (plan: CountPlan, lines: readonly PlanLine[]) => ({
  planId: plan.planId, locationId: plan.locationId, state: plan.state, frozenKinds: plan.frozenKinds,
  lines: lines.map((l) => ({
    productId: l.productId,
    toDo: l.state === 'not_counted' ? 'count' : l.state === 'recount_required' ? 'recount' : 'done',
    recountOf: l.state === 'recount_required' ? l.finalCountId : null,
  })),
});

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction = 'Nothing was changed.') =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

export function countPlanRoutes(deps: CountPlanDeps): readonly Route[] {
  const load = async (ctx: RequestContext): Promise<CountPlan> => {
    const planId = (ctx.params['planId'] ?? '').trim();
    const plan = await deps.plan(ctx.tenantId, planId);
    if (plan === undefined) throw refuse(404, 'count_plan_unknown', `No count plan ${planId} is on file here.`);
    await assertLocationInScope(ctx, plan.locationId, deps.locationBranches);
    return plan;
  };
  const positionOf = async (tenantId: string, plan: CountPlan) => {
    const [counts, causes, moves] = await Promise.all([deps.planCounts(tenantId, plan.planId), deps.causes(tenantId, plan.planId), deps.movementsAt(tenantId, plan.locationId, plan.productIds)]);
    const lines = planPosition(plan, counts, causes, moves);
    const breaches = freezeBreaches(plan, moves, new Set(counts.map((c) => `count:${c.countId}`)));
    return { counts, lines, breaches };
  };
  const audit = async (ctx: RequestContext, action: string, plan: CountPlan, after: Record<string, string>, reason: string) => {
    await deps.recordAudit?.(ctx.tenantId, {
      actorId: ctx.userId, action, objectType: 'count_plan', objectId: plan.planId, at: deps.now(),
      origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { state: plan.state }, after, reason, correlationId: plan.planId,
    });
  };

  return [
    {
      // PLAN: the place, the products, what is frozen while counting, and the recount threshold — the planner's choices.
      api: 'API-04', method: 'POST', path: '/v1/inventory/count-plans/:planId',
      permission: 'inventory.count.plan', idempotent: true,
      handler: async (ctx) => {
        const planId = (ctx.params['planId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const products = b['productIds'];
        const kinds = b['frozenKinds'];
        if (planId === '' || !isStr(b['locationId']) || !Array.isArray(products) || products.length === 0 || !products.every(isStr)
          || !Array.isArray(kinds) || !kinds.every(isStr) || !isNonNegInt(b['recountThresholdMinor'])) {
          throw refuse(400, 'not_readable_as_a_count_plan', 'A count plan needs a locationId, the productIds to count (at least one), frozenKinds (the movement kinds stopped while counting — an empty list freezes nothing, said on the plan) and a whole recountThresholdMinor.', 'Send the plan. Nothing was recorded.');
        }
        const never = (kinds as string[]).filter((k) => NEVER_FROZEN.includes(k));
        if (never.length > 0) {
          throw refuse(422, 'till_sales_are_never_frozen', `A count never stops the till: ${never.join(', ')} cannot be frozen (the till keeps selling with no network, hard rule #1). Sales during the count are judged by the time they happened.`, 'Remove the till kinds from frozenKinds. Nothing was recorded.');
        }
        const unknownKinds = (kinds as string[]).filter((k) => !(FREEZABLE_KINDS as readonly string[]).includes(k));
        if (unknownKinds.length > 0) throw refuse(400, 'not_a_freezable_kind', `Not a movement kind a count can freeze: ${unknownKinds.join(', ')}. Freezable: ${FREEZABLE_KINDS.join(', ')}.`, 'Nothing was recorded.');
        await assertLocationInScope(ctx, b['locationId'], deps.locationBranches);
        const existing = await deps.plan(ctx.tenantId, planId);
        if (existing !== undefined) throw refuse(409, 'count_plan_exists', `Count plan ${planId} is already on file (${existing.state}); a new count is a new plan id.`);
        const plan: CountPlan = {
          planId, locationId: b['locationId'].trim(), productIds: [...new Set((products as string[]).map((p) => p.trim()))],
          frozenKinds: [...new Set(kinds as FreezableKind[])], recountThresholdMinor: b['recountThresholdMinor'],
          note: isStr(b['note']) ? b['note'].trim() : null, plannedBy: ctx.userId, plannedAt: deps.now(), state: 'planned',
        };
        await deps.recordPlan(ctx.tenantId, plan, 'created');
        await audit(ctx, 'count.plan.create', { ...plan, state: 'planned' }, { state: 'planned', locationId: plan.locationId, products: String(plan.productIds.length), frozenKinds: plan.frozenKinds.join(','), recountThresholdMinor: String(plan.recountThresholdMinor) }, plan.note ?? 'count planned');
        return { status: 201, body: { plan, freezesNothing: plan.frozenKinds.length === 0 } };
      },
    },
    {
      // OPEN: counting starts and the freeze with it.
      api: 'API-04', method: 'POST', path: '/v1/inventory/count-plans/:planId/open',
      permission: 'inventory.count.plan', idempotent: true,
      handler: async (ctx) => {
        const plan = await load(ctx);
        if (plan.state === 'counting') return { status: 200, body: { plan, alreadyOpen: true } };
        if (plan.state !== 'planned') throw refuse(409, 'count_plan_not_planned', `Count plan ${plan.planId} is ${plan.state}; only a planned count can be opened.`);
        const clash = (await deps.plans(ctx.tenantId)).find((p) => p.state === 'counting' && p.locationId === plan.locationId && p.productIds.some((x) => plan.productIds.includes(x)));
        if (clash !== undefined) throw refuse(409, 'another_count_is_open_here', `Count plan ${clash.planId} is already counting some of these products at ${plan.locationId}; one count of a shelf at a time.`, 'Approve or cancel that plan first. Nothing was changed.');
        const opened: CountPlan = { ...plan, state: 'counting', openedBy: ctx.userId, openedAt: deps.now() };
        await deps.recordPlan(ctx.tenantId, opened, 'opened');
        await audit(ctx, 'count.plan.open', plan, { state: 'counting', openedAt: opened.openedAt ?? '' }, 'count opened; freeze started');
        return { status: 200, body: { plan: opened, alreadyOpen: false } };
      },
    },
    {
      // BLIND COUNT on a screen (the device path is the relayed StockCounted carrying the plan id).
      api: 'API-04', method: 'POST', path: '/v1/inventory/count-plans/:planId/counts/:countId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const planId = (ctx.params['planId'] ?? '').trim();
        const countId = (ctx.params['countId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['expectedMinor'] !== undefined || b['valuePerUnitMinor'] !== undefined || b['approvedBy'] !== undefined) {
          throw refuse(400, 'count_carries_caller_claims', 'A count carries only what the counter saw — never an expected figure, a value or an approver.', 'Send productId, locationId, uom, countedMinor (and recountOf for a recount). Nothing was recorded.');
        }
        if (countId === '' || !isStr(b['productId']) || !isStr(b['locationId']) || !isStr(b['uom']) || !isNonNegInt(b['countedMinor'])
          || (b['recountOf'] !== undefined && b['recountOf'] !== null && !isStr(b['recountOf']))) {
          throw refuse(400, 'not_readable_as_a_count', 'A planned count needs a productId, locationId, uom and a whole countedMinor (and recountOf naming the count it recounts, for a recount).', 'Send the blind count. Nothing was recorded.');
        }
        await assertLocationInScope(ctx, b['locationId'], deps.locationBranches);
        const out = await recordPlannedCount(deps, ctx.tenantId, {
          planId, countId, productId: b['productId'], locationId: b['locationId'], uom: b['uom'], countedMinor: b['countedMinor'],
          counterId: ctx.userId, countedAt: deps.now(), recountOf: isStr(b['recountOf']) ? b['recountOf'] : null, counterFlags: [],
        });
        if (!out.ok) throw refuse(out.status, out.code, out.detail, 'Nothing was recorded.');
        if (!out.alreadyRecorded) {
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'count.record', objectType: 'stock_count', objectId: countId, at: out.record.at,
            origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
            after: { planId, productId: out.record.productId, countedMinor: String(out.record.countedMinor), varianceMinor: String(out.record.varianceMinor), valueMinor: String(out.record.valueMinor), recountOf: out.record.recountOf ?? '' },
            reason: out.record.reasonCode, correlationId: planId,
          });
        }
        // The counter hears that it was recorded — and NOT what was expected (blind until the count is closed).
        return { status: out.alreadyRecorded ? 200 : 201, body: { planId, countId, recorded: true, alreadyRecorded: out.alreadyRecorded } };
      },
    },
    {
      // CAUSE: a manager names why a variance happened (from the fixed list) — the root cause the approval and the books carry.
      api: 'API-04', method: 'POST', path: '/v1/inventory/count-plans/:planId/counts/:countId/cause',
      permission: 'inventory.count.plan', idempotent: true,
      handler: async (ctx) => {
        const plan = await load(ctx);
        const countId = (ctx.params['countId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isAdjustmentReason(b['causeCode']) || !isStr(b['note'])) {
          throw refuse(400, 'not_readable_as_a_variance_cause', `A cause needs a causeCode from the list (${ADJUSTMENT_REASON_CODES.join(', ')}) and a note a person can read later.`);
        }
        if (plan.state !== 'counting') throw refuse(409, 'count_plan_not_open', `Count plan ${plan.planId} is ${plan.state}; causes are set while it is open.`);
        const rec = (await deps.planCounts(ctx.tenantId, plan.planId)).find((c) => c.countId === countId);
        if (rec === undefined) throw refuse(404, 'count_unknown', `Count ${countId} is not a count of plan ${plan.planId}.`);
        if (rec.varianceMinor === 0) throw refuse(409, 'no_variance_to_explain', `Count ${countId} matched head office's figure; there is nothing to explain.`);
        const cause: VarianceCause = { planId: plan.planId, countId, causeCode: b['causeCode'], note: b['note'].trim(), setBy: ctx.userId, setAt: deps.now() };
        await deps.recordCause(ctx.tenantId, cause);
        await audit(ctx, 'count.variance.cause', plan, { countId, causeCode: cause.causeCode, varianceMinor: String(rec.varianceMinor) }, cause.note);
        return { status: 201, body: { cause } };
      },
    },
    {
      // APPROVAL: one act, by a person who counted none of the variances they approve; every final variance posts once.
      api: 'API-04', method: 'POST', path: '/v1/inventory/count-plans/:planId/approve',
      permission: 'inventory.adjustment.approve', idempotent: true,
      handler: async (ctx) => {
        const plan = await load(ctx);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) throw refuse(400, 'not_readable_as_a_count_approval', 'An approval needs a reason — the audit line a person reads later.');
        if (plan.state === 'approved') return { status: 200, body: { plan, alreadyApproved: true } };
        if (plan.state !== 'counting') throw refuse(409, 'count_plan_not_open', `Count plan ${plan.planId} is ${plan.state}; only an open count can be approved.`);
        const { counts, lines } = await positionOf(ctx.tenantId, plan);
        const waiting = lines.filter((l) => l.state === 'not_counted' || l.state === 'recount_required' || l.state === 'cause_required');
        if (waiting.length > 0) {
          throw refuse(409, 'count_not_ready_to_approve', `Not every line is ready: ${waiting.map((l) => `${l.productId} ${l.state}${l.recountBecause.length > 0 ? ` (${l.recountBecause.join(', ')})` : ''}`).join('; ')}.`, 'Finish the counts, recounts and causes first. Nothing was posted.');
        }
        const ready = lines.filter((l) => l.state === 'ready');
        const finals = new Map(counts.map((c) => [c.countId, c] as const));
        const own = ready.filter((l) => finals.get(l.finalCountId as string)?.counterId === ctx.userId);
        if (own.length > 0) {
          throw refuse(422, 'self_approval', `${ctx.userId} counted ${own.map((l) => l.productId).join(', ')} and cannot approve their own variance (§28).`, 'A different person with approval authority approves. Nothing was posted.');
        }
        // Every final variance posts ONE compensating movement through the count register's own decide step.
        const posted: { countId: string; productId: string; varianceMinor: number; valueMinor: number; movementId: string | null; causeCode: string }[] = [];
        for (const l of ready) {
          const out = await decideCount(deps, {
            tenantId: ctx.tenantId, countId: l.finalCountId as string, decidedBy: ctx.userId, decision: 'approved',
            reason: `count plan ${plan.planId}: ${l.cause?.causeCode ?? ''} — ${l.cause?.note ?? ''}; ${b['reason'].trim()}`, branchId: ctx.branchId ?? null, via: 'direct',
          });
          if (!out.ok) throw refuse(409, out.refusedBecause, out.detail, 'Some lines may have posted; approve again to finish — a posted line is never posted twice.');
          posted.push({ countId: l.finalCountId as string, productId: l.productId, varianceMinor: l.varianceMinor, valueMinor: l.valueMinor, movementId: out.record.movementId ?? null, causeCode: l.cause?.causeCode ?? '' });
        }
        // Every count a recount superseded is closed as superseded — recorded, never posted (hard rule #2).
        const finalIds = new Set(lines.map((l) => l.finalCountId));
        const at = deps.now();
        for (const c of counts) {
          if (finalIds.has(c.countId) || c.pendingApproval !== true) continue;
          const by = counts.find((x) => x.recountOf === c.countId)?.countId ?? 'a recount';
          await deps.recordDecision(ctx.tenantId, { ...c, adjusted: false, pendingApproval: false, approvedBy: null, decision: 'rejected', decidedAt: at, decisionReason: `superseded by recount ${by} in count plan ${plan.planId}`, movementId: null });
        }
        const approved: CountPlan = { ...plan, state: 'approved', approvedBy: ctx.userId, approvedAt: at, approvalReason: b['reason'].trim() };
        await deps.recordPlan(ctx.tenantId, approved, 'approved');
        const lossMinor = posted.filter((p) => p.varianceMinor < 0).reduce((s, p) => s + p.valueMinor, 0);
        const gainMinor = posted.filter((p) => p.varianceMinor > 0).reduce((s, p) => s + p.valueMinor, 0);
        await audit(ctx, 'count.plan.approve', plan, { state: 'approved', posted: String(posted.length), lossMinor: String(lossMinor), gainMinor: String(gainMinor) }, approved.approvalReason ?? '');
        return { status: 200, body: { plan: approved, posted, lossMinor, gainMinor, alreadyApproved: false } };
      },
    },
    {
      // CANCEL: the count is abandoned — the freeze lifts, nothing posts, every held count stays on file as counted.
      api: 'API-04', method: 'POST', path: '/v1/inventory/count-plans/:planId/cancel',
      permission: 'inventory.count.plan', idempotent: true,
      handler: async (ctx) => {
        const plan = await load(ctx);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) throw refuse(400, 'not_readable_as_a_cancellation', 'Cancelling a count needs a reason.');
        if (plan.state === 'cancelled') return { status: 200, body: { plan, alreadyCancelled: true } };
        if (plan.state === 'approved') throw refuse(409, 'count_plan_already_approved', `Count plan ${plan.planId} was approved; its corrections stand (a correction to them is a new count).`);
        const cancelled: CountPlan = { ...plan, state: 'cancelled', cancelledBy: ctx.userId, cancelledAt: deps.now(), cancelReason: b['reason'].trim() };
        await deps.recordPlan(ctx.tenantId, cancelled, 'cancelled');
        await audit(ctx, 'count.plan.cancel', plan, { state: 'cancelled' }, cancelled.cancelReason ?? '');
        return { status: 200, body: { plan: cancelled, alreadyCancelled: false } };
      },
    },
    {
      // The manager's view: every line with its expected figure, variance, value, recount reasons, cause; the freeze breaches.
      api: 'API-04', method: 'GET', path: '/v1/inventory/count-plans/:planId',
      permission: 'inventory.count.plan',
      handler: async (ctx) => {
        const plan = await load(ctx);
        const { lines, breaches } = await positionOf(ctx.tenantId, plan);
        const finals = lines.filter((l) => l.state === 'ready' || l.state === 'cause_required' || l.state === 'recount_required');
        return {
          status: 200,
          body: {
            plan, lines, freezeBreaches: breaches,
            totals: {
              products: lines.length, counted: lines.filter((l) => l.state !== 'not_counted').length,
              recountRequired: lines.filter((l) => l.state === 'recount_required').length, causeRequired: lines.filter((l) => l.state === 'cause_required').length,
              lossMinor: finals.filter((l) => l.varianceMinor < 0).reduce((s, l) => s + l.valueMinor, 0),
              gainMinor: finals.filter((l) => l.varianceMinor > 0).reduce((s, l) => s + l.valueMinor, 0),
            },
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // The COUNTER's sheet: what to count or recount — never what head office expects (blind).
      api: 'API-04', method: 'GET', path: '/v1/inventory/count-plans/:planId/sheet',
      permission: 'inventory.movement.append',
      handler: async (ctx) => {
        const plan = await load(ctx);
        const { lines } = await positionOf(ctx.tenantId, plan);
        return { status: 200, body: { ...sheetOf(plan, lines), asAt: deps.now() } };
      },
    },
    {
      // Every plan (newest first) with its state — the counts board.
      api: 'API-04', method: 'GET', path: '/v1/inventory/count-plans',
      permission: 'inventory.count.plan',
      handler: async (ctx) => {
        const all = [...(await deps.plans(ctx.tenantId))].reverse();
        const filter = await stockReadScope(ctx, deps.locationBranches);
        const visible = all.filter((p) => filter.covers(p.locationId));
        return { status: 200, body: { plans: visible, asAt: deps.now() } };
      },
    },
  ];
}

/** Read the relayed count's plan fields (a device count carrying `planId`), or undefined when it is not a planned count. */
export function readPlannedFields(body: unknown): { readonly planId: string; readonly recountOf: string | null } | undefined | 'unreadable' {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (b['planId'] === undefined || b['planId'] === null) return undefined;
  if (!isStr(b['planId']) || (b['recountOf'] !== undefined && b['recountOf'] !== null && !isStr(b['recountOf']))) return 'unreadable';
  return { planId: b['planId'].trim(), recountOf: isStr(b['recountOf']) ? b['recountOf'].trim() : null };
}
