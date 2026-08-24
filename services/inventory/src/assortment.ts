// API-04 Store assortment & range review (M04-FR-01 · D02) — tested since the module was written, used by
// the ERP screen, on NO cloud route. The assortment answers "does THIS store carry this item?", and it has
// to be an answer, not a habit. Two failures come from not having one, and the check catches both:
//
//   • ORDERING WHAT YOU DO NOT SELL — replenishment cheerfully reorders an item this branch dropped
//     eighteen months ago, because nothing ever said stop (`reordered_not_listed`).
//   • SELLING WHAT YOU DO NOT STOCK — an item rings up at a store with no space, no reorder point and no
//     supplier line, sells once and disappoints every customer who comes back (`sold_not_in_assortment`).
//
// The DANGEROUS operation is DROPPING an item: deleting it from the range while stock sits on the shelf is
// how stock becomes invisible — not counted, not replenished, not sold, eventually written off. So a drop
// with stock on hand does NOT delete; the tested `dropFromRange` routes it to CLEARANCE, where it stays
// sellable until it is gone, and it is never reordered. Every range decision is effective-dated and names
// its reason and who made it, because "why did we stop carrying this?" is asked six months later by someone
// who was not in the meeting.
//
// The rules are the tested `dropFromRange` / `checkAssortmentIntegrity` / `Assortment` in `@sre/merchandising`
// (the `services-run-on-their-tested-engine` guardrail). Range entries are recorded append-only, per store;
// the reads fold them into an `Assortment` resolved as-at a date. Gated `merchandising.range.manage` to
// list/drop, `merchandising.range.read` to check integrity and read the range.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  dropFromRange, checkAssortmentIntegrity, Assortment, RangeDecisionError,
  type AssortmentEntry, type DropReason,
} from '../../../packages/merchandising/src/index';

const DROP_REASONS: readonly DropReason[] = ['poor_sales', 'poor_margin', 'supplier_discontinued', 'quality_issue', 'range_rationalisation', 'seasonal_end', 'replaced_by_alternative'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isDate = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
const onHandMap = (v: unknown): Readonly<Record<string, number>> | undefined =>
  v === undefined ? {} : (isObj(v) && Object.values(v).every((n) => isInt(n) && (n as number) >= 0) ? (v as Record<string, number>) : undefined);

export interface AssortmentDeps {
  /** Every range entry recorded for a store — append-only, effective-dated; the reads fold them. */
  readonly entries: (tenantId: string, storeId: string) => Promise<readonly AssortmentEntry[]> | readonly AssortmentEntry[];
  readonly recordEntry: (tenantId: string, storeId: string, entry: AssortmentEntry, key: string) => Promise<void> | void;
  readonly now: () => string;
}

export function assortmentRoutes(deps: AssortmentDeps): readonly Route[] {
  return [
    {
      // List an item into a store's range. Body: { effectiveFrom }. Effective-dated; decided by the caller.
      api: 'API-04', method: 'POST', path: '/v1/merchandising/assortment/:storeId/:productId/list',
      permission: 'merchandising.range.manage', idempotent: true,
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (storeId === '' || productId === '' || !isDate(b['effectiveFrom'])) {
          throw apiError(400, { code: 'not_readable_as_a_listing', whatHappened: 'Listing an item needs storeId + productId in the path and { effectiveFrom (YYYY-MM-DD) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date the item joins the range. Who decided it is taken from your login.' });
        }
        const entry: AssortmentEntry = { storeId, productId, status: 'listed', effectiveFrom: b['effectiveFrom'] as string, decidedBy: ctx.userId };
        await deps.recordEntry(ctx.tenantId, storeId, entry, ctx.idempotencyKey ?? `list-${storeId}-${productId}-${entry.effectiveFrom}`);
        return { status: 201, body: { storeId, productId, status: 'listed', effectiveFrom: entry.effectiveFrom, decidedBy: ctx.userId } };
      },
    },
    {
      // Drop an item from a store's range. With stock on hand this becomes a CLEARANCE listing, never a
      // deletion (which would make the stock invisible). Body: { onHandMinor, reason, reasonNote?,
      // effectiveFrom, replacedByProductId? }. Decided by the caller.
      api: 'API-04', method: 'POST', path: '/v1/merchandising/assortment/:storeId/:productId/drop',
      permission: 'merchandising.range.manage', idempotent: true,
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (storeId === '' || productId === '' || !isInt(b['onHandMinor']) || (b['onHandMinor'] as number) < 0
          || !DROP_REASONS.includes(b['reason'] as DropReason) || !isDate(b['effectiveFrom'])
          || (b['reasonNote'] !== undefined && typeof b['reasonNote'] !== 'string')
          || (b['replacedByProductId'] !== undefined && !isStr(b['replacedByProductId']))) {
          throw apiError(400, { code: 'not_readable_as_a_drop', whatHappened: 'A drop needs storeId + productId in the path and { onHandMinor (whole ≥ 0), reason (poor_sales/poor_margin/supplier_discontinued/quality_issue/range_rationalisation/seasonal_end/replaced_by_alternative), effectiveFrom, reasonNote?, replacedByProductId? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send why it is being dropped and how much is still on hand. Who decided it is taken from your login.' });
        }
        let decision;
        try {
          decision = dropFromRange({
            storeId, productId, onHandMinor: b['onHandMinor'] as number, reason: b['reason'] as DropReason,
            decidedBy: ctx.userId, effectiveFrom: b['effectiveFrom'] as string,
            ...(isStr(b['reasonNote']) ? { reasonNote: b['reasonNote'] } : {}),
            ...(isStr(b['replacedByProductId']) ? { replacedByProductId: b['replacedByProductId'] } : {}),
          });
        } catch (e) {
          if (e instanceof RangeDecisionError) {
            throw apiError(422, { code: 'range_decision_refused', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the decision and send it again. Nothing was saved.' });
          }
          throw e;
        }
        await deps.recordEntry(ctx.tenantId, storeId, decision.entry, ctx.idempotencyKey ?? `drop-${storeId}-${productId}-${decision.entry.effectiveFrom}`);
        return { status: 201, body: { storeId, productId, outcome: decision.outcome, status: decision.entry.status, effectiveFrom: decision.entry.effectiveFrom, detail: decision.detail } };
      },
    },
    {
      // Check the range against what the store actually did. STATIC "integrity" — 5 segments, so it never
      // collides with the 6-segment `/:productId/list|drop`. Body: { onDate, soldProductIds[],
      // reorderedProductIds?, onHand? }. A pure read/compute over the recorded range + supplied activity.
      api: 'API-04', method: 'POST', path: '/v1/merchandising/assortment/:storeId/integrity',
      permission: 'merchandising.range.read', idempotent: true,
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const sold = strArray(b['soldProductIds']);
        const reordered = b['reorderedProductIds'] === undefined ? [] : strArray(b['reorderedProductIds']);
        const onHand = onHandMap(b['onHand']);
        if (storeId === '' || !isDate(b['onDate']) || sold === undefined || reordered === undefined || onHand === undefined) {
          throw apiError(400, { code: 'not_readable_as_an_integrity_check', whatHappened: 'An integrity check needs storeId in the path and { onDate (YYYY-MM-DD), soldProductIds[], reorderedProductIds?, onHand?{ productId: whole ≥ 0 } }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date and what was sold, reordered and on hand.' });
        }
        const assortment = new Assortment(storeId, await deps.entries(ctx.tenantId, storeId));
        const issues = checkAssortmentIntegrity({
          assortment, onDate: b['onDate'] as string, soldProductIds: sold,
          ...(reordered.length > 0 ? { reorderedProductIds: reordered } : {}),
          ...(Object.keys(onHand).length > 0 ? { onHand } : {}),
        });
        return { status: 200, body: { storeId, onDate: b['onDate'], issues, count: issues.length } };
      },
    },
    {
      // What this store carries on a date — the listed products (clearance/delisted are not "carried").
      // `?onDate=` (defaults to today).
      api: 'API-04', method: 'GET', path: '/v1/merchandising/assortment/:storeId',
      permission: 'merchandising.range.read',
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        const onDate = isDate(ctx.query['onDate']) ? ctx.query['onDate'] as string : deps.now().slice(0, 10);
        const assortment = new Assortment(storeId, await deps.entries(ctx.tenantId, storeId));
        const listed = assortment.listedOn(onDate);
        return { status: 200, body: { storeId, onDate, listed, count: listed.length } };
      },
    },
  ];
}
