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
//   • FUL-04 (Batch 2): THE DESK PACKS AN ORDER HEAD OFFICE HOLDS, UNDER HEAD OFFICE'S RULES. The order and its ordered
//     quantities come from the order register (an unknown order is refused by name); each product's handling class and
//     cold-chain limits come from the product master through the SAME resolver the wave path uses (`masterPacking`); its
//     name and price from the published catalogue. The desk sends only what it OBSERVED — what was picked, the packed
//     grams, the temperature, the crate. A body that carries safety rules, a handling class, an ordered quantity or a price
//     is refused by name (`pack_carries_caller_rules`): a `rules: []` must never switch the cold chain off.
//
// Recording gated `fulfilment.pack.record`; the reads `fulfilment.pack.read`. Append-only.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  packOrder, dispatchOrder,
  type PackLine, type HandlingClass, type PackResult, type Manifest,
} from '../../../packages/fulfilment/src/index';
import { normaliseUom } from '../../../packages/contracts/src/quantity';

export type { PackResult, Manifest } from '../../../packages/fulfilment/src/index';

export const HANDLING: readonly HandlingClass[] = ['ambient', 'chilled', 'frozen', 'raw_meat', 'ready_to_eat', 'fragile', 'hazardous'];

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

/** What the desk OBSERVED for one product on the order — the only thing it may say (FUL-04). */
export interface DeskObservation {
  readonly productId: string;
  readonly pickedMinor: number;
  readonly packedGrams?: number;
  readonly packTenthsC?: number;
}

/** The fields that are head office's to say, never the desk's: a body naming any of them is refused by name (FUL-04). */
const AUTHORITY_FIELDS: readonly string[] = ['handling', 'orderedMinor', 'unitPriceMinor', 'coldChain', 'weighed', 'rules', 'finalPriceMinor'];

/** Read one observed line strictly; a line naming an authority field is reported, never silently ignored. */
function readObservation(v: unknown): DeskObservation | 'carries_rules' | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const l = v as Record<string, unknown>;
  if (AUTHORITY_FIELDS.some((f) => l[f] !== undefined)) return 'carries_rules';
  if (!isStr(l['productId']) || !isNonNegInt(l['pickedMinor'])
    || (l['packedGrams'] !== undefined && !isInt(l['packedGrams']))
    || (l['packTenthsC'] !== undefined && !isInt(l['packTenthsC']))) {
    return undefined;
  }
  return {
    productId: l['productId'].trim(), pickedMinor: l['pickedMinor'],
    ...(isInt(l['packedGrams']) ? { packedGrams: l['packedGrams'] } : {}),
    ...(isInt(l['packTenthsC']) ? { packTenthsC: l['packTenthsC'] } : {}),
  };
}

/** What the product master says about packing a product (HA-3): how it travels, and its own cold-chain limits when set. */
export interface MasterPacking {
  readonly handling?: HandlingClass;
  readonly coldChain?: { readonly minTenthsC?: number; readonly maxTenthsC?: number };
}

/**
 * FUL-04 — the ONE packing-policy resolver the desk and the wave paths share: the product master's handling class and its
 * own cold-chain limits (else the engine's approved class default, said on the line). A product the master names no
 * handling class for is refused `handling_unknown` — never defaulted, never read off its name. Pure.
 */
export function masterPacking(packing: MasterPacking | undefined, productId: string, name: string):
  { readonly ok: true; readonly handling: HandlingClass; readonly coldChain?: MasterPacking['coldChain'] }
  | { readonly ok: false; readonly refusal: { readonly lineId: string; readonly reason: 'handling_unknown'; readonly detail: string } } {
  if (packing?.handling === undefined || !HANDLING.includes(packing.handling)) {
    return { ok: false, refusal: { lineId: productId, reason: 'handling_unknown', detail: `${name}: the product master names no handling class for ${productId} — it cannot be packed until a person sets one (never guessed from its name)` } };
  }
  return { ok: true, handling: packing.handling, ...(packing.coldChain === undefined ? {} : { coldChain: packing.coldChain }) };
}

/** The order as head office's order register holds it — what was asked for, per product, and where it stands. */
export interface OrderForPacking {
  readonly state: string;
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number }[];
}

/** The published catalogue's word on a product: its name, its price per whole unit, and the unit it is sold in. */
export interface ProductForPacking {
  readonly name: string;
  readonly unitPriceMinor: number;
  readonly uom: string;
}

const PACKABLE_STATES: readonly string[] = ['confirmed', 'picking', 'packed'];

export interface FulfilmentPackingDeps {
  /** FUL-04: the order as head office's order register holds it, or undefined when there is no such order. */
  readonly order: (tenantId: string, orderId: string) => Promise<OrderForPacking | undefined> | OrderForPacking | undefined;
  /** FUL-04: the product master's packing facts (the same resolver input the wave path reads). */
  readonly productPacking: (tenantId: string, productId: string) => Promise<MasterPacking | undefined> | MasterPacking | undefined;
  /** FUL-04: the published catalogue's name, price and unit for a product, or undefined. */
  readonly productFacts: (tenantId: string, productId: string) => Promise<ProductForPacking | undefined> | ProductForPacking | undefined;
  readonly pack: (tenantId: string, orderId: string) => Promise<PackResult | undefined> | PackResult | undefined;
  readonly recordPack: (tenantId: string, orderId: string, result: PackResult, key: string) => Promise<void> | void;
  readonly manifest: (tenantId: string, orderId: string) => Promise<Manifest | undefined> | Manifest | undefined;
  readonly recordDispatch: (tenantId: string, orderId: string, manifest: Manifest, key: string) => Promise<void> | void;
  readonly now: () => string;
}

/** What makes two packs the same pack — the key a retry collapses on (the wave fold uses it too). */
export const packDigest = (r: PackResult): string =>
  [r.outcome, r.totalMinor, r.lines.map((l) => `${l.lineId}:${l.finalPriceMinor}:${l.crateId}`).join(','), r.refused.map((x) => `${x.lineId}:${x.reason}`).join(',')].join('|');

export function fulfilmentPackingRoutes(deps: FulfilmentPackingDeps): readonly Route[] {
  return [
    {
      // Pack an order head office holds (FUL-04) — price weighed lines at their packed weight, refuse unsafe crates, and
      // RECORD the result so dispatch can build the manifest from what was packed. Body: what the desk OBSERVED only —
      // { lines: [{ productId, pickedMinor, packedGrams?, packTenthsC? }], crateAssignment?: { productId: crateId } }. The
      // order, its ordered quantities, the handling class, the cold-chain limits and the price are head office's. An ordered
      // product the desk did not name was not picked (a short line, said). A refused line does not stop the rest.
      api: 'API-08', method: 'POST', path: '/v1/fulfilment/orders/:orderId/pack',
      permission: 'fulfilment.pack.record', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const rawLines = b['lines'];
        const observed = Array.isArray(rawLines) ? rawLines.map(readObservation) : undefined;
        if (b['rules'] !== undefined || (observed ?? []).some((o) => o === 'carries_rules')) {
          throw apiError(400, {
            code: 'pack_carries_caller_rules',
            whatHappened: `The pack for ${orderId} carries ${b['rules'] !== undefined ? 'its own safety rules' : 'a handling class, an ordered quantity, a price or cold-chain limits'}. Those are head office's: the cold chain comes from the product master and the order from the order register — a desk cannot send rules that switch a control off.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send only what was observed at the desk: { lines: [{ productId, pickedMinor, packedGrams?, packTenthsC? }], crateAssignment? }. Nothing was packed.',
          });
        }
        const crateAssignment = readStrRecord(b['crateAssignment']);
        const seen = new Set<string>();
        const duplicate = (observed ?? []).some((o) => { if (typeof o !== 'object') return false; if (seen.has(o.productId)) return true; seen.add(o.productId); return false; });
        if (orderId === '' || observed === undefined || observed.length === 0 || observed.some((o) => o === undefined) || crateAssignment === undefined || duplicate) {
          throw apiError(400, {
            code: 'not_readable_as_a_pack',
            whatHappened: 'Packing an order needs an orderId in the path and { lines: [{ productId, pickedMinor, packedGrams?, packTenthsC? }] (one line per product), crateAssignment?: { productId: crateId } }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the lines as they were actually picked and packed, with a temperature for every chilled/frozen line and a weight for every weighed line.',
          });
        }
        const order = await deps.order(ctx.tenantId, orderId);
        if (order === undefined) {
          throw apiError(404, {
            code: 'order_unknown',
            whatHappened: `There is no order ${orderId} on head office's order register — a pack must be of an order the shop holds, never one named by the desk.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the order number on the pick slip. Nothing was packed.',
          });
        }
        if (!PACKABLE_STATES.includes(order.state)) {
          throw apiError(409, {
            code: 'order_not_packable',
            whatHappened: `Order ${orderId} is ${order.state} — only a confirmed order (or one being picked or already packed) can be packed.`,
            wasItSaved: 'not_saved',
            nextSafeAction: order.state === 'placed' ? 'Confirm the order first (its payment must be confirmed), then pack it.' : 'Nothing was packed; check the order on the order screen.',
          });
        }
        const ordered = new Map<string, number>();
        for (const l of order.lines) ordered.set(l.productId, (ordered.get(l.productId) ?? 0) + l.quantityMinor);
        const obs = observed as DeskObservation[];
        const stray = obs.find((o) => !ordered.has(o.productId));
        if (stray !== undefined) {
          throw apiError(422, {
            code: 'not_on_order',
            whatHappened: `${stray.productId} is not on order ${orderId}. A desk packs what the customer ordered; a substitute is decided on the order first.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Take it out of the crate, or record the substitution on the order, then pack again. Nothing was packed.',
          });
        }
        const over = obs.find((o) => o.pickedMinor > (ordered.get(o.productId) ?? 0));
        if (over !== undefined) {
          throw apiError(422, {
            code: 'more_picked_than_ordered',
            whatHappened: `${over.pickedMinor} of ${over.productId} were picked, but order ${orderId} asks for ${ordered.get(over.productId)}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Put the extra back, then pack again. Nothing was packed.',
          });
        }
        // Every ORDERED product is a line — named by the desk or not (not named = nothing picked, a short line, said).
        const lines: PackLine[] = [];
        const refusedUpFront: { lineId: string; reason: 'handling_unknown'; detail: string }[] = [];
        for (const [productId, orderedMinor] of ordered) {
          const o = obs.find((x) => x.productId === productId);
          const facts = await deps.productFacts(ctx.tenantId, productId);
          const name = facts?.name ?? productId;
          const policy = masterPacking(await deps.productPacking(ctx.tenantId, productId), productId, name);
          if (!policy.ok) { refusedUpFront.push(policy.refusal); continue; }
          if (facts === undefined) {
            throw apiError(409, {
              code: 'product_not_on_catalogue',
              whatHappened: `${productId} on order ${orderId} is not on the published catalogue, so it has no price to pack at.`,
              wasItSaved: 'not_saved', nextSafeAction: 'Publish the product (or correct the order), then pack. Nothing was packed.',
            });
          }
          const uom = normaliseUom(facts.uom) ?? facts.uom;
          lines.push({
            lineId: productId, orderId, productId, name, handling: policy.handling, orderedMinor, pickedMinor: o?.pickedMinor ?? 0,
            uom, unitPriceMinor: facts.unitPriceMinor,
            ...(uom === 'kg' ? { weighed: true } : {}),
            ...(o?.packedGrams === undefined ? {} : { packedGrams: o.packedGrams }),
            ...(o?.packTenthsC === undefined ? {} : { packTenthsC: o.packTenthsC }),
            ...(policy.coldChain === undefined ? {} : { coldChain: policy.coldChain }),
          });
        }
        const engine = lines.length === 0
          ? { orderId, packed: false, outcome: 'handling_unknown' as const, lines: [], refused: [], totalMinor: 0, detail: '' }
          : packOrder({ orderId, lines, crateAssignment, at: deps.now() });
        const refused = [...engine.refused, ...refusedUpFront];
        const result: PackResult = refusedUpFront.length === 0 ? engine : {
          ...engine, refused,
          outcome: engine.refused.length === 0 ? 'handling_unknown' : engine.outcome,
          detail: `${engine.lines.length} line(s) packed, ${engine.totalMinor}; ${refused.length} refused and listed (${refusedUpFront.length} with no handling class on the product master)`,
        };
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
        // FUL-04: only an order head office holds leaves the building.
        if ((await deps.order(ctx.tenantId, orderId)) === undefined) {
          throw apiError(404, {
            code: 'order_unknown',
            whatHappened: `There is no order ${orderId} on head office's order register — nothing is dispatched that the shop does not hold as an order.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the order number on the crate label. Nothing was dispatched.',
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
