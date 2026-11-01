// Wave 2 · Round 4a part 2 (space · 1 Nov 2026) — head office's wiring for the shelf, floor-plan, display-space, range and
// product-check screens. Kept in its own file: main.ts carries one registration line. The routes it governs are WRAPPED in
// place (same path, same permission), so every caller — the new screens, the files, the tests — meets the same rules.
//
//   1. Audit (M04-FR-02 "layout changes audited" · M04-FR-03 "planogram versions … audited" · M04-FR-04 "contract and
//      funding changes audited" · M04-FR-01 "assortment changes audited"): a shelf map, a planogram version, a floor plan, a
//      display contract, a cluster range decision and a season plan are each sealed in the audit trail with who did it,
//      what it was before and what it became. The registers stay append-only (hard rule #2); this adds the evidence and
//      changes no behaviour. (The kernel's own row for every write stays as well.)
//   2. `GET /v1/catalogue/reports/product-checks` (OB-625): the three read-only product-master check reports.
//
// Nothing here is committed by an AI (hard rule #5).

import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { productCheckRoutes } from '../../catalogue/src/product-checks';
import { productMasterAdapter, categoryRegisterAdapter, barcodeAdapter, taxClassAdapter, spacePerformanceAdapter } from './adapters';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

export interface SpaceSurfaceInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly calendar?: ShopCalendarOf;
  readonly recordAudit?: Recorder;
}

function indexOf(surface: readonly Route[], method: string, path: string): number {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`Wave 2 space wiring cannot find ${method} ${path} — the control it adds would silently not happen`);
  return at;
}
const wrap = (surface: Route[], method: string, path: string, around: (inner: Route['handler']) => Route['handler']): void => {
  const at = indexOf(surface, method, path);
  surface[at] = { ...surface[at]!, handler: around(surface[at]!.handler) };
};
const ok = (r: HandlerResult): boolean => r.status >= 200 && r.status < 300;
const origin = (ctx: RequestContext) => ({ tenantId: ctx.tenantId, branchId: ctx.branchId ?? null });
const words = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The standing record, read through the surface's own GET route as the same person; undefined when there is none. */
async function readVia(surface: readonly Route[], path: string, ctx: RequestContext, params: Record<string, string>): Promise<Record<string, unknown> | undefined> {
  const route = surface[indexOf(surface, 'GET', path)]!;
  try {
    const res = await route.handler({ ...ctx, method: 'GET', params, query: {}, body: undefined } as RequestContext);
    return ok(res) && isObj(res.body) ? res.body : undefined;
  } catch { return undefined; }
}

type Loc = { locationId: string; aisle: number; rack: number; bay: number; shelf: number; position: number };
const locIds = (map: unknown): readonly string[] => (isObj(map) && Array.isArray(map['locations']) ? (map['locations'] as Loc[]).map((l) => l.locationId) : []);

function auditWraps(surface: Route[], input: { readonly store: EventStore; readonly now: () => string; readonly recordAudit: Recorder }): void {
  const { now, recordAudit } = input;
  const contracts = spacePerformanceAdapter({ store: input.store, now });

  wrap(surface, 'PUT', '/v1/merchandising/stores/:storeId/shelf-map', (inner) => async (ctx) => {
    const storeId = (ctx.params['storeId'] ?? '').trim();
    const before = (await readVia(surface, '/v1/merchandising/stores/:storeId/shelf-map', ctx, { storeId }))?.['shelfMap'];
    const res = await inner(ctx);
    const after = (res.body as { shelfMap?: Record<string, unknown> } | null)?.shelfMap;
    if (ok(res) && after !== undefined) {
      const was = new Set(locIds(before)); const is = new Set(locIds(after));
      await recordAudit(ctx.tenantId, {
        actorId: ctx.userId, action: 'merchandising.shelf_map.publish', objectType: 'shelf_map', objectId: storeId, at: now(), origin: origin(ctx),
        before: before === undefined ? null : { version: words((before as Record<string, unknown>)['version']), places: String(was.size) },
        after: {
          version: words(after['version']), places: String(is.size),
          added: [...is].filter((id) => !was.has(id)).join(','), removed: [...was].filter((id) => !is.has(id)).join(','),
        },
        correlationId: `shelf-map:${storeId}:v${words(after['version'])}`,
      });
    }
    return res;
  });

  wrap(surface, 'PUT', '/v1/merchandising/stores/:storeId/planograms/:planogramId', (inner) => async (ctx) => {
    const storeId = (ctx.params['storeId'] ?? '').trim();
    const planogramId = (ctx.params['planogramId'] ?? '').trim();
    const history = (await readVia(surface, '/v1/merchandising/stores/:storeId/planograms/:planogramId', ctx, { storeId, planogramId }))?.['versions'];
    const before = Array.isArray(history) ? (history as Record<string, unknown>[]).at(-1) : undefined;
    const res = await inner(ctx);
    const after = (res.body as { planogram?: Record<string, unknown> } | null)?.planogram;
    const shape = (p: Record<string, unknown>) => ({
      version: words(p['version']), effectiveFrom: words(p['effectiveFrom']), shelfMapVersion: words(p['shelfMapVersion']),
      facings: (Array.isArray(p['assignments']) ? p['assignments'] as Record<string, unknown>[] : []).map((a) => `${words(a['productId'])}@${words(a['locationId'])}:${words(a['capacityMinor'])}${a['primary'] === true ? '*' : ''}`).join(','),
    });
    if (ok(res) && after !== undefined) {
      await recordAudit(ctx.tenantId, {
        actorId: ctx.userId, action: 'merchandising.planogram.publish', objectType: 'planogram', objectId: `${storeId}/${planogramId}`, at: now(), origin: origin(ctx),
        before: before === undefined ? null : shape(before), after: shape(after), correlationId: `planogram:${storeId}:${planogramId}:v${words(after['version'])}`,
      });
    }
    return res;
  });

  wrap(surface, 'POST', '/v1/merchandising/stores/:storeId/floor-plan', (inner) => async (ctx) => {
    const storeId = (ctx.params['storeId'] ?? '').trim();
    const before = (await readVia(surface, '/v1/merchandising/stores/:storeId/floor-plan', ctx, { storeId }))?.['plan'];
    const res = await inner(ctx);
    const after = (res.body as { plan?: Record<string, unknown> } | null)?.plan;
    const shape = (p: Record<string, unknown>) => ({
      version: words(p['version']), size: `${words(p['widthFt'])}x${words(p['depthFt'])} ft`,
      areas: (Array.isArray(p['areas']) ? p['areas'] as Record<string, unknown>[] : []).map((a) => `${words(a['areaId'])}(${words(a['squareFeet'])} sq ft: ${(Array.isArray(a['locationIds']) ? a['locationIds'] : []).join('+')})`).join(','),
    });
    if (ok(res) && after !== undefined) {
      await recordAudit(ctx.tenantId, {
        actorId: ctx.userId, action: 'merchandising.floor_plan.publish', objectType: 'floor_plan', objectId: storeId, at: now(), origin: origin(ctx),
        before: isObj(before) ? shape(before) : null, after: shape(after), correlationId: `floor-plan:${storeId}:v${words(after['version'])}`,
      });
    }
    return res;
  });

  wrap(surface, 'POST', '/v1/merchandising/display-contracts/:contractId', (inner) => async (ctx) => {
    const contractId = (ctx.params['contractId'] ?? '').trim();
    const before = (await contracts.contracts(ctx.tenantId)).find((c) => c.contractId === contractId);
    const res = await inner(ctx);
    if (ok(res)) {
      const after = (await contracts.contracts(ctx.tenantId)).find((c) => c.contractId === contractId);
      const shape = (c: NonNullable<typeof before>) => ({
        storeId: c.storeId, supplierId: c.supplierId, description: c.description, fundingMinor: String(c.fundingAmount.minor), startsOn: c.startsOn, endsOn: c.endsOn,
        space: [c.areaId ?? '', ...c.locationIds].filter((x) => x !== '').join(','), approvedBy: c.approvedBy ?? '',
      });
      const b = (isObj(ctx.body) ? ctx.body : {}) as Record<string, unknown>;
      if (after !== undefined) {
        await recordAudit(ctx.tenantId, {
          actorId: ctx.userId, action: before === undefined ? 'merchandising.display_contract.record' : 'merchandising.display_contract.correct', objectType: 'display_contract', objectId: contractId,
          at: now(), origin: origin(ctx), before: before === undefined ? null : shape(before), after: shape(after),
          ...(typeof b['approvalId'] === 'string' && b['approvalId'].trim() !== '' ? { approvalId: b['approvalId'].trim() } : {}), correlationId: `display-contract:${contractId}`,
        });
      }
    }
    return res;
  });

  const rangeAudit = (path: string, action: string, objectOf: (ctx: RequestContext) => string) =>
    wrap(surface, 'POST', path, (inner) => async (ctx) => {
      const res = await inner(ctx);
      if (ok(res)) {
        const b = (isObj(ctx.body) ? ctx.body : {}) as Record<string, unknown>;
        const r = (isObj(res.body) ? res.body : {}) as Record<string, unknown>;
        const after: Record<string, string> = {};
        for (const k of ['reason', 'effectiveFrom', 'reasonNote', 'replacedByProductId', 'listFrom', 'listTo', 'zoneId', 'storeId']) if (b[k] !== undefined) after[k] = words(b[k]);
        if (Array.isArray(b['productIds'])) after['products'] = (b['productIds'] as unknown[]).map(words).join(',');
        if (Array.isArray(r['stores'])) after['stores'] = (r['stores'] as unknown[]).map(words).join(',');
        if (Array.isArray(r['decisions'])) after['decisions'] = (r['decisions'] as Record<string, unknown>[]).map((d) => `${words(d['storeId'])}:${words(d['outcome'])}`).join(',');
        if (isObj(r['plan']) && Array.isArray(r['plan']['storeIds'])) after['stores'] = (r['plan']['storeIds'] as unknown[]).map(words).join(',');
        await recordAudit(ctx.tenantId, {
          actorId: ctx.userId, action, objectType: 'assortment', objectId: objectOf(ctx), at: now(), origin: origin(ctx), before: null, after,
          ...(typeof b['reason'] === 'string' ? { reason: b['reason'].slice(0, 300) } : {}), correlationId: `${action}:${objectOf(ctx)}`,
        });
      }
      return res;
    });
  rangeAudit('/v1/merchandising/clusters/:zoneId/:productId/list', 'merchandising.cluster.list', (ctx) => `${ctx.params['zoneId'] ?? ''}/${ctx.params['productId'] ?? ''}`);
  rangeAudit('/v1/merchandising/clusters/:zoneId/:productId/drop', 'merchandising.cluster.drop', (ctx) => `${ctx.params['zoneId'] ?? ''}/${ctx.params['productId'] ?? ''}`);
  rangeAudit('/v1/merchandising/season-plans/:planId', 'merchandising.season_plan.make', (ctx) => ctx.params['planId'] ?? '');
}

/** The one line in main.ts. */
export function spaceSurface(surface: Route[], input: SpaceSurfaceInput): void {
  const store = input.store ?? new InMemoryEventStore();
  const now = input.now;
  if (input.recordAudit !== undefined) auditWraps(surface, { store, now, recordAudit: input.recordAudit });
  const master = productMasterAdapter({ store, now });
  const taxes = taxClassAdapter({ store, now });
  surface.push(...productCheckRoutes({
    now,
    products: async (t) => master.products(t),
    categories: async (t) => categoryRegisterAdapter({ store, now }).categories(t),
    barcodes: async (t) => barcodeAdapter({ store, now }).all(t),
    gstSchedule: async (t, hsn) => taxes.schedule(t, hsn),
    today: (t) => shopToday({ now, ...(input.calendar === undefined ? {} : { calendar: input.calendar }) }, t),
  }));
}
