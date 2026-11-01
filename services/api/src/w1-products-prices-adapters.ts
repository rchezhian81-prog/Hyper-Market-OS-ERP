// Round 4a (products and prices, 1 Nov 2026) — head office's wiring for the product-master and price-list screens. Kept in
// its own file: main.ts carries one registration line. The routes it governs are WRAPPED in place (same path, same
// permission), so every caller — the new screens, the files, the tests — meets the same rules.
//
//   1. Audit (M34-FR-01 · M03 "barcode/UOM changes audited", "merges … audited with before/after", "tax/MRP … changes
//      audited" · M05-FR-01): a category defined or changed, a pack hierarchy defined, a barcode given to a product, a
//      product published, a merge proposed / decided / reversed, a store put in a price zone and a price-list entry are each
//      sealed in the audit trail with who did it, what it was before and what it became. The registers themselves stay
//      append-only (hard rule #2); this adds the evidence, it changes no behaviour.
//   2. The price-list entry's price basis (M05-FR-01 · M05-FR-02 · OB-291): a dated, scoped price is judged on head
//      office's OWN figures where it holds them — the product master's MRP in force on the entry's date (the lower of it and
//      the one sent), the average buying cost at the stores the entry reaches (the higher of it and the one sent), and the
//      strictest margin floor the owner set in those stores' rules (the higher of it and the one sent) — so a screen or a
//      file cannot loosen the legal ceiling or the floor by sending another figure. And a price that moves more than the
//      owner's set size (OB-291: more than 10% or more than ₹50 a unit) from the price in force for the same scope needs a
//      second person, exactly as the flat price change does. With an approval named, the route's own check decides, as
//      before. Nothing is ever changed without a refusal saying so by name.
//   3. `GET /v1/prices/list/:productId/basis` — what the price screen shows and sends: those figures for a scope and a
//      date, each one "not known" / "not set" by name where head office does not hold it (P-08), never a guess.
//
// Nothing here is committed by an AI (hard rule #5).

import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { DurableTenantSettings } from '../../../packages/tenant/src/durable-settings';
import { resolvePrice, type PriceScope } from '../../../packages/price-list/src/price-list';
import { checkPrice } from '../../../packages/price-guard/src/price-guard';
import { money, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import { priceChangeSize } from '../../../packages/approvals/src/authority-rules';
import { priceCheckOf } from '../../identity/src/authority-limits';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import type { ProductRecord } from '../../../packages/product/src/index';
import {
  productMasterAdapter, categoryRegisterAdapter, packHierarchyAdapter, barcodeAdapter, productMergeAdapter, priceListAdapter, pricingAdapter,
  storeRulesAdapter, averageBuyingCosts,
} from './adapters';
import { channelPricingAdapter } from './r3-ops-adapters';
import { rulesStoreOf } from './p1-identity-adapters';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

export interface ProductsPricesInput {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly calendar?: ShopCalendarOf;
  readonly settings: DurableTenantSettings;
  readonly recordAudit?: Recorder;
}
interface Base { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf; readonly settings: DurableTenantSettings; readonly recordAudit?: Recorder }

function indexOf(surface: readonly Route[], method: string, path: string): number {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`Round 4a wiring cannot find ${method} ${path} — the control it adds would silently not happen`);
  return at;
}
const wrap = (surface: Route[], method: string, path: string, around: (inner: Route['handler']) => Route['handler']): void => {
  const at = indexOf(surface, method, path);
  surface[at] = { ...surface[at]!, handler: around(surface[at]!.handler) };
};
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const ok = (r: HandlerResult): boolean => r.status >= 200 && r.status < 300;
const origin = (ctx: RequestContext) => ({ tenantId: ctx.tenantId, branchId: ctx.branchId ?? null });
const words = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

// ── 1. audit ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The product fields a person reads in the trail — every field a product publish can change, as plain strings. */
export function productAuditFields(p: ProductRecord | undefined): Record<string, string> | null {
  if (p === undefined) return null;
  const s = p.safety ?? {};
  return {
    name: p.name, sku: p.sku, baseUom: p.baseUom, category: p.primaryCategoryId ?? '', taxClass: p.taxClass ?? '', lifecycle: p.lifecycle,
    brand: p.brand ?? '', manufacturer: p.manufacturer ?? '', parentProductId: p.parentProductId ?? '',
    mrp: (p.mrpHistory ?? []).map((m) => `${m.effectiveFrom}:${m.value.minor}`).join(','), attributes: words(p.attributes),
    ingredients: s.ingredients ?? '', allergens: s.allergens === undefined ? 'not declared' : s.allergens.length === 0 ? 'none' : s.allergens.join(','),
    countryOfOrigin: s.countryOfOrigin ?? '', storageConditions: s.storageConditions ?? '', packedBySre: s.packedBySre === true ? 'yes' : '',
    nutrition: words(s.nutrition), recallBlocked: p.recallBlocked === true ? 'yes' : '',
  };
}

function auditTrailWraps(surface: Route[], base: Base): void {
  const { store, now, recordAudit } = base;
  if (recordAudit === undefined) return;
  const products = productMasterAdapter({ store, now });
  const categories = categoryRegisterAdapter({ store, now });
  const packs = packHierarchyAdapter({ store, now });
  const barcodes = barcodeAdapter({ store, now });
  const merges = productMergeAdapter({ store, now });
  const zones = channelPricingAdapter({ store, now });

  wrap(surface, 'POST', '/v1/catalogue/categories/:categoryId', (inner) => async (ctx) => {
    const id = (ctx.params['categoryId'] ?? '').trim();
    const before = (await categories.categories(ctx.tenantId)).find((c) => c.categoryId === id);
    const res = await inner(ctx);
    const b = res.body as { category?: Record<string, unknown>; changed?: unknown } | null;
    if (ok(res) && b?.changed === true && isObj(b.category)) {
      const c = b.category;
      const shape = (x: Record<string, unknown> | undefined) => (x === undefined ? null : {
        name: words(x['name']), parentId: words(x['parentId']), regulated: (Array.isArray(x['regulated']) ? x['regulated'] : []).join(','),
        attributes: (Array.isArray(x['attributes']) ? x['attributes'] as Record<string, unknown>[] : []).map((a) => `${words(a['key'])}:${words(a['type'])}${a['required'] === true ? '*' : ''}`).join(','),
        version: words(x['version']),
      });
      await recordAudit(ctx.tenantId, {
        actorId: ctx.userId, action: before === undefined ? 'catalogue.category.define' : 'catalogue.category.change', objectType: 'category', objectId: id,
        at: now(), origin: origin(ctx), before: shape(before as unknown as Record<string, unknown> | undefined), after: { ...shape(c)!, approvedBy: words(c['approvedBy']) },
        ...(isStr((ctx.body as Record<string, unknown> | null)?.['approvalId']) ? { approvalId: String((ctx.body as Record<string, unknown>)['approvalId']).trim() } : {}),
        correlationId: `category:${id}:v${words(c['version'])}`,
      });
    }
    return res;
  });

  wrap(surface, 'POST', '/v1/catalogue/products/:productId/pack', (inner) => async (ctx) => {
    const id = (ctx.params['productId'] ?? '').trim();
    const before = await packs.pack(ctx.tenantId, id);
    const res = await inner(ctx);
    const levels = (p: { readonly baseUom: string; readonly levels: readonly { readonly level: string; readonly containsMinor: number; readonly barcode?: string }[] } | undefined) =>
      (p === undefined ? null : { baseUom: p.baseUom, levels: p.levels.map((l) => `${l.level}=${l.containsMinor}${l.barcode === undefined ? '' : `[${l.barcode}]`}`).join(',') });
    const after = (res.body as { pack?: Parameters<typeof levels>[0] } | null)?.pack;
    if (ok(res) && after !== undefined) {
      await recordAudit(ctx.tenantId, {
        actorId: ctx.userId, action: 'catalogue.pack.define', objectType: 'product', objectId: id, at: now(), origin: origin(ctx),
        before: levels(before), after: levels(after), correlationId: `pack:${id}`,
      });
    }
    return res;
  });

  wrap(surface, 'POST', '/v1/catalogue/products/:productId/barcodes/:code', (inner) => async (ctx) => {
    const id = (ctx.params['productId'] ?? '').trim();
    const code = (ctx.params['code'] ?? '').trim();
    const held = (await barcodes.all(ctx.tenantId)).some((a) => a.code === code && a.productId === id);
    const res = await inner(ctx);
    const after = (res.body as { barcode?: { kind?: unknown; level?: unknown } } | null)?.barcode;
    if (ok(res) && !held && after !== undefined) {
      await recordAudit(ctx.tenantId, {
        actorId: ctx.userId, action: 'catalogue.barcode.assign', objectType: 'product', objectId: id, at: now(), origin: origin(ctx),
        before: null, after: { code, kind: words(after.kind), level: words(after.level) }, correlationId: `barcode:${code}`,
      });
    }
    return res;
  });

  wrap(surface, 'POST', '/v1/catalogue/products/:productId/publish', (inner) => async (ctx) => {
    const id = (ctx.params['productId'] ?? '').trim();
    const before = await products.product(ctx.tenantId, id);
    const res = await inner(ctx);
    const after = (res.body as { product?: ProductRecord } | null)?.product;
    if (ok(res) && after !== undefined) {
      await recordAudit(ctx.tenantId, {
        actorId: ctx.userId, action: before === undefined ? 'catalogue.product.create' : 'catalogue.product.publish', objectType: 'product', objectId: id,
        at: now(), origin: origin(ctx), before: productAuditFields(before), after: productAuditFields(after),
        ...(isStr((ctx.body as Record<string, unknown> | null)?.['approvalId']) ? { approvalId: String((ctx.body as Record<string, unknown>)['approvalId']).trim() } : {}),
        correlationId: `product:${id}`,
      });
    }
    return res;
  });

  const mergeAudit = (path: string, action: (ctx: RequestContext, body: Record<string, unknown>) => string) =>
    wrap(surface, 'POST', path, (inner) => async (ctx) => {
      const mergeId = (ctx.params['mergeId'] ?? '').trim();
      const before = await merges.view(ctx.tenantId, mergeId);
      const res = await inner(ctx);
      const m = (res.body as { merge?: { request?: { keepProductId?: string; supersedeProductId?: string; reason?: string }; status?: string; decidedBy?: string } } | null)?.merge;
      if (ok(res) && m !== undefined && m.status !== before?.status) {
        await recordAudit(ctx.tenantId, {
          actorId: ctx.userId, action: action(ctx, (ctx.body ?? {}) as Record<string, unknown>), objectType: 'product_merge', objectId: mergeId, at: now(), origin: origin(ctx),
          before: before === undefined ? null : { status: before.status, keep: before.request.keepProductId, supersede: before.request.supersedeProductId },
          after: { status: words(m.status), keep: words(m.request?.keepProductId), supersede: words(m.request?.supersedeProductId), decidedBy: words(m.decidedBy) },
          ...(isStr(m.request?.reason) ? { reason: m.request!.reason! } : {}), correlationId: `merge:${mergeId}`,
        });
      }
      return res;
    });
  mergeAudit('/v1/catalogue/merges/:mergeId', () => 'catalogue.merge.propose');
  mergeAudit('/v1/catalogue/merges/:mergeId/decision', (_ctx, b) => (b['decision'] === 'approved' ? 'catalogue.merge.approve' : 'catalogue.merge.reject'));
  mergeAudit('/v1/catalogue/merges/:mergeId/reverse', () => 'catalogue.merge.reverse');

  // M05-FR-03 "promotion lifecycle audited": an offer stopped from a screen is sealed with who stopped it and why.
  wrap(surface, 'POST', '/v1/promotions/:promotionId/stop', (inner) => async (ctx) => {
    const res = await inner(ctx);
    const b = (isObj(ctx.body) ? ctx.body : {}) as Record<string, unknown>;
    if (ok(res)) {
      await recordAudit(ctx.tenantId, {
        actorId: ctx.userId, action: 'promotion.stop', objectType: 'promotion', objectId: (ctx.params['promotionId'] ?? '').trim(), at: now(), origin: origin(ctx),
        before: null, after: { status: 'stopped' }, ...(isStr(b['reason']) ? { reason: b['reason'].trim().slice(0, 300) } : {}), correlationId: `promotion:${(ctx.params['promotionId'] ?? '').trim()}:stop`,
      });
    }
    return res;
  });

  wrap(surface, 'POST', '/v1/prices/zones/:zoneId/stores/:storeId', (inner) => async (ctx) => {
    const storeId = (ctx.params['storeId'] ?? '').trim();
    const before = (await zones.zones(ctx.tenantId)).filter((z) => z.storeId === storeId).at(-1);
    const res = await inner(ctx);
    if (ok(res)) {
      await recordAudit(ctx.tenantId, {
        actorId: ctx.userId, action: 'price.zone.set', objectType: 'store', objectId: storeId, at: now(), origin: origin(ctx),
        before: before === undefined ? null : { zoneId: before.zoneId }, after: { zoneId: (ctx.params['zoneId'] ?? '').trim() }, correlationId: `price-zone:${storeId}`,
      });
    }
    return res;
  });
}

// ── 2 & 3. the price basis ───────────────────────────────────────────────────────────────────────────────────────────

/** What a scoped price is judged on, read from head office's own registers — each figure null when head office has none. */
export interface PriceBasis {
  readonly productId: string;
  readonly scope: PriceScope;
  readonly scopeRef: string;
  readonly on: string;
  /** The stores the entry reaches: the store; the stores in the zone; every store for a channel or a customer. */
  readonly stores: readonly string[];
  /** The MRP in force on `on` on the product master, or null when it holds none for that day. */
  readonly mrpMinor: number | null;
  readonly mrpFrom: string | null;
  /** The highest average buying cost among `stores` that head office knows, or null when it knows none. */
  readonly costMinor: number | null;
  /** The stores where head office knows no buying cost (nothing received at a cost yet). */
  readonly costNotKnownAt: readonly string[];
  /** The strictest margin floor the owner set in `stores`' rules, or null when none is set. */
  readonly marginFloorBps: number | null;
  readonly floorNotSetAt: readonly string[];
  /** The price this scope charges on `on` before the entry (null: none for this scope), and for a scope that is not a store
   *  with none of its own, the shelf price at each store it reaches — what OB-291's size is judged from. */
  readonly currentPriceMinor: number | null;
  readonly shelfPrices: readonly { readonly storeId: string; readonly priceMinor: number }[];
  /** OB-291: the owner's set size (more than this per cent or this amount needs a second person). */
  readonly secondPersonAbove: { readonly percentBps: number; readonly amountMinor: number };
}

const SCOPES: readonly PriceScope[] = ['store', 'zone', 'channel', 'customer'];
const isScope = (v: unknown): v is PriceScope => typeof v === 'string' && (SCOPES as readonly string[]).includes(v);
const dayOf = (v: string): string => (/^\d{4}-\d{2}-\d{2}/.exec(v)?.[0] ?? v);

function priceBasis(base: Base) {
  const { store, now } = base;
  const products = productMasterAdapter({ store, now });
  const list = priceListAdapter({ store, now });
  const rules = storeRulesAdapter({ store });
  const zones = channelPricingAdapter({ store, now });
  const stores = pricingAdapter({ store, now });
  const reachOf = async (tenantId: string, scope: PriceScope, scopeRef: string): Promise<string[]> => {
    if (scope === 'store') return [scopeRef];
    if (scope === 'zone') {
      const latest = new Map<string, string>();
      for (const z of await zones.zones(tenantId)) latest.set(z.storeId, z.zoneId);
      return [...latest].filter(([, z]) => z === scopeRef).map(([s]) => s).sort();
    }
    return [...new Set(await stores.storesToPrice!(tenantId))].sort();
  };
  return async (tenantId: string, productId: string, scope: PriceScope, scopeRef: string, onDay: string, batchId?: string, atInstant?: string): Promise<PriceBasis> => {
    const [product, entries, reach, costs, thresholds] = await Promise.all([
      products.product(tenantId, productId), list.entries(tenantId, productId), reachOf(tenantId, scope, scopeRef),
      averageBuyingCosts({ store, now, ...(base.calendar === undefined ? {} : { calendar: base.calendar }) }, tenantId),
      priceCheckOf(rulesStoreOf({ store, now, settings: base.settings }), tenantId),
    ]);
    const mrp = (product?.mrpHistory ?? []).filter((m) => dayOf(m.effectiveFrom) <= onDay).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1)).at(-1);
    const knownCosts = reach.map((s) => ({ s, c: costs.costOf(productId, s) }));
    const floors = await Promise.all(reach.map(async (s) => ({ s, f: (await rules.rules(tenantId, s))?.marginFloorBps })));
    // What this scope charges at the moment in question: for a new entry, the instant it would start (so a
    // price that took effect earlier the same day counts); for a read of today, now; for a read of another day, that day's end.
    const at = atInstant ?? (dayOf(now()) === onDay ? now() : `${onDay}T23:59:59.999Z`);
    const same = entries.filter((e) => e.scope === scope && e.scopeRef === scopeRef && (e.batchId ?? null) === (batchId ?? null));
    const ctxFor = (s: string) => ({ productId, at, storeId: scope === 'store' ? scopeRef : s, ...(scope === 'zone' ? { zoneId: scopeRef } : {}), ...(scope === 'channel' ? { channel: scopeRef } : {}), ...(scope === 'customer' ? { customerId: scopeRef } : {}), ...(batchId === undefined ? {} : { batchId }) });
    const current = resolvePrice(same, ctxFor(reach[0] ?? scopeRef));
    const shelfPrices = scope === 'store' || current !== null ? [] : reach.flatMap((s) => {
      const shelf = resolvePrice(entries.filter((e) => e.scope === 'store' && (e.batchId ?? null) === null), { productId, at, storeId: s });
      return shelf === null ? [] : [{ storeId: s, priceMinor: shelf.price.minor }];
    });
    const costed = knownCosts.filter((k) => k.c !== undefined).map((k) => k.c as number);
    const set = floors.filter((f) => f.f !== undefined).map((f) => f.f as number);
    return {
      productId, scope, scopeRef, on: onDay, stores: reach,
      mrpMinor: mrp === undefined ? null : Number(mrp.value.minor), mrpFrom: mrp === undefined ? null : mrp.effectiveFrom,
      costMinor: costed.length === 0 ? null : Math.max(...costed), costNotKnownAt: knownCosts.filter((k) => k.c === undefined).map((k) => k.s),
      marginFloorBps: set.length === 0 ? null : Math.max(...set), floorNotSetAt: floors.filter((f) => f.f === undefined).map((f) => f.s),
      currentPriceMinor: current === null ? null : current.price.minor, shelfPrices,
      secondPersonAbove: { percentBps: thresholds.value.percentBps, amountMinor: thresholds.value.amountMinor },
    };
  };
}

const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

function priceListGuard(surface: Route[], base: Base): void {
  const basisOf = priceBasis(base);
  const calendarDeps = { now: base.now, ...(base.calendar === undefined ? {} : { calendar: base.calendar }) };
  surface.push({
    // What the price screen shows beside a scoped, dated price, and sends with it. Read only.
    api: 'API-02', method: 'GET', path: '/v1/prices/list/:productId/basis',
    permission: 'price.change.propose',
    handler: async (ctx) => {
      const productId = (ctx.params['productId'] ?? '').trim();
      const scope = ctx.query['scope'] ?? 'store';
      const scopeRef = (ctx.query['scopeRef'] ?? '').trim();
      const on = ctx.query['on'] ?? await shopToday(calendarDeps, ctx.tenantId);
      const batchId = isStr(ctx.query['batchId']) ? ctx.query['batchId'].trim() : undefined;
      if (productId === '' || !isScope(scope) || scopeRef === '' || !/^\d{4}-\d{2}-\d{2}$/.test(on)) {
        throw apiError(400, {
          code: 'not_readable_as_a_price_basis', whatHappened: 'The price basis needs the product in the path and ?scope=store|zone|channel|customer&scopeRef=<id>, with ?on=YYYY-MM-DD for the day the price starts.',
          wasItSaved: 'not_saved', nextSafeAction: 'Send the scope, its id and the day. Nothing was changed.',
        });
      }
      return { status: 200, body: { ...(await basisOf(ctx.tenantId, productId, scope, scopeRef, on, batchId)), asAt: base.now() } };
    },
  });

  wrap(surface, 'POST', '/v1/prices/list/:productId/entries/:entryId', (inner) => async (ctx) => {
    const productId = ctx.params['productId'] ?? '';
    const entryId = ctx.params['entryId'] ?? '';
    const b = (isObj(ctx.body) ? ctx.body : {}) as Record<string, unknown>;
    const whole = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
    // Unreadable bodies, an approval named (or a typed approver, refused by name there), back-dating: the route's own rules
    // speak, exactly as before.
    if (!isScope(b['scope']) || !isStr(b['scopeRef']) || !whole(b['priceMinor']) || !whole(b['mrpMinor']) || !whole(b['costMinor'])
      || !Number.isInteger(b['marginFloorBps']) || typeof b['currency'] !== 'string' || !isCurrencyCode(b['currency'])
      || typeof b['effectiveFrom'] !== 'string' || Number.isNaN(Date.parse(b['effectiveFrom'])) || isStr(b['approvalId']) || b['approval'] !== undefined) return inner(ctx);
    const onDay = dayOf(b['effectiveFrom']);
    if (onDay < await shopToday(calendarDeps, ctx.tenantId)) return inner(ctx);
    const batchId = isStr(b['batchId']) ? b['batchId'].trim() : undefined;
    const basis = await basisOf(ctx.tenantId, productId, b['scope'], b['scopeRef'].trim(), onDay, batchId, new Date(Date.parse(b['effectiveFrom'])).toISOString());
    const currency = b['currency'] as CurrencyCode;
    const priceMinor = b['priceMinor'];
    const mrpMinor = basis.mrpMinor === null ? b['mrpMinor'] : Math.min(b['mrpMinor'], basis.mrpMinor);
    const costMinor = basis.costMinor === null ? b['costMinor'] : Math.max(b['costMinor'], basis.costMinor);
    const floor = Math.min(9999, Math.max(Number(b['marginFloorBps']), basis.marginFloorBps ?? 0));
    const check = checkPrice({ id: entryId, proposedPrice: money(priceMinor, currency), mrp: money(mrpMinor, currency), cost: money(costMinor, currency), marginFloorBps: floor, setBy: ctx.userId });
    if (!check.allowed) {
      const why = check.verdict === 'above_mrp'
        ? `The price ${rupees(priceMinor)} is above the MRP of ${rupees(mrpMinor)} ${basis.mrpMinor === null ? 'sent with it' : `on the product master from ${basis.mrpFrom}`} — a legal ceiling no approval can lift.`
        : `The price ${rupees(priceMinor)} is ${check.verdict.replace('_', ' ')}: head office judges it on a cost of ${rupees(costMinor)}${basis.costMinor !== null && basis.costMinor > b['costMinor'] ? ' (its own average buying cost, higher than the cost sent)' : ''} and a margin floor of ${(floor / 100).toFixed(2)}%${basis.marginFloorBps !== null && basis.marginFloorBps > Number(b['marginFloorBps']) ? ' (the store rules\' floor, stricter than the one sent)' : ''}, and it needs a separate approver's sign-off.`;
      throw apiError(422, {
        code: `price_${check.verdict}`, whatHappened: why, wasItSaved: 'not_saved',
        nextSafeAction: check.verdict === 'above_mrp'
          ? 'Set a price at or below the MRP. Nothing was recorded.'
          : 'Ask for approval (POST /v1/approvals/requests, kind price_list_entry, with exactly this entry); once someone who may approve prices approves it, send the approvalId. Nothing was recorded.',
      });
    }
    // OB-291: more than the owner's set size from what this scope charges now (or, for a scope with no price of its own, from
    // the shelf price at a store it reaches) needs a second person — a first price is not a change.
    const t = basis.secondPersonAbove;
    const from = basis.currentPriceMinor !== null ? [{ where: `this ${b['scope']} price`, minor: basis.currentPriceMinor }] : basis.shelfPrices.map((s) => ({ where: `the shelf price at ${s.storeId}`, minor: s.priceMinor }));
    for (const f of from) {
      const size = priceChangeSize(f.minor, priceMinor, t);
      if (size.needsSecondPerson) {
        throw apiError(422, {
          code: 'price_change_needs_second_person',
          whatHappened: `${productId}: ${rupees(priceMinor)} from ${onDay} would move ${f.where} from ${rupees(f.minor)} — a change of ${rupees(size.changeMinor)} (${(size.changeBps / 100).toFixed(2)}%), more than the ${(t.percentBps / 100).toFixed(2)}% or ${rupees(t.amountMinor)} a single person may make (OB-291).`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Ask for approval (POST /v1/approvals/requests, kind price_list_entry, with exactly this entry); once someone who may approve prices approves it, send the approvalId. Nothing was recorded.',
        });
      }
    }
    return inner(ctx);
  });

  if (base.recordAudit !== undefined) {
    const recordAudit = base.recordAudit;
    wrap(surface, 'POST', '/v1/prices/list/:productId/entries/:entryId', (inner) => async (ctx) => {
      const res = await inner(ctx);
      const r = res.body as { entryId?: unknown; productId?: unknown; scope?: unknown; scopeRef?: unknown; priceMinor?: unknown; effectiveFrom?: unknown; version?: unknown; approvedBy?: unknown; batchId?: unknown } | null;
      if (res.status === 201 && r !== null && typeof r.productId === 'string') {
        const b = (isObj(ctx.body) ? ctx.body : {}) as Record<string, unknown>;
        await recordAudit(ctx.tenantId, {
          actorId: ctx.userId, action: 'price.list_entry', objectType: 'product', objectId: r.productId, at: base.now(), origin: origin(ctx), before: null,
          after: {
            entryId: words(r.entryId), scope: words(r.scope), scopeRef: words(r.scopeRef), priceMinor: words(r.priceMinor), effectiveFrom: words(r.effectiveFrom),
            effectiveTo: words(b['effectiveTo']), version: words(r.version), approvedBy: words(r.approvedBy), batchId: words(r.batchId),
          },
          ...(isStr(b['approvalId']) ? { approvalId: b['approvalId'].trim() } : {}), correlationId: `price-list:${r.productId}:${words(r.entryId)}`,
        });
      }
      return res;
    });
  }
}

/** The one line in main.ts. */
export function productsPricesSurface(surface: Route[], input: ProductsPricesInput): void {
  const base: Base = { store: input.store ?? new InMemoryEventStore(), now: input.now, settings: input.settings, ...(input.calendar === undefined ? {} : { calendar: input.calendar }), ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) };
  auditTrailWraps(surface, base);
  priceListGuard(surface, base);
}
