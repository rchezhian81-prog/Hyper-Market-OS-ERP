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
export type StoredB2BDocument = B2BDocument & {
  readonly validUntil?: string;
  readonly orderId?: string;
  /** FUL-09: a sales order's stock is held at, and dispatched from, this store. */
  readonly locationId?: string;
  /** FUL-09 · M22-FR-03: the salesperson the order is attributed to — their commission is derived from its invoices. */
  readonly salespersonId?: string;
};

/**
 * FUL-09: the stock a B2B order moves — the ordinary stock every other channel sells from (P-02). A sales order HOLDS what
 * it needs at its store when it is made (all of it, or the order is refused — no oversell); a challan takes what left the
 * building OFF the shelf once (an ordinary `sold` movement per line, keyed on the challan) and keeps holding only what is
 * still to go.
 */
export interface B2BStockPort {
  /** Hold every line at the store, or hold nothing and say what is short. Holding the same order again is a no-op. */
  reserve(tenantId: string, orderRef: string, locationId: string, lines: readonly { readonly productId: string; readonly quantityMinor: number }[]):
    Promise<{ readonly ok: true } | { readonly ok: false; readonly shortages: readonly { readonly productId: string; readonly requestedMinor: number; readonly promisedMinor: number }[] }>;
  /** What left on a challan comes off the shelf once; the order keeps holding only `remaining`. */
  dispatch(tenantId: string, input: {
    readonly orderRef: string; readonly challanId: string; readonly locationId: string; readonly by: string;
    readonly lines: readonly { readonly lineId: string; readonly productId: string; readonly quantityMinor: number }[];
    readonly remaining: readonly { readonly productId: string; readonly quantityMinor: number }[];
  }): Promise<void>;
  /** What the order still holds at its store. */
  held(tenantId: string, orderRef: string, locationId: string): Promise<readonly { readonly productId: string; readonly quantityMinor: number }[]>;
}

/** The order reference a B2B sales order's stock holds are filed under (one per customer + order). */
export const b2bOrderRef = (customerId: string, orderId: string): string => `b2b-${customerId}-${orderId}`;

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
  /** FUL-09: a tax invoice's money effects — the receivable collections ages, the AR movement, the postable for the books. */
  readonly afterTaxInvoice?: (tenantId: string, customerId: string, doc: StoredB2BDocument) => Promise<{ readonly dueOn: string }>;
  /** FUL-09: the ordinary stock a sales order holds and a challan moves. Present → a sales order must name its store. */
  readonly stock?: B2BStockPort;
  /**
   * FUL-09 · M22-FR-03: the salesperson's commission, DERIVED from an invoice of an attributed order by the APPROVED rule
   * (never a rate typed at the time). Returns what was accrued, or why nothing was (no rule approved).
   */
  readonly commissionOnInvoice?: (tenantId: string, input: { readonly salespersonId: string; readonly invoice: StoredB2BDocument }) =>
    Promise<{ readonly accrued: true; readonly commissionMinor: number; readonly rateBps: number } | { readonly accrued: false; readonly why: string }>;
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
      entitlement: 'b2b',
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { lines?: unknown; validForDays?: unknown; locationId?: unknown };
        const stored = await issueQuotationDocument(deps, { tenantId: ctx.tenantId, customerId: ctx.params['customerId'] ?? '', documentId: ctx.params['documentId'] ?? '', lines: b.lines, validForDays: b.validForDays, locationId: b.locationId });
        return { status: 201, body: { documentId: stored.documentId, number: stored.number, kind: stored.kind, grossMinor: stored.grossMinor, validUntil: stored.validUntil, ...(stored.locationId === undefined ? {} : { locationId: stored.locationId }) } };
      },
    },
    {
      // Convert a quotation into a sales order — at the quoted price, inside the window, with credit cleared, and (FUL-09)
      // its stock HELD at the named store, all of it or none. Body: { fromQuotationId, locationId, salespersonId? }.
      api: 'API-09', method: 'POST', path: '/v1/b2b/documents/:customerId/orders/:documentId',
      permission: 'b2b.document.issue', idempotent: true,
      entitlement: 'b2b',
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { fromQuotationId?: unknown; locationId?: unknown; salespersonId?: unknown };
        const doc = await convertToSalesOrder(deps, {
          tenantId: ctx.tenantId, customerId: ctx.params['customerId'] ?? '', documentId: ctx.params['documentId'] ?? '',
          fromQuotationId: b.fromQuotationId, locationId: b.locationId, salespersonId: b.salespersonId,
        });
        return { status: 201, body: { documentId: doc.documentId, number: doc.number, kind: doc.kind, derivedFrom: doc.derivedFrom, grossMinor: doc.grossMinor, ...(doc.locationId === undefined ? {} : { locationId: doc.locationId, stock: 'held' }), ...(doc.salespersonId === undefined ? {} : { salespersonId: doc.salespersonId }) } };
      },
    },
    {
      // A proforma — a request for payment, derived from the order. It is NOT a tax invoice: it carries
      // no tax claim and draws from its own series. There is no refusal path; the order must exist.
      api: 'API-09', method: 'POST', path: '/v1/b2b/documents/:customerId/proformas/:documentId',
      permission: 'b2b.document.issue', idempotent: true,
      entitlement: 'b2b',
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
      entitlement: 'b2b',
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
        // FUL-09: what left the building comes off the ordinary shelf ONCE, and the order keeps holding only what is to go.
        if (deps.stock !== undefined && order.locationId !== undefined) {
          const dispatchedNow = sumByLine([doc]);
          const remaining = order.lines.map((l) => ({ productId: l.productId, quantityMinor: Math.max(0, l.qty - (alreadyDispatched[l.lineId] ?? 0) - (dispatchedNow[l.lineId] ?? 0)) }))
            .filter((l) => l.quantityMinor > 0);
          await deps.stock.dispatch(ctx.tenantId, {
            orderRef: b2bOrderRef(customerId, order.documentId), challanId: documentId, locationId: order.locationId, by: ctx.userId,
            lines: doc.lines.filter((l) => l.qty > 0).map((l) => ({ lineId: l.lineId, productId: l.productId, quantityMinor: l.qty })),
            remaining,
          });
        }
        return { status: 201, body: { documentId, number: doc.number, kind: doc.kind, grossMinor: doc.grossMinor, detail: doc.detail, ...(order.locationId === undefined ? {} : { dispatchedFrom: order.locationId }) } };
      },
    },
    {
      // The tax invoice — built from the CHALLANS, never from the order. Partial delivery bills partially;
      // an invoice that would exceed what the challans record is refused. A number is drawn only on success.
      api: 'API-09', method: 'POST', path: '/v1/b2b/documents/:customerId/invoices/:documentId',
      permission: 'b2b.document.issue', idempotent: true,
      entitlement: 'b2b',
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
        // FUL-09: the invoice is now money owed — a receivable on the customer's terms, on the AR ledger, and for the books.
        const owed = await deps.afterTaxInvoice?.(ctx.tenantId, customerId, { ...doc, orderId: order.documentId });
        // FUL-09 · M22-FR-03: the attributed salesperson's commission, derived from this invoice by the approved rule.
        const commission = order.salespersonId === undefined || deps.commissionOnInvoice === undefined ? undefined
          : await deps.commissionOnInvoice(ctx.tenantId, { salespersonId: order.salespersonId, invoice: { ...doc, orderId: order.documentId } });
        return { status: 201, body: { documentId, number: doc.number, kind: doc.kind, taxClaimable: doc.taxClaimable, grossMinor: doc.grossMinor, detail: doc.detail, ...(owed === undefined ? {} : { dueOn: owed.dueOn }), ...(commission === undefined ? {} : { commission }) } };
      },
    },
    {
      // Reconcile the chain for an order: ordered vs delivered vs billed. Delivered-but-not-invoiced is
      // the number that matters — goods gone out of the door with no claim on them.
      api: 'API-09', method: 'GET', path: '/v1/b2b/documents/:customerId/orders/:orderId/chain',
      permission: 'b2b.document.read',
      entitlement: 'b2b',
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
      entitlement: 'b2b',
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

/**
 * Issue a quotation (M22-FR-02): non-committing, and it draws a number only once the lines are valid. Shared by the desk
 * and the recurring-order run (FUL-09).
 */
export async function issueQuotationDocument(deps: B2BDocumentsDeps, input: {
  readonly tenantId: string; readonly customerId: string; readonly documentId: string;
  readonly lines: unknown; readonly validForDays?: unknown; readonly locationId?: unknown;
}): Promise<StoredB2BDocument> {
  const { tenantId, customerId, documentId } = input;
  const lines = asLines(input.lines);
  if (lines === null) {
    throw apiError(400, {
      code: 'not_readable_as_a_quotation',
      whatHappened: 'A quotation needs lines, each with a line id, product id, description and whole qty / unit price / tax rate.',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Send well-formed lines. Nothing was recorded and no number was drawn.',
    });
  }
  const validForDays = isInt(input.validForDays) && (input.validForDays as number) > 0 ? (input.validForDays as number) : undefined;
  const at = deps.now();

  // Validate WITHOUT drawing a number — a rejected quotation must leave no gap in the series.
  const probe = issueQuotation({ documentId, customerId, tenantId, lines, format: FORMAT.quotation, seq: 0, at, ...(validForDays === undefined ? {} : { validForDays }) });
  if (!probe.issued) {
    throw apiError(422, {
      code: `quotation_${probe.outcome}`,
      whatHappened: probe.detail,
      wasItSaved: 'not_saved',
      nextSafeAction: 'Fix the lines and re-send. No number was drawn, so the series keeps no gap.',
    });
  }

  // It will issue — draw the gap-free number and build the final document with the SAME clock.
  const seq = await deps.allocateNumber(tenantId, DOCTYPE.quotation);
  const result = issueQuotation({ documentId, customerId, tenantId, lines, format: FORMAT.quotation, seq, at, ...(validForDays === undefined ? {} : { validForDays }) });
  const doc = result.document;
  if (doc === undefined || result.validUntil === undefined) throw notFound(`quotation ${documentId}`); // unreachable — the probe issued
  // FUL-09: the store it is quoted from (optional) — the store an order made from it holds and dispatches stock at.
  const stored: StoredB2BDocument = { ...doc, validUntil: result.validUntil, ...(isStr(input.locationId) ? { locationId: input.locationId } : {}) };
  await deps.recordDocument(tenantId, customerId, stored);
  return stored;
}

/**
 * Turn a quotation into a sales order (M22-FR-01/02 · FUL-09): at the quoted price, inside its window, once, with credit
 * cleared — and, where the stock port is wired, with every line HELD at the named store first (all or nothing: a bulk
 * order never promises what is not on the shelf). Refusals draw no number. Shared by the desk and the customer's portal.
 */
export async function convertToSalesOrder(deps: B2BDocumentsDeps, input: {
  readonly tenantId: string; readonly customerId: string; readonly documentId: string;
  readonly fromQuotationId: unknown; readonly locationId: unknown; readonly salespersonId: unknown;
}): Promise<StoredB2BDocument> {
  const { tenantId, customerId, documentId } = input;
  const named = isStr(input.fromQuotationId) ? await deps.document(tenantId, customerId, input.fromQuotationId) : undefined;
  // The store is the one named now, or the one the quotation was made out from.
  const locationGiven = isStr(input.locationId) ? input.locationId : named?.locationId;
  if (isStr(input.fromQuotationId) && (named === undefined || named.kind !== 'quotation' || named.validUntil === undefined)) {
    throw notFound(`quotation ${input.fromQuotationId} for ${customerId}`);
  }
  if (!isStr(input.fromQuotationId) || (deps.stock !== undefined && !isStr(locationGiven)) || (input.salespersonId !== undefined && !isStr(input.salespersonId))) {
    throw apiError(400, {
      code: 'not_readable_as_a_conversion',
      whatHappened: deps.stock !== undefined
        ? 'A conversion needs the quotation id it is derived from and the store whose stock it is supplied from (locationId); a salespersonId, if given, names who sold it.'
        : 'A conversion needs the quotation id it is derived from.',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Send { "fromQuotationId": …, "locationId": … }. Nothing was recorded.',
    });
  }
  const quotation = named;
  if (quotation === undefined || quotation.kind !== 'quotation' || quotation.validUntil === undefined) {
    throw notFound(`quotation ${String(input.fromQuotationId)} for ${customerId}`);
  }
  const alreadyConvertedFrom = await deps.convertedQuotationIds(tenantId, customerId);
  const creditAllowed = await deps.creditAllowed(tenantId, customerId, quotation.grossMinor);
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
  // FUL-09: the stock, all of it, before a number is drawn — a bulk order the shelf cannot supply is refused, not oversold.
  const locationId = isStr(locationGiven) ? locationGiven : undefined;
  if (deps.stock !== undefined && locationId !== undefined) {
    const need = new Map<string, number>();
    for (const l of quotation.lines) need.set(l.productId, (need.get(l.productId) ?? 0) + l.qty);
    const held = await deps.stock.reserve(tenantId, b2bOrderRef(customerId, documentId), locationId, [...need].map(([productId, quantityMinor]) => ({ productId, quantityMinor })));
    if (!held.ok) {
      throw apiError(409, {
        code: 'order_cannot_be_supplied',
        whatHappened: `The store ${locationId} cannot supply this order in full: ${held.shortages.map((x) => `${x.productId} ${x.promisedMinor} of ${x.requestedMinor}`).join(', ')}. Nothing was held.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Re-quote for what can be supplied, or supply from another store. No number was drawn and no stock was held.',
      });
    }
  }
  const seq = await deps.allocateNumber(tenantId, DOCTYPE.sales_order);
  const result = convertQuotation({ documentId, quotation, customerId, format: FORMAT.sales_order, seq, validUntil: quotation.validUntil, at, alreadyConvertedFrom, creditAllowed });
  const doc = result.document;
  if (doc === undefined) throw notFound(`order ${documentId}`); // unreachable — the probe converted
  const stored: StoredB2BDocument = {
    ...doc,
    ...(locationId === undefined ? {} : { locationId }),
    ...(isStr(input.salespersonId) ? { salespersonId: input.salespersonId } : {}),
  };
  await deps.recordDocument(tenantId, customerId, stored);
  return stored;
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
