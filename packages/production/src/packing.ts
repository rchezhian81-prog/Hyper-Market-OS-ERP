// Packing, labels, shelf life, quality release and repacking (M11-FR-03).
//
// A freshly made item is not sellable because it exists. It is sellable when
// somebody has looked at it and said so, and when it carries a label that tells the
// customer what it is, how much of it there is, and when it stops being safe to eat.
//
// So two gates, both enforced rather than remembered:
//
//   1. THE LABEL MUST BE COMPLETE. A label missing its net quantity, its packer
//      details, or its use-by date is refused before it prints. A wrong label is not
//      a printing problem — it is a Legal Metrology offence and, on a use-by date, a
//      food-safety one (§9.3).
//
//   2. THE STOCK MUST BE RELEASED. Production output lands in QUARANTINE (see
//      `recipe.ts`), and only a quality release moves it to sellable. Release is
//      refused for a batch that has already expired, or that failed its check — you
//      cannot release your way past a use-by date.
//
// Repacking is traceable by construction: a repack records the batch it came from,
// so a recall on the source reaches everything made out of it (M10-FR-03).
//
// Permission to release belongs to `packages/rbac` — this module enforces the
// *rules*, not who may invoke them, which is the split used everywhere else here.
//
// Pure and deterministic: the timestamp is injected, there is no clock.

import type { Money } from '../../contracts/src/money';
import { shownShopDateTime } from '../../calendar/src/shop-day';
import type { StockMovement } from '../../stock/src/position';
import type { ProductionDepartment } from './departments';
import { checkLooseFoodLabel, MAJOR_ALLERGENS, type Allergen, type VegClass } from '../../product/src/loose-food-label';
import { validateLabelHeight, InvalidLabelHeightInput, type LabelHeightCheck } from '../../product/src/label-height';
import { unitSalePrice, InvalidUnitPriceInput, type NetQuantityUnit, type UnitSalePrice } from '../../product/src/unit-price';

/**
 * B24 (roadmap v2.1, Packaged Commodities Rule 9): the label stock a counter prints on and the character heights its
 * template prints the declarations at. The principal display panel's area sets the legal minimum height (the tested
 * `validateLabelHeight`); a template whose letters or numerals are below it is refused before anything prints.
 */
export interface LabelTemplate {
  readonly templateId: string;
  /** Area of the principal display panel, in square centimetres (width × height of the printed face). */
  readonly principalPanelAreaCm2: number;
  /** The smallest letter height the template prints a declaration in, in millimetres. */
  readonly letterHeightMm: number;
  /** The smallest numeral height the template prints a declaration in (net quantity, price, dates), in millimetres. */
  readonly numeralHeightMm: number;
}

/**
 * The counter label the production screens print on unless a printer names its own: a 58 × 40 mm thermal label
 * (23.2 cm² — Rule 9's smallest band, 1 mm minimum), printed at 2 mm letters and numerals.
 */
export const COUNTER_LABEL_TEMPLATE: LabelTemplate = Object.freeze({
  templateId: 'counter-58x40', principalPanelAreaCm2: 23.2, letterHeightMm: 2, numeralHeightMm: 2,
});

/** B9: the eight major allergen groups (FSSAI Labelling & Display Regulations 2020), as the label prints them. */
export const ALLERGEN_WORDS: Readonly<Record<Allergen, string>> = Object.freeze({
  cereals_gluten: 'Cereals containing gluten', crustaceans: 'Crustaceans', eggs: 'Eggs', fish: 'Fish',
  peanuts_tree_nuts: 'Peanuts and tree nuts', milk: 'Milk', soybeans: 'Soybeans', sulphites: 'Sulphites',
});
export { MAJOR_ALLERGENS };

/** What must appear on a pack label. Some of it is the law, not a preference. */
export interface PackLabel {
  readonly productId: string;
  readonly productName: string;
  readonly batchId: string;
  /** Net quantity as declared, e.g. "180 g" — a Legal Metrology field (§9.3). */
  readonly netQuantity: string;
  /** Name and address of the packer — a Legal Metrology field. */
  readonly packerDetails: string;
  /** ISO-8601 UTC — when it stops being safe to sell or eat. */
  readonly useBy: string;
  readonly price: Money;
  /** Weight in the UOM's smallest unit, for a weighed item. */
  readonly weightMinor?: number;
  /** The barcode the till scans. Embedded weight/price where the item is weighed. */
  readonly barcode?: string;
  /**
   * Allergens, where the department produces food (M03-FR-03): the major allergen groups present (B9 — only the eight
   * FSSAI groups, `MAJOR_ALLERGENS`), or an EMPTY list for an explicit "none of them". Absent = nobody declared anything.
   */
  readonly allergens?: readonly string[];
  /** B9: the veg / non-veg mark — mandatory on in-store and loose food (FSSAI). */
  readonly vegClass?: VegClass;
  /** B24: the label stock and character heights it prints at; absent → `COUNTER_LABEL_TEMPLATE`. */
  readonly template?: LabelTemplate;
  readonly producedAt: string;
}

/** What a lawful label carries beyond its fields: the unit sale price (B3) and the print sizes it was judged at (B24). */
export interface PreparedLabel extends PackLabel {
  readonly template: LabelTemplate;
  /** B24: the Rule 9 minimum height for this panel, and both heights it was checked at. */
  readonly heights: { readonly letters: LabelHeightCheck; readonly numerals: LabelHeightCheck };
  /** B3: ₹ per kg / litre / piece, worked out from the price and the net quantity; absent where no net quantity is declared. */
  readonly unitPrice?: UnitSalePrice;
}

/**
 * B3: read a declared net quantity ("180 g", "1.5 kg", "500 ml", "1 L", "6 pieces") into a whole amount in a unit the
 * tested `unitSalePrice` divides by — kilograms and litres in grams and millilitres. Undefined when it cannot be read.
 */
export function readNetQuantity(text: string): { readonly netQuantity: number; readonly unit: NetQuantityUnit } | undefined {
  const m = /^\s*(\d+(?:\.\d{1,3})?)\s*(g|gm|gms|grams?|kg|kgs|ml|l|ltr|litres?|liters?|pcs?|pieces?|units?|nos?|u)\s*$/i.exec(text);
  if (m === null) return undefined;
  const [whole, frac = ''] = m[1]!.split('.');
  const thousandths = Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
  const word = m[2]!.toLowerCase();
  const unit: NetQuantityUnit = /^(g|gm|gms|grams?)$/.test(word) ? 'g' : /^kgs?$/.test(word) ? 'kg' : word === 'ml' ? 'ml' : /^(l|ltr|litres?|liters?)$/.test(word) ? 'l' : 'piece';
  if (unit === 'kg') return thousandths > 0 ? { netQuantity: thousandths, unit: 'g' } : undefined;
  if (unit === 'l') return thousandths > 0 ? { netQuantity: thousandths, unit: 'ml' } : undefined;
  if (thousandths % 1000 !== 0 || thousandths === 0) return undefined; // grams, millilitres and pieces are whole
  return { netQuantity: thousandths / 1000, unit };
}

export class IncompleteLabelError extends Error {
  constructor(
    public readonly batchId: string,
    public readonly missing: string,
  ) {
    super(
      `The label for batch "${batchId}" cannot print without ${missing} — a wrong label is a legal problem, not a printing one (§9.3)`,
    );
    this.name = 'IncompleteLabelError';
  }
}

/**
 * Build a pack label, refusing anything that would print an unlawful one. What is
 * mandatory depends on the DEPARTMENT: a cafe sandwich needs its net quantity and
 * allergens; only a weighed department needs a weight on the label.
 */
export function buildPackLabel(
  label: PackLabel,
  department: ProductionDepartment,
): PreparedLabel {
  if (label.productName.trim() === '') {
    throw new IncompleteLabelError(label.batchId, 'the product name');
  }
  if (label.useBy.trim() === '') {
    throw new IncompleteLabelError(label.batchId, 'a use-by date');
  }
  if (department.legalMetrology) {
    if (label.netQuantity.trim() === '') {
      throw new IncompleteLabelError(label.batchId, 'the net quantity (Legal Metrology)');
    }
    if (label.packerDetails.trim() === '') {
      throw new IncompleteLabelError(label.batchId, 'the packer’s name and address (Legal Metrology)');
    }
  }
  if (department.foodSafety && label.allergens === undefined) {
    // The same rule as the product master: an empty list is a declaration of
    // "none"; saying nothing is not.
    throw new IncompleteLabelError(
      label.batchId,
      'an allergen declaration — state the allergens, or state explicitly that there are none',
    );
  }
  if (department.foodSafety) {
    // B9 (FSSAI Labelling & Display 2020): food made at the counter carries the veg / non-veg mark and declares its major
    // allergens from the EIGHT groups — the tested `checkLooseFoodLabel`. A gap, or a word that is not one of the groups,
    // blocks the label: an undeclared allergen on prepared food is a safety failure, not a formatting one.
    const food = checkLooseFoodLabel({
      ...(label.vegClass === undefined ? {} : { vegClass: label.vegClass }),
      allergenDeclarationProvided: label.allergens !== undefined,
      allergensPresent: label.allergens ?? [],
    });
    if (!food.valid) {
      throw new IncompleteLabelError(label.batchId, food.problems.map((p) => p.startsWith('vegMark')
        ? 'the veg or non-veg mark (mandatory on food made in the store)'
        : p.startsWith('allergen "')
          ? `${p.replace(/^allergen /, 'a known allergen group — ')} (the eight are: ${MAJOR_ALLERGENS.map((a) => ALLERGEN_WORDS[a]).join(', ')})`
          : 'an allergen declaration — state the allergen groups present, or state explicitly that there are none').join('; and '));
    }
  }
  if (department.weighedOutput && label.weightMinor === undefined) {
    throw new IncompleteLabelError(label.batchId, 'the weight (this department sells by weight)');
  }
  // B24 (Rule 9): the template must print every declaration at least as tall as the law requires for its panel. A render
  // too small FAILS here — nothing prints — rather than producing a label every word of which is present but illegible.
  const template = label.template ?? COUNTER_LABEL_TEMPLATE;
  let heights: PreparedLabel['heights'];
  try {
    heights = {
      letters: validateLabelHeight({ principalPanelAreaCm2: template.principalPanelAreaCm2, declaredHeightMm: template.letterHeightMm }),
      numerals: validateLabelHeight({ principalPanelAreaCm2: template.principalPanelAreaCm2, declaredHeightMm: template.numeralHeightMm }),
    };
  } catch (e) {
    if (e instanceof InvalidLabelHeightInput) throw new LabelTooSmallError(label.batchId, template, `${e.message}`);
    throw e;
  }
  if (!heights.letters.valid || !heights.numerals.valid) {
    const bad = [heights.letters.valid ? '' : `letters ${heights.letters.detail}`, heights.numerals.valid ? '' : `numerals ${heights.numerals.detail}`].filter((s) => s !== '');
    throw new LabelTooSmallError(label.batchId, template, bad.join('; '));
  }
  // B3: the unit sale price — ₹ per kg / litre / piece — from the price and the net quantity (a weighed pack: its weight).
  // A Legal Metrology department whose net quantity the price cannot be divided by is refused: the price per unit would
  // otherwise be silently missing from the label (P-08).
  let unitPrice: UnitSalePrice | undefined;
  const net = label.weightMinor !== undefined ? { netQuantity: label.weightMinor, unit: 'g' as const } : readNetQuantity(label.netQuantity);
  if (department.legalMetrology || net !== undefined) {
    if (net === undefined) {
      throw new IncompleteLabelError(label.batchId, `a net quantity the price per unit can be worked out from (it reads "${label.netQuantity}"; write it like 180 g, 1.5 kg, 500 ml, 1 L or 6 pieces)`);
    }
    try {
      unitPrice = unitSalePrice({ mrpMinor: label.price.minor, netQuantity: net.netQuantity, unit: net.unit, principalPanelAreaCm2: template.principalPanelAreaCm2 });
    } catch (e) {
      if (e instanceof InvalidUnitPriceInput) throw new IncompleteLabelError(label.batchId, `a price above zero (${e.message})`);
      throw e;
    }
  }
  return { ...label, template, heights, ...(unitPrice === undefined ? {} : { unitPrice }) };
}

/** B24: the template would print the declarations smaller than Rule 9 allows for its panel — nothing prints. */
export class LabelTooSmallError extends Error {
  constructor(
    public readonly batchId: string,
    public readonly template: LabelTemplate,
    detail: string,
  ) {
    super(`The label for batch "${batchId}" cannot print on template ${template.templateId}: ${detail}`);
    this.name = 'LabelTooSmallError';
  }
}

/** B24: read a printer's label template strictly — every number positive and finite; anything else is not a template. */
export function readLabelTemplate(v: unknown): LabelTemplate | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const pos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (typeof o['templateId'] !== 'string' || o['templateId'].trim() === '' || !pos(o['principalPanelAreaCm2']) || !pos(o['letterHeightMm']) || !pos(o['numeralHeightMm'])) return undefined;
  return { templateId: o['templateId'].trim(), principalPanelAreaCm2: o['principalPanelAreaCm2'], letterHeightMm: o['letterHeightMm'], numeralHeightMm: o['numeralHeightMm'] };
}

/** What a printer and a screen are told beside the lines: the sizes to print at (B24) and the unit sale price (B3). */
export function labelPrintFacts(label: PreparedLabel): {
  readonly print: { readonly templateId: string; readonly principalPanelAreaCm2: number; readonly minHeightMm: number; readonly letterHeightMm: number; readonly numeralHeightMm: number };
  readonly unitPrice: { readonly unitPriceMinor: number; readonly per: UnitSalePrice['per']; readonly exempt: boolean } | null;
  readonly vegClass: VegClass | null;
} {
  return {
    print: {
      templateId: label.template.templateId, principalPanelAreaCm2: label.template.principalPanelAreaCm2,
      minHeightMm: label.heights.letters.minHeightMm, letterHeightMm: label.template.letterHeightMm, numeralHeightMm: label.template.numeralHeightMm,
    },
    unitPrice: label.unitPrice === undefined ? null : { unitPriceMinor: label.unitPrice.unitPriceMinor, per: label.unitPrice.per, exempt: label.unitPrice.exempt },
    vegClass: label.vegClass ?? null,
  };
}

const UNIT_WORD: Readonly<Record<UnitSalePrice['per'], string>> = Object.freeze({ kg: 'kg', l: 'litre', unit: 'piece' });
const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/**
 * Render a label as text lines — the same shape the receipt renderer uses, so a
 * counter printer needs no new plumbing.
 *
 * OB-607: the USE BY is printed on the SHOP's clock, in `timeZone` — the store pack's zone on the store computer (offline,
 * no network call) or the tenant's calendar at head office; absent (or a zone nobody knows) → the shop default
 * (Asia/Kolkata), never UTC. A pack made at 01:00 in the shop and good for six hours reads "USE BY … 07:00", not 01:30.
 */
export function renderLabel(label: PackLabel | PreparedLabel, timeZone?: string): readonly string[] {
  const prepared = 'heights' in label ? label : undefined;
  const lines = [
    // B9: the veg / non-veg mark first, where a food label carries one (green dot = veg, brown triangle = non-veg).
    label.vegClass === 'veg' ? '[●] VEG' : label.vegClass === 'non_veg' ? '[▲] NON-VEG' : '',
    label.productName,
    `Batch ${label.batchId}`,
    label.netQuantity === '' ? '' : `Net ${label.netQuantity}`,
    label.weightMinor === undefined ? '' : `Weight ${(label.weightMinor / 1000).toFixed(3)} kg`,
    `USE BY ${shownShopDateTime(label.useBy, timeZone)}`,
    label.allergens === undefined
      ? ''
      : label.allergens.length === 0
        ? (label.vegClass === undefined ? 'Allergens: none declared' : 'Allergens: none of the 8 major groups')
        : `Contains: ${label.allergens.map((a) => ALLERGEN_WORDS[a as Allergen] ?? a).join(', ')}`,
    label.packerDetails === '' ? '' : `Packed by ${label.packerDetails}`,
    `${label.price.currency} ${(label.price.minor / 100).toFixed(2)}`,
    // B3: the unit sale price beside the price (said even where an exemption makes it optional — never hidden).
    prepared?.unitPrice === undefined ? '' : `Unit price ${rupees(prepared.unitPrice.unitPriceMinor)} per ${UNIT_WORD[prepared.unitPrice.per]}`,
    label.barcode === undefined ? '' : label.barcode,
  ];
  return lines.filter((line) => line !== '');
}

// --- quality release -----------------------------------------------------------

export interface QualityRelease {
  readonly batchId: string;
  readonly releasedBy: string;
  readonly qcPassed: boolean;
  readonly at: string;
  readonly notes?: string;
}

export type ReleaseRefusal =
  | 'qc_failed'
  | 'already_expired'
  | 'no_releaser'
  | 'nothing_to_release'
  | 'released';

export interface ReleaseResult {
  readonly batchId: string;
  readonly released: boolean;
  readonly outcome: ReleaseRefusal;
  readonly detail: string;
  /** The movement out of quarantine into sellable stock — empty when refused. */
  readonly movements: readonly StockMovement[];
}

/**
 * Release a produced batch for sale. Moves it out of quarantine — and only out of
 * quarantine, so a batch that was never produced cannot be conjured onto the shelf.
 */
export function releaseForSale(input: {
  readonly release: QualityRelease;
  readonly productId: string;
  readonly locationId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  /** When the batch expires, from production. */
  readonly expiresAt: string;
}): ReleaseResult {
  const { release } = input;
  const base = { batchId: release.batchId, movements: [] as readonly StockMovement[] };

  if (release.releasedBy.trim() === '') {
    return {
      ...base,
      released: false,
      outcome: 'no_releaser',
      detail: 'a release must be made by a named person — "it was checked" is not evidence',
    };
  }
  if (input.quantityMinor <= 0) {
    return { ...base, released: false, outcome: 'nothing_to_release', detail: 'there is nothing to release' };
  }
  if (!release.qcPassed) {
    return {
      ...base,
      released: false,
      outcome: 'qc_failed',
      detail: `the quality check failed${release.notes === undefined ? '' : ` — ${release.notes}`}; the batch stays in quarantine`,
    };
  }
  if (input.expiresAt <= release.at) {
    // You cannot release your way past a use-by date.
    return {
      ...base,
      released: false,
      outcome: 'already_expired',
      detail: `the batch expired at ${input.expiresAt} and can never be released`,
    };
  }

  return {
    batchId: release.batchId,
    released: true,
    outcome: 'released',
    detail: `released for sale by ${release.releasedBy}`,
    movements: [
      {
        movementId: `${release.batchId}-release`,
        productId: input.productId,
        locationId: input.locationId,
        batchId: release.batchId,
        from: 'quarantine',
        to: 'on_hand',
        quantityMinor: input.quantityMinor,
        uom: input.uom,
        at: release.at,
        reason: `quality release by ${release.releasedBy}`,
      },
    ],
  };
}

// --- repacking -----------------------------------------------------------------

export interface RepackRequest {
  readonly repackId: string;
  readonly sourceBatchId: string;
  readonly newBatchId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly repackedBy: string;
  readonly at: string;
  /** The source batch's expiry — a repack NEVER extends it. */
  readonly sourceExpiresAt: string;
}

export interface RepackResult {
  readonly repackId: string;
  readonly newBatchId: string;
  readonly sourceBatchId: string;
  /** Inherited, never reset — repacking does not make food younger. */
  readonly expiresAt: string;
  readonly movements: readonly StockMovement[];
}

export class RepackError extends Error {
  constructor(
    public readonly repackId: string,
    reason: string,
  ) {
    super(`Repack "${repackId}" refused: ${reason}`);
    this.name = 'RepackError';
  }
}

/**
 * Repack a batch into a new one. The new batch keeps the SOURCE's expiry — putting
 * food in a fresh wrapper does not make it fresh — and records where it came from,
 * so a recall on the source reaches everything made out of it (M10-FR-03).
 */
export function repack(request: RepackRequest): RepackResult {
  if (request.sourceBatchId === request.newBatchId) {
    throw new RepackError(request.repackId, 'the new batch must be distinguishable from its source');
  }
  if (request.quantityMinor <= 0) {
    throw new RepackError(request.repackId, 'there is nothing to repack');
  }
  if (request.sourceExpiresAt <= request.at) {
    throw new RepackError(
      request.repackId,
      'the source batch has already expired — repacking is not a way to sell it',
    );
  }

  return {
    repackId: request.repackId,
    newBatchId: request.newBatchId,
    sourceBatchId: request.sourceBatchId,
    expiresAt: request.sourceExpiresAt,
    movements: [
      {
        movementId: `${request.repackId}-out`,
        productId: request.productId,
        locationId: request.locationId,
        batchId: request.sourceBatchId,
        from: 'on_hand',
        to: null,
        quantityMinor: request.quantityMinor,
        uom: request.uom,
        at: request.at,
        reason: `repacked into ${request.newBatchId} by ${request.repackedBy}`,
      },
      {
        movementId: `${request.repackId}-in`,
        productId: request.productId,
        locationId: request.locationId,
        batchId: request.newBatchId,
        from: null,
        to: 'quarantine', // a repack is released like any other production output
        quantityMinor: request.quantityMinor,
        uom: request.uom,
        at: request.at,
        reason: `repacked from ${request.sourceBatchId} by ${request.repackedBy}`,
      },
    ],
  };
}
