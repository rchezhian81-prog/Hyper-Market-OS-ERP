// API-09 Finance — GST credit notes and debit notes to business customers (M23-FR-02 · OB-678 · CGST s.34 · OB-290 ·
// §28 · P-04 · P-08 · hard rules #2 #5 #10).
//
// OB-678 (owner, 2 Nov 2026, in writing): a note is raised ONLY against a business (B2B) tax invoice head office itself
// issued — a till bill's return stays on the till's own return and refund (WF-11). So this surface never takes an invoice
// from the request: it LOOKS UP the stored tax invoice by customer and document id, and works every figure from it (the
// lines, the rate, the CGST / SGST / IGST split it charged), through the tested engine `packages/finance/src/customer-notes.ts`.
// A request that still carries an `invoice` is refused by name. The invoice itself is never changed (hard rule #2): a note
// is its own document, with its own number, from its own gap-free series — customer credit notes (CN-) and customer debit
// notes (CDN-), apart from the supplier debit note (DN-) — drawn only once the note would issue.
//
// A CREDIT note is money back to the customer, so it counts as a REFUND under the owner's money limits (OB-290 · OB-678):
// it is issued only on an approval of exactly it (kind `customer_credit_note`, the amount = the note's whole value) given
// by a second person in their own session — the store manager up to his refund limit (₹5,000), the owner without limit; the
// accountant has no figure set, so above another approver's limit it waits for the owner. Nobody approves their own note.
// OB-679 (owner, 2 Nov 2026, in writing): a credit note the OWNER raises himself is approved by the accountant at any amount
// (the OB-613 pattern); and EVERY DEBIT note needs a second, different person's approval too (kind `customer_debit_note`),
// at any amount — no money ladder. One approval issues one note.
//
// Issuing a note writes, in ONE batch (services/api/src/adapters.ts): the note itself, the movement on the customer's AR
// ledger, and a fact for the books (`b2b:credit_note` / `b2b:debit_note`) that the accountant's existing B2B posting run
// turns into a journal through HIS posting rule. No account is ever suggested for a note: with no rule written, the note
// posts nothing and every read says "waiting for the accountant's posting rule" (the CA signs off C-01) — never silent.
// The period's notes appear in the GSTR-1 data as their own credit/debit-note section (services/finance/src/gst-returns.ts).

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  customerNoteAgainstInvoice, isCustomerNote, reconcileNotes,
  type CreditNote, type CreditReason, type CustomerNote, type NoteInvoice, type NoteKind, type NoteLineAsked,
} from '../../../packages/finance/src/index';
import { formatNumber, type NumberFormat } from '../../../packages/numbering/src/numbering';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { actionDetails, openApproval, NO_APPROVALS, type ApprovalPort } from '../../identity/src/approval-requests';
import type { StoredB2BDocument } from './b2b-documents';

const REASONS: readonly CreditReason[] = [
  'goods_returned', 'deficiency_in_service', 'post_supply_discount',
  'price_correction', 'tax_rate_correction', 'order_cancelled',
];
const KINDS: readonly NoteKind[] = ['credit_note', 'debit_note'];

/** OB-678: each kind of note to a customer draws from its OWN gap-free series, apart from the supplier debit note (DN). */
export const CUSTOMER_NOTE_SERIES: Readonly<Record<NoteKind, string>> = Object.freeze({ credit_note: 'customer_credit_note', debit_note: 'customer_debit_note' });
export const CUSTOMER_NOTE_FORMAT: Readonly<Record<NoteKind, NumberFormat>> = Object.freeze({ credit_note: { prefix: 'CN-', padTo: 6 }, debit_note: { prefix: 'CDN-', padTo: 6 } });
/** The approval kind a credit note is issued on (OB-290 refund limits). */
export const CREDIT_NOTE_APPROVAL_KIND = 'customer_credit_note';
/** OB-679: the approval kind each note is issued on — a credit note under the refund ladder, a debit note at any amount. */
export const NOTE_APPROVAL_KIND: Readonly<Record<NoteKind, string>> = Object.freeze({ credit_note: CREDIT_NOTE_APPROVAL_KIND, debit_note: 'customer_debit_note' });
/** What the approval is about — one note of one customer. */
export const creditNoteSubjectRef = (customerId: string, noteId: string): string => `credit-note:${customerId}/${noteId}`;
export const noteSubjectRef = (kind: NoteKind, customerId: string, noteId: string): string =>
  kind === 'credit_note' ? creditNoteSubjectRef(customerId, noteId) : `debit-note:${customerId}/${noteId}`;

/** Where a note stands in the books. */
export type NotePosting =
  | { readonly state: 'posted'; readonly entryId: string; readonly period: string }
  | { readonly state: 'waiting_for_posting_rule'; readonly why: string }
  | { readonly state: 'not_posted_yet'; readonly why: string };

/** The fact a note is filed under for the books, the same shape as a B2B invoice's (`invoice:<customer>:<doc>`). */
export const notePostableSourceId = (note: Pick<CustomerNote, 'kind' | 'customerId' | 'noteId'>): string => `${note.kind}:${note.customerId}:${note.noteId}`;

export interface CreditNoteDeps {
  /** Every credit/debit note issued, folded from the CreditNoteIssued events (the period reconciliation reads these). */
  readonly notes: (tenantId: string) => Promise<readonly CreditNote[]> | readonly CreditNote[];
  /** The business tax invoice head office holds, by customer and document id — the ONLY source a note is worked from. */
  readonly businessInvoice?: (tenantId: string, customerId: string, documentId: string) => Promise<StoredB2BDocument | undefined> | StoredB2BDocument | undefined;
  /** A customer's business documents (their tax invoices are what a note may be raised against). */
  readonly businessDocuments?: (tenantId: string, customerId: string) => Promise<readonly StoredB2BDocument[]> | readonly StoredB2BDocument[];
  /** Write the note, its AR movement and its fact for the books in ONE batch. Idempotent on the note id. */
  readonly recordCustomerNote?: (tenantId: string, note: CustomerNote, issuedBy: string) => Promise<void> | void;
  /** Draw the next gap-free number of a series. Called ONLY once the note would issue. */
  readonly allocateNumber?: (tenantId: string, series: string) => Promise<number> | number;
  /** The maker-checker engine (OB-290). Absent: no approval is ever found, so no credit note issues. */
  readonly approvals?: ApprovalPort;
  /** Where the books stand: the posting rules in force (kinds only) and the B2B facts already journalled. */
  readonly postingState?: (tenantId: string) => Promise<{ readonly ruleKinds: readonly string[] | undefined; readonly journals: readonly { readonly sourceId: string; readonly entryId: string; readonly period: string }[] }>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

interface Asked {
  readonly noteId: string;
  readonly kind: NoteKind;
  readonly customerId: string;
  readonly invoiceDocumentId: string;
  readonly reason: CreditReason;
  readonly lines: readonly NoteLineAsked[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const NOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Read the request as a note to work out, or refuse it (400) — and refuse an invoice carried in the body by name. */
function readAsked(body: unknown): Asked {
  const b = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (b['invoice'] !== undefined) {
    throw apiError(422, {
      code: 'invoice_is_looked_up',
      whatHappened: 'The request carried the invoice itself. Head office never takes an invoice from a request: it looks up the business tax invoice it holds and works the note from that (OB-678).',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Send the customer, the invoice\'s document id (invoiceDocumentId) and the lines with the value on each — no invoice figures. Nothing was issued and the invoice is unchanged.',
    });
  }
  const lines = Array.isArray(b['lines']) ? b['lines'] : undefined;
  const read = lines?.map((l) => {
    const r = (l !== null && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    return isStr(r['lineId']) && Number.isSafeInteger(r['taxableMinor']) ? { lineId: (r['lineId'] as string).trim(), taxableMinor: r['taxableMinor'] as number } : null;
  });
  if (!isStr(b['noteId']) || !NOTE_ID.test(b['noteId'].trim()) || !KINDS.includes(b['kind'] as NoteKind) || !isStr(b['customerId']) || !isStr(b['invoiceDocumentId'])
    || read === undefined || read.some((l) => l === null)) {
    throw apiError(400, {
      code: 'not_readable_as_a_note',
      whatHappened: 'A note needs its own id (noteId), its kind (credit_note or debit_note), the customer, the business tax invoice\'s document id (invoiceDocumentId), a reason and the lines — each a line id of that invoice and the taxable value on it in whole paise.',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Send the note in that shape. Nothing was issued.',
    });
  }
  if (!REASONS.includes(b['reason'] as CreditReason)) {
    throw apiError(422, {
      code: 'no_reason',
      whatHappened: 'A note needs a reason — it says whose conversation the change is (returns, pricing, the tax setup …).',
      wasItSaved: 'not_saved',
      nextSafeAction: `Send one of: ${REASONS.join(', ')}. Nothing was issued.`,
    });
  }
  return {
    noteId: (b['noteId'] as string).trim(), kind: b['kind'] as NoteKind, customerId: (b['customerId'] as string).trim(),
    invoiceDocumentId: (b['invoiceDocumentId'] as string).trim(), reason: b['reason'] as CreditReason, lines: read as NoteLineAsked[],
  };
}

/** The stored tax invoice as the engine reads it — its own date in the shop, its split, its buyer's GSTIN. */
export function noteInvoiceOf(doc: StoredB2BDocument): NoteInvoice {
  return {
    documentId: doc.documentId, number: doc.number, customerId: doc.customerId, issuedOn: shopDateIn(doc.issuedAt),
    lines: doc.lines,
    ...(doc.gst === undefined ? {} : { gst: { placeOfSupply: doc.gst.placeOfSupply, deliveryStateCode: doc.gst.deliveryStateCode, lines: doc.gst.lines } }),
    ...(doc.buyer === undefined ? {} : { recipientGstin: doc.buyer.gstin }),
  };
}

export function creditNoteRoutes(deps: CreditNoteDeps): readonly Route[] {
  const customerNotes = async (t: string): Promise<readonly CustomerNote[]> => (await deps.notes(t)).filter(isCustomerNote);

  /** Look the invoice up and work the note out under `number` — or refuse it by name. Writes nothing. */
  const workOut = async (ctx: RequestContext, a: Asked, number: string): Promise<{ readonly note: CustomerNote; readonly invoice: StoredB2BDocument }> => {
    const doc = await deps.businessInvoice?.(ctx.tenantId, a.customerId, a.invoiceDocumentId);
    if (doc === undefined || doc.kind !== 'tax_invoice') {
      throw apiError(404, {
        code: 'not_a_business_tax_invoice',
        whatHappened: `Head office holds no business tax invoice "${a.invoiceDocumentId}" for customer ${a.customerId}. A GST credit or debit note is raised only against a business tax invoice head office issued (OB-678); a till bill's return is refunded at the till (WF-11).`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Pick the invoice from the customer\'s tax invoices on the Business customers page. Nothing was issued.',
      });
    }
    const earlier = (await customerNotes(ctx.tenantId)).filter((n) => n.customerId === a.customerId && n.invoiceDocumentId === doc.documentId && n.noteId !== a.noteId);
    const result = customerNoteAgainstInvoice({
      noteId: a.noteId, number, kind: a.kind, invoice: noteInvoiceOf(doc), customerId: a.customerId, reason: a.reason,
      lines: a.lines, earlier, issuedOn: shopDateIn(deps.now()),
    });
    if (!result.issued || result.note === undefined) {
      throw apiError(422, {
        code: result.outcome,
        whatHappened: result.detail,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Nothing was issued, no number was drawn and the invoice is unchanged — a note never edits it. Correct the note and send it again.',
      });
    }
    return { note: result.note, invoice: doc };
  };

  const approvalAsk = (ctx: RequestContext, a: Asked, note: CustomerNote) => ({
    kind: NOTE_APPROVAL_KIND[a.kind], subjectRef: noteSubjectRef(a.kind, a.customerId, a.noteId), valueMinor: note.grossMinor,
    details: actionDetails(ctx.body), summary: `${a.kind === 'credit_note' ? 'Credit' : 'Debit'} note to ${a.customerId} against ${note.againstInvoiceNumber}: ₹${(note.grossMinor / 100).toFixed(2)} (${a.reason.replace(/_/g, ' ')})`,
  });

  const postingOf = async (t: string): Promise<(n: CustomerNote) => NotePosting> => {
    const s = await deps.postingState?.(t);
    const posted = new Map((s?.journals ?? []).map((j) => [j.sourceId, j] as const));
    const rules = s?.ruleKinds;
    return (n) => {
      const j = posted.get(notePostableSourceId(n));
      if (j !== undefined) return { state: 'posted', entryId: j.entryId, period: j.period };
      const kind = `b2b:${n.kind}`;
      if (rules === undefined || !rules.includes(kind)) {
        return { state: 'waiting_for_posting_rule', why: `No posting rule for "${kind}" is written yet, so this note posts nothing to the books. Which accounts a note reverses is the accountant's rule, signed off by the CA (C-01).` };
      }
      return { state: 'not_posted_yet', why: 'The posting rule is written; the note reaches the books on the accountant\'s next B2B posting run.' };
    };
  };

  return [
    {
      // Work a note out WITHOUT issuing it: the figures head office would issue, and — for a credit note — exactly what to ask
      // approval for (the amount is the note's whole value). Writes nothing; draws no number.
      api: 'API-09', method: 'POST', path: '/v1/finance/credit-notes/preview',
      permission: 'finance.creditnote.issue', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const a = readAsked(ctx.body);
        const { note } = await workOut(ctx, a, '(numbered when issued)');
        return {
          status: 200,
          // OB-678 · OB-679: every note — credit or debit — is issued only on a second person's approval of exactly it.
          body: { note, needsApproval: true, approval: approvalAsk(ctx, a, note) },
        };
      },
    },
    {
      // Issue a credit (or debit) note against a business tax invoice head office holds. Idempotent on the note id: a resend
      // of the same note is the same note, never a second credit.
      api: 'API-09', method: 'POST', path: '/v1/finance/credit-notes',
      permission: 'finance.creditnote.issue', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const a = readAsked(ctx.body);
        const t = ctx.tenantId;
        const already = (await customerNotes(t)).find((n) => n.noteId === a.noteId);
        if (already !== undefined) {
          if (already.customerId !== a.customerId || already.invoiceDocumentId !== a.invoiceDocumentId || already.kind !== a.kind) {
            throw apiError(409, {
              code: 'note_id_in_use', whatHappened: `Note id ${a.noteId} is already ${already.number}, against ${already.againstInvoiceNumber} for ${already.customerId}.`,
              wasItSaved: 'not_saved', nextSafeAction: 'Use a new note id for a new note. Nothing was issued.',
            });
          }
          return { status: 200, body: { note: already, alreadyIssued: true } };
        }
        if (deps.recordCustomerNote === undefined || deps.allocateNumber === undefined) {
          throw apiError(503, { code: 'notes_not_wired', whatHappened: 'Head office is not keeping notes here.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was issued.' });
        }
        // Validate WITHOUT drawing a number — a refused note must leave no gap in the series.
        const probe = await workOut(ctx, a, '(probe)');

        // OB-678 · OB-290: a credit note is a refund; OB-679: a debit note needs a second person too, at any amount. Either is
        // issued only on a second person's approval of exactly it.
        const approvalId = (ctx.body as Record<string, unknown>)['approvalId'];
        const ask = approvalAsk(ctx, a, probe.note);
        if (!isStr(approvalId)) {
          throw apiError(422, {
            code: a.kind === 'credit_note' ? 'credit_note_needs_approval' : 'debit_note_needs_approval',
            whatHappened: a.kind === 'credit_note'
              ? `A credit note is money back to the customer and counts as a refund (OB-678): this one, for ₹${(probe.note.grossMinor / 100).toFixed(2)}, is issued only once a second person approves it — the store manager up to his refund limit, the owner without limit (a credit note the owner raises: the accountant, OB-679).`
              : `Every debit note to a customer is issued only once a second, different person approves it, at any amount (OB-679): this one is for ₹${(probe.note.grossMinor / 100).toFixed(2)}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: `Ask for approval (POST /v1/approvals/requests, kind ${ask.kind}, subjectRef ${ask.subjectRef}, valueMinor ${ask.valueMinor}, with exactly this note as the details), then send the note again naming the approval. Nothing was issued.`,
          });
        }
        const opened = await openApproval(deps.approvals ?? NO_APPROVALS, {
          tenantId: t, approvalId: approvalId.trim(), kind: ask.kind, subjectRef: ask.subjectRef, details: ask.details,
          valueMinor: ask.valueMinor, maker: ctx.userId, usedBy: ctx.userId, now: deps.now(),
        });
        const approvedBy = opened.decision.decidedBy;
        const spend = opened.spend;
        const seq = await deps.allocateNumber(t, CUSTOMER_NOTE_SERIES[a.kind]);
        const { note } = await workOut(ctx, a, formatNumber(CUSTOMER_NOTE_FORMAT[a.kind], seq));
        await spend();
        const issued: CustomerNote = { ...note, issuedBy: ctx.userId, approvedBy };
        await deps.recordCustomerNote(t, issued, ctx.userId);
        await deps.recordAudit?.(t, {
          actorId: ctx.userId, action: `finance.${a.kind}.issue`, objectType: 'b2b_customer', objectId: a.customerId, at: deps.now(),
          origin: { tenantId: t, branchId: ctx.branchId ?? null }, before: null,
          after: { number: issued.number, againstInvoice: issued.againstInvoiceNumber, taxableMinor: String(issued.taxableMinor), taxMinor: String(issued.taxMinor), grossMinor: String(issued.grossMinor), reason: issued.reason },
          approvalId: approvalId.trim(),
          correlationId: a.noteId,
        });
        const posting = (await postingOf(t))(issued);
        return {
          status: 201,
          body: {
            note: issued, number: issued.number, taxAdjustable: issued.taxAdjustable, declareInPeriod: issued.declareInPeriod, posting,
            approvedBy, invoiceUnchanged: true,
          },
        };
      },
    },
    {
      // A customer's tax invoices a note may be raised against, each line with what it charged, what credit notes have
      // already taken off it and what is left — and the notes already issued, each with where it stands in the books.
      api: 'API-09', method: 'GET', path: '/v1/finance/credit-notes/customers/:customerId',
      permission: 'finance.creditnote.issue', entitlement: 'b2b',
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const customerId = (ctx.params['customerId'] ?? '').trim();
        const [docs, all, posting] = await Promise.all([deps.businessDocuments?.(t, customerId) ?? [], customerNotes(t), postingOf(t)]);
        const mine = all.filter((n) => n.customerId === customerId);
        const invoices = docs.filter((d) => d.kind === 'tax_invoice').map((d) => {
          const credits = mine.filter((n) => n.kind === 'credit_note' && n.invoiceDocumentId === d.documentId).flatMap((n) => n.lines);
          return {
            documentId: d.documentId, number: d.number, issuedOn: shopDateIn(d.issuedAt), grossMinor: d.grossMinor,
            ...(d.buyer === undefined ? {} : { recipientGstin: d.buyer.gstin }),
            hasGstSplit: d.gst !== undefined,
            lines: d.lines.map((l) => {
              const charged = d.gst?.lines.find((s) => s.lineId === l.lineId)?.taxableMinor ?? l.qty * l.unitPriceMinor;
              const credited = credits.filter((c) => c.lineId === l.lineId).reduce((s, c) => s + c.taxableMinor, 0);
              return { lineId: l.lineId, description: l.description, qty: l.qty, rateBps: l.taxRateBps, chargedMinor: charged, creditedMinor: credited, leftMinor: charged - credited };
            }),
          };
        });
        const notes = mine.map((n) => ({ ...n, posting: posting(n) })).sort((x, y) => x.number.localeCompare(y.number));
        return { status: 200, body: { customerId, invoices, notes, asAt: deps.now() } };
      },
    },
    {
      // The period credit-note reconciliation (M23-FR-02, CGST s.34 / GSTR-1). The notes ISSUED for a return period (grouped
      // by each note's own declareInPeriod — the month ISSUED, never the invoice's) against what the accounts POSTED for the
      // period (`?ledgerTaxable=&ledgerTax=`, supplied), the difference EXACT and signed. A read; nothing is posted here.
      // Gated on the tier that ISSUES the notes (owner + accountant), not the store manager.
      api: 'API-09', method: 'GET', path: '/v1/finance/credit-notes/reconciliation',
      permission: 'finance.creditnote.issue',
      handler: async (ctx) => {
        const period = ctx.query['period'];
        const ledgerTaxable = ctx.query['ledgerTaxable'];
        const ledgerTax = ctx.query['ledgerTax'];
        if (period === undefined || !/^\d{4}-\d{2}$/.test(period)) {
          throw apiError(400, {
            code: 'reconciliation_needs_a_period',
            whatHappened: 'The credit-note reconciliation needs ?period=YYYY-MM — the return period (the month notes were ISSUED) to reconcile.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the period. A reconciliation reads, it never writes.',
          });
        }
        if (ledgerTaxable === undefined || !/^\d+$/.test(ledgerTaxable) || ledgerTax === undefined || !/^\d+$/.test(ledgerTax)) {
          throw apiError(400, {
            code: 'reconciliation_needs_ledger_figures',
            whatHappened: 'The reconciliation needs the figures the accounts posted to compare against: ?ledgerTaxable=<minor>&ledgerTax=<minor> (whole minor units).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send both ledger figures. A reconciliation reads, it never writes.',
          });
        }
        const reconciliation = reconcileNotes({
          period,
          notes: await deps.notes(ctx.tenantId),
          ledgerTaxableMinor: Number(ledgerTaxable),
          ledgerTaxMinor: Number(ledgerTax),
        });
        return { status: 200, body: { ...reconciliation, asAt: deps.now() } };
      },
    },
  ];
}
