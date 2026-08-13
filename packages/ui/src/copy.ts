// Bilingual copy — the shared English/Tamil text primitive every web-erp screen uses (roadmap §19
// usability-by-role, OA-9/OA-10, P-07). The store is in Tamil Nadu; Tamil is a first language for much of
// its staff, not a translation afterthought, and a half-translated screen reads as unfinished exactly
// where somebody is relying on it. Until now each screen carried its OWN inline `WORDS = { en, ta }` map
// and its own `t()`; this consolidates the primitive so a new screen declares typed copy once and the
// "speaks both languages" completeness check is a reusable function, not a regex over each view's source.
//
// Pure and deterministic: no I/O, no DOM, no clock.

/** The two languages the product ships in. English is the fallback; Tamil is never an afterthought. */
export type Lang = 'en' | 'ta';
export const LANGUAGES: readonly Lang[] = ['en', 'ta'];

/**
 * A screen's copy, keyed by a string-literal union `K` so the compiler catches a key that exists in one
 * language and not the other. Both maps are required — a screen cannot ship English-only by construction.
 */
export interface BilingualCopy<K extends string> {
  readonly en: Readonly<Record<K, string>>;
  readonly ta: Readonly<Record<K, string>>;
}

/** True when a value is a usable piece of copy — a non-blank string (a blank is a gap, not a translation). */
function present(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * A resolver bound to one language: `t(key)` returns the copy in `lang`, falling back to English, and — only
 * if even English is missing — the key itself, so a gap renders visibly as the key name rather than a blank
 * a person cannot see is missing. The English fallback matches the long-standing per-screen `?? WORDS.en`.
 */
export function translator<K extends string>(copy: BilingualCopy<K>, lang: Lang): (key: K) => string {
  return (key: K): string => {
    const inLang = copy[lang][key];
    if (present(inLang)) return inLang;
    const inEn = copy.en[key];
    return present(inEn) ? inEn : key;
  };
}

/**
 * The reusable "speaks both languages" check — the tripwire each screen's guardrail calls instead of a
 * bespoke regex over its view source. Returns the keys missing (absent OR blank) in each language. Pass the
 * screen's authoritative vocabulary as `required` (e.g. the session model's exported KINDS) to catch a kind
 * added to the model but not to the copy; omit it to check the two maps against each other for symmetry.
 */
export function bilingualGaps<K extends string>(
  copy: BilingualCopy<K>,
  required?: readonly K[],
): { readonly en: readonly string[]; readonly ta: readonly string[] } {
  const keys: readonly string[] = required ?? [...new Set([...Object.keys(copy.en), ...Object.keys(copy.ta)])];
  const missingIn = (map: Readonly<Record<string, string>>): string[] => keys.filter((k) => !present(map[k]));
  return { en: missingIn(copy.en), ta: missingIn(copy.ta) };
}

/** True when every required key (or, with none given, every key in either map) has copy in BOTH languages. */
export function isBilingualComplete<K extends string>(copy: BilingualCopy<K>, required?: readonly K[]): boolean {
  const gaps = bilingualGaps(copy, required);
  return gaps.en.length === 0 && gaps.ta.length === 0;
}
