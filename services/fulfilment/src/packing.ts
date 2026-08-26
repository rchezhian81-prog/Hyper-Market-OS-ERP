// Packing & dispatch on the fulfilment API (M19-FR-02 / D09 / M10-FR-02, API-08).
//
// Between the shelf and the van there is one moment where the shop can still catch a mistake for
// free, and one where it can make an expensive one. Both are wired here, on the tested
// `packages/fulfilment` packing engine:
//
//   • A WEIGHED LINE'S FINAL PRICE IS CAPTURED AT PACK (D09) — priced in exact integer minor units
//     from the packed grams, never a guess at the doorstep.
//   • A COLD ITEM PACKED WARM IS ONE THE CUSTOMER CANNOT EAT — a missing temperature is a failure,
//     the same rule the goods-in door applies.
//   • A CRATE CANNOT MIX INCOMPATIBLE HANDLING — frozen with ambient, raw meat over ready-to-eat;
//     these are refusals, not warnings, and one bad crate never stops the rest of the order.
//   • THE DISPATCH MANIFEST IS DERIVED FROM WHAT WAS PACKED, NEVER FROM WHAT WAS ORDERED. That is
//     why the pack is RECORDED here and the dispatch reads it back: a manifest the caller could
//     re-supply would be a list of what the shop hoped to send, and the driver finds out the rest.
//
// Recording gated `fulfilment.pack.record`; the reads `fulfilment.pack.read`. Append-only.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  packOrder, dispatchOrder,
  type PackLine, type HandlingClass, type HandlingRule, type PackResult, type Manifest,
} from '../../../packages/fulfilment/src/index';

export type { PackResult, Manifest } from '../../../packages/fulfilment/src/index';

const HANDLING: readonly HandlingClass[] = ['ambient', 'chilled', 'frozen', 'raw_meat', 'ready_to_eat', 'fragile', 'hazardous'];

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** A caller-supplied { [k]: string } map, or undefined if it is not one. */
function readStrRecord(v: unknown): Readonly<Record<string, string>> | undefined {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return undefined;
    out[k] = val;
  }
  return out;
}

/** Validate one caller-supplied pack line into a PackLine (orderId taken from the path), or undefined. */
function readLine(v: unknown, orderId: string): PackLine | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const l = v as Record<string, unknown>;
  if (!isStr(l['lineId']) || !isStr(l['productId']) || !isStr(l['name']) || !isStr(l['uom'])
    || !HANDLING.includes(l['handling'] as HandlingClass)
    || !isNonNegInt(l['orderedMinor']) || !isNonNegInt(l['pickedMinor']) || !isNonNegInt(l['unitPriceMinor'])
    || (l['weighed'] !== undefined && typeof l['weighed'] !== 'boolean')
    || (l['packedGrams'] !== undefined && !isInt(l['packedGrams']))
    || (l['packTenthsC'] !== undefined && !isInt(l['packTenthsC']))) {
    return undefined;
  }
  return {
    lineId: l['lineId'], orderId, productId: l['productId'], name: l['name'],
    handling: l['handling'] as HandlingClass, orderedMinor: l['orderedMinor'], pickedMinor: l['pickedMinor'],
    uom: l['uom'], unitPriceMinor: l['unitPriceMinor'],
    ...(l['weighed'] === true ? { weighed: true } : {}),
    ...(isInt(l['packedGrams']) ? { packedGrams: l['packedGrams'] } : {}),
    ...(isInt(l['packTenthsC']) ? { packTenthsC: l['packTenthsC'] } : {}),
  };
}

/** Optional per-product cold-chain overrides. */
function readRule(v: unknown): HandlingRule | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (!HANDLING.includes(r['handling'] as HandlingClass)
    || (r['maxTenthsC'] !== undefined && !isInt(r['maxTenthsC']))
    || (r['minTenthsC'] !== undefined && !isInt(r['minTenthsC']))) {
    return undefined;
  }
  return {
    handling: r['handling'] as HandlingClass,
    ...(isInt(r['maxTenthsC']) ? { maxTenthsC: r['maxTenthsC'] } : {}),
    ...(isInt(r['minTenthsC']) ? { minTenthsC: r['minTenthsC'] } : {}),
  };
}

export interface FulfilmentPackingDeps {
  readonly pack: (tenantId: string, orderId: string) => Promise<PackResult | undefined> | PackResult | undefined;
  readonly recordPack: (tenantId: string, orderId: string, result: PackResult, key: string) => Promise<void> | void;
  readonly manifest: (tenantId: string, orderId: string) => Promise<Manifest | undefined> | Manifest | undefined;
  readonly recordDispatch: (tenantId: string, orderId: string, manifest: Manifest, key: string) => Promise<void> | void;
  readonly now: () => string;
}

const packDigest = (r: PackResult): string =>
  [r.outcome, r.totalMinor, r.lines.map((l) => `${l.lineId}:${l.finalPriceMinor}:${l.crateId}`).join(','), r.refused.map((x) => `${x.lineId}:${x.reason}`).join(',')].join('|');

export function fulfilmentPackingRoutes(deps: FulfilmentPackingDeps): readonly Route[] {
  return [
    {
      // Pack an order — price weighed lines at their packed weight, refuse unsafe crates, and RECORD the
      // result so dispatch can build the manifest from what was packed. Body: { lines:[PackLine],
      // crateAssignment?:{lineId:crateId}, rules?:[HandlingRule] }. A refused line does not stop the rest.
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/orders/:orderId/pack',
      permission: 'fulfilment.pack.record', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const rawLines = b['lines'];
        const lines = Array.isArray(rawLines) ? rawLines.map((l) => readLine(l, orderId)) : undefined;
        const crateAssignment = readStrRecord(b['crateAssignment']);
        const rawRules = b['rules'];
        const rules = rawRules === undefined ? undefined : Array.isArray(rawRules) ? rawRules.map(readRule) : [undefined];
        if (orderId === '' || lines === undefined || lines.length === 0 || lines.some((l) => l === undefined)
          || crateAssignment === undefined || (rules !== undefined && rules.some((r) => r === undefined))) {
          throw apiError(400, {
            code: 'not_readable_as_a_pack',
            whatHappened: 'Packing an order needs an orderId in the path and { lines: [{ lineId, productId, name, handling (ambient/chilled/frozen/raw_meat/ready_to_eat/fragile/hazardous), orderedMinor, pickedMinor, uom, unitPriceMinor, weighed?, packedGrams?, packTenthsC? }], crateAssignment?, rules? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the lines as they were actually picked and packed, with a temperature for every chilled/frozen line and a weight for every weighed line.',
          });
        }
        const result = packOrder({
          orderId, lines: lines as PackLine[], crateAssignment,
          ...(rules !== undefined ? { rules: rules as HandlingRule[] } : {}),
          at: deps.now(),
        });
        // Recorded even when some lines are refused — the pack is the honest record of what can be sent.
        await deps.recordPack(ctx.tenantId, orderId, result, packDigest(result));
        return { status: 200, body: result };
      },
    },
    {
      // Dispatch the order — build the manifest FROM THE RECORDED PACK, refuse an unsealed crate or an
      // unresolved short/refused line, and record the manifest. Body: { manifestId, locationId, seals:{
      // crateId:seal }, resolvedLineIds?:[lineId] }. dispatchedBy is the authenticated caller.
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/orders/:orderId/dispatch',
      permission: 'fulfilment.pack.record', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const seals = readStrRecord(b['seals']);
        const rawResolved = b['resolvedLineIds'];
        const resolvedLineIds = rawResolved === undefined ? [] : Array.isArray(rawResolved) && rawResolved.every((x) => typeof x === 'string') ? (rawResolved as string[]) : undefined;
        if (orderId === '' || !isStr(b['manifestId']) || !isStr(b['locationId']) || seals === undefined || resolvedLineIds === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_dispatch',
            whatHappened: 'Dispatch needs an orderId in the path and { manifestId, locationId, seals:{crateId:seal}, resolvedLineIds? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Seal every crate and name any short or refused lines the customer has been told about, then dispatch.',
          });
        }
        const pack = await deps.pack(ctx.tenantId, orderId);
        if (pack === undefined) {
          throw apiError(409, {
            code: 'no_pack_recorded',
            whatHappened: `Order ${orderId} has not been packed — there is nothing to dispatch, and a manifest must be built from what was packed, not from what was ordered.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Pack the order first (POST …/pack), then dispatch it.',
          });
        }
        const result = dispatchOrder({
          manifestId: b['manifestId'] as string, orderId, locationId: b['locationId'] as string,
          pack, seals, resolvedLineIds, dispatchedBy: ctx.userId, at: deps.now(),
        });
        if (!result.dispatched) {
          // A refusal means nothing left the building — nothing is recorded (409, not a silent 200).
          throw apiError(409, {
            code: result.outcome,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: result.outcome === 'unsealed_crate'
              ? 'Seal every crate and dispatch again.'
              : result.outcome === 'unresolved_lines'
                ? 'Tell the customer about the short or refused lines and mark them resolved, then dispatch again.'
                : 'Pack the order before dispatching it.',
          });
        }
        await deps.recordDispatch(ctx.tenantId, orderId, result.manifest!, result.manifest!.manifestId);
        return { status: 200, body: result };
      },
    },
    {
      // The recorded pack for an order — what can be sent, priced, with the refusals listed.
      api: 'API-08', method: 'GET', path: '/v1/fulfilment/orders/:orderId/pack',
      permission: 'fulfilment.pack.read',
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const pack = await deps.pack(ctx.tenantId, orderId);
        if (pack === undefined) throw notFound(`pack for order ${orderId}`);
        return { status: 200, body: pack };
      },
    },
    {
      // The dispatch manifest — derived from what was packed, with its cold-chain readings and crate seals.
      api: 'API-08', method: 'GET', path: '/v1/fulfilment/orders/:orderId/manifest',
      permission: 'fulfilment.pack.read',
      handler: async (ctx) => {
        const orderId = ctx.params['orderId'] ?? '';
        const manifest = await deps.manifest(ctx.tenantId, orderId);
        if (manifest === undefined) throw notFound(`manifest for order ${orderId}`);
        return { status: 200, body: manifest };
      },
    },
  ];
}
