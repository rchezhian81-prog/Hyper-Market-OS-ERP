// API-02 Pack hierarchy + UOM conversion (M03-FR-02) — the "a case of 24 becomes 24 singles, exactly"
// rule the whole stock figure rests on, made live on the cloud. If that conversion is ever approximate the
// stock is wrong from the first delivery and every count afterwards inherits the error, so the rule the
// roadmap sets, and the one this surface keeps, is:
//
//     A PACK CONVERSION IS EXACT AND REVERSIBLE, OR THE PACK IS REFUSED AT DEFINITION TIME.
//
// An inexact pack (a case that holds a fractional number of the level below, a base level that is not one
// base unit, two levels sharing a name) is rejected when it is DEFINED — before it can corrupt stock at
// receiving time — rather than silently producing a wrong figure later. Once a pack is defined, converting
// a quantity up to base units or back down is a pure, exact calculation.
//
// The rule is the tested `validatePack`/`toBaseUnits`/`fromBaseUnits`/`conversionIsReversible` in
// `@sre/product` (the `services-run-on-their-tested-engine` guardrail); this file is the persistence + HTTP
// skin around it. A product's pack hierarchy is event-sourced (`PackHierarchyDefined`, latest-per-product —
// a change is a new version, never an overwrite, hard rule #2), so it survives a restart. Defining a pack is
// gated `catalogue.pack.publish` (it decides how the shop counts what it receives and sells); reads and
// conversions are `catalogue.pack.read`. Barcodes ON a pack level are stored as part of the definition, but
// the authoritative one-code-one-item register remains the barcode route.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  validatePack, toBaseUnits, fromBaseUnits, unitsPerLevel, conversionIsReversible,
  InvalidPackError, UnknownPackLevelError,
  type PackHierarchy, type PackLevel,
} from '../../../packages/product/src/index';

export interface PackHierarchyDeps {
  /** Store a product's pack hierarchy (idempotent on the caller's key; latest-per-product wins). */
  readonly define: (tenantId: string, pack: PackHierarchy, key: string) => Promise<void> | void;
  /** The current pack hierarchy for a product, or undefined when none was ever defined. */
  readonly pack: (tenantId: string, productId: string) => Promise<PackHierarchy | undefined> | PackHierarchy | undefined;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Coerce one level from the body — shape only; the ENGINE judges exactness (integer, base-is-one, …). */
const readLevel = (v: unknown): PackLevel | undefined => {
  if (!isObj(v) || !isStr(v['level']) || !isNum(v['containsMinor'])) return undefined;
  return {
    level: v['level'],
    containsMinor: v['containsMinor'],
    ...(isStr(v['barcode']) ? { barcode: v['barcode'] } : {}),
  };
};

/** Turn an engine refusal into a plain-English 422 the person fixing it (not a programmer) can act on. */
function invalidPack(err: InvalidPackError): never {
  throw apiError(422, {
    code: 'pack_hierarchy_is_not_exact',
    whatHappened: `This pack cannot be defined: ${err.message.replace(/^Pack hierarchy for "[^"]*" is invalid: /, '')}. An inexact pack is refused here so it can never make a stock figure wrong at the back door.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'A pack must hold a WHOLE number of the level below, the base level must be one base unit, and no two levels may share a name. Fix that and define it again — nothing was saved.',
  });
}

export function packHierarchyRoutes(deps: PackHierarchyDeps): readonly Route[] {
  return [
    {
      // Define (or re-version) a product's pack hierarchy. Body: { baseUom, levels: PackLevel[] }.
      api: 'API-02', method: 'POST', path: '/v1/catalogue/products/:productId/pack',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const levelsRaw = b['levels'];
        if (productId === '' || !isStr(b['baseUom']) || !Array.isArray(levelsRaw)) {
          throw apiError(400, {
            code: 'not_readable_as_a_pack',
            whatHappened: 'Defining a pack needs a product id in the path, a baseUom, and levels[] (each { level, containsMinor }, ordered smallest-first from the base unit).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { baseUom: "each", levels: [{ level: "each", containsMinor: 1 }, { level: "case", containsMinor: 24 }] } with the product id in the URL.',
          });
        }
        const levels = levelsRaw.map(readLevel);
        if (levels.some((l) => l === undefined)) {
          throw apiError(400, {
            code: 'not_readable_as_a_pack',
            whatHappened: 'Every pack level needs a name (level) and a whole-number count of the level below (containsMinor).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Give each level a { level, containsMinor }; a barcode on the level is optional.',
          });
        }
        const pack: PackHierarchy = { productId, baseUom: b['baseUom'], levels: levels as PackLevel[] };
        // The exactness gate — the SAME tested rule any reader relies on, applied before anything is stored,
        // so an inexact pack is refused here rather than corrupting stock at receiving time.
        try {
          validatePack(pack);
        } catch (err) {
          if (err instanceof InvalidPackError) invalidPack(err);
          throw err;
        }
        await deps.define(ctx.tenantId, pack, ctx.idempotencyKey ?? productId);
        return { status: 201, body: { pack } };
      },
    },
    {
      // Read a product's current pack hierarchy. 404 when none was ever defined.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/products/:productId/pack',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const pack = await deps.pack(ctx.tenantId, productId);
        if (pack === undefined) throw notFound(`pack hierarchy for product ${productId}`);
        return { status: 200, body: { pack } };
      },
    },
    {
      // Convert a quantity through the pack hierarchy. Query: { level, quantity, direction }.
      //   direction=to-base   → `quantity` packs OF `level` = N base units (exact).
      //   direction=from-base → `quantity` base units = whole packs OF `level` + a base-unit remainder
      //                          (never a fraction of a case — half a case is not a thing on a shelf).
      // Also reports how many base units one of that level holds, and that the conversion round-trips.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/products/:productId/pack/convert',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const q = ctx.query;
        const level = (q['level'] ?? '').trim();
        const direction = q['direction'] ?? 'to-base';
        const quantity = Number(q['quantity']);
        if (level === '' || !Number.isFinite(quantity) || quantity < 0 || (direction !== 'to-base' && direction !== 'from-base')) {
          throw apiError(400, {
            code: 'not_readable_as_a_conversion',
            whatHappened: 'A conversion needs level, a quantity ≥ 0, and direction=to-base or from-base in the query.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask e.g. ?level=case&quantity=2&direction=to-base to turn 2 cases into base units.',
          });
        }
        const pack = await deps.pack(ctx.tenantId, productId);
        if (pack === undefined) throw notFound(`pack hierarchy for product ${productId}`);
        try {
          const perLevel = unitsPerLevel(pack, level); // throws UnknownPackLevelError for a level not defined
          const reversible = conversionIsReversible(pack, level);
          if (direction === 'to-base') {
            return { status: 200, body: { productId, level, direction, quantity, baseUnits: toBaseUnits(pack, quantity, level), unitsPerLevel: perLevel, reversible } };
          }
          const { packs, remainderBaseUnits } = fromBaseUnits(pack, quantity, level);
          return { status: 200, body: { productId, level, direction, baseUnits: quantity, packs, remainderBaseUnits, unitsPerLevel: perLevel, reversible } };
        } catch (err) {
          if (err instanceof UnknownPackLevelError) {
            throw apiError(422, {
              code: 'unknown_pack_level',
              whatHappened: `This product's pack has no level "${level}".`,
              wasItSaved: 'not_saved',
              nextSafeAction: `Use one of the levels this product's pack defines (read GET …/pack to see them).`,
            });
          }
          throw err;
        }
      },
    },
  ];
}
