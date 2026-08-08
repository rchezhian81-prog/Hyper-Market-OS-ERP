// API-04 cycle / blind physical count reconciliation (M09-FR-04). The counter enters a BLIND physical
// count — they never see the system-expected quantity; this surface derives the expected on-hand
// SERVER-SIDE (the authoritative M08 position plus any prior count corrections), computes and VALUES the
// variance, and — when there is one — commits a reason-coded COMPENSATING adjustment through the real
// engine, with a SEPARATE approver required when the value is material (§28: the counter can never
// approve their own variance). Blind-count integrity is structural: the expected figure is computed here
// and is never an input. Append-only (hard rule #2); idempotent on the count id.
//
// The rules are the pure `reconcileCount` (→ `commitAdjustment`) engines in `packages/counts` /
// `packages/adjustment`, run over an in-memory `Ledger` hydrated with the expected position. Because the
// M08 movement model (a kind + a positive quantity) cannot express a signed count correction, this
// module keeps its OWN append-only count-correction ledger LAYERED on M08 — expected = M08 on-hand + the
// sum of prior count corrections — so repeated counts converge even as real movements happen between them.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { reconcileCount, InvalidCountError, type CountReconciliation } from '../../../packages/counts/src/counts';
import { ApprovalRequiredError, MissingReasonError } from '../../../packages/adjustment/src/adjustment';
import { Ledger, InMemoryLedgerStore } from '../../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../../packages/sync/src/outbox';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';
import { isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';

export interface StoredReconciliation {
  readonly countId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly expectedMinor: number;
  readonly countedMinor: number;
  readonly varianceMinor: number;
  readonly valueMinor: number;
  readonly currency: CurrencyCode;
  readonly reasonCode: string;
  readonly reconciled: boolean;
  readonly adjusted: boolean;
  readonly requiredApproval: boolean;
  readonly counterId: string;
  readonly approvedBy: string | null;
  readonly at: string;
}

export interface CountsDeps {
  /** Authoritative M08 on-hand for (product, location) — the base the count is reconciled against. */
  readonly onHand: (tenantId: string, productId: string, locationId: string) => Promise<number> | number;
  /** Prior count reconciliations for (product, location) — their corrections layer on M08. */
  readonly reconciliations: (tenantId: string, productId: string, locationId: string) => Promise<readonly StoredReconciliation[]> | readonly StoredReconciliation[];
  /** Whether a count id has already been reconciled (idempotency — a count id is used once). */
  readonly countExists: (tenantId: string, countId: string) => Promise<boolean> | boolean;
  readonly recordReconciliation: (tenantId: string, rec: StoredReconciliation) => Promise<void> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** The count corrections applied so far for this key — the layer on top of the M08 base position. */
const priorCorrections = (recs: readonly StoredReconciliation[]): number =>
  recs.filter((r) => r.adjusted).reduce((s, r) => s + r.varianceMinor, 0);

export function countsRoutes(deps: CountsDeps): readonly Route[] {
  return [
    {
      // Reconcile a blind count. The expected quantity is computed here, never supplied. A variance
      // commits a reason-coded compensating adjustment; a material one needs a separate approver (§28).
      api: 'API-04', method: 'POST', path: '/v1/inventory/counts/:countId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const countId = ctx.params['countId'] ?? '';
        const b = (ctx.body ?? {}) as { productId?: unknown; locationId?: unknown; uom?: unknown; countedMinor?: unknown; reasonCode?: unknown; valuePerUnitMinor?: unknown; currency?: unknown; thresholdMinor?: unknown; approvedBy?: unknown };
        if (!isStr(b.productId) || !isStr(b.locationId) || !isStr(b.uom) || !isNonNegInt(b.countedMinor) || !isStr(b.reasonCode)
          || !isNonNegInt(b.valuePerUnitMinor) || !isNonNegInt(b.thresholdMinor)
          || (b.currency !== undefined && !isCurrencyCode(b.currency as string))
          || (b.approvedBy !== undefined && !isStr(b.approvedBy))) {
          throw apiError(400, {
            code: 'not_readable_as_a_count',
            whatHappened: 'A count needs a productId, locationId, uom, whole countedMinor, a reasonCode, a whole valuePerUnitMinor and thresholdMinor.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the blind count. Nothing was recorded. The expected quantity is computed by the system, never sent.',
          });
        }
        if (await deps.countExists(ctx.tenantId, countId)) {
          throw apiError(409, {
            code: 'count_already_reconciled',
            whatHappened: `Count ${countId} has already been reconciled — a count id is used once; a re-count is a new count.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use a new count id. Nothing was changed.',
          });
        }

        const currency = (b.currency as CurrencyCode) ?? 'INR';
        const at = deps.now();
        const priorRecs = await deps.reconciliations(ctx.tenantId, b.productId, b.locationId);
        const expected = (await deps.onHand(ctx.tenantId, b.productId, b.locationId)) + priorCorrections(priorRecs);

        // Hydrate a ledger with the expected position so the engine projects it as on-hand (blind).
        const store = new InMemoryLedgerStore();
        const ledger = new Ledger(store);
        ledger.append(makeEvent({
          id: `count-open-${countId}`, type: 'CountOpeningPosition', occurredAt: at,
          idempotencyKey: `count-open-${ctx.tenantId}-${countId}`, source: 'api/inventory',
          payload: { productId: b.productId, deltaMinor: expected },
        }));
        const outbox = new SyncOutbox();

        const approval: DecidedRequest | undefined = isStr(b.approvedBy)
          ? { id: countId, subjectType: 'stock_adjustment', subjectRef: countId, requestedBy: ctx.userId, branchId: ctx.branchId, value: null, status: 'approved', decidedBy: b.approvedBy, reason: b.reasonCode, decidedAt: at }
          : undefined;

        let result: CountReconciliation;
        try {
          result = reconcileCount({
            id: countId, productId: b.productId, locationId: b.locationId, uom: b.uom,
            countedMinor: b.countedMinor, counterId: ctx.userId, at, reasonCode: b.reasonCode,
            valuePerUnit: { minor: b.valuePerUnitMinor, currency }, thresholdMinor: b.thresholdMinor,
            ...(approval === undefined ? {} : { approval }),
          }, ledger, outbox);
        } catch (e) {
          if (e instanceof ApprovalRequiredError) {
            throw apiError(422, { code: 'count_needs_approval', whatHappened: `${e.message} The counter cannot approve their own variance (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'Have a separate person approve the variance with a reason, then re-send. Nothing was recorded.' });
          }
          if (e instanceof InvalidCountError || e instanceof MissingReasonError) {
            throw apiError(400, { code: 'invalid_count', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the count and re-send. Nothing was recorded.' });
          }
          throw e;
        }

        const rec: StoredReconciliation = {
          countId, productId: b.productId, locationId: b.locationId,
          expectedMinor: result.expectedMinor, countedMinor: b.countedMinor, varianceMinor: result.varianceMinor,
          valueMinor: result.varianceValue.minor, currency, reasonCode: b.reasonCode,
          reconciled: result.reconciled, adjusted: result.adjusted, requiredApproval: result.requiredApproval,
          counterId: ctx.userId, approvedBy: isStr(b.approvedBy) ? b.approvedBy : null, at,
        };
        await deps.recordReconciliation(ctx.tenantId, rec);
        return { status: 201, body: { countId, expectedMinor: rec.expectedMinor, countedMinor: rec.countedMinor, varianceMinor: rec.varianceMinor, valueMinor: rec.valueMinor, reconciled: rec.reconciled, adjusted: rec.adjusted, requiredApproval: rec.requiredApproval } };
      },
    },
    {
      // The corrected position and count history for a product at a location — the M08 base plus the
      // count corrections layered on it.
      api: 'API-04', method: 'GET', path: '/v1/inventory/counts',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const productId = ctx.query['productId'];
        const locationId = ctx.query['locationId'];
        if (!isStr(productId) || !isStr(locationId)) {
          throw apiError(400, {
            code: 'not_readable_as_a_count_query',
            whatHappened: 'Reading a count position needs a productId and a locationId.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send ?productId=…&locationId=…. Nothing was changed.',
          });
        }
        const recs = await deps.reconciliations(ctx.tenantId, productId, locationId);
        const systemOnHandMinor = await deps.onHand(ctx.tenantId, productId, locationId);
        const countCorrectionMinor = priorCorrections(recs);
        return {
          status: 200,
          body: { productId, locationId, systemOnHandMinor, countCorrectionMinor, correctedOnHandMinor: systemOnHandMinor + countCorrectionMinor, counts: recs, asAt: deps.now() },
        };
      },
    },
  ];
}
