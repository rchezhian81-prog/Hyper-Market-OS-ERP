// CR-01 OI-12 step 6b (OB-760 A · P-05 · hard rules 2, 5, 10 · §28): a rule's approval PLACES the act through its ORDINARY
// route, at once, in the name of the rule and the two people who set its limit.
//
// This file lives in the composition layer (services/api), never in services/ai: the assistant only drafts, the rule only
// decides (packages/ai/src/auto-approve.ts), and this placer is the one place a decided act reaches a domain route. It does
// that the way a person's request does — through the very route a person would call, found in the finished API surface at
// the moment of placing (so every wrapper the surface adds still speaks), with that route's own checks: an approved supplier,
// the price guard (MRP ceiling, margin floor, the second-person size rule), stock and open-to-buy.
//
//   • A DEDICATED NON-HUMAN IDENTITY, `rule:auto-approve`, places the act. It holds ONLY the permissions those routes need
//     (`AUTO_APPROVE_RULE_ROLE`) — never a refund, payment, privilege or any other permission — and may call ONLY the routes
//     on `RULE_ROUTES`. It is not on the role catalogue, so no person can ever be given it on Users & roles.
//   • A PURCHASE ORDER is raised by `rule:auto-approve` and issued by the RULE itself (`rule:<ruleId>`): the rule's approval
//     stands in for the second signature, and the two people who set the limit are named in the issue reason. The route's own
//     OB-290 authority check reads, for the rule (and only while this placer is placing), exactly the limit the two people set.
//   • A REFUSAL is never retried and never partly applied: the route's reason is recorded and the draft waits for a person.
//     (A purchase order the route raised but would not issue stays RAISED, never issued — said by name, for a person to issue
//     or leave.) A placement, or a refusal, is recorded ONCE per draft (one key per draft), so a draft is placed at most once.
//
// Append-only. Synthetic data only in tests (tests/unit/ai-auto-approve-executor.test.ts, tests/integration/cr01-oi12-*).

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { ApiError, type Route, type RequestContext } from '../../kernel/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import type { DraftAct } from '../../../packages/ai/src/index';
import { authorityFrom, type Authority } from '../../../packages/approvals/src/authority-rules';
import type { AutoApprovedDecision, PlaceResult } from '../../ai/src/auto-approve';
import { STREAM, streamName } from './adapters';

/** The rule's own identity: it places the act. Never a person, never an assistant. */
export const RULE_IDENTITY = 'rule:auto-approve';

/**
 * Everything the rule identity may do — exactly the permissions of the routes it places through, and nothing else.
 * Pinned by tests/guardrails/the-auto-approve-rule-holds-only-the-permissions-of-its-three-routes.test.ts.
 */
export const AUTO_APPROVE_RULE_ROLE = Object.freeze({
  id: 'auto_approve_rule',
  name: 'The auto-approve rule (not a person)',
  permissions: Object.freeze([
    'purchase.order.propose', // POST /v1/purchase/orders/:poId
    'purchase.order.approve', // POST /v1/purchase/orders/:poId/approval
    'price.change.propose', //   POST /v1/prices/changes
    'inventory.movement.append', // POST /v1/warehouse/transfers/:transferId (a proposal only: dispatch and receipt are people)
  ] as const),
});

/** The only routes the rule identity may ever call. */
export const RULE_ROUTES = Object.freeze([
  Object.freeze({ method: 'POST', path: '/v1/purchase/orders/:poId' }),
  Object.freeze({ method: 'POST', path: '/v1/purchase/orders/:poId/approval' }),
  Object.freeze({ method: 'POST', path: '/v1/prices/changes' }),
  Object.freeze({ method: 'POST', path: '/v1/warehouse/transfers/:transferId' }),
] as const);

/** What the rule is acting under while it places (read only by `ruleAwareAuthority`, never from a request). */
interface Acting { readonly tenantId: string; readonly identities: readonly string[]; readonly ruleVersion: number; readonly poLimitMinor?: number }
const acting = new AsyncLocalStorage<Acting>();

/**
 * Is `userId` the auto-approve rule, placing an act for `tenantId` right now? Only inside a placement this placer started —
 * never because a request or a token says so. The shop's role-scope checks (which suppliers, categories and places a role
 * reaches, fg4-buying-adapters.ts) read the rule as shop-wide ONLY then: the owner's limit is set for the whole shop.
 */
export function isTheRulePlacing(tenantId: string, userId: string): boolean {
  const a = acting.getStore();
  return a !== undefined && a.tenantId === tenantId && a.identities.includes(userId);
}

/**
 * The PO routes' OB-290 authority, aware of the rule: while — and only while — this placer is placing a reorder, the rule's
 * identities have exactly the purchase-order limit the two people set (the rule is the approver; its authority is its limit).
 * A token that merely CALLS itself `rule:…` is never inside a placement, so it gets the ordinary answer (no role → not set).
 */
export function ruleAwareAuthority<F extends (tenantId: string, userId: string, subjectType: string) => Promise<Authority> | Authority>(base: F | undefined): F | undefined {
  if (base === undefined) return undefined;
  return (async (tenantId: string, userId: string, subjectType: string) => {
    const a = acting.getStore();
    if (a !== undefined && a.poLimitMinor !== undefined && a.tenantId === tenantId && a.identities.includes(userId)) {
      return authorityFrom({
        limits: { byRole: { [AUTO_APPROVE_RULE_ROLE.id]: { purchase_order: a.poLimitMinor } } } as never,
        rulesVersion: a.ruleVersion, userId, roleIds: [AUTO_APPROVE_RULE_ROLE.id], subjectType,
      });
    }
    return base(tenantId, userId, subjectType);
  }) as F;
}

const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 20);
const placementsStream = (): string => streamName(STREAM.ai, 'auto-approve-placements');

/** One placement fact per draft — placed or refused, never both, never twice. */
export interface PlacementRecord {
  readonly proposalId: string;
  readonly kind: string;
  readonly result: PlaceResult;
  readonly ruleId: string;
  readonly ruleSetBy: { readonly askedBy: string; readonly confirmedBy: string };
  readonly at: string;
}

export async function placements(store: EventStore, tenantId: string): Promise<readonly PlacementRecord[]> {
  const rows: PersistedEvent[] = [
    ...await store.readStream(tenantId, placementsStream(), { type: 'AIAutoApprovedActPlaced' }),
    ...await store.readStream(tenantId, placementsStream(), { type: 'AIAutoApprovedActRefused' }),
  ];
  return rows.map((e) => e.event.payload as PlacementRecord);
}

/** The deterministic reference the act is placed under — the same draft always names the same order or transfer. */
export const referenceFor = (proposalId: string, prefix: 'po-auto' | 'tr-auto'): string => `${prefix}-${digest(proposalId)}`;

type Called = { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly code: string; readonly reason: string };

export interface PlacerDeps {
  readonly store: EventStore;
  readonly now: () => string;
  /** The finished API surface, read at the moment of placing (so every wrapper on a route still applies). */
  readonly routes: () => readonly Route[];
}

const inFlight = new Map<string, Promise<PlaceResult>>();

/** Build the placer the sweep is given (`AutoApproveDeps.place`). */
export function autoApprovePlacer(deps: PlacerDeps): (tenantId: string, decision: AutoApprovedDecision, act: DraftAct) => Promise<PlaceResult> {
  return (tenantId, decision, act) => {
    // One placement at a time per draft in this process; the record below holds it across processes and restarts.
    const key = `${tenantId}\u0000${decision.proposalId}`;
    const running = inFlight.get(key);
    if (running !== undefined) return running;
    const p = placeRecorded(deps, tenantId, decision, act).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  };
}

async function placeRecorded(deps: PlacerDeps, tenantId: string, decision: AutoApprovedDecision, act: DraftAct): Promise<PlaceResult> {
  const before = (await placements(deps.store, tenantId)).find((r) => r.proposalId === decision.proposalId);
  if (before !== undefined) return before.result; // placed (or refused) once already — never again
  const result = await acting.run({ tenantId, identities: [RULE_IDENTITY, decision.approvedBy], ruleVersion: decision.ruleVersion }, () => placeThroughRoute(deps, tenantId, decision, act));
  const record: PlacementRecord = { proposalId: decision.proposalId, kind: act.kind, result, ruleId: decision.ruleId, ruleSetBy: decision.ruleSetBy, at: deps.now() };
  const d = digest(`${tenantId}-placement-${decision.proposalId}`);
  const stored = await deps.store.append(tenantId, placementsStream(), makeEvent({
    id: `ai-placement-${d}`, type: result.placed ? 'AIAutoApprovedActPlaced' : 'AIAutoApprovedActRefused', occurredAt: record.at,
    idempotencyKey: `ai-placement-${tenantId}-${d}`, source: 'api/ai-auto-approve', payload: record,
  }));
  // A concurrent placer (another process) that recorded first wins: its record is the one that stands.
  return (stored.record.event.payload as PlacementRecord).result;
}

function ruleWords(decision: AutoApprovedDecision): string {
  return `Approved by rule ${decision.ruleId} (limit set by ${decision.ruleSetBy.askedBy}, confirmed by ${decision.ruleSetBy.confirmedBy}; CR-01 OI-12, OB-760); drafted by ${decision.draftedBy}.`;
}

/** Call ONE allowed route as the rule. Every refusal comes back as the route's own code and words. */
async function call(deps: PlacerDeps, tenantId: string, method: 'POST', path: string, params: Record<string, string>, userId: string, body: unknown, idempotencyKey: string): Promise<Called> {
  if (!RULE_ROUTES.some((r) => r.method === method && r.path === path)) {
    return { ok: false, code: 'not_a_rule_route', reason: `${method} ${path} is not one of the routes the rule may call.` };
  }
  const route = deps.routes().find((r) => r.method === method && r.path === path);
  if (route === undefined) return { ok: false, code: 'route_not_wired', reason: `${method} ${path} is not wired on head office.` };
  if (!(AUTO_APPROVE_RULE_ROLE.permissions as readonly string[]).includes(route.permission)) {
    return { ok: false, code: 'rule_lacks_permission', reason: `${method} ${path} needs ${route.permission}, which the rule does not hold.` };
  }
  if (route.reauth !== undefined) {
    return { ok: false, code: 'needs_a_person_to_sign_in_again', reason: `${method} ${path} needs a fresh sign-in, which only a person can give.` };
  }
  const ctx: RequestContext = {
    tenantId, userId, branchId: null, scope: 'all', params, query: {}, body, idempotencyKey,
    traceId: `rule-${digest(idempotencyKey)}`,
  };
  try {
    const r = await route.handler(ctx);
    if (r.status >= 300) {
      const e = (r.body as { error?: { code?: string; whatHappened?: string } } | undefined)?.error;
      return { ok: false, code: e?.code ?? `status_${r.status}`, reason: e?.whatHappened ?? `${method} ${path} answered ${r.status}.` };
    }
    return { ok: true, body: (r.body ?? {}) as Record<string, unknown> };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, code: err.body.code, reason: err.body.whatHappened };
    // Not a refusal the route meant — still never retried silently: a person decides, and the words are kept.
    return { ok: false, code: 'route_failed', reason: `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function placeThroughRoute(deps: PlacerDeps, tenantId: string, decision: AutoApprovedDecision, act: DraftAct): Promise<PlaceResult> {
  const key = (step: string): string => `auto-approve-${step}-${digest(`${tenantId}-${decision.proposalId}`)}`;
  switch (act.kind) {
    case 'reorder_from_approved_supplier': {
      const route = 'POST /v1/purchase/orders/:poId';
      if (act.deliverToLocationId === undefined || act.lines.some((l) => l.unitCostMinor === undefined)) {
        return { placed: false, route, code: 'act_not_exact', reason: 'The draft does not say where to deliver or at what price, so the order cannot be raised exactly.' };
      }
      const poId = referenceFor(decision.proposalId, 'po-auto');
      // The rule's two identities act ONLY inside this placement, under the limit the two people set.
      return acting.run({ tenantId, identities: [RULE_IDENTITY, decision.approvedBy], poLimitMinor: decision.limit, ruleVersion: decision.ruleVersion }, async () => {
        const raised = await call(deps, tenantId, 'POST', '/v1/purchase/orders/:poId', { poId }, RULE_IDENTITY, {
          supplierId: act.supplierId, deliverToLocationId: act.deliverToLocationId,
          lines: act.lines.map((l) => ({ productId: l.productId, orderedQty: l.qty, unitCost: { minor: l.unitCostMinor!, currency: 'INR' } })),
        }, key('po'));
        if (!raised.ok) return { placed: false, route, code: raised.code, reason: raised.reason };
        const order = raised.body['order'] as { totalMinor?: number; status?: string } | undefined;
        if (order?.status === 'issued') return { placed: true, route, reference: poId, by: RULE_IDENTITY, detail: `purchase order ${poId} was already issued.` };
        // The order's value as the ROUTE worked it out must be the value the rule measured — never more.
        if (typeof order?.totalMinor === 'number' && order.totalMinor > decision.measured) {
          return { placed: false, route, code: 'value_moved', reason: `The order came to ${order.totalMinor} paise at the route, above the ${decision.measured} the rule measured; it was raised as ${poId} but not issued.`, reference: poId };
        }
        const approvalRoute = 'POST /v1/purchase/orders/:poId/approval';
        const issued = await call(deps, tenantId, 'POST', '/v1/purchase/orders/:poId/approval', { poId }, decision.approvedBy, { reason: ruleWords(decision) }, key('po-issue'));
        if (!issued.ok) {
          return { placed: false, route: approvalRoute, code: issued.code, reason: `${issued.reason} Purchase order ${poId} was raised but NOT issued — a person can issue it on the Buying page, or leave it.`, reference: poId };
        }
        return { placed: true, route: `${route} + /approval`, reference: poId, by: `${RULE_IDENTITY} (raised), ${decision.approvedBy} (issued)`, detail: `purchase order ${poId} raised and issued to ${act.supplierId}.` };
      });
    }
    case 'markdown_short_dated': {
      const route = 'POST /v1/prices/changes';
      if (act.newPriceMinor === undefined || act.mrpMinor === undefined || act.costMinor === undefined) {
        return { placed: false, route, code: 'act_not_exact', reason: 'The draft does not carry the new price, the MRP and the cost, so the price change cannot be made exactly.' };
      }
      const r = await call(deps, tenantId, 'POST', '/v1/prices/changes', {}, RULE_IDENTITY, {
        productId: act.productId, priceMinor: act.newPriceMinor, currency: 'INR', mrpMinor: act.mrpMinor, costMinor: act.costMinor,
        ...(act.storeId === undefined ? {} : { storeId: act.storeId }),
      }, key('price'));
      if (!r.ok) return { placed: false, route, code: r.code, reason: r.reason };
      return { placed: true, route, reference: `price-${act.productId}`, by: RULE_IDENTITY, detail: `${act.productId} priced ${act.newPriceMinor} paise (${act.percentOffBps / 100}% off ${act.currentPriceMinor ?? '?'}).` };
    }
    case 'stock_transfer': {
      const route = 'POST /v1/warehouse/transfers/:transferId';
      if (act.uom === undefined) return { placed: false, route, code: 'act_not_exact', reason: 'The draft does not say the unit, so the transfer cannot be raised exactly.' };
      const transferId = referenceFor(decision.proposalId, 'tr-auto');
      const r = await call(deps, tenantId, 'POST', '/v1/warehouse/transfers/:transferId', { transferId }, RULE_IDENTITY, {
        fromLocationId: act.fromLocationId, toLocationId: act.toLocationId, lines: [{ productId: act.productId, quantityMinor: act.qty, uom: act.uom }],
      }, key('transfer'));
      if (!r.ok && r.code !== 'transfer_already_exists') return { placed: false, route, code: r.code, reason: r.reason };
      return { placed: true, route, reference: transferId, by: RULE_IDENTITY, detail: `transfer ${transferId} raised: ${act.qty} of ${act.productId} from ${act.fromLocationId} to ${act.toLocationId} — a person dispatches it and another receives it (§28).` };
    }
    default:
      return { placed: false, route: 'none', code: 'not_an_auto_approvable_kind', reason: 'The rule places only a reorder, a markdown or a transfer.' };
  }
}
