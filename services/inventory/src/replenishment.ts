// API-04 replenishment suggestions (M09-FR-02). Work out WHAT to reorder and HOW MUCH from per-product
// parameters (reorder point / safety / max, or demand × lead time). The output is a PROPOSAL a buyer
// approves — ADVISORY ONLY, it can never become a purchase order by itself (hard rule #5 / AI-NFR-12:
// automation may recommend a reorder, only an authorised human commits the PO). Parameters drive every
// number, a blocked/discontinued item is suppressed, and the maths is pure — the same on the edge or in
// the cloud. The rule is the pure `proposeReplenishmentBatch` engine in `packages/replenishment`; this
// surface is a stateless what-if over the supplied stock/parameter inputs (it reads, it never commits).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  proposeReplenishmentBatch, InvalidReplenishmentParameterError, type ReplenishmentInput,
} from '../../../packages/replenishment/src/replenishment';

export interface ReplenishmentRoutesDeps {
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const OPTIONAL_INTS = ['onOrder', 'reserved', 'maxLevel', 'safetyStock', 'reorderPoint', 'avgDailyDemand', 'leadTimeDays', 'minOrderQty', 'orderMultiple'] as const;

/** Read one item as a ReplenishmentInput, or null if malformed (a 400, not an engine refusal). */
function readItem(v: unknown): ReplenishmentInput | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (!isStr(r['productId']) || !isInt(r['onHand']) || !isInt(r['maxLevel'])) return null;
  for (const k of OPTIONAL_INTS) if (r[k] !== undefined && !isInt(r[k])) return null;
  if (r['blocked'] !== undefined && typeof r['blocked'] !== 'boolean') return null;
  return {
    productId: r['productId'] as string, onHand: r['onHand'] as number, maxLevel: r['maxLevel'] as number,
    ...(isInt(r['onOrder']) ? { onOrder: r['onOrder'] as number } : {}),
    ...(isInt(r['reserved']) ? { reserved: r['reserved'] as number } : {}),
    ...(isInt(r['safetyStock']) ? { safetyStock: r['safetyStock'] as number } : {}),
    ...(isInt(r['reorderPoint']) ? { reorderPoint: r['reorderPoint'] as number } : {}),
    ...(isInt(r['avgDailyDemand']) ? { avgDailyDemand: r['avgDailyDemand'] as number } : {}),
    ...(isInt(r['leadTimeDays']) ? { leadTimeDays: r['leadTimeDays'] as number } : {}),
    ...(isInt(r['minOrderQty']) ? { minOrderQty: r['minOrderQty'] as number } : {}),
    ...(isInt(r['orderMultiple']) ? { orderMultiple: r['orderMultiple'] as number } : {}),
    ...(r['blocked'] === true ? { blocked: true } : {}),
  };
}

export function replenishmentRoutes(deps: ReplenishmentRoutesDeps): readonly Route[] {
  return [
    {
      // Propose reorders for the supplied items — advisory only; only those below their reorder point come
      // back, each brought up to its max level (rounded to the pack, raised to the supplier minimum).
      api: 'API-04', method: 'POST', path: '/v1/replenishment/propose',
      permission: 'inventory.availability.read', idempotent: true,
      handler: (ctx) => {
        const b = (ctx.body ?? {}) as { items?: unknown };
        if (!Array.isArray(b.items)) {
          throw apiError(400, {
            code: 'not_readable_as_replenishment',
            whatHappened: 'Replenishment needs an items list, each with a productId, whole onHand and whole maxLevel (reorder/safety/demand/lead/moq/multiple optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "items": [ … ] }. Nothing was changed; replenishment only reads.',
          });
        }
        const items: ReplenishmentInput[] = [];
        for (const raw of b.items) {
          const item = readItem(raw);
          if (item === null) {
            throw apiError(400, {
              code: 'not_readable_as_an_item',
              whatHappened: 'Each item needs a productId and whole numbers for the stock parameters.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Fix the items and re-send. Nothing was changed.',
            });
          }
          items.push(item);
        }
        try {
          const proposals = proposeReplenishmentBatch(items);
          return { status: 200, body: { proposals, count: proposals.length, asAt: deps.now() } };
        } catch (e) {
          if (e instanceof InvalidReplenishmentParameterError) {
            throw apiError(400, { code: 'invalid_replenishment_parameter', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the parameter and re-send. Nothing was changed.' });
          }
          throw e;
        }
      },
    },
  ];
}
