// The "Adjust a quantity" page's session model (U6 of the UI/UX gap audit, 7 Nov 2026 · §27 Inventory "Adjustment" ·
// M08-FR-03 · §28 · hard rules #2 #5 #10 · P-08). DOM-free and tested.
//
// A plain office screen for a stock correction with a reason — until U6 only the warehouse handheld could ask for one and
// only the Count plans page could decide it. Here a person ASKS: product, place, how many more or fewer, a reason code and a
// note. Head office records the request PENDING, valued at its own cost (never typed here), and a DIFFERENT person with the
// approval right decides it; only then is ONE compensating movement appended to the ledger (never an edit). The raiser is
// never offered their own request to decide. Every word has a Tamil twin; head office's refusals stay as written.

import type { HeadOfficeHttp, HttpAnswer } from './head-office-http';
import { refusalWords } from './refusal-words';
import { rupees } from './head-office-http';
import { quantityLabel, normaliseUom, typedQuantityMinor } from '../../../packages/contracts/src/quantity';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';
import { shopMomentOf } from './stock-ledger-session';

export type Lang = 'en' | 'ta';
export interface AdjustmentsViewer { readonly userId?: string; readonly permissions: readonly string[] }

/** A request as head office keeps it (`GET /v1/inventory/adjustment-requests`). */
export interface AdjustmentRequestRow {
  readonly requestId: string; readonly productId: string; readonly locationId: string; readonly binId: string | null;
  readonly deltaMinor: number; readonly uom: string; readonly reasonCode: string; readonly note: string | null;
  readonly valueMinor: number; readonly requestedBy: string; readonly at: string; readonly storeId: string | null; readonly source: string;
  readonly governanceFlags: readonly string[]; readonly status: 'pending' | 'posted' | 'rejected';
  readonly decidedBy: string | null; readonly decidedAt: string | null; readonly decisionReason: string | null; readonly movementId: string | null;
}

export type Refused = { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string };
export type Outcome<T> = ({ readonly result: 'ok' } & T) | Refused | { readonly result: 'lost_link' } | { readonly result: 'invalid'; readonly key: string };

/** The reasons head office accepts (`ADJUSTMENT_REASON_CODES`). */
export const REASONS = Object.freeze(['damaged', 'expired', 'miscount', 'found', 'theft_suspected', 'other'] as const);

const WORDS: Readonly<Record<Lang, Readonly<Record<string, string>>>> = Object.freeze({
  en: {
    title: 'Adjust a quantity',
    lede: 'Ask for a stock correction with a reason. Nothing moves until a different person approves it; head office then adds one correcting line to the ledger in both your names — the record is never edited.',
    newH: 'Ask for a correction', newLede: 'Say what the shelf really holds. Head office values the difference at its own cost and holds the request for a different person to decide.',
    product: 'Product', place: 'Place', direction: 'The shelf holds', more: 'more than the system says', less: 'fewer than the system says', quantity: 'By how many', unit: 'Unit', reason: 'Reason', note: 'Note (what you saw)',
    whichProduct: 'Which product?', whichPlace: 'Which place?', choose: 'Choose…',
    damaged: 'Damaged', expired: 'Expired', miscount: 'Miscounted', found: 'Found', theft_suspected: 'Theft suspected', other: 'Other',
    ask: 'Ask for this correction',
    registerH: 'Corrections asked for', registerLede: 'Waiting ones first. A request is decided once, by a person who did not ask for it.', showAll: 'Show decided ones too', waiting: 'waiting for a decision',
    colRequest: 'Request', colProduct: 'Product', colPlace: 'Place', colChange: 'Change', colValue: 'Value at cost', colReason: 'Reason', colAskedBy: 'Asked by', colWhen: 'When', colState: 'State', colDecision: 'Decision',
    pending: 'Waiting for a decision', posted: 'Approved — correction posted', rejected: 'Rejected — nothing moved',
    yours: 'You asked for this one — a different person decides it.', decidedBy: 'decided by', fromOffice: 'from the office', fromHandheld: 'from a handheld',
    requester_unknown: 'the person who asked is not known here', requester_lacks_authority: 'the person who asked has no stock authority here', value_unknown: 'the product has no cost at head office — the value is not known',
    decisionReason: 'Why (the line a person reads later)', approve: 'Approve', reject: 'Reject',
    confirmAskTitle: 'Ask for this correction?', confirmAskDetail: '{product} at {place}: {change}, reason "{reason}". Head office records the request in your name and values it at its own cost. Nothing moves until a different person approves it.',
    confirmApproveTitle: 'Approve this correction?', confirmApproveDetail: '{product} at {place}: {change} ({value}). Head office adds one correcting line to the stock ledger in your name and the asker\'s. The ledger is never edited; a wrong approval needs a new correction.',
    authorityAsk: 'Your role may ask for a stock correction.', authorityApprove: 'Your role may approve a stock correction asked for by somebody else.',
    asked: 'Recorded. Head office holds it for a different person to decide.', askedAgain: 'That request was already recorded — nothing new was sent.',
    approvedNow: 'Approved. Head office posted the correction once.', rejectedNow: 'Rejected. Nothing moved.', already: 'Already decided the same way — nothing changed.',
    reading: 'Reading from head office…', unreachable: 'Head office cannot be reached — nothing was read.', refused: 'Head office refused:',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read stock corrections.', cannotAsk: 'Your role cannot ask for a stock correction.', cannotDecide: 'Your role cannot decide a stock correction.',
    needProduct: 'Choose the product first.', needPlace: 'Choose the place first.', needQty: 'Type how many, as a whole number of the unit.', needReason: 'Choose the reason first.', needWhy: 'Write a reason first.',
    confirmUnavailable: 'The confirm step could not open — nothing was sent.',
    empty: 'No correction is waiting for a decision.', emptyDetail: 'Tick "Show decided ones too" to read the ones already approved or rejected.',
    emptyAll: 'No correction has been asked for yet.', emptyAllDetail: 'A request from this page or from a warehouse handheld appears here.',
    asAt: 'Read from head office at', covers: 'This register covers the places your role may see.',
  },
  ta: {
    title: 'அளவைத் திருத்து',
    lede: 'காரணத்துடன் சரக்குத் திருத்தம் கேளுங்கள். வேறு ஒருவர் ஒப்புதல் அளிக்கும் வரை எதுவும் நகராது; பின்னர் தலைமை அலுவலகம் இருவர் பெயரிலும் பேரேட்டில் ஒரு திருத்த வரியைச் சேர்க்கிறது — பதிவு ஒருபோதும் திருத்தப்படாது.',
    newH: 'திருத்தம் கேள்', newLede: 'அலமாரியில் உண்மையில் என்ன உள்ளது என்று கூறுங்கள். தலைமை அலுவலகம் வித்தியாசத்தைத் தன் சொந்த விலையில் மதிப்பிட்டு, வேறு ஒருவர் முடிவு செய்ய கோரிக்கையை வைத்திருக்கும்.',
    product: 'பொருள்', place: 'இடம்', direction: 'அலமாரியில் உள்ளது', more: 'கணினி கூறுவதை விட அதிகம்', less: 'கணினி கூறுவதை விட குறைவு', quantity: 'எத்தனை', unit: 'அலகு', reason: 'காரணம்', note: 'குறிப்பு (நீங்கள் பார்த்தது)',
    whichProduct: 'எந்தப் பொருள்?', whichPlace: 'எந்த இடம்?', choose: 'தேர்வு…',
    damaged: 'சேதம்', expired: 'காலாவதி', miscount: 'தவறான எண்ணிக்கை', found: 'கண்டெடுக்கப்பட்டது', theft_suspected: 'திருட்டு சந்தேகம்', other: 'வேறு',
    ask: 'இந்தத் திருத்தத்தைக் கேள்',
    registerH: 'கேட்கப்பட்ட திருத்தங்கள்', registerLede: 'காத்திருப்பவை முதலில். ஒரு கோரிக்கை, கேட்காத ஒருவரால், ஒரே முறை முடிவு செய்யப்படும்.', showAll: 'முடிவு செய்யப்பட்டவற்றையும் காட்டு', waiting: 'முடிவுக்காகக் காத்திருக்கின்றன',
    colRequest: 'கோரிக்கை', colProduct: 'பொருள்', colPlace: 'இடம்', colChange: 'மாற்றம்', colValue: 'விலையில் மதிப்பு', colReason: 'காரணம்', colAskedBy: 'கேட்டவர்', colWhen: 'எப்போது', colState: 'நிலை', colDecision: 'முடிவு',
    pending: 'முடிவுக்காகக் காத்திருப்பு', posted: 'ஒப்புதல் — திருத்தம் பதிவானது', rejected: 'நிராகரிப்பு — எதுவும் நகரவில்லை',
    yours: 'இதை நீங்கள் கேட்டீர்கள் — வேறு ஒருவர் முடிவு செய்வார்.', decidedBy: 'முடிவு செய்தவர்', fromOffice: 'அலுவலகத்திலிருந்து', fromHandheld: 'கைக்கருவியிலிருந்து',
    requester_unknown: 'கேட்டவர் இங்கே அறியப்படவில்லை', requester_lacks_authority: 'கேட்டவருக்கு இங்கே சரக்கு அதிகாரம் இல்லை', value_unknown: 'தலைமை அலுவலகத்தில் பொருளுக்கு விலை இல்லை — மதிப்பு தெரியவில்லை',
    decisionReason: 'ஏன் (பின்னர் ஒருவர் படிக்கும் வரி)', approve: 'ஒப்புதல்', reject: 'நிராகரி',
    confirmAskTitle: 'இந்தத் திருத்தத்தைக் கேட்கவா?', confirmAskDetail: '{place}-இல் {product}: {change}, காரணம் "{reason}". தலைமை அலுவலகம் கோரிக்கையை உங்கள் பெயரில் பதிவு செய்து, தன் சொந்த விலையில் மதிப்பிடும். வேறு ஒருவர் ஒப்புதல் அளிக்கும் வரை எதுவும் நகராது.',
    confirmApproveTitle: 'இந்தத் திருத்தத்தை ஒப்புக்கொள்ளவா?', confirmApproveDetail: '{place}-இல் {product}: {change} ({value}). தலைமை அலுவலகம் உங்கள் மற்றும் கேட்டவர் பெயரில் சரக்குப் பேரேட்டில் ஒரு திருத்த வரியைச் சேர்க்கிறது. பேரேடு ஒருபோதும் திருத்தப்படாது; தவறான ஒப்புதலுக்கு புதிய திருத்தம் தேவை.',
    authorityAsk: 'உங்கள் பங்கு சரக்குத் திருத்தம் கேட்கலாம்.', authorityApprove: 'உங்கள் பங்கு வேறொருவர் கேட்ட சரக்குத் திருத்தத்தை ஒப்புக்கொள்ளலாம்.',
    asked: 'பதிவானது. வேறு ஒருவர் முடிவு செய்ய தலைமை அலுவலகம் வைத்திருக்கிறது.', askedAgain: 'அந்தக் கோரிக்கை ஏற்கனவே பதிவாகியிருந்தது — புதிதாக எதுவும் அனுப்பப்படவில்லை.',
    approvedNow: 'ஒப்புதல் அளிக்கப்பட்டது. தலைமை அலுவலகம் திருத்தத்தை ஒரே முறை பதிவு செய்தது.', rejectedNow: 'நிராகரிக்கப்பட்டது. எதுவும் நகரவில்லை.', already: 'ஏற்கனவே அதே முடிவு — எதுவும் மாறவில்லை.',
    reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.', refused: 'தலைமை அலுவலகம் மறுத்தது:',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு சரக்குத் திருத்தங்களைப் படிக்க முடியாது.', cannotAsk: 'உங்கள் பங்கு சரக்குத் திருத்தம் கேட்க முடியாது.', cannotDecide: 'உங்கள் பங்கு சரக்குத் திருத்தத்தை முடிவு செய்ய முடியாது.',
    needProduct: 'முதலில் பொருளைத் தேர்ந்தெடுக்கவும்.', needPlace: 'முதலில் இடத்தைத் தேர்ந்தெடுக்கவும்.', needQty: 'எத்தனை என்பதை அலகின் முழு எண்ணாகத் தட்டச்சு செய்யவும்.', needReason: 'முதலில் காரணத்தைத் தேர்ந்தெடுக்கவும்.', needWhy: 'முதலில் காரணத்தை எழுதவும்.',
    confirmUnavailable: 'உறுதிப்படுத்தும் படி திறக்கவில்லை — எதுவும் அனுப்பப்படவில்லை.',
    empty: 'எந்தத் திருத்தமும் முடிவுக்காகக் காத்திருக்கவில்லை.', emptyDetail: 'ஏற்கனவே ஒப்புதல் அல்லது நிராகரிப்பு பெற்றவற்றைப் படிக்க "முடிவு செய்யப்பட்டவற்றையும் காட்டு" என்பதைத் தேர்வு செய்யவும்.',
    emptyAll: 'இன்னும் எந்தத் திருத்தமும் கேட்கப்படவில்லை.', emptyAllDetail: 'இந்தப் பக்கத்திலிருந்தோ கிடங்குக் கைக்கருவியிலிருந்தோ வரும் கோரிக்கை இங்கே தோன்றும்.',
    asAt: 'தலைமை அலுவலகத்திலிருந்து படித்த நேரம்', covers: 'இந்தப் பதிவேடு உங்கள் பங்கு பார்க்கக்கூடிய இடங்களை உள்ளடக்கியது.',
  },
});
export const STOCK_ADJUSTMENTS_WORD_KEYS: readonly string[] = Object.freeze(Object.keys(WORDS.en));
export const text = (lang: Lang, key: string): string => WORDS[lang][key] ?? WORDS.en[key] ?? key;
export const fill = (lang: Lang, key: string, values: Readonly<Record<string, string>>): string => Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), text(lang, key));

/** "+2 ea" / "−2.500 kg" — the change as a person reads it (OB-31). */
export const changeWords = (deltaMinor: number, uom: string): string => `${deltaMinor > 0 ? '+' : '−'}${quantityLabel(Math.abs(deltaMinor), uom)}`;

export interface AskForm { readonly productId: string; readonly locationId: string; readonly direction: 'more' | 'less'; readonly quantityText: string; readonly uom: string; readonly reasonCode: string; readonly note: string }
/** The body head office is sent, or what is missing — only the cheap checks; every rule is head office's. */
export function askBody(form: AskForm): { readonly body: { productId: string; locationId: string; deltaMinor: number; uom: string; reasonCode: string; note?: string } } | { readonly key: string } {
  const productId = form.productId.trim(); const locationId = form.locationId.trim();
  if (productId === '') return { key: 'needProduct' };
  if (locationId === '') return { key: 'needPlace' };
  const uom = form.uom.trim() === '' ? 'EA' : form.uom.trim();
  // OB-31: typed in the item's own unit ("2.5" kg is 2500 g) through the one shared reading; an unknown unit keeps a whole number.
  const s = form.quantityText.trim();
  const qty = normaliseUom(uom) === undefined ? (/^\d+$/.test(s) ? Number(s) : undefined) : typedQuantityMinor(s, uom);
  if (qty === undefined || qty <= 0) return { key: 'needQty' };
  if (!(REASONS as readonly string[]).includes(form.reasonCode)) return { key: 'needReason' };
  const note = form.note.trim();
  return { body: { productId, locationId, deltaMinor: form.direction === 'more' ? qty : -qty, uom, reasonCode: form.reasonCode, ...(note === '' ? {} : { note }) } };
}

/** One request as the register shows it; `viewerId` marks the person's own, which they may never decide. */
export function requestView(lang: Lang, r: AdjustmentRequestRow, viewerId: string | null, mayDecide: boolean) {
  const yours = viewerId !== null && r.requestedBy === viewerId;
  return {
    ...r,
    change: changeWords(r.deltaMinor, r.uom),
    value: r.governanceFlags.includes('value_unknown') ? text(lang, 'value_unknown') : rupees(r.valueMinor),
    reasonWord: text(lang, r.reasonCode), stateWord: text(lang, r.status), when: shopMomentOf(r.at),
    sourceWord: r.source === 'office' ? text(lang, 'fromOffice') : text(lang, 'fromHandheld'),
    flags: r.governanceFlags.map((f) => text(lang, f)),
    decision: r.decidedBy === null ? null : `${text(lang, 'decidedBy')} ${r.decidedBy}${r.decisionReason === null ? '' : ` — ${r.decisionReason}`}`,
    yours, canDecide: r.status === 'pending' && mayDecide && !yours,
  };
}

const enc = encodeURIComponent;
const refusedOrLost = (a: HttpAnswer): Refused | { readonly result: 'lost_link' } => (a.result === 'lost_link' ? a : { result: 'refused', status: a.status, code: a.result === 'refused' ? a.code : 'unreadable_answer', whatHappened: a.result === 'refused' ? a.whatHappened : '' });
const stamp = (): string => shopDateIn(new Date().toISOString(), servedShopZone()).replace(/-/g, ''); // OB-606: the SHOP's date
const rand = (): string => Math.random().toString(36).slice(2, 7);

/** The cheap check alone (for the page to refuse before the confirm sheet): the key of what is missing, or null. */
export const checkAsk = (form: AskForm): string | null => { const made = askBody(form); return 'key' in made ? made.key : null; };
/** The quantity the form names, in the unit's smallest step (0 when it cannot be read). */
export const quantityOf = (form: AskForm): number => { const made = askBody(form); return 'key' in made ? 0 : Math.abs(made.body.deltaMinor); };

export function createStockAdjustmentsSession(viewer: AdjustmentsViewer | undefined, http: HeadOfficeHttp, ids: { request(): string } = { request: () => `adj-${stamp()}-${rand()}` }) {
  const perms = new Set(viewer?.permissions ?? []);
  const nobody = viewer === undefined;
  const may = { read: perms.has('inventory.availability.read'), ask: perms.has('inventory.movement.append'), decide: perms.has('inventory.adjustment.approve') };
  const post = async (path: string, body: unknown): Promise<Outcome<{ readonly body: unknown }>> => {
    if (nobody) return { result: 'invalid', key: 'nobody' };
    const a = await http.post(path, body);
    return a.result === 'ok' ? { result: 'ok', body: a.body } : refusedOrLost(a);
  };
  return {
    nobody, userId: viewer?.userId ?? null, may, text, fill, changeWords, shopMomentOf, check: checkAsk, quantityOf,
    requestView: (lang: Lang, r: AdjustmentRequestRow) => requestView(lang, r, viewer?.userId ?? null, may.decide),
    async list(all = false): Promise<Outcome<{ readonly requests: readonly AdjustmentRequestRow[]; readonly pending: number; readonly asAt: string }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      if (!may.read) return { result: 'invalid', key: 'cannotRead' };
      const a = await http.get(`/v1/inventory/adjustment-requests${all ? '' : '?status=pending'}`);
      if (a.result !== 'ok') return refusedOrLost(a);
      const b = a.body as { requests?: unknown; pending?: unknown; asAt?: unknown };
      return { result: 'ok', requests: Array.isArray(b.requests) ? (b.requests as AdjustmentRequestRow[]) : [], pending: typeof b.pending === 'number' ? b.pending : 0, asAt: typeof b.asAt === 'string' ? b.asAt : '' };
    },
    async ask(form: AskForm): Promise<Outcome<{ readonly requestId: string; readonly body: unknown; readonly alreadyRecorded: boolean }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      if (!may.ask) return { result: 'invalid', key: 'cannotAsk' };
      const made = askBody(form);
      if ('key' in made) return { result: 'invalid', key: made.key };
      const requestId = ids.request();
      const out = await post(`/v1/inventory/adjustment-requests/${enc(requestId)}`, made.body);
      if (out.result !== 'ok') return out;
      return { ...out, requestId, alreadyRecorded: (out.body as { alreadyRecorded?: unknown }).alreadyRecorded === true };
    },
    async decide(requestId: string, decision: 'approved' | 'rejected', reason: string): Promise<Outcome<{ readonly body: unknown; readonly alreadyDecided: boolean }>> {
      if (nobody) return { result: 'invalid', key: 'nobody' };
      if (!may.decide) return { result: 'invalid', key: 'cannotDecide' };
      if (reason.trim() === '') return { result: 'invalid', key: 'needWhy' };
      const out = await post(`/v1/inventory/adjustment-requests/${enc(requestId)}/decide`, { decision, reason: reason.trim() });
      if (out.result !== 'ok') return out;
      return { ...out, alreadyDecided: (out.body as { alreadyDecided?: unknown }).alreadyDecided === true };
    },
    say(lang: Lang, out: Outcome<unknown>, good = ''): { readonly tone: 'good' | 'err'; readonly words: string } {
      if (out.result === 'ok') return { tone: 'good', words: good === '' ? '' : text(lang, good) };
      if (out.result === 'lost_link') return { tone: 'err', words: text(lang, 'unreachable') };
      if (out.result === 'invalid') return { tone: 'err', words: text(lang, out.key) };
      return { tone: 'err', words: refusalWords(lang, out) };
    },
  };
}
export type StockAdjustmentsSession = ReturnType<typeof createStockAdjustmentsSession>;
