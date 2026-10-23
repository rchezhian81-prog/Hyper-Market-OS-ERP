// OB-288 lane 1 · P1 — identity, authority and configuration governance (M01-FR-01/02/03 · M02-FR-01/02/03 · SEC-03 ·
// §28 · §35 · owner decisions OB-290, OB-291, OB-292 of 23 Oct 2026). Head office's wiring for:
//
//   1. MONEY LIMITS ON THE SERVER (OB-290) — `authorityOf(tenant, user, subjectType)` reads the owner's versioned limits
//      table. Every decide path reads it: the delegation decide/effective-authority/grant routes (a limit in the body is
//      ignored — the audit's bug), the maker-checker engine (a request above the checker's limit is routed to the owner),
//      the store's relayed decisions (an over-limit approval is flagged and not applied), the head-office refund approval,
//      and the count and adjustment decisions.
//   2. ESCALATION BY AGE (OB-292) — `approvalAgeSweep` on the ops-alert worker's timer.
//   3. PRICE-CHANGE SIZE (OB-291) — a price change of more than the set percentage or amount needs a second person.
//   4. GOVERNED CONFIGURATION (M01-FR-02/03) — switch changes carry a reason, are versioned, previewed and rolled back in one
//      step; high-impact switches and settings need the owner's approval; org structure changes are owner-approved.
//   5. DEPARTMENT SCOPE (M02-FR-02) — a role limited to departments; the assortment, count and adjustment routes refuse
//      and filter by it; a department-filtered sales report.
//   6. ACCESS REVIEW and the permission-matrix export.
//
// Composition: `p1IdentitySurface(surface, …)` is the one line in `main.ts`. It re-builds the identity routes it governs
// with the server-held authority wired in, wraps the others in place (same path, same permission), and adds the new
// routes. A target route that is missing throws at start-up: a control that silently guards nothing is the failure P-08
// forbids.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { DurableTenantSettings } from '../../../packages/tenant/src/durable-settings';
import { AccessControl, type RoleAssignment } from '../../../packages/rbac/src/rbac';
import { makeEvent } from '../../../packages/contracts/src/event';
import { resolvePrice, type PriceEntry } from '../../../packages/price-list/src/price-list';
import { departmentOfCategory, withinDepartmentScope } from '../../../packages/org/src/departments';
import { limitedSubjectOf, mayApproveValue, authorityWords, priceChangeSize, type Authority } from '../../../packages/approvals/src/authority-rules';
import { setupItem, validateSetupAnswer } from '../../../packages/tenant/src/setup';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';
import type { IncomingSale } from '../../pos/src/index';
import type { PersonSignIn } from '../../identity/src/people';
import { delegationRoutes } from '../../identity/src/delegation';
import { approvalDecisionRoutes, type ApprovalDecisionRecord, type AppliedDecision } from '../../identity/src/approval-decisions';
import { approvalRequestRoutes, type ApprovalEscalationView } from '../../identity/src/approval-requests';
import { authorityRulesRoutes, authorityOfPort, escalationWaitsOf, priceCheckOf, RULE_CONFIG_KEYS, type AuthorityRulesStore, type AuthorityOf } from '../../identity/src/authority-limits';
import { approvalEscalationRoutes, sweepAgedApprovals, type ApprovalEscalation, type ApprovalEscalationDeps, type PendingApproval } from '../../identity/src/approval-escalation';
import { accessReviewRoutes } from '../../identity/src/access-review';
import { departmentScopeRoutes, departmentScopeFor, foldDepartmentScopes, type DepartmentScopeRecord } from '../../identity/src/department-scope';
import { MACHINE_ROLE_IDS, isPlatformAdministrationRole } from '../../identity/src/separation-of-duties';
import { orgStructureRoutes } from '../../platform/src/org-structure';
import { orgDepartmentRoutes, currentLinks, type DepartmentLinkRecord, type DepartmentSaleLine } from '../../platform/src/org-departments';
import { governedFlagRoutes, governSetupWrite, governConfigRollback, type GovernedFlagChange } from '../../platform/src/governed-config';
import {
  STREAM, streamName, effectiveGrants, rolesHeldNow, liveEmergencyRoles, peopleAdapter, emergencyAccessAdapter,
  delegationAdapter, approvalDecisionAdapter, approvalRequestsAdapter, orgStructureAdapter, purchaseOrdersAdapter,
  adjustmentRequestAdapter, countsAdapter, productMasterAdapter, categoryRegisterAdapter, alertLifecycleAdapter,
} from './adapters';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from './roles';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
type Base = { readonly store: EventStore; readonly now: () => string; readonly settings: DurableTenantSettings };

const ESCALATIONS_STREAM = streamName(STREAM.identity, 'approval-escalations');
const DEPARTMENT_SCOPES_STREAM = streamName(STREAM.identity, 'department-scopes');
const DEPARTMENT_LINKS_STREAM = streamName(STREAM.org, 'department-categories');
/** The id of the owner alert an age escalation raises — one per request. */
export const APPROVAL_AGE_ALERT_PREFIX = 'approval-age:';

const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);

// ── the server-held authority (OB-290) ─────────────────────────────────────────────────────────────────────────────

export function rulesStoreOf(input: Base): AuthorityRulesStore {
  return {
    versions: input.settings.configVersions,
    roleIds: () => ROLE_CATALOGUE.map((r) => r.id),
    rolesOf: (tenantId, userId) => rolesHeldNow(input.store, tenantId, userId, input.now()),
  };
}

/** THE port for the PO value limit (handed to procure-to-pay): a person's money authority for a kind, from the server. */
export function authorityOfAdapter(input: Base): AuthorityOf {
  return authorityOfPort(rulesStoreOf(input));
}

// ── department scope (M02-FR-02) ───────────────────────────────────────────────────────────────────────────────────

const departmentScopeRecords = (store: EventStore, tenantId: string) => payloads<DepartmentScopeRecord>(store, tenantId, DEPARTMENT_SCOPES_STREAM, 'DepartmentScopeSet');

/** Live grants with their department scope — the effective grants, each limited where a record says so. */
export async function grantsWithDepartments(store: EventStore, tenantId: string): Promise<readonly RoleAssignment[]> {
  const scopes = foldDepartmentScopes(await departmentScopeRecords(store, tenantId));
  return (await effectiveGrants(store, tenantId)).map((g) => {
    const d = departmentScopeFor(scopes, g.userId, g.roleId);
    return d === 'all' ? g : { ...g, departmentScope: d };
  });
}

/** Which departments a person may act in with a permission — the RBAC engine's answer from the scoped grants. */
export async function departmentScopeOf(store: EventStore, tenantId: string, userId: string, permission: string): Promise<readonly string[] | 'all'> {
  return new AccessControl(ROLE_CATALOGUE, await grantsWithDepartments(store, tenantId)).departmentScopeOf(userId, permission);
}

/** product → department, through its primary category and the departments' categories. */
async function departmentResolver(input: Pick<Base, 'store' | 'now'>, tenantId: string): Promise<(productId: string) => string | undefined> {
  const [links, categories, products] = await Promise.all([
    payloads<DepartmentLinkRecord>(input.store, tenantId, DEPARTMENT_LINKS_STREAM, 'DepartmentCategoriesSet'),
    categoryRegisterAdapter(input).categories(tenantId),
    productMasterAdapter(input).products(tenantId),
  ]);
  const live = currentLinks(links);
  const parent = new Map(categories.map((c) => [c.categoryId, c.parentId] as const));
  const cat = new Map(products.map((p) => [p.productId, p.primaryCategoryId] as const));
  return (productId) => departmentOfCategory(live, (c) => parent.get(c) ?? null, cat.get(productId) ?? null);
}

const outsideDepartment = (productId: string, departmentId: string | undefined): Error => apiError(403, {
  code: 'outside_your_department_scope',
  whatHappened: departmentId === undefined
    ? `Product ${productId} belongs to no department, and this account's role reaches only some departments.`
    : `Product ${productId} is in department "${departmentId}", which this account's role does not reach.`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Work within the departments your role covers, or ask someone whose role covers this one. Nothing was changed.',
});

// ── the shared-surface helpers ─────────────────────────────────────────────────────────────────────────────────────

function indexOf(surface: readonly Route[], method: string, path: string): number {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`P1 identity wiring cannot find ${method} ${path} — the control it adds would silently not happen`);
  return at;
}
function replace(surface: Route[], method: string, path: string, change: (r: Route) => Route): void {
  const at = indexOf(surface, method, path);
  surface[at] = change(surface[at]!);
}
/** Swap every route of `fresh` into the surface at its own path (the same paths and permissions, now with the deps wired). */
function swapIn(surface: Route[], fresh: readonly Route[]): void {
  for (const r of fresh) replace(surface, r.method, r.path, (old) => ({ ...r, permission: old.permission }));
}
const wrap = (surface: Route[], method: string, path: string, around: (inner: Route['handler']) => Route['handler']): void =>
  replace(surface, method, path, (r) => ({ ...r, handler: around(r.handler) }));

const bodyOf = (ctx: RequestContext): Record<string, unknown> => (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body as Record<string, unknown> : {});
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const overLimit = (who: string, valueMinor: number, a: Authority): Error => apiError(422, {
  code: 'exceeds_your_limit',
  whatHappened: `This is for ₹${(valueMinor / 100).toFixed(2)}; ${who}'s ${a.limitedAs?.replace('_', ' ') ?? 'approval'} limit is ${authorityWords(a)}. A decision above a person's limit goes to the owner (OB-290).`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'The owner decides it. Nothing was approved.',
});

// ── escalation by age (OB-292) ─────────────────────────────────────────────────────────────────────────────────────

const escalations = (store: EventStore, tenantId: string) => payloads<ApprovalEscalation>(store, tenantId, ESCALATIONS_STREAM, 'ApprovalEscalated');

export function escalationDeps(input: Base): ApprovalEscalationDeps {
  const { store, now } = input;
  const ownersOf = async (tenantId: string) => [...new Set((await effectiveGrants(store, tenantId)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
  return {
    pending: async (tenantId) => {
      const out: PendingApproval[] = [];
      for (const s of await approvalRequestsAdapter({ store, now }).allRequests(tenantId)) {
        const limitedAs = limitedSubjectOf(s.request.kind);
        if (s.decision !== undefined || limitedAs === undefined) continue;
        out.push({ requestId: s.request.requestId, source: 'approval_engine', kind: s.request.kind, limitedAs, requestedAt: s.request.requestedAt, requestedBy: s.request.requestedBy, valueMinor: s.request.valueMinor, summary: s.request.summary });
      }
      for (const po of await purchaseOrdersAdapter({ store, now }).all(tenantId)) {
        if (po.status !== 'proposed') continue;
        out.push({ requestId: `po:${po.poId}`, source: 'purchase_order', kind: 'purchase_order', limitedAs: 'purchase_order', requestedAt: po.at, requestedBy: po.requisitionedBy, valueMinor: po.totalMinor, summary: `Purchase order ${po.number} to ${po.supplierId}` });
      }
      for (const r of await adjustmentRequestAdapter({ store, now }).requests(tenantId)) {
        if (r.status !== 'pending') continue;
        out.push({ requestId: `adj:${r.requestId}`, source: 'approval_engine', kind: 'stock_adjustment', limitedAs: 'stock_adjustment', requestedAt: r.at, requestedBy: r.requestedBy, valueMinor: r.valueMinor, summary: `Stock adjustment of ${r.productId} at ${r.locationId}` });
      }
      return out;
    },
    waits: async (tenantId) => { const w = await escalationWaitsOf(rulesStoreOf(input), tenantId); return { value: w.value, version: w.version }; },
    escalations: (tenantId) => escalations(store, tenantId),
    recordEscalation: async (tenantId, e) => {
      const [r] = await store.appendBatch(tenantId, [{ stream: ESCALATIONS_STREAM, event: makeEvent({
        id: `approval-escalated-${e.requestId}`, type: 'ApprovalEscalated', occurredAt: e.escalatedAt,
        idempotencyKey: `approval-escalated-${tenantId}-${e.requestId}`, source: 'api/approvals', payload: e as unknown as Record<string, unknown>,
      }) }]);
      return r !== undefined && !r.deduped;
    },
    tellOwners: async (tenantId, e) => {
      const owners = await ownersOf(tenantId);
      if (owners.length === 0) return false;
      const alertId = `${APPROVAL_AGE_ALERT_PREFIX}${e.requestId}`;
      const hours = (m: number) => (m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`);
      const event: AlertLifecycleEvent = {
        alertId, change: 'raised', by: 'system:approval-age', at: e.escalatedAt,
        alert: {
          alertId, component: `Approval waiting: ${e.summary}`, status: 'degraded', ownerUserId: owners[0]!, ownerName: owners[0]!,
          detail: `${e.summary}${e.valueMinor === null ? '' : ` (₹${(e.valueMinor / 100).toFixed(2)})`}, asked by ${e.requestedBy}, has waited ${hours(e.waitedMinutes)} — longer than the ${hours(e.waitMinutes)} allowed for a ${e.limitedAs.replace('_', ' ')}. It has come to you to decide.`,
          raisedAt: e.escalatedAt, ackDueBy: e.escalatedAt,
          ...(owners.length > 1 ? { alsoToUserIds: owners.slice(1) } : {}),
        },
      };
      await alertLifecycleAdapter({ store, now }).recordAlertEvent(tenantId, event, `${alertId}|raised`);
      return true;
    },
    clearDecided: async (tenantId, e, at) => {
      const lifecycle = alertLifecycleAdapter({ store, now });
      const alertId = `${APPROVAL_AGE_ALERT_PREFIX}${e.requestId}`;
      const current = (await lifecycle.alerts(tenantId)).find((a) => a.alert.alertId === alertId);
      if (current === undefined || current.state === 'cleared') return false;
      await lifecycle.recordAlertEvent(tenantId, { alertId, change: 'cleared', by: 'system:approval-age', at, detail: 'the approval has been decided' }, `${alertId}|cleared`);
      return true;
    },
  };
}

/** The ops-alert worker's sweep (one line in ops-alert-sweeps.ts): how many approvals it newly escalated to the owner. */
export function approvalAgeSweep(input: Base): (tenantId: string, at: string) => Promise<number> {
  const deps = escalationDeps(input);
  return async (tenantId, at) => (await sweepAgedApprovals(deps, tenantId, at)).escalated.length;
}

// ── the surface ────────────────────────────────────────────────────────────────────────────────────────────────────

export function p1IdentitySurface(surface: Route[], input: {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly settings: DurableTenantSettings;
  readonly recordAudit?: Recorder;
  readonly applyDecision?: (tenantId: string, record: ApprovalDecisionRecord) => Promise<AppliedDecision>;
  readonly tillSealKey?: Buffer;
}): void {
  const { store, now, settings } = input;
  if (store === undefined) return; // a bare composition has nothing to govern and no store to read the rules from
  const base: Base = { store, now, settings };
  const authorityOf = authorityOfAdapter(base);
  const approvals = approvalRequestsAdapter({ store, now });
  const audit = input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit };
  const escalationView = async (tenantId: string): Promise<ReadonlyMap<string, ApprovalEscalationView>> =>
    new Map((await escalations(store, tenantId)).map((e) => [e.requestId, { escalatedAt: e.escalatedAt, waitedMinutes: e.waitedMinutes, waitMinutes: e.waitMinutes, escalatedTo: 'owner' as const }]));

  // 1. The identity routes that decide, rebuilt with the server-held authority (same paths, same permissions).
  swapIn(surface, delegationRoutes({ ...delegationAdapter({ store, now }), authorityOf }));
  swapIn(surface, approvalDecisionRoutes({
    ...approvalDecisionAdapter({ store, now }), ...audit, authorityOf,
    ...(input.applyDecision === undefined ? {} : { applyDecision: input.applyDecision }),
    ...(input.tillSealKey === undefined ? {} : { tillSealKey: input.tillSealKey }),
  }));
  swapIn(surface, approvalRequestRoutes({ ...approvals, authorityOf, escalations: escalationView }));
  // M01-FR-01: the org structure, with the owner's approval on every structural change.
  swapIn(surface, orgStructureRoutes({ ...orgStructureAdapter({ store, now }), approvals }));

  // 2. Head office's own refund approval (ADR-0022) and the count / adjustment decisions: never above the approver's limit;
  //    and the count and adjustment routes within a department-limited person's departments.
  wrap(surface, 'POST', '/v1/pos/refund-approvals', (inner) => async (ctx) => {
    const b = bodyOf(ctx);
    if (typeof b['valueMinor'] === 'number' && typeof b['kind'] === 'string' && limitedSubjectOf(b['kind']) !== undefined) {
      const a = await authorityOf(ctx.tenantId, ctx.userId, b['kind']);
      if (!mayApproveValue(a, b['valueMinor'])) throw overLimit(ctx.userId, b['valueMinor'], a);
    }
    return inner(ctx);
  });
  const departmentGuard = async (ctx: RequestContext, permission: string, productIds: readonly string[]): Promise<void> => {
    const scope = await departmentScopeOf(store, ctx.tenantId, ctx.userId, permission);
    if (scope === 'all') return;
    const dept = await departmentResolver({ store, now }, ctx.tenantId);
    for (const p of productIds) if (!withinDepartmentScope(scope, dept(p))) throw outsideDepartment(p, dept(p));
  };
  wrap(surface, 'POST', '/v1/inventory/counts/:countId/decide', (inner) => async (ctx) => {
    const rec = await countsAdapter({ store, now }).reconciliation(ctx.tenantId, (ctx.params['countId'] ?? '').trim());
    if (rec !== undefined) {
      await departmentGuard(ctx, 'inventory.adjustment.approve', [rec.productId]);
      if (bodyOf(ctx)['decision'] === 'approved') {
        const a = await authorityOf(ctx.tenantId, ctx.userId, 'stock_adjustment');
        if (!mayApproveValue(a, Math.abs(rec.valueMinor))) throw overLimit(ctx.userId, Math.abs(rec.valueMinor), a);
      }
    }
    return inner(ctx);
  });
  wrap(surface, 'POST', '/v1/inventory/adjustment-requests/:requestId/decide', (inner) => async (ctx) => {
    const rec = await adjustmentRequestAdapter({ store, now }).request(ctx.tenantId, (ctx.params['requestId'] ?? '').trim());
    if (rec !== undefined) {
      await departmentGuard(ctx, 'inventory.adjustment.approve', [rec.productId]);
      if (bodyOf(ctx)['decision'] === 'approved') {
        const a = await authorityOf(ctx.tenantId, ctx.userId, 'stock_adjustment');
        if (!mayApproveValue(a, Math.abs(rec.valueMinor))) throw overLimit(ctx.userId, Math.abs(rec.valueMinor), a);
      }
    }
    return inner(ctx);
  });
  wrap(surface, 'POST', '/v1/inventory/counts/:countId', (inner) => async (ctx) => {
    const p = bodyOf(ctx)['productId'];
    if (isStr(p)) await departmentGuard(ctx, 'inventory.movement.append', [p.trim()]);
    return inner(ctx);
  });
  wrap(surface, 'GET', '/v1/inventory/counts', (inner) => async (ctx) => {
    const p = ctx.query['productId'];
    if (isStr(p)) await departmentGuard(ctx, 'inventory.availability.read', [p.trim()]);
    return inner(ctx);
  });
  for (const action of ['list', 'drop'] as const) {
    wrap(surface, 'POST', `/v1/merchandising/assortment/:storeId/:productId/${action}`, (inner) => async (ctx) => {
      await departmentGuard(ctx, 'merchandising.range.manage', [(ctx.params['productId'] ?? '').trim()]);
      return inner(ctx);
    });
  }
  // Reads narrowed, never refused: a department-limited reader sees their departments' rows, and is told how many others exist.
  const narrowRead = (path: string, permission: string, field: 'listed' | 'requests', productOf: (row: unknown) => string) =>
    wrap(surface, 'GET', path, (inner) => async (ctx): Promise<HandlerResult> => {
      const out = await inner(ctx);
      const scope = await departmentScopeOf(store, ctx.tenantId, ctx.userId, permission);
      if (scope === 'all' || out.status !== 200) return out;
      const b = out.body as Record<string, unknown>;
      const rows = Array.isArray(b[field]) ? b[field] as unknown[] : [];
      const dept = await departmentResolver({ store, now }, ctx.tenantId);
      const kept = rows.filter((r) => withinDepartmentScope(scope, dept(productOf(r))));
      return { ...out, body: { ...b, [field]: kept, count: kept.length, outsideYourDepartments: rows.length - kept.length, departmentScope: scope } };
    });
  narrowRead('/v1/merchandising/assortment/:storeId', 'merchandising.range.read', 'listed', (r) => String(r));
  narrowRead('/v1/inventory/adjustment-requests', 'inventory.availability.read', 'requests', (r) => String((r as { productId?: unknown }).productId ?? ''));

  // 3. OB-291: a price change larger than the set size needs a second person (the margin floor is judged as before).
  wrap(surface, 'POST', '/v1/prices/changes', (inner) => async (ctx) => {
    const b = bodyOf(ctx);
    if (isStr(b['approvalId']) || !isStr(b['productId']) || typeof b['priceMinor'] !== 'number' || !Number.isSafeInteger(b['priceMinor'])) return inner(ctx);
    const productId = b['productId'].trim();
    const entries = await payloads<PriceEntry>(store, ctx.tenantId, streamName(STREAM.pricing, 'list', productId), 'PriceListEntryPublished');
    const at = now();
    const stores = isStr(b['storeId']) ? [b['storeId'].trim()] : [...new Set(entries.filter((e) => e.scope === 'store').map((e) => e.scopeRef))].sort();
    const t = (await priceCheckOf(rulesStoreOf(base), ctx.tenantId)).value;
    for (const storeId of stores) {
      const current = resolvePrice(entries, { productId, at, storeId });
      if (current === null) continue; // a first price is not a change; the margin floor still judges it
      const size = priceChangeSize(current.price.minor, b['priceMinor'], t);
      if (size.needsSecondPerson) {
        throw apiError(422, {
          code: 'price_change_needs_second_person',
          whatHappened: `${productId} at ${storeId} would move from ₹${(current.price.minor / 100).toFixed(2)} to ₹${((b['priceMinor'] as number) / 100).toFixed(2)} — a change of ₹${(size.changeMinor / 100).toFixed(2)} (${(size.changeBps / 100).toFixed(2)}%), more than the ${(t.percentBps / 100).toFixed(2)}% or ₹${(t.amountMinor / 100).toFixed(2)} a single person may make (OB-291).`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Ask for approval (POST /v1/approvals/requests, kind price_change, with exactly this change); once someone who may approve prices approves it, send the approvalId. Nothing was changed.',
        });
      }
    }
    return inner(ctx);
  });

  // 4. Governed configuration: switches (reason, version, preview, rollback, owner approval when high-impact); high-impact
  //    settings; and the approval rules' keys kept off the generic rollback.
  const flagChanges = async (tenantId: string) => payloads<GovernedFlagChange>(store, tenantId, STREAM.platform, 'FeatureFlagSet');
  const flags = governedFlagRoutes({
    flagChanges, approvals, ...audit, now,
    recordFlagChange: async (tenantId, change) => {
      await store.append(tenantId, STREAM.platform, makeEvent({
        id: `flag-${tenantId}-${change.key}-v${change.version ?? 0}-${change.changedAt}`, type: 'FeatureFlagSet', occurredAt: change.changedAt,
        idempotencyKey: `flag-${tenantId}-${change.key}-${change.changedAt}`, source: 'api/platform', payload: change as unknown as Record<string, unknown>,
      }));
    },
  });
  replace(surface, 'PUT', '/v1/platform/flags/:key', (old) => ({ ...flags.find((r) => r.method === 'PUT')!, permission: old.permission }));
  surface.push(...flags.filter((r) => r.method !== 'PUT'));
  wrap(surface, 'PUT', '/v1/platform/setup/:key', (inner) => governSetupWrite(inner, {
    approvals, now,
    validate: (key, value) => {
      const item = setupItem(key);
      if (item === undefined) return 'unknown';
      try { validateSetupAnswer(item, value); return undefined; } catch (e) { return e instanceof Error ? e.message : 'invalid'; }
    },
  }));
  wrap(surface, 'POST', '/v1/platform/config/:key/rollback', (inner) => governConfigRollback(inner, { approvals, now, ruleKeys: RULE_CONFIG_KEYS }));

  // 5. The new routes.
  const rules = rulesStoreOf(base);
  surface.push(
    ...authorityRulesRoutes({ ...rules, approvals, ...audit, now }),
    ...approvalEscalationRoutes({ ...escalationDeps(base), now }),
    ...accessReviewRoutes({
      now, authorityOf, roles: () => ROLE_CATALOGUE, machineRoleIds: MACHINE_ROLE_IDS,
      isItRole: (roleId) => { const r = ROLE_CATALOGUE.find((x) => x.id === roleId); return r !== undefined && isPlatformAdministrationRole(r); },
      people: async (tenantId) => (await peopleAdapter({ store, now }).people(tenantId)).map((p: PersonSignIn) => ({ userId: p.userId, username: p.username, displayName: p.displayName, state: p.state, secondFactor: p.secondFactor })),
      grants: (tenantId) => grantsWithDepartments(store, tenantId),
      emergency: async (tenantId) => {
        const at = now();
        return (await emergencyAccessAdapter({ store, now }).grants(tenantId)).filter((g) => (g.revokedAt ?? null) === null && Date.parse(g.expiresAt) > Date.parse(at))
          .map((g) => ({ userId: g.userId, roleId: g.roleId, expiresAt: g.expiresAt, approvedBy: g.approvedBy }));
      },
    }),
    ...departmentScopeRoutes({
      approvals, ...audit, now,
      records: (tenantId) => departmentScopeRecords(store, tenantId),
      recordScope: async (tenantId, r) => {
        await store.append(tenantId, DEPARTMENT_SCOPES_STREAM, makeEvent({
          id: `department-scope-${r.userId}-${r.roleId}-${r.approvalId}`, type: 'DepartmentScopeSet', occurredAt: r.at,
          idempotencyKey: `department-scope-${tenantId}-${r.approvalId}`, source: 'api/identity', payload: r as unknown as Record<string, unknown>,
        }));
      },
      holdsRole: async (tenantId, userId, roleId) => (await effectiveGrants(store, tenantId)).some((g) => g.userId === userId && g.roleId === roleId)
        || (await liveEmergencyRoles(store, tenantId, userId, now())).includes(roleId),
      departmentIds: async (tenantId) => (await orgStructureAdapter({ store, now }).nodes(tenantId)).filter((n) => n.kind === 'department' && n.status !== 'closed').map((n) => n.nodeId),
    }),
    ...orgDepartmentRoutes({
      approvals, ...audit, now,
      nodes: async (tenantId) => orgStructureAdapter({ store, now }).nodes(tenantId),
      links: (tenantId) => payloads<DepartmentLinkRecord>(store, tenantId, DEPARTMENT_LINKS_STREAM, 'DepartmentCategoriesSet'),
      recordLink: async (tenantId, link) => {
        await store.append(tenantId, DEPARTMENT_LINKS_STREAM, makeEvent({
          id: `department-categories-${link.departmentId}-${link.approvalId}`, type: 'DepartmentCategoriesSet', occurredAt: link.at,
          idempotencyKey: `department-categories-${tenantId}-${link.approvalId}`, source: 'api/org', payload: link as unknown as Record<string, unknown>,
        }));
      },
      categories: async (tenantId) => new Map((await categoryRegisterAdapter({ store, now }).categories(tenantId)).map((c) => [c.categoryId, c.parentId] as const)),
      productCategories: async (tenantId) => new Map((await productMasterAdapter({ store, now }).products(tenantId)).map((p) => [p.productId, p.primaryCategoryId] as const)),
      productNames: async (tenantId) => new Map((await productMasterAdapter({ store, now }).products(tenantId)).map((p) => [p.productId, p.name] as const)),
      saleLines: async (tenantId, day) => (await payloads<IncomingSale>(store, tenantId, STREAM.sales, 'SaleCommitted'))
        .filter((s) => s.tradingDay === day)
        .flatMap((s): DepartmentSaleLine[] => s.lines.map((l) => ({ saleId: s.saleId, locationId: s.locationId ?? '', tradingDay: s.tradingDay, productId: l.productId, quantityMinor: l.quantityMinor, lineTotalMinor: l.lineTotalMinor }))),
      departmentScopeOf: (tenantId, userId, permission) => departmentScopeOf(store, tenantId, userId, permission),
    }),
  );
}
