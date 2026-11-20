// STOCK HISTORY on the office's stock pages — batch 20b, the owner's missing-options audit of 19 Nov:
//
//   • S2 — Waste & write-off: EARLIER write-offs by date range and item, with totals (M28-FR-01 · M08-FR-03).
//   • S3 — Stock counts: EARLIER counts by date range, by number, and how ACCURATE the counting was (M09-FR-04).
//   • S4 — Stock health: WHAT THE EMPTY SHELVES COST — head office's estimate, its basis said in plain words, "Not known"
//          where it cannot be worked out (M08-FR-04 "stockouts" · P-08).
//   • S5 — Transfers: SUGGESTED transfers — where an item is out while another of our places holds it. A suggestion only:
//          "Start this transfer" fills the existing Start-a-transfer form; nothing moves until a person proposes it and a
//          second person sends it (M09-FR-03 · P-05 · hard rule #5).
//
// Each is a READ from head office in the signed-in person's session (HeadOfficeHttp). With the internet off the page says
// head office cannot be reached and keeps everything else it shows (the store keeps trading — P-01; nothing here is on
// the till). Holds the words (English and Tamil, one at a time) and the rules; DOM-free and tested.

import type { HeadOfficeHttp, HttpAnswer } from './head-office-http';
import { rupees } from './head-office-http';
import { quantityInWords } from './quantity-words';

export type Lang = 'en' | 'ta';
type Viewer = { readonly userId?: string; readonly permissions: readonly string[] } | undefined;

export const STOCK_HISTORY_WORDS = Object.freeze({
  en: {
    from: 'From', to: 'To', show: 'Show', reading: 'Reading…', badRange: 'Choose a "From" day that is not after the "To" day.',
    lost: 'Head office could not be reached, so this cannot be shown now. Everything else on this page still works.',
    refused: 'Head office did not show it:', nobody: 'Nobody is signed in on this page.', notKnown: 'Not known',
    noNumber: 'No number (saved before numbering began)',
    // S2
    woH: 'Earlier write-offs', woLede: 'Every write-off saved in the days you choose — not only today — with what was lost. Leave the item blank for every item.',
    woItem: 'Item code (blank = every item)', woNone: 'No write-offs were saved in these days.', woCannot: 'Your role does not see write-offs.',
    woCount: 'Write-offs', woTotal: 'Total lost', woDays: 'Days shown',
    colDate: 'Date', colNumber: 'Number', colItem: 'Item', colQty: 'How many', colKind: 'Kind of loss', colValue: 'Value', colRaised: 'Raised by', colApproved: 'Approved by',
    wastage: 'Wastage', damage: 'Damage', expiry: 'Expired', donation: 'Donation', destruction: 'Destroyed',
    statedValue: 'value as typed (no cost held)', notNeeded: 'Not needed', no: 'No',
    // S3
    chH: 'Earlier counts and how accurate they were', chLede: 'Every stock count in the days you choose, by its number, and how close the counts came to the stock record.',
    chNone: 'No counts were saved in these days.', chCannot: 'Your role does not see stock counts.',
    chCounts: 'Counts', chExact: 'Found exactly what the record said', chUnits: 'Units counted right', chShort: 'Short (value)', chOver: 'Over (value)',
    chOf: 'of', chWithoutValue: 'difference(s) have no value (no cost held)',
    colPlace: 'Place', colCounted: 'Counted', colRecord: 'Record said', colDifference: 'Difference', colApproval: 'Needed approval', colCounter: 'Counted by',
    matched: 'Matched', short: 'Short', over: 'Over', yes: 'Yes',
    // S4
    soH: 'What the empty shelves cost (an estimate)', soLede: 'The margin lost while items were sold out, over the last {days} days. A sale that never happened leaves no bill, so this is an estimate and is never added to the real figures.',
    soDays: 'Days to look back', soTotal: 'Estimated margin lost', soNotKnown: 'Items that could not be worked out', soNone: 'No item was empty for a whole day in these days.',
    soBasisH: 'How it is worked out',
    soBasis1: 'A day counts as empty when the stock record showed none at the start of the day and nothing of it was sold that day. Days before this place first had the item are not counted.',
    soBasis2: 'Normal sales a day = what sold over these days ÷ the days it was not empty.',
    soBasis3: 'Margin each = the item\'s margin over these days (sales before GST less the cost of what sold, the same as for GMROI) ÷ what sold.',
    soBasis4: 'Margin lost = empty days × normal sales a day × margin each. Items that earned no margin are left out.',
    colDaysEmpty: 'Days empty', colNormal: 'Normal sales a day', colLostSales: 'Sales lost (estimate)', colLostMargin: 'Margin lost (estimate)', colWhy: 'Why not known', colOnHand: 'On hand now',
    empty_every_day: 'It was empty every day, so its normal sales are not known.',
    margin_not_held: 'Its margin is not known (its GST rate is not held, so sales before GST cannot be worked out).',
    nothing_sold_anywhere: 'Nothing of it sold in these days, so its margin is not known.',
    soOfDays: 'of', workedOut: 'Worked out',
    // S5
    tsH: 'Suggested transfers', tsLede: 'Items that sold out where they sell while another of our places holds them. A suggestion only — nothing moves until a person starts a transfer below and a second person sends it.',
    tsShow: 'Show suggestions', tsNone: 'Nothing to suggest: no item is out where it sells while another of our places holds it.',
    tsCannot: 'Your role does not see stock.', colNeededAt: 'Needed at', colTakeFrom: 'Take from', colWhere: 'Where that is', colHeld: 'Held there', colSold: 'Sold here in the last 7 days', colStart: 'Start',
    own_back_store: 'This store\'s back store', head_office_warehouse: 'Head office\'s warehouse', another_store: 'Another store',
    tsStart: 'Start this transfer', tsFilled: 'Filled in: from {from} to {to}, item {item}. Type how many, press "Add this item", then "Propose this transfer". A second person sends it.',
  },
  ta: {
    from: 'இருந்து', to: 'வரை', show: 'காட்டு', reading: 'படிக்கிறது…', badRange: '"இருந்து" நாள் "வரை" நாளுக்குப் பிறகு இருக்கக் கூடாது.',
    lost: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இதை இப்போது காட்ட முடியாது. இந்தப் பக்கத்தின் மற்றவை வேலை செய்கின்றன.',
    refused: 'தலைமை அலுவலகம் காட்டவில்லை:', nobody: 'இந்தப் பக்கத்தில் யாரும் உள்நுழையவில்லை.', notKnown: 'தெரியவில்லை',
    noNumber: 'எண் இல்லை (எண்ணிடல் தொடங்கும் முன் சேமிக்கப்பட்டது)',
    woH: 'முந்தைய தள்ளுபடிகள்', woLede: 'நீங்கள் தேர்ந்தெடுக்கும் நாட்களில் சேமித்த ஒவ்வொரு தள்ளுபடியும் — இன்று மட்டுமல்ல — இழந்த மதிப்புடன். எல்லாப் பொருட்களுக்கும் பொருள் குறியீட்டை வெறுமையாக விடவும்.',
    woItem: 'பொருள் குறியீடு (வெறுமை = எல்லாப் பொருட்களும்)', woNone: 'இந்த நாட்களில் தள்ளுபடி எதுவும் சேமிக்கப்படவில்லை.', woCannot: 'உங்கள் பங்கு தள்ளுபடிகளைப் பார்ப்பதில்லை.',
    woCount: 'தள்ளுபடிகள்', woTotal: 'மொத்த இழப்பு', woDays: 'காட்டும் நாட்கள்',
    colDate: 'தேதி', colNumber: 'எண்', colItem: 'பொருள்', colQty: 'எத்தனை', colKind: 'இழப்பு வகை', colValue: 'மதிப்பு', colRaised: 'பதிவு செய்தவர்', colApproved: 'ஒப்புதல் அளித்தவர்',
    wastage: 'வீணானது', damage: 'சேதம்', expiry: 'காலாவதி', donation: 'நன்கொடை', destruction: 'அழிக்கப்பட்டது',
    statedValue: 'தட்டச்சு செய்த மதிப்பு (விலை இல்லை)', notNeeded: 'தேவையில்லை', no: 'இல்லை',
    chH: 'முந்தைய எண்ணிக்கைகளும் அவற்றின் துல்லியமும்', chLede: 'நீங்கள் தேர்ந்தெடுக்கும் நாட்களின் ஒவ்வொரு சரக்கு எண்ணிக்கையும், அதன் எண்ணுடன், சரக்குப் பதிவுக்கு எவ்வளவு நெருக்கமாக இருந்தது என்பதுடன்.',
    chNone: 'இந்த நாட்களில் எண்ணிக்கை எதுவும் சேமிக்கப்படவில்லை.', chCannot: 'உங்கள் பங்கு சரக்கு எண்ணிக்கைகளைப் பார்ப்பதில்லை.',
    chCounts: 'எண்ணிக்கைகள்', chExact: 'பதிவில் உள்ளபடியே கண்டவை', chUnits: 'சரியாக எண்ணிய அலகுகள்', chShort: 'குறைவு (மதிப்பு)', chOver: 'அதிகம் (மதிப்பு)',
    chOf: 'இல்', chWithoutValue: 'வேறுபாடு(கள்)க்கு மதிப்பு இல்லை (விலை இல்லை)',
    colPlace: 'இடம்', colCounted: 'எண்ணியது', colRecord: 'பதிவு சொன்னது', colDifference: 'வேறுபாடு', colApproval: 'ஒப்புதல் தேவைப்பட்டது', colCounter: 'எண்ணியவர்',
    matched: 'பொருந்தியது', short: 'குறைவு', over: 'அதிகம்', yes: 'ஆம்',
    soH: 'காலி அலமாரிகளின் இழப்பு (மதிப்பீடு)', soLede: 'கடந்த {days} நாட்களில் பொருட்கள் தீர்ந்திருந்தபோது இழந்த லாபம். நடக்காத விற்பனைக்கு பில் இருக்காது, எனவே இது ஒரு மதிப்பீடு மட்டுமே; உண்மை எண்களுடன் சேர்க்கப்படாது.',
    soDays: 'பின்னோக்கிப் பார்க்கும் நாட்கள்', soTotal: 'மதிப்பிட்ட லாப இழப்பு', soNotKnown: 'கணக்கிட முடியாத பொருட்கள்', soNone: 'இந்த நாட்களில் எந்தப் பொருளும் ஒரு முழு நாள் காலியாக இல்லை.',
    soBasisH: 'இது எப்படிக் கணக்கிடப்படுகிறது',
    soBasis1: 'நாளின் தொடக்கத்தில் சரக்குப் பதிவில் எதுவும் இல்லாமல், அன்று எதுவும் விற்கப்படாத நாள் காலி நாள். இந்த இடத்தில் பொருள் முதலில் வருவதற்கு முந்தைய நாட்கள் கணக்கில் இல்லை.',
    soBasis2: 'ஒரு நாளின் சாதாரண விற்பனை = இந்த நாட்களில் விற்றது ÷ காலியாக இல்லாத நாட்கள்.',
    soBasis3: 'ஒன்றின் லாபம் = இந்த நாட்களில் பொருளின் லாபம் (GSTக்கு முந்தைய விற்பனை கழித்தல் விற்றதன் அடக்க விலை, GMROI போலவே) ÷ விற்றது.',
    soBasis4: 'லாப இழப்பு = காலி நாட்கள் × ஒரு நாளின் சாதாரண விற்பனை × ஒன்றின் லாபம். லாபம் இல்லாத பொருட்கள் விடப்படும்.',
    colDaysEmpty: 'காலி நாட்கள்', colNormal: 'ஒரு நாளின் சாதாரண விற்பனை', colLostSales: 'இழந்த விற்பனை (மதிப்பீடு)', colLostMargin: 'இழந்த லாபம் (மதிப்பீடு)', colWhy: 'ஏன் தெரியவில்லை', colOnHand: 'இப்போது கையிருப்பு',
    empty_every_day: 'ஒவ்வொரு நாளும் காலியாக இருந்தது, எனவே சாதாரண விற்பனை தெரியவில்லை.',
    margin_not_held: 'லாபம் தெரியவில்லை (GST விகிதம் இல்லை, எனவே GSTக்கு முந்தைய விற்பனையைக் கணக்கிட முடியாது).',
    nothing_sold_anywhere: 'இந்த நாட்களில் எதுவும் விற்கப்படவில்லை, எனவே லாபம் தெரியவில்லை.',
    soOfDays: 'இல்', workedOut: 'கணக்கிடப்பட்டது',
    tsH: 'பரிந்துரைக்கப்பட்ட இடமாற்றங்கள்', tsLede: 'விற்கும் இடத்தில் தீர்ந்து, நமது மற்றொரு இடத்தில் இருக்கும் பொருட்கள். இது பரிந்துரை மட்டுமே — கீழே ஒருவர் இடமாற்றத்தைத் தொடங்கி, இரண்டாவது நபர் அனுப்பும் வரை எதுவும் நகராது.',
    tsShow: 'பரிந்துரைகளைக் காட்டு', tsNone: 'பரிந்துரை இல்லை: விற்கும் இடத்தில் தீர்ந்து வேறு இடத்தில் இருக்கும் பொருள் எதுவும் இல்லை.',
    tsCannot: 'உங்கள் பங்கு சரக்கைப் பார்ப்பதில்லை.', colNeededAt: 'தேவைப்படும் இடம்', colTakeFrom: 'எடுக்கும் இடம்', colWhere: 'அது எங்கே', colHeld: 'அங்கே இருப்பது', colSold: 'கடந்த 7 நாட்களில் இங்கே விற்றது', colStart: 'தொடங்கு',
    own_back_store: 'இந்தக் கடையின் பின் கிடங்கு', head_office_warehouse: 'தலைமை அலுவலகக் கிடங்கு', another_store: 'மற்றொரு கடை',
    tsStart: 'இந்த இடமாற்றத்தைத் தொடங்கு', tsFilled: 'நிரப்பப்பட்டது: {from} இலிருந்து {to} க்கு, பொருள் {item}. எத்தனை என்று தட்டச்சு செய்து, "இந்தப் பொருளைச் சேர்" அழுத்தி, பிறகு "இந்த இடமாற்றத்தை முன்மொழி". இரண்டாவது நபர் அனுப்புவார்.',
  },
} as const);

export type StockHistoryWord = keyof typeof STOCK_HISTORY_WORDS.en;
export const words = (lang: Lang, k: StockHistoryWord): string => (STOCK_HISTORY_WORDS[lang] ?? STOCK_HISTORY_WORDS.en)[k];
export const fill = (s: string, vars: Readonly<Record<string, string | number>>): string => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A moment's shop date (India time, the shop's clock — OB-607), YYYY-MM-DD; an unreadable moment is said as given. */
export const shopDateOf = (at: string): string => { const t = Date.parse(at); return Number.isFinite(t) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)) : at; };

/** A shop date said as the shop reads it: 19/11/2026. */
export const dayWords = (shopDay: string): string => (DAY.test(shopDay) ? `${shopDay.slice(8, 10)}/${shopDay.slice(5, 7)}/${shopDay.slice(0, 4)}` : shopDay);
/** A share in basis points as a percentage: 9,250 → "92.5%". */
export const percent = (bp: number): string => `${(bp / 100).toFixed(1).replace(/\.0$/, '')}%`;
/** A quantity in the shop's words; a unit not told is a count of pieces. */
export const qty = (minor: number, uom: string | null | undefined, lang: Lang): string => quantityInWords(minor, uom ?? 'ea', lang);

/** The outcome of one read: rows, or why there are none to show. */
export type Read<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'bad_range' }
  | { readonly kind: 'not_permitted' }
  | { readonly kind: 'refused'; readonly whatHappened: string }
  | { readonly kind: 'lost_link' };

const failed = (a: HttpAnswer): Read<never> => (a.result === 'lost_link' ? { kind: 'lost_link' } : { kind: 'refused', whatHappened: a.result === 'refused' ? a.whatHappened || a.code : '' });
const rangeOk = (from: string, to: string): boolean => DAY.test(from) && DAY.test(to) && from <= to;

/** What a failed read says, in the reader's language. */
export function failureWords(lang: Lang, r: Read<unknown>, cannot: StockHistoryWord, viewer: Viewer): string {
  switch (r.kind) {
    case 'bad_range': return words(lang, 'badRange');
    case 'not_permitted': return viewer?.userId === undefined ? words(lang, 'nobody') : words(lang, cannot);
    case 'refused': return `${words(lang, 'refused')} ${r.whatHappened}`;
    case 'lost_link': return words(lang, 'lost');
    default: return '';
  }
}

// ── S2 · earlier write-offs ──────────────────────────────────────────────────────────────────────────────────────

export interface PastWriteOff {
  readonly id: string; readonly documentNumber: string | null; readonly productId: string; readonly locationId: string; readonly lossType: string;
  readonly qtyRemoved: number; readonly uom: string; readonly valueMinor: number; readonly valueStated: boolean; readonly raisedBy: string; readonly approvedBy: string | null; readonly at: string;
  /** The shop's date of it (India time), as head office filters by. */
  readonly shopDate: string;
}
export interface PastWriteOffs {
  readonly from: string; readonly to: string; readonly rows: readonly PastWriteOff[]; readonly count: number; readonly totalLossMinor: number;
  readonly byLossType: Readonly<Record<string, { readonly count: number; readonly valueMinor: number }>>;
}

export function pastWriteOffOf(raw: unknown): PastWriteOff | null {
  if (!isRec(raw) || str(raw['id']) === '') return null;
  return {
    id: str(raw['id']), documentNumber: str(raw['documentNumber']) || null, productId: str(raw['productId']), locationId: str(raw['locationId']),
    lossType: str(raw['lossType']), qtyRemoved: num(raw['qtyRemoved']), uom: str(raw['uom']) || 'ea', valueMinor: Math.abs(num(raw['valueMinor'])),
    valueStated: raw['valueSource'] === 'cost_unknown', raisedBy: str(raw['raisedBy']), approvedBy: typeof raw['approvedBy'] === 'string' ? raw['approvedBy'] : null, at: str(raw['at']), shopDate: shopDateOf(str(raw['at'])),
  };
}

export function createPastWriteOffsSession(viewer: Viewer, http: HeadOfficeHttp) {
  const may = viewer?.userId !== undefined && viewer.permissions.includes('waste.view');
  return {
    may,
    async read(from: string, to: string, productId = ''): Promise<Read<PastWriteOffs>> {
      if (!may) return { kind: 'not_permitted' };
      if (!rangeOk(from, to)) return { kind: 'bad_range' };
      const item = productId.trim();
      const got = await http.get(`/v1/inventory/write-offs?from=${from}&to=${to}${item === '' ? '' : `&productId=${encodeURIComponent(item)}`}`);
      if (got.result !== 'ok') return failed(got);
      const b = isRec(got.body) ? got.body : {};
      const rows = (Array.isArray(b['writeOffs']) ? b['writeOffs'] as unknown[] : []).map(pastWriteOffOf).filter((r): r is PastWriteOff => r !== null)
        .sort((a, c) => (a.at < c.at ? 1 : a.at > c.at ? -1 : 0));
      const byLossType = isRec(b['byLossType']) ? b['byLossType'] as PastWriteOffs['byLossType'] : {};
      return { kind: 'ok', value: { from, to, rows, count: rows.length, totalLossMinor: num(b['totalLossMinor']), byLossType } };
    },
    /** One line per kind of loss that happened: "Damage: 3 · ₹1,200.00". */
    kindLines(lang: Lang, v: PastWriteOffs): readonly string[] {
      return Object.entries(v.byLossType).sort((a, b) => b[1].valueMinor - a[1].valueMinor)
        .map(([k, x]) => `${(STOCK_HISTORY_WORDS.en as Record<string, string>)[k] === undefined ? k : words(lang, k as StockHistoryWord)}: ${x.count} · ${rupees(x.valueMinor)}`);
    },
    kindWord: (lang: Lang, lossType: string): string => ((STOCK_HISTORY_WORDS.en as Record<string, string>)[lossType] === undefined ? lossType : words(lang, lossType as StockHistoryWord)),
  };
}

// ── S3 · earlier counts and count accuracy ───────────────────────────────────────────────────────────────────────

export interface PastCount {
  readonly countId: string; readonly documentNumber: string | null; readonly productId: string; readonly locationId: string; readonly shopDate: string;
  readonly expectedMinor: number; readonly countedMinor: number; readonly varianceMinor: number; readonly valueMinor: number | null; readonly uom: string | null;
  readonly requiredApproval: boolean; readonly counterId: string; readonly approvedBy: string | null;
}
export interface CountAccuracyView {
  readonly counts: number; readonly matched: number; readonly short: number; readonly over: number; readonly exactBp: number | null; readonly unitsBp: number | null;
  readonly shortValueMinor: number; readonly overValueMinor: number; readonly withoutValue: number;
}
export interface CountHistory { readonly from: string; readonly to: string; readonly rows: readonly PastCount[]; readonly accuracy: CountAccuracyView; readonly uoms: Readonly<Record<string, string>> }

export function pastCountOf(raw: unknown): PastCount | null {
  if (!isRec(raw) || str(raw['countId']) === '') return null;
  return {
    countId: str(raw['countId']), documentNumber: str(raw['documentNumber']) || null, productId: str(raw['productId']), locationId: str(raw['locationId']), shopDate: str(raw['shopDate']),
    expectedMinor: num(raw['expectedMinor']), countedMinor: num(raw['countedMinor']), varianceMinor: num(raw['varianceMinor']),
    valueMinor: typeof raw['valueMinor'] === 'number' ? raw['valueMinor'] : null, uom: typeof raw['uom'] === 'string' ? raw['uom'] : null,
    requiredApproval: raw['requiredApproval'] === true, counterId: str(raw['counterId']), approvedBy: typeof raw['approvedBy'] === 'string' ? raw['approvedBy'] : null,
  };
}

export function createCountHistorySession(viewer: Viewer, http: HeadOfficeHttp) {
  const may = viewer?.userId !== undefined && viewer.permissions.includes('count.view');
  return {
    may,
    async read(from: string, to: string): Promise<Read<CountHistory>> {
      if (!may) return { kind: 'not_permitted' };
      if (!rangeOk(from, to)) return { kind: 'bad_range' };
      const got = await http.get(`/v1/inventory/count-history?from=${from}&to=${to}`);
      if (got.result !== 'ok') return failed(got);
      const b = isRec(got.body) ? got.body : {};
      const rows = (Array.isArray(b['counts']) ? b['counts'] as unknown[] : []).map(pastCountOf).filter((r): r is PastCount => r !== null);
      const a = isRec(b['accuracy']) ? b['accuracy'] : {};
      const share = (v: unknown): number | null => (typeof v === 'number' ? v : null);
      return {
        kind: 'ok',
        value: {
          from, to, rows, uoms: isRec(b['productUoms']) ? b['productUoms'] as Record<string, string> : {},
          accuracy: { counts: num(a['counts']), matched: num(a['matched']), short: num(a['short']), over: num(a['over']), exactBp: share(a['exactBp']), unitsBp: share(a['unitsBp']), shortValueMinor: num(a['shortValueMinor']), overValueMinor: num(a['overValueMinor']), withoutValue: num(a['withoutValue']) },
        },
      };
    },
    /** The accuracy as summary cards' figures — a share that cannot be stated is "Not known", never 0%. */
    cards(lang: Lang, a: CountAccuracyView): readonly { readonly key: string; readonly label: string; readonly value: string; readonly note?: string }[] {
      const w = (k: StockHistoryWord): string => words(lang, k);
      return [
        { key: 'counts', label: w('chCounts'), value: String(a.counts) },
        { key: 'exact', label: w('chExact'), value: a.exactBp === null ? w('notKnown') : percent(a.exactBp), note: `${a.matched} ${w('chOf')} ${a.counts}` },
        { key: 'units', label: w('chUnits'), value: a.unitsBp === null ? w('notKnown') : percent(a.unitsBp) },
        { key: 'short', label: w('chShort'), value: rupees(a.shortValueMinor), ...(a.withoutValue > 0 ? { note: `${a.withoutValue} ${w('chWithoutValue')}` } : {}) },
        { key: 'over', label: w('chOver'), value: rupees(a.overValueMinor) },
      ];
    },
    direction: (lang: Lang, c: PastCount): string => words(lang, c.varianceMinor === 0 ? 'matched' : c.varianceMinor < 0 ? 'short' : 'over'),
    difference: (lang: Lang, c: PastCount, uom: string | null): string => `${c.varianceMinor > 0 ? '+' : ''}${qty(c.varianceMinor, uom, lang)}`,
  };
}

// ── S4 · what the empty shelves cost ─────────────────────────────────────────────────────────────────────────────

export interface StockoutRowView {
  readonly productId: string; readonly locationId: string; readonly daysCarried: number; readonly daysEmpty: number; readonly onHandNowMinor: number;
  readonly normalDailyMinor: number | null; readonly lostUnitsMinor: number | null; readonly lostMarginMinor: number | null; readonly notKnownBecause: string | null;
}
export interface StockoutView { readonly from: string; readonly to: string; readonly days: number; readonly rows: readonly StockoutRowView[]; readonly knownLostMarginMinor: number; readonly notKnownCount: number; readonly uoms: Readonly<Record<string, string>> }
export const STOCKOUT_PERIODS = [7, 14, 28, 60, 90] as const;

export function createStockoutSession(viewer: Viewer, http: HeadOfficeHttp) {
  const may = viewer?.userId !== undefined && viewer.permissions.includes('inventory.availability.read');
  return {
    may,
    async read(days = 28): Promise<Read<StockoutView>> {
      if (!may) return { kind: 'not_permitted' };
      const got = await http.get(`/v1/inventory/stockout-estimate?days=${days}`);
      if (got.result !== 'ok') return failed(got);
      const b = isRec(got.body) ? got.body : {};
      const nullable = (v: unknown): number | null => (typeof v === 'number' ? v : null);
      const rows = (Array.isArray(b['rows']) ? b['rows'] as unknown[] : []).filter(isRec).map((r): StockoutRowView => ({
        productId: str(r['productId']), locationId: str(r['locationId']), daysCarried: num(r['daysCarried']), daysEmpty: num(r['daysEmpty']), onHandNowMinor: num(r['onHandNowMinor']),
        normalDailyMinor: nullable(r['normalDailyMinor']), lostUnitsMinor: nullable(r['lostUnitsMinor']), lostMarginMinor: nullable(r['lostMarginMinor']),
        notKnownBecause: typeof r['notKnownBecause'] === 'string' ? r['notKnownBecause'] : null,
      }));
      return { kind: 'ok', value: { from: str(b['from']), to: str(b['to']), days: num(b['days']), rows, knownLostMarginMinor: num(b['knownLostMarginMinor']), notKnownCount: num(b['notKnownCount']), uoms: isRec(b['productUoms']) ? b['productUoms'] as Record<string, string> : {} } };
    },
    /** A row's figures in words — "Not known" where head office could not work it out, with the reason. */
    rowWords(lang: Lang, r: StockoutRowView, uom: string | null) {
      const nk = words(lang, 'notKnown');
      return {
        daysEmpty: `${r.daysEmpty} ${words(lang, 'soOfDays')} ${r.daysCarried}`,
        normal: r.normalDailyMinor === null ? nk : qty(r.normalDailyMinor, uom, lang),
        lostSales: r.lostUnitsMinor === null ? nk : qty(r.lostUnitsMinor, uom, lang),
        lostMargin: r.lostMarginMinor === null ? nk : rupees(r.lostMarginMinor),
        why: r.notKnownBecause === null ? words(lang, 'workedOut') : (STOCK_HISTORY_WORDS.en as Record<string, string>)[r.notKnownBecause] === undefined ? r.notKnownBecause : words(lang, r.notKnownBecause as StockHistoryWord),
        onHand: qty(r.onHandNowMinor, uom, lang),
      };
    },
    /** The total and the count not worked out — never one figure that hides the gaps. */
    cards(lang: Lang, v: StockoutView) {
      return [
        { key: 'lost', label: words(lang, 'soTotal'), value: rupees(v.knownLostMarginMinor) },
        { key: 'notKnown', label: words(lang, 'soNotKnown'), value: String(v.notKnownCount) },
      ];
    },
    basis: (lang: Lang): readonly string[] => (['soBasis1', 'soBasis2', 'soBasis3', 'soBasis4'] as const).map((k) => words(lang, k)),
  };
}

// ── S5 · suggested transfers ─────────────────────────────────────────────────────────────────────────────────────

export interface TransferSuggestionView {
  readonly productId: string; readonly toLocationId: string; readonly fromLocationId: string; readonly fromKind: string;
  readonly heldAtSourceMinor: number; readonly onHandHereMinor: number; readonly soldHereLast7DaysMinor: number;
}

export function createTransferSuggestionsSession(viewer: Viewer, http: HeadOfficeHttp) {
  // The same read the Transfers page holds; STARTING a transfer needs its own right, checked by head office as before.
  const may = viewer?.userId !== undefined && viewer.permissions.includes('inventory.availability.read');
  return {
    may,
    async read(): Promise<Read<{ readonly rows: readonly TransferSuggestionView[]; readonly uoms: Readonly<Record<string, string>> }>> {
      if (!may) return { kind: 'not_permitted' };
      const got = await http.get('/v1/inventory/transfer-suggestions');
      if (got.result !== 'ok') return failed(got);
      const b = isRec(got.body) ? got.body : {};
      const rows = (Array.isArray(b['suggestions']) ? b['suggestions'] as unknown[] : []).filter(isRec).map((r): TransferSuggestionView => ({
        productId: str(r['productId']), toLocationId: str(r['toLocationId']), fromLocationId: str(r['fromLocationId']), fromKind: str(r['fromKind']),
        heldAtSourceMinor: num(r['heldAtSourceMinor']), onHandHereMinor: num(r['onHandHereMinor']), soldHereLast7DaysMinor: num(r['soldHereLast7DaysMinor']),
      })).filter((r) => r.productId !== '' && r.toLocationId !== '' && r.fromLocationId !== '');
      return { kind: 'ok', value: { rows, uoms: isRec(b['productUoms']) ? b['productUoms'] as Record<string, string> : {} } };
    },
    whereWord: (lang: Lang, kind: string): string => ((STOCK_HISTORY_WORDS.en as Record<string, string>)[kind] === undefined ? kind : words(lang, kind as StockHistoryWord)),
    /**
     * What "Start this transfer" puts in the Start-a-transfer form: from, to and the item — never a quantity (no transfer
     * level is stored; how many is the person's decision) and never a send. Nothing is sent by this.
     */
    startForm: (r: TransferSuggestionView): { readonly fromLocationId: string; readonly toLocationId: string; readonly productId: string; readonly uom: string } =>
      ({ fromLocationId: r.fromLocationId, toLocationId: r.toLocationId, productId: r.productId, uom: '' }),
  };
}
