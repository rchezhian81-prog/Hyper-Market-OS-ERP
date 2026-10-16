// The till's "cannot sell" gate on ONE line (roadmap v2.1 B6 · B14 · B19 · M12 · M28 · M34) — the rules the
// stand-alone check routes already answer, applied where the sale actually happens: at the scan, at a quantity change,
// at the moment the till commits, and again on the store computer before its disk.
//
//   • B19 — a banned single-use-plastic SKU cannot be sold; a plastic carry bag thinner than 120 µm (or with no
//     recorded thickness) cannot be sold; a carry bag is its own line at a price, never free.
//   • B14 — a tobacco line below one whole pack is refused (no loose single stick). The age-18 half of B14 is the
//     till's age gate: a tobacco product always needs at least 18 (`minimumAgeOf`).
//   • B6  — weight is accepted only from a scale whose Legal Metrology verification is current. A weighed line on a
//     lane whose scale stamp has lapsed — or a lane with no verified scale on record — is refused.
//
// Every input comes from the signed packs the lane already holds (the product's `regulatedFlags` in the catalogue
// pack; this lane's scales in the store pack), so the gate needs no network (hard rule #1). There is NO override: each
// rule is a legal prohibition, and none of the signed criteria allows one. Pure and deterministic: "today" is passed in.
//
// The decisions are the tested engines' (`checkSingleUsePlastic`, `checkRestrictedSale`, `weighingScaleVerification`);
// this module only reads the pack's flags into their inputs and words each refusal for the cashier.

import { checkSingleUsePlastic } from './single-use-plastic';
import { checkRestrictedSale } from './restricted-sales';
import { weighingScaleVerification, InvalidScaleVerification } from '../../facilities/src/weighing-verification';

/** The age a tobacco product needs at the very least (COTPA 2003 s.6 · B14). */
export const TOBACCO_MINIMUM_AGE = 18;
/** The minimum plastic carry-bag thickness (Plastic Waste Management Rules, from 31 Dec 2022 · B19). */
export const MIN_CARRY_BAG_MICRONS = 120;

/**
 * The keys in a product's `regulatedFlags` (catalogue pack) this gate reads. Written once: the pack signature covers a
 * product's flags whenever it carries any of these (`services/catalogue/src/pack.ts` `canonicalise`).
 */
export const TILL_RULE_FLAG_KEYS = ['tobacco', 'packMinimumMinor', 'carryBag', 'plasticMaterial', 'plasticThicknessMicrons', 'bannedSingleUsePlastic'] as const;

/** What the gate reads from a product's `regulatedFlags`. Absent = the product master did not declare it. */
export interface TillRuleFlags {
  readonly tobacco?: boolean;
  /** One whole pack, in the product's base-unit minor units (e.g. 10 for a pack of 10 sticks sold `ea`). */
  readonly packMinimumMinor?: number;
  readonly carryBag?: boolean;
  readonly plasticMaterial?: string;
  readonly plasticThicknessMicrons?: number;
  readonly bannedSingleUsePlastic?: boolean;
}

const posInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined);

/** Read the gate's flags out of a product's `regulatedFlags` — only well-formed values count; anything else is absent. */
export function tillRuleFlagsOf(flags: Readonly<Record<string, unknown>> | undefined): TillRuleFlags {
  if (flags === undefined || flags === null || typeof flags !== 'object') return {};
  const material = flags['plasticMaterial'];
  const pack = posInt(flags['packMinimumMinor']);
  const microns = posInt(flags['plasticThicknessMicrons']);
  return {
    ...(flags['tobacco'] === true ? { tobacco: true } : {}),
    ...(pack === undefined ? {} : { packMinimumMinor: pack }),
    ...(flags['carryBag'] === true ? { carryBag: true } : {}),
    ...(typeof material === 'string' && material.trim() !== '' ? { plasticMaterial: material.trim() } : {}),
    ...(microns === undefined ? {} : { plasticThicknessMicrons: microns }),
    ...(flags['bannedSingleUsePlastic'] === true ? { bannedSingleUsePlastic: true } : {}),
  };
}

/** True when a product's flags carry anything this gate reads. */
export function hasTillRuleFlags(flags: Readonly<Record<string, unknown>> | undefined): boolean {
  return flags !== undefined && flags !== null && TILL_RULE_FLAG_KEYS.some((k) => flags[k] !== undefined);
}

/** One weighing scale this lane takes weight from, as the store pack carries it (B6 · B7 register fields). */
export interface LaneScale {
  readonly assetId: string;
  readonly approvalNo?: string;
  readonly capacityGrams?: number;
  readonly lastStampedOn?: string;
  /** The last day the verification stamp is valid (YYYY-MM-DD). */
  readonly reverificationDueOn: string;
}

/**
 * The scales this lane takes weight from. `known: false` when the store computer was never told (no scale register in
 * its store pack) — then nothing can be sold by weight, because no stamp can be shown to be current.
 */
export type LaneScales =
  | { readonly known: true; readonly scales: readonly LaneScale[] }
  | { readonly known: false; readonly why: string };

/** The units a line is WEIGHED in — a line in these needs a verified scale (B6). Litres are measured, not weighed. */
export function isWeighedUom(uom: string): boolean {
  return uom === 'kg' || uom === 'g';
}

export type TillRefusalReason =
  | 'banned_single_use_plastic'
  | 'carry_bag_below_min_thickness'
  | 'carry_bag_not_priced'
  | 'tobacco_below_pack'
  | 'tobacco_pack_size_unknown'
  | 'weighed_without_verified_scale'
  | 'weighed_on_lapsed_scale';

export interface TillRefusal {
  readonly reason: TillRefusalReason;
  readonly productId: string;
  /** What the cashier is told, with a customer watching. */
  readonly laneMessage: string;
  /** The engine's own words, for the record. */
  readonly detail: string;
}

export interface TillGateLine {
  readonly productId: string;
  readonly description: string;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly unitPriceMinor: number;
  readonly regulatedFlags?: Readonly<Record<string, unknown>>;
}

export interface TillGateContext {
  /** This lane's scales from the store pack; absent = the till was never told. */
  readonly scales?: LaneScales;
  /** The lane's local calendar date (YYYY-MM-DD); absent = unknown, and a weighed line is refused. */
  readonly today?: string;
}

const qtyWords = (minor: number, uom: string): string => (uom === 'ea' ? `${minor}` : `${minor} ${uom === 'kg' ? 'g' : uom === 'L' ? 'ml' : uom}`);

/**
 * Every reason this line may not be sold, in the order a cashier should hear them — the empty list when it may. Pure.
 */
export function tillLineRefusals(line: TillGateLine, ctx: TillGateContext): readonly TillRefusal[] {
  const name = typeof line.description === 'string' && line.description.trim() !== '' ? line.description : line.productId;
  // ── B6 · weight only from a scale whose verification is current ────────────────────────────────────────────────
  return [...productRuleRefusals(line), ...(isWeighedUom(line.uom) ? scaleRefusals(line.productId, name, ctx) : [])];
}

/** The product's own rules (B14 · B19) — what the line is, not where it is weighed. Head office's intake re-asks these. */
export function productRuleRefusals(line: TillGateLine): readonly TillRefusal[] {
  const flags = tillRuleFlagsOf(line.regulatedFlags);
  const out: TillRefusal[] = [];
  const name = typeof line.description === 'string' && line.description.trim() !== '' ? line.description : line.productId;

  // ── B19 · single-use plastic and carry bags (the tested engine decides) ────────────────────────────────────────
  if (flags.bannedSingleUsePlastic === true || flags.carryBag === true) {
    const verdict = checkSingleUsePlastic({
      lines: [{
        lineId: line.productId, productId: line.productId, unitPriceMinor: line.unitPriceMinor,
        ...(flags.carryBag === true ? { isCarryBag: true } : {}),
        ...(flags.plasticMaterial === undefined ? {} : { material: flags.plasticMaterial }),
        ...(flags.plasticThicknessMicrons === undefined ? {} : { plasticThicknessMicrons: flags.plasticThicknessMicrons }),
        ...(flags.bannedSingleUsePlastic === true ? { bannedSingleUsePlastic: true } : {}),
      }],
      minCarryBagMicrons: MIN_CARRY_BAG_MICRONS,
    });
    for (const b of verdict.blocks) {
      if (b.reason === 'banned_single_use_plastic') {
        out.push({ reason: b.reason, productId: line.productId, detail: b.detail,
          laneMessage: `${name} is a banned single-use plastic item. It cannot be sold — keep it off the bill and tell the manager.` });
      } else if (b.reason === 'carry_bag_below_min_thickness') {
        out.push({ reason: b.reason, productId: line.productId, detail: b.detail,
          laneMessage: flags.plasticThicknessMicrons === undefined
            ? `${name} is a plastic carry bag with no thickness on record, so it cannot be shown to be ${MIN_CARRY_BAG_MICRONS} microns or more. It cannot be sold — offer a ${MIN_CARRY_BAG_MICRONS}-micron, cloth or paper bag.`
            : `${name} is a ${flags.plasticThicknessMicrons}-micron plastic carry bag, thinner than the ${MIN_CARRY_BAG_MICRONS}-micron minimum. It cannot be sold — offer a ${MIN_CARRY_BAG_MICRONS}-micron, cloth or paper bag.` });
      } else {
        out.push({ reason: b.reason, productId: line.productId, detail: b.detail,
          laneMessage: `${name} is a carry bag. A bag is sold as its own line at its price — it cannot be given free.` });
      }
    }
  }

  // ── B14 · no loose single stick (the tested engine decides) ────────────────────────────────────────────────────
  if (flags.tobacco === true) {
    if (flags.packMinimumMinor === undefined) {
      out.push({ reason: 'tobacco_pack_size_unknown', productId: line.productId,
        detail: `${line.productId} is tobacco with no pack size on record — a below-pack quantity cannot be ruled out`,
        laneMessage: `${name} is tobacco and its pack size is not on record, so this till cannot tell a whole pack from loose cigarettes. It cannot be sold until head office records the pack size.` });
    } else {
      const verdict = checkRestrictedSale({
        lines: [{ lineId: line.productId, productId: line.productId, quantityMinor: line.quantityMinor, uom: line.uom, ageRestricted: true, restrictionKind: 'tobacco', minSaleQuantityMinor: flags.packMinimumMinor }],
        // The age half is the till's own age gate; this asks only the pack rule.
        ageVerification: { verified: true },
        minimumAge: TOBACCO_MINIMUM_AGE,
      });
      for (const b of verdict.blocks.filter((x) => x.reason === 'below_pack_minimum')) {
        out.push({ reason: 'tobacco_below_pack', productId: line.productId, detail: b.detail,
          laneMessage: `${name} is tobacco and is sold only in whole packs (at least ${qtyWords(flags.packMinimumMinor, line.uom)}). Loose cigarettes cannot be sold — this line is ${qtyWords(line.quantityMinor, line.uom)}.` });
      }
    }
  }

  return out;
}

/** Why weight cannot be taken on this lane today — the empty list when every scale it takes weight from is current. */
export function scaleRefusals(productId: string, name: string, ctx: TillGateContext): readonly TillRefusal[] {
  const scales = ctx.scales;
  const none = (detail: string): TillRefusal => ({ reason: 'weighed_without_verified_scale', productId, detail,
    laneMessage: `This lane has no weighing scale with a current Legal Metrology stamp on record, so ${name} cannot be sold by weight here. Use a lane with a verified scale and tell the manager.` });
  if (scales === undefined || !scales.known) return [none(scales === undefined ? 'the till was not told which scales this lane uses' : scales.why)];
  if (scales.scales.length === 0) return [none('no weighing scale is registered to this lane')];
  if (ctx.today === undefined) return [none('the lane does not know today\'s date, so no stamp can be judged current')];
  const out: TillRefusal[] = [];
  for (const s of scales.scales) {
    try {
      const status = weighingScaleVerification({ reverificationDueOn: s.reverificationDueOn }, ctx.today);
      if (status.tradingBlocked) {
        out.push({ reason: 'weighed_on_lapsed_scale', productId, detail: `scale ${s.assetId}: ${status.detail}`,
          laneMessage: `The weighing scale on this lane (${s.assetId}) had its Legal Metrology verification run out on ${s.reverificationDueOn}. Nothing can be sold by weight on this lane until it is re-verified — use another lane and tell the manager.` });
      }
    } catch (err) {
      if (!(err instanceof InvalidScaleVerification)) throw err;
      out.push(none(`scale ${s.assetId}: ${err.message}`));
    }
  }
  return out;
}

/** The scale evidence a weighed sale line carries: which scales the lane took weight from, and until when each is valid. */
export function scaleEvidence(ctx: TillGateContext): { readonly checkedOn: string; readonly scales: readonly { readonly assetId: string; readonly reverificationDueOn: string }[] } | undefined {
  if (ctx.scales === undefined || !ctx.scales.known || ctx.today === undefined) return undefined;
  return { checkedOn: ctx.today, scales: ctx.scales.scales.map((s) => ({ assetId: s.assetId, reverificationDueOn: s.reverificationDueOn })) };
}

/** The refusal thrown at the till: every reason, the first one's words for the cashier. */
export class TillRuleRefusedError extends Error {
  readonly laneMessage: string;
  constructor(public readonly refusals: readonly TillRefusal[], prefix = '') {
    super(`not sold: ${refusals.map((r) => `${r.productId} ${r.reason}`).join('; ')}`);
    this.name = 'TillRuleRefusedError';
    this.laneMessage = `${prefix}${refusals[0]?.laneMessage ?? 'This item cannot be sold.'}`;
  }
}
