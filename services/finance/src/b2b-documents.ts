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
import {
  issueQuotation, convertQuotation, issueProforma, issueChallan, issueTaxInvoice, checkChain,
  type B2BDocument, type B2BLine,
} from '../../../packages/b2b/src/documents';
import type { NumberFormat } from '../../../packages/numbering/src/numbering';

/**
 * A stored document. A quotation also carries the window its price holds for (`convertQuotation` needs
 * it); a proforma, challan or tax invoice also carries the ORDER it ultimately reconciles to, so the
 * chain can be gathered by its aggregate (a tax invoice is derivedFrom the CHALLANS, so it does not
 * name the order — `orderId` is the honest index that lets the chain be reconciled without that lie).
 */
export type StoredB2BDocument = B2BDocument & { readonly validUntil?: string; readonly orderId?: string };

/** Each B2B document type draws from its OWN gap-free series — a quotation must never consume a tax number. */
const FORMAT: Record<B2BDocument['kind'], NumberFormat> = {
  quotation: { prefix: 'QUO-', padTo: 6 },
  sales_order: { prefix: 'SO-', padTo: 6 },
  proforma: { prefix: 'PF-', padTo: 6 },
  challan: { prefix: 'DC-', padTo: 6 },
  tax_invoice: { prefix: 'INV-', padTo: 6 },
};
const DOCTYPE: Record<B2BDocument['kind'], string> = {
  quotation: 'b2b_quotation', sales_order: 'b2b_sales_order', proforma: 'b2b_proforma',
  challan: 'b2b_challan', tax_invoice: 'b2b_tax_invoice',
};

export interface B2BDocumentsDeps {
  readonly document: (tenantId: string, customerId: string, documentId: string) => Promise<StoredB2BDocument | undefined> | StoredB2BDocument | undefined;
  /** Every stored document for a customer, deduped by id — the chain projections (challans/invoices per order). */
  readonly documents: (tenantId: string, customerId: string) => Promise<readonly StoredB2BDocument[]> | readonly StoredB2BDocument[];
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

/** Read the dispatched map as a Record<lineId, whole non-negative qty>, or null if malformed. */
function asDispatched(v: unknown): Record<string, number> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [lineId, qty] of Object.entries(v as Record<string, unknown>)) {
    if (!isInt(qty) || (qty as number) < 0) return null;
    out[lineId] = qty as number;
  }
  return out;
}

/** Sum a line quantity across a set of documents (prior challans dispatched, or prior invoices billed). */
function sumByLine(docs: readonly StoredB2BDocument[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const d of docs) for (const l of d.lines) acc[l.lineId] = (acc[l.lineId] ?? 0) + l.qty;
  return acc;
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
      // A proforma — a request for payment, derived from the order. It is NOT a tax invoice: it carries
      // no tax claim and draws from its own series. There is no refusal path; the order must exist.
      api: 'API-09', method: 'POST', path: '/v1/b2b/documents/:customerId/proformas/:documentId',
      permission: 'b2b.document.issue', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const documentId = ctx.params['documentId'] ?? '';
        const order = await loadOrder(deps, ctx.tenantId, customerId, (ctx.body ?? {}) as { fromOrderId?: unknown });
        const seq = await deps.allocateNumber(ctx.tenantId, DOCTYPE.proforma);
        const doc = issueProforma({ documentId, order, format: FORMAT.proforma, seq, at: deps.now() });
        await deps.recordDocument(ctx.tenantId, customerId, { ...doc, orderId: order.documentId });
        return { status: 201, body: { documentId, number: doc.number, kind: doc.kind, taxClaimable: doc.taxClaimable, grossMinor: doc.grossMinor } };
      },
    },
    {
      // A delivery challan — what actually LEFT the building. Quantities are the dispatched ones, not the
      // ordered ones; over-delivery (cumulative dispatch beyond the order) is refused, and it draws a
      // number only on success.
      api: 'API-09', method: 'POST', path: '/v1/b2b/documents/:customerId/challans/:documentId',
      permission: 'b2b.document.issue', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const documentId = ctx.params['documentId'] ?? '';
        const b = (ctx.body ?? {}) as { fromOrderId?: unknown; dispatched?: unknown };
        const order = await loadOrder(deps, ctx.tenantId, customerId, b);
        const dispatched = asDispatched(b.dispatched);
        if (dispatched === null) {
          throw apiError(400, {
            code: 'not_readable_as_a_challan',
            whatHappened: 'A challan needs a dispatched map of { lineId: whole non-negative qty }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "fromOrderId": …, "dispatched": { "<lineId>": <qty> } }. Nothing was recorded.',
          });
        }
        const priorChallans = (await deps.documents(ctx.tenantId, customerId)).filter((d) => d.kind === 'challan' && d.orderId === order.documentId);
        const alreadyDispatched = sumByLine(priorChallans);
        const at = deps.now();

        const probe = issueChallan({ documentId, order, dispatched, alreadyDispatched, format: FORMAT.challan, seq: 0, at });
        if (!probe.issued) {
          throw apiError(422, {
            code: `challan_${probe.outcome}`,
            whatHappened: probe.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Fix the dispatched quantities and re-send. No number was drawn.',
          });
        }
        const seq = await deps.allocateNumber(ctx.tenantId, DOCTYPE.challan);
        const result = issueChallan({ documentId, order, dispatched, alreadyDispatched, format: FORMAT.challan, seq, at });
        const doc = result.document;
        if (doc === undefined) throw notFound(`challan ${documentId}`); // unreachable — the probe issued
        await deps.recordDocument(ctx.tenantId, customerId, { ...doc, orderId: order.documentId });
        return { status: 201, body: { documentId, number: doc.number, kind: doc.kind, grossMinor: doc.grossMinor, detail: doc.detail } };
      },
    },
    {
      // The tax invoice — built from the CHALLANS, never from the order. Partial delivery bills partially;
      // an invoice that would exceed what the challans record is refused. A number is drawn only on success.
      api: 'API-09', method: 'POST', path: '/v1/b2b/documents/:customerId/invoices/:documentId',
      permission: 'b2b.document.issue', idempotent: true,
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const documentId = ctx.params['documentId'] ?? '';
        const order = await loadOrder(deps, ctx.tenantId, customerId, (ctx.body ?? {}) as { fromOrderId?: unknown });
        const all = await deps.documents(ctx.tenantId, customerId);
        const challans = all.filter((d) => d.kind === 'challan' && d.orderId === order.documentId);
        const alreadyInvoiced = sumByLine(all.filter((d) => d.kind === 'tax_invoice' && d.orderId === order.documentId));
        const at = deps.now();

        const probe = issueTaxInvoice({ documentId, order, challans, alreadyInvoiced, format: FORMAT.tax_invoice, seq: 0, at });
        if (!probe.issued) {
          throw apiError(422, {
            code: `invoice_${probe.outcome}`,
            whatHappened: probe.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Deliver (challan) what is to be billed first. No number was drawn.',
          });
        }
        const seq = await deps.allocateNumber(ctx.tenantId, DOCTYPE.tax_invoice);
        const result = issueTaxInvoice({ documentId, order, challans, alreadyInvoiced, format: FORMAT.tax_invoice, seq, at });
        const doc = result.document;
        if (doc === undefined) throw notFound(`invoice ${documentId}`); // unreachable — the probe issued
        await deps.recordDocument(ctx.tenantId, customerId, { ...doc, orderId: order.documentId });
        return { status: 201, body: { documentId, number: doc.number, kind: doc.kind, taxClaimable: doc.taxClaimable, grossMinor: doc.grossMinor, detail: doc.detail } };
      },
    },
    {
      // Reconcile the chain for an order: ordered vs delivered vs billed. Delivered-but-not-invoiced is
      // the number that matters — goods gone out of the door with no claim on them.
      api: 'API-09', method: 'GET', path: '/v1/b2b/documents/:customerId/orders/:orderId/chain',
      permission: 'b2b.document.read',
      handler: async (ctx) => {
        const customerId = ctx.params['customerId'] ?? '';
        const orderId = ctx.params['orderId'] ?? '';
        const order = await deps.document(ctx.tenantId, customerId, orderId);
        if (order === undefined || order.kind !== 'sales_order') throw notFound(`order ${orderId} for ${customerId}`);
        const all = await deps.documents(ctx.tenantId, customerId);
        const challans = all.filter((d) => d.kind === 'challan' && d.orderId === order.documentId);
        const invoices = all.filter((d) => d.kind === 'tax_invoice' && d.orderId === order.documentId);
        return { status: 200, body: { orderId, ...checkChain({ order, challans, invoices }) } };
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

/** Load the sales order a derived document is built from, or refuse (404) if it is missing or not an order. */
async function loadOrder(deps: B2BDocumentsDeps, tenantId: string, customerId: string, body: { fromOrderId?: unknown }): Promise<StoredB2BDocument> {
  if (!isStr(body.fromOrderId)) {
    throw apiError(400, {
      code: 'not_readable_as_a_derived_document',
      whatHappened: 'This document is derived from a sales order, so it needs the order id it is built from.',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Send { "fromOrderId": … }. Nothing was recorded.',
    });
  }
  const order = await deps.document(tenantId, customerId, body.fromOrderId);
  if (order === undefined || order.kind !== 'sales_order') throw notFound(`order ${body.fromOrderId} for ${customerId}`);
  return order;
}
