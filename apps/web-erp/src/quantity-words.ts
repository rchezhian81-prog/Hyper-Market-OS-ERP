// A quantity in the shop's own words (daily-work defects D-016 · D-037 · OB-31) — DOM-free, tested.
//
// Head office keeps every quantity as a whole count of its unit's smallest step (OB-31): a COUNT for pieces (`ea`), grams
// for kg, millilitres for litres. A person reads "4 pieces", "1.25 kg", "500 ml" — never "4 ea", never 1/100th of the
// count ("−0.04"), never grams as kilos ("−12.5"). One rule for every office page that shows a quantity.

import { minorPerUnitOf, normaliseUom } from '../../../packages/contracts/src/quantity';

export type Lang = 'en' | 'ta';

/** The plain word for each unit, in both languages (the words the production pages already use). */
const UNIT_WORDS: Readonly<Record<Lang, Readonly<Record<string, { readonly one: string; readonly many: string }>>>> = Object.freeze({
  en: {
    ea: { one: 'piece', many: 'pieces' }, kg: { one: 'kg', many: 'kg' }, g: { one: 'g', many: 'g' },
    L: { one: 'litre', many: 'litres' }, ml: { one: 'ml', many: 'ml' },
  },
  ta: {
    ea: { one: 'எண்ணிக்கை', many: 'எண்ணிக்கை' }, kg: { one: 'கிலோ', many: 'கிலோ' }, g: { one: 'கிராம்', many: 'கிராம்' },
    L: { one: 'லிட்டர்', many: 'லிட்டர்' }, ml: { one: 'மி.லி', many: 'மி.லி' },
  },
});

/**
 * `quantityMinor` smallest steps of `uom` as a person reads it: "4 pieces", "1 piece", "−1.25 kg", "2 litres". A unit this
 * system does not know is said by its own code after the plain number (never divided). The minus sign is a true minus.
 */
export function quantityInWords(quantityMinor: number, uom: string, lang: Lang = 'en'): string {
  const code = normaliseUom(uom) ?? uom;
  const per = minorPerUnitOf(code);
  const whole = quantityMinor / per;
  const number = Math.abs(whole).toLocaleString('en-IN', { maximumFractionDigits: 3 });
  const sign = whole < 0 ? '−' : '';
  const words = UNIT_WORDS[lang][code] ?? UNIT_WORDS.en[code];
  const word = words === undefined ? code : Math.abs(whole) === 1 ? words.one : words.many;
  return `${sign}${number} ${word}`;
}
