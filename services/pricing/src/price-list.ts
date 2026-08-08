// API-02 the effective-dated, scoped price list (M05-FR-01) — "one price truth" (P-02) resolved by an
// explicit precedence: customer > channel > zone > store base. This is distinct from the governed price
// CHANGE (M05-FR-02, ./index.ts), which records a single flat shelf price with the MRP/margin/§28 gate:
// this surface is the LIST — many scoped, effective-dated entries per product — and the RESOLUTION that
// picks the one that applies at a moment, plus the append-only history.
//
// The rules are the pure `resolvePrice` / `priceHistory` in `packages/price-list` (a complete engine
// nothing fed on the cloud — it only reached the offline pack). This surface gives them persistence,
// a version per (scope, ref) so a sale can lock the entry it referenced, and two refusals at the write
// boundary that the resolver cannot make on its own:
//   • ABOVE MRP IS REFUSED at ANY scope — MRP is a legal ceiling in India, not a shop policy, and
//     nothing (no approval) may lift it. (The discretionary margin floor + §28 is the shelf-price
//     control and stays with the governed change, M05-FR-02.)
//   • BACK-DATING IS REFUSED — an entry effective before today would change what resolvePrice says
//     yesterday's sales should have charged, so the receipts and the reports would stop agreeing.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { resolvePrice, priceHistory, type PriceEntry, type PriceScope, type ResolveContext } from '../../../packages/price-list/src/price-list';
import { money, compare, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';

const SCOPES: readonly PriceScope[] = ['customer', 'channel', 'zone', 'store'];
const isScope = (v: unknown): v is PriceScope => typeof v === 'string' && (SCOPES as readonly string[]).includes(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDateLike = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export interface PriceListDeps {
  readonly entries: (tenantId: string, productId: string) => Promise<readonly PriceEntry[]> | readonly PriceEntry[];
  readonly recordEntry: (tenantId: string, productId: string, entry: PriceEntry) => Promise<void> | void;
  readonly now: () => string;
}

export function priceListRoutes(deps: PriceListDeps): readonly Route[] {
  return [
    {
      // Publish a scoped, effective-dated price-list entry — append-only, with a version assigned per
      // (scope, ref). Above MRP is refused at any scope; back-dating is refused.
      api: 'API-02', method: 'POST', path: '/v1/prices/list/:productId/entries/:entryId',
      permission: 'price.change.propose', idempotent: true,
      handler: async (ctx) => {
        const productId = ctx.params['productId'] ?? '';
        const entryId = ctx.params['entryId'] ?? '';
        const b = (ctx.body ?? {}) as { scope?: unknown; scopeRef?: unknown; priceMinor?: unknown; currency?: unknown; mrpMinor?: unknown; effectiveFrom?: unknown; effectiveTo?: unknown };

        if (!isScope(b.scope) || !isStr(b.scopeRef)
          || !Number.isInteger(b.priceMinor) || (b.priceMinor as number) < 0
          || !Number.isInteger(b.mrpMinor) || (b.mrpMinor as number) < 0
          || typeof b.currency !== 'string' || !isCurrencyCode(b.currency)
          || !isDateLike(b.effectiveFrom)
          || (b.effectiveTo !== undefined && b.effectiveTo !== null && !isDateLike(b.effectiveTo))) {
          throw apiError(400, {
            code: 'not_readable_as_a_price_entry',
            whatHappened: 'A price-list entry needs a scope (customer/channel/zone/store), a scopeRef, a whole priceMinor and mrpMinor, a currency, and an effectiveFrom date.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the scope, ref, price, mrp, currency and effective date. Nothing was recorded.',
          });
        }
        const currency = b.currency as CurrencyCode;
        const priceMinor = b.priceMinor as number;

        // The legal ceiling — refused at any scope, no approval branch (M05-FR-02 §, hard rule spirit).
        if (compare(money(priceMinor, currency), money(b.mrpMinor as number, currency)) > 0) {
          throw apiError(422, {
            code: 'price_above_mrp',
            whatHappened: 'The price is above the printed MRP — a legal ceiling no approval can lift.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Set a price at or below the MRP. Nothing was recorded.',
          });
        }
        // Back-dating is refused — a price active before today rewrites what past sales should have charged.
        if ((b.effectiveFrom as string).slice(0, 10) < deps.now().slice(0, 10)) {
          throw apiError(422, {
            code: 'price_back_dated',
            whatHappened: 'A price-list entry cannot take effect before today — that would change what past sales should have charged.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use today or a future effective date. Nothing was recorded.',
          });
        }

        // Version is monotonic per (scope, ref) — a later entry supersedes on tie, and a sale can lock it.
        const existing = await deps.entries(ctx.tenantId, productId);
        const version = existing
          .filter((e) => e.scope === b.scope && e.scopeRef === b.scopeRef)
          .reduce((max, e) => Math.max(max, e.version), 0) + 1;

        const entry: PriceEntry = {
          id: entryId, productId, scope: b.scope, scopeRef: b.scopeRef,
          price: money(priceMinor, currency),
          effectiveFrom: b.effectiveFrom as string,
          effectiveTo: b.effectiveTo === undefined ? null : (b.effectiveTo as string | null),
          status: 'active', version,
        };
        await deps.recordEntry(ctx.tenantId, productId, entry);
        return { status: 201, body: { entryId, productId, scope: entry.scope, scopeRef: entry.scopeRef, priceMinor, currency, effectiveFrom: entry.effectiveFrom, version } };
      },
    },
    {
      // Resolve the effective price for a product in a context, as of a moment — by precedence, only for
      // published in-window entries. Returns the winning entry (id + version) so a sale can lock to it.
      api: 'API-02', method: 'GET', path: '/v1/prices/list/:productId/resolve',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const productId = ctx.params['productId'] ?? '';
        const q = ctx.query;
        if (!isDateLike(q['at']) || !isStr(q['storeId'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_resolve',
            whatHappened: 'Resolving a price needs at least an "at" date and a "storeId".',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send ?at=<ISO date>&storeId=<id> (optionally zoneId, channel, customerId). Nothing was changed.',
          });
        }
        const ctxIn: ResolveContext = {
          productId, at: q['at'] as string, storeId: q['storeId'] as string,
          ...(isStr(q['zoneId']) ? { zoneId: q['zoneId'] } : {}),
          ...(isStr(q['channel']) ? { channel: q['channel'] } : {}),
          ...(isStr(q['customerId']) ? { customerId: q['customerId'] } : {}),
        };
        const entry = resolvePrice(await deps.entries(ctx.tenantId, productId), ctxIn);
        if (entry === null) throw notFound(`an effective price for ${productId}`);
        return {
          status: 200,
          body: { productId, entryId: entry.id, version: entry.version, scope: entry.scope, scopeRef: entry.scopeRef, priceMinor: entry.price.minor, currency: entry.price.currency, effectiveFrom: entry.effectiveFrom, effectiveTo: entry.effectiveTo ?? null },
        };
      },
    },
    {
      // The full, chronological price history for a product — the append-only who-charged-what record.
      api: 'API-02', method: 'GET', path: '/v1/prices/list/:productId/history',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const productId = ctx.params['productId'] ?? '';
        const all = await deps.entries(ctx.tenantId, productId);
        if (all.length === 0) throw notFound(`a price list for ${productId}`);
        return { status: 200, body: { productId, entries: priceHistory(all, productId) } };
      },
    },
  ];
}
