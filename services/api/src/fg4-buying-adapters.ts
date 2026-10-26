// FG-4 (final-gap builders, 26 Oct 2026) — head office's wiring for five buying and authority gaps. Kept in its own file:
// the shared main.ts carries one registration line for the surface and one for the sweep.
//
//   1. Contract-expiry alerts (M04-FR-04 · M06-FR-03): the owner's warning window ("not set" until he enters it), the
//      list of what is due, and the ops-alert worker's sweep that raises an expired display or supplier contract — and,
//      once the window is set, an expiring one — into every owner's alert inbox, clearing it on renewal.
//   2. Purchase-price variance (D03-FR-05): each goods-receipt line's cost as received against the purchase order's price
//      and the contract (blanket agreement) price on the day — per product and per receipt, with the lines behind each.
//   3. Free samples (A12 (1) · OB-386): a "free sample" stock issue; the GST credit given back is worked out from the buying
//      cost and placed in the next GST return as a free-sample ITC reversal, for the accountant to check.
//   4. Authorization scopes (M02-FR-02 · SEC-03 · §28): the department scope reaches markdown proposals and store tasks; a
//      supplier / category scope for the person who buys (requisitions, quotes, blanket agreements, purchase orders); a
//      location scope inside a branch for those who receive, count and move stock (goods receipts, counts, bins, bin moves,
//      transfers). Each derived on the server from the person's grants and refused by name.
//   5. Vendor-managed inventory (D03-FR-04): the buyer sets each of a supplier's items' minimum and maximum at a store; the
//      supplier sees only those items (on hand, on order, room) and proposes a replenishment inside them; a buyer accepts it
//      into a purchase-order PROPOSAL (a second person still issues it) or rejects it with a reason.
//
// One entry point, `fg4BuyingSurface(surface, input)`, ADDS this package's routes (and wraps the routes it governs in
// place, same path, same permission); `contractExpirySweep(input)` is the line on the ops-alert worker. Every register here
// is append-only on its own stream (hard rules #2, #6). Nothing here is committed by an AI (hard rule #5).

import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Route } from '../../kernel/src/index';
import { apiError, branchInScope } from '../../kernel/src/index';
import { tradingDayIn, type TradingCalendar } from '../../../packages/calendar/src/index';
import { SETTINGS } from '../../../packages/tenant/src/index';
import type { TenantSetting } from '../../../packages/tenant/src/settings';
import {
  contractExpiryAlerts, staleAlertIds, readWarningDays, type ExpiringContract,
} from '../../../packages/purchasing/src/contract-expiry';
import { priceVariance, type PpvReceipt, type PpvOrder, type PpvAgreement } from '../../../packages/purchasing/src/price-variance';
import { shiftDate } from '../../../packages/calendar/src/index';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import {
  STREAM, streamName, spacePerformanceAdapter, supplierScorecardAdapter, alertLifecycleAdapter, goodsReceiptAdapter, foldPurchaseOrders,
  orgStructureAdapter,
} from './adapters';
import { finBridgeRaiseToOwners } from './finance-bridge-adapters';
import { foldBlanketAgreements } from './p3-procure-adapters';
import { freeSampleRoutes, FREE_SAMPLE_REASON, type FreeSampleIssue, type FreeSampleCheck } from '../../inventory/src/free-samples';
import { frozenBy as countPlanFreezing } from '../../inventory/src/count-plans';
import type { PurchaseTaxLine } from '../../../packages/input-tax/src/free-sample-itc';
import { lockedGstr3bPeriods } from './r3-gst-adapters';
import { itcStoreAdapter } from './r3-tax-pay-adapters';
import { inventoryAdapter, writeOffAdapter, liveSupplierInvoices, countPlansAdapter } from './adapters';
import type { RequestContext, HandlerResult } from '../../kernel/src/index';
import {
  roleScopeRoutes, foldRoleScopes, roleScopeOf, withinTreeScope, type RoleScopeRecord, type RoleScopeDimension,
} from '../../identity/src/department-scope';
import { departmentOfCategory, withinDepartmentScope } from '../../../packages/org/src/departments';
import { currentLinks, type DepartmentLinkRecord } from '../../platform/src/org-departments';
import { departmentScopeOf, DEPARTMENT_LINKS_STREAM } from './p1-identity-adapters';
import { ROLE_CATALOGUE } from './roles';
import {
  effectiveGrants, liveEmergencyRoles, approvalRequestsAdapter, categoryRegisterAdapter, productMasterAdapter, supplierMasterAdapter,
  rosterStoreAdapter, warehouseAdapter, transfersAdapter, supplierPortalAdapter,
} from './adapters';
import { vmiRoutes, type VmiProposal, type VmiDecision } from '../../purchase/src/vmi';
import type { VmiLimit } from '../../../packages/purchasing/src/vmi';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
/** The one thing this file reads from tenant settings: a setting's value in force (the shop's calendar). */
export interface SettingsReader { value<T>(tenantId: string, setting: TenantSetting<T>): Promise<T> }

export interface Fg4BuyingInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly settings?: SettingsReader;
  readonly recordAudit?: Recorder;
}
interface Base { readonly store: EventStore; readonly now: () => string; readonly settings?: SettingsReader; readonly recordAudit?: Recorder }

export const FG4_STREAMS = Object.freeze({
  contractExpiryWindow: streamName(STREAM.purchase, 'contract-expiry-window'),
  freeSamples: streamName(STREAM.inventory, 'free-samples'),
  freeSampleChecks: streamName(STREAM.finance, 'free-sample-itc-checks'),
  roleScopes: streamName(STREAM.identity, 'role-scopes'),
  vmiLimits: streamName(STREAM.purchase, 'vmi-limits'),
  vmiProposals: streamName(STREAM.purchase, 'vmi-proposals'),
  vmiDecisions: streamName(STREAM.purchase, 'vmi-decisions'),
});

const payloads = async <T>(store: EventStore, tenantId: string, stream: string, type: string): Promise<T[]> =>
  (await store.readStream(tenantId, stream, { type })).map((e) => e.event.payload as T);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const bodyOf = (b: unknown): Record<string, unknown> => (b !== null && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});

/** The shop's trading day for an instant — its own calendar when settings are wired, the defaults otherwise. */
async function shopDay(input: Pick<Base, 'settings'>, tenantId: string, at: string): Promise<string> {
  const calendar: TradingCalendar = input.settings === undefined
    ? { timeZone: SETTINGS.STORE_TIME_ZONE.defaultValue, tradingDayCutoff: SETTINGS.TRADING_DAY_CUTOFF.defaultValue }
    : { timeZone: await input.settings.value(tenantId, SETTINGS.STORE_TIME_ZONE), tradingDayCutoff: await input.settings.value(tenantId, SETTINGS.TRADING_DAY_CUTOFF) };
  return tradingDayIn(at, calendar);
}

// ── 1. contract-expiry alerts (M04-FR-04 · M06-FR-03) ────────────────────────────────────────────────────────────

/** One append-only fact: the owner's warning window set (or cleared — `days: null`). The latest stands. */
export interface ContractExpiryWindow {
  readonly days: number | null;
  readonly setBy: string;
  readonly setAt: string;
  readonly reason?: string;
}

const NOT_SET_WORDS = 'Not set. Only contracts that have already ended are raised until you enter how many days ahead to be told.';

async function expiryWindow(store: EventStore, tenantId: string): Promise<ContractExpiryWindow | undefined> {
  return (await payloads<ContractExpiryWindow>(store, tenantId, FG4_STREAMS.contractExpiryWindow, 'ContractExpiryWindowSet')).at(-1);
}

/** Both registers, read into the one shape the engine judges. */
async function contractsOf(input: Base, tenantId: string): Promise<readonly ExpiringContract[]> {
  const [display, buying] = await Promise.all([
    spacePerformanceAdapter({ store: input.store, now: input.now }).contracts(tenantId),
    supplierScorecardAdapter({ store: input.store, now: input.now }).allContracts(tenantId),
  ]);
  return [
    ...display.map((c): ExpiringContract => ({
      register: 'display', contractId: c.contractId, supplierId: c.supplierId, endsOn: c.endsOn,
      approved: c.approvedBy !== undefined && c.approvedBy.trim() !== '', what: `${c.description} at ${c.storeId}`,
    })),
    ...buying.map((c): ExpiringContract => ({
      register: 'supplier', contractId: c.contractId, supplierId: c.supplierId, endsOn: c.endsOn,
      approved: c.approvedBy !== undefined && c.approvedBy.trim() !== '',
    })),
  ];
}

async function dueToday(input: Base, tenantId: string, at: string) {
  const window = await expiryWindow(input.store, tenantId);
  const today = await shopDay(input, tenantId, at);
  return { window, today, due: contractExpiryAlerts({ contracts: await contractsOf(input, tenantId), today, warnDays: window?.days ?? null }) };
}

/**
 * The ops-alert worker's pass (one line in ops-alert-sweeps.ts): raises each due contract alert to every owner — once
 * while it is open — and clears the open ones a renewal (or a changed window) made stale. Answers how many it raised.
 */
export function contractExpirySweep(raw: Omit<Fg4BuyingInput, 'store'> & { readonly store: EventStore }): (tenantId: string, at: string) => Promise<number> {
  const input: Base = raw;
  return async (tenantId, at) => {
    const { due } = await dueToday(input, tenantId, at);
    let raised = 0;
    for (const a of due) {
      const component = a.register === 'display' ? `Display contract ${a.contractId}` : `Supplier contract ${a.contractId}`;
      if (await finBridgeRaiseToOwners(input.store, input.now, tenantId, a.alertId, component, a.detail, 'system:contract-expiry', at, a.alertId)) raised += 1;
    }
    const lifecycle = alertLifecycleAdapter({ store: input.store, now: input.now });
    const open = (await lifecycle.alerts(tenantId)).filter((x) => x.state !== 'cleared').map((x) => x.alert.alertId);
    for (const id of staleAlertIds({ openAlertIds: open, due })) {
      await lifecycle.recordAlertEvent(tenantId, { alertId: id, change: 'cleared', by: 'system:contract-expiry', at, detail: 'the contract was renewed, or is no longer due' }, `${id}|cleared|${at}`);
    }
    return raised;
  };
}

function contractExpiryRoutes(input: Base): Route[] {
  return [
    {
      // What the sweep would raise today, and the owner's warning window ("not set" until he enters it).
      api: 'API-10', method: 'GET', path: '/v1/reporting/contract-expiry-alerts',
      permission: 'owner.alert.read',
      handler: async (ctx) => {
        const { window, today, due } = await dueToday(input, ctx.tenantId, input.now());
        return {
          status: 200,
          body: {
            today,
            warningDays: window === undefined || window.days === null
              ? { state: 'not_set', days: null, say: NOT_SET_WORDS }
              : { state: 'set', days: window.days, setBy: window.setBy, setAt: window.setAt },
            due, count: due.length, asAt: input.now(),
          },
        };
      },
    },
    {
      // The owner sets (or clears) how many days ahead of a contract's end he is told. Body: { days } or { days: null,
      // reason }. Append-only; the latest stands. Expired contracts are raised whatever this says.
      api: 'API-10', method: 'POST', path: '/v1/reporting/contract-expiry-alerts/warning-days',
      permission: 'owner.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const b = bodyOf(ctx.body);
        const at = input.now();
        let window: ContractExpiryWindow;
        if (b['days'] === null) {
          if (!isStr(b['reason'])) {
            throw apiError(400, { code: 'clearing_needs_a_reason', whatHappened: 'Clearing the warning window needs a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Send { days: null, reason }. Nothing was changed.' });
          }
          window = { days: null, setBy: ctx.userId, setAt: at, reason: b['reason'].trim().slice(0, 300) };
        } else {
          const read = readWarningDays(b['days']);
          if (!read.ok) {
            throw apiError(400, { code: 'not_readable_as_a_warning_window', whatHappened: `This could not be read as a warning window: ${read.why}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send { days: <1 to 365> }. Nothing was changed.' });
          }
          window = { days: read.days, setBy: ctx.userId, setAt: at };
        }
        const before = await expiryWindow(input.store, ctx.tenantId);
        const key = ctx.idempotencyKey ?? `${window.days ?? 'cleared'}-${at}`;
        await input.store.append(ctx.tenantId, FG4_STREAMS.contractExpiryWindow, makeEvent({
          id: `contract-expiry-window-${key}`, type: 'ContractExpiryWindowSet', occurredAt: at,
          idempotencyKey: `contract-expiry-window-${ctx.tenantId}-${key}`, source: 'api/purchase', payload: window as unknown as Record<string, unknown>,
        }));
        await input.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: window.days === null ? 'owner.contract_expiry_window.clear' : 'owner.contract_expiry_window.set',
          objectType: 'contract_expiry_window', objectId: 'contracts', at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { days: before?.days === undefined || before.days === null ? 'not set' : String(before.days) },
          after: { days: window.days === null ? 'not set' : String(window.days) },
          ...(window.reason === undefined ? {} : { reason: window.reason }), correlationId: 'contract-expiry-window',
        });
        return { status: 201, body: { state: window.days === null ? 'not_set' : 'set', days: window.days, setBy: window.setBy, setAt: at } };
      },
    },
  ];
}

// ── 2. purchase-price variance (D03-FR-05) ───────────────────────────────────────────────────────────────────────

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

function priceVarianceRoutes(input: Base): Route[] {
  return [
    {
      // D03-FR-05: what each receipt line cost against the order's price and the contract price on the day. Query:
      // supplierId?, from?, to? (YYYY-MM-DD, default the trailing 90 days), and the drill-through filters productId? /
      // grnId?. A branch-limited reader sees the receipts of their own branches. Reads only.
      api: 'API-03', method: 'GET', path: '/v1/purchase/price-variance',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const today = await shopDay(input, ctx.tenantId, input.now());
        const to = ctx.query['to'] ?? today;
        const from = ctx.query['from'] ?? (isDay(to) ? shiftDate(to, -89) : '');
        if (!isDay(from) || !isDay(to) || from > to) {
          throw apiError(400, { code: 'not_readable_as_a_period', whatHappened: 'The price-variance period needs ?from= and ?to= as YYYY-MM-DD dates, with from on or before to.', wasItSaved: 'not_saved', nextSafeAction: 'Correct the dates. Nothing was changed; this only reads.' });
        }
        const supplierId = isStr(ctx.query['supplierId']) ? ctx.query['supplierId'].trim() : undefined;
        const productId = isStr(ctx.query['productId']) ? ctx.query['productId'].trim() : undefined;
        const grnId = isStr(ctx.query['grnId']) ? ctx.query['grnId'].trim() : undefined;
        const [grns, orders, agreements, nodes] = await Promise.all([
          goodsReceiptAdapter({ store: input.store, now: input.now }).all(ctx.tenantId),
          foldPurchaseOrders(input.store, ctx.tenantId),
          foldBlanketAgreements(input.store, ctx.tenantId),
          orgStructureAdapter({ store: input.store, now: input.now }).nodes(ctx.tenantId),
        ]);
        const branchOf = branchOfLocationIn(nodes);
        const inScope = (locationId: string): boolean => branchInScope(ctx, branchOf(locationId));
        const ppvOrders = new Map<string, PpvOrder>([...orders.values()].map((o) => [o.poId, {
          poId: o.poId, number: o.number, supplierId: o.supplierId, ...(o.blanketAgreementId === undefined ? {} : { blanketAgreementId: o.blanketAgreementId }),
          lines: o.lines.map((l) => ({ productId: l.productId, unitCost: l.unitCost })),
        }]));
        let outsideScope = 0;
        const receipts: PpvReceipt[] = [];
        for (const g of grns) {
          const receivedOn = await shopDay(input, ctx.tenantId, g.receivedAt);
          if (receivedOn < from || receivedOn > to) continue;
          if (grnId !== undefined && g.grnId !== grnId) continue;
          const sup = g.poId === null ? null : (orders.get(g.poId)?.supplierId ?? null);
          if (supplierId !== undefined && sup !== supplierId) continue;
          if (!inScope(g.warehouseId)) { outsideScope += 1; continue; }
          receipts.push({
            grnId: g.grnId, number: g.number, poId: g.poId, supplierId: sup, receivedOn, locationId: g.warehouseId,
            lines: g.captured.lines
              .filter((l) => productId === undefined || l.productId === productId)
              .map((l) => ({ lineId: l.lineId, productId: l.productId, keptMinor: l.sellableMinor + l.quarantinedMinor + l.heldMinor, uom: l.uom, unitCost: l.unitCost })),
          });
        }
        const ppvAgreements: PpvAgreement[] = [...agreements.values()].map((a) => ({
          agreementId: a.agreementId, supplierId: a.supplierId, currency: a.currency, validFrom: a.validFrom, validTo: a.validTo,
          approved: a.status === 'approved', lines: a.lines.map((l) => ({ productId: l.productId, agreedUnitCost: l.agreedUnitCost })),
        }));
        const report = priceVariance({ receipts, orders: ppvOrders, agreements: ppvAgreements });
        return {
          status: 200,
          body: {
            period: { from, to }, supplierId: supplierId ?? null, drill: { productId: productId ?? null, grnId: grnId ?? null },
            ...report, receipts: receipts.length,
            // P-08: receipts the reader's branches do not cover are counted, never silently left out.
            ...(ctx.scope === 'all' ? {} : { outsideYourBranches: outsideScope }),
            sources: ['goods receipts', 'purchase orders', 'blanket agreements'], typedFigures: false, asAt: input.now(),
          },
        };
      },
    },
  ];
}

// ── 3. free samples and their GST credit give-back (A12 (1) · OB-386) ──────────────────────────────────────────────

function freeSampleSurface(input: Base): readonly Route[] {
  const { store, now } = input;
  const nodesBranches = async (tenantId: string) => branchOfLocationIn(await orgStructureAdapter({ store, now }).nodes(tenantId));
  const writeOffs = writeOffAdapter({ store, now });
  const plans = countPlansAdapter({ store, now });
  return freeSampleRoutes({
    now,
    issues: (t) => payloads<FreeSampleIssue>(store, t, FG4_STREAMS.freeSamples, 'FreeSampleIssued'),
    recordIssue: async (t, issue) => {
      // One truth (P-02): the sample REDUCES on-hand — a compensating issue keyed on the issue id (a retry is one, not two).
      await inventoryAdapter({ store, now }).appendMovement(t, {
        movementId: `free-sample-${issue.issueId}`, productId: issue.productId, locationId: issue.locationId, kind: 'wasted',
        quantityMinor: issue.qty, uom: issue.uom, occurredAt: issue.issuedAt, reason: FREE_SAMPLE_REASON, enteredBy: issue.issuedBy,
        ...(issue.batchId === undefined ? {} : { batchId: issue.batchId }),
      });
      await store.append(t, FG4_STREAMS.freeSamples, makeEvent({
        id: `free-sample-${issue.issueId}`, type: 'FreeSampleIssued', occurredAt: issue.issuedAt,
        idempotencyKey: `free-sample-${t}-${issue.issueId}`, source: 'api/inventory', payload: issue as unknown as Record<string, unknown>,
      }));
    },
    unitCostAt: async (t, l, p) => (writeOffs.unitCostAt === undefined ? undefined : writeOffs.unitCostAt(t, l, p)),
    ownersOfStockAt: async (t, p, l) => writeOffs.ownersOfStockAt(t, p, l),
    bills: async (t) => (await liveSupplierInvoices(store, t)).flatMap((inv) => inv.lines.map((l): PurchaseTaxLine => ({
      invoiceId: inv.invoiceId, capturedAt: inv.capturedAt, productId: l.productId, lineTotalMinor: l.lineTotalMinor,
      ...(l.cgstMinor === undefined ? {} : { cgstMinor: l.cgstMinor }), ...(l.sgstMinor === undefined ? {} : { sgstMinor: l.sgstMinor }), ...(l.igstMinor === undefined ? {} : { igstMinor: l.igstMinor }),
    }))),
    lockedMonths: (t) => lockedGstr3bPeriods(store, t),
    recordReversal: async (t, r) => itcStoreAdapter({ store, now }).recordReversal(t, r),
    checks: (t) => payloads<FreeSampleCheck>(store, t, FG4_STREAMS.freeSampleChecks, 'FreeSampleItcChecked'),
    recordCheck: async (t, c) => {
      await store.append(t, FG4_STREAMS.freeSampleChecks, makeEvent({
        id: `free-sample-check-${c.issueId}-${c.at}`, type: 'FreeSampleItcChecked', occurredAt: c.at,
        idempotencyKey: `free-sample-check-${t}-${c.issueId}-${c.by}-${c.at}`, source: 'api/finance', payload: c as unknown as Record<string, unknown>,
      }));
    },
    tradingDay: (t, at) => shopDay(input, t, at),
    locationBranches: nodesBranches,
    countFreeze: async (t, l, p, k) => (await countPlanFreezing(plans, t, l, p, k))?.planId,
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  });
}

// ── 4. authorization scopes (M02-FR-02 · SEC-03 · §28) ──────────────────────────────────────────────────────────

function indexOf(surface: readonly Route[], method: string, path: string): number {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`FG-4 scope wiring cannot find ${method} ${path} — the control it adds would silently not happen`);
  return at;
}
const wrap = (surface: Route[], method: string, path: string, around: (inner: Route['handler']) => Route['handler']): void => {
  const at = indexOf(surface, method, path);
  surface[at] = { ...surface[at]!, handler: around(surface[at]!.handler) };
};
/** Run a guard before the route's own handler — same path, same permission; a refusal stops it before anything is written. */
const guardBefore = (surface: Route[], method: string, path: string, guard: (ctx: RequestContext) => Promise<void>): void =>
  wrap(surface, method, path, (inner) => async (ctx): Promise<HandlerResult> => { await guard(ctx); return inner(ctx); });

const refusal = (code: string, whatHappened: string, nextSafeAction: string): Error =>
  apiError(403, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: `${nextSafeAction} Nothing was changed.` });

/** The facts a scope is judged on — read from head office's own registers at the request, never from the request. */
function scopeFacts(input: Base) {
  const { store, now } = input;
  const rolePermissions = (roleId: string) => ROLE_CATALOGUE.find((r) => r.id === roleId)?.permissions;
  const roleScope = async (tenantId: string, userId: string, permission: string, dimension: RoleScopeDimension) => roleScopeOf({
    scopes: foldRoleScopes(await payloads<RoleScopeRecord>(store, tenantId, FG4_STREAMS.roleScopes, 'RoleScopeSet')),
    grants: await effectiveGrants(store, tenantId), rolePermissions, userId, permission, dimension,
  });
  const categoryTree = async (tenantId: string) => {
    const [categories, products] = await Promise.all([categoryRegisterAdapter({ store, now }).categories(tenantId), productMasterAdapter({ store, now }).products(tenantId)]);
    const parent = new Map(categories.map((c) => [c.categoryId, c.parentId ?? null] as const));
    const categoryOf = new Map(products.map((p) => [p.productId, p.primaryCategoryId ?? null] as const));
    return { parentOf: (c: string) => parent.get(c) ?? null, categoryOf: (p: string) => categoryOf.get(p) ?? null };
  };
  const departmentOf = async (tenantId: string) => {
    const [links, tree] = await Promise.all([payloads<DepartmentLinkRecord>(store, tenantId, DEPARTMENT_LINKS_STREAM, 'DepartmentCategoriesSet'), categoryTree(tenantId)]);
    const live = currentLinks(links);
    return (productId: string) => departmentOfCategory(live, tree.parentOf, tree.categoryOf(productId));
  };
  const locationTree = async (tenantId: string) => {
    const nodes = await orgStructureAdapter({ store, now }).nodes(tenantId);
    const parent = new Map(nodes.map((n) => [n.nodeId, n.parentId ?? null] as const));
    return (id: string) => parent.get(id) ?? null;
  };
  return { roleScope, categoryTree, departmentOf, locationTree };
}

function scopeGuards(surface: Route[], input: Base): void {
  const { store, now } = input;
  const facts = scopeFacts(input);
  const body = (ctx: RequestContext) => bodyOf(ctx.body);
  const str = (v: unknown): string | undefined => (isStr(v) ? v.trim() : undefined);
  const productIdsOf = (lines: unknown): string[] => (Array.isArray(lines) ? lines : [])
    .flatMap((l) => (l !== null && typeof l === 'object' && isStr((l as Record<string, unknown>)['productId']) ? [((l as Record<string, unknown>)['productId'] as string).trim()] : []));

  // (a) Department scope — markdown proposals and store tasks (§28 "Department Manager … assortment/task/count/markdown").
  const departmentGuard = async (ctx: RequestContext, permission: string, productIds: readonly string[]) => {
    const scope = await departmentScopeOf(store, ctx.tenantId, ctx.userId, permission);
    if (scope === 'all') return;
    const dept = await facts.departmentOf(ctx.tenantId);
    for (const p of productIds) {
      const d = dept(p);
      if (!withinDepartmentScope(scope, d)) {
        throw refusal('outside_your_department_scope', d === undefined ? `Product ${p} belongs to no department, and this account's role reaches only some departments.` : `Product ${p} is in department "${d}", which this account's role does not reach.`, 'Work within the departments your role covers, or ask someone whose role covers this one.');
      }
    }
  };
  guardBefore(surface, 'POST', '/v1/pricing/markdown/propose', (ctx) => departmentGuard(ctx, 'price.change.propose', productIdsOf(body(ctx)['items'])));
  // A task assigned to a named person is in that person's home department (OB-357: the department on the staff record).
  guardBefore(surface, 'POST', '/v1/hr/workforce/assigned-tasks/:taskId', async (ctx) => {
    const scope = await departmentScopeOf(store, ctx.tenantId, ctx.userId, 'workforce.roster.manage');
    if (scope === 'all') return;
    const assignee = str(body(ctx)['assignedTo']) ?? '';
    const home = (await rosterStoreAdapter({ store, now }).roster(ctx.tenantId)).employees.find((e) => e.employeeId === assignee)?.homeDepartmentId;
    if (home === undefined || !scope.includes(home)) {
      throw refusal('outside_your_department_scope', home === undefined
        ? `${assignee === '' ? 'The assignee' : assignee} has no home department on the staff record, and this account's role reaches only some departments (${scope.join(', ')}).`
        : `${assignee}'s home department is "${home}", which this account's role does not reach (${scope.join(', ')}).`, 'Assign the task to someone in your departments, or ask someone whose role covers theirs.');
    }
  });
  // A daily task routed to a role names no person and no department — not one a department-limited role may raise.
  guardBefore(surface, 'POST', '/v1/hr/workforce/tasks/:taskId', async (ctx) => {
    const scope = await departmentScopeOf(store, ctx.tenantId, ctx.userId, 'workforce.roster.manage');
    if (scope === 'all') return;
    throw refusal('outside_your_department_scope', `A daily task routed to a role belongs to no department, and this account's role reaches only some departments (${scope.join(', ')}).`, 'Assign the task to a named person in your departments, or ask someone whose role covers the whole store.');
  });

  // (b) Supplier / category scope — the person who buys (§28 "Purchase User — assigned suppliers/categories").
  const PROPOSE = 'purchase.order.propose';
  const supplierGuard = async (ctx: RequestContext, supplierId: string | undefined) => {
    const suppliers = await facts.roleScope(ctx.tenantId, ctx.userId, PROPOSE, 'suppliers');
    if (suppliers === 'all' || (supplierId !== undefined && suppliers.includes(supplierId))) return;
    throw refusal('outside_your_supplier_scope', `${supplierId === undefined ? 'This names no supplier' : `Supplier ${supplierId} is not one of yours`}: this account's buying role reaches only ${suppliers.length === 0 ? 'no supplier' : suppliers.join(', ')}.`, 'Buy from the suppliers your role covers, or ask the buyer who covers this one.');
  };
  const categoryGuard = async (ctx: RequestContext, productIds: readonly string[]) => {
    const categories = await facts.roleScope(ctx.tenantId, ctx.userId, PROPOSE, 'categories');
    if (categories === 'all') return;
    const tree = await facts.categoryTree(ctx.tenantId);
    for (const p of productIds) {
      const c = tree.categoryOf(p);
      if (!withinTreeScope(categories, c, tree.parentOf)) {
        throw refusal('outside_your_category_scope', c === null ? `Product ${p} is in no category, and this account's buying role reaches only some categories (${categories.join(', ')}).` : `Product ${p} is in category "${c}", which this account's buying role does not reach (${categories.join(', ')}).`, 'Take the line off, or ask the buyer who covers that category.');
      }
    }
  };
  // A requisition names no supplier yet: only its products' categories are judged (the supplier is judged at the quote).
  guardBefore(surface, 'POST', '/v1/purchase/requisitions/:requisitionId', (ctx) => categoryGuard(ctx, productIdsOf(body(ctx)['lines'])));
  for (const path of ['/v1/purchase/requisitions/:requisitionId/quotes/:quoteId', '/v1/purchase/blanket-orders/:agreementId']) {
    guardBefore(surface, 'POST', path, async (ctx) => { await supplierGuard(ctx, str(body(ctx)['supplierId'])); await categoryGuard(ctx, productIdsOf(body(ctx)['lines'])); });
  }
  guardBefore(surface, 'POST', '/v1/purchase/orders/:poId', async (ctx) => {
    const b = body(ctx);
    // A call-off release is with its agreement's supplier (never the body's word).
    const agreementId = str(b['blanketAgreementId']);
    const supplierId = agreementId === undefined ? str(b['supplierId']) : (await foldBlanketAgreements(store, ctx.tenantId)).get(agreementId)?.supplierId ?? str(b['supplierId']);
    await supplierGuard(ctx, supplierId);
    await categoryGuard(ctx, productIdsOf(b['lines']));
  });

  // (c) Location scope inside a branch — those who receive, count and move stock (§28 "Receiver/QC, Warehouse User —
  //     assigned locations"). A location reaches the places under it in the organisation.
  const locationGuard = async (ctx: RequestContext, locationIds: readonly (string | undefined)[]) => {
    const scope = await facts.roleScope(ctx.tenantId, ctx.userId, 'inventory.movement.append', 'locations');
    if (scope === 'all') return;
    const parentOf = await facts.locationTree(ctx.tenantId);
    for (const l of locationIds) {
      if (l === undefined) continue;
      if (!withinTreeScope(scope, l, parentOf)) {
        throw refusal('outside_your_location_scope', `${l} is not one of the places this account's role reaches inside the branch (${scope.join(', ')}).`, 'Work at the places your role covers, or ask someone who works at this one.');
      }
    }
  };
  /** Where a bin is: its location when it names one, else its store. Unknown bins are left to the route to refuse. */
  const binPlaces = async (tenantId: string, binIds: readonly unknown[]): Promise<(string | undefined)[]> => {
    const bins = await warehouseAdapter({ store, now }).bins(tenantId);
    return binIds.map((id) => { const bin = isStr(id) ? bins.find((x) => x.binId === id) : undefined; return bin === undefined ? undefined : bin.locationId ?? bin.storeId; });
  };
  guardBefore(surface, 'POST', '/v1/inventory/goods-receipt/:grnId', (ctx) => locationGuard(ctx, [str(body(ctx)['warehouseId'])]));
  guardBefore(surface, 'POST', '/v1/inventory/counts/:countId', (ctx) => locationGuard(ctx, [str(body(ctx)['locationId'])]));
  guardBefore(surface, 'POST', '/v1/warehouse/bins/:binId', async (ctx) => locationGuard(ctx, [str(body(ctx)['locationId']) ?? str(body(ctx)['storeId']), ...(await binPlaces(ctx.tenantId, [ctx.params['binId']]))]));
  guardBefore(surface, 'POST', '/v1/warehouse/movements/:commandId', async (ctx) => locationGuard(ctx, await binPlaces(ctx.tenantId, [body(ctx)['fromBinId'], body(ctx)['toBinId']])));
  guardBefore(surface, 'POST', '/v1/warehouse/transfers/:transferId', (ctx) => locationGuard(ctx, [str(body(ctx)['fromLocationId']), str(body(ctx)['toLocationId'])]));
  guardBefore(surface, 'POST', '/v1/warehouse/transfers/:transferId/dispatch', async (ctx) => {
    const t = await transfersAdapter({ store, now }).transfer(ctx.tenantId, (ctx.params['transferId'] ?? '').trim());
    if (t !== undefined) await locationGuard(ctx, [t.fromLocationId]);
  });
  guardBefore(surface, 'POST', '/v1/warehouse/transfers/:transferId/receive', async (ctx) => {
    const t = await transfersAdapter({ store, now }).transfer(ctx.tenantId, (ctx.params['transferId'] ?? '').trim());
    if (t !== undefined) await locationGuard(ctx, [t.toLocationId]);
  });

  // The access review shows these limits beside the branch and department on every role they narrow (M02-FR-01/02).
  wrap(surface, 'GET', '/v1/identity/access-review', (inner) => async (ctx): Promise<HandlerResult> => {
    const out = await inner(ctx);
    if (out.status !== 200) return out;
    const scopes = foldRoleScopes(await payloads<RoleScopeRecord>(store, ctx.tenantId, FG4_STREAMS.roleScopes, 'RoleScopeSet'));
    const b = out.body as { rows?: { userId: string; roles?: { roleId: string }[] }[] };
    const of = (userId: string, roleId: string, d: RoleScopeDimension) => scopes.get(`${userId}\u0000${roleId}\u0000${d}`)?.values ?? 'all';
    const rows = (b.rows ?? []).map((r) => ({
      ...r,
      roles: (r.roles ?? []).map((g) => ({ ...g, supplierScope: of(r.userId, g.roleId, 'suppliers'), categoryScope: of(r.userId, g.roleId, 'categories'), locationScope: of(r.userId, g.roleId, 'locations') })),
    }));
    return { ...out, body: { ...(out.body as Record<string, unknown>), rows } };
  });

  // The scope-setting routes themselves (two other people through the engine) and their read.
  surface.push(...roleScopeRoutes({
    approvals: approvalRequestsAdapter({ store, now }), now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
    records: (t) => payloads<RoleScopeRecord>(store, t, FG4_STREAMS.roleScopes, 'RoleScopeSet'),
    recordScope: async (t, r) => {
      await store.append(t, FG4_STREAMS.roleScopes, makeEvent({
        id: `role-scope-${r.userId}-${r.roleId}-${r.dimension}-${r.approvalId}`, type: 'RoleScopeSet', occurredAt: r.at,
        idempotencyKey: `role-scope-${t}-${r.approvalId}`, source: 'api/identity', payload: r as unknown as Record<string, unknown>,
      }));
    },
    holdsRole: async (t, userId, roleId) => (await effectiveGrants(store, t)).some((g) => g.userId === userId && g.roleId === roleId)
      || (await liveEmergencyRoles(store, t, userId, now())).includes(roleId),
    knownIds: async (t, dimension) => {
      if (dimension === 'suppliers') return (await supplierMasterAdapter({ store, now }).records(t)).map((r) => r.supplierId);
      if (dimension === 'categories') return (await categoryRegisterAdapter({ store, now }).categories(t)).map((c) => c.categoryId);
      return (await orgStructureAdapter({ store, now }).nodes(t)).filter((n) => n.kind !== 'company' && n.status !== 'closed').map((n) => n.nodeId);
    },
  }));
}

// ── 5. vendor-managed inventory (D03-FR-04) ──────────────────────────────────────────────────────────────────────

function vmiSurface(surface: Route[], input: Base): readonly Route[] {
  const { store, now } = input;
  const put = async (t: string, stream: string, type: string, id: string, at: string, payload: unknown) => {
    await store.append(t, stream, makeEvent({ id: `${type}-${id}`, type, occurredAt: at, idempotencyKey: `${type}-${t}-${id}`, source: 'api/purchase', payload: payload as Record<string, unknown> }));
  };
  const portal = supplierPortalAdapter({ store, now });
  return vmiRoutes({
    now,
    limits: (t) => payloads<VmiLimit>(store, t, FG4_STREAMS.vmiLimits, 'VmiLimitSet'),
    recordLimit: (t, l) => put(t, FG4_STREAMS.vmiLimits, 'VmiLimitSet', `${l.supplierId}-${l.storeId}-${l.productId}-${l.setAt}`, l.setAt, l),
    proposals: (t) => payloads<VmiProposal>(store, t, FG4_STREAMS.vmiProposals, 'VmiProposalReceived'),
    recordProposal: (t, p) => put(t, FG4_STREAMS.vmiProposals, 'VmiProposalReceived', p.proposalId, p.proposedAt, p),
    decisions: (t) => payloads<VmiDecision>(store, t, FG4_STREAMS.vmiDecisions, 'VmiProposalDecided'),
    recordDecision: (t, d) => put(t, FG4_STREAMS.vmiDecisions, 'VmiProposalDecided', d.proposalId, d.decidedAt, d),
    partnerForUser: async (t, userId) => portal.partnerForUser(t, userId),
    supplierKnown: async (t, s) => (await supplierMasterAdapter({ store, now }).records(t)).some((r) => r.supplierId === s && r.status === 'active'),
    storeKnown: async (t, s) => (await orgStructureAdapter({ store, now }).nodes(t)).some((n) => n.nodeId === s && n.kind === 'branch' && n.status !== 'closed'),
    productKnown: async (t, p) => (await productMasterAdapter({ store, now }).products(t)).some((x) => x.productId === p),
    stockOf: async (t, supplierId, storeId, productId) => {
      const [nodes, rows, orders] = await Promise.all([
        orgStructureAdapter({ store, now }).nodes(t), inventoryAdapter({ store, now }).availability(t, productId), foldPurchaseOrders(store, t),
      ]);
      const branchOf = branchOfLocationIn(nodes);
      const here = rows.filter((r) => r.productId === productId && branchOf(r.locationId) === storeId);
      const onOrder = [...orders.values()]
        .filter((o) => o.supplierId === supplierId && o.deliverToLocationId !== undefined && branchOf(o.deliverToLocationId) === storeId)
        .reduce((sum, o) => sum + o.lines.filter((l) => l.productId === productId).reduce((s, l) => s + Math.max(0, l.orderedQty - (o.receivedByProduct[productId] ?? 0) - (o.cancelledByProduct[productId] ?? 0)), 0), 0);
      return { onHand: here.reduce((s, r) => s + r.onHandMinor, 0), onOrder, asAt: here.map((r) => r.asAt).sort().at(-1) ?? now() };
    },
    // The ordinary purchase-order route, as the buyer — with every check wrapped on it (supplier, range, scope, limits).
    proposePurchaseOrder: async (ctx, poId, body) => {
      const r = surface.find((x) => x.method === 'POST' && x.path === '/v1/purchase/orders/:poId');
      if (r === undefined) throw new Error('FG-4 VMI wiring cannot find POST /v1/purchase/orders/:poId — an accepted proposal would order nothing');
      return r.handler({ ...ctx, params: { poId }, body });
    },
    recordPartnerAudit: async (t, entry, key) => { await portal.recordAudit(t, entry, key); },
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  });
}

// ── the surface ────────────────────────────────────────────────────────────────────────────────────────────────────

export function fg4BuyingSurface(surface: Route[], raw: Fg4BuyingInput): void {
  // A bare composition (no store: the API-surface document, a stub) still serves the same routes over a store that keeps
  // nothing between processes — the surface a partner reads is the one production serves.
  const input: Base = { ...raw, store: raw.store ?? new InMemoryEventStore() };
  surface.push(...contractExpiryRoutes(input), ...priceVarianceRoutes(input), ...freeSampleSurface(input));
  scopeGuards(surface, input);
  // After the guards: an accepted VMI proposal goes through the purchase-order route WITH them.
  surface.push(...vmiSurface(surface, input));
}
