// B18 (roadmap v2.1 · owner decision OB-310, 23 Oct 2026, in writing: "sell no medicines; category stays blocked").
//
// Selling medicines lawfully needs a drug licence and a registered pharmacist (Drugs and Cosmetics Act 1940; only the
// remedies of Schedule K may be sold without one, and the owner chose not to sell those either). So, like liquor (B17),
// a medicine is NOT SOLD here at all: refused when a product is published, left out of every pack, refused at the till
// (offline, from the pack and the line itself) and refused again at head office's sale intake.
//
// What makes a product a medicine is DECLARED, never guessed from its name:
//   • the product master says so (`safety.medicine: true`), or its category is regulated `drug` (the pharmacy and
//     prescription categories — `otc_pharma_lite`, `prescription_blocked` — are `drug` categories); or
//   • its HSN is a medicaments heading — 3003 (medicaments not in measured doses) or 3004 (medicaments in measured doses
//     or packed for retail sale). Bandages and first-aid dressings (3005), vaccines and blood products (3002) and
//     cosmetics (33xx) are not caught here.
//
// Pure and deterministic. There is no override: it is the owner's written decision and the law's licence requirement.

/** The HSN headings (first four digits) of medicaments (Customs Tariff Chapter 30). */
export const MEDICINE_HSN_HEADINGS: readonly string[] = Object.freeze(['3003', '3004']);

/** True when an HSN code falls under a medicaments heading. Spaces and dots are ignored ("3004.90" → 3004). */
export function isMedicineHsn(hsn: string | null | undefined): boolean {
  if (typeof hsn !== 'string') return false;
  const digits = hsn.replace(/[\s.]/g, '');
  return /^\d{4,8}$/.test(digits) && MEDICINE_HSN_HEADINGS.includes(digits.slice(0, 4));
}

/** What a product must say for the medicine rule to judge it — the declared mark, its category's kinds, its HSN. */
export interface MedicineFacts {
  readonly declaredMedicine?: boolean;
  readonly categoryKinds?: readonly string[];
  readonly hsn?: string | null;
}

/** Why a product is a medicine, in plain words — or undefined when it is not. */
export function medicineReason(facts: MedicineFacts): string | undefined {
  if (facts.declaredMedicine === true) return 'it is marked as a medicine on the product master';
  if ((facts.categoryKinds ?? []).includes('drug')) return 'its category is a medicine (pharmacy) category';
  if (isMedicineHsn(facts.hsn)) return `its HSN ${String(facts.hsn)} is a medicaments heading (${MEDICINE_HSN_HEADINGS.join(', ')})`;
  return undefined;
}

/** The words every refusal uses — the same at head office and at the till. */
export const MEDICINE_NOT_SOLD = 'Medicines are not sold: SRE holds no drug licence and has no pharmacist, and the owner decided to sell no medicines (OB-310 · B18).';

/** What the cashier is told, in English and Tamil. */
export const MEDICINE_LANE_WORDS: { readonly en: string; readonly ta: string } = Object.freeze({
  en: 'Medicines are not sold in this shop. Keep it off the bill and tell the manager.',
  ta: 'இந்தக் கடையில் மருந்துகள் விற்கப்படுவதில்லை. பில்லில் சேர்க்க வேண்டாம்; மேலாளரிடம் சொல்லுங்கள்.',
});
