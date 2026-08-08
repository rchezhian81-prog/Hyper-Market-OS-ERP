// API-09 the B2B document chain, part 1: quotation → sales order (M22-FR-02). A hypermarket selling
// to a school or a caterer runs a chain of documents, each a legal or commercial claim about the same
// order, and the rule that runs through it is that **each document is derived from the one before it**.
// This surface wires the first two links onto the gap-free number series (M01-FR-02) and the credit
// control (M22-FR-01); the delivery challan and the tax-invoice-from-challans follow in part 2.
//
// Two controls are refusals, not warnings:
//   • **A number is drawn once, and only on success** — a rejected quotation leaves NO gap in the
//     series, because a gap in a tax series is a question from an assessing officer with no good answer.
//     The engine is run once to validate WITHOUT a number; only if it would issue is a number allocated
//     and the document built.
//   • **Conversion is at the QUOTED price or refused** — never re-priced quietly at today's list, and
//     never converted past the quoted window or without credit control clearing it (M22-FR-01, §28).
//
// The rules are the pure `issueQuotation` / `convertQuotation` engines in `packages/b2b`; this surface
// gives them persistence, the number series, the credit gate, an authorization split and a read.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { issueQuotation, convertQuotation, type B2BDocument, type B2BLine } from '../../../packages/b2b/src/documents';
import type { NumberFormat } from '../../../packages/numbering/src/numbering';

/** A stored document. A quotation also carries the window its price holds for (`convertQuotation` needs it). */
export type StoredB2BDocument = B2BDocument & { readonly validUntil?: string };

/** Each B2B document type draws from its OWN gap-free series — a quotation must never consume a tax number. */
const FORMAT: Record<'quotation' | 'sales_order', NumberFormat> = {
  quotation: { prefix: 'QUO-', padTo: 6 },
  sales_order: { prefix: 'SO-', padTo: 6 },
};
const DOCTYPE = { quotation: 'b2b_quotation', sales_order: 'b2b_sales_order' } as const;

export interface B2BDocumentsDeps {
  readonly document: (tenantId: string, customerId: string, documentId: string) => Promise<StoredB2BDocument | undefined> | StoredB2BDocument | undefined;
  /** The quotation ids that have already become an order — the `already_converted` guard (one quote, one order). */
  readonly convertedQuotationIds: (tenantId: string, customerId: string) => Promise<readonly string[]> | readonly string[];
  readonly recordDocument: (tenantId: string, customerId: string, doc: StoredB2BDocument) => Promise<void> | void;
  /** Draw the next gap-free number for a (tenant, doc type). Called ONLY once the engine would issue. */
  readonly allocateNumber: (tenantId: string, docType: string) => Promise<number> | number;
  /** Does credit control clear an order of this value for this customer? (M22-FR-01). */
  readonly creditAllowed: (tenantId: string, customerId: string, orderValueMinor: number) => Promise<boolean> | boolean;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);

/** Read the request lines as B2BLine[], or null if any line is malformed (a 400, not a business refusal). */
function asLines(v: unknown): B2BLine[] | null {
  if (!Array.isArray(v)) return null;
  const lines: B2BLine[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== 'object') return null;
    const l = raw as Record<string, unknown>;
    if (!isStr(l['lineId']) || !isStr(l['productId']) || !isStr(l['description'])
      || !isInt(l['qty']) || !isInt(l['unitPriceMinor']) || (l['unitPriceMinor'] as number) < 0
      || !isInt(l['taxRateBps']) || (l['taxRateBps'] as number) < 0) {
      return null;
    }
    lines.push({
      lineId: l['lineId'] as string, productId: l['productId'] as string, description: l['description'] as string,
      qty: l['qty'] as number, unitPriceMinor: l['unitPriceMinor'] as number, taxRateBps: l['taxRateBps'] as number,
    });
  }
  return lines;
}

export function b2bDocumentsRoutes(deps: B2BDocumentsDeps): readonly Route[] {
  return [
    {
      // Issue a quotation — non-committing, and it draws a number only once the lines are valid.
      api: 'API-09', method: 'POST', path: '/v1/b2b/documents/:customerId/quotations/:documentId',
      permission: 'b2b.document.issue', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const documentId = ctx.params['documentId'] ?? '';
        const b = (ctx.body ?? {}) as { lines?: unknown; validForDays?: unknown };
        const lines = asLines(b.lines);
        if (lines === null) {
          throw apiError(400, {
            code: 'not_readable_as_a_quotation',
            whatHappened: 'A quotation needs lines, each with a line id, product id, description and whole qty / unit price / tax rate.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send well-formed lines. Nothing was recorded and no number was drawn.',
          });
        }
        const validForDays = isInt(b.validForDays) && (b.validForDays as number) > 0 ? (b.validForDays as number) : undefined;
        const at = deps.now();

        // Validate WITHOUT drawing a number — a rejected quotation must leave no gap in the series.
        const probe = issueQuotation({ documentId, customerId, tenantId: ctx.tenantId, lines, format: FORMAT.quotation, seq: 0, at, ...(validForDays === undefined ? {} : { validForDays }) });
        if (!probe.issued) {
          throw apiError(422, {
            code: `quotation_${probe.outcome}`,
            whatHappened: probe.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Fix the lines and re-send. No number was drawn, so the series keeps no gap.',
          });
        }

        // It will issue — draw the gap-free number and build the final document with the SAME clock.
        const seq = await deps.allocateNumber(ctx.tenantId, DOCTYPE.quotation);
        const result = issueQuotation({ documentId, customerId, tenantId: ctx.tenantId, lines, format: FORMAT.quotation, seq, at, ...(validForDays === undefined ? {} : { validForDays }) });
        const doc = result.document;
        if (doc === undefined || result.validUntil === undefined) throw notFound(`quotation ${documentId}`); // unreachable — the probe issued
        const stored: StoredB2BDocument = { ...doc, validUntil: result.validUntil };
        await deps.recordDocument(ctx.tenantId, customerId, stored);
        return { status: 201, body: { documentId, number: doc.number, kind: doc.kind, grossMinor: doc.grossMinor, validUntil: result.validUntil } };
      },
    },
    {
      // Convert a quotation into a sales order — at the quoted price, inside the window, with credit cleared.
      api: 'API-09', method: 'POST', path: '/v1/b2b/documents/:customerId/orders/:documentId',
      permission: 'b2b.document.issue', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const documentId = ctx.params['documentId'] ?? '';
        const b = (ctx.body ?? {}) as { fromQuotationId?: unknown };
        if (!isStr(b.fromQuotationId)) {
          throw apiError(400, {
            code: 'not_readable_as_a_conversion',
            whatHappened: 'A conversion needs the quotation id it is derived from.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "fromQuotationId": … }. Nothing was recorded.',
          });
        }
        const quotation = await deps.document(ctx.tenantId, customerId, b.fromQuotationId);
        if (quotation === undefined || quotation.kind !== 'quotation' || quotation.validUntil === undefined) {
          throw notFound(`quotation ${b.fromQuotationId} for ${customerId}`);
        }

        const alreadyConvertedFrom = await deps.convertedQuotationIds(ctx.tenantId, customerId);
        const creditAllowed = await deps.creditAllowed(ctx.tenantId, customerId, quotation.grossMinor);
        const at = deps.now();

        // Decide WITHOUT drawing a number — a refused conversion (expired, already converted, credit blocked)
        // leaves the sales-order series with no gap.
        const probe = convertQuotation({ documentId, quotation, customerId, format: FORMAT.sales_order, seq: 0, validUntil: quotation.validUntil, at, alreadyConvertedFrom, creditAllowed });
        if (!probe.converted) {
          throw apiError(422, {
            code: `conversion_${probe.outcome}`,
            whatHappened: probe.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: probe.outcome === 'expired' ? 'Re-quote rather than re-price. Nothing was recorded.' : 'Nothing was recorded and no number was drawn.',
          });
        }

        const seq = await deps.allocateNumber(ctx.tenantId, DOCTYPE.sales_order);
        const result = convertQuotation({ documentId, quotation, customerId, format: FORMAT.sales_order, seq, validUntil: quotation.validUntil, at, alreadyConvertedFrom, creditAllowed });
        const doc = result.document;
        if (doc === undefined) throw notFound(`order ${documentId}`); // unreachable — the probe converted
        await deps.recordDocument(ctx.tenantId, customerId, doc);
        return { status: 201, body: { documentId, number: doc.number, kind: doc.kind, derivedFrom: doc.derivedFrom, grossMinor: doc.grossMinor } };
      },
    },
    {
      // Read a stored document — the quotation or the order it became.
      api: 'API-09', method: 'GET', path: '/v1/b2b/documents/:customerId/:documentId',
      permission: 'b2b.document.read',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const documentId = ctx.params['documentId'] ?? '';
        const doc = await deps.document(ctx.tenantId, customerId, documentId);
        if (doc === undefined) throw notFound(`document ${documentId} for ${customerId}`);
        return { status: 200, body: doc };
      },
    },
  ];
}
