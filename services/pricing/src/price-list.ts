// API-02 the effective-dated, scoped price list (M05-FR-01) — "one price truth" (P-02) resolved by an
// explicit precedence: customer > channel > zone > store base. Many scoped, effective-dated entries per
// product, and the RESOLUTION that picks the one that applies at a moment, plus the append-only history.
//
// The rules are the pure `resolvePrice` / `priceHistory` in `packages/price-list` (a complete engine that
// only ever reached the offline pack). This surface gives them persistence, a version per (scope, ref) so a
// sale can lock the entry it referenced, and the FULL price gate at the write boundary:
//   • ABOVE MRP IS REFUSED at ANY scope — MRP is a legal ceiling in India, not a shop policy, and nothing
//     (no approval) may lift it.
//   • BELOW COST / BELOW THE MARGIN FLOOR IS REFUSED unless a SEPARATE approver who genuinely holds
//     `price.change.approve` signs it off with a reason (§28, M05-FR-02). This is the SAME `checkPrice`
//     engine the governed price-change surface (./index.ts) uses — the two doors now enforce one control,
//     because a below-cost price reaching the till through this route unapproved was a real gap (a price a
//     resolved sale actually charges, produced here, must clear the same gate as the flat shelf price).
//   • BACK-DATING IS REFUSED — an entry effective before today would change what resolvePrice says
//     yesterday's sales should have charged, so the receipts and the reports would stop agreeing.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { resolvePrice, priceHistory, type PriceEntry, type PriceScope, type ResolveContext } from '../../../packages/price-list/src/price-list';
import { money, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';
import { checkPrice } from '../../../packages/price-guard/src/price-guard';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';

const SCOPES: readonly PriceScope[] = ['customer', 'channel', 'zone', 'store'];
const isScope = (v: unknown): v is PriceScope => typeof v === 'string' && (SCOPES as readonly string[]).includes(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDateLike = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

export interface PriceListDeps {
  readonly entries: (tenantId: string, productId: string) => Promise<readonly PriceEntry[]> | readonly PriceEntry[];
  readonly recordEntry: (tenantId: string, productId: string, entry: PriceEntry) => Promise<void> | void;
  /** Whether a user holds `price.change.approve` — the §28 approver of a below-cost/floor price must genuinely hold it. */
  readonly canApprove: (tenantId: string, userId: string) => Promise<boolean>;
  readonly now: () => string;
}

export function priceListRoutes(deps: PriceListDeps): readonly Route[] {
  return [
    {
      // Publish a scoped, effective-dated price-list entry — append-only, versioned per (scope, ref). It
      // clears the full price gate: above MRP refused; below cost / below the margin floor refused unless a
      // separate approver (§28) signs off; back-dating refused. A below-cost price no longer reaches the till
      // through this route without the same approval the governed change requires.
      api: 'API-02', method: 'POST', path: '/v1/prices/list/:productId/entries/:entryId',
      permission: 'price.change.propose', idempotent: true,
      handler: async (ctx) => {
        const productId = ctx.params['productId'] ?? '';
        const entryId = ctx.params['entryId'] ?? '';
        const b = (ctx.body ?? {}) as { scope?: unknown; scopeRef?: unknown; priceMinor?: unknown; currency?: unknown; mrpMinor?: unknown; costMinor?: unknown; marginFloorBps?: unknown; effectiveFrom?: unknown; effectiveTo?: unknown; approval?: unknown };

        if (!isScope(b.scope) || !isStr(b.scopeRef)
          || !isNonNegInt(b.priceMinor) || !isNonNegInt(b.mrpMinor) || !isNonNegInt(b.costMinor)
          || !Number.isInteger(b.marginFloorBps) || (b.marginFloorBps as number) < 0 || (b.marginFloorBps as number) > 9999
          || typeof b.currency !== 'string' || !isCurrencyCode(b.currency)
          || !isDateLike(b.effectiveFrom)
          || (b.effectiveTo !== undefined && b.effectiveTo !== null && !isDateLike(b.effectiveTo))) {
          throw apiError(400, {
            code: 'not_readable_as_a_price_entry',
            whatHappened: 'A price-list entry needs a scope (customer/channel/zone/store), a scopeRef, whole priceMinor, mrpMinor and costMinor, a marginFloorBps (0–9999), a currency, and an effectiveFrom date.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the scope, ref, price, mrp, cost, margin floor, currency and effective date. Nothing was recorded.',
          });
        }
        const currency = b.currency as CurrencyCode;
        const priceMinor = b.priceMinor as number;
        const setBy = ctx.userId;

        // Back-dating is refused first — checkPrice does not judge dates, and a price active before today
        // rewrites what past sales should have charged.
        if ((b.effectiveFrom as string).slice(0, 10) < deps.now().slice(0, 10)) {
          throw apiError(422, {
            code: 'price_back_dated',
            whatHappened: 'A price-list entry cannot take effect before today — that would change what past sales should have charged.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use today or a future effective date. Nothing was recorded.',
          });
        }

        // A supplied §28 approval: the approver may not be the setter, and must genuinely hold the approve
        // permission — a named approver who cannot approve prices is not an approval.
        let approval: DecidedRequest | undefined;
        const appr = b.approval as { decidedBy?: unknown; reason?: unknown } | undefined;
        if (appr !== undefined && typeof appr.decidedBy === 'string' && appr.decidedBy.trim() !== '') {
          const approver = appr.decidedBy;
          if (approver === setBy) {
            throw apiError(422, { code: 'approved_by_the_setter', whatHappened: `${setBy} cannot approve their own price change (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'Have someone else approve it. Nothing was recorded.' });
          }
          if (!(await deps.canApprove(ctx.tenantId, approver))) {
            throw apiError(422, { code: 'approver_may_not_approve_prices', whatHappened: `${approver} does not hold price.change.approve, so their approval does not count.`, wasItSaved: 'not_saved', nextSafeAction: 'Have someone who may approve prices approve it. Nothing was recorded.' });
          }
          approval = Object.freeze({
            id: entryId, subjectType: 'price', subjectRef: entryId, requestedBy: setBy, branchId: ctx.branchId,
            value: null, status: 'approved', decidedBy: approver, reason: typeof appr.reason === 'string' ? appr.reason : '', decidedAt: deps.now(),
          }) as DecidedRequest;
        }

        // The governed gate — the SAME `checkPrice` engine the M05-FR-02 change route uses (pure and
        // deterministic; the identical check runs on the offline edge). Above MRP is refused with no approval
        // path; below cost / below floor is refused unless the separate approval above is valid.
        const check = checkPrice({
          id: entryId,
          proposedPrice: money(priceMinor, currency),
          mrp: money(b.mrpMinor as number, currency),
          cost: money(b.costMinor as number, currency),
          marginFloorBps: b.marginFloorBps as number,
          setBy,
          ...(approval === undefined ? {} : { approval }),
        });
        if (!check.allowed) {
          throw apiError(422, {
            code: `price_${check.verdict}`,
            whatHappened: check.verdict === 'above_mrp'
              ? 'The price is above the printed MRP — a legal ceiling no approval can lift.'
              : `The price is ${check.verdict.replace('_', ' ')} and needs a separate approver's sign-off with a reason.`,
            wasItSaved: 'not_saved',
            nextSafeAction: check.verdict === 'above_mrp'
              ? 'Set a price at or below the MRP. Nothing was recorded.'
              : 'Have someone who is not the setter, and who may approve prices, approve it with a reason. Nothing was recorded.',
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
        return { status: 201, body: { entryId, productId, scope: entry.scope, scopeRef: entry.scopeRef, priceMinor, currency, effectiveFrom: entry.effectiveFrom, version, approvedBy: approval?.decidedBy ?? null } };
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
