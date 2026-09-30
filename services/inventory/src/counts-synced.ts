// API-04 Blind count RELAYED from a store device (M09-FR-04 · §28 · §31 — SP-2b, audit finding F11 count half; W2's path).
//
// The counter enters a BLIND count on a device — the manager's screen first, the warehouse handheld in W2. The device
// keeps it durably, hands it to the box, the box relays it HERE under the store's sync credential. Until SP-2b the
// manager's count was reconciled ON THE SCREEN against an in-memory ledger that was empty after a reload, so every count
// after a reload invented a variance (F11). Now the device captures only what the counter saw, and this route owns
// every judgement the device must not make:
//
//   • the EXPECTED quantity is computed here (M08 on-hand + prior count corrections) — never sent, never shown first;
//   • the unit VALUE is the cloud's own weighted-average cost — never the body (F07);
//   • the approval THRESHOLD is the tenant's count policy — never the body (F07); unset → the default, said as a flag;
//   • a MATERIAL variance with no approver is RECORDED as awaiting approval: valued, visible on the counts review
//     screen, the correction NOT applied until a separate person approves (§28). Nothing is refused into the void and
//     nothing is applied silently (hard rule #10). An immaterial variance is corrected at once, as the direct route does;
//   • the counter's own authority is re-verified from their grants (flag, never silent).
// Idempotent per countId: the same count again is 200; a re-count is a NEW count id.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { reconcileCount, InvalidCountError, type CountReconciliation } from '../../../packages/counts/src/counts';
import { Ledger, InMemoryLedgerStore } from '../../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../../packages/sync/src/outbox';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { priorCorrections, type CountsDeps, type StoredReconciliation } from './counts';

/** The count-approval threshold applied when the tenant has set none — and the record says so (`default_threshold`). */
export const DEFAULT_COUNT_APPROVAL_THRESHOLD_MINOR = 100_000;

export const COUNT_FLAGS = Object.freeze([
  'counter_unknown', 'counter_lacks_authority', 'value_unknown', 'default_threshold',
] as const);
export type CountFlag = (typeof COUNT_FLAGS)[number];

export interface CountPolicy {
  /** Variance value at/above which a separate person must approve the correction (§28), in minor units. */
  readonly approvalThresholdMinor: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface SyncedCountsDeps extends CountsDeps {
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** The cloud's own unit value for the product (weighted-average cost); `undefined` when never costed. */
  readonly unitValueMinor: (tenantId: string, productId: string) => Promise<number | undefined> | number | undefined;
  /** The tenant's count policy, or `undefined` when never set. */
  readonly countPolicy: (tenantId: string) => Promise<CountPolicy | undefined> | CountPolicy | undefined;
  readonly recordCountPolicy: (tenantId: string, policy: CountPolicy) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
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
}

function readRelayedCount(body: unknown): RelayedCount | undefined {
  if (!isObj(body)) return undefined;
  if (!isStr(body['countId']) || !isStr(body['productId']) || !isStr(body['locationId']) || !isStr(body['uom'])
    || !isNonNegInt(body['countedMinor']) || !isStr(body['reasonCode']) || !isStr(body['counterId']) || !isIso(body['at'])) return undefined;
  return {
    countId: body['countId'], productId: body['productId'], locationId: body['locationId'], uom: body['uom'],
    countedMinor: body['countedMinor'], reasonCode: body['reasonCode'], counterId: body['counterId'], at: body['at'],
    storeId: isStr(body['storeId']) ? body['storeId'] : null,
    source: isStr(body['source']) ? body['source'] : 'unknown',
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
        // A count id is used once; the same count again is a retry after a lost reply (§31.1) — one record.
        if (await deps.countExists(ctx.tenantId, countId)) {
          const prior = (await deps.reconciliations(ctx.tenantId, c.productId, c.locationId)).find((r) => r.countId === countId);
          return { status: 200, body: { countId, recorded: true, alreadyRecorded: true, ...(prior === undefined ? {} : { pendingApproval: prior.pendingApproval ?? false, adjusted: prior.adjusted, flags: prior.governanceFlags ?? [] }) } };
        }

        const flags: CountFlag[] = [];
        const permissions = await deps.permissionsOfUser(ctx.tenantId, c.counterId);
        if (permissions === undefined) flags.push('counter_unknown');
        else if (!permissions.includes('inventory.movement.append')) flags.push('counter_lacks_authority');

        // The EXPECTED position — computed here, from the authoritative ledger plus prior corrections. Blind by
        // construction: the device never sent it and never sees it.
        const priorRecs = await deps.reconciliations(ctx.tenantId, c.productId, c.locationId);
        const expected = (await deps.onHand(ctx.tenantId, c.productId, c.locationId)) + priorCorrections(priorRecs);

        // The VALUE and the THRESHOLD — the cloud's, never the body's (F07). Unknown is said, never silently zero:
        // an unvalued variance cannot be judged immaterial, so it waits for a person like a material one would.
        const unitValue = await deps.unitValueMinor(ctx.tenantId, c.productId);
        if (unitValue === undefined) flags.push('value_unknown');
        const policy = await deps.countPolicy(ctx.tenantId);
        if (policy === undefined) flags.push('default_threshold');
        const thresholdMinor = policy?.approvalThresholdMinor ?? DEFAULT_COUNT_APPROVAL_THRESHOLD_MINOR;

        const varianceMinor = c.countedMinor - expected;
        const valueMinor = Math.abs(varianceMinor) * (unitValue ?? 0);
        const material = varianceMinor !== 0 && (unitValue === undefined || valueMinor >= thresholdMinor);
        const at = deps.now();

        let rec: StoredReconciliation;
        if (material) {
          // Recorded, valued, visible — and NOT applied. The correction waits for a separate person (§28); the review
          // screen lists it first. This is the relayed fact recorded honestly, never a refusal into the void (#10).
          rec = {
            countId, productId: c.productId, locationId: c.locationId,
            expectedMinor: expected, countedMinor: c.countedMinor, varianceMinor,
            valueMinor, currency: 'INR', reasonCode: c.reasonCode,
            reconciled: false, adjusted: false, requiredApproval: true,
            counterId: c.counterId, approvedBy: null, at,
            pendingApproval: true, governanceFlags: flags, relayedBy: ctx.userId, source: c.source, storeId: c.storeId,
          };
        } else {
          // Immaterial (or no variance): the same tested engine as the direct route, over a ledger hydrated with the
          // expected position, corrects at once. Threshold above the value by construction, so it never throws for
          // approval; a malformed count is 400.
          const store = new InMemoryLedgerStore();
          const ledger = new Ledger(store);
          ledger.append(makeEvent({
            id: `count-open-${countId}`, type: 'CountOpeningPosition', occurredAt: at,
            idempotencyKey: `count-open-${ctx.tenantId}-${countId}`, source: 'api/inventory',
            payload: { productId: c.productId, deltaMinor: expected },
          }));
          let result: CountReconciliation;
          try {
            result = reconcileCount({
              id: countId, productId: c.productId, locationId: c.locationId, uom: c.uom,
              countedMinor: c.countedMinor, counterId: c.counterId, at, reasonCode: c.reasonCode,
              valuePerUnit: { minor: unitValue ?? 0, currency: 'INR' }, thresholdMinor: valueMinor + 1,
            }, ledger, new SyncOutbox());
          } catch (e) {
            if (e instanceof InvalidCountError) {
              throw apiError(400, { code: 'invalid_count', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the count on the device and count again. Nothing was recorded.' });
            }
            throw e;
          }
          rec = {
            countId, productId: c.productId, locationId: c.locationId,
            expectedMinor: result.expectedMinor, countedMinor: c.countedMinor, varianceMinor: result.varianceMinor,
            valueMinor: result.varianceValue.minor, currency: 'INR', reasonCode: c.reasonCode,
            reconciled: result.reconciled, adjusted: result.adjusted, requiredApproval: false,
            counterId: c.counterId, approvedBy: null, at,
            pendingApproval: false, governanceFlags: flags, relayedBy: ctx.userId, source: c.source, storeId: c.storeId,
          };
        }
        await deps.recordReconciliation(ctx.tenantId, rec);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: c.counterId, action: 'count.record', objectType: 'stock_count', objectId: countId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            productId: c.productId, locationId: c.locationId, countedMinor: String(c.countedMinor), varianceMinor: String(rec.varianceMinor),
            valueMinor: String(rec.valueMinor), adjusted: String(rec.adjusted), pendingApproval: String(rec.pendingApproval ?? false),
            relayedBy: ctx.userId, source: c.source, storeId: c.storeId ?? '', flags: flags.join(','),
          },
          reason: c.reasonCode, correlationId: countId,
        });
        // 202: the count happened at the store; this records it and what head office made of it. The expected figure
        // travels back only to the BOX (the device sees posted / refused) — the counter still never sees it first.
        return {
          status: 202,
          body: { countId, recorded: true, expectedMinor: rec.expectedMinor, countedMinor: rec.countedMinor, varianceMinor: rec.varianceMinor, valueMinor: rec.valueMinor, adjusted: rec.adjusted, pendingApproval: rec.pendingApproval ?? false, flags },
        };
      },
    },
    {
      // The owner sets the count-approval threshold — the policy the cloud reconciles every relayed count against.
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
