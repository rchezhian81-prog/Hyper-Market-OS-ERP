// C12 (v2.1 addendum · ADR-0002 "India region") · OB-162 — what counts as "India" for where payment data is kept.
//
// India is `IN` in ISO 3166-1. A state or union territory is `IN-` plus its ISO 3166-2:IN code. Only the REAL codes are
// accepted: "IN-ZZ", "IN-XX" or a typo is not a place in India, and a check that accepts any two letters after "IN-" is
// a check that accepts anything (verifier lane-2 L5). One list, used by the head-office boot check
// (`services/kernel/src/data-residency.ts`) and by the payment-adapter registry (`./adapters.ts`).

/**
 * ISO 3166-2:IN — the 28 states and 8 union territories, by their current code (the 2023 ISO update aligned four codes
 * with vehicle registration: Chhattisgarh CG, Odisha OD, Telangana TS, Uttarakhand UK; and Dadra and Nagar Haveli and
 * Daman and Diu has been one territory, DH, since 2020).
 */
export const INDIA_SUBDIVISIONS: Readonly<Record<string, string>> = Object.freeze({
  // States
  AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CG: 'Chhattisgarh', GA: 'Goa', GJ: 'Gujarat',
  HR: 'Haryana', HP: 'Himachal Pradesh', JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', MP: 'Madhya Pradesh',
  MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha', PB: 'Punjab',
  RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TS: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UK: 'Uttarakhand',
  WB: 'West Bengal',
  // Union territories
  AN: 'Andaman and Nicobar Islands', CH: 'Chandigarh', DH: 'Dadra and Nagar Haveli and Daman and Diu', DL: 'Delhi',
  JK: 'Jammu and Kashmir', LA: 'Ladakh', LD: 'Lakshadweep', PY: 'Puducherry',
});

/**
 * Codes ISO used for the same places until its 2020 and 2023 updates. A configuration or a provider's declaration
 * written before then still names a place in India, so it is accepted and read as the current code — never refused as
 * "not India".
 */
export const INDIA_FORMER_SUBDIVISION_CODES: Readonly<Record<string, string>> = Object.freeze({
  CT: 'CG', OR: 'OD', TG: 'TS', UT: 'UK', DD: 'DH', DN: 'DH',
});

/** True when the region is India (`IN`) or a real Indian state or union territory (`IN-TN`). Case and spaces ignored. */
export function isIndiaRegion(region: string): boolean {
  const r = region.trim().toUpperCase();
  if (r === 'IN') return true;
  const m = /^IN-([A-Z]{2})$/.exec(r);
  if (m === null) return false;
  const code = m[1]!;
  return Object.hasOwn(INDIA_SUBDIVISIONS, code) || Object.hasOwn(INDIA_FORMER_SUBDIVISION_CODES, code);
}

/** The place a region names, in words ("India", "Tamil Nadu, India"), or `undefined` when it is not India. */
export function indiaRegionName(region: string): string | undefined {
  if (!isIndiaRegion(region)) return undefined;
  const r = region.trim().toUpperCase();
  if (r === 'IN') return 'India';
  const code = r.slice(3);
  const current = INDIA_FORMER_SUBDIVISION_CODES[code] ?? code;
  return `${INDIA_SUBDIVISIONS[current]!}, India`;
}
