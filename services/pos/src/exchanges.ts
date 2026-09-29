// API-05 Exchanges — a return and a replacement sale settled together (M13-FR-03 "support exchanges …
// with approval thresholds", M21, §28, §31). Un-parks the second half of CH-01.
//
// An exchange at the service desk is TWO things that must land together or not at all: the goods
// coming back are credited against the ORIGINAL bill (its register sees the credit, so the same unit
// cannot come back twice and the bill can never be credited past what it was paid), and the goods
// going out are a REAL replacement sale — banked exactly as a till sale is (receipt index, `sold` stock
// movements, intake findings), so it reduces on-hand, files under GST as a new supply beside the credit
// note, and can itself be returned later. The difference is settled by the rules the refund already
// obeys: a refund of the balance is a refund (tender, threshold, a genuine §28 approver, store-credit
// cap and customer); a top-up is collected in tenders that must add up; an even exchange moves no money
// and needs no approver (the roadmap's own words: "a zero-value refund is not material").
//
// The arithmetic is the pure `assessExchange` in `packages/returns/src/exchange.ts` — the desk's screen
// can run the identical rule before it submits; this module is the HTTP skin, the §28/policy gates that
// need role and config reads, and the atomic persistence. Nothing here can be reached by a till with the
// cable out: an offline exchange is a return and a sale at the lane, each already durable-first and
// each reconciling on sync through its own route.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { ReturnRequestLine } from '../../../packages/returns/src/assess-return';
import { DEFAULT_REFUND_THRESHOLD_MINOR } from '../../../packages/returns/src/assess-return';
import { assessExchange, type ReplacementLine } from '../../../packages/returns/src/exchange';
import { assessReturnEligibility, isDataFault } from '../../../packages/returns/src/return-eligibility';
import type { RefundStatus } from '../../../packages/returns/src/returns';
import { issueRefundCredit } from '../../../packages/loyalty/src/stored-value';
import { looksLikeCardNumber } from '../../../packages/ops/src/logging';
import type { ReturnsDeps, ReturnRecord, StoreCreditIssue, ExchangeSettlement } from './returns';
import type { PosDeps } from './index';
import { acceptSale, type IncomingSale, type IncomingTender, type IntakeContext, type IntakeResult } from './sale-intake';

const DISPOSITIONS: ReadonlySet<string> = new Set(['resell', 'quarantine', 'damaged', 'scrap']);
const SETTLED_AT_DESK: ReadonlySet<string> = new Set(['cash', 'store_credit']);
/** The tender kind a replacement sale is paid with out of the returned goods' value. */
export const EXCHANGE_CREDIT_TENDER = 'exchange_credit';

export interface ExchangeDeps extends
  Pick<ReturnsDeps, 'originalSale' | 'priorReturns' | 'priorRefunds' | 'refundThreshold' | 'returnWindow' | 'storeCreditCap' | 'canApproveRefund' | 'recordAudit' | 'now'>,
  Pick<PosDeps, 'catalogue' | 'currentPackVersion' | 'saleHoldingReceipt' | 'isBanked' | 'recordExceptions'> {
  /** The banked original as the lane sent it — for the replacement's defaults (currency, location, lane). */
  readonly bankedSale: (tenantId: string, saleId: string) => Promise<IncomingSale | undefined> | IncomingSale | undefined;
  /**
   * Append, in ONE atomic batch: the return record (credit against the bill) + its projection + the
   * `returned` movements of resold lines; the replacement sale + its receipt index + its `sold` movements;
   * any store credit issued for the balance. Idempotent on the exchange id and the replacement sale id.
   */
  readonly recordExchange: (
    tenantId: string, originalSaleId: string, record: ReturnRecord, replacement: IncomingSale, storeCredit: StoreCreditIssue | undefined,
  ) => Promise<void> | void;
}

interface ExchangeRequest {
  readonly exchangeId: string;
  readonly number: string;
  readonly reasonCode: string;
  readonly returnLines: readonly ReturnRequestLine[];
  readonly replacement: {
    readonly saleId: string;
    readonly receiptNumber: string;
    readonly lines: readonly (ReplacementLine & { readonly batchId?: string; readonly hsnCode?: string; readonly taxRateBps?: number })[];
    readonly locationId?: string;
  };
  readonly settlement: {
    readonly refundTender?: string;
    readonly customerRef?: string;
    readonly topUpTenders?: readonly IncomingTender[];
  };
  readonly approvedBy?: string;
  readonly outOfWindowApprovedBy?: string;
  readonly processedAt?: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function readReturnLines(v: unknown): readonly ReturnRequestLine[] | 'invalid' {
  if (!Array.isArray(v)) return 'invalid';
  const out: ReturnRequestLine[] = [];
  for (const raw of v) {
    if (!isObj(raw)) return 'invalid';
    if (!isStr(raw['productId']) || !isStr(raw['uom']) || !isInt(raw['quantityMinor']) || !isStr(raw['disposition']) || !DISPOSITIONS.has(raw['disposition'])) return 'invalid';
    out.push({
      productId: raw['productId'], uom: raw['uom'], quantityMinor: raw['quantityMinor'],
      disposition: raw['disposition'] as ReturnRequestLine['disposition'],
      ...(isStr(raw['condition']) ? { condition: raw['condition'] } : {}),
      ...(isStr(raw['batchId']) ? { batchId: raw['batchId'] } : {}),
    });
  }
  return out;
}

function readReplacementLines(v: unknown): ExchangeRequest['replacement']['lines'] | 'invalid' {
  if (!Array.isArray(v)) return 'invalid';
  const out: (ReplacementLine & { batchId?: string; hsnCode?: string; taxRateBps?: number })[] = [];
  for (const raw of v) {
    if (!isObj(raw)) return 'invalid';
    if (!isStr(raw['productId']) || !isStr(raw['uom']) || !isInt(raw['quantityMinor']) || !isInt(raw['unitPriceMinor']) || !isInt(raw['lineTotalMinor'])) return 'invalid';
    out.push({
      productId: raw['productId'], uom: raw['uom'], quantityMinor: raw['quantityMinor'],
      unitPriceMinor: raw['unitPriceMinor'], lineTotalMinor: raw['lineTotalMinor'],
      ...(isStr(raw['batchId']) ? { batchId: raw['batchId'] } : {}),
      ...(isStr(raw['hsnCode']) ? { hsnCode: raw['hsnCode'] } : {}),
      ...(isInt(raw['taxRateBps']) ? { taxRateBps: raw['taxRateBps'] } : {}),
    });
  }
  return out;
}

function readTenders(v: unknown): readonly IncomingTender[] | 'invalid' {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return 'invalid';
  const out: IncomingTender[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !isStr(raw['kind']) || !isInt(raw['amountMinor']) || raw['amountMinor'] <= 0) return 'invalid';
    out.push({ kind: raw['kind'], amountMinor: raw['amountMinor'], ...(isStr(raw['ref']) ? { ref: raw['ref'] } : {}) });
  }
  return out;
}

/** Structural read only — every money rule is a named refusal in the handler, never a silent 400. */
function readExchange(body: unknown): ExchangeRequest | undefined {
  if (!isObj(body)) return undefined;
  if (!isStr(body['exchangeId']) || typeof body['reasonCode'] !== 'string' || !isObj(body['replacement'])) return undefined;
  const rep = body['replacement'];
  if (!isStr(rep['saleId']) || !isStr(rep['receiptNumber'])) return undefined;
  const returnLines = readReturnLines(body['returnLines']);
  const replacementLines = readReplacementLines(rep['lines']);
  if (returnLines === 'invalid' || replacementLines === 'invalid') return undefined;
  const settlement = isObj(body['settlement']) ? body['settlement'] : {};
  const topUpTenders = readTenders(settlement['topUpTenders']);
  if (topUpTenders === 'invalid') return undefined;
  return {
    exchangeId: body['exchangeId'],
    number: isStr(body['number']) ? body['number'] : body['exchangeId'],
    reasonCode: body['reasonCode'],
    returnLines,
    replacement: {
      saleId: rep['saleId'], receiptNumber: rep['receiptNumber'], lines: replacementLines,
      ...(isStr(rep['locationId']) ? { locationId: rep['locationId'] } : {}),
    },
    settlement: {
      ...(isStr(settlement['refundTender']) ? { refundTender: settlement['refundTender'] } : {}),
      ...(isStr(settlement['customerRef']) ? { customerRef: settlement['customerRef'] } : {}),
      topUpTenders,
    },
    ...(isStr(body['approvedBy']) ? { approvedBy: body['approvedBy'] } : {}),
    ...(isStr(body['outOfWindowApprovedBy']) ? { outOfWindowApprovedBy: body['outOfWindowApprovedBy'] } : {}),
    ...(isStr(body['processedAt']) ? { processedAt: body['processedAt'] } : {}),
  };
}

export function exchangeRoutes(deps: ExchangeDeps): readonly Route[] {
  return [
    {
      // Exchange goods on a banked bill (M13-FR-03, §28). No money has moved yet, so every breach is REFUSED
      // here, never recorded: a bill this system never saw; an out-of-window return without a supervisor;
      // more coming back than was sold; a credit past what the bill was paid; a balance refund with no
      // tender, no approver, a self-approval or an approver without authority; a top-up whose tenders do
      // not add up; store credit without a customer or over its cap; a card number where a tender reference
      // should be (hard rule #3).
      api: 'API-05', method: 'POST', path: '/v1/sales/:saleId/exchanges',
      permission: 'pos.return.record', idempotent: true,
      handler: async (ctx) => {
        const saleId = ctx.params['saleId'] ?? '';
        const req = readExchange(ctx.body);
        if (req === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_an_exchange',
            whatHappened: 'This payload could not be read as an exchange — it needs an exchangeId, a reasonCode, returnLines (product, uom, whole quantity, disposition), and a replacement { saleId, receiptNumber, lines (product, uom, quantity, unitPriceMinor, lineTotalMinor) }; optional settlement { refundTender, customerRef, topUpTenders }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'No money has moved and no stock has changed. Fix the exchange and send it again.',
          });
        }
        if (req.reasonCode.trim() === '') {
          throw apiError(422, { code: 'no_reason', whatHappened: 'An exchange must say why the goods are coming back.', wasItSaved: 'not_saved', nextSafeAction: 'Pick a reason and send it again. No money has moved.' });
        }
        for (const t of req.settlement.topUpTenders ?? []) {
          if (t.ref !== undefined && looksLikeCardNumber(t.ref)) {
            throw apiError(422, {
              code: 'card_data_refused',
              whatHappened: 'A tender reference looks like a card number. Card numbers are never stored (hard rule #3).',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send the payment provider\'s token or reference, never the card number. No money has moved.',
            });
          }
        }

        const sale = await deps.originalSale(ctx.tenantId, saleId);
        const banked = await deps.bankedSale(ctx.tenantId, saleId);
        if (sale === undefined || banked === undefined) throw notFound(`sale ${saleId}`);
        if (req.replacement.saleId === saleId) {
          throw apiError(422, {
            code: 'replacement_is_the_original',
            whatHappened: 'The replacement sale must have its own id — it is a new sale, not the bill being exchanged.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Mint a new sale id for the replacement. No money has moved.',
          });
        }
        if (await deps.isBanked(ctx.tenantId, req.replacement.saleId)) {
          // The same exchange resent lands on the same ids and dedups; a DIFFERENT exchange reusing a sale id
          // would silently merge two sales — refused before anything is written.
          const prior = (await Promise.resolve(deps.priorReturns(ctx.tenantId, saleId))).find((r) => r.returnId === req.exchangeId);
          if (prior === undefined) {
            throw apiError(409, {
              code: 'replacement_sale_id_in_use',
              whatHappened: `Sale ${req.replacement.saleId} is already banked and does not belong to exchange ${req.exchangeId}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Mint a new sale id for the replacement. No money has moved.',
            });
          }
        }

        const processedAt = req.processedAt ?? deps.now();

        // Return eligibility (M13-FR-02) — the same window and supervisor override as a plain return.
        let outOfWindowApprovedBy: string | undefined;
        const returnWindowDays = await deps.returnWindow(ctx.tenantId);
        if (returnWindowDays !== undefined) {
          const elig = assessReturnEligibility({ soldAt: sale.committedAt, returnedAt: processedAt, returnWindowDays });
          if (!elig.eligible) {
            if (isDataFault(elig.status)) {
              throw apiError(422, { code: elig.status, whatHappened: elig.detail, wasItSaved: 'not_saved', nextSafeAction: 'No money has moved. The sale or exchange date looks wrong — fix the record rather than authorise it.' });
            }
            const overrideBy = req.outOfWindowApprovedBy;
            if (overrideBy === undefined) {
              throw apiError(422, { code: elig.status, whatHappened: elig.detail, wasItSaved: 'not_saved', nextSafeAction: 'Have a supervisor/manager authorise this out-of-window exchange (send outOfWindowApprovedBy), or it cannot be taken. No money has moved.' });
            }
            if (overrideBy === ctx.userId) {
              throw apiError(422, { code: 'out_of_window_self_authorised', whatHappened: `${ctx.userId} cannot authorise their own out-of-window exchange (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'A different supervisor/manager must authorise it. No money has moved.' });
            }
            if (!(await deps.canApproveRefund(ctx.tenantId, overrideBy))) {
              throw apiError(422, { code: 'out_of_window_approver_may_not_authorise', whatHappened: `${overrideBy} does not hold the authority to authorise an out-of-window exchange.`, wasItSaved: 'not_saved', nextSafeAction: 'A supervisor/manager (one who can approve refunds) must authorise it. No money has moved.' });
            }
            outOfWindowApprovedBy = overrideBy;
          }
        }

        // The arithmetic and the two register rules, against the whole history of the bill.
        const [priorReturns, priorRefunds] = await Promise.all([
          Promise.resolve(deps.priorReturns(ctx.tenantId, saleId)),
          Promise.resolve(deps.priorRefunds(ctx.tenantId, saleId)),
        ]);
        const assessment = assessExchange({
          sale, priorReturns, priorRefunds,
          exchange: { exchangeId: req.exchangeId, returnLines: req.returnLines, replacementLines: req.replacement.lines },
        });
        if (!assessment.ok) {
          throw apiError(422, { code: assessment.refusedBecause!, whatHappened: assessment.detail, wasItSaved: 'not_saved', nextSafeAction: 'No money has moved and no stock has changed. Fix the exchange and send it again.' });
        }

        // Settle the balance by the refund's own rules (M13-FR-03, §28).
        const thresholdMinor = (await deps.refundThreshold(ctx.tenantId)) ?? DEFAULT_REFUND_THRESHOLD_MINOR;
        let refundStatus: RefundStatus = 'settled';
        let storeCredit: StoreCreditIssue | undefined;
        let creditBalanceMinor: number | undefined;
        const topUp = req.settlement.topUpTenders ?? [];
        if (assessment.balance === 'refund') {
          const refundMinor = assessment.balanceMinor;
          const tender = req.settlement.refundTender;
          if (tender === undefined) {
            throw apiError(422, {
              code: 'refund_tender_required',
              whatHappened: `The shop owes the customer ${refundMinor} paise on this exchange; say how it is refunded (settlement.refundTender).`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send settlement.refundTender (cash, card, upi or store_credit). No money has moved.',
            });
          }
          if (topUp.length > 0) {
            throw apiError(422, { code: 'top_up_not_owed', whatHappened: 'The shop owes the customer on this exchange — no top-up tenders may be collected.', wasItSaved: 'not_saved', nextSafeAction: 'Remove settlement.topUpTenders. No money has moved.' });
          }
          const material = refundMinor > 0 && refundMinor >= thresholdMinor;
          if (material) {
            if (req.approvedBy === undefined) {
              throw apiError(422, { code: 'needs_a_second_person', whatHappened: `A balance refund of ${refundMinor} paise is at or above this shop's approval threshold (${thresholdMinor}) and needs a second person (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'Have a supervisor/manager approve it (send approvedBy). No money has moved.' });
            }
            if (req.approvedBy === ctx.userId) {
              throw apiError(422, { code: 'approved_by_the_person_processing_it', whatHappened: `${ctx.userId} cannot approve their own balance refund (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'A different supervisor/manager must approve it. No money has moved.' });
            }
            if (!(await deps.canApproveRefund(ctx.tenantId, req.approvedBy))) {
              throw apiError(422, { code: 'approver_may_not_approve', whatHappened: `${req.approvedBy} does not hold the authority to approve a refund, so their approval of this balance does not count.`, wasItSaved: 'not_saved', nextSafeAction: 'Have a supervisor/manager (one who can approve refunds) approve it. No money has moved.' });
            }
          }
          refundStatus = SETTLED_AT_DESK.has(tender) ? 'settled' : 'pending';
          if (tender === 'store_credit') {
            const customerRef = req.settlement.customerRef;
            if (customerRef === undefined) {
              throw apiError(422, { code: 'store_credit_needs_a_customer', whatHappened: 'A store-credit balance must name the customer it is issued to (settlement.customerRef).', wasItSaved: 'not_saved', nextSafeAction: 'Identify the customer, or refund the balance another way. No money has moved.' });
            }
            const capMinor = await deps.storeCreditCap(ctx.tenantId);
            const issue = issueRefundCredit({ ownerRef: customerRef, amountMinor: refundMinor, returnId: req.exchangeId, at: processedAt, ...(capMinor === undefined ? {} : { capMinor }) });
            if (!issue.ok) {
              const code = issue.outcome === 'cap_not_configured' ? 'store_credit_unavailable' : issue.outcome === 'cap_exceeded' ? 'store_credit_over_cap' : 'store_credit_amount_invalid';
              throw apiError(422, { code, whatHappened: issue.detail, wasItSaved: 'not_saved', nextSafeAction: issue.outcome === 'cap_not_configured' ? 'Set a store-credit cap (owner) before issuing store credit, or refund the balance another way. No money has moved.' : 'Refund the balance another way. No money has moved.' });
            }
            storeCredit = { movement: issue.movement!, ...(issue.instrument === undefined ? {} : { instrument: issue.instrument }) };
            creditBalanceMinor = issue.balanceAfterMinor;
          }
        } else if (assessment.balance === 'top_up') {
          const collected = topUp.reduce((s, t) => s + t.amountMinor, 0);
          if (collected !== assessment.balanceMinor) {
            throw apiError(422, {
              code: 'top_up_does_not_match_balance',
              whatHappened: `The customer owes ${assessment.balanceMinor} paise on this exchange but the tenders sent add to ${collected}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Collect exactly the difference (settlement.topUpTenders must sum to it). No money has moved.',
            });
          }
        } else if (topUp.length > 0) {
          throw apiError(422, { code: 'top_up_not_owed', whatHappened: 'This is an even exchange — nothing is owed either way, so no tenders may be collected.', wasItSaved: 'not_saved', nextSafeAction: 'Remove settlement.topUpTenders. No money has moved.' });
        }

        // The replacement is a REAL sale — banked as a till sale would be, paid out of the returned value
        // (`exchange_credit`) plus any top-up, so its tenders sum to its total. Same location as the original
        // where the desk named none, so what left a shelf comes back to it and the replacement leaves from it.
        const replacement: IncomingSale = {
          saleId: req.replacement.saleId,
          receiptNumber: req.replacement.receiptNumber,
          laneId: banked.laneId,
          ...(req.replacement.locationId !== undefined ? { locationId: req.replacement.locationId } : banked.locationId !== undefined ? { locationId: banked.locationId } : {}),
          cashierId: ctx.userId,
          tradingDay: processedAt.slice(0, 10),
          committedAt: processedAt,
          totalMinor: assessment.replacementTotalMinor,
          currency: banked.currency,
          packVersion: await deps.currentPackVersion(ctx.tenantId),
          lines: req.replacement.lines,
          tenders: [
            ...(assessment.appliedMinor > 0 ? [{ kind: EXCHANGE_CREDIT_TENDER, amountMinor: assessment.appliedMinor }] : []),
            ...topUp,
          ],
        };
        const intake: IntakeResult = acceptSale(replacement, {
          catalogue: await deps.catalogue(ctx.tenantId),
          currentPackVersion: replacement.packVersion,
          saleHoldingThisReceipt: await deps.saleHoldingReceipt(ctx.tenantId, replacement.receiptNumber),
          alreadyBanked: await deps.isBanked(ctx.tenantId, replacement.saleId),
          now: deps.now(),
        } satisfies IntakeContext);

        const settlement: ExchangeSettlement = {
          exchangeId: req.exchangeId, replacementSaleId: replacement.saleId,
          replacementTotalMinor: assessment.replacementTotalMinor, appliedMinor: assessment.appliedMinor,
          balance: assessment.balance, balanceMinor: assessment.balanceMinor,
          ...(assessment.balance === 'refund' && req.settlement.refundTender !== undefined ? { balanceTender: req.settlement.refundTender } : {}),
          ...(assessment.balance === 'top_up' ? { topUpTenders: topUp.map((t) => ({ kind: t.kind, amountMinor: t.amountMinor })) } : {}),
        };
        const record: ReturnRecord = {
          returnId: req.exchangeId, number: req.number, originalSaleId: saleId,
          processedBy: ctx.userId, processedAt, reasonCode: req.reasonCode,
          // The value credited against the bill — what the register and the refund cap see (M13-FR-03).
          refundMinor: assessment.returnedValueMinor, refundTender: 'exchange', refundStatus,
          lines: req.returnLines,
          ...(req.approvedBy === undefined ? {} : { approvedBy: req.approvedBy }),
          ...(storeCredit === undefined ? {} : { customerRef: req.settlement.customerRef }),
          exchange: settlement,
        };
        await deps.recordExchange(ctx.tenantId, saleId, record, replacement, storeCredit);
        if (!intake.alreadyBanked && intake.exceptions.length > 0) await deps.recordExceptions(ctx.tenantId, intake.exceptions);

        // Seal the fact (M34-FR-01): what came back, what went out, how the balance moved, who approved. No
        // tender instrument (hard rule #3).
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'exchange.accept', objectType: 'sale', objectId: saleId,
          at: processedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            exchangeId: req.exchangeId, replacementSaleId: replacement.saleId,
            returnedValueMinor: String(assessment.returnedValueMinor), replacementTotalMinor: String(assessment.replacementTotalMinor),
            balance: assessment.balance, balanceMinor: String(assessment.balanceMinor),
            reasonCode: req.reasonCode, refundStatus, approvedBy: req.approvedBy ?? '',
            ...(outOfWindowApprovedBy === undefined ? {} : { outOfWindowApprovedBy }),
            ...(storeCredit === undefined ? {} : { storeCreditInstrumentId: storeCredit.movement.instrumentId }),
          },
          correlationId: req.exchangeId,
        });

        return {
          status: 201,
          body: {
            exchangeId: req.exchangeId, originalSaleId: saleId, replacementSaleId: replacement.saleId,
            returnedValueMinor: assessment.returnedValueMinor, replacementTotalMinor: assessment.replacementTotalMinor,
            balance: {
              kind: assessment.balance, amountMinor: assessment.balanceMinor,
              ...(assessment.balance === 'refund' ? { tender: req.settlement.refundTender, refundStatus } : {}),
              ...(assessment.balance === 'top_up' ? { tenders: topUp.map((t) => ({ kind: t.kind, amountMinor: t.amountMinor })) } : {}),
            },
            restockedLines: assessment.restockedLines,
            remaining: assessment.remaining,
            ...(storeCredit === undefined ? {} : { storeCredit: { instrumentId: storeCredit.movement.instrumentId, balanceMinor: creditBalanceMinor } }),
            // The replacement's intake findings (a product not in the catalogue, a reused receipt number…):
            // recorded as exceptions like any sale's, and shown to the desk (P-08).
            replacementIntake: { exceptions: intake.exceptions, detail: intake.detail },
          },
        };
      },
    },
  ];
}
