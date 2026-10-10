// API-04 Adjustment REQUESTS from a store device, approved by a separate person before anything posts
// (M08-FR-03 · §28 · P-05 · hard rules #2/#5/#6/#10 — SP-3b, W3 of the owner's warehouse directive).
//
// A warehouse worker at the racking finds stock that is not what the system says — a damaged pack, a missing case,
// two more than the bin should hold. On the handheld they RAISE an adjustment request with a reason. The request is
// saved on the device, handed to the store box, and relayed HERE under the store's sync credential. Nothing moves stock
// yet: the request is recorded PENDING, valued at the cloud's own cost, and waits for a supervisor who is NOT the
// raiser to approve it. Only then is the compensating movement appended to the M08 ledger — once, keyed on the request.
//
// ── What this trusts, and what it re-verifies ──────────────────────────────
//
// The FACT is trusted: a named worker asked, at the store, for a named correction with a named reason. The AUTHORITY
// is re-verified: whether the raiser holds any grant here (`requester_unknown`) or holds one without the movement
// permission (`requester_lacks_authority`) is a FLAG on the record, never a silent drop (hard rule #10). The value is
// the cloud's weighted-average cost (F07 — never the body); an uncosted product is said (`value_unknown`).
//
// ── The decision ───────────────────────────────────────────────────────────
//
// `decide` is a DIRECT route by an authenticated supervisor (`inventory.adjustment.approve`). The raiser cannot decide
// their own request (§28) — that one is refused outright, because the caller is known and present, unlike a relayed
// fact. One request, one decision: the same decision again is 200; a different one is 409 and nothing changes.
//
// The M08 movement model has a kind and a POSITIVE quantity, never a sign. An upward correction posts as `adjusted`
// and a downward one as `wasted`, each carrying the reason code and both people (entered by the raiser, approved by
// the decider) — the same shape the direct movement route already requires for those kinds (`checkMovement`).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { assertLocationInScope, stockReadScope, type LocationBranches } from './location-scope';
import { isAdjustmentReason, ADJUSTMENT_REASON_CODES } from '../../../packages/adjustment/src/adjustment';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { checkMovement, type Movement } from './index';
import { valueAtUnitCost } from '../../../packages/contracts/src/quantity';

export const ADJUSTMENT_REQUEST_FLAGS = Object.freeze([
  'requester_unknown', 'requester_lacks_authority', 'value_unknown',
] as const);
export type AdjustmentRequestFlag = (typeof ADJUSTMENT_REQUEST_FLAGS)[number];

export const ADJUSTMENT_REQUEST_STATUSES = Object.freeze(['pending', 'posted', 'rejected'] as const);
export type AdjustmentRequestStatus = (typeof ADJUSTMENT_REQUEST_STATUSES)[number];

/** The request as head office keeps it — raised at the store, decided (or not) here. */
export interface AdjustmentRequestRecord {
  readonly requestId: string;
  readonly productId: string;
  readonly locationId: string;
  /** The bin the worker stood at, when the handheld named one; the M08 correction is at the location regardless. */
  readonly binId: string | null;
  /** Signed: positive = found more, negative = missing / damaged. Never zero. */
  readonly deltaMinor: number;
  readonly uom: string;
  readonly reasonCode: string;
  readonly note: string | null;
  /** |delta| × the cloud's unit cost (0 with `value_unknown` when the product was never costed). */
  readonly valueMinor: number;
  readonly currency: 'INR';
  readonly requestedBy: string;
  /** When the worker raised it, on the device. */
  readonly at: string;
  readonly storeId: string | null;
  readonly source: string;
  /** The identity that relayed it (the store box) — the carrier, never the raiser. */
  readonly relayedBy: string;
  readonly recordedAt: string;
  readonly governanceFlags: readonly AdjustmentRequestFlag[];
  readonly status: AdjustmentRequestStatus;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  /** The M08 movement the approval appended — `adj-req:<requestId>` — null until posted. */
  readonly movementId: string | null;
}

export interface AdjustmentRequestDeps {
  /** PA-01-r1: which branch a location belongs to (the org hierarchy); absent → a location is its own branch key. */
  readonly locationBranches?: LocationBranches;
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** The cloud's own unit value for the product (weighted-average cost); `undefined` when never costed. */
  readonly unitValueMinor: (tenantId: string, productId: string) => Promise<number | undefined> | number | undefined;
  /** The request on file (its latest state), if any. */
  readonly request: (tenantId: string, requestId: string) => Promise<AdjustmentRequestRecord | undefined> | AdjustmentRequestRecord | undefined;
  /** Every request on file for the tenant, latest state each, in record order. */
  readonly requests: (tenantId: string) => Promise<readonly AdjustmentRequestRecord[]> | readonly AdjustmentRequestRecord[];
  /** Idempotent on the request id. */
  readonly recordRequest: (tenantId: string, record: AdjustmentRequestRecord) => Promise<void> | void;
  /** Append the decided state (a second event, never an edit — hard rule #2). */
  readonly recordDecision: (tenantId: string, record: AdjustmentRequestRecord) => Promise<void> | void;
  /** The M08 ledger append — idempotent on the movement id. */
  readonly appendMovement: (tenantId: string, m: Movement) => Promise<void> | void;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const isSignedNonZeroInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) !== 0;

/** The request as the device queued it (`AdjustmentRequested`). */
interface RelayedRequest {
  readonly requestId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly binId: string | null;
  readonly deltaMinor: number;
  readonly uom: string;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly requestedBy: string;
  readonly at: string;
  readonly storeId: string | null;
  readonly source: string;
}

function readRelayedRequest(body: unknown): RelayedRequest | undefined {
  if (!isObj(body)) return undefined;
  if (!isStr(body['requestId']) || !isStr(body['productId']) || !isStr(body['locationId']) || !isStr(body['uom'])
    || !isSignedNonZeroInt(body['deltaMinor']) || !isAdjustmentReason(body['reasonCode']) || !isStr(body['requestedBy']) || !isIso(body['at'])) return undefined;
  if (body['binId'] !== undefined && body['binId'] !== null && !isStr(body['binId'])) return undefined;
  if (body['note'] !== undefined && body['note'] !== null && typeof body['note'] !== 'string') return undefined;
  return {
    requestId: body['requestId'], productId: body['productId'], locationId: body['locationId'],
    binId: isStr(body['binId']) ? body['binId'] : null,
    deltaMinor: body['deltaMinor'], uom: body['uom'], reasonCode: body['reasonCode'],
    note: typeof body['note'] === 'string' && body['note'].trim() !== '' ? body['note'].trim() : null,
    requestedBy: body['requestedBy'], at: body['at'],
    storeId: isStr(body['storeId']) ? body['storeId'] : null,
    source: isStr(body['source']) ? body['source'] : 'unknown',
  };
}

/** The M08 movement id an approved request posts under — one per request, so a repeated approval is one movement. */
export const adjustmentMovementId = (requestId: string): string => `adj-req:${requestId}`;

/** What deciding a request came to — for the direct route and for the manager's relayed decision alike (SP-4). */
export type AdjustmentDecisionOutcome =
  | { readonly ok: true; readonly record: AdjustmentRequestRecord; readonly alreadyDecided: boolean }
  | { readonly ok: false; readonly refusedBecause: 'adjustment_request_unknown' | 'self_approval' | 'adjustment_request_already_decided' | `movement_${string}`; readonly detail: string };

/**
 * Decide a pending request (§28): a person who is NOT the raiser approves — ONE compensating M08 movement posts, keyed
 * on the request — or rejects it (nothing posts). One decision per request: the same again is a no-op with
 * `alreadyDecided`, a different one is refused. Appends the decided state; never edits.
 */
export async function decideAdjustmentRequest(deps: AdjustmentRequestDeps, input: {
  readonly tenantId: string; readonly requestId: string; readonly decidedBy: string;
  readonly decision: 'approved' | 'rejected'; readonly reason: string; readonly branchId: string | null;
  /** How the decision arrived — for the audit line. */
  readonly via: 'direct' | 'relayed';
  /** PA-01-r1: refuse (throws, by name) when the request's location is outside the decider's branches. */
  readonly assertInScope?: (locationId: string) => Promise<void>;
}): Promise<AdjustmentDecisionOutcome> {
  const rec = await deps.request(input.tenantId, input.requestId);
  if (rec === undefined) return { ok: false, refusedBecause: 'adjustment_request_unknown', detail: `No adjustment request ${input.requestId} is on file here.` };
  await input.assertInScope?.(rec.locationId);
  if (rec.requestedBy === input.decidedBy) return { ok: false, refusedBecause: 'self_approval', detail: `${input.decidedBy} raised this request and cannot decide it (§28 separation of duties).` };
  if (rec.status !== 'pending') {
    const same = (input.decision === 'approved') === (rec.status === 'posted');
    if (same) return { ok: true, record: rec, alreadyDecided: true };
    return { ok: false, refusedBecause: 'adjustment_request_already_decided', detail: `Request ${input.requestId} was already ${rec.status} by ${rec.decidedBy ?? 'someone'} at ${rec.decidedAt ?? '?'}; a different decision now would be a second truth.` };
  }
  const decidedAt = deps.now();
  let movementId: string | null = null;
  if (input.decision === 'approved') {
    // One compensating M08 movement, by kind: found → adjusted (+), missing/damaged → wasted (−). Both people on it.
    const m: Movement = {
      movementId: adjustmentMovementId(input.requestId), productId: rec.productId, locationId: rec.locationId,
      kind: rec.deltaMinor > 0 ? 'adjusted' : 'wasted', quantityMinor: Math.abs(rec.deltaMinor), uom: rec.uom,
      occurredAt: decidedAt, reason: `${rec.reasonCode}${rec.note === null ? '' : `: ${rec.note}`}`,
      approvedBy: input.decidedBy, enteredBy: rec.requestedBy,
    };
    const check = checkMovement(m);
    if (!check.ok) return { ok: false, refusedBecause: `movement_${check.refusedBecause ?? 'refused'}`, detail: check.detail };
    await deps.appendMovement(input.tenantId, m);
    movementId = m.movementId;
  }
  const decided: AdjustmentRequestRecord = {
    ...rec, status: input.decision === 'approved' ? 'posted' : 'rejected',
    decidedBy: input.decidedBy, decidedAt, decisionReason: input.reason, movementId,
  };
  await deps.recordDecision(input.tenantId, decided);
  await deps.recordAudit?.(input.tenantId, {
    actorId: input.decidedBy, action: input.decision === 'approved' ? 'adjustment.approve' : 'adjustment.reject', objectType: 'stock_adjustment_request', objectId: input.requestId,
    at: decidedAt, origin: { tenantId: input.tenantId, branchId: input.branchId },
    before: { status: 'pending' },
    after: { status: decided.status, requestedBy: rec.requestedBy, deltaMinor: String(rec.deltaMinor), valueMinor: String(rec.valueMinor), movementId: movementId ?? '', via: input.via },
    reason: input.reason, correlationId: input.requestId,
  });
  return { ok: true, record: decided, alreadyDecided: false };
}

export function adjustmentRequestRoutes(deps: AdjustmentRequestDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/adjustment-requests/:requestId/synced',
      permission: 'inventory.adjustment.sync', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const r = readRelayedRequest(ctx.body);
        if (requestId === '' || r === undefined || r.requestId !== requestId) {
          throw apiError(400, {
            code: 'not_readable_as_an_adjustment_request',
            whatHappened: `This payload could not be read as an adjustment request from the store — it needs the requestId matching the path, productId, locationId, uom, a whole non-zero deltaMinor, a reasonCode from ${ADJUSTMENT_REASON_CODES.join(' / ')}, the requestedBy and when it was raised.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        await assertLocationInScope(ctx, r.locationId, deps.locationBranches); // PA-01-r1: the relayer's own store only
        const prior = await deps.request(ctx.tenantId, requestId);
        if (prior !== undefined) {
          // A retry after a lost reply (§31.1) — one record, whatever state it has reached since.
          return { status: 200, body: { requestId, recorded: true, alreadyRecorded: true, status: prior.status, valueMinor: prior.valueMinor, flags: prior.governanceFlags } };
        }

        const flags: AdjustmentRequestFlag[] = [];
        const permissions = await deps.permissionsOfUser(ctx.tenantId, r.requestedBy);
        if (permissions === undefined) flags.push('requester_unknown');
        else if (!permissions.includes('inventory.movement.append')) flags.push('requester_lacks_authority');
        const unitValue = await deps.unitValueMinor(ctx.tenantId, r.productId);
        if (unitValue === undefined) flags.push('value_unknown');
        const recordedAt = deps.now();

        const record: AdjustmentRequestRecord = {
          requestId, productId: r.productId, locationId: r.locationId, binId: r.binId,
          deltaMinor: r.deltaMinor, uom: r.uom, reasonCode: r.reasonCode, note: r.note,
          valueMinor: valueAtUnitCost(Math.abs(r.deltaMinor), r.uom, unitValue ?? 0), currency: 'INR', // OB-31
          requestedBy: r.requestedBy, at: r.at, storeId: r.storeId, source: r.source,
          relayedBy: ctx.userId, recordedAt, governanceFlags: flags,
          status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null, movementId: null,
        };
        await deps.recordRequest(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: r.requestedBy, action: 'adjustment.request', objectType: 'stock_adjustment_request', objectId: requestId,
          at: recordedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            productId: r.productId, locationId: r.locationId, binId: r.binId ?? '', deltaMinor: String(r.deltaMinor), uom: r.uom,
            reasonCode: r.reasonCode, valueMinor: String(record.valueMinor), relayedBy: ctx.userId, source: r.source, storeId: r.storeId ?? '',
            flags: flags.join(','), status: 'pending',
          },
          reason: r.reasonCode, correlationId: requestId,
        });
        // 202: the request happened at the store; this records it and holds it for a person. Nothing has moved.
        return { status: 202, body: { requestId, recorded: true, status: 'pending', valueMinor: record.valueMinor, flags } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/adjustment-requests/:requestId/decide',
      permission: 'inventory.adjustment.approve', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decision = b['decision'];
        if ((decision !== 'approved' && decision !== 'rejected') || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_adjustment_decision',
            whatHappened: 'A decision needs { decision: "approved" | "rejected", reason } — the reason is the audit line a person reads later.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the decision with a reason. Nothing was changed.',
          });
        }
        const out = await decideAdjustmentRequest(deps, { tenantId: ctx.tenantId, requestId, decidedBy: ctx.userId, decision, reason: b['reason'].trim(), branchId: ctx.branchId ?? null, via: 'direct',
          assertInScope: (locationId) => assertLocationInScope(ctx, locationId, deps.locationBranches) });
        if (!out.ok) {
          const status = out.refusedBecause === 'adjustment_request_unknown' ? 404 : out.refusedBecause === 'adjustment_request_already_decided' ? 409 : 422;
          throw apiError(status, {
            code: out.refusedBecause, whatHappened: out.detail, wasItSaved: 'not_saved',
            nextSafeAction: out.refusedBecause === 'self_approval' ? 'A different person with approval authority must decide it. Nothing was changed.'
              : out.refusedBecause === 'adjustment_request_unknown' ? 'Check the store has synchronised — the request may still be on the store computer.'
                : out.refusedBecause === 'adjustment_request_already_decided' ? 'Raise a new request if the position is still wrong. Nothing was changed.' : 'Nothing was posted. Raise it with the store.',
          });
        }
        const r = out.record;
        return { status: 200, body: { requestId, status: r.status, movementId: r.movementId, decidedBy: r.decidedBy, decidedAt: r.decidedAt, alreadyDecided: out.alreadyDecided } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/adjustment-requests',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const status = ctx.query['status'];
        if (status !== undefined && !(ADJUSTMENT_REQUEST_STATUSES as readonly string[]).includes(status)) {
          throw apiError(400, { code: 'not_readable_as_an_adjustment_query', whatHappened: `status must be one of ${ADJUSTMENT_REQUEST_STATUSES.join(' / ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Correct the query. Nothing was changed.' });
        }
        const storeId = ctx.query['storeId'];
        const scope = await stockReadScope(ctx, deps.locationBranches); // PA-01-r1: only requests at the caller's branches
        const all = (await deps.requests(ctx.tenantId)).filter((r) => scope.covers(r.locationId));
        const requests = all
          .filter((r) => (status === undefined || r.status === status) && (storeId === undefined || r.storeId === storeId))
          // Pending first (the work a person has), then newest first.
          .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        return { status: 200, body: { requests, count: requests.length, pending: all.filter((r) => r.status === 'pending').length, asAt: deps.now() } };
      },
    },
  ];
}
