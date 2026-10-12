// API-05 Till cash — float, loans, pickups and safe drops (M14-FR-01). Each is an append-only
// movement; the drawer balance and the current custodian are PROJECTED from them, never stored. Two
// roadmap rules hold on the cloud, where every till's whole chain is visible: ONE custodian per till
// at a time, and no overdraw. The rule is the pure `assessCashMovement` in `packages/cash`, so the
// till's own screen can run the identical one; this module is the HTTP skin and the persistence.

import type { Route } from '../../kernel/src/index';
import { apiError, assertRecordBranchInScope } from '../../kernel/src/index';
import {
  assessCashMovement, custodianOf, tillDrawerBalanceMinor,
  type CashMovementKind, type StoredCashMovement,
} from '../../../packages/cash/src/index';
import { TILL_AUTHORITY } from './sale-intake';
import { cashierSealFlags, stampIn, type CashierSealFlag } from './store-seal';
import { tillStoreOf, type TillStoreDeps } from './till-store';
import type { AuditEntry } from '../../../packages/audit/src/index';

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
  /**
   * OB-80 "A": the store whose till this is — a till is (store, till). Absent only on a movement kept by the till's id
   * alone: one taken before OB-80, or in a business with one store where nothing can clash (`till-store.ts`).
   */
  readonly storeId?: string;
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

export interface CashDeps extends TillStoreDeps {
  /**
   * OB-80: one till's chain — the till at `storeId` (with, under the migration rule, what was kept by its id alone before
   * OB-80 when that belongs to the same store); with no store, the chain kept by the till's id alone.
   */
  readonly tillMovements: (tenantId: string, tillId: string, storeId?: string) => Promise<readonly TillMovement[]> | readonly TillMovement[];
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
  /**
   * OB-82: the till's records kept by its id ALONE (before OB-80) and their one-time placement, when made. Absent → the
   * composition keeps no such records.
   */
  readonly legacyTill?: (tenantId: string, tillId: string) => Promise<LegacyTillView> | LegacyTillView;
  /** OB-82: record the one-time placement — the first stands for ever; returns the one that stands and whether this made it. */
  readonly placeLegacyTill?: (tenantId: string, p: LegacyTillPlacementRecord) => Promise<{ readonly placement: LegacyTillPlacementRecord; readonly recorded: boolean }>;
  /** Seal a person's placement into the audit trail (M34). Optional on a bare stub. */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

/** OB-82 "A": the one-time, append-only "till X's pre-OB-80 records are store S's" fact. */
export interface LegacyTillPlacementRecord {
  readonly tillId: string;
  readonly storeId: string;
  readonly placedBy: string;
  readonly how: 'single_store_rule' | 'head_office';
  readonly reason: string;
  readonly at: string;
  readonly storesKnown: readonly string[];
}
export interface LegacyTillView {
  readonly placement?: LegacyTillPlacementRecord;
  readonly movements: readonly TillMovement[];
}

const sameMovement = (m: TillMovement, kind: string, amountMinor: number, custodianId: string): boolean =>
  m.kind === kind && Math.abs(m.deltaMinor) === amountMinor && m.custodianId === custodianId;

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
        const storeId = await tillStoreOf(deps, ctx, tillId, (b as Record<string, unknown>)['storeId']);
        const request = { movementId: b.movementId, tillId, kind: b.kind as CashMovementKind, amountMinor: b.amountMinor as number, custodianId: b.custodianId };
        const prior = await deps.tillMovements(ctx.tenantId, tillId, storeId);
        // OB-82: a movement id already on this till's chain (its own, or the old chain placed here) is that movement — the
        // same one again is answered as recorded; a different movement under the same id is refused by name (one id, one movement).
        const onFile = prior.find((m) => m.movementId === request.movementId);
        if (onFile !== undefined) {
          if (sameMovement(onFile, request.kind, request.amountMinor, request.custodianId)) {
            return { status: 200, body: { movementId: request.movementId, tillId, storeId: storeId ?? null, kind: request.kind, alreadyRecorded: true, balanceMinor: tillDrawerBalanceMinor(prior, tillId), custodian: custodianOf(prior, tillId) } };
          }
          throw apiError(409, {
            code: 'movement_id_already_used',
            whatHappened: `Movement ${request.movementId} is already on till ${tillId}'s record as a different movement (${onFile.kind} of ${Math.abs(onFile.deltaMinor)} held by ${onFile.custodianId}).`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing moved. Give the new movement its own id.',
          });
        }
        const assessment = assessCashMovement({ priorMovements: prior, request });
        if (!assessment.ok) {
          throw apiError(422, {
            code: assessment.refusedBecause!,
            whatHappened: assessment.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing moved. A till has one custodian at a time and cannot be overdrawn.',
          });
        }

        await deps.recordCashMovement(ctx.tenantId, tillId, {
          movementId: request.movementId, tillId, ...(storeId === undefined ? {} : { storeId }), kind: request.kind, deltaMinor: assessment.deltaMinor,
          currency: typeof b.currency === 'string' ? b.currency : 'INR', custodianId: request.custodianId,
          tradingDay: b.tradingDay, at: deps.now(), performedBy: ctx.userId,
        });
        return { status: 201, body: { movementId: request.movementId, tillId, storeId: storeId ?? null, kind: request.kind, balanceMinor: assessment.balanceAfterMinor, custodian: assessment.custodianAfter } };
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
        // OB-80: the till is (store, till) — a box's own store is stamped on the movement by head office.
        const storeId = await tillStoreOf(deps, ctx, tillId, b['storeId']);
        const prior = await deps.tillMovements(ctx.tenantId, tillId, storeId);
        const already = prior.find((m) => m.movementId === movementId);
        if (already !== undefined) {
          return { status: 200, body: { movementId, tillId, storeId: storeId ?? null, recorded: true, alreadyRecorded: true, flags: already.flags ?? [] } };
        }
        // OB-82: the very movement already kept on the till's OLD chain (before OB-80) while that chain is not yet placed —
        // re-sent after a lost reply. It is the same movement: answered as recorded and NOT written again, so it can never
        // count twice once head office places the old chain (a different movement that merely shares the id is recorded).
        if (storeId !== undefined && deps.legacyTill !== undefined) {
          const legacy = await deps.legacyTill(ctx.tenantId, tillId);
          const old = legacy.placement === undefined ? legacy.movements.find((m) => m.movementId === movementId) : undefined;
          if (old !== undefined && sameMovement(old, kind, amountMinor as number, custodianId)) {
            return { status: 200, body: { movementId, tillId, storeId, recorded: true, alreadyRecorded: true, onUnplacedLegacyChain: true, flags: old.flags ?? [] } };
          }
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
          movementId, tillId, ...(storeId === undefined ? {} : { storeId }), kind: kind as CashMovementKind, deltaMinor,
          currency: typeof b['currency'] === 'string' ? (b['currency'] as string) : 'INR',
          custodianId, tradingDay, at, performedBy, relayed: true,
          ...(laneId === undefined ? {} : { laneId }),
          ...(flags.length === 0 ? {} : { flags: flags as CashGovernanceFlag[] }),
        });
        return { status: 202, body: { movementId, tillId, storeId: storeId ?? null, recorded: true, flags } };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/tills/:tillId/cash',
      permission: 'cash.till.read',
      handler: async (ctx) => {
        const tillId = ctx.params['tillId'] ?? '';
        // OB-80: which store's till — `?storeId=`, else where it is registered, else the reader's one store.
        const storeId = await tillStoreOf(deps, ctx, tillId, ctx.query['storeId']);
        const movements = await deps.tillMovements(ctx.tenantId, tillId, storeId);
        // OB-82 · P-08: where the till's old records (kept by its id alone) stand — placed here (counted above), placed at
        // another store (not this store's), or NOT YET PLACED: then they are shown here, by amount, for head office to place —
        // never silently ₹0, never folded in.
        const legacy = storeId === undefined || deps.legacyTill === undefined ? undefined : await deps.legacyTill(ctx.tenantId, tillId);
        const legacyBody = legacy === undefined || (legacy.placement === undefined && legacy.movements.length === 0) ? {}
          : legacy.placement !== undefined
            ? { legacyPlacement: { storeId: legacy.placement.storeId, placedBy: legacy.placement.placedBy, how: legacy.placement.how, at: legacy.placement.at, countedHere: legacy.placement.storeId === storeId } }
            : {
              unplacedLegacy: {
                movements: legacy.movements.length, balanceMinor: tillDrawerBalanceMinor(legacy.movements, tillId), custodian: custodianOf(legacy.movements, tillId),
                nextSafeAction: `Till ${tillId} has cash kept before OB-80 by its id alone, and head office has not yet placed it at a store. A head-office person places it once (POST /v1/tills/${tillId}/legacy-placement); until then it is counted at no store.`,
              },
            };
        return {
          status: 200,
          body: {
            tillId, storeId: storeId ?? null, custodian: custodianOf(movements, tillId), balanceMinor: tillDrawerBalanceMinor(movements, tillId), ...legacyBody,
            // Relayed movements the cloud flagged when it re-verified them (SP-4c) — for the cash office to look at (P-08).
            flagged: movements.filter((m) => (m.flags?.length ?? 0) > 0).map((m) => ({ movementId: m.movementId, kind: m.kind, custodianId: m.custodianId, laneId: m.laneId ?? null, flags: m.flags })),
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // OB-82 "A" (owner, 12 Oct 2026, "Fix it once, for good"): a NAMED head-office person records, once and for ever, which
      // store a till's records kept by its id alone (before OB-80) belong to. Append-only, one per till: the first placement
      // stands — the same store again is answered as already placed; another store is refused by name (409), never moved.
      // Only a company-wide person (head office / the cash office) may place; the store must be one head office knows.
      api: 'API-05', method: 'POST', path: '/v1/tills/:tillId/legacy-placement',
      permission: 'till.overshort.review', idempotent: true,
      handler: async (ctx) => {
        const tillId = (ctx.params['tillId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const storeId = typeof b['storeId'] === 'string' ? b['storeId'] : '';
        const reason = typeof b['reason'] === 'string' ? b['reason'].trim() : '';
        if (tillId === '' || storeId.trim() === '' || reason === '') {
          throw apiError(400, {
            code: 'not_readable_as_a_legacy_placement',
            whatHappened: 'Placing a till\'s old records needs the till in the path and { storeId, reason }.',
            wasItSaved: 'not_saved', nextSafeAction: 'Name the store the till\'s old cash belongs to, and why. Nothing was recorded.',
          });
        }
        assertRecordBranchInScope(ctx, null); // company-wide only: a decision about which store owns history
        if (deps.placeLegacyTill === undefined || deps.legacyTill === undefined) {
          throw apiError(503, { code: 'legacy_placement_unavailable', whatHappened: 'This deployment keeps no till records by the till\'s id alone.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing to place. Nothing was recorded.' });
        }
        const known = deps.knownStores === undefined ? [] : [...await deps.knownStores(ctx.tenantId)];
        if (!known.includes(storeId)) {
          throw apiError(422, {
            code: 'store_not_known',
            whatHappened: `Head office knows no store "${storeId}" (it knows ${known.join(', ') || 'none'}).`,
            wasItSaved: 'not_saved', nextSafeAction: 'Name a store head office knows. Nothing was recorded.',
          });
        }
        const legacy = await deps.legacyTill(ctx.tenantId, tillId);
        const at = deps.now();
        const { placement, recorded } = await deps.placeLegacyTill(ctx.tenantId, {
          tillId, storeId, placedBy: ctx.userId, how: 'head_office', reason, at, storesKnown: known,
        });
        if (placement.storeId !== storeId) {
          throw apiError(409, {
            code: 'legacy_till_already_placed',
            whatHappened: `Till ${tillId}'s old records were placed at ${placement.storeId} by ${placement.placedBy} at ${placement.at} (${placement.how}). That placement stands for ever; it is never re-decided.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'If the old cash really belongs elsewhere, a person corrects it with a compensating cash movement at each store. Nothing was recorded.',
          });
        }
        if (recorded) {
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'till.legacy.place', objectType: 'till', objectId: tillId, at,
            origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
            after: { storeId, reason, storesKnown: known.join(','), oldMovements: String(legacy.movements.length) },
            reason, correlationId: tillId,
          });
        }
        return {
          status: recorded ? 201 : 200,
          body: { tillId, storeId, placedBy: placement.placedBy, how: placement.how, at: placement.at, ...(recorded ? {} : { alreadyPlaced: true }), oldMovements: legacy.movements.length, balanceMinor: tillDrawerBalanceMinor(legacy.movements, tillId) },
        };
      },
    },
  ];
}
