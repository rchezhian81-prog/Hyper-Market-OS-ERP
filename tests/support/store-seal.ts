// The store computer's seal (ADR-0023), applied the way the box applies it — for tests that stand in for the box's sync
// agent and post a relayed fact straight to head office. A real box seals at the till gate, after it verified the person;
// these helpers seal under the same pack signing key head office runs with (the harness's own by default), so head office
// sees what it sees from a real, current store computer.

import { sealDecision, sealTillFact, tillSealKey, APPROVER_STAMP_FIELD, DECIDER_STAMP_FIELD } from '../../packages/identity/src/till-seal';
import { SEALED_DECISIONS } from '../../edge/store-edge/src/decision-seal';
import { TEST_PACK_KEY } from './api-harness';

const LANE = 'lane-1';

type Body = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The four sealers for a head office running with `packSigningKey`. */
export function storeSealer(packSigningKey: string, via = 'pin') {
  const key = tillSealKey(packSigningKey);
  return {
    /** A relayed sale as a current store computer sends it: the cashier it verified, sealed. */
    sale(tenantId: string, sale: Body): Body {
      const userId = str(sale['cashierId']);
      const seal = sealTillFact(key, { fact: 'sale', tenantId, recordId: str(sale['saleId']), laneId: LANE, userId, via, amountMinor: num(sale['totalMinor']) });
      return { ...sale, operatorVerified: { userId, via, laneId: LANE, seal } };
    },
    /** A relayed refund (any kind): who processed it and, when one is named, the manager's approval it spent — sealed. */
    return(tenantId: string, ret: Body): Body {
      const recordId = str(ret['returnId']); const amountMinor = num(ret['refundMinor']); const userId = str(ret['processedBy']);
      const out: Body = {
        ...ret,
        operatorVerified: { userId, via, laneId: LANE, seal: sealTillFact(key, { fact: 'return', tenantId, recordId, laneId: LANE, userId, via, amountMinor }) },
      };
      const approvedBy = str(ret['approvedBy']);
      if (approvedBy !== '') {
        const approvalId = `apr-${recordId}`;
        out['approvalVerified'] = {
          approvalId, approvedBy, laneId: LANE,
          seal: sealTillFact(key, { fact: 'approval', tenantId, recordId, laneId: LANE, userId: approvedBy, via: 'approval', amountMinor, approvalId }),
        };
      }
      return out;
    },
    /** A relayed till cash movement: who did it (the person signed in), sealed. */
    cashMovement(tenantId: string, movement: Body): Body {
      const userId = str(movement['performedBy']) || str(movement['custodianId']);
      const seal = sealTillFact(key, { fact: 'cash_movement', tenantId, recordId: str(movement['movementId']), laneId: LANE, userId, via, amountMinor: num(movement['amountMinor']) });
      return { ...movement, operatorVerified: { userId, via, laneId: LANE, seal } };
    },
    /** A relayed till close: who closed it, sealed. */
    shiftClose(tenantId: string, close: Body): Body {
      const userId = str(close['cashierId']);
      const seal = sealTillFact(key, { fact: 'shift_close', tenantId, recordId: str(close['shiftId']), laneId: LANE, userId, via, amountMinor: num(close['countedMinor']) });
      return { ...close, operatorVerified: { userId, via, laneId: LANE, seal } };
    },
    /**
     * A relayed back-office decision (2b-vi-c-3) as a current store computer sends it when the person it names was signed
     * in: an approval decided, a bill captured, a checklist signed, a migration exception resolved or a total signed.
     * `recordId` when the body does not carry its own id (a route that addresses the record by its path only).
     */
    decision(tenantId: string, type: keyof typeof SEALED_DECISIONS, body: Body, recordId?: string): Body {
      const shape = SEALED_DECISIONS[type]!;
      const record: Body = { ...body };
      delete record[DECIDER_STAMP_FIELD];
      const userId = str(record[shape.named]);
      return { ...record, [DECIDER_STAMP_FIELD]: sealDecision(key, { tenantId, kind: shape.kind, recordId: recordId ?? str(record[shape.id]), record, laneId: LANE, userId, via }) };
    },
    /** A relayed day reopen (2b-vi-c-3): the reopener the box verified, sealed over the body head office reads. */
    dayReopen(tenantId: string, dayCloseId: string, body: Body, opts: { readonly approverToo?: boolean } = {}): Body {
      const userId = str(body['reopenedBy']);
      const approver = str(body['approvedBy']);
      return {
        ...body,
        [DECIDER_STAMP_FIELD]: sealDecision(key, { tenantId, kind: 'day_reopen', recordId: dayCloseId, record: body, laneId: LANE, userId, via }),
        // The approver's own PIN at the box (2b-vi-c-4), when the test stands in for a current store computer.
        ...(opts.approverToo === true && approver !== ''
          ? { [APPROVER_STAMP_FIELD]: sealDecision(key, { tenantId, kind: 'day_reopen_approval', recordId: dayCloseId, record: body, laneId: LANE, userId: approver, via: 'pin' }) }
          : {}),
      };
    },
  };
}

const harness = storeSealer(TEST_PACK_KEY);
/** Sealed for the API harness's head office (`apiHarness`). */
export const sealedSale = harness.sale;
export const sealedReturn = harness.return;
export const sealedCashMovement = harness.cashMovement;
export const sealedShiftClose = harness.shiftClose;
export const sealedDecision = harness.decision;
export const sealedDayReopen = harness.dayReopen;
