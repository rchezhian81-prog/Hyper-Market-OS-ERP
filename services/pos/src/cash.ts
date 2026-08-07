// API-05 Till cash — float, loans, pickups and safe drops (M14-FR-01). Each is an append-only
// movement; the drawer balance and the current custodian are PROJECTED from them, never stored. Two
// roadmap rules hold on the cloud, where every till's whole chain is visible: ONE custodian per till
// at a time, and no overdraw. The rule is the pure `assessCashMovement` in `packages/cash`, so the
// till's own screen can run the identical one; this module is the HTTP skin and the persistence.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  assessCashMovement, custodianOf, tillDrawerBalanceMinor,
  type CashMovementKind, type StoredCashMovement,
} from '../../../packages/cash/src/index';

export type { StoredCashMovement } from '../../../packages/cash/src/index';

const KINDS: readonly CashMovementKind[] = ['float_issue', 'loan', 'pickup', 'safe_drop', 'float_return'];

/** A cash movement as it is persisted — the signed delta and who held the till. */
export interface RecordedCashMovement {
  readonly movementId: string;
  readonly tillId: string;
  readonly kind: CashMovementKind;
  readonly deltaMinor: number;
  readonly currency: string;
  readonly custodianId: string;
  readonly tradingDay: string;
  readonly at: string;
}

export interface CashDeps {
  readonly tillMovements: (tenantId: string, tillId: string) => Promise<readonly StoredCashMovement[]> | readonly StoredCashMovement[];
  readonly recordCashMovement: (tenantId: string, tillId: string, m: RecordedCashMovement) => Promise<void> | void;
  readonly now: () => string;
}

export function cashRoutes(deps: CashDeps): readonly Route[] {
  return [
    {
      // Record a float issue / loan / pickup / safe drop / float return. Refuses issuing a till that
      // is already held, a movement on a till not held by the named custodian, and any overdraw.
      api: 'API-05', method: 'POST', path: '/v1/tills/:tillId/cash-movements',
      permission: 'cash.movement.record', idempotent: true,
      handler: async (ctx) => {
        const tillId = ctx.params['tillId'] ?? '';
        const b = (ctx.body ?? {}) as { movementId?: unknown; kind?: unknown; amountMinor?: unknown; currency?: unknown; custodianId?: unknown; tradingDay?: unknown };
        if (typeof b.movementId !== 'string' || b.movementId.trim() === ''
          || typeof b.kind !== 'string' || !KINDS.includes(b.kind as CashMovementKind)
          || !Number.isInteger(b.amountMinor) || (b.amountMinor as number) <= 0
          || typeof b.custodianId !== 'string' || b.custodianId.trim() === ''
          || typeof b.tradingDay !== 'string' || b.tradingDay.trim() === '') {
          throw apiError(400, {
            code: 'not_readable_as_a_cash_movement',
            whatHappened: 'A cash movement needs a movement id, a kind (float_issue, loan, pickup, safe_drop or float_return), a positive amount, a custodian and a trading day.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing moved. Send the movement id, kind, amount, custodian and trading day.',
          });
        }

        const request = { movementId: b.movementId, tillId, kind: b.kind as CashMovementKind, amountMinor: b.amountMinor as number, custodianId: b.custodianId };
        const assessment = assessCashMovement({ priorMovements: await deps.tillMovements(ctx.tenantId, tillId), request });
        if (!assessment.ok) {
          throw apiError(422, {
            code: assessment.refusedBecause!,
            whatHappened: assessment.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing moved. A till has one custodian at a time and cannot be overdrawn.',
          });
        }

        await deps.recordCashMovement(ctx.tenantId, tillId, {
          movementId: request.movementId, tillId, kind: request.kind, deltaMinor: assessment.deltaMinor,
          currency: typeof b.currency === 'string' ? b.currency : 'INR', custodianId: request.custodianId,
          tradingDay: b.tradingDay, at: deps.now(),
        });
        return { status: 201, body: { movementId: request.movementId, tillId, kind: request.kind, balanceMinor: assessment.balanceAfterMinor, custodian: assessment.custodianAfter } };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/tills/:tillId/cash',
      permission: 'cash.till.read',
      handler: async (ctx) => {
        const tillId = ctx.params['tillId'] ?? '';
        const movements = await deps.tillMovements(ctx.tenantId, tillId);
        return { status: 200, body: { tillId, custodian: custodianOf(movements, tillId), balanceMinor: tillDrawerBalanceMinor(movements, tillId), asAt: deps.now() } };
      },
    },
  ];
}
