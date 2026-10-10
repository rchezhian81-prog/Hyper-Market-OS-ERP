// API-04 Blind count RELAYED from a store device (M09-FR-04 · §28 · §31 — SP-2b, audit finding F11 count half; W2's path).
//
// The counter enters a BLIND count on a device — the manager's screen, or the warehouse handheld at a bin (SP-3b). The
// device keeps it durably, hands it to the box, the box relays it HERE under the store's sync credential. Until SP-2b
// the manager's count was reconciled ON THE SCREEN against an in-memory ledger that was empty after a reload, so every
// count after a reload invented a variance (F11). Now the device captures only what the counter saw, and head office
// owns every judgement the device must not make — through the SAME `reconcileBlindCount` the direct route uses (SP-4):
//
//   • the EXPECTED quantity is computed here (M08 on-hand, or the bin's contents, + prior corrections) — never sent;
//   • the unit VALUE is the cloud's own weighted-average cost — never the body (F07);
//   • the approval THRESHOLD is the tenant's count policy — never the body (F07); unset → the default, said as a flag;
//   • a MATERIAL variance with no approver is RECORDED as awaiting approval: valued, visible on the counts review
//     screen, the correction NOT applied until a separate person approves (§28) — by the decide route or the manager's
//     relayed decision. Nothing is refused into the void and nothing is applied silently (hard rule #10);
//   • the counter's own authority is re-verified from their grants (flag, never silent).
// Idempotent per countId: the same count again is 200; a re-count is a NEW count id.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { assertLocationInScope } from './location-scope';
import { InvalidCountError } from '../../../packages/counts/src/counts';
import {
  reconcileBlindCount, DEFAULT_COUNT_APPROVAL_THRESHOLD_MINOR, COUNT_FLAGS,
  type CountFlag, type CountPolicy, type CountsDeps, type StoredReconciliation,
} from './counts';

// The vocabulary lives with the shared reconcile now (SP-4); re-exported so nothing that imported it here breaks.
export { DEFAULT_COUNT_APPROVAL_THRESHOLD_MINOR, COUNT_FLAGS, type CountFlag, type CountPolicy };

export interface SyncedCountsDeps extends CountsDeps {
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly recordCountPolicy: (tenantId: string, policy: CountPolicy) => Promise<void> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

/** The count as the device queued it (`StockCounted`). */
interface RelayedCount {
  readonly countId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly uom: string;
  readonly countedMinor: number;
  readonly reasonCode: string;
  readonly counterId: string;
  readonly at: string;
  readonly storeId: string | null;
  readonly source: string;
  /** The bin counted (a warehouse handheld's count, SP-3b) — null for a store-level count. */
  readonly binId: string | null;
}

function readRelayedCount(body: unknown): RelayedCount | undefined {
  if (!isObj(body)) return undefined;
  if (!isStr(body['countId']) || !isStr(body['productId']) || !isStr(body['locationId']) || !isStr(body['uom'])
    || !isNonNegInt(body['countedMinor']) || !isStr(body['reasonCode']) || !isStr(body['counterId']) || !isIso(body['at'])) return undefined;
  if (body['binId'] !== undefined && body['binId'] !== null && !isStr(body['binId'])) return undefined;
  return {
    countId: body['countId'], productId: body['productId'], locationId: body['locationId'], uom: body['uom'],
    countedMinor: body['countedMinor'], reasonCode: body['reasonCode'], counterId: body['counterId'], at: body['at'],
    storeId: isStr(body['storeId']) ? body['storeId'] : null,
    source: isStr(body['source']) ? body['source'] : 'unknown',
    binId: isStr(body['binId']) ? body['binId'] : null,
  };
}

export function syncedCountsRoutes(deps: SyncedCountsDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/counts/:countId/synced',
      permission: 'inventory.count.sync', idempotent: true,
      handler: async (ctx) => {
        const countId = (ctx.params['countId'] ?? '').trim();
        const c = readRelayedCount(ctx.body);
        if (countId === '' || c === undefined || c.countId !== countId) {
          throw apiError(400, {
            code: 'not_readable_as_a_relayed_count',
            whatHappened: 'This payload could not be read as a blind count from the store — it needs the countId matching the path, productId, locationId, uom, a whole countedMinor, a reasonCode, the counterId and when it was counted.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it. The expected quantity is computed here, never sent.',
          });
        }
        // PA-01-r1: the box relays its own store's counts only — a location outside the relayer's branches is refused.
        await assertLocationInScope(ctx, c.locationId, deps.locationBranches);
        // A count id is used once; the same count again is a retry after a lost reply (§31.1) — one record.
        if (await deps.countExists(ctx.tenantId, countId)) {
          const prior = await deps.reconciliation(ctx.tenantId, countId);
          return { status: 200, body: { countId, recorded: true, alreadyRecorded: true, binId: prior?.binId ?? c.binId, ...(prior === undefined ? {} : { pendingApproval: prior.pendingApproval ?? false, adjusted: prior.adjusted, flags: prior.governanceFlags ?? [] }) } };
        }

        // The COUNTER's authority — re-verified from their grants (flag, never silent).
        const counterFlags: CountFlag[] = [];
        const permissions = await deps.permissionsOfUser(ctx.tenantId, c.counterId);
        if (permissions === undefined) counterFlags.push('counter_unknown');
        else if (!permissions.includes('inventory.movement.append')) counterFlags.push('counter_lacks_authority');

        let rec: StoredReconciliation;
        try {
          rec = await reconcileBlindCount(deps, ctx.tenantId, {
            countId, productId: c.productId, locationId: c.locationId, binId: c.binId, uom: c.uom,
            countedMinor: c.countedMinor, reasonCode: c.reasonCode, counterId: c.counterId, counterFlags,
            relayed: { relayedBy: ctx.userId, source: c.source, storeId: c.storeId },
          });
        } catch (e) {
          if (e instanceof InvalidCountError) {
            throw apiError(400, { code: 'invalid_count', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the count on the device and count again. Nothing was recorded.' });
          }
          throw e;
        }
        const flags = rec.governanceFlags ?? [];
        await deps.recordReconciliation(ctx.tenantId, rec);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: c.counterId, action: 'count.record', objectType: 'stock_count', objectId: countId,
          at: rec.at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            productId: c.productId, locationId: c.locationId, binId: c.binId ?? '', countedMinor: String(c.countedMinor), varianceMinor: String(rec.varianceMinor),
            valueMinor: String(rec.valueMinor), adjusted: String(rec.adjusted), pendingApproval: String(rec.pendingApproval ?? false),
            relayedBy: ctx.userId, source: c.source, storeId: c.storeId ?? '', flags: flags.join(','),
          },
          reason: c.reasonCode, correlationId: countId,
        });
        // 202: the count happened at the store; this records it and what head office made of it. The expected figure
        // travels back only to the BOX (the device sees posted / refused) — the counter still never sees it first.
        return {
          status: 202,
          body: { countId, recorded: true, binId: c.binId, expectedMinor: rec.expectedMinor, countedMinor: rec.countedMinor, varianceMinor: rec.varianceMinor, valueMinor: rec.valueMinor, adjusted: rec.adjusted, pendingApproval: rec.pendingApproval ?? false, movementId: rec.movementId ?? null, flags },
        };
      },
    },
    {
      // The owner sets the count-approval threshold — the policy the cloud reconciles every count against.
      api: 'API-04', method: 'POST', path: '/v1/inventory/count-policy',
      permission: 'inventory.count.policy.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isNonNegInt(b['approvalThresholdMinor'])) {
          throw apiError(400, { code: 'not_readable_as_a_count_policy', whatHappened: 'A count policy needs a whole approvalThresholdMinor (the variance value at or above which a second person must approve).', wasItSaved: 'not_saved', nextSafeAction: 'Send { approvalThresholdMinor }. Nothing was changed.' });
        }
        const policy: CountPolicy = { approvalThresholdMinor: b['approvalThresholdMinor'], setBy: ctx.userId, setAt: deps.now() };
        await deps.recordCountPolicy(ctx.tenantId, policy);
        return { status: 201, body: { policy } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/count-policy',
      permission: 'inventory.count.policy.read',
      handler: async (ctx) => {
        const policy = await deps.countPolicy(ctx.tenantId);
        return { status: 200, body: { policy: policy ?? null, defaultApprovalThresholdMinor: DEFAULT_COUNT_APPROVAL_THRESHOLD_MINOR, inForceMinor: policy?.approvalThresholdMinor ?? DEFAULT_COUNT_APPROVAL_THRESHOLD_MINOR } };
      },
    },
  ];
}
