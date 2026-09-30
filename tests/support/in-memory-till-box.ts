// A store BOX for the till's cash, in memory — the SAME pure engine the real box runs (`edge/store-edge/src/till-cash.ts`)
// over an array instead of an fsync'd log, so a unit test of the till (or of the till's screen) drives the real decisions
// — one custodian, no overdraw, the blind count, the material-variance reason — without a disk or a socket.
//
// The real box is `main.ts`'s `recordCashMovement` / `closeShift` / `tillCash`; this mirrors their shape exactly, which is
// what makes it honest as a test double: a till that passes against it makes the same calls it makes in the shop. What it
// does NOT do is anything the real box does with I/O — no durability, no queue, no restart. Those are proven by the
// integration suite over `startEdge` (`tests/integration/the-till-closes-through-the-box.test.ts`).

import {
  foldTillCash, decideCashMovement, decideShiftClose, shiftFigures, TILL_CASH_WORDS,
  type TillCashRecord, type CashMovementOutcome, type ShiftCloseOutcome, type TillCashStatus, type TillCashRefusal,
} from '../../edge/store-edge/src/till-cash';
import type { CashMovementWrite, ShiftCloseWrite, TillCashRead } from '../../apps/pos/src/till-session';
import { tradingDate, wallClockIn, makeTradingDayRule } from '../../packages/calendar/src/trading-day';

export interface InMemoryTillBox {
  readonly ports: { readonly cashMovement: CashMovementWrite; readonly shiftClose: ShiftCloseWrite; readonly tillCash: TillCashRead };
  /** Everything the box "wrote", in order — a test reads the records the real box would have on its log. */
  readonly records: readonly TillCashRecord[];
  /** Sales the box "rang" — the cash they put in the drawer counts towards the shift (the real box reads its sale log). */
  ringSale(sale: { readonly id: string; readonly committedAt: string; readonly total: number; readonly tenders: readonly { readonly kind: string; readonly amount: { readonly minor: number } }[]; readonly laneId?: string }): void;
  /** Refunds the box "gave" — a cash one reduces the shift's expected figure (the real box reads its return log). */
  giveRefund(refund: { readonly returnId: string; readonly processedAt: string; readonly refundMinor: number; readonly refundTender: string; readonly laneId?: string }): void;
  /** Make the box unreachable — every port then answers `lane_unreachable`, as the real loopback port does. */
  unplug(): void;
  plug(): void;
}

export function inMemoryTillBox(input: { readonly laneId: string; readonly tradingDayCutoff?: string; readonly toleranceMinor?: number | undefined } = { laneId: 'lane-1' }): InMemoryTillBox {
  const records: TillCashRecord[] = [];
  const sales: unknown[] = [];
  const returns: unknown[] = [];
  let plugged = true;
  const rule = makeTradingDayRule(input.tradingDayCutoff ?? '00:00');
  const dayOf = (at: string): string => tradingDate(wallClockIn(at), rule);
  const refuseCash = (why: TillCashRefusal): CashMovementOutcome => ({ committed: false, refusedBecause: why, laneMessage: TILL_CASH_WORDS[why] });
  const refuseClose = (why: TillCashRefusal, varianceMinor?: number): ShiftCloseOutcome =>
    ({ closed: false, refusedBecause: why, laneMessage: TILL_CASH_WORDS[why], ...(varianceMinor === undefined ? {} : { varianceMinor }) });

  return {
    records,
    ringSale: (sale) => { sales.push(sale); },
    giveRefund: (refund) => { returns.push(refund); },
    unplug: () => { plugged = false; },
    plug: () => { plugged = true; },
    ports: {
      cashMovement: async (req) => {
        if (!plugged) return refuseCash('lane_unreachable');
        const prior = records.find((r) => r.kind === 'movement' && r.movementId === req.movementId);
        if (prior !== undefined && prior.kind === 'movement') {
          const now = foldTillCash(records, input.laneId);
          return { committed: true, alreadyRecorded: true, movementId: prior.movementId, kind: prior.movementKind, custodian: now.custodian, tradingDay: prior.tradingDay, laneMessage: 'Already recorded.' };
        }
        const state = foldTillCash(records, input.laneId);
        const trade = shiftFigures({ state, laneId: input.laneId, closedAt: req.at, sales, returns });
        const decision = decideCashMovement({ state, request: req, laneId: input.laneId, tradingDay: dayOf(req.at), tradingCashMinor: trade.cashSalesMinor - trade.cashRefundsMinor });
        if (!decision.ok) return refuseCash(decision.refusedBecause);
        records.push(decision.record);
        return { committed: true, movementId: req.movementId, kind: req.movementKind, custodian: decision.custodianAfter, tradingDay: decision.record.tradingDay, laneMessage: 'Recorded on the store computer.' };
      },
      shiftClose: async (req) => {
        if (!plugged) return refuseClose('lane_unreachable');
        const prior = records.find((r) => r.kind === 'close' && r.shiftId === req.shiftId);
        if (prior !== undefined && prior.kind === 'close') {
          return { closed: true, alreadyClosed: true, shiftId: prior.shiftId, tradingDay: prior.tradingDay, countedMinor: prior.countedMinor, varianceMinor: prior.varianceMinor, exceptionRaised: prior.exceptionRaised, reasonCode: prior.reasonCode, laneMessage: 'This shift was already closed.' };
        }
        const state = foldTillCash(records, input.laneId);
        const figures = shiftFigures({ state, laneId: input.laneId, closedAt: req.closedAt, sales, returns });
        const decision = decideShiftClose({ state, request: req, laneId: input.laneId, figures, tradingDay: dayOf(req.closedAt), toleranceMinor: input.toleranceMinor });
        if (!decision.ok) return refuseClose(decision.refusedBecause, decision.varianceMinor);
        records.push(decision.record);
        const r = decision.record;
        return { closed: true, shiftId: r.shiftId, tradingDay: r.tradingDay, countedMinor: r.countedMinor, varianceMinor: r.varianceMinor, exceptionRaised: r.exceptionRaised, reasonCode: r.reasonCode, laneMessage: r.exceptionRaised ? 'Closed, with a difference the cash office will review.' : 'Closed.' };
      },
      tillCash: async (): Promise<TillCashStatus | null> => {
        if (!plugged) return null;
        const state = foldTillCash(records, input.laneId);
        return { tillId: input.laneId, laneId: input.laneId, custodian: state.custodian, openedAt: state.openedAt, shiftOpen: state.custodian !== null };
      },
    },
  };
}
