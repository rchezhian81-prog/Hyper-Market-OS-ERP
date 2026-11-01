// TAX RATES — the panel on the Products and prices page where the person who keeps the catalogue records the GST rate and
// the compensation cess an HSN code attracts FROM A DATE, and reads its schedule (M03-FR-03 tax side · A6 · A7 · P-08).
//
// A THIN client over head office's own routes, every rule theirs:
//   • `GET /v1/catalogue/tax-classes/:hsnCode/rates` and `…/cess` — the effective-dated schedules (`catalogue.pack.read`);
//   • `POST /v1/catalogue/tax-classes/:hsnCode/rates/:effectiveFrom` { rateBps } — `catalogue.pack.publish`. The FIRST rate
//     of an HSN is setting it up; a CHANGE (a class that already has a rate) is refused `tax_change_needs_finance_approval`
//     unless it names an approval (M03.md §28 "tax change with Finance approval", OB-288 P2): the person asks on head
//     office's maker-checker engine (`POST /v1/approvals/requests`, kind `tax_rate_change`, subject the HSN, details EXACTLY
//     what the change will send: { rateBps, hsnCode, effectiveFrom }); a Finance approver (`catalogue.tax.approve`: the
//     accountant or the owner — never the person asking) approves it on their own Approvals page; then the change is sent
//     naming that approval. Nobody's name is typed here;
//   • `POST /v1/catalogue/tax-classes/:hsnCode/cess/:effectiveFrom` { advaloremBps, specificPerQuantityMinor, perQuantity }
//     — `catalogue.pack.publish`; head office asks for no second person on a cess, and neither does this panel.
// Append-only (hard rule #2): a change is a new period from a later date; head office refuses a different rate on a date
// that already has one, and the refusal is shown in its own words. Head office unreachable → "nothing was saved".

import { translator, type BilingualCopy, type Lang } from '../../../packages/ui/src/index';
import { outcomeOf, paiseOf, rupees, type HttpAnswer, type Outcome } from './finance-close-session';

export interface TaxRateHttp {
  get(path: string): Promise<HttpAnswer>;
  post(path: string, body: unknown): Promise<HttpAnswer>;
}

export const TAX_RATE_PERMISSIONS = Object.freeze({ read: 'catalogue.pack.read', set: 'catalogue.pack.publish' });
export const TAX_RATE_APPROVAL_KIND = 'tax_rate_change';
/** Head office's own code for "this is a change and needs a Finance approver" — the panel then offers to ask. */
export const NEEDS_FINANCE_APPROVAL = 'tax_change_needs_finance_approval';

export interface GstPeriod { readonly effectiveFrom: string; readonly rateBps: number }
export interface CessPeriod { readonly effectiveFrom: string; readonly advaloremBps: number; readonly specificPerQuantityMinor: number; readonly perQuantity: number }
export interface TaxSchedule { readonly hsnCode: string; readonly gst: readonly GstPeriod[]; readonly cess: readonly CessPeriod[] }

/** One tax-change request this person asked for, as head office's inbox gives it back. */
export interface TaxChangeRequest {
  readonly requestId: string;
  readonly kind: string;
  readonly subjectRef: string;
  readonly status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';
  readonly details: { readonly rateBps: number; readonly hsnCode: string; readonly effectiveFrom: string };
  readonly decidedBy?: string;
  readonly decisionReason?: string;
  readonly requestedAt: string;
}

export interface GstInput { readonly hsnCode: string; readonly effectiveFrom: string; readonly ratePercent: string }
export interface CessInput {
  readonly hsnCode: string; readonly effectiveFrom: string;
  readonly advaloremPercent: string; readonly specificRupees: string; readonly perQuantity: string;
}

export type TaxRateCopyKey =
  | 'tab' | 'h' | 'lede' | 'hsn' | 'show' | 'gstH' | 'cessH' | 'noGst' | 'noCess' | 'gstLine' | 'cessLine' | 'cessAdvOnly' | 'cessEnds'
  | 'setGstH' | 'from' | 'ratePercent' | 'saveGst' | 'askH' | 'reason' | 'ask' | 'asked' | 'mineH' | 'noMine'
  | 'reqWaiting' | 'reqApproved' | 'reqRejected' | 'reqUsed' | 'reqExpired' | 'useApproved'
  | 'setCessH' | 'advalorem' | 'specific' | 'perQuantity' | 'saveCess'
  | 'gstSaved' | 'gstChanged' | 'cessSaved' | 'refused' | 'unreachable' | 'unreadable' | 'notAllowed' | 'cannotRead' | 'readOnly'
  | 'needHsn' | 'needGst' | 'needCess' | 'needReason' | 'notConnected' | 'nextPack' | 'whoApproves';

export const TAX_RATE_COPY: BilingualCopy<TaxRateCopyKey> = {
  en: {
    tab: 'Tax rates', h: 'GST and cess by HSN code',
    lede: 'The GST rate and the compensation cess an HSN code carries, each from a date. A change is a new rate from a later date — the old one stays on record. The first rate of an HSN code is setting it up; changing it needs a Finance approver (the accountant or the owner), never the person asking.',
    hsn: 'HSN code', show: 'Show the schedule', gstH: 'GST rates on record', cessH: 'Compensation cess on record',
    noGst: 'No GST rate is recorded for this HSN code — a product with it cannot be priced at the tills.', noCess: 'No compensation cess is recorded for this HSN code.',
    gstLine: 'GST {rate}% from {from}', cessLine: 'Cess {rate}% plus {specific} per {block} from {from}', cessAdvOnly: 'Cess {rate}% from {from}', cessEnds: 'No cess from {from}',
    setGstH: 'Record a GST rate', from: 'From (date)', ratePercent: 'GST rate (%)', saveGst: 'Save this rate at head office',
    askH: 'Changing a rate already on record', reason: 'Why the rate changes (the approver reads this)', ask: 'Ask Finance to approve this change',
    asked: 'Asked. A Finance approver (the accountant or the owner) decides it on their Approvals page; once approved, press “Save the approved change” below. Nothing was changed yet.',
    mineH: 'Your rate-change requests for this HSN code', noMine: 'You have asked for no change to this HSN code.',
    reqWaiting: '{rate}% from {from} — waiting for a Finance approver', reqApproved: '{rate}% from {from} — approved by {by}', reqRejected: '{rate}% from {from} — refused by {by}: {why}',
    reqUsed: '{rate}% from {from} — approved and saved', reqExpired: '{rate}% from {from} — the approval ran out; ask again', useApproved: 'Save the approved change',
    setCessH: 'Record a compensation cess', advalorem: 'Cess on the value (%)', specific: 'Fixed cess (₹ per block, 0 for none)', perQuantity: 'Block size (e.g. 1000 sticks; 1 for each)',
    saveCess: 'Save this cess at head office',
    gstSaved: 'Saved at head office. The tills charge it from that date after the next price update.',
    gstChanged: 'Saved at head office with the approval of {by}. The tills charge it from that date after the next price update.',
    cessSaved: 'Saved at head office. The tills charge it from that date after the next price update.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was saved. Try again when the connection is back.',
    unreadable: 'Head office cannot be reached — the schedule could not be read, so none is shown.',
    notAllowed: 'Your role cannot record tax rates.', cannotRead: 'Your role cannot read the tax rates.',
    readOnly: 'You can read the tax rates; recording one needs the catalogue role. A Finance approver approves changes on the Approvals page.',
    needHsn: 'Write the HSN code first.', needGst: 'Give the date and the GST rate as a number (for example 5, 12 or 18).',
    needCess: 'Give the date, the cess on the value as a number, the fixed cess in rupees (0 for none) and a whole block size.',
    needReason: 'Write why the rate changes, then ask again. Nothing was sent.',
    notConnected: 'Tax rates are kept at head office. Open Products and prices from head office to see or record them.',
    nextPack: 'A rate reaches the tills with the next signed price update.',
    whoApproves: 'The accountant or the owner approves it — never you.',
  },
  ta: {
    tab: 'வரி விகிதங்கள்', h: 'HSN குறியீடு வாரியாக ஜிஎஸ்டியும் செஸ்ஸும்',
    lede: 'ஒரு HSN குறியீட்டுக்கான ஜிஎஸ்டி விகிதமும் இழப்பீட்டு செஸ்ஸும், ஒவ்வொன்றும் ஒரு தேதியிலிருந்து. மாற்றம் என்பது பிந்தைய தேதியிலிருந்து ஒரு புதிய விகிதம் — பழையது பதிவில் இருக்கும். ஒரு HSN குறியீட்டின் முதல் விகிதம் அதை அமைப்பது; அதை மாற்ற நிதி ஒப்புதலாளர் (கணக்காளர் அல்லது உரிமையாளர்) தேவை, கேட்பவர் ஒருபோதும் இல்லை.',
    hsn: 'HSN குறியீடு', show: 'அட்டவணையைக் காட்டு', gstH: 'பதிவில் உள்ள ஜிஎஸ்டி விகிதங்கள்', cessH: 'பதிவில் உள்ள இழப்பீட்டு செஸ்',
    noGst: 'இந்த HSN குறியீட்டுக்கு ஜிஎஸ்டி விகிதம் பதிவில் இல்லை — இதைக் கொண்ட பொருளுக்கு பில் இயந்திரங்களில் விலை வைக்க முடியாது.', noCess: 'இந்த HSN குறியீட்டுக்கு இழப்பீட்டு செஸ் பதிவில் இல்லை.',
    gstLine: '{from} முதல் ஜிஎஸ்டி {rate}%', cessLine: '{from} முதல் செஸ் {rate}% மற்றும் ஒவ்வொரு {block}-க்கும் {specific}', cessAdvOnly: '{from} முதல் செஸ் {rate}%', cessEnds: '{from} முதல் செஸ் இல்லை',
    setGstH: 'ஜிஎஸ்டி விகிதத்தைப் பதிவு செய்', from: 'தொடங்கும் தேதி', ratePercent: 'ஜிஎஸ்டி விகிதம் (%)', saveGst: 'இந்த விகிதத்தைத் தலைமை அலுவலகத்தில் சேமி',
    askH: 'ஏற்கனவே பதிவில் உள்ள விகிதத்தை மாற்றுதல்', reason: 'விகிதம் ஏன் மாறுகிறது (ஒப்புதலாளர் இதைப் படிப்பார்)', ask: 'இந்த மாற்றத்துக்கு நிதி ஒப்புதல் கேள்',
    asked: 'கேட்கப்பட்டது. நிதி ஒப்புதலாளர் (கணக்காளர் அல்லது உரிமையாளர்) தங்கள் ஒப்புதல்கள் பக்கத்தில் முடிவு செய்வார்; ஒப்புதல் கிடைத்ததும் கீழே “ஒப்புதல் பெற்ற மாற்றத்தைச் சேமி” அழுத்தவும். இன்னும் எதுவும் மாற்றப்படவில்லை.',
    mineH: 'இந்த HSN குறியீட்டுக்கு நீங்கள் கேட்ட விகித மாற்றங்கள்', noMine: 'இந்த HSN குறியீட்டுக்கு நீங்கள் எந்த மாற்றமும் கேட்கவில்லை.',
    reqWaiting: '{from} முதல் {rate}% — நிதி ஒப்புதலாளருக்காகக் காத்திருக்கிறது', reqApproved: '{from} முதல் {rate}% — {by} ஒப்புதல் அளித்தார்', reqRejected: '{from} முதல் {rate}% — {by} மறுத்தார்: {why}',
    reqUsed: '{from} முதல் {rate}% — ஒப்புதல் பெற்றுச் சேமிக்கப்பட்டது', reqExpired: '{from} முதல் {rate}% — ஒப்புதலின் காலம் முடிந்தது; மீண்டும் கேளுங்கள்', useApproved: 'ஒப்புதல் பெற்ற மாற்றத்தைச் சேமி',
    setCessH: 'இழப்பீட்டு செஸ்ஸைப் பதிவு செய்', advalorem: 'மதிப்பின் மீது செஸ் (%)', specific: 'நிலையான செஸ் (ஒரு தொகுதிக்கு ₹, இல்லையெனில் 0)', perQuantity: 'தொகுதி அளவு (எ.கா. 1000 குச்சிகள்; ஒவ்வொன்றுக்கும் 1)',
    saveCess: 'இந்த செஸ்ஸைத் தலைமை அலுவலகத்தில் சேமி',
    gstSaved: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது. அடுத்த விலை புதுப்பிப்புக்குப் பிறகு பில் இயந்திரங்கள் அந்தத் தேதியிலிருந்து இதை வசூலிக்கும்.',
    gstChanged: '{by} அவர்களின் ஒப்புதலுடன் தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது. அடுத்த விலை புதுப்பிப்புக்குப் பிறகு பில் இயந்திரங்கள் அந்தத் தேதியிலிருந்து இதை வசூலிக்கும்.',
    cessSaved: 'தலைமை அலுவலகத்தில் சேமிக்கப்பட்டது. அடுத்த விலை புதுப்பிப்புக்குப் பிறகு பில் இயந்திரங்கள் அந்தத் தேதியிலிருந்து செஸ்ஸை வசூலிக்கும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் சேமிக்கப்படவில்லை. இணைப்பு திரும்பியதும் மீண்டும் முயலுங்கள்.',
    unreadable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — அட்டவணையைப் படிக்க முடியவில்லை, அதனால் எதுவும் காட்டப்படவில்லை.',
    notAllowed: 'உங்கள் பங்கால் வரி விகிதங்களைப் பதிவு செய்ய முடியாது.', cannotRead: 'உங்கள் பங்கால் வரி விகிதங்களைப் படிக்க முடியாது.',
    readOnly: 'நீங்கள் வரி விகிதங்களைப் படிக்கலாம்; பதிவு செய்ய அட்டவணைப் பங்கு தேவை. நிதி ஒப்புதலாளர் மாற்றங்களை ஒப்புதல்கள் பக்கத்தில் அங்கீகரிப்பார்.',
    needHsn: 'முதலில் HSN குறியீட்டை எழுதுங்கள்.', needGst: 'தேதியையும் ஜிஎஸ்டி விகிதத்தையும் எண்ணாகக் கொடுங்கள் (எ.கா. 5, 12 அல்லது 18).',
    needCess: 'தேதி, மதிப்பின் மீதான செஸ் (எண்), நிலையான செஸ் ரூபாயில் (இல்லையெனில் 0), முழு எண் தொகுதி அளவு ஆகியவற்றைக் கொடுங்கள்.',
    needReason: 'விகிதம் ஏன் மாறுகிறது என்று எழுதி, மீண்டும் கேளுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    notConnected: 'வரி விகிதங்கள் தலைமை அலுவலகத்தில் வைக்கப்படுகின்றன. அவற்றைப் பார்க்க அல்லது பதிவு செய்ய, தலைமை அலுவலகத்திலிருந்து பொருட்களும் விலைகளும் திரையைத் திறக்கவும்.',
    nextPack: 'ஒரு விகிதம் அடுத்த கையொப்பமிட்ட விலை புதுப்பிப்புடன் பில் இயந்திரங்களைச் சென்றடையும்.',
    whoApproves: 'கணக்காளர் அல்லது உரிமையாளர் இதை அங்கீகரிப்பார் — நீங்கள் ஒருபோதும் இல்லை.',
  },
};
export const TAX_RATE_COPY_KEYS: readonly TaxRateCopyKey[] = Object.freeze(Object.keys(TAX_RATE_COPY.en) as TaxRateCopyKey[]);

export function taxRateWords(lang: Lang): (key: TaxRateCopyKey, fill?: Readonly<Record<string, string | number>>) => string {
  const t = translator(TAX_RATE_COPY, lang);
  return (key, fill) => Object.entries(fill ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));
}

/** A percentage a person typed ("18", "12.5", "0.25") as whole basis points; undefined when it is not one. Pure. */
export function bpsOf(text: string): number | undefined {
  const s = String(text).trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return undefined;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

/** Basis points as a percentage in words: 1800 → "18", 1250 → "12.5", 25 → "0.25". Pure. */
export function percentOf(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return frac === '' ? String(whole) : `${whole}.${frac}`;
}

const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));

export function gstLine(lang: Lang, p: GstPeriod): string {
  return taxRateWords(lang)('gstLine', { rate: percentOf(p.rateBps), from: p.effectiveFrom });
}
export function cessLine(lang: Lang, p: CessPeriod): string {
  const w = taxRateWords(lang);
  if (p.advaloremBps === 0 && p.specificPerQuantityMinor === 0) return w('cessEnds', { from: p.effectiveFrom });
  if (p.specificPerQuantityMinor === 0) return w('cessAdvOnly', { rate: percentOf(p.advaloremBps), from: p.effectiveFrom });
  return w('cessLine', { rate: percentOf(p.advaloremBps), specific: rupees(p.specificPerQuantityMinor), block: p.perQuantity, from: p.effectiveFrom });
}
export function requestLine(lang: Lang, r: TaxChangeRequest): string {
  const w = taxRateWords(lang);
  const fill = { rate: percentOf(r.details.rateBps), from: r.details.effectiveFrom, by: r.decidedBy ?? '', why: r.decisionReason ?? '' };
  switch (r.status) {
    case 'waiting': return w('reqWaiting', fill);
    case 'approved': return w('reqApproved', fill);
    case 'rejected': return w('reqRejected', fill);
    case 'used': return w('reqUsed', fill);
    case 'expired': return w('reqExpired', fill);
  }
}

/** Every outcome in the reader's language; a refusal in head office's own words. `invalid` names what is missing. */
export function taxOutcomeWords(lang: Lang, o: Outcome<{ approvedBy?: string; cess?: unknown; requestId?: string }>, saved: 'gst' | 'cess' | 'ask'): { readonly ok: boolean; readonly text: string } {
  const w = taxRateWords(lang);
  switch (o.kind) {
    case 'done':
      if (saved === 'ask') return { ok: true, text: w('asked') };
      if (saved === 'cess') return { ok: true, text: w('cessSaved') };
      return { ok: true, text: o.body.approvedBy === undefined ? w('gstSaved') : w('gstChanged', { by: o.body.approvedBy }) };
    case 'refused': return { ok: false, text: `${w('refused')} ${o.whatHappened}${o.nextSafeAction === '' ? '' : ` ${o.nextSafeAction}`}` };
    case 'not_allowed': return { ok: false, text: w('notAllowed') };
    case 'invalid': return { ok: false, text: w(o.detail === 'hsn' ? 'needHsn' : o.detail === 'reason' ? 'needReason' : o.detail === 'cess' ? 'needCess' : 'needGst') };
    case 'unreachable': return { ok: false, text: w('unreachable') };
  }
}

export interface TaxRatesSession {
  readonly may: { readonly read: boolean; readonly set: boolean };
  /** The GST and cess schedules for one HSN code (both read; the first failure is the answer). */
  schedule(hsnCode: string): Promise<Outcome<TaxSchedule>>;
  /** This person's own tax-change requests for the HSN code, newest first (only someone who may record rates asks). */
  myRequests(hsnCode: string): Promise<Outcome<readonly TaxChangeRequest[]>>;
  /** Record a GST rate from a date. A change without an approval is refused by head office, in its words. */
  setGst(input: GstInput): Promise<Outcome<{ readonly rate: GstPeriod; readonly approvedBy?: string }>>;
  /** Ask a Finance approver for exactly this change (the details the change will send). A reason is needed. */
  askGstChange(input: GstInput & { readonly reason: string }): Promise<Outcome<{ readonly requestId: string }>>;
  /** Send an approved change, naming its approval; the rate and the date are the approved ones, never retyped. */
  saveApprovedGst(request: TaxChangeRequest): Promise<Outcome<{ readonly rate: GstPeriod; readonly approvedBy?: string }>>;
  setCess(input: CessInput): Promise<Outcome<{ readonly cess: CessPeriod }>>;
}

export function createTaxRatesSession(viewer: { readonly permissions: readonly string[] }, http: TaxRateHttp): TaxRatesSession {
  const held = new Set(viewer.permissions);
  const may = Object.freeze({ read: held.has(TAX_RATE_PERMISSIONS.read), set: held.has(TAX_RATE_PERMISSIONS.set) });
  const hsnPath = (hsn: string): string => `/v1/catalogue/tax-classes/${encodeURIComponent(hsn.trim())}`;
  /** The GST change body, read from what the person typed — the same object the approval's details are built from. */
  const gstOf = (input: GstInput): { hsnCode: string; effectiveFrom: string; rateBps: number } | 'hsn' | 'gst' => {
    const hsnCode = input.hsnCode.trim();
    const effectiveFrom = input.effectiveFrom.trim();
    const rateBps = bpsOf(input.ratePercent);
    if (hsnCode === '') return 'hsn';
    if (!isDate(effectiveFrom) || rateBps === undefined) return 'gst';
    return { hsnCode, effectiveFrom, rateBps };
  };
  const notAllowed = { kind: 'not_allowed', needs: TAX_RATE_PERMISSIONS.set } as const;
  return {
    may,
    schedule: async (hsnCode) => {
      if (!may.read) return { kind: 'not_allowed', needs: TAX_RATE_PERMISSIONS.read };
      if (hsnCode.trim() === '') return { kind: 'invalid', detail: 'hsn' };
      const gst = outcomeOf<{ schedule?: GstPeriod[] }>(await http.get(`${hsnPath(hsnCode)}/rates`));
      if (gst.kind !== 'done') return gst;
      const cess = outcomeOf<{ schedule?: CessPeriod[] }>(await http.get(`${hsnPath(hsnCode)}/cess`));
      if (cess.kind !== 'done') return cess;
      return { kind: 'done', status: 200, body: { hsnCode: hsnCode.trim(), gst: gst.body.schedule ?? [], cess: cess.body.schedule ?? [] } };
    },
    myRequests: async (hsnCode) => {
      if (!may.set) return notAllowed;
      const inbox = outcomeOf<{ mine?: TaxChangeRequest[] }>(await http.get('/v1/approvals/requests'));
      if (inbox.kind !== 'done') return inbox;
      const mine = (inbox.body.mine ?? []).filter((r) => r.kind === TAX_RATE_APPROVAL_KIND && r.subjectRef === hsnCode.trim())
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      return { kind: 'done', status: 200, body: mine };
    },
    setGst: async (input) => {
      if (!may.set) return notAllowed;
      const g = gstOf(input);
      if (typeof g === 'string') return { kind: 'invalid', detail: g };
      return outcomeOf(await http.post(`${hsnPath(g.hsnCode)}/rates/${encodeURIComponent(g.effectiveFrom)}`, { rateBps: g.rateBps }));
    },
    askGstChange: async (input) => {
      if (!may.set) return notAllowed;
      const g = gstOf(input);
      if (typeof g === 'string') return { kind: 'invalid', detail: g };
      const reason = input.reason.trim();
      if (reason === '') return { kind: 'invalid', detail: 'reason' };
      // The details are EXACTLY what the change will send ({ rateBps }) plus the route's path ids — head office fingerprints them.
      return outcomeOf(await http.post('/v1/approvals/requests', {
        kind: TAX_RATE_APPROVAL_KIND, subjectRef: g.hsnCode, valueMinor: null,
        details: { rateBps: g.rateBps, hsnCode: g.hsnCode, effectiveFrom: g.effectiveFrom },
        summary: `HSN ${g.hsnCode}: GST ${percentOf(g.rateBps)}% from ${g.effectiveFrom}`, reason: reason.slice(0, 300),
      }));
    },
    saveApprovedGst: async (request) => {
      if (!may.set) return notAllowed;
      const { hsnCode, effectiveFrom, rateBps } = request.details;
      return outcomeOf(await http.post(`${hsnPath(hsnCode)}/rates/${encodeURIComponent(effectiveFrom)}`, { rateBps, approvalId: request.requestId }));
    },
    setCess: async (input) => {
      if (!may.set) return notAllowed;
      const hsnCode = input.hsnCode.trim();
      if (hsnCode === '') return { kind: 'invalid', detail: 'hsn' };
      const effectiveFrom = input.effectiveFrom.trim();
      const advaloremBps = bpsOf(input.advaloremPercent);
      const specific = input.specificRupees.trim() === '' ? 0 : paiseOf(input.specificRupees);
      const block = /^\s*\d+\s*$/.test(input.perQuantity) ? Number(input.perQuantity.trim()) : input.perQuantity.trim() === '' ? 1 : undefined;
      if (!isDate(effectiveFrom) || advaloremBps === undefined || specific === null || block === undefined || block < 1) return { kind: 'invalid', detail: 'cess' };
      return outcomeOf(await http.post(`${hsnPath(hsnCode)}/cess/${encodeURIComponent(effectiveFrom)}`, { advaloremBps, specificPerQuantityMinor: specific, perQuantity: block }));
    },
  };
}
