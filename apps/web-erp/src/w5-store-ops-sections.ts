// W5 (bundle 5 — store operations): the head-office routes no screen called, put on the page each belongs to as a tested,
// DOM-free SECTION. A section is a list of actions — a read or a write — each with its own permission, its fields and the
// words for what head office answered. `apps/web-erp/web/w5-sections.js` only draws them (labels, inputs, a button, a status
// line, a list) and repaints them in Tamil; every rule, every check and every word is here.
//
//   • /settings — the OWNER's shop policy numbers (M13-FR-01/02/03, M28-FR-01, SP-2b, SP-7b): the return window, the refund
//     threshold, the store-credit and no-receipt caps, the write-off and count thresholds and the match tolerances. A number
//     the owner never set is shown as NOT SET — the field is never pre-filled with a figure; where head office applies its own
//     built-in safe rule until then, that is SAID, never hidden (P-08). Only the owner holds the words that set them.
//     OB-686 (owner, 3 Nov 2026): the kept safety limits — write-off ₹500, count ₹1,000, every refund needs a manager, the
//     bill match 0% / 1% / ₹1 — each read "built-in, not yet set by the owner" until he sets his own (one wording, EN and TA).
//   • /indents — reject an indent (a different person, §28), cancel what is still owed, send stock back to the back store;
//     the returns waiting at the back store are listed — they are counted in on the warehouse HANDHELD (M09-FR-03).
//   • /goods-receipt — the goods a direct delivery (DSD) check-in HELD beyond the order: keep or refuse, by someone other
//     than the receiver (§28, OB-141).
//   • /stock-health — on-shelf availability (OB-147): the suspects, the owner's minimum days, raise and record a count task
//     (a difference becomes an adjustment REQUEST a second person decides — nothing here moves stock).
//   • /recall-trace — trace requests (M10-FR-03): the list with what is overdue, ask for a trace, answer one.
//   • /production-costs — register an ingredient's production cost (M11-FR-02).
//   • /warehouse-supervisor/ — register a bin, read what a bin holds (M09-FR-01).
// The facilities and loss-prevention sections are in `w5-facilities-lp-sections.ts`. Head office re-checks every call.

import { makeCaller, newId, type Outcome } from './r4-insight-call';
import { typedQuantityMinor, quantityLabel } from '../../../packages/contracts/src/quantity';
import { ADJUSTMENT_REASON_CODES } from '../../../packages/adjustment/src/adjustment';
import { shopMomentOf } from './findings-session';

export type Lang = 'en' | 'ta';
export type Tone = 'ok' | 'warn' | 'error' | 'info';
/** Words in the reader's language. */
export type T = (lang: Lang) => string;
export interface W5Line { readonly tone: Tone; readonly text: T; readonly key?: string }
/** `stop`: nothing was done (a refusal, a lost link, a box not filled in) — the section's lists are not read again. */
export interface W5Said { readonly tone: Tone; readonly text: T; readonly lines?: readonly W5Line[]; readonly stop?: true }
export type FieldKind = 'text' | 'money' | 'number' | 'select' | 'datetime' | 'date' | 'lines';
export interface W5Field {
  readonly key: string; readonly label: T; readonly kind: FieldKind;
  readonly options?: readonly { readonly value: string; readonly label: T }[];
  /** What the field starts with — never a policy figure; a place or a person the page already knows. */
  readonly initial?: string;
}
export interface W5Action {
  readonly id: string; readonly title: T; readonly note?: T; readonly fields: readonly W5Field[]; readonly go: T;
  /** A READ that runs once when the page opens (GET only — nothing is written on open). */
  readonly auto?: boolean;
  /** The other actions of the section to run again after this one is answered ok (their lists). */
  readonly refresh?: readonly string[];
  run(values: Readonly<Record<string, string>>): Promise<W5Said>;
}
export interface W5Section { readonly id: string; readonly heading: T; readonly lead: T; readonly actions: readonly W5Action[] }
export interface Viewer { readonly userId?: string; readonly permissions: readonly string[] }

// ── the shared words ──────────────────────────────────────────────────────────────────────────────────────────────────

export const W5_COMMON_COPY = {
  en: {
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.',
    needMoney: 'Type an amount in rupees, like 500 or 499.50.', needWhole: 'Type a whole number.', needPercent: 'Type a percentage from 0 to 100, like 1 or 0.5.',
    needText: 'Fill in every box marked for this.', needWhen: 'Pick the date and time.', needDate: 'Pick the date.', needQty: 'Type how many, in the item\'s own unit.',
    none: 'Nothing to show.', saved: 'Saved at head office.', show: 'Show', by: 'by', at: 'at', yes: 'Yes', no: 'No', optional: '(may be left empty)',
  },
  ta: {
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, மாற்றப்படவில்லை.',
    needMoney: 'ரூபாயில் தொகையை இடுங்கள், எ.கா. 500 அல்லது 499.50.', needWhole: 'முழு எண்ணை இடுங்கள்.', needPercent: '0 முதல் 100 வரை சதவீதம் இடுங்கள், எ.கா. 1 அல்லது 0.5.',
    needText: 'இதற்குக் குறிக்கப்பட்ட ஒவ்வொரு பெட்டியையும் நிரப்புங்கள்.', needWhen: 'தேதியும் நேரமும் தேர்ந்தெடுங்கள்.', needDate: 'தேதியைத் தேர்ந்தெடுங்கள்.', needQty: 'பொருளின் சொந்த அலகில் எத்தனை என்று இடுங்கள்.',
    none: 'காட்ட எதுவும் இல்லை.', saved: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது.', show: 'காட்டு', by: 'செய்தவர்', at: 'நேரம்', yes: 'ஆம்', no: 'இல்லை', optional: '(காலியாக விடலாம்)',
  },
} as const;

type Copy = { readonly en: Readonly<Record<string, string>>; readonly ta: Readonly<Record<string, string>> };
/** `w(key, vars)` — a word from the section's own table, else the shared one; `{name}` filled from `vars`. */
export function wordsOf(copy: Copy): (key: string, vars?: Readonly<Record<string, string | number>>) => T {
  return (key, vars) => (lang) => {
    const own = (copy[lang] as Record<string, string>)[key] ?? (W5_COMMON_COPY[lang] as Record<string, string>)[key]
      ?? (copy.en as Record<string, string>)[key] ?? (W5_COMMON_COPY.en as Record<string, string>)[key] ?? key;
    return vars === undefined ? own : own.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
  };
}
/** Head office's own text (an id, a name, its sentence) — the same in both languages. */
export const raw = (s: string): T => () => s;
/** Several pieces in one line. */
export const join = (...parts: readonly T[]): T => (lang) => parts.map((p) => p(lang)).filter((x) => x !== '').join(' ');
const common = wordsOf(W5_COMMON_COPY);

export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Rupees typed by a person → paise, or undefined (never a guess). */
export function paiseOf(typed: string | undefined): number | undefined {
  const s = (typed ?? '').trim().replace(/^₹\s*/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}
/** A percentage typed by a person → basis points (0–10000), or undefined. */
export function bpsOf(typed: string | undefined): number | undefined {
  const s = (typed ?? '').trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const [w, f = ''] = s.split('.');
  const bps = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return bps <= 10_000 ? bps : undefined;
}
export const percentOf = (bps: number): string => `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
export function wholeOf(typed: string | undefined): number | undefined {
  const s = (typed ?? '').trim();
  return /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : undefined;
}
const filled = (v: string | undefined): string | undefined => { const s = (v ?? '').trim(); return s === '' ? undefined : s; };

/** What head office answered, as a said line: ok → `ok(value)`; a refusal in head office's own words; a lost link said. */
export function said<V>(out: Outcome<V, never>, ok: (v: V) => W5Said): W5Said {
  if (out.result === 'ok') return ok(out.value);
  if (out.result === 'refused') return { tone: 'error', text: join(common('refused'), raw(out.whatHappened)), stop: true };
  return { tone: 'error', text: common('unreachable'), stop: true };
}
export const invalid = (text: T): W5Said => ({ tone: 'warn', text, stop: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface SectionInput { readonly viewer: Viewer | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly ids?: () => string }
function setup(input: SectionInput, prefix: string) {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = (p: string): boolean => named && held.has(p);
  const call = makeCaller({ keyPrefix: prefix, ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const id = (p: string): string => (input.ids === undefined ? newId(p) : `${p}-${input.ids()}`);
  return { may, call, id, userId: input.viewer?.userId };
}
const section = (s: W5Section): W5Section | null => (s.actions.length === 0 ? null : s);
const enc = encodeURIComponent;

// ═════════════════════════════════════════════════ /settings — the owner's numbers ═════════════════════════════════════

export const POLICY_COPY = {
  en: {
    h: 'The owner\'s shop rules — the numbers', lead: 'The numbers the tills, the back store and the buyers work to. Each is the owner\'s decision: until he sets one it reads "Not set" — nothing here is filled in for him. Where head office applies its own safe rule until then, that rule is said. Every change is kept; the newest applies.',
    read: 'The numbers in force', readGo: 'Read them again',
    notSet: 'Not set by the owner.',
    windowL: 'Return window', windowSet: '{days} day(s) after the sale — later returns need a supervisor.', windowNot: 'Not set by the owner — returns are not limited by age until it is set.',
    refundL: 'Refund approval threshold', refundSet: '{amount} — a refund at or above this needs a manager\'s approval.', refundNot: 'Every refund needs a manager\'s approval — built-in, not yet set by the owner.',
    creditL: 'Store-credit cap', creditSet: '{amount} — the most store credit one refund may create.', creditNot: 'Not set by the owner — store credit cannot be given until it is set.',
    noReceiptL: 'No-receipt return cap', noReceiptSet: '{amount} — the most one return without a bill may refund.', noReceiptOff: '₹0 — returns without a bill are switched off.', noReceiptNot: 'Not set by the owner — returns without a bill are switched off until it is set.',
    writeOffL: 'Write-off threshold', writeOffSet: '{amount} — a loss at or above this needs a photo and a manager\'s sign-off.', writeOffNot: '{amount} — built-in, not yet set by the owner.',
    countL: 'Count approval threshold', countSet: '{amount} — a count difference worth this or more needs a second person.', countNot: '{amount} — built-in, not yet set by the owner.',
    matchL: 'Supplier bill match tolerances', matchSet: 'quantity {qty} · price {price} · differences under {small} are ignored.', matchNot: 'quantity {qty} · price {price} · differences under {small} are ignored — built-in, not yet set by the owner.',
    setBy: 'set by {who} on {when}',
    setWindow: 'Set the return window', days: 'Days after the sale', setRefund: 'Set the refund approval threshold', setCredit: 'Set the store-credit cap',
    setNoReceipt: 'Set the no-receipt return cap', setWriteOff: 'Set the write-off threshold', setCount: 'Set the count approval threshold',
    setMatch: 'Set the supplier bill match tolerances', qtyTol: 'Quantity tolerance (%)', priceTol: 'Price tolerance (%)', small: 'Ignore differences under (₹)',
    amount: 'Amount (₹)', saveGo: 'Save this number', savedNow: 'Saved. The newest number applies from now; the earlier ones stay on record.',
    zeroNoReceipt: '0 switches returns without a bill off.', zeroCredit: '0 switches store credit off.', zeroRefund: '0 means every refund needs a manager.',
  },
  ta: {
    h: 'உரிமையாளரின் கடை விதிகள் — எண்கள்', lead: 'பணப்பெட்டிகள், பின் கிடங்கு, வாங்குபவர்கள் பின்பற்றும் எண்கள். ஒவ்வொன்றும் உரிமையாளரின் முடிவு: அவர் அமைக்கும் வரை "அமைக்கப்படவில்லை" என்று காட்டும் — இங்கே அவருக்காக எதுவும் நிரப்பப்படுவதில்லை. அதுவரை தலைமை அலுவலகம் தன் பாதுகாப்பு விதியைப் பயன்படுத்தினால், அது சொல்லப்படும். ஒவ்வொரு மாற்றமும் வைக்கப்படுகிறது; புதியது நடைமுறையில் வரும்.',
    read: 'நடைமுறையில் உள்ள எண்கள்', readGo: 'மீண்டும் படி',
    notSet: 'உரிமையாளர் அமைக்கவில்லை.',
    windowL: 'திரும்பப் பெறும் காலம்', windowSet: 'விற்பனைக்குப் பின் {days} நாள் — அதன் பின் திரும்புவதற்கு மேற்பார்வையாளர் தேவை.', windowNot: 'உரிமையாளர் அமைக்கவில்லை — அமைக்கும் வரை திரும்புதலுக்கு வயது வரம்பு இல்லை.',
    refundL: 'பணத் திருப்ப ஒப்புதல் வரம்பு', refundSet: '{amount} — இதற்கு மேல் திருப்புவதற்கு மேலாளர் ஒப்புதல் தேவை.', refundNot: 'ஒவ்வொரு திருப்பத்திற்கும் மேலாளர் ஒப்புதல் தேவை — உள்ளமைந்தது, உரிமையாளர் இன்னும் அமைக்கவில்லை.',
    creditL: 'கடைக் கடன் உச்சவரம்பு', creditSet: '{amount} — ஒரு திருப்பம் உருவாக்கக்கூடிய அதிகபட்ச கடைக் கடன்.', creditNot: 'உரிமையாளர் அமைக்கவில்லை — அமைக்கும் வரை கடைக் கடன் தர முடியாது.',
    noReceiptL: 'ரசீது இல்லாத திருப்ப உச்சவரம்பு', noReceiptSet: '{amount} — ரசீது இல்லாத ஒரு திருப்பம் தரக்கூடிய அதிகபட்சம்.', noReceiptOff: '₹0 — ரசீது இல்லாத திருப்பங்கள் நிறுத்தப்பட்டுள்ளன.', noReceiptNot: 'உரிமையாளர் அமைக்கவில்லை — அமைக்கும் வரை ரசீது இல்லாத திருப்பங்கள் நிறுத்தப்பட்டுள்ளன.',
    writeOffL: 'தள்ளுபடி வரம்பு', writeOffSet: '{amount} — இதற்கு மேல் இழப்புக்குப் புகைப்படமும் மேலாளர் கையொப்பமும் தேவை.', writeOffNot: '{amount} — உள்ளமைந்தது, உரிமையாளர் இன்னும் அமைக்கவில்லை.',
    countL: 'எண்ணிக்கை ஒப்புதல் வரம்பு', countSet: '{amount} — இதற்கு மேல் மதிப்புள்ள எண்ணிக்கை வேறுபாட்டுக்கு இரண்டாம் நபர் தேவை.', countNot: '{amount} — உள்ளமைந்தது, உரிமையாளர் இன்னும் அமைக்கவில்லை.',
    matchL: 'சப்ளையர் பில் பொருத்த வரம்புகள்', matchSet: 'அளவு {qty} · விலை {price} · {small}க்குக் கீழ் வேறுபாடுகள் கவனிக்கப்படாது.', matchNot: 'அளவு {qty} · விலை {price} · {small}க்குக் கீழ் வேறுபாடுகள் கவனிக்கப்படாது — உள்ளமைந்தது, உரிமையாளர் இன்னும் அமைக்கவில்லை.',
    setBy: '{who} {when} அன்று அமைத்தார்',
    setWindow: 'திரும்பப் பெறும் காலத்தை அமை', days: 'விற்பனைக்குப் பின் நாட்கள்', setRefund: 'பணத் திருப்ப ஒப்புதல் வரம்பை அமை', setCredit: 'கடைக் கடன் உச்சவரம்பை அமை',
    setNoReceipt: 'ரசீது இல்லாத திருப்ப உச்சவரம்பை அமை', setWriteOff: 'தள்ளுபடி வரம்பை அமை', setCount: 'எண்ணிக்கை ஒப்புதல் வரம்பை அமை',
    setMatch: 'சப்ளையர் பில் பொருத்த வரம்புகளை அமை', qtyTol: 'அளவு வரம்பு (%)', priceTol: 'விலை வரம்பு (%)', small: 'இதற்குக் கீழ் வேறுபாடுகளைக் கவனிக்காதே (₹)',
    amount: 'தொகை (₹)', saveGo: 'இந்த எண்ணைச் சேமி', savedNow: 'சேமிக்கப்பட்டது. புதிய எண் இப்போதிலிருந்து பொருந்தும்; முந்தையவை பதிவில் இருக்கும்.',
    zeroNoReceipt: '0 ரசீது இல்லாத திருப்பங்களை நிறுத்துகிறது.', zeroCredit: '0 கடைக் கடனை நிறுத்துகிறது.', zeroRefund: '0 என்றால் ஒவ்வொரு திருப்பத்திற்கும் மேலாளர் தேவை.',
  },
} as const;

/** The owner's numbers, read and set. `policyNumbersSection` → null when the viewer may neither read nor set any. */
export function policyNumbersSection(input: SectionInput): W5Section | null {
  const { may, call } = setup(input, 'w5-policy');
  const w = wordsOf(POLICY_COPY);
  const line = (key: string, label: T, text: T, tone: Tone): W5Line => ({ key, tone, text: join((l) => `${label(l)}:`, text) });
  const setter = (r: Record<string, unknown>): T => {
    const who = str(r['setBy']); const at = str(r['setAt']);
    return who === '' ? raw('') : (l) => `(${w('setBy', { who, when: at === '' ? '' : shopMomentOf(at) })(l)})`;
  };
  const read: W5Action = {
    id: 'read', title: w('read'), fields: [], go: w('readGo'), auto: true,
    run: async () => {
      const lines: W5Line[] = [];
      const each = async (perm: string, path: string, make: (b: Record<string, unknown>) => W5Line) => {
        if (!may(perm)) return;
        const out = await call<Record<string, unknown>>('GET', path);
        if (out.result === 'ok') lines.push(make(out.value));
        else lines.push({ key: path, tone: 'error', text: said(out, () => ({ tone: 'ok', text: raw('') })).text });
      };
      await each('pos.return.record', '/v1/pos/return-window', (b) => (b['isSet'] === true
        ? line('return-window', w('windowL'), w('windowSet', { days: str(b['returnWindowDays']) }), 'ok')
        : line('return-window', w('windowL'), w('windowNot'), 'warn')));
      await each('pos.return.record', '/v1/pos/refund-threshold', (b) => (b['isDefault'] === false
        ? line('refund-threshold', w('refundL'), w('refundSet', { amount: rupees(num(b['thresholdMinor']) ?? 0) }), 'ok')
        : line('refund-threshold', w('refundL'), w('refundNot'), 'warn')));
      await each('pos.return.record', '/v1/pos/store-credit-cap', (b) => (b['isSet'] === true
        ? line('store-credit-cap', w('creditL'), w('creditSet', { amount: rupees(num(b['capMinor']) ?? 0) }), 'ok')
        : line('store-credit-cap', w('creditL'), w('creditNot'), 'warn')));
      await each('pos.return.record', '/v1/pos/no-receipt-cap', (b) => (b['isSet'] !== true
        ? line('no-receipt-cap', w('noReceiptL'), w('noReceiptNot'), 'warn')
        : num(b['capMinor']) === 0 ? line('no-receipt-cap', w('noReceiptL'), w('noReceiptOff'), 'ok')
          : line('no-receipt-cap', w('noReceiptL'), w('noReceiptSet', { amount: rupees(num(b['capMinor']) ?? 0) }), 'ok')));
      await each('waste.view', '/v1/inventory/write-off-threshold', (b) => (b['isDefault'] === false
        ? line('write-off-threshold', w('writeOffL'), w('writeOffSet', { amount: rupees(num(b['thresholdMinor']) ?? 0) }), 'ok')
        : line('write-off-threshold', w('writeOffL'), w('writeOffNot', { amount: rupees(num(b['thresholdMinor']) ?? 0) }), 'warn')));
      await each('inventory.count.policy.read', '/v1/inventory/count-policy', (b) => {
        const p = isObj(b['policy']) ? b['policy'] : null;
        return p === null
          ? line('count-policy', w('countL'), w('countNot', { amount: rupees(num(b['inForceMinor']) ?? 0) }), 'warn')
          : line('count-policy', w('countL'), join(w('countSet', { amount: rupees(num(p['approvalThresholdMinor']) ?? 0) }), setter(p)), 'ok');
      });
      await each('purchase.commitment.read', '/v1/purchase/match-policy', (b) => {
        const p = isObj(b['policy']) ? b['policy'] : null;
        const shown = (x: Record<string, unknown>) => ({ qty: percentOf(num(x['quantityToleranceBps']) ?? 0), price: percentOf(num(x['priceToleranceBps']) ?? 0), small: rupees(num(x['immaterialMinor']) ?? 0) });
        return p === null
          ? line('match-policy', w('matchL'), w('matchNot', shown(isObj(b['inForce']) ? b['inForce'] : {})), 'warn')
          : line('match-policy', w('matchL'), join(w('matchSet', shown(p)), setter(p)), 'ok');
      });
      return { tone: 'info', text: raw(''), lines };
    },
  };
  const amount = (key = 'amount'): W5Field => ({ key, label: w('amount'), kind: 'money' });
  const setMoney = (id: string, title: string, perm: string, path: string, field: string, note?: string): W5Action | null => (!may(perm) ? null : {
    id, title: w(title), ...(note === undefined ? {} : { note: w(note) }), fields: [amount()], go: w('saveGo'), refresh: ['read'],
    run: async (v) => {
      const minor = paiseOf(v['amount']);
      if (minor === undefined) return invalid(common('needMoney'));
      return said(await call('POST', path, { [field]: minor }), () => ({ tone: 'ok', text: w('savedNow') }));
    },
  });
  const actions: (W5Action | null)[] = [
    read,
    !may('pos.return.window.set') ? null : {
      id: 'set-return-window', title: w('setWindow'), fields: [{ key: 'days', label: w('days'), kind: 'number' }], go: w('saveGo'), refresh: ['read'],
      run: async (v) => {
        const days = wholeOf(v['days']);
        if (days === undefined) return invalid(common('needWhole'));
        return said(await call('POST', '/v1/pos/return-window', { returnWindowDays: days }), () => ({ tone: 'ok', text: w('savedNow') }));
      },
    },
    setMoney('set-refund-threshold', 'setRefund', 'pos.return.threshold.set', '/v1/pos/refund-threshold', 'thresholdMinor', 'zeroRefund'),
    setMoney('set-store-credit-cap', 'setCredit', 'pos.storecredit.cap.set', '/v1/pos/store-credit-cap', 'capMinor', 'zeroCredit'),
    setMoney('set-no-receipt-cap', 'setNoReceipt', 'pos.return.noreceipt.cap.set', '/v1/pos/no-receipt-cap', 'capMinor', 'zeroNoReceipt'),
    setMoney('set-write-off-threshold', 'setWriteOff', 'inventory.writeoff.threshold.set', '/v1/inventory/write-off-threshold', 'thresholdMinor'),
    setMoney('set-count-policy', 'setCount', 'inventory.count.policy.set', '/v1/inventory/count-policy', 'approvalThresholdMinor'),
    !may('purchase.match.policy.set') ? null : {
      id: 'set-match-policy', title: w('setMatch'), go: w('saveGo'), refresh: ['read'],
      fields: [{ key: 'qty', label: w('qtyTol'), kind: 'text' }, { key: 'price', label: w('priceTol'), kind: 'text' }, { key: 'small', label: w('small'), kind: 'money' }],
      run: async (v) => {
        const q = bpsOf(v['qty']); const p = bpsOf(v['price']); const s = paiseOf(v['small']);
        if (q === undefined || p === undefined) return invalid(common('needPercent'));
        if (s === undefined) return invalid(common('needMoney'));
        return said(await call('POST', '/v1/purchase/match-policy', { quantityToleranceBps: q, priceToleranceBps: p, immaterialMinor: s }), () => ({ tone: 'ok', text: w('savedNow') }));
      },
    },
  ];
  const kept = actions.filter((a): a is W5Action => a !== null);
  // The read alone, with no number the viewer may read, is nothing to show.
  const readable = ['pos.return.record', 'waste.view', 'inventory.count.policy.read', 'purchase.commitment.read'].some(may);
  return section({ id: 'w5-policy', heading: w('h'), lead: w('lead'), actions: readable ? kept : kept.filter((a) => a.id !== 'read') });
}

// ═════════════════════════════════════════════════ /indents — reject, cancel, send back ════════════════════════════════

export const INDENT_CHANGES_COPY = {
  en: {
    h: 'Change an indent', lead: 'Reject an indent (a different person from the one who asked), cancel what the back store still owes, or send stock the indent brought back to the back store. A return moves nothing until the back store counts it in on the warehouse handheld — someone other than the person who sent it.',
    indent: 'Indent number', reason: 'Why', product: 'Product', batch: 'Batch (if the label shows one)', qty: 'How many',
    reject: 'Reject an indent', rejectGo: 'Reject it', rejected: 'Indent {id} is rejected. Nothing moved.', alreadyRejected: 'Indent {id} was already rejected.',
    cancel: 'Cancel what is still owed', cancelGo: 'Cancel the rest', cancelled: 'The rest of indent {id} is cancelled. Anything already on the trolley must still be counted in.', alreadyCancelled: 'The rest of indent {id} was already cancelled.',
    ret: 'Send stock back to the back store', retGo: 'Ask the back store to take it back', returned: 'Return {rid} on indent {id} is recorded. The back store counts it in on the warehouse handheld.',
    waiting: 'Returns waiting at the back store', waitingGo: 'Show them', waitingLine: '{id} · return {rid} — {what} — sent back by {who}: {why}', noneWaiting: 'No return is waiting at the back store.',
    ownIndent: 'You asked for this indent — a different person must reject it (§28).', unknownProduct: 'That product is not one this store sells.',
  },
  ta: {
    h: 'ஒரு கோரிக்கையை மாற்று', lead: 'ஒரு கோரிக்கையை நிராகரிக்கவும் (கேட்டவர் அல்லாத வேறொருவர்), பின் கிடங்கு இன்னும் தர வேண்டியதை ரத்து செய்யவும், அல்லது கோரிக்கை கொண்டு வந்த சரக்கைப் பின் கிடங்குக்குத் திருப்பவும். அனுப்பியவர் அல்லாத வேறொருவர் கிடங்குக் கைக்கருவியில் எண்ணி ஏற்கும் வரை திருப்பம் எதையும் நகர்த்தாது.',
    indent: 'கோரிக்கை எண்', reason: 'ஏன்', product: 'பொருள்', batch: 'தொகுதி (லேபிளில் இருந்தால்)', qty: 'எத்தனை',
    reject: 'கோரிக்கையை நிராகரி', rejectGo: 'நிராகரி', rejected: 'கோரிக்கை {id} நிராகரிக்கப்பட்டது. எதுவும் நகரவில்லை.', alreadyRejected: 'கோரிக்கை {id} ஏற்கனவே நிராகரிக்கப்பட்டது.',
    cancel: 'இன்னும் தர வேண்டியதை ரத்து செய்', cancelGo: 'மீதியை ரத்து செய்', cancelled: 'கோரிக்கை {id}இன் மீதி ரத்து செய்யப்பட்டது. தள்ளுவண்டியில் ஏற்கனவே உள்ளதை இன்னும் எண்ணி ஏற்க வேண்டும்.', alreadyCancelled: 'கோரிக்கை {id}இன் மீதி ஏற்கனவே ரத்து செய்யப்பட்டது.',
    ret: 'சரக்கைப் பின் கிடங்குக்குத் திருப்பு', retGo: 'திரும்ப எடுக்கப் பின் கிடங்கைக் கேள்', returned: 'கோரிக்கை {id}இல் திருப்பம் {rid} பதியப்பட்டது. பின் கிடங்கு அதைக் கிடங்குக் கைக்கருவியில் எண்ணி ஏற்கும்.',
    waiting: 'பின் கிடங்கில் காத்திருக்கும் திருப்பங்கள்', waitingGo: 'காட்டு', waitingLine: '{id} · திருப்பம் {rid} — {what} — திருப்பியவர் {who}: {why}', noneWaiting: 'பின் கிடங்கில் எந்தத் திருப்பமும் காத்திருக்கவில்லை.',
    ownIndent: 'இந்தக் கோரிக்கையை நீங்கள் கேட்டீர்கள் — வேறொருவர் நிராகரிக்க வேண்டும் (§28).', unknownProduct: 'அந்தப் பொருள் இந்தக் கடை விற்கும் பொருள் அல்ல.',
  },
} as const;

export interface IndentProduct { readonly productId: string; readonly uom?: string }

/** The returns on head office's register that wait for the back store (state `requested`). */
export function waitingReturnsOf(body: unknown): readonly { readonly indentId: string; readonly returnId: string; readonly returnedBy: string; readonly reason: string; readonly lines: readonly { productId: string; batchId: string | null; quantityMinor: number }[] }[] {
  const indents = isObj(body) ? arr(body['indents']) : [];
  return indents.filter(isObj).flatMap((i) => arr(i['returns']).filter(isObj).filter((r) => r['state'] === 'requested').map((r) => ({
    indentId: str(i['indentId']), returnId: str(r['returnId']), returnedBy: str(r['returnedBy']), reason: str(r['reason']),
    lines: arr(r['lines']).filter(isObj).map((l) => ({ productId: str(l['productId']), batchId: typeof l['batchId'] === 'string' ? l['batchId'] : null, quantityMinor: num(l['quantityMinor']) ?? 0 })),
  })));
}

export function indentChangesSection(input: SectionInput & { readonly products?: readonly IndentProduct[] }): W5Section | null {
  const { may, call, id } = setup(input, 'w5-indent');
  const w = wordsOf(INDENT_CHANGES_COPY);
  const uomOf = (p: string): string | undefined => input.products?.find((x) => x.productId === p)?.uom;
  const indent: W5Field = { key: 'indent', label: w('indent'), kind: 'text' };
  const reason: W5Field = { key: 'reason', label: w('reason'), kind: 'text' };
  const actions: (W5Action | null)[] = [
    !may('inventory.indent.approve') ? null : {
      id: 'reject', title: w('reject'), fields: [indent, reason], go: w('rejectGo'), refresh: ['waiting'],
      run: async (v) => {
        const i = filled(v['indent']); const r = filled(v['reason']);
        if (i === undefined || r === undefined) return invalid(common('needText'));
        return said(await call<Record<string, unknown>>('POST', `/v1/floor/indents/${enc(i)}/rejection`, { reason: r }), (b) => ({ tone: 'ok', text: w(b['alreadyRejected'] === true ? 'alreadyRejected' : 'rejected', { id: i }) }));
      },
    },
    !may('inventory.indent.request') ? null : {
      id: 'cancel', title: w('cancel'), fields: [indent, reason], go: w('cancelGo'), refresh: ['waiting'],
      run: async (v) => {
        const i = filled(v['indent']); const r = filled(v['reason']);
        if (i === undefined || r === undefined) return invalid(common('needText'));
        return said(await call<Record<string, unknown>>('POST', `/v1/floor/indents/${enc(i)}/cancel`, { reason: r }), (b) => ({ tone: 'ok', text: w(b['alreadyCancelled'] === true ? 'alreadyCancelled' : 'cancelled', { id: i }) }));
      },
    },
    !may('inventory.indent.request') ? null : {
      id: 'return', title: w('ret'), go: w('retGo'), refresh: ['waiting'],
      fields: [indent, { key: 'product', label: w('product'), kind: 'text' }, { key: 'batch', label: join(w('batch'), common('optional')), kind: 'text' }, { key: 'qty', label: w('qty'), kind: 'text' }, reason],
      run: async (v) => {
        const i = filled(v['indent']); const p = filled(v['product']); const r = filled(v['reason']);
        if (i === undefined || p === undefined || r === undefined) return invalid(common('needText'));
        const uom = uomOf(p);
        if (input.products !== undefined && uom === undefined) return invalid(w('unknownProduct'));
        const q = uom === undefined ? wholeOf(v['qty']) : typedQuantityMinor(v['qty'] ?? '', uom);
        if (q === undefined || q <= 0) return invalid(common('needQty'));
        const rid = id('ret');
        const batch = filled(v['batch']);
        return said(await call('POST', `/v1/floor/indents/${enc(i)}/returns/${enc(rid)}`, { lines: [{ productId: p, ...(batch === undefined ? {} : { batchId: batch }), quantityMinor: q }], reason: r }),
          () => ({ tone: 'ok', text: w('returned', { id: i, rid }) }));
      },
    },
    !may('inventory.indent.read') ? null : {
      id: 'waiting', title: w('waiting'), fields: [], go: w('waitingGo'), auto: true,
      run: async () => said(await call<unknown>('GET', '/v1/floor/indents?open=true'), (b) => {
        const rows = waitingReturnsOf(b);
        if (rows.length === 0) return { tone: 'info', text: w('noneWaiting') };
        return {
          tone: 'info', text: raw(''),
          lines: rows.map((r) => ({
            key: r.returnId, tone: 'warn' as const,
            text: w('waitingLine', { id: r.indentId, rid: r.returnId, who: r.returnedBy, why: r.reason, what: r.lines.map((l) => `${quantityLabel(l.quantityMinor, uomOf(l.productId) ?? 'ea')} × ${l.productId}${l.batchId === null ? '' : ` (${l.batchId})`}`).join(', ') }),
          })),
        };
      }),
    },
  ];
  return section({ id: 'w5-indent-changes', heading: w('h'), lead: w('lead'), actions: actions.filter((a): a is W5Action => a !== null) });
}

// ═════════════════════════════════════════════════ /goods-receipt — the held DSD goods ═════════════════════════════════

export const DSD_HELD_COPY = {
  en: {
    h: 'Direct deliveries: goods held beyond the order', lead: 'A delivery checked in at the door (paid later as a supplier bill) can bring more than was ordered, or goods with no order behind them. Those are held — not on sale — until someone other than the receiver keeps or refuses them. Keeping puts them in stock; refusing sends them back to the supplier.',
    list: 'Held goods waiting for a decision', listGo: 'Show them', line: '{id} · {supplier} · received by {who} — {what}', none: 'No direct delivery holds goods for a decision.', yours: '(you received it — another person decides)',
    decide: 'Decide held goods', checkIn: 'Check-in number', decision: 'Decision', keep: 'Keep them (put in stock)', refuse: 'Refuse them (back to the supplier)', reason: 'Why', go: 'Record the decision',
    kept: 'Kept: the held goods on {id} are in stock now.', refused: 'Refused: the held goods on {id} go back to the supplier.', already: 'That decision was already recorded for {id}.',
  },
  ta: {
    h: 'நேரடி விநியோகங்கள்: ஆர்டருக்கு மேல் வைக்கப்பட்ட பொருட்கள்', lead: 'வாசலில் பதியப்பட்ட விநியோகம் (பின்னர் சப்ளையர் பில்லாகச் செலுத்தப்படும்) ஆர்டரை விட அதிகமாகவோ, ஆர்டர் இல்லாத பொருட்களையோ கொண்டு வரலாம். பெற்றவர் அல்லாத வேறொருவர் வைக்க அல்லது மறுக்கும் வரை அவை விற்பனைக்கு இல்லாமல் வைக்கப்படும். வைத்தால் இருப்பில் சேரும்; மறுத்தால் சப்ளையருக்குத் திரும்பும்.',
    list: 'முடிவுக்காகக் காத்திருக்கும் பொருட்கள்', listGo: 'காட்டு', line: '{id} · {supplier} · பெற்றவர் {who} — {what}', none: 'முடிவுக்காக எந்த நேரடி விநியோகமும் பொருட்களை வைத்திருக்கவில்லை.', yours: '(நீங்கள் பெற்றீர்கள் — வேறொருவர் முடிவு செய்வார்)',
    decide: 'வைக்கப்பட்ட பொருட்களை முடிவு செய்', checkIn: 'பதிவு எண்', decision: 'முடிவு', keep: 'வை (இருப்பில் சேர்)', refuse: 'மறு (சப்ளையருக்குத் திருப்பு)', reason: 'ஏன்', go: 'முடிவைப் பதி',
    kept: 'வைக்கப்பட்டது: {id}இல் வைக்கப்பட்ட பொருட்கள் இப்போது இருப்பில் உள்ளன.', refused: 'மறுக்கப்பட்டது: {id}இல் வைக்கப்பட்ட பொருட்கள் சப்ளையருக்குத் திரும்பும்.', already: '{id}க்கு அந்த முடிவு ஏற்கனவே பதியப்பட்டது.',
  },
} as const;

export function dsdHeldSection(input: SectionInput): W5Section | null {
  const { may, call, userId } = setup(input, 'w5-dsd');
  const w = wordsOf(DSD_HELD_COPY);
  const actions: (W5Action | null)[] = [
    !(may('inventory.adjustment.approve') && may('inventory.availability.read')) ? null : {
      id: 'held', title: w('list'), fields: [], go: w('listGo'), auto: true,
      run: async () => said(await call<unknown>('GET', '/v1/inventory/dsd-checkins'), (b) => {
        const rows = (isObj(b) ? arr(b['checkIns']) : []).filter(isObj).filter((r) => isObj(r['held']) && (r['held'] as Record<string, unknown>)['state'] === 'pending');
        if (rows.length === 0) return { tone: 'info', text: w('none') };
        return {
          tone: 'info', text: raw(''),
          lines: rows.map((r) => {
            const lines = arr((r['held'] as Record<string, unknown>)['lines']).filter(isObj);
            const mine = str(r['receivedBy']) === userId;
            return {
              key: str(r['checkInId']), tone: 'warn' as const,
              text: join(w('line', { id: str(r['checkInId']), supplier: str(r['supplierId']), who: str(r['receivedBy']), what: lines.map((l) => `${str(l['quantityMinor'])} × ${str(l['productId'])}`).join(', ') }), mine ? w('yours') : raw('')),
            };
          }),
        };
      }),
    },
    !may('inventory.adjustment.approve') ? null : {
      id: 'decide', title: w('decide'), go: w('go'), refresh: ['held'],
      fields: [{ key: 'checkIn', label: w('checkIn'), kind: 'text' }, { key: 'decision', label: w('decision'), kind: 'select', options: [{ value: 'approved', label: w('keep') }, { value: 'rejected', label: w('refuse') }] }, { key: 'reason', label: w('reason'), kind: 'text' }],
      run: async (v) => {
        const id = filled(v['checkIn']); const r = filled(v['reason']); const d = v['decision'] === 'rejected' ? 'rejected' : v['decision'] === 'approved' ? 'approved' : undefined;
        if (id === undefined || r === undefined || d === undefined) return invalid(common('needText'));
        return said(await call<Record<string, unknown>>('POST', `/v1/inventory/dsd-checkins/${enc(id)}/held/decide`, { decision: d, reason: r }),
          (b) => ({ tone: 'ok', text: w(b['alreadyDecided'] === true ? 'already' : d === 'approved' ? 'kept' : 'refused', { id }) }));
      },
    },
  ];
  return section({ id: 'w5-dsd-held', heading: w('h'), lead: w('lead'), actions: actions.filter((a): a is W5Action => a !== null) });
}

// ═════════════════════════════════════════════════ /stock-health — on-shelf availability ═══════════════════════════════

export const OSA_COPY = {
  en: {
    h: 'On-shelf availability — stock the books say is there but is not selling', lead: 'An item with stock on the books that has not sold for longer than expected may not really be on the shelf. A person raises a count of it; a counted difference becomes an adjustment request a second person decides. Nothing here changes stock. The minimum number of days is the owner\'s.',
    list: 'Items suspected missing from the shelf', listGo: 'Check now', notSet: 'The owner has not set the minimum days yet — nothing is judged until he does.', minimumIs: 'Owner\'s minimum: {days} day(s).',
    suspect: '{product} at {place} — {onHand} on the books, no sale for {days} day(s) (expected within {threshold})', openTask: '· count task {task} is open', none: 'No item is suspected missing from the shelf.',
    minimum: 'Set the minimum days (owner)', days: 'Days without a sale before an item is suspected', setGo: 'Save the minimum', minSaved: 'Saved: an item is suspected after {days} day(s) without a sale.',
    raise: 'Raise a count of one item', product: 'Product', place: 'Place (store or shelf location)', raiseGo: 'Raise the count', raised: 'Count task {task} is raised for {product}.', alreadyRaised: 'Count task {task} was already raised.',
    tasks: 'Count tasks', tasksGo: 'Show them', taskLine: '{task} · {product} at {place} — {state}', noTasks: 'No count task yet.',
    st_open: 'open — waiting for the count', st_stock_confirmed: 'counted {counted}: the books were right', st_adjustment_requested: 'counted {counted}, books {expected}: adjustment request {req} ({status})',
    count: 'Record a count', task: 'Count task number', counted: 'How many are there (shelf and back)', reasonCode: 'If it differs, why', note: 'Note', countGo: 'Record the count',
    rc_damaged: 'Damaged', rc_expired: 'Expired', rc_miscount: 'Miscounted before', rc_found: 'Found', rc_theft_suspected: 'Theft suspected', rc_other: 'Other', rc_none: '— no difference —',
    countSame: 'Counted: the books were right. Nothing changes.', countDiff: 'Counted. The difference is adjustment request {req}, waiting for a second person to decide. Stock has not changed.',
  },
  ta: {
    h: 'அலமாரியில் கிடைப்பு — கணக்கில் இருந்தும் விற்காத சரக்கு', lead: 'கணக்கில் இருப்பு உள்ள, எதிர்பார்த்ததை விட நீண்ட நாள் விற்காத பொருள் உண்மையில் அலமாரியில் இல்லாமல் இருக்கலாம். ஒருவர் அதன் எண்ணிக்கையை எழுப்புவார்; எண்ணிய வேறுபாடு இரண்டாம் நபர் முடிவு செய்யும் சரிசெய்தல் கோரிக்கையாகும். இங்கே எதுவும் இருப்பை மாற்றாது. குறைந்தபட்ச நாட்கள் உரிமையாளருடையவை.',
    list: 'அலமாரியில் இல்லை என சந்தேகிக்கப்படும் பொருட்கள்', listGo: 'இப்போது சரிபார்', notSet: 'உரிமையாளர் இன்னும் குறைந்தபட்ச நாட்களை அமைக்கவில்லை — அவர் அமைக்கும் வரை எதுவும் மதிப்பிடப்படாது.', minimumIs: 'உரிமையாளரின் குறைந்தபட்சம்: {days} நாள்.',
    suspect: '{place}இல் {product} — கணக்கில் {onHand}, {days} நாளாக விற்பனை இல்லை ({threshold}க்குள் எதிர்பார்க்கப்பட்டது)', openTask: '· எண்ணிக்கைப் பணி {task} திறந்துள்ளது', none: 'அலமாரியில் இல்லை என எந்தப் பொருளும் சந்தேகிக்கப்படவில்லை.',
    minimum: 'குறைந்தபட்ச நாட்களை அமை (உரிமையாளர்)', days: 'சந்தேகிக்கும் முன் விற்பனை இல்லாத நாட்கள்', setGo: 'குறைந்தபட்சத்தைச் சேமி', minSaved: 'சேமிக்கப்பட்டது: {days} நாள் விற்பனை இல்லாவிட்டால் பொருள் சந்தேகிக்கப்படும்.',
    raise: 'ஒரு பொருளின் எண்ணிக்கையை எழுப்பு', product: 'பொருள்', place: 'இடம் (கடை அல்லது அலமாரி இடம்)', raiseGo: 'எண்ணிக்கையை எழுப்பு', raised: '{product}க்கு எண்ணிக்கைப் பணி {task} எழுப்பப்பட்டது.', alreadyRaised: 'எண்ணிக்கைப் பணி {task} ஏற்கனவே எழுப்பப்பட்டது.',
    tasks: 'எண்ணிக்கைப் பணிகள்', tasksGo: 'காட்டு', taskLine: '{task} · {place}இல் {product} — {state}', noTasks: 'இன்னும் எண்ணிக்கைப் பணி இல்லை.',
    st_open: 'திறந்துள்ளது — எண்ணிக்கைக்குக் காத்திருக்கிறது', st_stock_confirmed: '{counted} எண்ணப்பட்டது: கணக்கு சரி', st_adjustment_requested: '{counted} எண்ணப்பட்டது, கணக்கில் {expected}: சரிசெய்தல் கோரிக்கை {req} ({status})',
    count: 'எண்ணிக்கையைப் பதி', task: 'எண்ணிக்கைப் பணி எண்', counted: 'எத்தனை உள்ளன (அலமாரியும் பின்புறமும்)', reasonCode: 'வேறுபட்டால், ஏன்', note: 'குறிப்பு', countGo: 'எண்ணிக்கையைப் பதி',
    rc_damaged: 'சேதமடைந்தது', rc_expired: 'காலாவதியானது', rc_miscount: 'முன்பு தவறாக எண்ணப்பட்டது', rc_found: 'கண்டுபிடிக்கப்பட்டது', rc_theft_suspected: 'திருட்டு சந்தேகம்', rc_other: 'மற்றவை', rc_none: '— வேறுபாடு இல்லை —',
    countSame: 'எண்ணப்பட்டது: கணக்கு சரி. எதுவும் மாறாது.', countDiff: 'எண்ணப்பட்டது. வேறுபாடு சரிசெய்தல் கோரிக்கை {req}, இரண்டாம் நபரின் முடிவுக்குக் காத்திருக்கிறது. இருப்பு மாறவில்லை.',
  },
} as const;

export function osaSection(input: SectionInput & { readonly storeId?: string }): W5Section | null {
  const { may, call, id } = setup(input, 'w5-osa');
  const w = wordsOf(OSA_COPY);
  let proposals: readonly { productId: string; locationId: string; taskId: string }[] = [];
  const actions: (W5Action | null)[] = [
    !may('inventory.availability.read') ? null : {
      id: 'suspects', title: w('list'), fields: [], go: w('listGo'), auto: true,
      run: async () => said(await call<Record<string, unknown>>('GET', '/v1/inventory/on-shelf-availability'), (b) => {
        if (b['state'] === 'minimum_not_set') return { tone: 'warn', text: w('notSet') };
        const min = isObj(b['minimum']) ? num(b['minimum']['minimumDays']) : undefined;
        const suspects = arr(b['suspects']).filter(isObj);
        proposals = suspects.flatMap((s) => (isObj(s['proposedCountTask']) ? [{ productId: str(s['productId']), locationId: str(s['locationId']), taskId: str(s['proposedCountTask']['taskId']) }] : []));
        const head = min === undefined ? raw('') : w('minimumIs', { days: min });
        if (suspects.length === 0) return { tone: 'ok', text: join(head, w('none')) };
        return {
          tone: 'warn', text: head,
          lines: suspects.map((s) => ({
            key: `${str(s['locationId'])}|${str(s['productId'])}`, tone: 'warn' as const,
            text: join(w('suspect', { product: str(s['productId']), place: str(s['locationId']), onHand: str(s['onHandMinor']), days: str(s['daysWithoutSale']), threshold: str(s['thresholdDays']) }),
              isObj(s['openCountTask']) ? w('openTask', { task: str(s['openCountTask']['taskId']) }) : raw('')),
          })),
        };
      }),
    },
    !may('inventory.osa.configure') ? null : {
      id: 'minimum', title: w('minimum'), fields: [{ key: 'days', label: w('days'), kind: 'number' }], go: w('setGo'), refresh: ['suspects'],
      run: async (v) => {
        const d = wholeOf(v['days']);
        if (d === undefined) return invalid(common('needWhole'));
        return said(await call('POST', '/v1/inventory/on-shelf-availability/minimum', { minimumDays: d }), () => ({ tone: 'ok', text: w('minSaved', { days: d }) }));
      },
    },
    !may('inventory.osa.task.raise') ? null : {
      id: 'raise', title: w('raise'), go: w('raiseGo'), refresh: ['suspects', 'tasks'],
      fields: [{ key: 'product', label: w('product'), kind: 'text' }, { key: 'place', label: w('place'), kind: 'text', ...(input.storeId === undefined ? {} : { initial: input.storeId }) }],
      run: async (v) => {
        const p = filled(v['product']); const l = filled(v['place']);
        if (p === undefined || l === undefined) return invalid(common('needText'));
        const task = proposals.find((x) => x.productId === p && x.locationId === l)?.taskId ?? id('osa');
        return said(await call<Record<string, unknown>>('POST', `/v1/inventory/on-shelf-availability/count-tasks/${enc(task)}`, { productId: p, locationId: l }),
          (b) => ({ tone: 'ok', text: w(b['alreadyRaised'] === true ? 'alreadyRaised' : 'raised', { task, product: p }) }));
      },
    },
    !may('inventory.availability.read') ? null : {
      id: 'tasks', title: w('tasks'), fields: [], go: w('tasksGo'), auto: true,
      run: async () => said(await call<Record<string, unknown>>('GET', '/v1/inventory/on-shelf-availability/count-tasks'), (b) => {
        const tasks = arr(b['tasks']).filter(isObj);
        if (tasks.length === 0) return { tone: 'info', text: w('noTasks') };
        return {
          tone: 'info', text: raw(''),
          lines: tasks.map((t) => ({
            key: str(t['taskId']), tone: t['state'] === 'open' ? 'warn' as const : t['state'] === 'adjustment_requested' ? 'warn' as const : 'ok' as const,
            text: (l: Lang) => w('taskLine', { task: str(t['taskId']), product: str(t['productId']), place: str(t['locationId']), state: w(`st_${str(t['state'])}`, { counted: str(t['countedMinor']), expected: str(t['expectedMinor']), req: str(t['adjustmentRequestId']), status: str(t['adjustmentStatus']) })(l) })(l),
          })),
        };
      }),
    },
    !may('inventory.osa.count.record') ? null : {
      id: 'count', title: w('count'), go: w('countGo'), refresh: ['tasks', 'suspects'],
      fields: [
        { key: 'task', label: w('task'), kind: 'text' }, { key: 'counted', label: w('counted'), kind: 'number' },
        { key: 'reasonCode', label: w('reasonCode'), kind: 'select', options: [{ value: '', label: w('rc_none') }, ...ADJUSTMENT_REASON_CODES.map((c) => ({ value: c, label: w(`rc_${c}`) }))] },
        { key: 'note', label: join(w('note'), common('optional')), kind: 'text' },
      ],
      run: async (v) => {
        const t = filled(v['task']); const c = wholeOf(v['counted']);
        if (t === undefined) return invalid(common('needText'));
        if (c === undefined) return invalid(common('needWhole'));
        const rc = filled(v['reasonCode']); const note = filled(v['note']);
        return said(await call<Record<string, unknown>>('POST', `/v1/inventory/on-shelf-availability/count-tasks/${enc(t)}/count`, { countedMinor: c, ...(rc === undefined ? {} : { reasonCode: rc }), ...(note === undefined ? {} : { note }) }),
          (b) => (isObj(b['adjustmentRequest']) ? { tone: 'warn', text: w('countDiff', { req: str(b['adjustmentRequest']['requestId']) }) } : { tone: 'ok', text: w('countSame') }));
      },
    },
  ];
  return section({ id: 'w5-osa', heading: w('h'), lead: w('lead'), actions: actions.filter((a): a is W5Action => a !== null) });
}

// ═════════════════════════════════════════════════ /recall-trace — trace requests ══════════════════════════════════════

export const TRACE_REQUESTS_COPY = {
  en: {
    h: 'Trace requests — answered within 24 hours', lead: 'When an inspector or a supplier asks where a batch came from and where it went, record the request here. It must be answered within 24 hours; one not answered in time is a critical exception. Answering keeps the trace exactly as it was given (its fingerprint), once.',
    list: 'Trace requests', listGo: 'Show them', line: '{id} · batch {batch} — asked by {who} ({why}) — {state}', none: 'No trace request is on file.',
    st_open: 'open, answer by {due}', st_overdue: 'OVERDUE — was due {due}', st_answered: 'answered {at}', st_answered_late: 'answered late, {at}',
    ask: 'Record a trace request', batch: 'Batch', askedBy: 'Who asked (name or office)', why: 'Why they asked', askGo: 'Record the request', asked: 'Request {id} is recorded. Answer it by {due}.',
    answer: 'Answer a trace request', request: 'Request number', answerGo: 'Answer it now', answered: 'Answered: {rows} line(s) in the trace, {gaps} gap(s). Fingerprint {sha}.', alreadyAnswered: 'Already answered on {at}; the trace as it is now is shown again.',
  },
  ta: {
    h: 'தடம் கோரிக்கைகள் — 24 மணி நேரத்தில் பதில்', lead: 'ஒரு ஆய்வாளர் அல்லது சப்ளையர் ஒரு தொகுதி எங்கிருந்து வந்தது, எங்கே சென்றது என்று கேட்டால், கோரிக்கையை இங்கே பதியுங்கள். 24 மணி நேரத்தில் பதில் தர வேண்டும்; நேரத்தில் பதிலளிக்காதது ஒரு முக்கிய விதிவிலக்கு. பதிலளிப்பது தடத்தை அளித்தபடியே (அதன் கைரேகையுடன்) ஒருமுறை வைக்கிறது.',
    list: 'தடம் கோரிக்கைகள்', listGo: 'காட்டு', line: '{id} · தொகுதி {batch} — கேட்டவர் {who} ({why}) — {state}', none: 'எந்தத் தடம் கோரிக்கையும் பதிவில் இல்லை.',
    st_open: 'திறந்துள்ளது, {due}க்குள் பதில்', st_overdue: 'தாமதம் — {due}க்குள் இருந்திருக்க வேண்டும்', st_answered: '{at} அன்று பதிலளிக்கப்பட்டது', st_answered_late: 'தாமதமாகப் பதிலளிக்கப்பட்டது, {at}',
    ask: 'தடம் கோரிக்கையைப் பதி', batch: 'தொகுதி', askedBy: 'கேட்டவர் (பெயர் அல்லது அலுவலகம்)', why: 'ஏன் கேட்டார்கள்', askGo: 'கோரிக்கையைப் பதி', asked: 'கோரிக்கை {id} பதியப்பட்டது. {due}க்குள் பதில் தாருங்கள்.',
    answer: 'தடம் கோரிக்கைக்குப் பதில்', request: 'கோரிக்கை எண்', answerGo: 'இப்போது பதில் தா', answered: 'பதிலளிக்கப்பட்டது: தடத்தில் {rows} வரி, {gaps} இடைவெளி. கைரேகை {sha}.', alreadyAnswered: '{at} அன்று ஏற்கனவே பதிலளிக்கப்பட்டது; இப்போதுள்ள தடம் மீண்டும் காட்டப்படுகிறது.',
  },
} as const;

export function traceRequestsSection(input: SectionInput): W5Section | null {
  const { may, call, id } = setup(input, 'w5-trace');
  const w = wordsOf(TRACE_REQUESTS_COPY);
  const moment = (s: unknown): string => (str(s) === '' ? '' : shopMomentOf(str(s)));
  const actions: (W5Action | null)[] = [
    !may('quality.lottrace.read') ? null : {
      id: 'requests', title: w('list'), fields: [], go: w('listGo'), auto: true,
      run: async () => said(await call<Record<string, unknown>>('GET', '/v1/quality/lot-trace/requests'), (b) => {
        const rows = arr(b['requests']).filter(isObj);
        if (rows.length === 0) return { tone: 'info', text: w('none') };
        return {
          tone: num(b['overdue']) === undefined || num(b['overdue']) === 0 ? 'info' : 'error', text: raw(str(b['detail'])),
          lines: rows.map((r) => {
            const state = str(r['state']);
            const at = isObj(r['answer']) ? moment(r['answer']['answeredAt']) : '';
            return {
              key: str(r['requestId']), tone: state === 'overdue' || state === 'answered_late' ? 'error' as const : state === 'open' ? 'warn' as const : 'ok' as const,
              text: (l: Lang) => w('line', { id: str(r['requestId']), batch: str(r['batchId']), who: str(r['askedBy']), why: str(r['reason']), state: w(`st_${state}`, { due: moment(r['dueAt']), at })(l) })(l),
            };
          }),
        };
      }),
    },
    !may('quality.lottrace.request') ? null : {
      id: 'ask', title: w('ask'), go: w('askGo'), refresh: ['requests'],
      fields: [{ key: 'batch', label: w('batch'), kind: 'text' }, { key: 'askedBy', label: w('askedBy'), kind: 'text' }, { key: 'why', label: w('why'), kind: 'text' }],
      run: async (v) => {
        const batch = filled(v['batch']); const who = filled(v['askedBy']); const why = filled(v['why']);
        if (batch === undefined || who === undefined || why === undefined) return invalid(common('needText'));
        const rid = id('tr');
        return said(await call<Record<string, unknown>>('POST', `/v1/quality/lot-trace/requests/${enc(rid)}`, { batchId: batch, askedBy: who, reason: why }),
          (b) => ({ tone: 'ok', text: w('asked', { id: rid, due: isObj(b['request']) ? moment(b['request']['dueAt']) : '' }) }));
      },
    },
    !may('quality.lottrace.request') ? null : {
      id: 'answer', title: w('answer'), go: w('answerGo'), refresh: ['requests'], fields: [{ key: 'request', label: w('request'), kind: 'text' }],
      run: async (v) => {
        const rid = filled(v['request']);
        if (rid === undefined) return invalid(common('needText'));
        return said(await call<Record<string, unknown>>('POST', `/v1/quality/lot-trace/requests/${enc(rid)}/answer`, {}), (b) => {
          const a = isObj(b['answer']) ? b['answer'] : {};
          if (b['alreadyAnswered'] === true) return { tone: 'info', text: w('alreadyAnswered', { at: moment(a['answeredAt']) }) };
          return { tone: 'ok', text: w('answered', { rows: str(a['rowCount']), gaps: str(a['gapCount']), sha: str(a['csvSha256']).slice(0, 12) }) };
        });
      },
    },
  ];
  return section({ id: 'w5-trace-requests', heading: w('h'), lead: w('lead'), actions: actions.filter((a): a is W5Action => a !== null) });
}

// ═════════════════════════════════════════════════ /production-costs — an ingredient's cost ════════════════════════════

export const INGREDIENT_COST_COPY = {
  en: {
    h: 'Register an ingredient\'s production cost', lead: 'The cost production uses for an ingredient that has no buying cost yet (one never bought, or made in the shop). It is per SMALLEST unit — one gram, one millilitre or one piece. A run is never valued on a figure typed for that run.',
    product: 'Ingredient (product)', cost: 'Cost of one smallest unit (₹)', go: 'Register the cost', saved: '{product} is now costed at {amount} per smallest unit for production.',
  },
  ta: {
    h: 'ஒரு பொருளின் உற்பத்திச் செலவைப் பதி', lead: 'இன்னும் வாங்கும் விலை இல்லாத பொருளுக்கு (ஒருபோதும் வாங்காதது, அல்லது கடையில் செய்தது) உற்பத்தி பயன்படுத்தும் செலவு. இது மிகச் சிறிய அலகுக்கு — ஒரு கிராம், ஒரு மில்லிலிட்டர் அல்லது ஒரு எண்ணிக்கை. ஓட்டத்திற்காக இடப்பட்ட எண்ணில் ஓட்டம் ஒருபோதும் மதிப்பிடப்படாது.',
    product: 'பொருள்', cost: 'ஒரு சிறிய அலகின் செலவு (₹)', go: 'செலவைப் பதி', saved: '{product} இப்போது உற்பத்திக்கு ஒரு சிறிய அலகுக்கு {amount} எனச் செலவிடப்படுகிறது.',
  },
} as const;

export function ingredientCostSection(input: SectionInput): W5Section | null {
  const { may, call } = setup(input, 'w5-cost');
  const w = wordsOf(INGREDIENT_COST_COPY);
  if (!may('production.recipe.manage')) return null;
  return section({
    id: 'w5-ingredient-cost', heading: w('h'), lead: w('lead'),
    actions: [{
      id: 'register', title: w('h'), go: w('go'), fields: [{ key: 'product', label: w('product'), kind: 'text' }, { key: 'cost', label: w('cost'), kind: 'money' }],
      run: async (v) => {
        const p = filled(v['product']); const c = paiseOf(v['cost']);
        if (p === undefined) return invalid(common('needText'));
        if (c === undefined) return invalid(common('needMoney'));
        return said(await call('POST', `/v1/production/costs/${enc(p)}`, { unitCostMinor: c, currency: 'INR' }), () => ({ tone: 'ok', text: w('saved', { product: p, amount: rupees(c) }) }));
      },
    }],
  });
}

// ═════════════════════════════════════════════════ /warehouse-supervisor/ — bins ═══════════════════════════════════════

export const BINS_COPY = {
  en: {
    h: 'Bins — set one up, see what one holds', lead: 'A bin\'s capacity and whether it may be picked from are what every scan is judged against. Stock that is not sellable never goes into a pickable bin.',
    register: 'Set up a bin', bin: 'Bin code', capacity: 'Capacity (smallest units)', pickable: 'May be picked from', zone: 'Zone', place: 'Location in the store (if any)', go: 'Save the bin',
    z_: '— no zone —', z_ambient: 'Ambient', z_chilled: 'Chilled', z_frozen: 'Frozen', z_secure: 'Secure', z_quarantine: 'Quarantine (not for sale)',
    saved: 'Bin {bin} is set up: capacity {cap}, {pick}.', pickYes: 'pickable', pickNo: 'not pickable',
    holds: 'What a bin holds', holdsGo: 'Show it', holdsHead: 'Bin {bin}: {used} of {cap} used — {pick}', holdsLine: '{what}: {qty}', empty: 'Bin {bin} is empty.',
  },
  ta: {
    h: 'தொட்டிகள் — அமை, உள்ளதைப் பார்', lead: 'ஒவ்வொரு ஸ்கேனும் தொட்டியின் கொள்ளளவு, அதிலிருந்து எடுக்கலாமா என்பதை வைத்து மதிப்பிடப்படுகிறது. விற்க முடியாத சரக்கு ஒருபோதும் எடுக்கும் தொட்டியில் செல்லாது.',
    register: 'தொட்டியை அமை', bin: 'தொட்டிக் குறியீடு', capacity: 'கொள்ளளவு (சிறிய அலகுகள்)', pickable: 'எடுக்கலாம்', zone: 'பகுதி', place: 'கடையில் இடம் (இருந்தால்)', go: 'தொட்டியைச் சேமி',
    z_: '— பகுதி இல்லை —', z_ambient: 'சாதாரண வெப்பம்', z_chilled: 'குளிர்', z_frozen: 'உறைவு', z_secure: 'பாதுகாப்பு', z_quarantine: 'தனிமைப்படுத்தல் (விற்பனைக்கு அல்ல)',
    saved: 'தொட்டி {bin} அமைக்கப்பட்டது: கொள்ளளவு {cap}, {pick}.', pickYes: 'எடுக்கலாம்', pickNo: 'எடுக்க முடியாது',
    holds: 'தொட்டியில் உள்ளது', holdsGo: 'காட்டு', holdsHead: 'தொட்டி {bin}: {cap}இல் {used} பயன்பாட்டில் — {pick}', holdsLine: '{what}: {qty}', empty: 'தொட்டி {bin} காலியாக உள்ளது.',
  },
} as const;

const BIN_ZONES = ['', 'ambient', 'chilled', 'frozen', 'secure', 'quarantine'] as const;

export function binsSection(input: SectionInput & { readonly storeId?: string }): W5Section | null {
  const { may, call } = setup(input, 'w5-bins');
  const w = wordsOf(BINS_COPY);
  const actions: (W5Action | null)[] = [
    !may('inventory.movement.append') || input.storeId === undefined ? null : {
      id: 'register', title: w('register'), go: w('go'),
      fields: [
        { key: 'bin', label: w('bin'), kind: 'text' }, { key: 'capacity', label: w('capacity'), kind: 'number' },
        { key: 'pickable', label: w('pickable'), kind: 'select', options: [{ value: 'yes', label: common('yes') }, { value: 'no', label: common('no') }] },
        { key: 'zone', label: w('zone'), kind: 'select', options: BIN_ZONES.map((z) => ({ value: z, label: w(`z_${z}`) })) },
        { key: 'place', label: join(w('place'), common('optional')), kind: 'text' },
      ],
      run: async (v) => {
        const bin = filled(v['bin']); const cap = wholeOf(v['capacity']);
        if (bin === undefined) return invalid(common('needText'));
        if (cap === undefined) return invalid(common('needWhole'));
        const pickable = v['pickable'] !== 'no'; const zone = filled(v['zone']); const place = filled(v['place']);
        return said(await call('POST', `/v1/warehouse/bins/${enc(bin)}`, { storeId: input.storeId, capacityMinor: cap, pickable, ...(zone === undefined ? {} : { zone }), ...(place === undefined ? {} : { locationId: place }) }),
          () => ({ tone: 'ok', text: (l: Lang) => w('saved', { bin, cap, pick: w(pickable ? 'pickYes' : 'pickNo')(l) })(l) }));
      },
    },
    !may('inventory.availability.read') ? null : {
      id: 'holds', title: w('holds'), go: w('holdsGo'), fields: [{ key: 'bin', label: w('bin'), kind: 'text' }],
      run: async (v) => {
        const bin = filled(v['bin']);
        if (bin === undefined) return invalid(common('needText'));
        return said(await call<Record<string, unknown>>('GET', `/v1/warehouse/bins/${enc(bin)}`), (b) => {
          const held = arr(b['held']).filter(isObj);
          const head = (l: Lang) => w('holdsHead', { bin, used: str(b['occupancyMinor']), cap: str(b['capacityMinor']), pick: w(b['pickable'] === true ? 'pickYes' : 'pickNo')(l) })(l);
          if (held.length === 0) return { tone: 'info', text: join(head, w('empty', { bin })) };
          // A key is `bin|product|batch` (the ledger's projection) — shown as the product and batch.
          return { tone: 'info', text: head, lines: held.map((h) => ({ key: str(h['key']), tone: (num(h['quantityMinor']) ?? 0) < 0 ? 'error' as const : 'ok' as const, text: w('holdsLine', { what: str(h['key']).split('|').slice(1).filter((x) => x !== '').join(' · '), qty: str(h['quantityMinor']) }) })) };
        });
      },
    },
  ];
  return section({ id: 'w5-bins', heading: w('h'), lead: w('lead'), actions: actions.filter((a): a is W5Action => a !== null) });
}
