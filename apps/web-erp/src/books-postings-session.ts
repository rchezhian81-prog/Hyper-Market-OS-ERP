// Month-end · "Into the books" and "For the CA" (W5 · M23-FR-01 "every operational event maps to a journal or an exception" ·
// M23-FR-04 "control totals must validate before period close … a CA can sign the control totals" · D10-FR-01 "cost/profit
// centres tie to the ledger" · D09-FR-06 · D02-FR-06 · M22-FR-02 · P-08 · hard rule #2) — a tested, DOM-free session over
// head-office routes no screen reached:
//
//   INTO THE BOOKS — five registers whose movements reach the books through the accountant's posting map, each read
//   (what is there, what is posted, what is not) and posted by ONE click (head office posts each movement once; a re-run
//   posts nothing twice; what the map cannot post comes back as an exception, said by name, never zero):
//     • business-customer invoices and collections       GET /v1/finance/b2b/postings          POST /v1/finance/b2b/post
//     • count differences and write-offs                 GET /v1/finance/stock-adjustments    POST /v1/finance/stock-adjustments/post
//     • stock confirmed lost (indents, transfers)        GET /v1/finance/stock-losses         POST /v1/finance/stock-losses/post
//     • the shop's own delivery fleet settlements        GET /v1/finance/fleet-settlements    POST /v1/finance/fleet-settlements/post
//     • supplier display funding — each RECEIPT is recorded as it arrived (amount, day, bank reference), refused by head
//       office above what the contract still has outstanding:
//                                                        GET /v1/finance/display-funding      POST /v1/finance/display-funding/:contractId/receipts/:receiptId
//
//   FOR THE CA — the month's independent checks (GET /v1/finance/periods/:period/independent-evidence: each figure from
//   the books against the same figure from outside), the control totals compared (POST …/control-totals) and the pack the CA
//   signs (POST …/evidence-pack) — built from exactly those checks plus any line a person adds from another outside source
//   (the filed return, a counted shelf), each with where both sides came from. Both are reads: nothing is written, no month
//   changes state. And the month's cost and profit centres against the ledger (GET …/centres).
//
// Head office re-checks every permission. Amounts are typed in rupees and sent as paise. Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { signedPaiseOf } from './settlement-bank-session';

export type Lang = 'en' | 'ta';
export type Stream = 'b2b' | 'stock' | 'losses' | 'fleet' | 'display';
export const STREAMS: readonly Stream[] = ['b2b', 'stock', 'losses', 'fleet', 'display'];

export const BOOKS_POSTINGS_COPY = {
  en: {
    tabBooks: 'Into the books', booksH: 'Movements into the books', booksLede: 'Each register below reaches the books through the accountant\'s posting map. Read it to see what is posted and what is not; post puts every movement not yet posted in the books, once. Anything the map cannot post is listed by name — never posted at zero.',
    b2bH: 'Business customer invoices and collections', stockH: 'Count differences and write-offs', lossesH: 'Stock confirmed lost (indents and transfers)', fleetH: 'Own delivery fleet settlements', displayH: 'Supplier display funding',
    read: 'Read', post: 'Post what is not in the books', posted: '{count} entr(ies) put in the books.', nothingPosted: 'Nothing new was posted.', notPosted: 'Not posted: {id} ({reason}) — {detail}',
    inRegister: 'In the register', inBooks: 'In the books', waiting: 'Not yet in the books', valueRegister: 'Value in the register', valueBooks: 'Value in the books', unvalued: 'Cannot be valued (no cost held)',
    isPosted: 'in the books', notYet: 'not yet in the books', noRows: 'Nothing in this register yet.', notConnected: 'No books are connected here.',
    funding: 'Agreed', received: 'Received', outstanding: 'Still to come', ledger: 'In the books', agrees: 'agrees', differs: 'does not agree', unmappedAccount: 'The posting map has no display funding rule yet — not known, not zero.',
    finding_expired_with_money_outstanding: 'ended with money still to come', finding_not_approved_by_finance: 'not approved by finance', finding_ledger_differs: 'the books differ',
    receiptAmount: 'Amount received (₹)', receiptOn: 'Received on', receiptRef: 'Bank or cheque reference', recordReceipt: 'Record this receipt', receiptDone: 'Recorded. Still to come: {left}.', receiptAgain: 'Already recorded — nothing was written twice.',
    tabCa: 'For the CA', caH: 'Evidence for the CA', caLede: 'Each check compares a figure from the books with the same figure from outside the system, reached a different way. The pack the CA signs states both sides of every figure and where each came from. Checking writes nothing and does not close the month.',
    evidence: 'Read the month\'s checks', checksH: 'The month\'s independent checks', left: 'From the books', right: 'From outside', notChecked: 'Not checked', noChecks: 'Nothing was checked this month — there is nothing to compare yet.',
    unsettled: '{count} card or UPI payment(s) the provider never settled', payoutsMissing: '{count} payout(s) the bank never received', depositsMissing: '{count} cash deposit(s) no bank line answers',
    addLine: 'Add a line from another outside source', lineName: 'What is compared', lineBooks: 'Books figure (₹)', lineOutside: 'Outside figure (₹)', lineMethod: 'Where each side came from',
    cutoff: 'The shop\'s day ends at (as set in the shop\'s settings, HH:MM)',
    checkTotals: 'Compare the control totals', makePack: 'Prepare the CA\'s evidence pack', allAgree: 'Every control total agrees exactly.', someDiffer: 'Some control totals do not agree — see each line.',
    signable: 'Signable', notSignable: 'NOT signable', deadFrom: 'Postings the accounts never received are read from', reconcilesYes: 'agrees', reconcilesNo: 'differs by {diff}',
    centresH: 'Cost and profit centres', centresLede: 'Each branch and department\'s share of the month\'s books, its profit, what is not placed in any centre, and the tie to the ledger.',
    showCentres: 'Read the centres', centre: 'Centre', income: 'Income', expense: 'Expenses', profit: 'Profit', unassigned: 'Not placed in a centre', attributed: 'Placed in a centre', ties: 'The centres add up to the ledger.', noTie: 'The centres do NOT add up to the ledger — a person must look.',
    classesMissing: 'The accountant has not set the account classes, so income and expenses cannot be told apart yet.', journals: 'journals', unknownCentre: 'not in the centre list',
    needMonth: 'Choose the month first.', needLines: 'There is nothing to compare: read the month\'s checks, or add a line.', needLine: 'Each added line needs what is compared, both figures in rupees and where each side came from.', needCutoff: 'Type the time the shop\'s day ends, as HH:MM.',
    needReceipt: 'Type the amount in rupees, the day it arrived and the bank reference.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the books.', cannotPost: 'Your role cannot post to the books.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', reading: 'Reading from head office…',
  },
  ta: {
    tabBooks: 'கணக்குப் புத்தகத்தில்', booksH: 'புத்தகத்தில் சேரும் அசைவுகள்', booksLede: 'கீழே உள்ள ஒவ்வொரு பதிவேடும் கணக்காளரின் பதிவு வரைபடம் மூலம் புத்தகத்தை அடைகிறது. எது பதிந்தது, எது இல்லை என்று பார்க்கப் படிக்கவும்; பதி என்பது இன்னும் பதியாத ஒவ்வொரு அசைவையும் ஒருமுறை புத்தகத்தில் சேர்க்கும். வரைபடம் பதிய முடியாதவை பெயருடன் பட்டியலிடப்படும் — பூஜ்ஜியமாகப் பதியப்படாது.',
    b2bH: 'வணிக வாடிக்கையாளர் விலைப்பட்டியல்களும் வசூலும்', stockH: 'எண்ணிக்கை வேறுபாடுகளும் தள்ளுபடிகளும்', lossesH: 'இழந்ததாக உறுதியான சரக்கு (கோரிக்கைகள், இடமாற்றங்கள்)', fleetH: 'சொந்த விநியோக வாகனத் தீர்வுகள்', displayH: 'சப்ளையர் காட்சி நிதி',
    read: 'படி', post: 'புத்தகத்தில் இல்லாததைப் பதி', posted: '{count} பதிவுகள் புத்தகத்தில் சேர்க்கப்பட்டன.', nothingPosted: 'புதிதாக எதுவும் பதியப்படவில்லை.', notPosted: 'பதியப்படவில்லை: {id} ({reason}) — {detail}',
    inRegister: 'பதிவேட்டில்', inBooks: 'புத்தகத்தில்', waiting: 'இன்னும் புத்தகத்தில் இல்லை', valueRegister: 'பதிவேட்டு மதிப்பு', valueBooks: 'புத்தக மதிப்பு', unvalued: 'மதிப்பிட முடியாது (விலை இல்லை)',
    isPosted: 'புத்தகத்தில் உள்ளது', notYet: 'இன்னும் புத்தகத்தில் இல்லை', noRows: 'இந்தப் பதிவேட்டில் இன்னும் எதுவும் இல்லை.', notConnected: 'இங்கே கணக்குப் புத்தகம் இணைக்கப்படவில்லை.',
    funding: 'ஒப்புக்கொண்டது', received: 'பெற்றது', outstanding: 'இன்னும் வர வேண்டியது', ledger: 'புத்தகத்தில்', agrees: 'பொருந்துகிறது', differs: 'பொருந்தவில்லை', unmappedAccount: 'பதிவு வரைபடத்தில் காட்சி நிதி விதி இன்னும் இல்லை — தெரியவில்லை, பூஜ்ஜியம் அல்ல.',
    finding_expired_with_money_outstanding: 'பணம் வர வேண்டிய நிலையில் முடிந்தது', finding_not_approved_by_finance: 'நிதித்துறை ஒப்புதல் இல்லை', finding_ledger_differs: 'புத்தகம் வேறுபடுகிறது',
    receiptAmount: 'பெற்ற தொகை (₹)', receiptOn: 'பெற்ற நாள்', receiptRef: 'வங்கி அல்லது காசோலை குறிப்பு', recordReceipt: 'இந்த வரவைப் பதி', receiptDone: 'பதியப்பட்டது. இன்னும் வர வேண்டியது: {left}.', receiptAgain: 'ஏற்கனவே பதியப்பட்டது — இருமுறை எழுதப்படவில்லை.',
    tabCa: 'CA-க்காக', caH: 'CA-க்கான சான்று', caLede: 'ஒவ்வொரு சோதனையும் புத்தகத்தின் ஒரு எண்ணை அமைப்புக்கு வெளியிலிருந்து வேறு வழியில் வந்த அதே எண்ணுடன் ஒப்பிடுகிறது. CA கையெழுத்திடும் தொகுப்பு ஒவ்வொரு எண்ணின் இரு பக்கங்களையும் அவை எங்கிருந்து வந்தன என்பதையும் கூறுகிறது. சோதனை எதையும் எழுதாது, மாதத்தை மூடாது.',
    evidence: 'மாதச் சோதனைகளைப் படி', checksH: 'மாதத்தின் தனிச் சோதனைகள்', left: 'புத்தகத்திலிருந்து', right: 'வெளியிலிருந்து', notChecked: 'சோதிக்கப்படவில்லை', noChecks: 'இந்த மாதம் எதுவும் சோதிக்கப்படவில்லை — ஒப்பிட இன்னும் எதுவும் இல்லை.',
    unsettled: 'வழங்குநர் தீர்க்காத {count} கார்டு அல்லது UPI கட்டணங்கள்', payoutsMissing: 'வங்கி பெறாத {count} வழங்குநர் செலுத்தல்கள்', depositsMissing: 'வங்கி வரி பதிலளிக்காத {count} ரொக்க வைப்புகள்',
    addLine: 'வேறு வெளி மூலத்திலிருந்து ஒரு வரியைச் சேர்', lineName: 'எது ஒப்பிடப்படுகிறது', lineBooks: 'புத்தக எண் (₹)', lineOutside: 'வெளி எண் (₹)', lineMethod: 'ஒவ்வொரு பக்கமும் எங்கிருந்து வந்தது',
    cutoff: 'கடையின் நாள் முடியும் நேரம் (கடை அமைப்புகளில் உள்ளபடி, HH:MM)',
    checkTotals: 'கட்டுப்பாட்டு மொத்தங்களை ஒப்பிடு', makePack: 'CA-யின் சான்றுத் தொகுப்பைத் தயாரி', allAgree: 'ஒவ்வொரு கட்டுப்பாட்டு மொத்தமும் சரியாகப் பொருந்துகிறது.', someDiffer: 'சில கட்டுப்பாட்டு மொத்தங்கள் பொருந்தவில்லை — ஒவ்வொரு வரியையும் பாருங்கள்.',
    signable: 'கையெழுத்திடலாம்', notSignable: 'கையெழுத்திட முடியாது', deadFrom: 'கணக்கை அடையாத பதிவுகள் படிக்கப்படுவது', reconcilesYes: 'பொருந்துகிறது', reconcilesNo: '{diff} வேறுபடுகிறது',
    centresH: 'செலவு மற்றும் இலாப மையங்கள்', centresLede: 'ஒவ்வொரு கிளை மற்றும் துறையின் மாதக் கணக்குப் பங்கு, அதன் இலாபம், எந்த மையத்திலும் வைக்கப்படாதது, புத்தகத்துடனான இணைப்பு.',
    showCentres: 'மையங்களைப் படி', centre: 'மையம்', income: 'வருமானம்', expense: 'செலவுகள்', profit: 'இலாபம்', unassigned: 'மையத்தில் வைக்கப்படாதது', attributed: 'மையத்தில் வைக்கப்பட்டது', ties: 'மையங்கள் புத்தகத்துடன் பொருந்துகின்றன.', noTie: 'மையங்கள் புத்தகத்துடன் பொருந்தவில்லை — ஒருவர் பார்க்க வேண்டும்.',
    classesMissing: 'கணக்காளர் கணக்கு வகைகளை இன்னும் அமைக்கவில்லை, எனவே வருமானம், செலவைப் பிரித்துச் சொல்ல முடியாது.', journals: 'பதிவுகள்', unknownCentre: 'மையப் பட்டியலில் இல்லை',
    needMonth: 'முதலில் மாதத்தைத் தேர்ந்தெடுக்கவும்.', needLines: 'ஒப்பிட எதுவும் இல்லை: மாதச் சோதனைகளைப் படிக்கவும், அல்லது ஒரு வரியைச் சேர்க்கவும்.', needLine: 'சேர்த்த ஒவ்வொரு வரிக்கும் எது ஒப்பிடப்படுகிறது, இரு எண்களும் ரூபாயில், ஒவ்வொரு பக்கமும் எங்கிருந்து வந்தது என்பவை தேவை.', needCutoff: 'கடையின் நாள் முடியும் நேரத்தை HH:MM ஆகத் தட்டச்சு செய்யவும்.',
    needReceipt: 'தொகையை ரூபாயில், வந்த நாள், வங்கிக் குறிப்பு ஆகியவற்றைத் தட்டச்சு செய்யவும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு கணக்குப் புத்தகத்தைப் பார்க்க முடியாது.', cannotPost: 'உங்கள் பங்கு புத்தகத்தில் பதிய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export function booksWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (BOOKS_POSTINGS_COPY[lang] as Record<string, string>)[key] ?? (BOOKS_POSTINGS_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}
export const booksOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => booksWords(lang, k), out);

const PATHS: Readonly<Record<Exclude<Stream, 'display'>, { readonly read: string; readonly post: string }>> = {
  b2b: { read: '/v1/finance/b2b/postings', post: '/v1/finance/b2b/post' },
  stock: { read: '/v1/finance/stock-adjustments', post: '/v1/finance/stock-adjustments/post' },
  losses: { read: '/v1/finance/stock-losses', post: '/v1/finance/stock-losses/post' },
  fleet: { read: '/v1/finance/fleet-settlements', post: '/v1/finance/fleet-settlements/post' },
};

/** One movement as the screen shows it: what it is, its value (null = not known, never zero), and whether it is posted. */
export interface StreamRow { readonly id: string; readonly what: string; readonly valueMinor: number | null; readonly posted: boolean }
export interface StreamView {
  readonly rows: readonly StreamRow[];
  readonly inRegister: number; readonly inBooks: number; readonly waiting: number;
  readonly valueMinor: number | null; readonly postedValueMinor: number | null;
  readonly unvalued: number; readonly detail: string | null; readonly connected: boolean;
}

type Raw = Record<string, unknown>;
const arr = (v: unknown): readonly Raw[] => (Array.isArray(v) ? v.filter((x): x is Raw => x !== null && typeof x === 'object') : []);
const strs = (v: unknown): readonly string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Head office's register answer, laid out the same way for every stream. Pure. */
export function streamView(stream: Exclude<Stream, 'display'>, body: unknown): StreamView {
  const b = (body ?? {}) as Raw;
  const unposted = new Set(strs(b['unposted']));
  let rows: StreamRow[] = [];
  if (stream === 'b2b') {
    rows = arr(b['facts']).map((f) => {
      const c = (f['components'] ?? {}) as Raw;
      return { id: str(f['sourceId']), what: `${str(f['kind']).replace('_', ' ')} ${str(f['ref'])} · ${str(f['customerId'])} · ${str(f['documentDate'])}`, valueMinor: num(c['total']) ?? num(c['amount']), posted: !unposted.has(str(f['sourceId'])) };
    });
  } else if (stream === 'stock') {
    rows = arr(b['sources']).map((s) => ({ id: str(s['sourceId']), what: `${str(s['kind'])} · ${str(s['productId'])} ${String(s['quantityMinor'] ?? '')} ${str(s['uom'])} · ${str(s['locationId'])} · ${str(s['reason'])}`, valueMinor: num(s['valueMinor']), posted: !unposted.has(str(s['sourceId'])) }));
  } else if (stream === 'losses') {
    rows = arr(b['losses']).map((l) => ({ id: str(l['sourceId']), what: `${str(l['kind'])} · ${str(l['transferId'])} · ${str(l['fromLocationId'])} → ${str(l['toLocationId'])} · ${str(l['reasonCode'])}`, valueMinor: num(l['lostValueMinor']), posted: !unposted.has(str(l['sourceId'])) }));
  } else {
    rows = arr(b['movements']).map((m) => ({ id: str(m['movementId']), what: `${str(m['kind'])} · ${str(m['routeId'])}${str(m['reference']) === '' ? '' : ` · ${str(m['reference'])}`}`, valueMinor: num(m['amountMinor']), posted: m['posted'] === true }));
  }
  const valued = rows.filter((r) => r.valueMinor !== null);
  const valueMinor = num(b['valueMinor']) ?? num(b['lostValueMinor']) ?? (rows.length === 0 ? 0 : valued.length === rows.length ? valued.reduce((s, r) => s + (r.valueMinor ?? 0), 0) : null);
  const postedValueMinor = num(b['postedValueMinor']) ?? (rows.every((r) => !r.posted || r.valueMinor !== null) ? rows.filter((r) => r.posted).reduce((s, r) => s + (r.valueMinor ?? 0), 0) : null);
  const waiting = rows.filter((r) => !r.posted).length;
  return {
    rows, inRegister: rows.length, inBooks: rows.length - waiting, waiting, valueMinor, postedValueMinor,
    unvalued: rows.filter((r) => r.valueMinor === null).length,
    detail: typeof b['detail'] === 'string' ? b['detail'] : null, connected: b['connected'] !== false,
  };
}

export interface PostAnswer { readonly posted: readonly unknown[]; readonly exceptions: readonly { readonly sourceId?: string; readonly movementId?: string; readonly kind: string; readonly reason: string; readonly detail: string }[] }

export interface DisplayLine {
  readonly contractId: string; readonly supplierId: string; readonly storeId: string; readonly fundingMinor: number; readonly receivedMinor: number;
  readonly outstandingMinor: number; readonly ledgerMinor: number; readonly agrees: boolean; readonly endsOn: string; readonly findings: readonly string[];
}
export interface DisplayFunding { readonly lines: readonly DisplayLine[]; readonly agrees: boolean; readonly fundingMinor: number; readonly receivedMinor: number; readonly ledgerMinor: number; readonly incomeAccount: string | null; readonly needingAttention: number }
export interface ReceiptForm { readonly amountRupees: string; readonly receivedOn: string; readonly reference: string }

export interface EvidenceCheck { readonly name: string; readonly leftMinor: number; readonly rightMinor: number; readonly leftDerivation: string; readonly rightDerivation: string }
export interface MonthEvidence {
  readonly period: string; readonly checks: readonly EvidenceCheck[]; readonly unsettledTenders: readonly unknown[]; readonly payoutsNotInBank: readonly unknown[];
  readonly depositsNotInBank?: readonly unknown[]; readonly notChecked: readonly string[]; readonly agrees: boolean;
}
/** A line a person adds from another outside source — typed in rupees. */
export interface ExtraLine { readonly name: string; readonly booksRupees: string; readonly outsideRupees: string; readonly method: string }
export interface ControlTotal { readonly name: string; readonly ledgerMinor: number; readonly postedMinor: number; readonly method: string }
export interface TotalResult { readonly name: string; readonly ledgerMinor: number; readonly postedMinor: number; readonly differenceMinor: number; readonly reconciles: boolean; readonly method: string; readonly detail: string }
export interface ControlTotalsAnswer { readonly results: readonly TotalResult[]; readonly allReconcile: boolean }
export interface EvidencePack { readonly verdict: string; readonly statement: readonly string[]; readonly signable: boolean; readonly totals: readonly TotalResult[]; readonly deadLetteredFrom?: string; readonly preparedBy: string }

/** The month's checks as control totals: the books' side and the outside side, each with where it came from. Pure. */
export function totalsFrom(checks: readonly EvidenceCheck[], extra: readonly ExtraLine[]): readonly ControlTotal[] | null {
  const out: ControlTotal[] = checks.map((c) => ({ name: c.name, ledgerMinor: c.leftMinor, postedMinor: c.rightMinor, method: `${c.leftDerivation} | ${c.rightDerivation}` }));
  for (const e of extra) {
    if (e.name.trim() === '' && e.booksRupees.trim() === '' && e.outsideRupees.trim() === '' && e.method.trim() === '') continue;
    const l = signedPaiseOf(e.booksRupees); const r = signedPaiseOf(e.outsideRupees);
    if (e.name.trim() === '' || e.method.trim() === '' || l === null || r === null) return null;
    out.push({ name: e.name.trim(), ledgerMinor: l, postedMinor: r, method: e.method.trim() });
  }
  return out;
}

export interface CentreSection { readonly centre: string; readonly name: string | null; readonly known: boolean; readonly incomeMinor: number; readonly expenseMinor: number; readonly profitMinor: number; readonly journals: number }
export interface Centres { readonly centres: readonly CentreSection[]; readonly unassigned: { readonly accounts: readonly unknown[]; readonly journals: readonly unknown[] }; readonly ties: boolean; readonly attributedBps: number | null; readonly classesDefined: boolean; readonly detail: string }

type Why = 'nobody' | 'cannotRead' | 'cannotPost' | 'needMonth' | 'needLines' | 'needLine' | 'needCutoff' | 'needReceipt';
type Done<T> = Promise<Outcome<T, Why>>;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CUTOFF = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface BooksPostingsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly post: boolean };
  read(stream: Exclude<Stream, 'display'>): Done<StreamView>;
  post(stream: Exclude<Stream, 'display'>): Done<PostAnswer>;
  displayFunding(): Done<DisplayFunding>;
  recordReceipt(contractId: string, f: ReceiptForm): Done<{ readonly outstandingMinor?: number; readonly alreadyRecorded: boolean }>;
  evidence(period: string): Done<MonthEvidence>;
  controlTotals(period: string, checks: readonly EvidenceCheck[], extra: readonly ExtraLine[]): Done<ControlTotalsAnswer>;
  evidencePack(period: string, checks: readonly EvidenceCheck[], extra: readonly ExtraLine[], cutoff: string): Done<EvidencePack>;
  centres(period: string): Done<Centres>;
}

export function createBooksPostingsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: (prefix: string) => string;
}): BooksPostingsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('finance.period.read'), post: named && held.has('finance.journal.post') };
  const call = makeCaller({ keyPrefix: 'books', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const idOf = input.newId ?? newId;
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: 'read' | 'post') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotPost') : undefined);
  const enc = encodeURIComponent;
  const totalsOrWhy = (period: string, checks: readonly EvidenceCheck[], extra: readonly ExtraLine[]): { result: 'invalid'; why: Why } | readonly ControlTotal[] => {
    if (!MONTH.test(period)) return no('needMonth');
    const totals = totalsFrom(checks, extra);
    if (totals === null) return no('needLine');
    if (totals.length === 0) return no('needLines');
    return totals;
  };
  return {
    may,
    read: async (stream) => {
      const g = gate('read'); if (g) return g;
      const out = await call<unknown>('GET', PATHS[stream].read);
      return out.result === 'ok' ? { result: 'ok', value: streamView(stream, out.value) } : out;
    },
    post: async (stream) => gate('post') ?? call<PostAnswer>('POST', PATHS[stream].post, {}),
    displayFunding: async () => gate('read') ?? call<DisplayFunding>('GET', '/v1/finance/display-funding'),
    recordReceipt: async (contractId, f) => {
      const g = gate('post'); if (g) return g;
      const amountMinor = signedPaiseOf(f.amountRupees);
      if (contractId.trim() === '' || amountMinor === null || amountMinor <= 0 || !DAY.test(f.receivedOn.trim()) || f.reference.trim() === '') return no('needReceipt');
      return call('POST', `/v1/finance/display-funding/${enc(contractId.trim())}/receipts/${enc(idOf('rcpt'))}`, { amountMinor, receivedOn: f.receivedOn.trim(), reference: f.reference.trim() });
    },
    evidence: async (period) => {
      const g = gate('read'); if (g) return g;
      if (!MONTH.test(period)) return no('needMonth');
      return call<MonthEvidence>('GET', `/v1/finance/periods/${enc(period)}/independent-evidence`);
    },
    controlTotals: async (period, checks, extra) => {
      const g = gate('read'); if (g) return g;
      const totals = totalsOrWhy(period, checks, extra);
      if (!Array.isArray(totals)) return totals as { result: 'invalid'; why: Why };
      return call<ControlTotalsAnswer>('POST', `/v1/finance/periods/${enc(period)}/control-totals`, { totals });
    },
    evidencePack: async (period, checks, extra, cutoff) => {
      const g = gate('read'); if (g) return g;
      const totals = totalsOrWhy(period, checks, extra);
      if (!Array.isArray(totals)) return totals as { result: 'invalid'; why: Why };
      if (!CUTOFF.test(cutoff.trim())) return no('needCutoff');
      return call<EvidencePack>('POST', `/v1/finance/periods/${enc(period)}/evidence-pack`, { totals, tradingDayCutoff: cutoff.trim() });
    },
    centres: async (period) => {
      const g = gate('read'); if (g) return g;
      if (!MONTH.test(period)) return no('needMonth');
      return call<Centres>('GET', `/v1/finance/periods/${enc(period)}/centres`);
    },
  };
}
