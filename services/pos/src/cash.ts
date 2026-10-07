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
import { TILL_AUTHORITY } from './sale-intake';
import { cashierSealFlags, stampIn, type CashierSealFlag } from './store-seal';

export type { StoredCashMovement } from '../../../packages/cash/src/index';

const KINDS: readonly CashMovementKind[] = ['float_issue', 'loan', 'pickup', 'safe_drop', 'float_return'];
/** Whether a kind adds to (+1) or removes from (−1) the drawer — for a relayed movement the cloud's chain refused. */
const DRAWER_SIGN: Readonly<Record<CashMovementKind, 1 | -1>> = Object.freeze({ float_issue: 1, loan: 1, pickup: -1, safe_drop: -1, float_return: -1 });

/**
 * A movement as the cash office reads it back: the chain the guard judges, plus what a relayed one carried — which lane
 * it happened on and any flag the cloud raised when it re-verified the record (SP-4c). Never a permission to anything.
 */
export type TillMovement = StoredCashMovement & {
  readonly laneId?: string;
  readonly performedBy?: string;
  readonly relayed?: true;
  readonly flags?: readonly string[];
};

/** What the cloud found when it re-verified a movement the store box relayed (SP-4c · §28 · hard rule #10). */
export type CashGovernanceFlag =
  /** The store computer's seal on who did it is missing, or does not match this movement (ADR-0023 · PF-02). */
  | CashierSealFlag
  /** The named custodian holds no grant at all — a name head office does not know. */
  | 'custodian_unknown'
  /** The named custodian is known but holds no till authority. */
  | 'custodian_lacks_authority'
  /** The person who recorded it at the till is unknown / holds no till authority. */
  | 'recorder_unknown' | 'recorder_lacks_authority'
  /** The cloud's own chain for this till would have refused the movement — recorded as it happened, flagged, never dropped. */
  | 'chain_till_already_assigned' | 'chain_till_not_held_by_this_custodian' | 'chain_insufficient_till_cash' | 'chain_amount_not_positive';

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
  /** Set on a movement the store box relayed (SP-4c): where it happened, who keyed it, and what the cloud found. */
  readonly laneId?: string;
  readonly performedBy?: string;
  readonly relayed?: true;
  readonly flags?: readonly CashGovernanceFlag[];
}

export interface CashDeps {
  readonly tillMovements: (tenantId: string, tillId: string) => Promise<readonly TillMovement[]> | readonly TillMovement[];
  readonly recordCashMovement: (tenantId: string, tillId: string, m: RecordedCashMovement) => Promise<void> | void;
  readonly now: () => string;
  /**
   * The permissions a named person holds through their grants; `undefined` when they hold none (an unknown name). The
   * synced route re-verifies the custodian and the recorder a relayed movement names (SP-4c · §28 · hard rule #4).
   * Absent → the route raises no person finding (a composition with no grants register).
   */
  readonly permissionsOfUser?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** The key head office checks the store computer's seal with (ADR-0023) — on a relayed movement. Absent → not checked. */
  readonly tillSealKey?: Buffer;
}

/**
 * Re-verify a person a relayed record names against their grants: unknown, or known without till authority, is a flag —
 * never a refusal of money that already moved at the lane (record-and-flag, hard rule #10). Shared by the two synced routes.
 */
export async function personFindings(
  deps: { readonly permissionsOfUser?: CashDeps['permissionsOfUser'] }, tenantId: string, userId: string,
  unknown: string, lacks: string,
): Promise<string[]> {
  if (deps.permissionsOfUser === undefined) return [];
  const held = await deps.permissionsOfUser(tenantId, userId);
  if (held === undefined) return [unknown];
  return held.includes(TILL_AUTHORITY) ? [] : [lacks];
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

        // Who did it is the signed-in caller (audit PF-02 · M14-FR-01), never a body value. A till is put in the name of a
        // person head office knows who holds till authority — a name alone is not a person who holds the till. Every later
        // movement must name the CURRENT holder (the chain below), so a float can still come back from someone who has
        // since left.
        const custodian = b.kind !== 'float_issue' ? []
          : await personFindings(deps, ctx.tenantId, b.custodianId, 'custodian_unknown', 'custodian_lacks_authority');
        if (custodian.length > 0) {
          throw apiError(422, {
            code: custodian[0]!,
            whatHappened: custodian[0] === 'custodian_unknown'
              ? `Head office does not know ${b.custodianId}, so the till cannot be put in their name.`
              : `${b.custodianId} is not allowed to hold a till.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing moved. Name the cashier who holds this till.',
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
          tradingDay: b.tradingDay, at: deps.now(), performedBy: ctx.userId,
        });
        return { status: 201, body: { movementId: request.movementId, tillId, kind: request.kind, balanceMinor: assessment.balanceAfterMinor, custodian: assessment.custodianAfter } };
      },
    },
    {
      // A cash movement that ALREADY HAPPENED at the till, relayed by the store box under the store's sync identity
      // (SP-4c · F10 · M14-FR-01 · §31 · §28). The box judged and recorded it on the lane's own chain; the cloud never
      // refuses it (202 always — a 4xx would tell the box the money did not move). It RE-VERIFIES the custodian and the
      // recorder from their grants, re-runs the chain guard against every till's whole history it holds, and records the
      // movement WITH any finding as a visible flag (record-and-flag, hard rule #10) — never silently applied, never
      // silently dropped. Idempotent on the till's own movement id: a re-send after a lost reply collapses to one.
      api: 'API-05', method: 'POST', path: '/v1/tills/:tillId/cash-movements/synced',
      permission: 'cash.movement.sync', idempotent: true,
      handler: async (ctx) => {
        const tillId = ctx.params['tillId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const str = (k: string): string | undefined => (typeof b[k] === 'string' && (b[k] as string).trim() !== '' ? (b[k] as string) : undefined);
        const movementId = str('movementId'); const kind = str('kind'); const custodianId = str('custodianId');
        const tradingDay = str('tradingDay'); const at = str('at'); const performedBy = str('performedBy') ?? custodianId; const laneId = str('laneId');
        const amountMinor = b['amountMinor'];
        if (movementId === undefined || kind === undefined || !KINDS.includes(kind as CashMovementKind) || custodianId === undefined || performedBy === undefined
          || tradingDay === undefined || at === undefined || Number.isNaN(Date.parse(at))
          || !Number.isInteger(amountMinor) || (amountMinor as number) <= 0) {
          throw apiError(400, {
            code: 'not_readable_as_a_synced_cash_movement',
            whatHappened: 'A relayed cash movement needs a movement id, a kind, a positive whole amount, a custodian, a trading day and the moment it happened.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. The box must send the movement as it recorded it.',
          });
        }
        const prior = await deps.tillMovements(ctx.tenantId, tillId);
        const already = prior.find((m) => m.movementId === movementId);
        if (already !== undefined) {
          return { status: 200, body: { movementId, tillId, recorded: true, alreadyRecorded: true, flags: already.flags ?? [] } };
        }

        const flags: string[] = [
          ...await personFindings(deps, ctx.tenantId, custodianId, 'custodian_unknown', 'custodian_lacks_authority'),
          ...(performedBy === custodianId ? [] : await personFindings(deps, ctx.tenantId, performedBy, 'recorder_unknown', 'recorder_lacks_authority')),
          // Whether the store computer vouches for who did it (ADR-0023 · PF-02): the person it verified at the till.
          ...cashierSealFlags(deps.tillSealKey, {
            fact: 'cash_movement', tenantId: ctx.tenantId, recordId: movementId, amountMinor: amountMinor as number, named: performedBy,
            stamp: stampIn(ctx.body, 'operatorVerified'),
          }),
        ];
        const request = { movementId, tillId, kind: kind as CashMovementKind, amountMinor: amountMinor as number, custodianId };
        const assessment = assessCashMovement({ priorMovements: prior, request });
        if (!assessment.ok) flags.push(`chain_${assessment.refusedBecause!}`);
        // The money moved at the lane whatever the cloud's chain says: recorded with the sign the kind carries.
        const deltaMinor = assessment.ok ? assessment.deltaMinor : DRAWER_SIGN[kind as CashMovementKind] * (amountMinor as number);

        await deps.recordCashMovement(ctx.tenantId, tillId, {
          movementId, tillId, kind: kind as CashMovementKind, deltaMinor,
          currency: typeof b['currency'] === 'string' ? (b['currency'] as string) : 'INR',
          custodianId, tradingDay, at, performedBy, relayed: true,
          ...(laneId === undefined ? {} : { laneId }),
          ...(flags.length === 0 ? {} : { flags: flags as CashGovernanceFlag[] }),
        });
        return { status: 202, body: { movementId, tillId, recorded: true, flags } };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/tills/:tillId/cash',
      permission: 'cash.till.read',
      handler: async (ctx) => {
        const tillId = ctx.params['tillId'] ?? '';
        const movements = await deps.tillMovements(ctx.tenantId, tillId);
        return {
          status: 200,
          body: {
            tillId, custodian: custodianOf(movements, tillId), balanceMinor: tillDrawerBalanceMinor(movements, tillId),
            // Relayed movements the cloud flagged when it re-verified them (SP-4c) — for the cash office to look at (P-08).
            flagged: movements.filter((m) => (m.flags?.length ?? 0) > 0).map((m) => ({ movementId: m.movementId, kind: m.kind, custodianId: m.custodianId, laneId: m.laneId ?? null, flags: m.flags })),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
