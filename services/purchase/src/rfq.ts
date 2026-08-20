// API-03 Requisition → RFQ → quotation comparison (M06-FR-02) — the front half of buying, before a PO.
// A buyer raises a REQUISITION (what the shop needs, in one comparison currency), captures the QUOTES
// suppliers send back, and reads a like-for-like COMPARISON. The comparison itself is the tested
// `compareQuotes` (packages/purchasing) — this file is the persistence + HTTP skin:
//
//   • it decides nothing and commits no money — it lays the choice out (cheapest + fastest per line and
//     overall), never ranking a quote that is missing a line or priced in another currency (P-08);
//   • a chosen quote becomes a PO through the SEPARATE approved `issuePurchaseOrder` path (§28) — the
//     buyer who raised the requisition still cannot be the one who approves the PO it leads to.
//
// Recording is gated `purchase.order.propose` (the buyer's demand + the quotes they enter); the
// comparison and the worklist are `purchase.commitment.read`. Requisitions and quotes are event-sourced
// and latest-wins (a re-quote supersedes), so the comparison always reflects the newest offer.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  compareQuotes,
  type Requisition, type RequisitionLine, type Quote, type QuoteLine,
} from '../../../packages/purchasing/src/index';
import { money, isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';

export interface RfqDeps {
  /** One requisition by id (latest version), or undefined. */
  readonly requisition: (tenantId: string, requisitionId: string) => Promise<Requisition | undefined> | Requisition | undefined;
  /** Every requisition — the buying worklist. */
  readonly requisitions: (tenantId: string) => Promise<readonly Requisition[]> | readonly Requisition[];
  /** Every recorded quote for a requisition (latest per quote id). */
  readonly quotes: (tenantId: string, requisitionId: string) => Promise<readonly Quote[]> | readonly Quote[];
  /** Record a requisition. Latest per id. */
  readonly recordRequisition: (tenantId: string, requisition: Requisition) => Promise<void> | void;
  /** Record a supplier quote against a requisition. Latest per quote id (a re-quote supersedes). */
  readonly recordQuote: (tenantId: string, requisitionId: string, quote: Quote) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

interface RawReqLine { readonly productId: string; readonly quantity: number; }
const isReqLine = (v: unknown): v is RawReqLine => isObj(v) && isStr(v['productId']) && isPosInt(v['quantity']);

interface RawQuoteLine { readonly productId: string; readonly unitCost: { readonly minor: number; readonly currency: string }; readonly leadTimeDays: number; }
const isQuoteLine = (v: unknown): v is RawQuoteLine =>
  isObj(v) && isStr(v['productId']) && isNonNegInt(v['leadTimeDays'])
  && isObj(v['unitCost']) && typeof (v['unitCost'] as Record<string, unknown>)['minor'] === 'number'
  && Number.isSafeInteger((v['unitCost'] as Record<string, unknown>)['minor'])
  && typeof (v['unitCost'] as Record<string, unknown>)['currency'] === 'string' && isCurrencyCode((v['unitCost'] as Record<string, unknown>)['currency'] as string);

export function rfqRoutes(deps: RfqDeps): readonly Route[] {
  return [
    {
      // Raise a requisition. Body: { currency, lines[] each { productId, quantity } }. Latest per id.
      api: 'API-03', method: 'POST', path: '/v1/purchase/requisitions/:requisitionId',
      permission: 'purchase.order.propose', idempotent: true,
      handler: async (ctx) => {
        const requisitionId = (ctx.params['requisitionId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = b['lines'];
        if (requisitionId === '' || !isStr(b['currency']) || !isCurrencyCode(b['currency'])
          || !Array.isArray(lines) || lines.length === 0 || !lines.every(isReqLine)) {
          throw apiError(400, {
            code: 'not_readable_as_a_requisition',
            whatHappened: 'A requisition needs a requisitionId in the path and { currency (a known code), lines[] (each with productId and a positive whole quantity) } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the comparison currency and at least one product with a quantity.',
          });
        }
        const req: Requisition = {
          requisitionId,
          currency: b['currency'] as CurrencyCode,
          lines: (lines as RawReqLine[]).map((l): RequisitionLine => ({ productId: l.productId, quantity: l.quantity })),
        };
        await deps.recordRequisition(ctx.tenantId, req);
        return { status: 201, body: { requisition: req } };
      },
    },
    {
      // Record a supplier's quote against a requisition. Body: { supplierId, lines[] each { productId,
      // unitCost { minor, currency }, leadTimeDays } }. Latest per quote id — a re-quote supersedes.
      api: 'API-03', method: 'POST', path: '/v1/purchase/requisitions/:requisitionId/quotes/:quoteId',
      permission: 'purchase.order.propose', idempotent: true,
      handler: async (ctx) => {
        const requisitionId = (ctx.params['requisitionId'] ?? '').trim();
        const quoteId = (ctx.params['quoteId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = b['lines'];
        if (quoteId === '' || !isStr(b['supplierId']) || !Array.isArray(lines) || lines.length === 0 || !lines.every(isQuoteLine)) {
          throw apiError(400, {
            code: 'not_readable_as_a_quote',
            whatHappened: 'A quote needs requisitionId + quoteId in the path and { supplierId, lines[] (each with productId, unitCost { minor, currency }, and a whole leadTimeDays ≥ 0) } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the supplier and its quoted lines.',
          });
        }
        // The requisition must exist — a quote against nothing cannot be compared.
        if ((await deps.requisition(ctx.tenantId, requisitionId)) === undefined) throw notFound(`requisition ${requisitionId}`);
        const quote: Quote = {
          quoteId,
          supplierId: b['supplierId'] as string,
          lines: (lines as RawQuoteLine[]).map((l): QuoteLine => ({
            productId: l.productId,
            unitCost: money(l.unitCost.minor, l.unitCost.currency as CurrencyCode),
            leadTimeDays: l.leadTimeDays,
          })),
        };
        await deps.recordQuote(ctx.tenantId, requisitionId, quote);
        return { status: 201, body: { quote } };
      },
    },
    {
      // The like-for-like comparison — cheapest + fastest per line and overall (M06-FR-02). 404 unknown.
      api: 'API-03', method: 'GET', path: '/v1/purchase/requisitions/:requisitionId/comparison',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const requisitionId = (ctx.params['requisitionId'] ?? '').trim();
        const requisition = await deps.requisition(ctx.tenantId, requisitionId);
        if (requisition === undefined) throw notFound(`requisition ${requisitionId}`);
        const quotes = await deps.quotes(ctx.tenantId, requisitionId);
        return { status: 200, body: { comparison: compareQuotes({ requisition, quotes }) } };
      },
    },
    {
      // The buying worklist — every requisition raised.
      api: 'API-03', method: 'GET', path: '/v1/purchase/requisitions',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const requisitions = await deps.requisitions(ctx.tenantId);
        return { status: 200, body: { requisitions, count: requisitions.length } };
      },
    },
  ];
}
