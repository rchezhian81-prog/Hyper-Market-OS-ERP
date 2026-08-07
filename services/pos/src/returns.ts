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
import type { OriginalSale, RecordedReturn } from '../../../packages/returns/src/return-register';
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
  ];
}
