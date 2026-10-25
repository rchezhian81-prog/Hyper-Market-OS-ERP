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

// ── OB-348 · OB-353 · OB-354 (owner, 24 Oct 2026, in writing): the liquor rule is the SHOP'S STATE's ─────────────────
//
// OB-348: "Refused by the shop's state; Tamil Nadu refused; each shop records its state."
// OB-354: each store's state is READ FROM ITS GSTIN — the first two digits are the GST state code (33 = Tamil Nadu) —
//   never typed separately and never one business-wide setting (`shopStateFromGstin`). A store with no GSTIN on record
//   has no state: "not set", and liquor is refused all the same (P-08).
// OB-353: "refused in every state until that state's rule is recorded in writing and approved; Tamil Nadu recorded as
//   refused." The table below is that record: one row per state whose rule the owner has given in writing, each naming
//   where it was given. Tamil Nadu is the only row, and it refuses (TASMAC). Every other state has no row, so liquor is
//   refused there until a row is added — and adding a row is a change to this file, through a reviewed pull request, with
//   the owner's written decision named on it. There is no override.

/** The states and union territories of India by their ISO 3166-2:IN codes — what the shop's state setting accepts. */
export const INDIAN_STATES: Readonly<Record<string, { readonly en: string; readonly ta: string }>> = Object.freeze({
  AN: { en: 'Andaman and Nicobar Islands', ta: 'அந்தமான் நிக்கோபார் தீவுகள்' }, AP: { en: 'Andhra Pradesh', ta: 'ஆந்திரப் பிரதேசம்' },
  AR: { en: 'Arunachal Pradesh', ta: 'அருணாசலப் பிரதேசம்' }, AS: { en: 'Assam', ta: 'அசாம்' }, BR: { en: 'Bihar', ta: 'பீகார்' },
  CH: { en: 'Chandigarh', ta: 'சண்டிகர்' }, CT: { en: 'Chhattisgarh', ta: 'சத்தீஸ்கர்' },
  DH: { en: 'Dadra and Nagar Haveli and Daman and Diu', ta: 'தாத்ரா நகர் ஹவேலி மற்றும் தமன் தியு' }, DL: { en: 'Delhi', ta: 'டெல்லி' },
  GA: { en: 'Goa', ta: 'கோவா' }, GJ: { en: 'Gujarat', ta: 'குஜராத்' }, HR: { en: 'Haryana', ta: 'ஹரியானா' },
  HP: { en: 'Himachal Pradesh', ta: 'இமாச்சலப் பிரதேசம்' }, JK: { en: 'Jammu and Kashmir', ta: 'ஜம்மு காஷ்மீர்' },
  JH: { en: 'Jharkhand', ta: 'ஜார்கண்ட்' }, KA: { en: 'Karnataka', ta: 'கர்நாடகா' }, KL: { en: 'Kerala', ta: 'கேரளா' },
  LA: { en: 'Ladakh', ta: 'லடாக்' }, LD: { en: 'Lakshadweep', ta: 'இலட்சத்தீவுகள்' }, MP: { en: 'Madhya Pradesh', ta: 'மத்தியப் பிரதேசம்' },
  MH: { en: 'Maharashtra', ta: 'மகாராஷ்டிரா' }, MN: { en: 'Manipur', ta: 'மணிப்பூர்' }, ML: { en: 'Meghalaya', ta: 'மேகாலயா' },
  MZ: { en: 'Mizoram', ta: 'மிசோரம்' }, NL: { en: 'Nagaland', ta: 'நாகாலாந்து' }, OR: { en: 'Odisha', ta: 'ஒடிசா' },
  PY: { en: 'Puducherry', ta: 'புதுச்சேரி' }, PB: { en: 'Punjab', ta: 'பஞ்சாப்' }, RJ: { en: 'Rajasthan', ta: 'ராஜஸ்தான்' },
  SK: { en: 'Sikkim', ta: 'சிக்கிம்' }, TN: { en: 'Tamil Nadu', ta: 'தமிழ்நாடு' }, TG: { en: 'Telangana', ta: 'தெலங்கானா' },
  TR: { en: 'Tripura', ta: 'திரிபுரா' }, UP: { en: 'Uttar Pradesh', ta: 'உத்தரப் பிரதேசம்' }, UT: { en: 'Uttarakhand', ta: 'உத்தராகண்ட்' },
  WB: { en: 'West Bengal', ta: 'மேற்கு வங்காளம்' },
});

/** True when a value is one of the state codes above (upper case, as stored). */
export function isIndianStateCode(v: unknown): v is string {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(INDIAN_STATES, v);
}

/** One state's liquor rule as the owner gave it in writing (OB-353). Every recorded rule today REFUSES. */
export interface RecordedStateLiquorRule {
  readonly state: string;
  readonly rule: 'refused';
  /** Why, for the record and the cashier. */
  readonly because: string;
  /** Where the owner gave it in writing. */
  readonly recordedIn: string;
}

/** The states whose liquor rule has been recorded in writing (OB-353). Only Tamil Nadu (OB-348). */
export const RECORDED_STATE_LIQUOR_RULES: readonly RecordedStateLiquorRule[] = Object.freeze([
  Object.freeze({ state: 'TN', rule: 'refused', because: 'in Tamil Nadu retail liquor is a TASMAC state monopoly', recordedIn: 'OB-348 · OB-353 (owner, 24 Oct 2026, in writing); OWNER_DECISIONS D3 (11 Aug 2026)' }),
] as RecordedStateLiquorRule[]);

const RECORDED_STATE_RULES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(RECORDED_STATE_LIQUOR_RULES.map((r) => [r.state, r.because])),
);

/**
 * OB-354: the GST system's two-digit state code → the state's ISO 3166-2:IN code (as `INDIAN_STATES` holds it). Code 25
 * (Daman and Diu, merged into 26 in 2020) reads as the merged territory; 97 ("Other Territory") is no state and has no row.
 */
export const GST_STATE_CODE_TO_STATE: Readonly<Record<string, string>> = Object.freeze({
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UT', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR',
  '11': 'SK', '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH',
  '21': 'OR', '22': 'CT', '23': 'MP', '24': 'GJ', '25': 'DH', '26': 'DH', '27': 'MH', '29': 'KA', '30': 'GA', '31': 'LD',
  '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TG', '37': 'AP', '38': 'LA',
});

/** What a store's GSTIN says about its state (OB-354). */
export type ShopStateFromGstin =
  | { readonly known: true; readonly state: string; readonly gstStateCode: string; readonly gstin: string }
  | { readonly known: false; readonly why: 'no_gstin' | 'not_a_state_code'; readonly gstStateCode?: string; readonly gstin?: string };

/**
 * OB-354: the store's state from its GSTIN — the first two digits are the GST state code. No GSTIN → not known ("not set");
 * first two characters that are no state's code → not known. Never guessed from an address or a setting.
 */
export function shopStateFromGstin(gstin: string | null | undefined): ShopStateFromGstin {
  const g = typeof gstin === 'string' ? gstin.trim().toUpperCase() : '';
  if (g === '') return { known: false, why: 'no_gstin' };
  const code = g.slice(0, 2);
  const state = Object.prototype.hasOwnProperty.call(GST_STATE_CODE_TO_STATE, code) ? GST_STATE_CODE_TO_STATE[code] : undefined;
  return state === undefined ? { known: false, why: 'not_a_state_code', gstStateCode: code, gstin: g } : { known: true, state, gstStateCode: code, gstin: g };
}

/** How the shop's state rules on liquor. Every outcome today is a refusal; `basis` says which kind. */
export interface StateLiquorRule {
  readonly refused: true;
  readonly basis: 'state_monopoly' | 'state_not_set' | 'no_rule_recorded_for_state';
  /** The state code as the setting holds it, when it is one. */
  readonly state?: string;
  /** For the record. */
  readonly why: string;
  /** For the cashier, English and Tamil. */
  readonly laneWords: { readonly en: string; readonly ta: string };
}

/** The liquor rule for the shop's state (read from the store's GSTIN, OB-354). Absent / not a state code → "not set", and refused. */
export function liquorRuleForState(state: string | null | undefined): StateLiquorRule {
  const code = typeof state === 'string' ? state.trim().toUpperCase() : '';
  if (!isIndianStateCode(code)) {
    return {
      refused: true, basis: 'state_not_set',
      why: 'the shop\'s state is not set (it is read from the store\'s GSTIN, and none is on record), so no state rule permits it — liquor is refused (OB-348 · OB-354)',
      laneWords: {
        en: 'Liquor cannot be sold: the shop\'s state is not set (the store\'s GSTIN is not on record). Keep it off the bill and tell the manager.',
        ta: 'மதுபானம் விற்க முடியாது: கடையின் மாநிலம் அமைக்கப்படவில்லை (கடையின் GSTIN பதிவில் இல்லை). பில்லில் சேர்க்க வேண்டாம்; மேலாளரிடம் சொல்லுங்கள்.',
      },
    };
  }
  const name = INDIAN_STATES[code]!;
  const recorded = RECORDED_STATE_RULES[code];
  if (recorded !== undefined) {
    return {
      refused: true, basis: 'state_monopoly', state: code, why: `${recorded} (OB-348 · OB-353)`,
      laneWords: {
        en: `Liquor is not sold here: ${recorded}. Keep it off the bill and tell the manager.`,
        ta: 'மதுபானம் இங்கு விற்கப்படுவதில்லை: தமிழ்நாட்டில் மதுபான சில்லறை விற்பனை டாஸ்மாக் நிறுவனத்திற்கு மட்டுமே. பில்லில் சேர்க்க வேண்டாம்; மேலாளரிடம் சொல்லுங்கள்.',
      },
    };
  }
  return {
    refused: true, basis: 'no_rule_recorded_for_state', state: code,
    why: `no liquor rule has been recorded in writing for ${name.en}, so it is refused until the owner records one (OB-348 · OB-353)`,
    laneWords: {
      en: `Liquor cannot be sold: no liquor rule is recorded in writing for ${name.en}. Keep it off the bill and tell the manager.`,
      ta: `மதுபானம் விற்க முடியாது: ${name.ta} மாநிலத்திற்கு மதுபான விதி பதிவு செய்யப்படவில்லை. பில்லில் சேர்க்க வேண்டாம்; மேலாளரிடம் சொல்லுங்கள்.`,
    },
  };
}
