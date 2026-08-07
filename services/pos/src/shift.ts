// API-05 Shift close — the cashier's blind cash count and over/short (M14-FR-02). The cashier counts
// the drawer WITHOUT seeing the expected figure; this computes the expected cash and the variance,
// requires a reason for a MATERIAL over/short, and records the close — raising a reconciliation
// exception the cash office can see. The rule is the pure `assessShiftClose` in `packages/till`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { assessShiftClose, type ShiftCloseInput } from '../../../packages/till/src/index';

/** A shift close as it is persisted — enough to list over/short and to answer idempotently. */
export interface ClosedShiftRecord {
  readonly shiftId: string;
  readonly tillId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  readonly expectedMinor: number;
  readonly countedMinor: number;
  readonly varianceMinor: number;
  readonly currency: string;
  readonly exceptionRaised: boolean;
  readonly reasonCode: string | null;
  readonly closedAt: string;
}

export interface ShiftDeps {
  readonly closedShift: (tenantId: string, shiftId: string) => Promise<ClosedShiftRecord | undefined> | ClosedShiftRecord | undefined;
  readonly recordShiftClose: (tenantId: string, record: ClosedShiftRecord) => Promise<void> | void;
  /** Shifts closed with a material over/short — the cash office's reconciliation list. */
  readonly overShortShifts: (tenantId: string) => Promise<readonly ClosedShiftRecord[]> | readonly ClosedShiftRecord[];
  readonly now: () => string;
}

const NUMS = ['openingFloatMinor', 'cashSalesMinor', 'pickupsMinor', 'cashRefundsMinor', 'countedCashMinor', 'toleranceMinor'] as const;

export function shiftRoutes(deps: ShiftDeps): readonly Route[] {
  return [
    {
      // Close a shift against the blind count. A material variance needs a reason; on success the
      // close is recorded and, if material, flagged for reconciliation. Idempotent per shift.
      api: 'API-05', method: 'POST', path: '/v1/shifts/:shiftId/close',
      permission: 'till.shift.close', idempotent: true,
      handler: async (ctx) => {
        const shiftId = ctx.params['shiftId'] ?? '';
        const already = await deps.closedShift(ctx.tenantId, shiftId);
        if (already !== undefined) {
          return { status: 200, body: { shiftId, closed: true, varianceMinor: already.varianceMinor, exceptionRaised: already.exceptionRaised, alreadyClosed: true } };
        }

        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['tillId'] !== 'string' || (b['tillId'] as string).trim() === ''
          || typeof b['cashierId'] !== 'string' || (b['cashierId'] as string).trim() === ''
          || typeof b['tradingDay'] !== 'string' || (b['tradingDay'] as string).trim() === ''
          || !NUMS.every((k) => Number.isInteger(b[k]))) {
          throw apiError(400, {
            code: 'not_readable_as_a_shift_close',
            whatHappened: 'Closing a shift needs a till, a cashier, a trading day, and whole opening float, cash sales, pickups, cash refunds, counted cash and a tolerance.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was closed. Send the till, cashier, day and the cash figures.',
          });
        }

        const input: ShiftCloseInput = {
          openingFloatMinor: b['openingFloatMinor'] as number, cashSalesMinor: b['cashSalesMinor'] as number,
          pickupsMinor: b['pickupsMinor'] as number, cashRefundsMinor: b['cashRefundsMinor'] as number,
          countedCashMinor: b['countedCashMinor'] as number, toleranceMinor: b['toleranceMinor'] as number,
          ...(typeof b['reasonCode'] === 'string' ? { reasonCode: b['reasonCode'] } : {}),
        };
        const result = assessShiftClose(input);
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The drawer is not balanced within tolerance. Enter the reason for the over/short and close it again.',
          });
        }

        const record: ClosedShiftRecord = {
          shiftId, tillId: b['tillId'] as string, cashierId: b['cashierId'] as string, tradingDay: b['tradingDay'] as string,
          expectedMinor: result.expectedMinor, countedMinor: result.countedMinor, varianceMinor: result.varianceMinor,
          currency: typeof b['currency'] === 'string' ? b['currency'] as string : 'INR',
          exceptionRaised: result.exceptionRaised, reasonCode: result.reasonCode, closedAt: deps.now(),
        };
        await deps.recordShiftClose(ctx.tenantId, record);
        return {
          status: 201,
          body: { shiftId, closed: true, expectedMinor: result.expectedMinor, countedMinor: result.countedMinor, varianceMinor: result.varianceMinor, isOver: result.isOver, isShort: result.isShort, exceptionRaised: result.exceptionRaised },
        };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/shifts/over-short',
      permission: 'till.shift.read',
      handler: async (ctx) => {
        const rows = await deps.overShortShifts(ctx.tenantId);
        return {
          status: 200,
          body: {
            overShort: rows.map((r) => ({ shiftId: r.shiftId, tillId: r.tillId, cashierId: r.cashierId, tradingDay: r.tradingDay, varianceMinor: r.varianceMinor, reasonCode: r.reasonCode })),
            totalVarianceMinor: rows.reduce((s, r) => s + r.varianceMinor, 0),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
