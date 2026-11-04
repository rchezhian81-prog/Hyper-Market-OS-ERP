// Concessions · "Counter sale lines" and "Whose stock is whose" (W5 · M27-FR-03 "a concession sale attributes to the
// concessionaire and reconciles at settlement" · M27-FR-02 "concession stock is excluded from the store's valuation" ·
// M27-FR-04 · §28 · P-08 · hard rule #2) — a tested, DOM-free session over the head-office routes no screen reached:
//   • the counter's SALE LINES (`GET /v1/concession/contracts/:contractId/tags?from=&to=`) with head office's totals;
//   • RECORD a docket line at the desk (`POST …/tags/:tagId`) — the sale and line, the product and quantity, the counter,
//     till and shift, the money in rupees, and the docket it was taken from; head office keeps one line per tag, the
//     commission under the contract as it stands, and flags (never hides) a counter that could not trade that day;
//   • REVERSE or ADJUST a line (`POST …/tags/:tagId/reverse`, `…/adjust`) — a supervisor's act; a correction is a NEW line
//     naming the old, never an edit; head office refuses (and records) a cashier's attempt;
//   • MARK a window's lines as included in the charge, or settled (`POST …/tag-settlement`) — forward only, never back;
//   • SALES ON A DAY A COUNTER COULD NOT TRADE (`GET /v1/concession/trading-breaches`) — kept for a person;
//   • THE STORE'S STOCK VALUE WITHOUT THE CONCESSIONS' (`GET /v1/concession/branches/:branchId/store-valuation`).
// Head office re-checks every permission. Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { signedPaiseOf } from './settlement-bank-session';

export type Lang = 'en' | 'ta';

export const CONCESSION_TAGS_COPY = {
  en: {
    tagsH: 'Counter sale lines', tagsLede: 'Every line a concession counter sold, as the till or the desk recorded it, with the commission under the contract as it stood. A correction is a new line naming the old — nothing is rewritten. Correcting is a supervisor\'s act.',
    contract: 'Counter (contract)', from: 'From', to: 'To', show: 'Show the lines', none: 'No line is recorded for this counter in this window.',
    gross: 'Gross', net: 'Net', commission: 'Commission', lines: 'lines', kind_sale: 'sale', kind_return: 'return', kind_cancellation: 'cancellation', kind_reversal: 'reversal', kind_adjustment: 'adjustment',
    st_pending: 'not yet in a charge', st_included_in_charge: 'in a charge', st_settled: 'settled', corrects: 'corrects',
    recordH: 'Record a docket line at the desk', saleId: 'Sale number', lineId: 'Line', productId: 'Product', qty: 'Quantity', counterId: 'Counter', tillId: 'Till', shiftId: 'Shift', grossRs: 'Gross (₹)', discountRs: 'Discount (₹)', taxRs: 'Tax (₹)', source: 'Docket or app reference', record: 'Record the line',
    recorded: 'Recorded.', alreadyThere: 'That line is already recorded — nothing was written twice.', cannotTrade: 'Recorded — but this counter could not trade that day: {why}. A person must look.',
    reason: 'Reason', reverse: 'Reverse this line', adjust: 'Adjust this line', grossDelta: 'Gross change (₹, minus to reduce)', discountDelta: 'Discount change (₹)', taxDelta: 'Tax change (₹)', corrected: 'Correction recorded as a new line.',
    markH: 'Mark this window\'s lines', markCharge: 'Mark as included in the charge', markSettled: 'Mark as settled', marked: '{count} line(s) marked.',
    breachesH: 'Sales on a day a counter could not trade', showBreaches: 'Show them', noBreaches: 'No sale was recorded on a day a counter could not trade.', blockedBy: 'blocked by',
    valuationH: 'The store\'s stock without the concessions\'', valuationLede: 'The stock the store owns, valued on its own; stock that belongs to a concessionaire or another owner is left out and named — never folded in.', branch: 'Store', showValuation: 'Value the store\'s own stock', owned: 'The store owns', excluded: 'Left out (not the store\'s)', lots: 'lots',
    needContract: 'Choose the counter first.', needWindow: 'Give the window as dates (from and to).', needLine: 'Every field of the docket line is needed: sale, line, product, a whole quantity, counter, till, shift, the money in rupees and the docket reference.', needReason: 'Say why.', needDeltas: 'Type at least one change in rupees.', needBranch: 'Type the store.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see concession charges.', cannotRecord: 'Recording and correcting lines needs the concession desk\'s permission.', cannotManage: 'Marking lines needs the concession manager\'s permission.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    tagsH: 'கவுண்டர் விற்பனை வரிகள்', tagsLede: 'ஒரு சலுகைக் கவுண்டர் விற்ற ஒவ்வொரு வரியும், கல்லா அல்லது மேசை பதிந்தபடி, அப்போதைய ஒப்பந்தக் கமிஷனுடன். திருத்தம் என்பது பழையதைக் குறிப்பிடும் புதிய வரி — எதுவும் மாற்றி எழுதப்படாது. திருத்துவது மேற்பார்வையாளரின் செயல்.',
    contract: 'கவுண்டர் (ஒப்பந்தம்)', from: 'முதல்', to: 'வரை', show: 'வரிகளைக் காட்டு', none: 'இந்தக் காலத்தில் இந்தக் கவுண்டருக்கு எந்த வரியும் பதியப்படவில்லை.',
    gross: 'மொத்தம்', net: 'நிகரம்', commission: 'கமிஷன்', lines: 'வரிகள்', kind_sale: 'விற்பனை', kind_return: 'திருப்பம்', kind_cancellation: 'ரத்து', kind_reversal: 'மறுதலிப்பு', kind_adjustment: 'சரிசெய்தல்',
    st_pending: 'இன்னும் கட்டணத்தில் இல்லை', st_included_in_charge: 'கட்டணத்தில் உள்ளது', st_settled: 'தீர்க்கப்பட்டது', corrects: 'திருத்துவது',
    recordH: 'மேசையில் ஒரு டாக்கெட் வரியைப் பதி', saleId: 'விற்பனை எண்', lineId: 'வரி', productId: 'பொருள்', qty: 'அளவு', counterId: 'கவுண்டர்', tillId: 'கல்லா', shiftId: 'ஷிஃப்ட்', grossRs: 'மொத்தம் (₹)', discountRs: 'தள்ளுபடி (₹)', taxRs: 'வரி (₹)', source: 'டாக்கெட் அல்லது செயலி குறிப்பு', record: 'வரியைப் பதி',
    recorded: 'பதியப்பட்டது.', alreadyThere: 'அந்த வரி ஏற்கனவே பதியப்பட்டுள்ளது — இருமுறை எழுதப்படவில்லை.', cannotTrade: 'பதியப்பட்டது — ஆனால் அன்று இந்தக் கவுண்டர் வணிகம் செய்ய முடியாது: {why}. ஒருவர் பார்க்க வேண்டும்.',
    reason: 'காரணம்', reverse: 'இந்த வரியை மறுதலி', adjust: 'இந்த வரியைச் சரிசெய்', grossDelta: 'மொத்த மாற்றம் (₹, குறைக்க கழித்தல்)', discountDelta: 'தள்ளுபடி மாற்றம் (₹)', taxDelta: 'வரி மாற்றம் (₹)', corrected: 'திருத்தம் புதிய வரியாகப் பதியப்பட்டது.',
    markH: 'இந்தக் காலத்தின் வரிகளைக் குறி', markCharge: 'கட்டணத்தில் சேர்ந்ததாகக் குறி', markSettled: 'தீர்க்கப்பட்டதாகக் குறி', marked: '{count} வரிகள் குறிக்கப்பட்டன.',
    breachesH: 'கவுண்டர் வணிகம் செய்ய முடியாத நாளில் நடந்த விற்பனைகள்', showBreaches: 'அவற்றைக் காட்டு', noBreaches: 'கவுண்டர் வணிகம் செய்ய முடியாத நாளில் எந்த விற்பனையும் பதியப்படவில்லை.', blockedBy: 'தடுத்தது',
    valuationH: 'சலுகையாளர்களுடையது இல்லாமல் கடையின் சரக்கு', valuationLede: 'கடைக்குச் சொந்தமான சரக்கு, தனியாக மதிப்பிடப்படுகிறது; சலுகையாளர் அல்லது வேறு உரிமையாளருடையது விலக்கப்பட்டு பெயரிடப்படுகிறது — ஒருபோதும் சேர்க்கப்படாது.', branch: 'கடை', showValuation: 'கடையின் சொந்தச் சரக்கை மதிப்பிடு', owned: 'கடைக்குச் சொந்தமானது', excluded: 'விலக்கப்பட்டது (கடையுடையது அல்ல)', lots: 'தொகுதிகள்',
    needContract: 'முதலில் கவுண்டரைத் தேர்ந்தெடுக்கவும்.', needWindow: 'காலத்தைத் தேதிகளாகக் கொடுக்கவும் (முதல், வரை).', needLine: 'டாக்கெட் வரியின் ஒவ்வொரு புலமும் தேவை: விற்பனை, வரி, பொருள், முழு அளவு, கவுண்டர், கல்லா, ஷிஃப்ட், ரூபாயில் பணம், டாக்கெட் குறிப்பு.', needReason: 'ஏன் என்று சொல்லுங்கள்.', needDeltas: 'குறைந்தது ஒரு மாற்றத்தை ரூபாயில் தட்டச்சு செய்யவும்.', needBranch: 'கடையைத் தட்டச்சு செய்யவும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு சலுகைக் கட்டணங்களைப் பார்க்க முடியாது.', cannotRecord: 'வரிகளைப் பதிவதற்கும் திருத்துவதற்கும் சலுகை மேசையின் அனுமதி தேவை.', cannotManage: 'வரிகளைக் குறிக்க சலுகை மேலாளரின் அனுமதி தேவை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.',
  },
} as const;

export function concessionTagsWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (CONCESSION_TAGS_COPY[lang] as Record<string, string>)[key] ?? (CONCESSION_TAGS_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}
export const concessionTagsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => concessionTagsWords(lang, k), out);

export interface Tag {
  readonly tagId: string; readonly kind: string; readonly saleId: string; readonly lineId: string; readonly productId: string; readonly qty: number;
  readonly grossMinor: number; readonly netMinor: number; readonly commissionMinor: number; readonly settlementStatus: string; readonly correctsTagId?: string; readonly capturedBy: string; readonly at: string;
}
export interface TagList { readonly contractId: string; readonly concessionaireId: string; readonly tags: readonly Tag[]; readonly totals: { readonly grossMinor: number; readonly netMinor: number; readonly commissionMinor: number; readonly detail: string } }
export interface LineForm {
  readonly saleId: string; readonly lineId: string; readonly productId: string; readonly qty: string; readonly counterId: string; readonly tillId: string; readonly shiftId: string;
  readonly grossRupees: string; readonly discountRupees: string; readonly taxRupees: string; readonly source: string;
}
export interface Recorded { readonly captured: boolean; readonly trading?: { readonly mayTrade: boolean; readonly blockedBy: readonly string[] } }
export interface Breaches { readonly count: number; readonly breaches: readonly { readonly tagId: string; readonly contractId: string; readonly concessionaireId: string; readonly saleId: string; readonly grossMinor: number; readonly day: string; readonly blockedBy: readonly string[] }[] }
export interface Valuation { readonly branchId: string; readonly ownedValueMinor: number; readonly ownedLots: number; readonly excluded: readonly { readonly ownership: string; readonly ownerId: string; readonly lots: number; readonly valueMinor: number }[]; readonly excludedValueMinor: number; readonly detail: string }

/** A docket line as head office's record route reads it, or null when the form is not complete. Pure. */
export function lineBody(f: LineForm): Record<string, unknown> | null {
  const ids = [f.saleId, f.lineId, f.productId, f.counterId, f.tillId, f.shiftId, f.source].map((s) => s.trim());
  const qty = /^\d+$/.test(f.qty.trim()) ? Number(f.qty.trim()) : NaN;
  const gross = signedPaiseOf(f.grossRupees); const discount = f.discountRupees.trim() === '' ? 0 : signedPaiseOf(f.discountRupees); const tax = f.taxRupees.trim() === '' ? 0 : signedPaiseOf(f.taxRupees);
  if (ids.some((s) => s === '') || !Number.isSafeInteger(qty) || qty <= 0 || gross === null || gross < 0 || discount === null || discount < 0 || tax === null || tax < 0) return null;
  const [saleId, lineId, productId, counterId, tillId, shiftId, source] = ids as [string, string, string, string, string, string, string];
  return { saleId, lineId, productId, qty, counterId, tillId, shiftId, grossMinor: gross, discountMinor: discount, taxMinor: tax, source };
}

type Why = 'nobody' | 'cannotRead' | 'cannotRecord' | 'cannotManage' | 'needContract' | 'needWindow' | 'needLine' | 'needReason' | 'needDeltas' | 'needBranch';
type Done<T> = Promise<Outcome<T, Why>>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ConcessionTagsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly record: boolean; readonly manage: boolean };
  tags(contractId: string, from: string, to: string): Done<TagList>;
  record(contractId: string, f: LineForm): Done<Recorded>;
  reverse(contractId: string, tagId: string, reason: string): Done<{ readonly corrected: boolean }>;
  adjust(contractId: string, tagId: string, d: { readonly grossRupees: string; readonly discountRupees: string; readonly taxRupees: string }, reason: string): Done<{ readonly corrected: boolean }>;
  mark(contractId: string, status: 'included_in_charge' | 'settled', from: string, to: string): Done<{ readonly marked: number }>;
  breaches(): Done<Breaches>;
  valuation(branchId: string): Done<Valuation>;
}

export function createConcessionTagsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: (prefix: string) => string;
}): ConcessionTagsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('concession.charge.read'), record: named && held.has('concession.tag.record'), manage: named && held.has('concession.contract.manage') };
  const call = makeCaller({ keyPrefix: 'concession-tags', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const idOf = input.newId ?? newId;
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'record' | 'manage') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : need === 'record' ? 'cannotRecord' : 'cannotManage') : undefined);
  const enc = (s: string): string => encodeURIComponent(s.trim());
  const base = (c: string): string => `/v1/concession/contracts/${enc(c)}`;
  return {
    may,
    tags: async (c, from, to) => {
      const g = gate('record'); if (g) return g;
      if (c.trim() === '') return no('needContract');
      if ((from.trim() !== '' && !DAY.test(from.trim())) || (to.trim() !== '' && !DAY.test(to.trim()))) return no('needWindow');
      const q = new URLSearchParams({ ...(from.trim() === '' ? {} : { from: from.trim() }), ...(to.trim() === '' ? {} : { to: to.trim() }) }).toString();
      return call<TagList>('GET', `${base(c)}/tags${q === '' ? '' : `?${q}`}`);
    },
    record: async (c, f) => {
      const g = gate('record'); if (g) return g;
      if (c.trim() === '') return no('needContract');
      const body = lineBody(f); if (body === null) return no('needLine');
      return call<Recorded>('POST', `${base(c)}/tags/${enc(idOf('tag'))}`, body);
    },
    reverse: async (c, tagId, reason) => {
      const g = gate('record'); if (g) return g;
      if (reason.trim() === '') return no('needReason');
      return call('POST', `${base(c)}/tags/${enc(tagId)}/reverse`, { reasonCode: reason.trim() });
    },
    adjust: async (c, tagId, d, reason) => {
      const g = gate('record'); if (g) return g;
      if (reason.trim() === '') return no('needReason');
      const v = (s: string): number | null => (s.trim() === '' ? 0 : signedPaiseOf(s));
      const gross = v(d.grossRupees); const discount = v(d.discountRupees); const tax = v(d.taxRupees);
      if (gross === null || discount === null || tax === null || (gross === 0 && discount === 0 && tax === 0)) return no('needDeltas');
      return call('POST', `${base(c)}/tags/${enc(tagId)}/adjust`, { reasonCode: reason.trim(), grossDeltaMinor: gross, discountDeltaMinor: discount, taxDeltaMinor: tax });
    },
    mark: async (c, status, from, to) => {
      const g = gate('manage'); if (g) return g;
      if (c.trim() === '') return no('needContract');
      if (!DAY.test(from.trim()) || !DAY.test(to.trim())) return no('needWindow');
      return call('POST', `${base(c)}/tag-settlement`, { status, from: from.trim(), to: to.trim() });
    },
    breaches: async () => gate('read') ?? call<Breaches>('GET', '/v1/concession/trading-breaches'),
    valuation: async (b) => gate('read') ?? (b.trim() === '' ? no('needBranch') : call<Valuation>('GET', `/v1/concession/branches/${enc(b)}/store-valuation`)),
  };
}
