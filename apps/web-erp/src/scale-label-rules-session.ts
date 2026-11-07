// SCALE LABEL RULES — the panel on the Products and prices page where the Product user sees, adds and withdraws the rules a
// till reads a weighing scale's label by (M03-FR-02 "configure variable-weight barcode parsing" · OB-570 "A" · P-07 · P-08).
//
// A THIN client over head office's own routes: `GET /v1/catalogue/scale-label-rules` (the rules in force),
// `POST /v1/catalogue/scale-label-rules/:prefix` (set one — a new version, never an edit) and `…/:prefix/withdrawal`. Every
// rule — what is ambiguous, what overruns the check digit — is head office's (`scaleRuleProblems`), and its refusal is shown
// in its own words. The person counts digits from 1, as printed; head office counts from 0, so the conversion lives here.
// A rule reaches the tills with the next signed price update; when head office cannot be reached the panel says nothing was
// saved — never a success it did not get.

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { outcomeOf, type HttpAnswer, type Outcome } from './finance-close-session';
import { shopDateOf } from '../../../packages/calendar/src/shop-day';
import { refusalWords } from './refusal-words';

export const SCALE_VALUE_KINDS = Object.freeze(['weight', 'price', 'expiry'] as const);
export type ScaleValueKind = (typeof SCALE_VALUE_KINDS)[number];

export interface ScaleRuleHttp {
  get(path: string): Promise<HttpAnswer>;
  post(path: string, body: unknown): Promise<HttpAnswer>;
}

/** One rule as head office holds it (positions from 0). */
export interface ScaleRule {
  readonly prefix: string; readonly itemStart: number; readonly itemLength: number;
  readonly valueStart: number; readonly valueLength: number; readonly valueKind: ScaleValueKind;
}
export interface ScaleRuleRecord {
  readonly prefix: string; readonly version: number; readonly state: 'active' | 'withdrawn'; readonly rule: ScaleRule;
  readonly reason?: string; readonly by: string; readonly at: string;
}
export interface ScaleRuleList { readonly rules: readonly ScaleRuleRecord[]; readonly count: number; readonly asAt: string }

/** What the person types: digit positions counted from 1, as printed on the label. */
export interface ScaleRuleInput {
  readonly prefix: string;
  readonly itemFrom: string; readonly itemTo: string;
  readonly valueFrom: string; readonly valueTo: string;
  readonly valueKind: string;
  readonly reason?: string;
}

export const SCALE_RULE_PERMISSIONS = Object.freeze({ read: 'catalogue.pack.read', set: 'catalogue.pack.publish' });

export type ScaleRuleCopyKey =
  | 'tab' | 'h' | 'lede' | 'inForce' | 'none' | 'prefix' | 'itemFrom' | 'itemTo' | 'valueFrom' | 'valueTo' | 'valueKind' | 'reason'
  | 'weight' | 'price' | 'expiry' | 'add' | 'withdraw' | 'withdrawReason' | 'saved' | 'unchanged' | 'withdrawn' | 'refused'
  | 'unreachable' | 'unreadable' | 'notAllowed' | 'cannotRead' | 'readOnly' | 'needFields' | 'needReason' | 'notConnected' | 'line' | 'setBy' | 'nextPack'
  | 'weightWords' | 'priceWords' | 'expiryWords';

export const SCALE_RULE_COPY: BilingualCopy<ScaleRuleCopyKey> = {
  en: {
    tab: 'Scale label rules', h: 'Scale label rules',
    lede: 'How the tills read a weighing scale’s label: the first digits say it is a scale label, then where the item code and the weight sit. Count the digits from 1, as printed; the 13th digit is the check digit. Two rules whose starting digits overlap are refused, so a label is never read two ways.',
    inForce: 'Rules in force', none: 'No scale label rule is set — a weight label is refused at the tills.',
    prefix: 'Labels start with', itemFrom: 'Item code from digit', itemTo: 'to digit', valueFrom: 'Value from digit', valueTo: 'to digit',
    valueKind: 'The value is', reason: 'Why (optional to add a rule; needed to stop one)', weight: 'the weight in grams', price: 'the price in paise', expiry: 'the use-by date (YYMMDD)',
    add: 'Save this rule at head office', withdraw: 'Stop this rule', withdrawReason: 'Why it stops (needed)',
    saved: 'Saved at head office. The tills read labels this way after the next price update.',
    unchanged: 'Already set exactly so — nothing new was saved.',
    withdrawn: 'Stopped at head office. The tills stop reading these labels after the next price update.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was saved. Try again when the connection is back.',
    unreadable: 'Head office cannot be reached — the rules in force could not be read, so none are shown.',
    notAllowed: 'Your role cannot change scale label rules.', cannotRead: 'Your role cannot read the scale label rules.',
    readOnly: 'You can read these rules; changing them needs the product role.',
    needFields: 'Give the starting digits and the digit positions as whole numbers, and choose what the value is.',
    needReason: 'Write why this rule stops in the “Why” box, then press Stop again. Nothing was changed.',
    notConnected: 'Scale label rules are kept at head office. Open Products and prices from head office to see or change them.',
    line: 'Labels starting with {prefix}: item code in digits {itemFrom}–{itemTo}, {value} in digits {valueFrom}–{valueTo}',
    setBy: 'set by {by} on {at}', nextPack: 'A change reaches the tills with the next price update.',
    weightWords: 'weight in grams', priceWords: 'price in paise', expiryWords: 'use-by date',
  },
  ta: {
    tab: 'எடை லேபிள் விதிகள்', h: 'எடை லேபிள் விதிகள்',
    lede: 'எடை இயந்திரத்தின் லேபிளை பில் இயந்திரங்கள் எப்படிப் படிக்கின்றன: முதல் இலக்கங்கள் இது எடை லேபிள் என்று சொல்கின்றன, பிறகு பொருள் குறியீடும் எடையும் எங்கே உள்ளன. அச்சிட்டபடி இலக்கங்களை 1 இலிருந்து எண்ணுங்கள்; 13-வது இலக்கம் சரிபார்ப்பு இலக்கம். தொடக்க இலக்கங்கள் ஒன்றின்மேல் ஒன்று படியும் இரண்டு விதிகள் மறுக்கப்படும், அதனால் ஒரு லேபிள் இரண்டு விதமாகப் படிக்கப்படாது.',
    inForce: 'நடைமுறையில் உள்ள விதிகள்', none: 'எந்த எடை லேபிள் விதியும் அமைக்கப்படவில்லை — பில் இயந்திரங்களில் எடை லேபிள் மறுக்கப்படும்.',
    prefix: 'லேபிள் தொடங்கும் இலக்கங்கள்', itemFrom: 'பொருள் குறியீடு தொடங்கும் இலக்கம்', itemTo: 'முடியும் இலக்கம்', valueFrom: 'மதிப்பு தொடங்கும் இலக்கம்', valueTo: 'முடியும் இலக்கம்',
    valueKind: 'மதிப்பு என்பது', reason: 'ஏன் (விதியைச் சேர்க்க விருப்பம்; நிறுத்த அவசியம்)', weight: 'கிராமில் எடை', price: 'பைசாவில் விலை', expiry: 'பயன்படுத்த வேண்டிய கடைசி தேதி (YYMMDD)',
    add: 'இந்த விதியைத் தலைமை அலுவலகத்தில் சேமி', withdraw: 'இந்த விதியை நிறுத்து', withdrawReason: 'ஏன் நிறுத்தப்படுகிறது (அவசியம்)',
    saved: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது. அடுத்த விலை புதுப்பிப்புக்குப் பிறகு பில் இயந்திரங்கள் லேபிள்களை இப்படிப் படிக்கும்.',
    unchanged: 'ஏற்கனவே இப்படியே அமைக்கப்பட்டுள்ளது — புதிதாக எதுவும் சேமிக்கப்படவில்லை.',
    withdrawn: 'தலைமை அலுவலகத்தில் நிறுத்தப்பட்டது. அடுத்த விலை புதுப்பிப்புக்குப் பிறகு பில் இயந்திரங்கள் இந்த லேபிள்களைப் படிப்பதை நிறுத்தும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் சேமிக்கப்படவில்லை. இணைப்பு திரும்பியதும் மீண்டும் முயலுங்கள்.',
    unreadable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — நடைமுறையில் உள்ள விதிகளைப் படிக்க முடியவில்லை, அதனால் எதுவும் காட்டப்படவில்லை.',
    notAllowed: 'உங்கள் பங்கால் எடை லேபிள் விதிகளை மாற்ற முடியாது.', cannotRead: 'உங்கள் பங்கால் எடை லேபிள் விதிகளைப் படிக்க முடியாது.',
    readOnly: 'நீங்கள் இந்த விதிகளைப் படிக்கலாம்; மாற்றுவதற்குப் பொருள் பங்கு தேவை.',
    needFields: 'தொடக்க இலக்கங்களையும் இலக்க இடங்களையும் முழு எண்களாகக் கொடுத்து, மதிப்பு என்ன என்பதைத் தேர்ந்தெடுங்கள்.',
    needReason: 'இந்த விதி ஏன் நிறுத்தப்படுகிறது என்பதை “ஏன்” பெட்டியில் எழுதி, மீண்டும் நிறுத்து என்பதை அழுத்துங்கள். எதுவும் மாற்றப்படவில்லை.',
    notConnected: 'எடை லேபிள் விதிகள் தலைமை அலுவலகத்தில் வைக்கப்படுகின்றன. அவற்றைப் பார்க்க அல்லது மாற்ற, தலைமை அலுவலகத்திலிருந்து பொருட்களும் விலைகளும் திரையைத் திறக்கவும்.',
    line: '{prefix} இல் தொடங்கும் லேபிள்கள்: பொருள் குறியீடு இலக்கங்கள் {itemFrom}–{itemTo} இல், {value} இலக்கங்கள் {valueFrom}–{valueTo} இல்',
    setBy: '{by} அவர்களால் {at} அன்று அமைக்கப்பட்டது', nextPack: 'ஒரு மாற்றம் அடுத்த விலை புதுப்பிப்புடன் பில் இயந்திரங்களைச் சென்றடையும்.',
    weightWords: 'கிராமில் எடை', priceWords: 'பைசாவில் விலை', expiryWords: 'கடைசி தேதி',
  },
};
export const SCALE_RULE_COPY_KEYS: readonly ScaleRuleCopyKey[] = Object.freeze(Object.keys(SCALE_RULE_COPY.en) as ScaleRuleCopyKey[]);

export function scaleRuleWords(lang: Lang): (key: ScaleRuleCopyKey, fill?: Readonly<Record<string, string | number>>) => string {
  const t = translator(SCALE_RULE_COPY, lang);
  return (key, fill) => Object.entries(fill ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));
}

/** A rule in plain words, digits counted from 1 — "Labels starting with 2: item code in digits 2–7, weight in grams in digits 8–12". Pure. */
export function describeScaleRule(lang: Lang, r: ScaleRule): string {
  const w = scaleRuleWords(lang);
  const value = w(r.valueKind === 'weight' ? 'weightWords' : r.valueKind === 'price' ? 'priceWords' : 'expiryWords');
  return w('line', {
    prefix: r.prefix, itemFrom: r.itemStart + 1, itemTo: r.itemStart + r.itemLength,
    value, valueFrom: r.valueStart + 1, valueTo: r.valueStart + r.valueLength,
  });
}

/** Who set a rule and on which SHOP day (never the UTC date of the moment), with their reason. Pure but for the served zone. */
export function setByWords(lang: Lang, record: Pick<ScaleRuleRecord, 'by' | 'at' | 'reason'>, timeZone?: string): string {
  const day = timeZone === undefined ? shopDateOf(record.at) : shopDateOf(record.at, timeZone);
  return scaleRuleWords(lang)('setBy', { by: record.by, at: day }) + (record.reason === undefined || record.reason === '' ? '' : ` · ${record.reason}`);
}

/** What the person typed (digits from 1) as head office's rule (from 0) — undefined when a number is not a whole number. Pure. */
export function ruleFromInput(input: ScaleRuleInput): Omit<ScaleRule, 'valueKind'> & { readonly valueKind: string } | undefined {
  const whole = (s: string): number | undefined => (/^\s*\d+\s*$/.test(s) ? Number(s.trim()) : undefined);
  const [itemFrom, itemTo, valueFrom, valueTo] = [input.itemFrom, input.itemTo, input.valueFrom, input.valueTo].map(whole);
  const prefix = input.prefix.trim();
  if (prefix === '' || itemFrom === undefined || itemTo === undefined || valueFrom === undefined || valueTo === undefined
    || itemFrom < 1 || valueFrom < 1 || itemTo < itemFrom || valueTo < valueFrom || input.valueKind.trim() === '') return undefined;
  return { prefix, itemStart: itemFrom - 1, itemLength: itemTo - itemFrom + 1, valueStart: valueFrom - 1, valueLength: valueTo - valueFrom + 1, valueKind: input.valueKind.trim() };
}

export function scaleRuleOutcomeWords(lang: Lang, o: Outcome<{ unchanged?: boolean; rule?: { state?: string } }>): { readonly ok: boolean; readonly text: string } {
  const w = scaleRuleWords(lang);
  switch (o.kind) {
    case 'done': return { ok: true, text: o.body.unchanged === true ? w('unchanged') : o.body.rule?.state === 'withdrawn' ? w('withdrawn') : w('saved') };
    case 'refused': return { ok: false, text: refusalWords(lang, o) };
    case 'not_allowed': return { ok: false, text: w('notAllowed') };
    case 'invalid': return { ok: false, text: o.detail === 'reason' ? w('needReason') : w('needFields') };
    case 'unreachable': return { ok: false, text: w('unreachable') };
  }
}

export interface ScaleRulesSession {
  readonly may: { readonly read: boolean; readonly set: boolean };
  list(): Promise<Outcome<ScaleRuleList>>;
  set(input: ScaleRuleInput): Promise<Outcome<{ readonly unchanged?: boolean; readonly rule: ScaleRuleRecord }>>;
  /** OB-574: a reason is required — without one nothing is sent (`invalid`, detail 'reason'). */
  withdraw(prefix: string, reason?: string): Promise<Outcome<{ readonly rule: ScaleRuleRecord }>>;
}

export function createScaleRulesSession(viewer: { readonly permissions: readonly string[] }, http: ScaleRuleHttp): ScaleRulesSession {
  const held = new Set(viewer.permissions);
  const may = Object.freeze({ read: held.has(SCALE_RULE_PERMISSIONS.read), set: held.has(SCALE_RULE_PERMISSIONS.set) });
  const reasonOf = (r?: string): { reason?: string } => (r === undefined || r.trim() === '' ? {} : { reason: r.trim() });
  return {
    may,
    list: async () => {
      if (!may.read) return { kind: 'not_allowed', needs: SCALE_RULE_PERMISSIONS.read };
      return outcomeOf<ScaleRuleList>(await http.get('/v1/catalogue/scale-label-rules'));
    },
    set: async (input) => {
      if (!may.set) return { kind: 'not_allowed', needs: SCALE_RULE_PERMISSIONS.set };
      const rule = ruleFromInput(input);
      if (rule === undefined) return { kind: 'invalid', detail: '' };
      const { prefix, ...positions } = rule;
      return outcomeOf(await http.post(`/v1/catalogue/scale-label-rules/${encodeURIComponent(prefix)}`, { ...positions, ...reasonOf(input.reason) }));
    },
    withdraw: async (prefix, reason) => {
      if (!may.set) return { kind: 'not_allowed', needs: SCALE_RULE_PERMISSIONS.set };
      if (prefix.trim() === '') return { kind: 'invalid', detail: '' };
      // OB-574: stopping a rule needs a reason — asked for here, before anything is sent (head office refuses it too).
      if (reasonOf(reason).reason === undefined) return { kind: 'invalid', detail: 'reason' };
      return outcomeOf(await http.post(`/v1/catalogue/scale-label-rules/${encodeURIComponent(prefix.trim())}/withdrawal`, reasonOf(reason)));
    },
  };
}
