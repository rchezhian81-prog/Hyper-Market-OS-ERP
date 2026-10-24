// The till's "cannot sell" gate on ONE line (roadmap v2.1 B6 · B14 · B19 · M12 · M28 · M34) — the rules the
// stand-alone check routes already answer, applied where the sale actually happens: at the scan, at a quantity change,
// at the moment the till commits, and again on the store computer before its disk.
//
//   • B19 — a banned single-use-plastic SKU cannot be sold; a plastic carry bag thinner than 120 µm (or with no
//     recorded thickness) cannot be sold; a carry bag is its own line at a price, never free.
//   • B14 — a tobacco line below one whole pack is refused (no loose single stick), and so is one that is not a whole
//     number of packs (OB-160 "A": whole packs only). The age-18 half of B14 is the till's age gate: a tobacco product
//     always needs at least 18 (`minimumAgeOf`).
//   • B6  — weight is accepted only from a scale whose Legal Metrology verification is current. A weighed line on a
//     lane whose scale stamp has lapsed — or a lane with no verified scale on record — is refused. Whether a line is
//     WEIGHED is decided from the judging side's OWN catalogue (`catalogueUom`), never only from the unit written on the
//     line (NEW-2): a weighed product sent as "L" or "ea" is still weighed.
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
import { isLiquorHsn, LIQUOR_NOT_SOLD } from './liquor';

/** The age a tobacco product needs at the very least (COTPA 2003 s.6 · B14). */
export const TOBACCO_MINIMUM_AGE = 18;
/** The minimum plastic carry-bag thickness (Plastic Waste Management Rules, from 31 Dec 2022 · B19). */
export const MIN_CARRY_BAG_MICRONS = 120;

/**
 * The keys in a product's `regulatedFlags` (catalogue pack) this gate reads. Written once: the pack signature covers a
 * product's flags whenever it carries any of these (`services/catalogue/src/pack.ts` `canonicalise`).
 */
export const TILL_RULE_FLAG_KEYS = [
  'tobacco', 'packMinimumMinor', 'carryBag', 'plasticMaterial', 'plasticThicknessMicrons', 'bannedSingleUsePlastic',
  // R3: B16 — the last day a tobacco product's health-warning confirmation stays good; B13 — a gold piece and its HUID.
  'tobaccoWarningConfirmedUntil', 'gold', 'huid',
  // B12 (OB-325): a product under a BIS Quality Control Order, its BIS licence number and the last day that licence is valid.
  'bisControlled', 'bisLicenceNo', 'bisLicenceValidUntil',
  // B8 (OB-298): a perishable whose printed date the cashier confirms on the pack before the line is added.
  'perishable',
  // OB-288 P2 · B17: liquor is not sold at all (TASMAC). A pack never carries one; a line flagged so is refused.
  'liquor',
] as const;

/** B13: a Hallmark Unique ID as the till reads it — six capital letters and digits (BIS). */
const HUID = /^[A-Z0-9]{6}$/;

/** What the gate reads from a product's `regulatedFlags`. Absent = the product master did not declare it. */
export interface TillRuleFlags {
  readonly tobacco?: boolean;
  /** One whole pack, in the product's base-unit minor units (e.g. 10 for a pack of 10 sticks sold `ea`). */
  readonly packMinimumMinor?: number;
  readonly carryBag?: boolean;
  readonly plasticMaterial?: string;
  readonly plasticThicknessMicrons?: number;
  readonly bannedSingleUsePlastic?: boolean;
  /** B16: the last day (YYYY-MM-DD) the tobacco health-warning confirmation is good — the next picture comes in after it. */
  readonly tobaccoWarningConfirmedUntil?: string;
  /** B13: a gold piece. */
  readonly gold?: boolean;
  /** B13: its hallmark HUID, when well-formed. A gold piece without one is not sold. */
  readonly huid?: string;
  /** B12 (OB-325): the product is under a BIS Quality Control Order (packaged drinking water and other QCO goods). */
  readonly bisControlled?: boolean;
  /** B12: the BIS licence number its ISI mark is used under, when recorded (non-empty text). */
  readonly bisLicenceNo?: string;
  /** B12: the last day (YYYY-MM-DD) that BIS licence is valid. */
  readonly bisLicenceValidUntil?: string;
  /** B8 (OB-298): a perishable — the cashier confirms the date printed on the pack before the line is added. */
  readonly perishable?: boolean;
  /** B17: the product is liquor — never sold (TASMAC monopoly). */
  readonly liquor?: boolean;
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
    ...(typeof flags['tobaccoWarningConfirmedUntil'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(flags['tobaccoWarningConfirmedUntil']) ? { tobaccoWarningConfirmedUntil: flags['tobaccoWarningConfirmedUntil'] } : {}),
    ...(flags['gold'] === true ? { gold: true } : {}),
    ...(typeof flags['huid'] === 'string' && HUID.test(flags['huid']) ? { huid: flags['huid'] } : {}),
    ...(flags['bisControlled'] === true ? { bisControlled: true } : {}),
    ...(typeof flags['bisLicenceNo'] === 'string' && flags['bisLicenceNo'].trim() !== '' ? { bisLicenceNo: flags['bisLicenceNo'].trim() } : {}),
    ...(isCalendarDate(flags['bisLicenceValidUntil']) ? { bisLicenceValidUntil: flags['bisLicenceValidUntil'] } : {}),
    ...(flags['perishable'] === true ? { perishable: true } : {}),
    ...(flags['liquor'] === true ? { liquor: true } : {}),
  };
}

/** A real calendar date written YYYY-MM-DD (not 2026-02-30). */
function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
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
  | 'carry_bag_discounted'
  | 'tobacco_below_pack'
  | 'tobacco_not_whole_packs'
  | 'tobacco_pack_size_unknown'
  | 'weighed_without_verified_scale'
  | 'weighed_on_lapsed_scale'
  /** B16: the tobacco product's health-warning confirmation ran out (a new government picture is in force). */
  | 'tobacco_warning_confirmation_expired'
  /** B13: a gold piece with no hallmark HUID recorded on the product. */
  | 'gold_without_huid'
  /** B13: this HUID has already been sold — a hallmarked piece is sold once. */
  | 'gold_huid_already_sold'
  /** B17: liquor — never sold (TASMAC state monopoly), whatever the customer's age. */
  | 'liquor_not_sold'
  /** B13: one HUID is one piece — a gold line is exactly one. */
  | 'gold_huid_more_than_one_piece'
  /** B12 (OB-325): a BIS-controlled product with no BIS licence number, or no licence expiry date, on record. */
  | 'bis_licence_missing'
  /** B12 (OB-325): the product's BIS licence ran out (today is after its last valid day). */
  | 'bis_licence_expired'
  /** B12: the lane does not know today's date, so the licence cannot be shown to be current. */
  | 'bis_licence_not_judged';

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
  /**
   * NEW-1 (B19): what the line actually CHARGES after any promotion attributed to it. Known at the till's commit, at the
   * store computer and at head office (`lineTotalMinor`); absent at a scan, where only the unit price is known.
   */
  readonly chargedMinor?: number;
  /**
   * OB-173 (B19): the line's LIST unit price — what it cost before any price change at the till (a lowered line's original
   * price). Absent → `unitPriceMinor` is the list price. A carry bag charged below list price × quantity is refused.
   */
  readonly listUnitPriceMinor?: number;
  /**
   * NEW-2 (B6): the product's base unit in the JUDGING side's own catalogue. A line is weighed when this OR the line's
   * own unit is a weight — so a weighed product cannot skip the scale gate by being sent in another unit.
   */
  readonly catalogueUom?: string;
  readonly regulatedFlags?: Readonly<Record<string, unknown>>;
  /**
   * B17: the HSN the line is sold under (from the pack). An alcoholic-drink heading is refused even when the product carries
   * no flag — a pack built before the liquor rule, or a product whose flag was never set. Absent: only the flag is judged.
   */
  readonly hsnCode?: string;
}

/** Whether a line is sold by WEIGHT (B6): its own unit, or its product's unit in the judging side's catalogue. */
export function lineIsWeighed(line: Pick<TillGateLine, 'uom' | 'catalogueUom'>): boolean {
  return isWeighedUom(line.uom) || (line.catalogueUom !== undefined && isWeighedUom(line.catalogueUom));
}

export interface TillGateContext {
  /** This lane's scales from the store pack; absent = the till was never told. */
  readonly scales?: LaneScales;
  /** The lane's local calendar date (YYYY-MM-DD); absent = unknown, and a weighed line is refused. */
  readonly today?: string;
  /**
   * B13: the HUIDs already sold — by this store (its store computer's own sales) and already on this bill (other lines).
   * Absent = not known here; a gold line is then judged only on carrying a HUID, and head office backstops the rest.
   */
  readonly soldHuids?: ReadonlySet<string>;
}

const qtyWords = (minor: number, uom: string): string => (uom === 'ea' ? `${minor}` : `${minor} ${uom === 'kg' ? 'g' : uom === 'L' ? 'ml' : uom}`);

/**
 * Every reason this line may not be sold, in the order a cashier should hear them — the empty list when it may. Pure.
 */
export function tillLineRefusals(line: TillGateLine, ctx: TillGateContext): readonly TillRefusal[] {
  const name = typeof line.description === 'string' && line.description.trim() !== '' ? line.description : line.productId;
  // ── B6 · weight only from a scale whose verification is current ────────────────────────────────────────────────
  return [
    ...productRuleRefusals(line),
    ...(lineIsWeighed(line) ? scaleRefusals(line.productId, name, ctx) : []),
    ...datedAndOnceOnlyRefusals(line, name, ctx),
  ];
}

/**
 * R3 — the two rules that need what only the till knows: today's date (B16) and the HUIDs this store has sold (B13).
 * Pure; every input comes from the signed pack and the store computer's own sales, never a network call.
 */
export function datedAndOnceOnlyRefusals(line: TillGateLine, name: string, ctx: TillGateContext): readonly TillRefusal[] {
  const flags = tillRuleFlagsOf(line.regulatedFlags);
  const out: TillRefusal[] = [];
  // B16 · OB-140 "A": the confirmation is good up to the day before the next government picture comes into force.
  if (flags.tobacco === true && flags.tobaccoWarningConfirmedUntil !== undefined && ctx.today !== undefined && ctx.today > flags.tobaccoWarningConfirmedUntil) {
    out.push({ reason: 'tobacco_warning_confirmation_expired', productId: line.productId,
      detail: `${line.productId}: health-warning confirmation good until ${flags.tobaccoWarningConfirmedUntil}; today is ${ctx.today}`,
      laneMessage: `${name} cannot be sold: a new government health-warning picture is in force and nobody has confirmed these packs carry it. Keep it off the bill and tell the manager.` });
  }
  // B13 (BIS IS 1417:2016 · OB-138): a gold piece is sold only with its HUID, once, one piece per line.
  const raw = line.regulatedFlags?.['gold'] === true;
  if (raw || flags.gold === true) {
    if (flags.huid === undefined) {
      out.push({ reason: 'gold_without_huid', productId: line.productId, detail: `${line.productId}: gold with no well-formed HUID on the product`,
        laneMessage: `${name} is gold and has no hallmark HUID recorded on the product. It cannot be sold — keep it off the bill and ask head office to record its HUID.` });
    } else if (ctx.soldHuids?.has(flags.huid) === true) {
      out.push({ reason: 'gold_huid_already_sold', productId: line.productId, detail: `${line.productId}: HUID ${flags.huid} already sold`,
        laneMessage: `${name} (HUID ${flags.huid}) has already been sold — a hallmarked piece is sold once. Do not sell it; tell the manager.` });
    } else if (line.quantityMinor !== 1) {
      out.push({ reason: 'gold_huid_more_than_one_piece', productId: line.productId, detail: `${line.productId}: quantity ${line.quantityMinor} for one HUID`,
        laneMessage: `${name} (HUID ${flags.huid}) is one hallmarked piece — it is sold as exactly one.` });
    }
  }
  out.push(...bisMarkRefusals(line, name, ctx));
  return out;
}

/**
 * B12 (roadmap v2.1 · OB-325, owner 23 Oct 2026, "build, switched ON"): a product under a BIS Quality Control Order —
 * packaged drinking water and other QCO goods — is sold only with its BIS licence number AND that licence's expiry date on
 * record, and only while the licence is current by the lane's own clock. Refused at the till offline otherwise; no
 * override. On by construction: a shop with no BIS-controlled category is simply unaffected.
 */
export function bisMarkRefusals(line: TillGateLine, name: string, ctx: TillGateContext): readonly TillRefusal[] {
  const flags = tillRuleFlagsOf(line.regulatedFlags);
  // The raw flag too: a malformed licence on a flagged product is a missing one, never a pass.
  if (flags.bisControlled !== true && line.regulatedFlags?.['bisControlled'] !== true) return [];
  if (flags.bisLicenceNo === undefined || flags.bisLicenceValidUntil === undefined) {
    const missing = [flags.bisLicenceNo === undefined ? 'licence number' : null, flags.bisLicenceValidUntil === undefined ? 'licence expiry date' : null].filter((x) => x !== null).join(' and ');
    return [{ reason: 'bis_licence_missing', productId: line.productId,
      detail: `${line.productId}: BIS-controlled with no BIS ${missing} on record`,
      laneMessage: `${name} needs the BIS (ISI mark) licence by law, and its BIS ${missing} is not on record. It cannot be sold — keep it off the bill and ask head office to record the BIS licence.` }];
  }
  if (ctx.today === undefined) {
    return [{ reason: 'bis_licence_not_judged', productId: line.productId,
      detail: `${line.productId}: the lane does not know today's date, so BIS licence ${flags.bisLicenceNo} cannot be judged current`,
      laneMessage: `${name} needs a current BIS (ISI mark) licence, and this till does not know today's date to check it. It cannot be sold here — tell the manager.` }];
  }
  if (ctx.today > flags.bisLicenceValidUntil) {
    return [{ reason: 'bis_licence_expired', productId: line.productId,
      detail: `${line.productId}: BIS licence ${flags.bisLicenceNo} valid until ${flags.bisLicenceValidUntil}; today is ${ctx.today}`,
      laneMessage: `${name}: its BIS (ISI mark) licence ${flags.bisLicenceNo} ran out on ${flags.bisLicenceValidUntil}. It cannot be sold — keep it off the bill and tell the manager.` }];
  }
  return [];
}

/** The product's own rules (B14 · B19) — what the line is, not where it is weighed. Head office's intake re-asks these. */
export function productRuleRefusals(line: TillGateLine): readonly TillRefusal[] {
  const flags = tillRuleFlagsOf(line.regulatedFlags);
  const out: TillRefusal[] = [];
  const name = typeof line.description === 'string' && line.description.trim() !== '' ? line.description : line.productId;

  // ── B17 · liquor is not sold at all (TASMAC) — refused before anything else, with no override ──────────────────
  if (flags.liquor === true || isLiquorHsn(line.hsnCode)) {
    out.push({ reason: 'liquor_not_sold', productId: line.productId,
      detail: `${line.productId}: ${flags.liquor === true ? 'flagged liquor' : `HSN ${String(line.hsnCode)} is an alcoholic-drink heading`} — ${LIQUOR_NOT_SOLD}`,
      laneMessage: `${name} is liquor. SRE does not sell liquor — in Tamil Nadu only TASMAC may. Keep it off the bill and tell the manager.` });
    return out;
  }

  // ── B19 · single-use plastic and carry bags (the tested engine decides) ────────────────────────────────────────
  if (flags.bannedSingleUsePlastic === true || flags.carryBag === true) {
    // OB-173: a bag sold by the piece is judged against its LIST price for the whole line. Without a charged amount (a scan,
    // a price change) the line charges its unit price × quantity — so a bag's price lowered at the till is refused too.
    // Verifier r2final L1: a carry bag is judged by the PIECE whatever unit the line carries — a bag line sent as "kg" or
    // "L" (a hand-made request) is still a number of bags, unless the judging side's own catalogue sells it by weight.
    const bagByPiece = flags.carryBag === true && (line.catalogueUom === undefined || line.catalogueUom === '' || line.catalogueUom === 'ea');
    const each = (line.uom === 'ea' || bagByPiece) && Number.isSafeInteger(line.quantityMinor) && line.quantityMinor > 0;
    const listUnit = typeof line.listUnitPriceMinor === 'number' && Number.isFinite(line.listUnitPriceMinor) ? Math.max(line.listUnitPriceMinor, line.unitPriceMinor) : line.unitPriceMinor;
    const charged = typeof line.chargedMinor === 'number' && Number.isFinite(line.chargedMinor) ? line.chargedMinor : each ? line.unitPriceMinor * line.quantityMinor : undefined;
    const verdict = checkSingleUsePlastic({
      lines: [{
        lineId: line.productId, productId: line.productId, unitPriceMinor: line.unitPriceMinor,
        ...(charged === undefined ? {} : { chargedMinor: charged }),
        ...(flags.carryBag === true && each ? { listMinor: listUnit * line.quantityMinor } : {}),
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
      } else if (b.reason === 'carry_bag_discounted') {
        out.push({ reason: b.reason, productId: line.productId, detail: b.detail,
          laneMessage: `${name} is a carry bag and it is being charged less than its price. A bag is always charged its full price — no offer or price change applies to it. Tell the manager.` });
      } else {
        out.push({ reason: b.reason, productId: line.productId, detail: b.detail,
          laneMessage: line.unitPriceMinor > 0
            ? `${name} is a carry bag and an offer has taken its price to nothing. A bag is sold as its own line at its price — it cannot be given free, even by an offer. Tell the manager.`
            : `${name} is a carry bag. A bag is sold as its own line at its price — it cannot be given free.` });
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
        lines: [{ lineId: line.productId, productId: line.productId, quantityMinor: line.quantityMinor, uom: line.uom, ageRestricted: true, restrictionKind: 'tobacco', minSaleQuantityMinor: flags.packMinimumMinor, wholePacksOnly: true }],
        // The age half is the till's own age gate; this asks only the pack rule.
        ageVerification: { verified: true },
        minimumAge: TOBACCO_MINIMUM_AGE,
      });
      for (const b of verdict.blocks.filter((x) => x.reason === 'below_pack_minimum')) {
        out.push({ reason: 'tobacco_below_pack', productId: line.productId, detail: b.detail,
          laneMessage: `${name} is tobacco and is sold only in whole packs (at least ${qtyWords(flags.packMinimumMinor, line.uom)}). Loose cigarettes cannot be sold — this line is ${qtyWords(line.quantityMinor, line.uom)}.` });
      }
      // OB-160 "A": whole packs only — 15 sticks from packs of 10 is one pack and five loose cigarettes.
      for (const b of verdict.blocks.filter((x) => x.reason === 'not_whole_packs')) {
        const pack = flags.packMinimumMinor;
        const down = Math.floor(line.quantityMinor / pack) * pack;
        out.push({ reason: 'tobacco_not_whole_packs', productId: line.productId, detail: b.detail,
          laneMessage: `${name} is tobacco and is sold only in whole packs of ${qtyWords(pack, line.uom)}. This line is ${qtyWords(line.quantityMinor, line.uom)}, which is not a whole number of packs — make it ${qtyWords(down, line.uom)} or ${qtyWords(down + pack, line.uom)}.` });
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
