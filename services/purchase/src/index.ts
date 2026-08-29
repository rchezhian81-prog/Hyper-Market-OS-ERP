// API-03 Purchase — suppliers, POs, GRNs, invoices, three-way match.
//
// The single most valuable control on this surface is not about purchasing at all: **a change to a
// supplier's bank details is verified out of band, against a number the supplier gave us before
// the request arrived** (M06, `packages/bank-controls`). Invoice fraud in retail is almost never
// clever — it is an email from a real supplier's real address saying the account has changed, and
// the money leaves on the next payment run. A system that accepts the change because the email
// looked right has no control at all.
//
// The second is the **three-way match**: a PO, a receipt and an invoice must agree before anything
// is paid, and where they do not, what is paid is the *lowest* of the three until a person settles
// it. Paying the invoice and investigating later is how an overcharge becomes permanent.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { threeWayMatch, type MatchLine, type MatchResult } from '../../../packages/purchasing/src/three-way-match';
import {
  matchInvoice, InvalidMatchApprovalError,
  type OrderedLine, type ReceivedLine, type InvoicedLine, type LandedCharges, type MatchPolicy, type MatchApproval,
} from '../../../packages/receiving/src/three-way-match';
import { isCurrencyCode, type Money, type CurrencyCode } from '../../../packages/contracts/src/money';

// The rule itself lives in `packages/purchasing` so the buyer's screen can use the SAME one — a
// browser cannot import this file, which imports the HTTP kernel. Re-exported so every existing
// caller of the service keeps working and there is still exactly one implementation.
export * from '../../../packages/purchasing/src/three-way-match';

// --- readers for the richer three-way match (invoice ↔ PO ↔ receipt + landed cost) ------------------
// This one is stateless: the AP clerk supplies the three source documents, so the figures are validated
// off the wire before they reach the engine. One reporting currency throughout — a Money quoted in
// another currency is refused rather than summed into a mixed-currency total (P-08).
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const moneyIn = (v: unknown, currency: CurrencyCode): Money | undefined =>
  isObj(v) && Number.isInteger(v['minor']) && v['currency'] === currency ? { minor: v['minor'] as number, currency } : undefined;

function readOrdered(v: unknown, currency: CurrencyCode): OrderedLine | undefined {
  if (!isObj(v) || !isStr(v['lineId']) || !isStr(v['productId']) || !isNonNegInt(v['quantityMinor'])) return undefined;
  const unitCost = moneyIn(v['unitCost'], currency);
  if (unitCost === undefined) return undefined;
  return { lineId: v['lineId'] as string, productId: v['productId'] as string, quantityMinor: v['quantityMinor'] as number, unitCost };
}
function readReceived(v: unknown): ReceivedLine | undefined {
  if (!isObj(v) || !isStr(v['lineId']) || !isStr(v['productId']) || !isNonNegInt(v['quantityMinor'])) return undefined;
  return { lineId: v['lineId'] as string, productId: v['productId'] as string, quantityMinor: v['quantityMinor'] as number };
}
function readInvoiced(v: unknown, currency: CurrencyCode): InvoicedLine | undefined {
  if (!isObj(v) || !isStr(v['lineId']) || !isStr(v['productId']) || !isNonNegInt(v['quantityMinor'])) return undefined;
  const unitCost = moneyIn(v['unitCost'], currency);
  if (unitCost === undefined) return undefined;
  if (v['taxMinor'] !== undefined && !isNonNegInt(v['taxMinor'])) return undefined;
  return {
    lineId: v['lineId'] as string, productId: v['productId'] as string, quantityMinor: v['quantityMinor'] as number, unitCost,
    ...(isNonNegInt(v['taxMinor']) ? { taxMinor: v['taxMinor'] } : {}),
  };
}
function readPolicy(v: unknown): MatchPolicy | undefined {
  if (!isObj(v) || !isNonNegInt(v['priceToleranceBp']) || !isNonNegInt(v['quantityToleranceBp']) || !isNonNegInt(v['immaterialMinor'])) return undefined;
  return { priceToleranceBp: v['priceToleranceBp'] as number, quantityToleranceBp: v['quantityToleranceBp'] as number, immaterialMinor: v['immaterialMinor'] as number };
}
function readCharges(v: unknown, currency: CurrencyCode): LandedCharges | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (!isObj(v)) return 'invalid';
  const out: { freight?: Money; duty?: Money; other?: Money } = {};
  for (const k of ['freight', 'duty', 'other'] as const) {
    if (v[k] !== undefined) {
      const mv = moneyIn(v[k], currency);
      if (mv === undefined) return 'invalid';
      out[k] = mv;
    }
  }
  return out;
}
function readApproval(v: unknown): MatchApproval | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (!isObj(v) || !isStr(v['subjectRef']) || !isStr(v['decidedBy'])
    || !(v['status'] === 'approved' || v['status'] === 'rejected' || v['status'] === 'pending')) return 'invalid';
  return { subjectRef: v['subjectRef'] as string, status: v['status'] as MatchApproval['status'], decidedBy: v['decidedBy'] as string };
}

/** Read the whole three-way match off the wire. Returns undefined for any unreadable field. */
function readMatchInput(body: unknown, invoiceId: string): Parameters<typeof matchInvoice>[0] | undefined {
  if (!isObj(body)) return undefined;
  const cur = body['currency'];
  if (typeof cur !== 'string' || !isCurrencyCode(cur) || !isStr(body['receivedBy'])) return undefined;
  if (!Array.isArray(body['ordered']) || !Array.isArray(body['received']) || !Array.isArray(body['invoiced']) || body['invoiced'].length === 0) return undefined;
  const ordered = body['ordered'].map((x) => readOrdered(x, cur));
  const received = body['received'].map(readReceived);
  const invoiced = body['invoiced'].map((x) => readInvoiced(x, cur));
  if (ordered.some((x) => x === undefined) || received.some((x) => x === undefined) || invoiced.some((x) => x === undefined)) return undefined;
  const policy = readPolicy(body['policy']);
  if (policy === undefined) return undefined;
  const charges = readCharges(body['charges'], cur);
  if (charges === 'invalid') return undefined;
  const approval = readApproval(body['approval']);
  if (approval === 'invalid') return undefined;
  return {
    invoiceId,
    ordered: ordered as OrderedLine[], received: received as ReceivedLine[], invoiced: invoiced as InvoicedLine[],
    policy, currency: cur, receivedBy: body['receivedBy'] as string,
    ...(charges !== undefined ? { charges } : {}),
    ...(approval !== undefined ? { approval } : {}),
  };
}

export interface BankChangeRequest {
  readonly supplierId: string;
  readonly newAccount: string;
  readonly requestedVia: 'email' | 'letter' | 'portal' | 'phone_call_we_made';
  /** Confirmed on a number we already held, not one supplied with the request. */
  readonly calledBackOn?: string;
  readonly numberWeAlreadyHeld?: string;
  readonly approvedBy?: string;
  readonly requestedBy: string;
  /**
   * When the request arrived. Required, and it is evidence rather than bookkeeping.
   *
   * "When did this come in?" is the first question at an investigation into a payment that went
   * to the wrong place, and it is also what keeps the record straight when a supplier moves to a
   * new account and later moves back: without a date, the return to the first account looks
   * identical to the original change and collapses into it — leaving the ledger asserting the
   * money still goes to the middle account.
   */
  readonly requestedAt: string;
}

export type BankChangeRefusal =
  | 'no_request_date'
  | 'not_called_back'
  | 'called_back_on_the_number_they_supplied'
  | 'not_approved'
  | 'approved_by_the_requester';

export interface BankChangeResult {
  readonly ok: boolean;
  readonly refusedBecause?: BankChangeRefusal;
  readonly detail: string;
}

/**
 * Verify a supplier bank-detail change.
 *
 * The refusal that matters is the second one. Ringing the number printed on the letter that asks
 * for the change reaches whoever sent the letter — it feels like verification and confirms
 * nothing. The call must go to a number we already held.
 */
export function verifyBankChange(r: BankChangeRequest): BankChangeResult {
  if (typeof r.requestedAt !== 'string' || Number.isNaN(Date.parse(r.requestedAt))) {
    return {
      ok: false, refusedBecause: 'no_request_date',
      detail: `${r.supplierId}'s account change carries no date it was requested on. An undated request cannot be placed against the call that verified it or the payment run that followed, which is the whole sequence an investigation reads`,
    };
  }
  if (r.calledBackOn === undefined) {
    return {
      ok: false, refusedBecause: 'not_called_back',
      detail: `${r.supplierId}'s account change arrived by ${r.requestedVia} and nobody rang them. Invoice fraud in retail is not clever — it is a real supplier's real address saying the account has changed, and the money leaves on the next payment run`,
    };
  }
  if (r.numberWeAlreadyHeld === undefined || r.calledBackOn !== r.numberWeAlreadyHeld) {
    return {
      ok: false, refusedBecause: 'called_back_on_the_number_they_supplied',
      detail: `the call went to ${r.calledBackOn}, which is not the number we already held. Ringing the number on the letter that asks for the change reaches whoever sent the letter — it feels like verification and confirms nothing`,
    };
  }
  if (r.approvedBy === undefined) {
    return { ok: false, refusedBecause: 'not_approved', detail: 'a bank-detail change needs a second person' };
  }
  if (r.approvedBy === r.requestedBy) {
    return { ok: false, refusedBecause: 'approved_by_the_requester', detail: `${r.requestedBy} approved their own bank change for ${r.supplierId}` };
  }
  return { ok: true, detail: `${r.supplierId} verified on ${r.numberWeAlreadyHeld}, approved by ${r.approvedBy}` };
}

export interface PurchaseDeps {
  readonly matchLines: (tenantId: string, invoiceId: string) => Promise<readonly MatchLine[]> | readonly MatchLine[];
  /** Record a supplier invoice's captured lines (ordered/received/invoiced per line) for the match. */
  readonly recordCapture: (tenantId: string, invoiceId: string, lines: readonly MatchLine[]) => Promise<void> | void;
  readonly recordMatch: (tenantId: string, invoiceId: string, r: MatchResult) => Promise<void> | void;
  readonly applyBankChange: (tenantId: string, r: BankChangeRequest) => Promise<void> | void;
  /**
   * What is on order and not yet received.
   *
   * **`undefined` means not known, and that is not the same answer as zero.** Purchase orders are
   * not yet recorded by this API, so a projection over an empty stream would return
   * `{count: 0, valueMinor: 0}` — which an owner reads as "we have nothing on order" and uses to
   * decide what to buy. Not-known is returned as not-known, the same way loyalty points are.
   */
  readonly openCommitments: (tenantId: string) => Promise<Commitments | undefined> | Commitments | undefined;
  readonly now: () => string;
}

export interface Commitments {
  readonly count: number;
  readonly valueMinor: number;
}

export function purchaseRoutes(deps: PurchaseDeps): readonly Route[] {
  return [
    {
      // Capture a supplier invoice's lines against its order and delivery, so the three-way match has
      // something to compare (D03/M07-FR-04). Without this the match route holds no lines for any
      // invoice and correctly refuses every one. Idempotent per invoice: re-sending the same capture
      // collapses rather than doubling the lines.
      api: 'API-03', method: 'POST', path: '/v1/purchase/invoices/:invoiceId/capture',
      permission: 'purchase.invoice.capture', idempotent: true,
      handler: async (ctx) => {
        const invoiceId = ctx.params['invoiceId'] ?? '';
        const lines = (ctx.body as { lines?: readonly MatchLine[] } | null)?.lines;
        if (!Array.isArray(lines) || lines.length === 0) {
          throw apiError(400, {
            code: 'no_lines_captured',
            whatHappened: 'A capture must carry at least one invoice line.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { "lines": [ … ] }. Nothing was captured.',
          });
        }
        for (const l of lines) {
          const nums = [l.orderedQty, l.receivedQty, l.invoicedQty, l.orderedUnitMinor, l.invoicedUnitMinor];
          if (typeof l.productId !== 'string' || l.productId.trim() === '' || !nums.every((n) => Number.isInteger(n) && n >= 0)) {
            throw apiError(422, {
              code: 'line_not_readable',
              whatHappened: 'Every line needs a product and whole, non-negative ordered/received/invoiced quantities and unit prices.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Fix the line and send it again. Nothing was captured.',
            });
          }
        }
        await deps.recordCapture(ctx.tenantId, invoiceId, lines);
        return { status: 201, body: { invoiceId, lines: lines.length } };
      },
    },
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/invoices/:invoiceId/match',
      permission: 'purchase.invoice.match', idempotent: true,
      handler: async (ctx) => {
        const invoiceId = ctx.params['invoiceId'] ?? '';
        const result = threeWayMatch({ lines: await deps.matchLines(ctx.tenantId, invoiceId) });
        await deps.recordMatch(ctx.tenantId, invoiceId, result);
        return { status: 200, body: result };
      },
    },
    {
      // The full three-way match with LANDED COST (M07-FR-04, D03-FR-05, §28). Distinct from /match
      // above (which reconciles pre-captured lines to the lowest of three): this is the stateless
      // reconciliation the AP clerk drives with the three source documents — the purchase ORDER, the
      // goods RECEIPT and the supplier INVOICE — plus freight/duty. It VALUES and OWNS every variance
      // (₹ over-charged on which lines, not "it doesn't tie up"), apportions the charges across the
      // lines to the paisa so the stock's TRUE landed cost is known (valuation that ignores freight
      // overstates margin), and decides PAYABILITY: an out-of-tolerance variance blocks payment until
      // someone who did NOT receive the goods approves it (§28 — the receiver can never clear their own
      // receipt). It DECIDES only; it records nothing. Gated purchase.invoice.match.
      api: 'API-03', method: 'POST', path: '/v1/purchase/invoices/:invoiceId/reconcile',
      permission: 'purchase.invoice.match', idempotent: true,
      handler: async (ctx) => {
        const input = readMatchInput(ctx.body, ctx.params['invoiceId'] ?? '');
        if (input === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_three_way_match',
            whatHappened: 'A three-way match needs { ordered[], received[], invoiced[] } lines (each with a lineId, productId and whole quantities; ordered/invoiced also a unitCost {minor,currency}), a policy { priceToleranceBp, quantityToleranceBp, immaterialMinor }, a currency, who receivedBy, optional charges {freight,duty,other} and an optional approval — all money in the one currency.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the figures and send again — this only reconciles and decides, it pays nothing and records nothing.',
          });
        }
        try {
          return { status: 200, body: matchInvoice(input) };
        } catch (e) {
          if (e instanceof InvalidMatchApprovalError) {
            throw apiError(422, {
              code: 'approval_authorises_a_different_invoice',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send the approval that names THIS invoice, or none. Nothing was changed.',
            });
          }
          throw e;
        }
      },
    },
    {
      api: 'API-03', method: 'POST', path: '/v1/purchase/suppliers/:supplierId/bank-details',
      permission: 'purchase.supplier.bank', idempotent: true,
      handler: async (ctx) => {
        const request = { ...(ctx.body as BankChangeRequest), supplierId: ctx.params['supplierId'] ?? '' };
        const check = verifyBankChange(request);
        if (!check.ok) {
          throw apiError(422, {
            code: check.refusedBecause!,
            whatHappened: check.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The old account is unchanged and payments will still go there. Ring the supplier on a number you already had, then have a second person approve it.',
          });
        }
        await deps.applyBankChange(ctx.tenantId, request);
        return { status: 200, body: { changed: check.detail } };
      },
    },
    {
      api: 'API-03', method: 'GET', path: '/v1/purchase/commitments',
      permission: 'purchase.commitment.read',
      handler: async (ctx) => {
        const open = await deps.openCommitments(ctx.tenantId);
        return {
          status: 200,
          body: open === undefined
            ? {
              known: false, asAt: deps.now(),
              detail: 'what is on order cannot be stated yet, because purchase orders are not recorded in this system. A zero here would read as "we have nothing on order" and be acted on.',
            }
            : { ...open, known: true, asAt: deps.now() },
        };
      },
    },
  ];
}
