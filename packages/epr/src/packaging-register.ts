// Plastic EPR register for the shop's own-brand packaging (R4 · B20 · OB-212 · OB-227). The signed sentence:
//   "Every product you mark as the shop's own brand carries its plastic packaging category and its weight per unit. One
//    without them is listed as an exception ('packaging declaration missing') and is never counted as zero. For a
//    financial year, the system totals the plastic put on the market per category, to the gram, from the units received
//    and produced, as a sortable file for the CPCB portal. Nothing is filed automatically. The EPR registration number
//    and any exemption are settings with their reference; until the CA or EPR consultant confirms them they show 'not
//    confirmed'."
//
// OB-212: the owner is not sure which EPR rules apply, so the shop builds the register and the yearly figures; the CA
// or an EPR consultant says what (if anything) is registered or filed on the CPCB portal. This file files nothing.
//
// The categories are the four plastic packaging categories of the Plastic Waste Management Rules (as amended, 2022):
// I rigid; II flexible single-layer or multilayer of different types of plastic; III multilayered with at least one
// layer of plastic and one of another material; IV compostable plastic. Which category a pack is in is the declaring
// person's (and their consultant's) answer, recorded with the product.
//
// Weights are whole MILLIGRAMS per unit (a 2.5 g sachet is 2500), so a total is exact; the yearly figure is given to the
// gram (rounded half up, once, on the total). Pure and deterministic: no clock, no I/O.

export type PlasticCategory = 'I' | 'II' | 'III' | 'IV';
export const PLASTIC_CATEGORIES: readonly PlasticCategory[] = Object.freeze(['I', 'II', 'III', 'IV']);
export const PLASTIC_CATEGORY_WORDS: Readonly<Record<PlasticCategory, string>> = Object.freeze({
  I: 'Category I — rigid plastic packaging',
  II: 'Category II — flexible plastic packaging (single layer or multilayer of different plastics)',
  III: 'Category III — multilayered packaging (at least one layer of plastic and one of another material)',
  IV: 'Category IV — compostable plastic packaging',
});

/** One packaging component of one unit of the product. */
export interface PackagingLine {
  readonly category: PlasticCategory;
  /** Plastic in one unit, in whole milligrams (> 0). */
  readonly weightPerUnitMg: number;
  readonly description?: string;
}

/** The latest own-brand declaration of a product (append-only; a later one replaces it). */
export interface OwnBrandDeclaration {
  readonly productId: string;
  readonly ownBrand: boolean;
  /** Empty while the packaging is not declared — then the product is an exception, never counted as zero. */
  readonly packaging: readonly PackagingLine[];
  readonly by: string;
  readonly at: string;
}

/** A unit put on the market: a receipt or a production output of a product, from the stock ledger. */
export interface UnitsMovement {
  readonly productId: string;
  readonly kind: 'received' | 'produced';
  readonly quantityMinor: number;
  readonly uom: string;
  /** Store-local date YYYY-MM-DD. */
  readonly date: string;
}

export class InvalidEprInput extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidEprInput'; }
}

/** Whether a packaging line is complete and readable. */
export function packagingLineIsValid(v: unknown): v is PackagingLine {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as Record<string, unknown>;
  return (PLASTIC_CATEGORIES as readonly unknown[]).includes(l['category']) && Number.isInteger(l['weightPerUnitMg']) && (l['weightPerUnitMg'] as number) > 0 && (l['weightPerUnitMg'] as number) <= 100_000_000
    && (l['description'] === undefined || typeof l['description'] === 'string');
}

/** The financial year label for a date — April to March ("2026-27" runs 2026-04-01 to 2027-03-31). */
export function financialYearOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The first and last day of a financial year label ("2026-27"). */
export function financialYearBounds(fy: string): { readonly from: string; readonly to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (m === null || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new InvalidEprInput(`a financial year reads like 2026-27, not "${fy}"`);
  return { from: `${m[1]}-04-01`, to: `${Number(m[1]) + 1}-03-31` };
}

export interface PlasticProductRow {
  readonly productId: string;
  readonly category: PlasticCategory;
  readonly weightPerUnitMg: number;
  readonly unitsReceived: number;
  readonly unitsProduced: number;
  readonly units: number;
  readonly totalMg: number;
}

export interface PlasticCategoryTotal {
  readonly category: PlasticCategory;
  readonly label: string;
  readonly products: number;
  readonly units: number;
  readonly totalMg: number;
  /** The plastic put on the market, to the gram. */
  readonly totalGrams: number;
}

export interface PlasticException {
  readonly productId: string;
  readonly kind: 'packaging_declaration_missing' | 'not_counted_in_items';
  readonly detail: string;
}

export interface PlasticReturn {
  readonly financialYear: string;
  readonly from: string;
  readonly to: string;
  readonly categories: readonly PlasticCategoryTotal[];
  readonly rows: readonly PlasticProductRow[];
  /** Own-brand products the totals could not count — never counted as zero. */
  readonly exceptions: readonly PlasticException[];
  /** True while there is any exception: the totals are incomplete and say so. */
  readonly incomplete: boolean;
  readonly csv: string;
  readonly filing: 'not_filed_by_the_system';
}

const grams = (mg: number): number => Math.round(mg / 1000);
const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const g3 = (mg: number): string => (mg / 1000).toFixed(3);

/**
 * The year's plastic put on the market by the shop's own brand, per category. Units come from the stock ledger's
 * receipts and production outputs in the year (counted in items); each own-brand product's latest declaration gives its
 * packaging. An own-brand product with no packaging declared — or one sold by weight or volume, which has no "units" —
 * is an exception and is not counted, and the return says it is incomplete. Pure.
 */
export function plasticReturn(input: {
  readonly financialYear: string;
  readonly declarations: readonly OwnBrandDeclaration[];
  readonly movements: readonly UnitsMovement[];
}): PlasticReturn {
  const { from, to } = financialYearBounds(input.financialYear);
  const latest = new Map<string, OwnBrandDeclaration>();
  for (const d of input.declarations) latest.set(d.productId, d);
  const ownBrand = [...latest.values()].filter((d) => d.ownBrand).sort((a, b) => a.productId.localeCompare(b.productId));
  const exceptions: PlasticException[] = [];
  const rows: PlasticProductRow[] = [];
  for (const d of ownBrand) {
    const moved = input.movements.filter((m) => m.productId === d.productId && m.date >= from && m.date <= to);
    if (d.packaging.length === 0) {
      exceptions.push({ productId: d.productId, kind: 'packaging_declaration_missing', detail: `packaging declaration missing: ${d.productId} is marked own brand with no plastic packaging category and weight per unit — not counted` });
      continue;
    }
    const notItems = moved.filter((m) => m.uom.toLowerCase() !== 'ea');
    if (notItems.length > 0) {
      exceptions.push({ productId: d.productId, kind: 'not_counted_in_items', detail: `${d.productId} moved in ${[...new Set(notItems.map((m) => m.uom))].join(', ')}, not in items — its packaging per unit cannot be counted; not counted` });
      continue;
    }
    const received = moved.filter((m) => m.kind === 'received').reduce((s, m) => s + m.quantityMinor, 0);
    const produced = moved.filter((m) => m.kind === 'produced').reduce((s, m) => s + m.quantityMinor, 0);
    // One row per category the product's packaging has (a jar and its film are two lines).
    const byCategory = new Map<PlasticCategory, number>();
    for (const l of d.packaging) byCategory.set(l.category, (byCategory.get(l.category) ?? 0) + l.weightPerUnitMg);
    for (const [category, weightPerUnitMg] of byCategory) {
      const units = received + produced;
      rows.push({ productId: d.productId, category, weightPerUnitMg, unitsReceived: received, unitsProduced: produced, units, totalMg: units * weightPerUnitMg });
    }
  }
  rows.sort((a, b) => a.category.localeCompare(b.category) || a.productId.localeCompare(b.productId));
  const categories = PLASTIC_CATEGORIES.map((category): PlasticCategoryTotal => {
    const mine = rows.filter((r) => r.category === category);
    const totalMg = mine.reduce((s, r) => s + r.totalMg, 0);
    return { category, label: PLASTIC_CATEGORY_WORDS[category], products: mine.length, units: mine.reduce((s, r) => s + r.units, 0), totalMg, totalGrams: grams(totalMg) };
  });
  const header = ['financial_year', 'category', 'product_id', 'plastic_per_unit_g', 'units_received', 'units_produced', 'units_put_on_market', 'plastic_g'];
  const lines = rows.map((r) => [input.financialYear, r.category, r.productId, g3(r.weightPerUnitMg), r.unitsReceived, r.unitsProduced, r.units, g3(r.totalMg)].map(csvCell).join(','));
  const totals = categories.filter((c) => c.products > 0).map((c) => [input.financialYear, c.category, 'TOTAL', '', '', '', c.units, String(c.totalGrams)].map(csvCell).join(','));
  const notes = exceptions.map((e) => [input.financialYear, '', e.productId, 'EXCEPTION', '', '', '', csvCell(e.detail)].join(','));
  return {
    financialYear: input.financialYear, from, to, categories, rows, exceptions, incomplete: exceptions.length > 0,
    csv: [header.join(','), ...lines, ...totals, ...notes].join('\n') + '\n',
    filing: 'not_filed_by_the_system',
  };
}

// ── the EPR settings: registration and any exemption (B20), brand-owner duties (B21, B22) ──────────────────────────

export type EprSettingKey = 'plasticRegistration' | 'plasticExemption' | 'eWasteBrandOwner' | 'batteryBrandOwner';
export const EPR_SETTING_KEYS: readonly EprSettingKey[] = Object.freeze(['plasticRegistration', 'plasticExemption', 'eWasteBrandOwner', 'batteryBrandOwner']);
export const EPR_SETTINGS: Readonly<Record<EprSettingKey, { readonly label: string; readonly item: 'B20' | 'B21' | 'B22' }>> = Object.freeze({
  plasticRegistration: { label: 'Plastic EPR registration number on the CPCB portal', item: 'B20' },
  plasticExemption: { label: 'Any plastic EPR exemption (for example, as a micro or small enterprise)', item: 'B20' },
  eWasteBrandOwner: { label: 'Whether the shop must register as an e-waste producer or brand owner', item: 'B21' },
  batteryBrandOwner: { label: 'Whether the shop must register as a battery producer or brand owner', item: 'B22' },
});

/** One EPR setting: the answer, and who confirmed it with their reference. */
export interface EprSetting {
  readonly value: string | null;
  readonly confirmation: string | null;
}

export interface EprSettingChange { readonly key: EprSettingKey; readonly setting: EprSetting; readonly by: string; readonly at: string }

export interface EprSettingStatus {
  readonly key: EprSettingKey;
  readonly label: string;
  readonly item: 'B20' | 'B21' | 'B22';
  readonly value: string | null;
  readonly confirmation: string | null;
  readonly status: 'confirmed' | 'not_confirmed';
}

/** Each EPR setting, latest per key, "not confirmed" until it has both an answer and who confirmed it. Pure. */
export function eprSettingStatuses(changes: readonly EprSettingChange[]): readonly EprSettingStatus[] {
  const latest = new Map<EprSettingKey, EprSetting>();
  for (const c of changes) latest.set(c.key, c.setting);
  return EPR_SETTING_KEYS.map((key) => {
    const s = latest.get(key) ?? { value: null, confirmation: null };
    const ok = typeof s.value === 'string' && s.value.trim() !== '' && typeof s.confirmation === 'string' && s.confirmation.trim() !== '';
    return { key, ...EPR_SETTINGS[key], value: s.value, confirmation: s.confirmation, status: ok ? 'confirmed' : 'not_confirmed' };
  });
}
