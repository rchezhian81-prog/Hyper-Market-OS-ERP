// API-05 Returns — refunds against a banked sale, guarded where the whole history lives.
//
// A return is where money leaves the till, so the controls are not decoration. The offline lane can
// commit a return against its own log, but a lane only knows its own log: the same receipt refunded
// at another lane, at another branch, or online is a refund the lane never saw. This endpoint is the
// authoritative guard, because the cloud is where every return against a bill is visible at once —
// it is the consumer that finally feeds `packages/returns`' register (M13-FR-01/FR-03, M21).
//
// The rule itself is the pure `assessReturn` in `packages/returns`, so the desk's own screen can run
// the identical one; this module is the HTTP skin and the persistence wiring around it.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { assessReturn, type ReturnRequest, type ReturnRequestLine } from '../../../packages/returns/src/assess-return';
import {
  returnRegister, returnableLines, overReturned, alreadyRefundedMinor,
  type OriginalSale, type RecordedReturn,
} from '../../../packages/returns/src/return-register';
import type { RefundStatus } from '../../../packages/returns/src/returns';

export type { OriginalSale, RecordedReturn } from '../../../packages/returns/src/return-register';

/** A refund already given against a bill, for the money cap (M13-FR-03). */
export interface RecordedRefund {
  readonly returnId: string;
  readonly originalSaleId: string | null;
  readonly refundMinor: number;
}

/** The return as it is persisted — enough to re-derive both the register and the refund history. */
export interface ReturnRecord {
  readonly returnId: string;
  readonly number: string;
  readonly originalSaleId: string;
  readonly processedBy: string;
  readonly processedAt: string;
  readonly reasonCode: string;
  readonly refundMinor: number;
  readonly refundTender: string;
  readonly refundStatus: RefundStatus;
  readonly lines: readonly ReturnRequestLine[];
}

export interface ReturnsDeps {
  /** The original bill, or `undefined` if this system never banked it. */
  readonly originalSale: (tenantId: string, saleId: string) => Promise<OriginalSale | undefined> | OriginalSale | undefined;
  /** Every return already recorded against this bill (for the at-most-once register). */
  readonly priorReturns: (tenantId: string, saleId: string) => Promise<readonly RecordedReturn[]> | readonly RecordedReturn[];
  /** Every refund already given against this bill (for the money cap). */
  readonly priorRefunds: (tenantId: string, saleId: string) => Promise<readonly RecordedRefund[]> | readonly RecordedRefund[];
  /** Append the accepted return. Idempotent on the return id. */
  readonly recordReturn: (tenantId: string, saleId: string, record: ReturnRecord) => Promise<void> | void;
  readonly now: () => string;
}

/** Enough of a return to be a return. Anything past this is a finding for `assessReturn`, not here. */
function readReturn(body: unknown, saleId: string): ReturnRequest | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Partial<ReturnRequest>;
  const structural = typeof b.returnId === 'string' && b.returnId.trim() !== ''
    && typeof b.processedBy === 'string' && b.processedBy.trim() !== ''
    && typeof b.reasonCode === 'string'
    && Array.isArray(b.lines)
    && typeof b.refundMinor === 'number' && Number.isInteger(b.refundMinor)
    && typeof b.refundTender === 'string'
    && typeof b.approvalThresholdMinor === 'number' && Number.isInteger(b.approvalThresholdMinor);
  if (!structural) return undefined;
  return {
    ...(b as ReturnRequest),
    originalSaleId: saleId,
    number: typeof b.number === 'string' && b.number.trim() !== '' ? b.number : saleId,
    processedAt: typeof b.processedAt === 'string' && b.processedAt.trim() !== '' ? b.processedAt : '',
  };
}

export function returnsRoutes(deps: ReturnsDeps): readonly Route[] {
  return [
    {
      // Record a refund against a banked sale (M13-FR-01/FR-03, M21). The at-most-once and
      // refund-cap guards run against the whole cloud history of this bill, not one lane's slice.
      api: 'API-05', method: 'POST', path: '/v1/sales/:saleId/returns',
      permission: 'pos.return.record', idempotent: true,
      handler: async (ctx) => {
        const saleId = ctx.params['saleId'] ?? '';
        const request = readReturn(ctx.body, saleId);
        if (request === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_return',
            whatHappened: 'This payload could not be read as a return — it needs a return id, who processed it, a reason code, lines, a whole refund amount, a tender and an approval threshold.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'No money has moved. Fix the return and send it again.',
          });
        }

        // A receipted return is against a bill this system banked. If we never saw the sale, we
        // cannot say what was bought, so there is nothing to return against — refused, not guessed.
        const sale = await deps.originalSale(ctx.tenantId, saleId);
        if (sale === undefined) throw notFound(`sale ${saleId}`);

        const [priorReturns, priorRefunds] = await Promise.all([
          Promise.resolve(deps.priorReturns(ctx.tenantId, saleId)),
          Promise.resolve(deps.priorRefunds(ctx.tenantId, saleId)),
        ]);

        const processedAt = request.processedAt === '' ? deps.now() : request.processedAt;
        const assessment = assessReturn({ sale, priorReturns, priorRefunds, request: { ...request, processedAt } });
        if (!assessment.ok) {
          throw apiError(422, {
            code: assessment.refusedBecause!,
            whatHappened: assessment.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'No money has moved and no stock has changed. Fix the return and send it again.',
          });
        }

        await deps.recordReturn(ctx.tenantId, saleId, {
          returnId: request.returnId, number: request.number, originalSaleId: saleId,
          processedBy: request.processedBy, processedAt, reasonCode: request.reasonCode,
          refundMinor: request.refundMinor, refundTender: request.refundTender,
          refundStatus: assessment.refundStatus, lines: request.lines,
        });

        return {
          status: 201,
          body: {
            returnId: request.returnId,
            refundStatus: assessment.refundStatus,
            restockedLines: assessment.restockedLines,
            remaining: assessment.remaining,
          },
        };
      },
    },
    {
      // What may STILL come back on a bill, and how much money is left to refund on it (M13-FR-01/
      // FR-03, M21). The same register the POST guards against, now legible instead of only enforced:
      // the desk can see, before it takes a return, that two of three units are still returnable and
      // ₹100 of a ₹150 bill is still refundable. Folded from the WHOLE cloud history of the bill —
      // every return at every lane and branch — so it answers what one lane's own log cannot.
      //
      // A desk read, on `pos.sale.read` (owner / manager / cashier). Read-only: it moves no money.
      api: 'API-05', method: 'GET', path: '/v1/sales/:saleId/returnable',
      permission: 'pos.sale.read',
      handler: async (ctx) => {
        const saleId = ctx.params['saleId'] ?? '';
        const sale = await deps.originalSale(ctx.tenantId, saleId);
        if (sale === undefined) throw notFound(`sale ${saleId}`);

        const [priorReturns, priorRefunds] = await Promise.all([
          Promise.resolve(deps.priorReturns(ctx.tenantId, saleId)),
          Promise.resolve(deps.priorRefunds(ctx.tenantId, saleId)),
        ]);
        const returnable = returnableLines(sale, returnRegister(priorReturns));
        const refundedMinor = alreadyRefundedMinor(saleId, priorRefunds);
        return {
          status: 200,
          body: {
            saleId, number: sale.number, totalMinor: sale.totalMinor,
            refundedMinor,
            // The money cap (M13-FR-03): never below zero, so a fully-refunded bill reads 0, not negative.
            refundableMinor: Math.max(0, sale.totalMinor - refundedMinor),
            returnable,
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // Bills where MORE has come back than went out (M21). It should be impossible through this guard,
      // which is exactly why it is worth surfacing rather than clamping away: it means a return was
      // recorded against the wrong bill, or the same goods were refunded twice before this register
      // existed — a migration, or another branch's log synced in. Both are money already gone, and both
      // need a person to look. Detect-only: it names the exposure and reverses nothing, because two
      // people really did receive goods and a human — not a last-write-wins — decides (hard rule #10).
      //
      // A LOSS surface, not a desk one, so it is gated one rung above the returnable read — on
      // `lp.case.read` (owner / manager / accountant), NOT the cashier's `pos.sale.read`. Least
      // privilege (P-04): a cashier taking a return at the desk has no business pulling the shop's
      // over-refund report. Mirrors the stored-value double-spend split exactly.
      api: 'API-05', method: 'GET', path: '/v1/sales/:saleId/over-returns',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const saleId = ctx.params['saleId'] ?? '';
        const sale = await deps.originalSale(ctx.tenantId, saleId);
        if (sale === undefined) throw notFound(`sale ${saleId}`);

        const register = returnRegister(await Promise.resolve(deps.priorReturns(ctx.tenantId, saleId)));
        const over = overReturned(sale, register);
        return {
          status: 200,
          body: { saleId, overReturned: over, anyFound: over.length > 0, asAt: deps.now() },
        };
      },
    },
  ];
}
