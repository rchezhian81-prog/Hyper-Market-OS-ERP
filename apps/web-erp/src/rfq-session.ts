// Requests for quotation (U6 of the UI/UX gap audit · §27 "Purchase — RFQ" was PARTIAL · M06-FR-02 "RFQ to suppliers" ·
// M24-FR-01 "a supplier responds to RFQs" · §28) — the Requests for quotation page's tested, DOM-free session. Before this a
// buyer could only key in what a supplier quoted; nothing sent a request and a supplier had nowhere to answer. Now:
//   • SEND — `POST /v1/purchase/requisitions/:id/rfq/:rfqId` { supplierIds, dueOn, note? } (`purchase.order.propose`): the
//     requisition's lines go to the chosen, APPROVED suppliers with the day the quotes are due; head office refuses a
//     supplier the master has not approved, by name;
//   • the REGISTER — `GET /v1/purchase/rfqs` (`purchase.commitment.read`): every request sent, which suppliers answered
//     (their reply accepted by a buyer on the Supplier submissions page lands as a quote on the Requisitions page's
//     comparison), which are still open and which are overdue.
// The session refuses only the cheap things before a request (nobody signed in, the right not held, no requisition, no
// supplier, no day); head office refuses everything else by name and the page shows its words. Head office's own sentences
// stay in English (OB-553); every word this page adds has a Tamil twin.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { quantityLabel } from '../../../packages/contracts/src/quantity';

export type Lang = 'en' | 'ta';
export type RfqState = 'open' | 'overdue' | 'answered';

export interface RfqSupplierStanding { readonly supplierId: string; readonly answered: boolean; readonly quoteId?: string }
export interface RfqRow {
  readonly rfqId: string;
  readonly requisitionId: string;
  readonly supplierIds: readonly string[];
  readonly dueOn: string;
  readonly note?: string;
  readonly sentBy: string;
  readonly sentAt: string;
  readonly suppliers: readonly RfqSupplierStanding[];
  readonly asked: number;
  readonly answered: number;
  readonly state: RfqState;
}
export interface RfqRegister { readonly rfqs: readonly RfqRow[]; readonly counts: Record<RfqState, number>; readonly today: string; readonly registerKnown: boolean; readonly asAt: string }
export interface RequisitionRow { readonly requisitionId: string; readonly lines: readonly { readonly productId: string; readonly quantity: number; readonly uom?: string }[]; readonly raisedBy?: string }

export const RFQ_COPY = {
  en: {
    title: 'Requests for quotation',
    lead: 'Send what the shop needs to the suppliers you choose, with the day their quotes are due. Each supplier answers on its portal; a buyer accepts the reply on Supplier submissions, and it then stands on the Requisitions page as that supplier\'s quote.',
    sendH: 'Send a request for quotation', requisition: 'Requisition', chooseRequisition: 'Choose a requisition', noRequisitions: 'No requisition has been raised yet — raise one on the Requisitions page first.',
    suppliers: 'Suppliers to ask', supplier: 'Supplier', addSupplier: 'Add this supplier', remove: 'Remove', nobodyAsked: 'No supplier added yet.',
    dueOn: 'Quotes due by', note: 'Note to the suppliers (optional)', send: 'Send the request', sent: 'Sent. Each supplier now sees it on its portal.',
    registerH: 'Requests sent', refresh: 'Read again from head office', covers: 'Every request sent from this shop · read at {time}',
    rfq: 'Request', lines: 'Lines', asked: 'Asked', answered: 'Answered', due: 'Due by', state: 'State', sentBy: 'Sent by', sentOn: 'Sent on',
    state_open: 'Open', state_overdue: 'Overdue', state_answered: 'All answered',
    answeredYes: 'answered', answeredNo: 'not yet', quoteOn: 'quote', compare: 'Compare the quotes',
    none: 'No request for quotation has been sent yet.', noneDetail: 'Head office answered and holds none. Send one above.',
    notKnown: 'Not known', notKnownDetail: 'Head office has not answered, so nothing here is known.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read requests for quotation.', cannotSend: 'Your role cannot send a request for quotation.',
    needRequisition: 'Choose the requisition first. Nothing was sent.', needSupplier: 'Add at least one supplier first. Nothing was sent.', needDay: 'Give the day the quotes are due. Nothing was sent.',
    alreadyAdded: 'That supplier is already on the list.', noteTooLong: 'The note is longer than 300 letters. Nothing was sent.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
    headOfficeEnglish: 'Head office\'s own sentences are in English.',
  },
  ta: {
    title: 'விலைப்புள்ளிக் கோரிக்கைகள்',
    lead: 'கடைக்குத் தேவையானதை நீங்கள் தேர்ந்தெடுக்கும் விநியோகஸ்தர்களுக்கு, விலைப்புள்ளி தர வேண்டிய நாளுடன் அனுப்புங்கள். ஒவ்வொரு விநியோகஸ்தரும் தன் போர்ட்டலில் பதிலளிப்பார்; வாங்குபவர் அந்தப் பதிலை சப்ளையர் சமர்ப்பிப்புகள் பக்கத்தில் ஏற்றதும், அது கோரிக்கைகள் பக்கத்தில் அந்த விநியோகஸ்தரின் விலைப்புள்ளியாக நிற்கும்.',
    sendH: 'விலைப்புள்ளிக் கோரிக்கையை அனுப்பு', requisition: 'கோரிக்கை', chooseRequisition: 'ஒரு கோரிக்கையைத் தேர்ந்தெடுங்கள்', noRequisitions: 'இன்னும் கோரிக்கை எதுவும் எழுப்பப்படவில்லை — முதலில் கோரிக்கைகள் பக்கத்தில் ஒன்றை எழுப்புங்கள்.',
    suppliers: 'கேட்க வேண்டிய விநியோகஸ்தர்கள்', supplier: 'விநியோகஸ்தர்', addSupplier: 'இந்த விநியோகஸ்தரைச் சேர்', remove: 'நீக்கு', nobodyAsked: 'இன்னும் விநியோகஸ்தர் சேர்க்கப்படவில்லை.',
    dueOn: 'விலைப்புள்ளி தர வேண்டிய நாள்', note: 'விநியோகஸ்தர்களுக்குக் குறிப்பு (விருப்பம்)', send: 'கோரிக்கையை அனுப்பு', sent: 'அனுப்பப்பட்டது. ஒவ்வொரு விநியோகஸ்தரும் இப்போது தன் போர்ட்டலில் பார்க்கலாம்.',
    registerH: 'அனுப்பிய கோரிக்கைகள்', refresh: 'தலைமை அலுவலகத்திலிருந்து மீண்டும் படி', covers: 'இந்தக் கடையிலிருந்து அனுப்பிய ஒவ்வொரு கோரிக்கையும் · படித்தது {time}',
    rfq: 'கோரிக்கை', lines: 'வரிகள்', asked: 'கேட்டது', answered: 'பதிலளித்தது', due: 'தர வேண்டிய நாள்', state: 'நிலை', sentBy: 'அனுப்பியவர்', sentOn: 'அனுப்பிய நாள்',
    state_open: 'திறந்துள்ளது', state_overdue: 'நாள் கடந்தது', state_answered: 'அனைவரும் பதிலளித்தனர்',
    answeredYes: 'பதிலளித்தது', answeredNo: 'இன்னும் இல்லை', quoteOn: 'விலைப்புள்ளி', compare: 'விலைப்புள்ளிகளை ஒப்பிடு',
    none: 'இன்னும் விலைப்புள்ளிக் கோரிக்கை எதுவும் அனுப்பப்படவில்லை.', noneDetail: 'தலைமை அலுவலகம் பதிலளித்தது, எதுவும் இல்லை. மேலே ஒன்றை அனுப்புங்கள்.',
    notKnown: 'தெரியவில்லை', notKnownDetail: 'தலைமை அலுவலகம் பதிலளிக்கவில்லை, எனவே இங்கே எதுவும் தெரியாது.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணிப் பொறுப்பால் விலைப்புள்ளிக் கோரிக்கைகளைப் படிக்க முடியாது.', cannotSend: 'உங்கள் பணிப் பொறுப்பால் விலைப்புள்ளிக் கோரிக்கையை அனுப்ப முடியாது.',
    needRequisition: 'முதலில் கோரிக்கையைத் தேர்ந்தெடுங்கள். எதுவும் அனுப்பப்படவில்லை.', needSupplier: 'முதலில் குறைந்தது ஒரு விநியோகஸ்தரைச் சேருங்கள். எதுவும் அனுப்பப்படவில்லை.', needDay: 'விலைப்புள்ளி தர வேண்டிய நாளைக் கொடுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    alreadyAdded: 'அந்த விநியோகஸ்தர் ஏற்கனவே பட்டியலில் உள்ளார்.', noteTooLong: 'குறிப்பு 300 எழுத்துகளுக்கு மேல் உள்ளது. எதுவும் அனுப்பப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ மாற்றவோ இல்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    headOfficeEnglish: 'தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.',
  },
} as const;
export type RfqCopyKey = keyof typeof RFQ_COPY.en;

export const rfqWords = (lang: Lang, key: RfqCopyKey | string): string =>
  (RFQ_COPY[lang] as Record<string, string>)[key] ?? (RFQ_COPY.en as Record<string, string>)[key] ?? key;
export const rfqOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => rfqWords(lang, k), out, lang);

/** The chip's tone for an RFQ's state: open = pending, overdue = error, all answered = ok. Pure. */
export const rfqStateTone = (state: RfqState): 'pending' | 'error' | 'ok' => (state === 'overdue' ? 'error' : state === 'answered' ? 'ok' : 'pending');

/** "rice × 10.000 kg, dal × 4" — a requisition's lines as the page names them (OB-31: the unit's smallest step read back in the unit). */
export const requisitionLinesText = (r: RequisitionRow): string => r.lines.map((l) => `${l.productId} × ${quantityLabel(l.quantity, l.uom ?? 'ea')}`).join(', ');

/** Add a supplier to the list to ask, once; the same id again is refused in words. Pure. */
export function addSupplier(list: readonly string[], supplierId: string): { readonly ok: true; readonly list: readonly string[] } | { readonly ok: false; readonly why: 'needSupplier' | 'alreadyAdded' } {
  const id = supplierId.trim();
  if (id === '') return { ok: false, why: 'needSupplier' };
  if (list.includes(id)) return { ok: false, why: 'alreadyAdded' };
  return { ok: true, list: [...list, id] };
}

export interface RfqSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly send: boolean };
  register(): Promise<Outcome<RfqRegister>>;
  requisitions(): Promise<Outcome<readonly RequisitionRow[]>>;
  send(input: { readonly requisitionId: string; readonly supplierIds: readonly string[]; readonly dueOn: string | null; readonly note: string }): Promise<Outcome<{ readonly rfq: RfqRow }>>;
}

export function createRfqSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: () => string }): RfqSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('purchase.commitment.read'), send: named && perms.has('purchase.order.propose') };
  const call = makeCaller({ keyPrefix: 'rfq', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const newId = input.newId ?? (() => `rfq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const gate = (need: 'read' | 'send'): Outcome<never> | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotSend' } : undefined;
  return {
    may,
    register: async () => { const g = gate('read'); return g ?? call<RfqRegister>('GET', '/v1/purchase/rfqs'); },
    requisitions: async () => {
      const g = gate('read'); if (g !== undefined) return g;
      const out = await call<{ requisitions: RequisitionRow[] }>('GET', '/v1/purchase/requisitions');
      return out.result === 'ok' ? { result: 'ok', value: out.value.requisitions } : out;
    },
    send: async (o) => {
      const g = gate('send'); if (g !== undefined) return g;
      if (o.requisitionId.trim() === '') return { result: 'invalid', why: 'needRequisition' };
      const supplierIds = [...new Set(o.supplierIds.map((s) => s.trim()).filter((s) => s !== ''))];
      if (supplierIds.length === 0) return { result: 'invalid', why: 'needSupplier' };
      if (o.dueOn === null || !/^\d{4}-\d{2}-\d{2}$/.test(o.dueOn)) return { result: 'invalid', why: 'needDay' };
      if (o.note.length > 300) return { result: 'invalid', why: 'noteTooLong' };
      return call('POST', `/v1/purchase/requisitions/${encodeURIComponent(o.requisitionId.trim())}/rfq/${encodeURIComponent(newId())}`, { supplierIds, dueOn: o.dueOn, ...(o.note.trim() === '' ? {} : { note: o.note.trim() }) });
    },
  };
}
