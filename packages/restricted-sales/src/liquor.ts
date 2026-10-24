// B17 (roadmap v2.1 · OWNER_DECISIONS D3, 11 Aug 2026): retail liquor in Tamil Nadu is a TASMAC state monopoly. A private
// hypermarket cannot sell IMFL, beer, wine or any other alcoholic drink, and the owner removed liquor from scope: "All
// liquor/excise items are out of scope." So liquor is not age-checked here — it is NOT SOLD at all: refused when a product
// is published, left out of every pack, refused at the till (offline, from the pack and the line itself) and refused again
// at head office's sale intake.
//
// What makes a product liquor is DECLARED, never guessed from its name:
//   • the product master says so (`safety.liquor: true`), or its category is regulated `liquor`; or
//   • its HSN is one of the customs-tariff headings for alcoholic drinks — 2203 (beer), 2204 (wine), 2205 (vermouth),
//     2206 (other fermented drinks: cider, perry, mead), 2208 (spirits and liqueurs). Non-alcoholic beer is 2202 and is
//     not caught. 2207 (ethyl alcohol, including denatured spirit) is industrial and not a drink, so it is not caught here.
//
// Pure and deterministic. There is no override: the prohibition is the law of the state, not a store policy.

/** The HSN headings (first four digits) of alcoholic drinks (Customs Tariff Chapter 22). */
export const LIQUOR_HSN_HEADINGS: readonly string[] = Object.freeze(['2203', '2204', '2205', '2206', '2208']);

/** True when an HSN code falls under an alcoholic-drink heading. Spaces and dots are ignored ("2203.00" → 2203). */
export function isLiquorHsn(hsn: string | null | undefined): boolean {
  if (typeof hsn !== 'string') return false;
  const digits = hsn.replace(/[\s.]/g, '');
  return /^\d{4,8}$/.test(digits) && LIQUOR_HSN_HEADINGS.includes(digits.slice(0, 4));
}

/** What a product must say for the liquor rule to judge it — the declared flag, its category's kinds, its HSN. */
export interface LiquorFacts {
  readonly declaredLiquor?: boolean;
  readonly categoryKinds?: readonly string[];
  readonly hsn?: string | null;
}

/** Why a product is liquor, in plain words — or undefined when it is not. */
export function liquorReason(facts: LiquorFacts): string | undefined {
  if (facts.declaredLiquor === true) return 'it is marked as liquor on the product master';
  if ((facts.categoryKinds ?? []).includes('liquor')) return 'its category is a liquor category';
  if (isLiquorHsn(facts.hsn)) return `its HSN ${String(facts.hsn)} is an alcoholic-drink heading (${LIQUOR_HSN_HEADINGS.join(', ')})`;
  return undefined;
}

/** The words every refusal uses — the same at head office and at the till. */
export const LIQUOR_NOT_SOLD = 'Liquor is not sold: retail liquor in Tamil Nadu is a TASMAC state monopoly, and SRE does not sell any alcoholic drink (B17).';
