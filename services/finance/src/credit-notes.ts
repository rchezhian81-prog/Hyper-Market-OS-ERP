// API-09 Finance — GST credit/debit notes (M23-FR-02 remainder, CGST s.34).
//
// A customer returns goods; the shop owes them money back. Indian GST is specific about how you
// record that: **you do not edit the tax invoice.** Section 34 gives you a credit note — its own
// number, its own date, a reference to the invoice it relieves — declared in the return for the
// month it was ISSUED, not the month the invoice was. That is hard rule #2 arrived at independently
// by the tax code: a correction is a compensating document, never an overwrite.
//
// This module is the running door onto the tested `packages/finance` credit-note engine, which
// until now lived only in its own unit tests. The route validates that the request is well-formed;
// the engine enforces the tax law — the credit never exceeds what the invoice charged (cumulatively
// across every note against it), the tax comes off in the same proportion it went on, and a note
// issued after the s.34(2) window is honestly marked commercial-only with no tax relief. The
// invoice itself is never touched.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  issueCreditNote,
  type CreditNote,
  type CreditReason,
  type NoteKind,
  type SourceInvoice,
  type TaxComponent,
} from '../../../packages/finance/src/index';

const REASONS: readonly CreditReason[] = [
  'goods_returned', 'deficiency_in_service', 'post_supply_discount',
  'price_correction', 'tax_rate_correction', 'order_cancelled',
];

export interface CreditNoteDeps {
  /**
   * Taxable value already credited against this invoice by earlier notes. The engine adds the new
   * note to this and refuses if the cumulative total exceeds what the invoice charged — so the cap
   * holds across many notes, not just one. Folded from the issued-note events, never a stored field.
   */
  readonly alreadyCredited: (tenantId: string, invoiceId: string) => Promise<number> | number;
  readonly appendCreditNote: (tenantId: string, note: CreditNote) => Promise<void> | void;
  readonly now: () => string;
}

/** The request body — a note to issue against a supplied source invoice. */
interface IssueBody {
  readonly noteId?: string;
  readonly number?: string;
  readonly kind?: NoteKind;
  readonly invoice?: SourceInvoice;
  readonly customerId?: string;
  readonly reason?: CreditReason;
  readonly taxableMinor?: number;
  readonly taxes?: readonly TaxComponent[];
  /** ISO date; defaults to now. Drives the return period and the s.34(2) window. */
  readonly issuedOn?: string;
}

export function creditNoteRoutes(deps: CreditNoteDeps): readonly Route[] {
  return [
    {
      // Issue a credit (or debit) note against an invoice. Idempotent on the note id, so a resend of
      // the same note is not a second credit — money out must never double on a retry.
      api: 'API-09', method: 'POST', path: '/v1/finance/credit-notes',
      permission: 'finance.creditnote.issue', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as IssueBody;

        // The route checks the request is answerable; the engine checks the tax law.
        if (b.invoice === undefined) {
          throw apiError(422, {
            code: 'invoice_not_found',
            whatHappened: 'No source invoice was supplied to credit against. A credit note with nothing to relieve is not a credit note.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the invoice this note is issued against.',
          });
        }
        if (b.reason === undefined || !REASONS.includes(b.reason)) {
          throw apiError(422, {
            code: 'no_reason',
            whatHappened: 'A credit note needs a reason — it decides which return period it belongs to and whose conversation the return is.',
            wasItSaved: 'not_saved',
            nextSafeAction: `Send one of: ${REASONS.join(', ')}.`,
          });
        }

        const result = issueCreditNote({
          noteId: b.noteId ?? '',
          number: b.number ?? '',
          kind: b.kind ?? 'credit_note',
          invoice: b.invoice,
          customerId: b.customerId ?? '',
          reason: b.reason,
          taxableMinor: b.taxableMinor ?? 0,
          taxes: b.taxes ?? [],
          alreadyCreditedMinor: await deps.alreadyCredited(ctx.tenantId, b.invoice.invoiceId),
          issuedOn: b.issuedOn ?? deps.now(),
        });

        if (!result.issued) {
          throw apiError(422, {
            code: result.outcome,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was issued and the invoice is unchanged — a credit note never edits it. Correct the note and send it again.',
          });
        }

        await deps.appendCreditNote(ctx.tenantId, result.note!);
        return {
          status: 201,
          body: {
            note: result.note,
            // Stated on every reply so the caller can see, without re-deriving it, whether the tax
            // is reclaimable and which return period this note falls in.
            taxAdjustable: result.note!.taxAdjustable,
            declareInPeriod: result.note!.declareInPeriod,
          },
        };
      },
    },
  ];
}
