// GST credit and debit notes to business customers — the section on the Business customers page (M23-FR-02 · OB-678 ·
// OB-290 · §28 · P-04 · P-08 · hard rules #2 #10). A tested, DOM-free THIN client over head office's own routes
// (services/finance/src/credit-notes.ts):
//
//   • THE CUSTOMER'S TAX INVOICES (`GET /v1/finance/credit-notes/customers/:customerId`) — each line with what it charged,
//     what credit notes already took off it and what is left; and the notes already issued, each with where it stands in
//     the books (posted, or waiting for the accountant's posting rule — never silent);
//   • A DEBIT NOTE (`POST /v1/finance/credit-notes`) — issued at once: OB-678 sets no approval for a note that adds;
//   • A CREDIT NOTE — money back, a refund under the money limits (OB-290): head office works it out first
//     (`POST …/preview`, the whole value with its GST), the person asks a second person to approve EXACTLY that
//     (`POST /v1/approvals/requests`), and once it is approved issues it naming the approval. The store manager approves up
//     to his refund limit, the owner any amount; nobody approves their own.
//
// The page never sends invoice figures: head office looks the invoice up and works every rupee of tax from it. Nothing is
// read on open; every call is a click.

import { makeCaller, newId, outcomeIn, type Outcome } from './r4-insight-call';
import { paiseOfRupees } from './b2b-transfer-notes-session';

export type Lang = 'en' | 'ta';

export const B2B_NOTES_COPY = {
  en: {
    h: 'GST credit and debit notes', lead: 'A note corrects a business customer\'s tax invoice without changing it: a credit note takes value and its GST off (goods back, a price charged too high), a debit note adds them. Head office works the tax out from the invoice it holds. A credit note is money back, so a second person approves it first — the store manager up to ₹5,000, the owner any amount.',
    show: 'Show this customer\'s invoices and notes', invoicesNone: 'This customer has no tax invoice yet — a note is raised only against a business tax invoice.',
    charged: 'charged', credited: 'credited', left: 'left to credit', noSplit: 'This invoice carries no CGST / SGST / IGST split, so no note can be worked out for it.',
    kindL: 'Kind of note', kind_credit_note: 'Credit note (takes off)', kind_debit_note: 'Debit note (adds)',
    reasonL: 'Reason', reason_goods_returned: 'Goods returned', reason_deficiency_in_service: 'Service problem', reason_post_supply_discount: 'Discount agreed after the sale',
    reason_price_correction: 'Wrong price charged', reason_tax_rate_correction: 'Wrong tax rate applied', reason_order_cancelled: 'Order cancelled',
    lineValueL: 'Value on this line (₹, before GST)', askCredit: 'Work it out and ask for approval', issueDebit: 'Issue the debit note',
    askedNow: 'Asked for approval. A second person approves it in their own Approvals inbox; then come back and issue it.',
    issuedNow: 'Issued. The invoice is unchanged; the customer\'s balance has moved.',
    askedH: 'Credit notes you asked approval for', waiting: 'waiting for approval', approved: 'approved', rejected: 'rejected', used: 'issued', expired: 'approval expired',
    issueApproved: 'Issue the approved credit note', approvedBy: 'approved by', rejectedBy: 'rejected by',
    notesH: 'Notes issued', notesNone: 'No note has been issued to this customer.', against: 'against', tax: 'GST',
    posting_posted: 'In the books', posting_waiting_for_posting_rule: 'Waiting for the accountant\'s posting rule — nothing is in the books yet', posting_not_posted_yet: 'Rule written — reaches the books on the next posting run',
    notInWindow: 'issued after the GST time limit — no tax adjustment',
    needCustomer: 'Open a customer first.', needLines: 'Write a value in rupees on at least one line.', needReason: 'Choose the reason.',
    nobody: 'Nobody is signed in on this screen.', cannotIssue: 'Your role cannot issue credit or debit notes.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    h: 'GST வரவு மற்றும் பற்றுக் குறிப்புகள்', lead: 'ஒரு குறிப்பு வணிக வாடிக்கையாளரின் வரி விலைப்பட்டியலை மாற்றாமல் திருத்துகிறது: வரவுக் குறிப்பு மதிப்பையும் அதன் GST-யையும் குறைக்கிறது (பொருள் திரும்பியது, அதிக விலை வசூலித்தது), பற்றுக் குறிப்பு அவற்றைக் கூட்டுகிறது. தலைமை அலுவலகம் தன்னிடம் உள்ள விலைப்பட்டியலிலிருந்து வரியைக் கணக்கிடுகிறது. வரவுக் குறிப்பு திருப்பித் தரும் பணம், எனவே முதலில் இரண்டாவது நபர் அனுமதிக்க வேண்டும் — கடை மேலாளர் ₹5,000 வரை, உரிமையாளர் எந்தத் தொகையும்.',
    show: 'இந்த வாடிக்கையாளரின் விலைப்பட்டியல்களும் குறிப்புகளும் காட்டு', invoicesNone: 'இந்த வாடிக்கையாளருக்கு இன்னும் வரி விலைப்பட்டியல் இல்லை — குறிப்பு வணிக வரி விலைப்பட்டியலுக்கு எதிராக மட்டுமே.',
    charged: 'வசூலித்தது', credited: 'வரவு வைத்தது', left: 'வரவு வைக்க மீதம்', noSplit: 'இந்த விலைப்பட்டியலில் CGST / SGST / IGST பிரிவு இல்லை, எனவே இதற்குக் குறிப்பு கணக்கிட முடியாது.',
    kindL: 'குறிப்பின் வகை', kind_credit_note: 'வரவுக் குறிப்பு (குறைக்கும்)', kind_debit_note: 'பற்றுக் குறிப்பு (கூட்டும்)',
    reasonL: 'காரணம்', reason_goods_returned: 'பொருள் திரும்பியது', reason_deficiency_in_service: 'சேவைக் குறைபாடு', reason_post_supply_discount: 'விற்பனைக்குப் பின் ஒப்புக்கொண்ட தள்ளுபடி',
    reason_price_correction: 'தவறான விலை வசூலித்தது', reason_tax_rate_correction: 'தவறான வரி விகிதம்', reason_order_cancelled: 'ஆர்டர் ரத்து',
    lineValueL: 'இந்த வரியில் மதிப்பு (₹, GST இல்லாமல்)', askCredit: 'கணக்கிட்டு அனுமதி கேள்', issueDebit: 'பற்றுக் குறிப்பை வெளியிடு',
    askedNow: 'அனுமதி கேட்கப்பட்டது. இரண்டாவது நபர் தன் அனுமதிப் பெட்டியில் அனுமதிப்பார்; பிறகு இங்கே வந்து வெளியிடுங்கள்.',
    issuedNow: 'வெளியிடப்பட்டது. விலைப்பட்டியல் மாறவில்லை; வாடிக்கையாளரின் நிலுவை மாறியது.',
    askedH: 'நீங்கள் அனுமதி கேட்ட வரவுக் குறிப்புகள்', waiting: 'அனுமதிக்காகக் காத்திருக்கிறது', approved: 'அனுமதிக்கப்பட்டது', rejected: 'நிராகரிக்கப்பட்டது', used: 'வெளியிடப்பட்டது', expired: 'அனுமதி காலாவதியானது',
    issueApproved: 'அனுமதிக்கப்பட்ட வரவுக் குறிப்பை வெளியிடு', approvedBy: 'அனுமதித்தவர்', rejectedBy: 'நிராகரித்தவர்',
    notesH: 'வெளியிட்ட குறிப்புகள்', notesNone: 'இந்த வாடிக்கையாளருக்கு எந்தக் குறிப்பும் வெளியிடவில்லை.', against: 'எதிராக', tax: 'GST',
    posting_posted: 'கணக்கில் பதிவானது', posting_waiting_for_posting_rule: 'கணக்காளரின் பதிவு விதிக்காகக் காத்திருக்கிறது — இன்னும் கணக்கில் எதுவும் இல்லை', posting_not_posted_yet: 'விதி எழுதப்பட்டது — அடுத்த பதிவு ஓட்டத்தில் கணக்கில் சேரும்',
    notInWindow: 'GST கால வரம்புக்குப் பின் வெளியிட்டது — வரிச் சரிசெய்தல் இல்லை',
    needCustomer: 'முதலில் ஒரு வாடிக்கையாளரைத் திறக்கவும்.', needLines: 'குறைந்தது ஒரு வரியில் ரூபாயில் மதிப்பை எழுதுங்கள்.', needReason: 'காரணத்தைத் தேர்ந்தெடுக்கவும்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotIssue: 'உங்கள் பணி வரவு அல்லது பற்றுக் குறிப்புகளை வெளியிட முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const notesWords = (lang: Lang, key: string): string =>
  (B2B_NOTES_COPY[lang] as Record<string, string>)[key] ?? (B2B_NOTES_COPY.en as Record<string, string>)[key] ?? key;

export const NOTE_REASONS = ['goods_returned', 'deficiency_in_service', 'post_supply_discount', 'price_correction', 'tax_rate_correction', 'order_cancelled'] as const;
export type NoteReason = (typeof NOTE_REASONS)[number];
export type NoteKindChoice = 'credit_note' | 'debit_note';

export interface InvoiceForNotes {
  readonly documentId: string; readonly number: string; readonly issuedOn: string; readonly grossMinor: number; readonly recipientGstin?: string;
  readonly hasGstSplit: boolean;
  readonly lines: readonly { readonly lineId: string; readonly description: string; readonly qty: number; readonly rateBps: number; readonly chargedMinor: number; readonly creditedMinor: number; readonly leftMinor: number }[];
}
export interface IssuedNote {
  readonly noteId: string; readonly number: string; readonly kind: NoteKindChoice; readonly againstInvoiceNumber: string; readonly issuedOn: string;
  readonly reason: NoteReason; readonly taxableMinor: number; readonly taxMinor: number; readonly grossMinor: number; readonly taxAdjustable: boolean;
  readonly issuedBy?: string; readonly approvedBy?: string;
  readonly posting: { readonly state: 'posted' | 'waiting_for_posting_rule' | 'not_posted_yet'; readonly entryId?: string };
}
export interface CustomerNotesView { readonly customerId: string; readonly invoices: readonly InvoiceForNotes[]; readonly notes: readonly IssuedNote[]; readonly asAt: string }
export interface AskedNote {
  readonly requestId: string; readonly kind: string; readonly subjectRef: string; readonly status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'used';
  readonly valueMinor: number | null; readonly summary: string; readonly details: Readonly<Record<string, unknown>>;
  readonly decidedBy?: string; readonly decisionReason?: string;
}
export interface NoteForm {
  readonly kind: NoteKindChoice; readonly customerId: string; readonly invoiceDocumentId: string; readonly reason: string;
  /** lineId → rupees typed (blank = not on this note). */
  readonly rupeesByLine: Readonly<Record<string, string>>;
}

type Why = 'nobody' | 'cannotIssue' | 'needCustomer' | 'needLines' | 'needReason';
type Done<T> = Promise<Outcome<T, Why>>;

/** The body head office reads — a note id, the invoice by its id and each line's value in paise. Never invoice figures. */
export function noteBody(f: NoteForm, noteId: string): { readonly body: Record<string, unknown> } | { readonly why: Why } {
  if (f.customerId.trim() === '' || f.invoiceDocumentId.trim() === '') return { why: 'needCustomer' };
  if (!(NOTE_REASONS as readonly string[]).includes(f.reason)) return { why: 'needReason' };
  const lines: { lineId: string; taxableMinor: number }[] = [];
  for (const [lineId, typed] of Object.entries(f.rupeesByLine)) {
    if (typed.trim() === '') continue;
    const minor = paiseOfRupees(typed);
    if (minor === null) return { why: 'needLines' };
    lines.push({ lineId, taxableMinor: minor });
  }
  if (lines.length === 0) return { why: 'needLines' };
  return { body: { noteId, kind: f.kind, customerId: f.customerId.trim(), invoiceDocumentId: f.invoiceDocumentId.trim(), reason: f.reason, lines } };
}

export const notesOutcomeWords = (lang: Lang, out: Outcome<unknown>, good: string): string =>
  out.result === 'ok' ? notesWords(lang, good) : outcomeIn((k) => notesWords(lang, k), out);

export interface NotesSession {
  readonly may: { readonly named: boolean; readonly issue: boolean };
  read(customerId: string): Done<CustomerNotesView>;
  /** The credit notes this person asked approval for (the engine's own list of their requests). */
  asked(): Done<readonly AskedNote[]>;
  /** A debit note is issued at once; a credit note is worked out and a second person's approval of exactly it is asked. */
  raise(f: NoteForm): Done<{ readonly asked?: string; readonly number?: string }>;
  /** Issue the credit note an approved request is for — exactly what was asked. */
  issueApproved(request: AskedNote): Done<{ readonly number?: string }>;
}

export function createNotesSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newNoteId?: () => string;
}): NotesSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, issue: named && (input.viewer?.permissions ?? []).includes('finance.creditnote.issue') };
  const call = makeCaller({ keyPrefix: 'b2b-notes', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const gate = (): { result: 'invalid'; why: Why } | undefined => (!named ? { result: 'invalid', why: 'nobody' } : !may.issue ? { result: 'invalid', why: 'cannotIssue' } : undefined);
  const noteId = input.newNoteId ?? (() => newId('N'));
  return {
    may,
    read: async (customerId) => {
      const no = gate(); if (no !== undefined) return no;
      if (customerId.trim() === '') return { result: 'invalid', why: 'needCustomer' };
      return call('GET', `/v1/finance/credit-notes/customers/${encodeURIComponent(customerId.trim())}`);
    },
    asked: async () => {
      const no = gate(); if (no !== undefined) return no;
      const r = await call<{ mine?: AskedNote[] }>('GET', '/v1/approvals/requests');
      if (r.result !== 'ok') return r;
      return { result: 'ok', value: (r.value.mine ?? []).filter((q) => q.kind === 'customer_credit_note') };
    },
    raise: async (f) => {
      const no = gate(); if (no !== undefined) return no;
      const read = noteBody(f, noteId());
      if ('why' in read) return { result: 'invalid', why: read.why };
      if (f.kind === 'debit_note') {
        const r = await call<{ number: string }>('POST', '/v1/finance/credit-notes', read.body);
        return r.result === 'ok' ? { result: 'ok', value: { number: r.value.number } } : r;
      }
      // A credit note: head office works it out first; the approval asked is for exactly that note and its whole value.
      const p = await call<{ approval: { kind: string; subjectRef: string; valueMinor: number; details: Record<string, unknown>; summary: string } }>('POST', '/v1/finance/credit-notes/preview', read.body);
      if (p.result !== 'ok') return p;
      const a = p.value.approval;
      const asked = await call<{ requestId: string }>('POST', '/v1/approvals/requests', {
        kind: a.kind, subjectRef: a.subjectRef, valueMinor: a.valueMinor, details: a.details, summary: a.summary,
        reason: `GST credit note — ${f.reason.replace(/_/g, ' ')}`,
      });
      return asked.result === 'ok' ? { result: 'ok', value: { asked: asked.value.requestId } } : asked;
    },
    issueApproved: async (request) => {
      const no = gate(); if (no !== undefined) return no;
      const r = await call<{ number: string }>('POST', '/v1/finance/credit-notes', { ...request.details, approvalId: request.requestId });
      return r.result === 'ok' ? { result: 'ok', value: { number: r.value.number } } : r;
    },
  };
}
