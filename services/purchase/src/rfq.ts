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
import { normaliseUom } from '../../../packages/contracts/src/quantity';

/**
 * OB-288 P3: a requisition as head office keeps it — who raised it (server-attributed, §28) and, for WF-03, what it was
 * raised FROM (a replenishment proposal or an A02 draft, turned into a requisition by a buyer's own act).
 */
export interface StoredRequisition extends Requisition {
  readonly raisedBy?: string;
  readonly raisedAt?: string;
  readonly source?: RequisitionSource;
}

/** WF-03: where a requisition came from. Absent = typed by the buyer. */
export type RequisitionSource =
  | { readonly kind: 'replenishment'; readonly storeId: string; readonly proposedAt: string; readonly proposed: Readonly<Record<string, number>> }
  | { readonly kind: 'a02_draft'; readonly proposalIds: readonly string[] };

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
  /**
   * OB-31: the unit head office's product master counts a product in (kg ⇒ a requisition quantity is grams, and a quote is
   * per kg). Absent, or undefined for a product, ⇒ whole items, exactly as before.
   */
  readonly productUom?: (tenantId: string, productId: string) => Promise<string | undefined> | string | undefined;
  readonly now: () => string;
}

/**
 * OB-31: every requisition line names its unit — the one it was raised in, else the product master's today — so the
 * comparison values grams at a per-kg price and the screen reads "2.5 kg", never "2500". A unit the system does not know is
 * left off (whole items), never guessed.
 */
export async function withUnits<R extends Requisition>(deps: RfqDeps, tenantId: string, r: R): Promise<R> {
  if (deps.productUom === undefined) return r;
  const lines = await Promise.all(r.lines.map(async (l): Promise<RequisitionLine> => {
    if (l.uom !== undefined) return l;
    const master = await deps.productUom!(tenantId, l.productId);
    const uom = master === undefined ? undefined : normaliseUom(master);
    return uom === undefined ? l : { ...l, uom };
  }));
  return { ...r, lines };
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
        // OB-31: `quantity` is the product unit's smallest step (grams for kg); the unit is head office's, stamped on the line.
        const req: StoredRequisition = await withUnits(deps, ctx.tenantId, {
          requisitionId,
          currency: b['currency'] as CurrencyCode,
          lines: (lines as RawReqLine[]).map((l): RequisitionLine => ({ productId: l.productId, quantity: l.quantity })),
          // OB-288 P3 (§28): who raised it — the signed-in buyer, never a field — is the requisition step of every order it leads to.
          raisedBy: ctx.userId, raisedAt: deps.now(),
        });
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
        const found = await deps.requisition(ctx.tenantId, requisitionId);
        if (found === undefined) throw notFound(`requisition ${requisitionId}`);
        const requisition = await withUnits(deps, ctx.tenantId, found);
        const quotes = await deps.quotes(ctx.tenantId, requisitionId);
        return { status: 200, body: { comparison: compareQuotes({ requisition, quotes }) } };
      },
    },
    {
      // The buying worklist — every requisition raised.
      api: 'API-03', method: 'GET', path: '/v1/purchase/requisitions',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const requisitions = await Promise.all((await deps.requisitions(ctx.tenantId)).map((r) => withUnits(deps, ctx.tenantId, r)));
        return { status: 200, body: { requisitions, count: requisitions.length } };
      },
    },
  ];
}
