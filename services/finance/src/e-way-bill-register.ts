// API-09 GST e-way bill — the DURABLE lifecycle store (A23, item 2), on the tested `packages/e-way-bill`
// engine. Like the e-invoice register, the API is the store of record for each movement's e-way-bill state;
// a credentialed portal connector (the deployment step) reads submitted movements, calls the portal, and
// posts the answer back. This makes an e-way bill durable — its state, its number, when it was generated —
// so it survives a restart, and "current" is a fold of the stored facts (hard rule #2).
//
//   • `POST …/movements/:movementId/submit`          — record the intent + the canonical Part-A request
//                                                       (idempotent per movement; refuses not-required and a
//                                                       malformed request before anything is stored).
//   • `POST …/movements/:movementId/record-response`  — apply the portal's answer; a `generated` EWB is FINAL
//                                                       (a later answer cannot change its number), `unknown`
//                                                       stays retryable, a re-posted answer collapses.
//   • `POST …/movements/:movementId/cancel`           — cancel a generated EWB within 24h (Rule 138(9)).
//   • `GET  …/movements/:movementId`                  — the current folded state.
//
// The e-way bill is the transport twin of the e-invoice; this register deliberately mirrors that one.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  assessEwayBillRequirement, buildEwayBillRequest, applyEwbResult, assessEwbCancellation,
  type SupplyRoute, type EwayBillRequest, type EwbResult, type EwbRecord, type EwbAggregate,
} from '../../../packages/e-way-bill/src/index';

const ROUTES: readonly SupplyRoute[] = ['intra_state', 'inter_state'];
const STATUSES = ['generated', 'duplicate', 'rejected', 'unknown'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export interface EwayBillRegisterDeps {
  readonly load: (tenantId: string, movementId: string) => Promise<EwbAggregate | undefined> | EwbAggregate | undefined;
  readonly recordSubmit: (tenantId: string, movementId: string, request: EwayBillRequest, at: string) => Promise<void> | void;
  readonly recordResponse: (tenantId: string, movementId: string, record: EwbRecord, at: string) => Promise<void> | void;
  readonly recordCancel: (tenantId: string, movementId: string, reason: string, at: string) => Promise<void> | void;
  /** The movement ids that have entered the lifecycle — the reconciliation queue folds each one. */
  readonly listMovementIds: (tenantId: string) => Promise<readonly string[]> | readonly string[];
  readonly now: () => string;
}

export function eWayBillRegisterRoutes(deps: EwayBillRegisterDeps): readonly Route[] {
  return [
    {
      // Record the intent to generate an e-way bill for a movement, with the canonical Part-A request.
      // Idempotent per movement. Body: { request: {…the Part-A fields…} }.
      api: 'API-09', method: 'POST', path: '/v1/finance/e-way-bill/movements/:movementId/submit',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const movementId = ctx.params['movementId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const r = b['request'];
        if (!isObj(r) || !Number.isInteger(r['consignmentValueMinor']) || !ROUTES.includes(r['supplyRoute'] as SupplyRoute)) {
          throw apiError(400, { code: 'ewb_submit_needs_request', whatHappened: 'Submitting an e-way bill needs a request carrying at least consignmentValueMinor and supplyRoute (intra_state/inter_state).', wasItSaved: 'not_saved', nextSafeAction: 'Send the Part-A request fields (GSTINs, document, HSN, pincodes, value, route).' });
        }
        const eligibility = assessEwayBillRequirement({
          consignmentValueMinor: r['consignmentValueMinor'] as number,
          supplyRoute: r['supplyRoute'] as SupplyRoute,
          ...(typeof r['exemptGoods'] === 'boolean' ? { exemptGoods: r['exemptGoods'] } : {}),
        });
        if (!eligibility.required) {
          return { status: 200, body: { movementId, required: false, reason: eligibility.reason, detail: eligibility.detail } };
        }
        const existing = await deps.load(ctx.tenantId, movementId);
        if (existing !== undefined) {
          return { status: 200, body: { movementId, alreadyInLifecycle: true, state: existing.state, detail: existing.detail } };
        }
        const build = buildEwayBillRequest({ request: r as unknown as Omit<EwayBillRequest, 'financialYear'>, eligibility });
        if (!build.built || build.request === undefined) {
          throw apiError(422, { code: 'ewb_invalid_request', whatHappened: build.detail, wasItSaved: 'not_saved', nextSafeAction: 'Fix the named fields and submit again — a malformed request must not be sent to the portal.' });
        }
        await deps.recordSubmit(ctx.tenantId, movementId, build.request, deps.now());
        return { status: 201, body: { movementId, state: 'pending_unknown', idempotencyKey: build.idempotencyKey } };
      },
    },
    {
      // The portal connector posts the portal's answer back here. Generated is final; unknown stays retryable.
      api: 'API-09', method: 'POST', path: '/v1/finance/e-way-bill/movements/:movementId/record-response',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const movementId = ctx.params['movementId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const result = b['result'];
        if (!isObj(result) || !STATUSES.includes(result['status'] as typeof STATUSES[number]) || (result['status'] === 'rejected' && !Array.isArray(result['errors']))) {
          throw apiError(400, { code: 'ewb_record_needs_result', whatHappened: 'Recording a response needs result.status (generated/duplicate/rejected/unknown; a rejected result needs errors[]).', wasItSaved: 'not_saved', nextSafeAction: 'Send the portal’s raw response under "result".' });
        }
        const existing = await deps.load(ctx.tenantId, movementId);
        if (existing === undefined) throw notFound(`a submitted e-way bill for ${movementId}`);
        if (existing.state === 'generated' || existing.state === 'cancelled') {
          return { status: 200, body: existing }; // final — a re-posted answer does not change a generated EWB
        }
        const record = applyEwbResult({ movementId, result: result as unknown as EwbResult });
        const at = typeof b['at'] === 'string' ? (b['at'] as string) : deps.now();
        await deps.recordResponse(ctx.tenantId, movementId, record, at);
        return { status: 200, body: (await deps.load(ctx.tenantId, movementId)) ?? record };
      },
    },
    {
      // Cancel a generated e-way bill within the 24-hour window (Rule 138(9)), unless verified in transit.
      api: 'API-09', method: 'POST', path: '/v1/finance/e-way-bill/movements/:movementId/cancel',
      permission: 'finance.einvoice.generate', idempotent: true,
      handler: async (ctx) => {
        const movementId = ctx.params['movementId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['reason'] !== 'string' || b['reason'].trim() === '') {
          throw apiError(400, { code: 'ewb_cancel_needs_reason', whatHappened: 'Cancelling an e-way bill needs a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Send a reason for the cancellation.' });
        }
        const existing = await deps.load(ctx.tenantId, movementId);
        if (existing === undefined) throw notFound(`an e-way bill for ${movementId}`);
        if (existing.state === 'cancelled') return { status: 200, body: existing }; // idempotent
        if (existing.state !== 'generated' || existing.generatedAt === undefined) {
          throw apiError(422, { code: 'ewb_not_generated', whatHappened: `only a generated e-way bill can be cancelled — this movement is ${existing.state}`, wasItSaved: 'not_saved', nextSafeAction: 'There is no e-way-bill number to cancel.' });
        }
        const at = deps.now();
        const check = assessEwbCancellation({ generatedAt: existing.generatedAt, at, ...(typeof b['verifiedInTransit'] === 'boolean' ? { verifiedInTransit: b['verifiedInTransit'] } : {}) });
        if (!check.cancellable) {
          throw apiError(422, { code: 'ewb_cancel_window_closed', whatHappened: check.reason, wasItSaved: 'not_saved', nextSafeAction: 'The e-way bill can no longer be cancelled — a fresh movement needs a fresh bill.' });
        }
        await deps.recordCancel(ctx.tenantId, movementId, b['reason'], at);
        return { status: 200, body: { movementId, state: 'cancelled', detail: `cancelled: ${b['reason']}` } };
      },
    },
    {
      // The current folded e-way-bill state for a movement.
      api: 'API-09', method: 'GET', path: '/v1/finance/e-way-bill/movements/:movementId',
      permission: 'finance.einvoice.read',
      handler: async (ctx) => {
        const movementId = ctx.params['movementId'] ?? '';
        const agg = await deps.load(ctx.tenantId, movementId);
        if (agg === undefined) throw notFound(`an e-way bill for ${movementId}`);
        return { status: 200, body: agg };
      },
    },
  ];
}
