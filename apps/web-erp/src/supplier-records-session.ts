// The supplier's PAPERS, BANK ACCOUNT and HOLD on the Suppliers page (WF-02 "Application → KYC/commercial documents → bank
// verification → terms/contracts → approval → active/blocked" · M06-FR-01 · §28 · P-04 · P-08 · hard rules #3, #10).
// A tested, DOM-free THIN client over head office's own routes:
//
//   • DOCUMENTS (`GET` / `POST /v1/purchase/suppliers/:id`, `purchase.supplier.manage`) — the supplier's GST registration,
//     FSSAI licence, trade licence, insurance, bank mandate or quality certificate, with its number and the days it is valid.
//     Saved as "not checked yet", or as checked by the person at the screen when they have seen the original. A paper on file
//     that nobody has checked can be marked "checked by me" later. Head office records who checked it as the signed-in
//     person — never a typed name. Every other paper on file is sent back exactly as stored, so nothing on file is lost.
//   • BANK ACCOUNT CHANGE — where a supplier is paid is the invoice-fraud door, so it is a two-person act through head office's
//     maker-checker engine (kind `supplier_bank_change`): the person who holds `purchase.supplier.bank` ASKS, with how the
//     request arrived, when, the number they rang back and the number we ALREADY held; a DIFFERENT person who holds
//     `purchase.supplier.approve` approves it on the Approvals page; the asker then RECORDS it, naming that approval — the
//     details come from the approved request itself, never typed again (`POST /v1/purchase/suppliers/:id/bank-details`).
//     Only a masked or tokenised account reference is ever typed or shown (PRV: no raw account number) — a run of nine or
//     more digits is refused here before anything is sent.
//   • HOLD (`POST /v1/purchase/suppliers/:id/block-status`, `purchase.supplier.block`) — put a supplier on hold or lift it,
//     always with a reason for the record.
//
// Head office re-checks every permission, the approval, the call-back rule and the supplier's creator (who may never approve
// its bank change). Nothing is read on open; every read and write is a person's click. No AI here (hard rule #5 does not arise).

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const DOCUMENT_KINDS = ['gst_registration', 'fssai_licence', 'trade_licence', 'insurance', 'bank_mandate', 'quality_certificate'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const REQUESTED_VIA = ['letter', 'email', 'portal', 'phone_call_we_made'] as const;
export type RequestedVia = (typeof REQUESTED_VIA)[number];

export const SUPPLIER_RECORDS_COPY = {
  en: {
    h: 'A supplier\'s papers, bank account and hold', lead: 'Choose a supplier, then show its papers. A paper is saved as "not checked yet" until someone who has seen the original marks it checked. Changing where a supplier is paid always needs a second person.',
    supplier: 'Supplier', show: 'Show this supplier\'s papers',
    docsH: 'Papers on file', noDocs: 'No paper is on file for this supplier yet.', noRecord: 'This supplier has no record yet — add it first, below.',
    k_gst_registration: 'GST registration', k_fssai_licence: 'FSSAI food licence', k_trade_licence: 'Trade licence', k_insurance: 'Insurance', k_bank_mandate: 'Bank mandate letter', k_quality_certificate: 'Quality certificate',
    validFrom: 'Valid from', validUntil: 'Valid until', checkedBy: 'Checked by', notChecked: 'Not checked yet', verify: 'I have seen the original — mark it checked by me',
    addH: 'Add a paper', kind: 'Which paper', reference: 'Its number', seenNow: 'I have seen the original of this paper', add: 'Save the paper',
    addedNow: 'Saved on the supplier\'s record.', verifiedNow: 'Marked as checked by you.', alreadyChecked: 'This paper is already checked.',
    needDoc: 'Choose the paper, write its number and both dates (YYYY-MM-DD); the "valid until" day cannot be before the "valid from" day.',
    bankH: 'Change where this supplier is paid', bankLead: 'Ring the supplier back on a number we ALREADY held — never the number on the letter or e-mail asking for the change. Type only the masked account (for example ••••1234) or the bank\'s token, never the full account number.',
    account: 'New account (masked, e.g. ••••1234)', via: 'How the request came', v_letter: 'Letter', v_email: 'E-mail', v_portal: 'Supplier portal', v_phone_call_we_made: 'A call we made',
    arrivedOn: 'Day the request arrived (YYYY-MM-DD)', calledBack: 'Number you rang back', heldNumber: 'Number we already held for them', why: 'Why (this is the record)',
    ask: 'Ask a second person to approve', askedNow: 'Asked. A different person who approves supplier changes approves exactly this on the Approvals page; then record it below.',
    needBank: 'Fill in the masked account, how the request came, the day it arrived (YYYY-MM-DD), the number you rang, the number we already held and why.',
    fullNumber: 'That looks like a full account number. Type only the masked account (for example ••••1234) or the bank\'s token — nothing was sent.',
    notTheHeldNumber: 'The number you rang is not the number we already held. Ringing the number on the request reaches whoever sent it — ring the number we held. Nothing was sent.',
    asksH: 'Bank changes you asked for', noAsks: 'You have not asked for a bank change.', st_waiting: 'Waiting for a second person', st_approved: 'Approved — record it now', st_rejected: 'Rejected', st_expired: 'Approval ran out — ask again', st_used: 'Recorded',
    record: 'Record the approved change', recordedNow: 'Recorded — payments now go to the verified account, with who approved it.',
    holdH: 'Hold', onHold: 'This supplier is ON HOLD — nothing is ordered or paid.', notOnHold: 'This supplier is not on hold.', holdWhy: 'Why (this is the record)',
    hold: 'Put this supplier on hold', lift: 'Lift the hold', heldNow: 'On hold — head office will order and pay nothing to this supplier.', liftedNow: 'Hold lifted.', needWhy: 'Write why — the reason is the record.',
    needSupplier: 'Choose a supplier first.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read suppliers.', cannotManage: 'Your role cannot add or check a supplier\'s papers.', cannotBank: 'Your role cannot ask for a bank account change.', cannotHold: 'Your role cannot put a supplier on hold.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    h: 'விநியோகஸ்தரின் ஆவணங்கள், வங்கிக் கணக்கு, நிறுத்தம்', lead: 'ஒரு விநியோகஸ்தரைத் தேர்ந்தெடுத்து அதன் ஆவணங்களைக் காட்டுங்கள். மூலத்தைப் பார்த்த ஒருவர் சரிபார்த்ததாகக் குறிக்கும் வரை ஆவணம் "இன்னும் சரிபார்க்கவில்லை" என்றே சேமிக்கப்படும். விநியோகஸ்தருக்குப் பணம் செல்லும் இடத்தை மாற்ற எப்போதும் இரண்டாமவர் தேவை.',
    supplier: 'விநியோகஸ்தர்', show: 'இந்த விநியோகஸ்தரின் ஆவணங்களைக் காட்டு',
    docsH: 'பதிவில் உள்ள ஆவணங்கள்', noDocs: 'இந்த விநியோகஸ்தருக்கு இன்னும் எந்த ஆவணமும் இல்லை.', noRecord: 'இந்த விநியோகஸ்தருக்கு இன்னும் பதிவு இல்லை — முதலில் கீழே சேருங்கள்.',
    k_gst_registration: 'GST பதிவு', k_fssai_licence: 'FSSAI உணவு உரிமம்', k_trade_licence: 'வர்த்தக உரிமம்', k_insurance: 'காப்பீடு', k_bank_mandate: 'வங்கி ஆணைக் கடிதம்', k_quality_certificate: 'தரச் சான்றிதழ்',
    validFrom: 'செல்லுபடி தொடக்கம்', validUntil: 'செல்லுபடி முடிவு', checkedBy: 'சரிபார்த்தவர்', notChecked: 'இன்னும் சரிபார்க்கவில்லை', verify: 'மூலத்தைப் பார்த்தேன் — நான் சரிபார்த்ததாகக் குறி',
    addH: 'ஆவணம் சேர்', kind: 'எந்த ஆவணம்', reference: 'அதன் எண்', seenNow: 'இந்த ஆவணத்தின் மூலத்தைப் பார்த்தேன்', add: 'ஆவணத்தைச் சேமி',
    addedNow: 'விநியோகஸ்தரின் பதிவில் சேமிக்கப்பட்டது.', verifiedNow: 'நீங்கள் சரிபார்த்ததாகக் குறிக்கப்பட்டது.', alreadyChecked: 'இந்த ஆவணம் ஏற்கனவே சரிபார்க்கப்பட்டது.',
    needDoc: 'ஆவணத்தைத் தேர்ந்தெடுத்து, அதன் எண்ணையும் இரு நாட்களையும் (YYYY-MM-DD) எழுதுங்கள்; "செல்லுபடி முடிவு" நாள் "தொடக்க" நாளுக்கு முன் இருக்கக் கூடாது.',
    bankH: 'இந்த விநியோகஸ்தருக்குப் பணம் செல்லும் இடத்தை மாற்று', bankLead: 'நம்மிடம் ஏற்கனவே இருந்த எண்ணில் விநியோகஸ்தரை அழையுங்கள் — மாற்றம் கேட்கும் கடிதம் அல்லது மின்னஞ்சலில் உள்ள எண்ணில் அல்ல. மறைத்த கணக்கை (எ.கா. ••••1234) அல்லது வங்கியின் குறியீட்டை மட்டும் எழுதுங்கள், முழுக் கணக்கு எண்ணை ஒருபோதும் அல்ல.',
    account: 'புதிய கணக்கு (மறைத்தது, எ.கா. ••••1234)', via: 'கோரிக்கை எப்படி வந்தது', v_letter: 'கடிதம்', v_email: 'மின்னஞ்சல்', v_portal: 'விநியோகஸ்தர் தளம்', v_phone_call_we_made: 'நாம் செய்த அழைப்பு',
    arrivedOn: 'கோரிக்கை வந்த நாள் (YYYY-MM-DD)', calledBack: 'நீங்கள் திரும்ப அழைத்த எண்', heldNumber: 'நம்மிடம் ஏற்கனவே இருந்த எண்', why: 'ஏன் (இதுவே பதிவு)',
    ask: 'இரண்டாமவரின் அனுமதி கேள்', askedNow: 'கேட்கப்பட்டது. விநியோகஸ்தர் மாற்றங்களை அனுமதிக்கும் வேறொருவர் இதையே அனுமதிகள் பக்கத்தில் அனுமதிப்பார்; பின்னர் கீழே பதிவு செய்யுங்கள்.',
    needBank: 'மறைத்த கணக்கு, கோரிக்கை எப்படி வந்தது, வந்த நாள் (YYYY-MM-DD), நீங்கள் அழைத்த எண், நம்மிடம் இருந்த எண், ஏன் — நிரப்புங்கள்.',
    fullNumber: 'இது முழுக் கணக்கு எண் போல் உள்ளது. மறைத்த கணக்கை (எ.கா. ••••1234) அல்லது வங்கியின் குறியீட்டை மட்டும் எழுதுங்கள் — எதுவும் அனுப்பப்படவில்லை.',
    notTheHeldNumber: 'நீங்கள் அழைத்த எண் நம்மிடம் இருந்த எண் அல்ல. கோரிக்கையில் உள்ள எண்ணை அழைத்தால் அனுப்பியவரையே அடையும் — நம்மிடம் இருந்த எண்ணை அழையுங்கள். எதுவும் அனுப்பப்படவில்லை.',
    asksH: 'நீங்கள் கேட்ட வங்கி மாற்றங்கள்', noAsks: 'நீங்கள் எந்த வங்கி மாற்றமும் கேட்கவில்லை.', st_waiting: 'இரண்டாமவருக்காகக் காத்திருக்கிறது', st_approved: 'அனுமதிக்கப்பட்டது — இப்போது பதிவு செய்யுங்கள்', st_rejected: 'நிராகரிக்கப்பட்டது', st_expired: 'அனுமதி காலாவதியானது — மீண்டும் கேளுங்கள்', st_used: 'பதிவானது',
    record: 'அனுமதிக்கப்பட்ட மாற்றத்தைப் பதிவு செய்', recordedNow: 'பதிவானது — இனி பணம் சரிபார்த்த கணக்குக்குச் செல்லும், அனுமதித்தவருடன்.',
    holdH: 'நிறுத்தம்', onHold: 'இந்த விநியோகஸ்தர் நிறுத்தி வைக்கப்பட்டுள்ளார் — எதுவும் ஆணையிடப்படவோ செலுத்தப்படவோ இல்லை.', notOnHold: 'இந்த விநியோகஸ்தர் நிறுத்தி வைக்கப்படவில்லை.', holdWhy: 'ஏன் (இதுவே பதிவு)',
    hold: 'இந்த விநியோகஸ்தரை நிறுத்தி வை', lift: 'நிறுத்தத்தை நீக்கு', heldNow: 'நிறுத்தப்பட்டது — தலைமை அலுவலகம் இந்த விநியோகஸ்தருக்கு எதையும் ஆணையிடாது, செலுத்தாது.', liftedNow: 'நிறுத்தம் நீக்கப்பட்டது.', needWhy: 'ஏன் என்று எழுதுங்கள் — காரணமே பதிவு.',
    needSupplier: 'முதலில் ஒரு விநியோகஸ்தரைத் தேர்ந்தெடுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி விநியோகஸ்தர்களைப் படிக்க முடியாது.', cannotManage: 'உங்கள் பணி விநியோகஸ்தரின் ஆவணங்களைச் சேர்க்கவோ சரிபார்க்கவோ முடியாது.', cannotBank: 'உங்கள் பணி வங்கிக் கணக்கு மாற்றம் கேட்க முடியாது.', cannotHold: 'உங்கள் பணி விநியோகஸ்தரை நிறுத்தி வைக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const supplierRecordsWords = (lang: Lang, key: string): string =>
  (SUPPLIER_RECORDS_COPY[lang] as Record<string, string>)[key] ?? (SUPPLIER_RECORDS_COPY.en as Record<string, string>)[key] ?? key;

export interface SupplierDocumentView {
  readonly documentId: string; readonly kind: DocumentKind; readonly reference: string; readonly validFrom: string; readonly validUntil: string;
  readonly verifiedBy?: string; readonly verifiedAt?: string;
}
/** The supplier's master record as head office holds it (the fields an update must send back). */
export interface SupplierRecordView {
  readonly supplierId: string; readonly name: string; readonly gstin: string | null; readonly phone: string | null; readonly email: string | null;
  readonly address: string | null; readonly paymentTermsDays: number | null; readonly documents: readonly SupplierDocumentView[]; readonly status: string;
}
export interface SupplierDetail { readonly supplier: SupplierRecordView | null; readonly blocked: boolean; readonly bank: { readonly accountRef: string; readonly verifiedBy: string } | null }
export interface BankAsk {
  readonly requestId: string; readonly subjectRef: string; readonly status: string; readonly details: Record<string, unknown>;
  readonly decidedBy?: string; readonly decisionReason?: string;
}
export interface DocumentForm { readonly kind: string; readonly reference: string; readonly validFrom: string; readonly validUntil: string; readonly seenNow: boolean }
export interface BankForm { readonly account: string; readonly via: string; readonly arrivedOn: string; readonly calledBack: string; readonly heldNumber: string; readonly why: string }

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'cannotBank' | 'cannotHold' | 'needSupplier' | 'needDoc' | 'needBank' | 'fullNumber'
  | 'notTheHeldNumber' | 'needWhy' | 'noRecord' | 'alreadyChecked';
type Done<T = Record<string, unknown>> = Promise<Outcome<T, Why>>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: string): boolean => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const seg = (s: string): string => encodeURIComponent(s.trim());

/** PRV (packages/bank-controls): no raw account number is typed or stored — a run of nine or more digits reads as one. */
export const looksLikeAFullAccountNumber = (typed: string): boolean => /\d{9,}/.test(typed.replace(/[\s-]/g, ''));

/** The bank change exactly as the bank-details route reads it (and the approval is asked for), or the word key of what is wrong. */
export function bankChangeBody(f: BankForm): { readonly body: Record<string, string> } | { readonly why: Why } {
  const account = f.account.trim(); const arrivedOn = f.arrivedOn.trim(); const calledBack = f.calledBack.trim(); const held = f.heldNumber.trim();
  if (account === '' || !(REQUESTED_VIA as readonly string[]).includes(f.via) || !isDay(arrivedOn) || calledBack === '' || held === '' || f.why.trim() === '') return { why: 'needBank' };
  if (looksLikeAFullAccountNumber(account)) return { why: 'fullNumber' };
  // Head office refuses this too (`called_back_on_the_number_they_supplied`); said here before anything is asked.
  if (calledBack !== held) return { why: 'notTheHeldNumber' };
  return { body: { newAccount: account, requestedVia: f.via, requestedAt: arrivedOn, calledBackOn: calledBack, numberWeAlreadyHeld: held } };
}

/** A paper from the form, or the word key of what is wrong. */
export function documentFrom(f: DocumentForm, documentId: string, viewer: string): SupplierDocumentView | { readonly why: Why } {
  const reference = f.reference.trim(); const from = f.validFrom.trim(); const until = f.validUntil.trim();
  if (!(DOCUMENT_KINDS as readonly string[]).includes(f.kind) || reference === '' || !isDay(from) || !isDay(until) || until < from) return { why: 'needDoc' };
  return { documentId, kind: f.kind as DocumentKind, reference, validFrom: from, validUntil: until, ...(f.seenNow ? { verifiedBy: viewer } : {}) };
}

/** The upsert body: the record as stored, its papers as stored, with `documents` replacing them. */
function recordBody(r: SupplierRecordView, documents: readonly SupplierDocumentView[]): Record<string, unknown> {
  return {
    name: r.name, gstin: r.gstin, phone: r.phone, email: r.email, address: r.address, paymentTermsDays: r.paymentTermsDays,
    documents: documents.map((d) => ({ documentId: d.documentId, kind: d.kind, reference: d.reference, validFrom: d.validFrom, validUntil: d.validUntil, ...(d.verifiedBy === undefined ? {} : { verifiedBy: d.verifiedBy }) })),
  };
}

export const supplierRecordsOutcomeWords = (lang: Lang, out: Outcome<unknown>, good: string): string =>
  out.result !== 'ok' ? outcomeIn((k) => supplierRecordsWords(lang, k), out) : supplierRecordsWords(lang, good);

export interface SupplierRecordsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean; readonly bank: boolean; readonly hold: boolean };
  detail(supplierId: string): Done<SupplierDetail>;
  addDocument(supplierId: string, f: DocumentForm): Done<{ readonly supplier: SupplierRecordView }>;
  verifyDocument(supplierId: string, documentId: string): Done<{ readonly supplier: SupplierRecordView }>;
  askBankChange(supplierId: string, f: BankForm): Done<{ readonly requestId: string }>;
  /** The bank changes this person asked for, as head office's approvals engine holds them — each with where it stands. */
  myBankAsks(): Done<readonly BankAsk[]>;
  /** Record an APPROVED change, naming its approval; the details are the approved request's own. */
  recordBankChange(ask: BankAsk): Done<{ readonly changed: string }>;
  setHold(supplierId: string, blocked: boolean, why: string): Done<{ readonly supplierId: string; readonly blocked: boolean }>;
}

export function createSupplierRecordsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newId?: (prefix: string) => string;
}): SupplierRecordsSession {
  const userId = input.viewer?.userId;
  const named = userId !== undefined && userId.trim() !== '';
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, read: named && held.has('supplier.view'), manage: named && held.has('purchase.supplier.manage'),
    bank: named && held.has('purchase.supplier.bank'), hold: named && held.has('purchase.supplier.block'),
  };
  const call = makeCaller({ keyPrefix: 'supplier-records', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const idOf = input.newId ?? newId;
  const NEED: Readonly<Record<'read' | 'manage' | 'bank' | 'hold', Why>> = { read: 'cannotRead', manage: 'cannotManage', bank: 'cannotBank', hold: 'cannotHold' };
  const gate = (...need: readonly ('read' | 'manage' | 'bank' | 'hold')[]): { result: 'invalid'; why: Why } | undefined => {
    if (!named) return { result: 'invalid', why: 'nobody' };
    const missing = need.find((n) => !may[n]);
    return missing === undefined ? undefined : { result: 'invalid', why: NEED[missing] };
  };
  const detail = (supplierId: string): Done<SupplierDetail> => call<SupplierDetail>('GET', `/v1/purchase/suppliers/${seg(supplierId)}`);
  /** Read the record now (never a copy from earlier), then send it back with the papers changed as `change` says. */
  const withDocuments = async (supplierId: string, change: (docs: readonly SupplierDocumentView[]) => readonly SupplierDocumentView[] | Why): Done<{ readonly supplier: SupplierRecordView }> => {
    const read = await detail(supplierId);
    if (read.result !== 'ok') return read;
    const record = read.value.supplier;
    if (record === null) return { result: 'invalid', why: 'noRecord' };
    const docs = change(record.documents);
    if (typeof docs === 'string') return { result: 'invalid', why: docs };
    return call('POST', `/v1/purchase/suppliers/${seg(supplierId)}`, recordBody(record, docs));
  };
  return {
    may,
    detail: async (supplierId) => gate('read') ?? (supplierId.trim() === '' ? { result: 'invalid', why: 'needSupplier' } : detail(supplierId)),
    addDocument: async (supplierId, f) => {
      const no = gate('read', 'manage'); if (no !== undefined) return no;
      if (supplierId.trim() === '') return { result: 'invalid', why: 'needSupplier' };
      const doc = documentFrom(f, idOf('doc'), userId!);
      if ('why' in doc) return { result: 'invalid', why: doc.why };
      return withDocuments(supplierId, (docs) => [...docs, doc]);
    },
    verifyDocument: async (supplierId, documentId) => {
      const no = gate('read', 'manage'); if (no !== undefined) return no;
      return withDocuments(supplierId, (docs) => {
        const doc = docs.find((d) => d.documentId === documentId);
        if (doc === undefined) return 'needDoc';
        if (doc.verifiedBy !== undefined) return 'alreadyChecked';
        return docs.map((d) => (d.documentId === documentId ? { ...d, verifiedBy: userId! } : d));
      });
    },
    askBankChange: async (supplierId, f) => {
      const no = gate('bank'); if (no !== undefined) return no;
      if (supplierId.trim() === '') return { result: 'invalid', why: 'needSupplier' };
      const made = bankChangeBody(f);
      if ('why' in made) return { result: 'invalid', why: made.why };
      const id = supplierId.trim();
      // The engine fingerprints exactly what the bank-details route will compare: its body plus the supplier from the path.
      return call<{ requestId: string }>('POST', '/v1/approvals/requests', {
        kind: 'supplier_bank_change', subjectRef: id, details: { ...made.body, supplierId: id }, valueMinor: null,
        summary: `Pay supplier ${id} to account ${made.body['newAccount']} (asked by ${made.body['requestedVia']} on ${made.body['requestedAt']}; rang back on the number we held)`,
        reason: f.why.trim(),
      });
    },
    myBankAsks: async () => {
      const no = gate('bank'); if (no !== undefined) return no;
      const out = await call<{ mine?: readonly (BankAsk & { readonly kind: string })[] }>('GET', '/v1/approvals/requests');
      if (out.result !== 'ok') return out;
      return { result: 'ok', value: (out.value.mine ?? []).filter((q) => q.kind === 'supplier_bank_change') };
    },
    recordBankChange: async (ask) => {
      const no = gate('bank'); if (no !== undefined) return no;
      const body = Object.fromEntries(Object.entries(ask.details).filter(([k]) => k !== 'supplierId'));
      return call('POST', `/v1/purchase/suppliers/${seg(ask.subjectRef)}/bank-details`, { ...body, approvalId: ask.requestId });
    },
    setHold: async (supplierId, blocked, why) => {
      const no = gate('hold'); if (no !== undefined) return no;
      if (supplierId.trim() === '') return { result: 'invalid', why: 'needSupplier' };
      if (why.trim() === '') return { result: 'invalid', why: 'needWhy' };
      return call('POST', `/v1/purchase/suppliers/${seg(supplierId)}/block-status`, { blocked, reason: why.trim() });
    },
  };
}
