// API-04 A write-off CAPTURED at the store with the line down (M28-FR-01 · M28.md "Offline (§31): queued; approval on
// sync" · audit-4 · P-01 · hard rules #2 #6 #10).
//
// The write-off capture page served by the store computer saves a loss on the screen's own queue when head office cannot
// be reached; the store computer carries it here. Nothing is decided at the store that head office would decide: the
// value is head office's (quantity × its own cost of that stock), the material-loss line is head office's, and so is the
// second person. So, on arrival:
//
//   • the raiser is re-checked from THEIR grants (they must handle stock);
//   • the loss is put to the SAME governed write-off route a head-office loss goes through, as the raiser — the closed
//     reason list, the count freeze, other owners' stock, the value. A loss below the line is recorded there and then
//     (`posted`); one the route refuses for a reason a person must fix is refused by name and stays at the store, visible;
//   • a loss at or above the line — evidence required — waits here for a SECOND person who handles stock: "approval on
//     sync" (`awaiting_approval`, 202). Nothing is written off and no stock moves until they decide.
//   • the decision (`POST /v1/inventory/write-off-captures/:writeOffId/decide`) is the second person's, in their own
//     session: approved → the raiser's approval request is made for exactly this loss, decided by them in the approvals
//     engine (never the raiser — §28), and the loss is recorded through the governed route naming it; rejected → nothing
//     is written off, the capture is kept with the reason (hard rule #6).
//
// Append-only: a capture's journey is a series of facts, the latest of which is its state.

import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError, ApiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { isWasteReason, WASTE_REASON_CODES } from '../../../packages/waste/src/reasons';
import { assertLocationInScope, stockReadScope, type LocationBranches } from './location-scope';

export type CaptureState = 'posted' | 'awaiting_approval' | 'rejected';
const LOSS_TYPES = ['wastage', 'damage', 'expiry', 'donation', 'destruction'] as const;

/** The loss as the store's screen captured it — the governed route's own body, and who and when. */
export interface CapturedLoss {
  readonly writeOffId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly uom: string;
  readonly lossType: (typeof LOSS_TYPES)[number];
  readonly reasonCode: string;
  readonly evidenceRef?: string;
  readonly batchId?: string;
  readonly note?: string;
  readonly raisedBy: string;
  readonly capturedAt: string;
  readonly storeId: string | null;
}

export interface CaptureRecord {
  readonly loss: CapturedLoss;
  readonly state: CaptureState;
  readonly at: string;
  readonly relayedBy?: string;
  /** Head office's value of the loss when it was judged (paise), when known. */
  readonly valueMinor?: number | null;
  readonly decidedBy?: string;
  readonly decisionReason?: string;
}

export interface WriteOffCaptureDeps {
  readonly captures: (tenantId: string) => Promise<readonly CaptureRecord[]>;
  readonly recordCapture: (tenantId: string, r: CaptureRecord) => Promise<void>;
  readonly writeOffExists: (tenantId: string, writeOffId: string) => Promise<boolean>;
  readonly permissionsOf: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
  /** Head office's value of the loss (quantity × its own cost), or undefined when it holds no cost. */
  readonly valueOf: (tenantId: string, loss: CapturedLoss) => Promise<number | undefined>;
  /** The governed write-off route's own handler, run as the raiser (with `approvalId` when a second person approved). */
  readonly writeOffAs: (ctx: RequestContext) => Promise<HandlerResult>;
  /** The approvals engine's own two routes: the maker asks, a different checker decides. */
  readonly askApprovalAs: (ctx: RequestContext) => Promise<HandlerResult>;
  readonly decideApprovalAs: (ctx: RequestContext) => Promise<HandlerResult>;
  readonly locationBranches?: LocationBranches;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

/** The governed route's body for this loss (what an approval is asked for, exactly). */
export function writeOffBodyOfCapture(l: CapturedLoss): Record<string, unknown> {
  return {
    productId: l.productId, locationId: l.locationId, qty: l.qty, uom: l.uom, lossType: l.lossType, reasonCode: l.reasonCode,
    ...(l.evidenceRef === undefined ? {} : { evidenceRef: l.evidenceRef }), ...(l.batchId === undefined ? {} : { batchId: l.batchId }),
    ...(l.note === undefined ? {} : { note: l.note }),
  };
}

function readCaptured(b: Record<string, unknown>, writeOffId: string): CapturedLoss | undefined {
  if (b['writeOffId'] !== writeOffId || !isStr(b['productId']) || !isStr(b['locationId']) || !isPosInt(b['qty']) || !isStr(b['uom'])
    || !(LOSS_TYPES as readonly unknown[]).includes(b['lossType']) || !isWasteReason(b['reasonCode']) || !isStr(b['raisedBy']) || !isTime(b['capturedAt'])
    || (b['evidenceRef'] !== undefined && !isStr(b['evidenceRef'])) || (b['batchId'] !== undefined && !isStr(b['batchId'])) || (b['note'] !== undefined && !isStr(b['note']))) return undefined;
  return {
    writeOffId, productId: (b['productId'] as string).trim(), locationId: (b['locationId'] as string).trim(), qty: b['qty'] as number, uom: (b['uom'] as string).trim(),
    lossType: b['lossType'] as CapturedLoss['lossType'], reasonCode: b['reasonCode'] as string, raisedBy: (b['raisedBy'] as string).trim(), capturedAt: b['capturedAt'] as string,
    storeId: isStr(b['storeId']) ? b['storeId'].trim() : null,
    ...(isStr(b['evidenceRef']) ? { evidenceRef: b['evidenceRef'].trim() } : {}), ...(isStr(b['batchId']) ? { batchId: b['batchId'].trim() } : {}), ...(isStr(b['note']) ? { note: b['note'].trim() } : {}),
  };
}

/** The latest record per write-off id. */
export function latestCaptures(records: readonly CaptureRecord[]): Map<string, CaptureRecord> {
  const m = new Map<string, CaptureRecord>();
  for (const r of records) m.set(r.loss.writeOffId, r);
  return m;
}

export function writeOffCaptureRoutes(deps: WriteOffCaptureDeps): readonly Route[] {
  const seal = async (tenantId: string, actorId: string, action: string, r: CaptureRecord, reason?: string): Promise<void> => {
    await deps.recordAudit?.(tenantId, {
      actorId, action, objectType: 'write_off', objectId: r.loss.writeOffId, at: deps.now(), origin: { tenantId, branchId: r.loss.storeId, capturedOffline: true },
      before: null, after: { productId: r.loss.productId, qty: String(r.loss.qty), lossType: r.loss.lossType, reasonCode: r.loss.reasonCode, state: r.state, raisedBy: r.loss.raisedBy, valueMinor: r.valueMinor === undefined || r.valueMinor === null ? '' : String(r.valueMinor) },
      ...(reason === undefined ? {} : { reason }), correlationId: r.loss.writeOffId,
    });
  };
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/write-off/:writeOffId/synced',
      permission: 'inventory.writeoff.sync', idempotent: true,
      handler: async (ctx) => {
        const writeOffId = (ctx.params['writeOffId'] ?? '').trim();
        const loss = writeOffId === '' ? undefined : readCaptured((ctx.body ?? {}) as Record<string, unknown>, writeOffId);
        if (loss === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_captured_write_off',
            whatHappened: `This could not be read as a loss captured at the store: it needs the writeOffId matching the address, productId, locationId, a whole qty above 0, uom, a lossType, a reasonCode from ${WASTE_REASON_CODES.join(' / ')}, who raised it and when.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it.',
          });
        }
        await assertLocationInScope(ctx, loss.locationId, deps.locationBranches); // the store computer speaks for its own store only
        const prior = latestCaptures(await deps.captures(ctx.tenantId)).get(writeOffId);
        if (prior !== undefined) return { status: prior.state === 'awaiting_approval' ? 202 : 200, body: { writeOffId, state: prior.state, alreadyRecorded: true } };
        if (await deps.writeOffExists(ctx.tenantId, writeOffId)) return { status: 200, body: { writeOffId, state: 'posted', alreadyRecorded: true } };
        const held = (await deps.permissionsOf(ctx.tenantId, loss.raisedBy)) ?? [];
        if (!held.includes('inventory.movement.append')) {
          throw apiError(403, { code: 'raiser_may_not_write_off', whatHappened: `${loss.raisedBy} holds no right to record a stock loss here (re-checked from their own grants).`, wasItSaved: 'not_saved', nextSafeAction: 'Keep it at the store; a person must look. Nothing was written off.' });
        }
        const valueMinor = (await deps.valueOf(ctx.tenantId, loss)) ?? null;
        try {
          await deps.writeOffAs({ ...ctx, userId: loss.raisedBy, params: { writeOffId }, body: writeOffBodyOfCapture(loss) });
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          if (e.body.code !== 'write_off_needs_approval') throw e; // refused by name — kept at the store, visible
          // A material loss: evidence is part of the loss itself, so one without it is refused now, not after approval.
          if (loss.evidenceRef === undefined) {
            throw apiError(422, { code: 'write_off_needs_evidence', whatHappened: 'This is a big loss (at or above the shop\'s line), and big losses need a photo or witness reference — the screen did not capture one.', wasItSaved: 'not_saved', nextSafeAction: 'Keep it at the store; record the loss again with its photo or witness. Nothing was written off.' });
          }
          const waiting: CaptureRecord = { loss, state: 'awaiting_approval', at: deps.now(), relayedBy: ctx.userId, valueMinor };
          await deps.recordCapture(ctx.tenantId, waiting);
          await seal(ctx.tenantId, loss.raisedBy, 'stock.write_off.captured_awaiting_approval', waiting);
          return { status: 202, body: { writeOffId, state: 'awaiting_approval', valueMinor } };
        }
        const posted: CaptureRecord = { loss, state: 'posted', at: deps.now(), relayedBy: ctx.userId, valueMinor };
        await deps.recordCapture(ctx.tenantId, posted);
        return { status: 201, body: { writeOffId, state: 'posted', valueMinor } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/write-off-captures',
      permission: 'waste.view',
      handler: async (ctx) => {
        const scope = await stockReadScope(ctx, deps.locationBranches);
        const state = ctx.query['state'];
        const rows = [...latestCaptures(await deps.captures(ctx.tenantId)).values()]
          .filter((r) => scope.covers(r.loss.locationId) && (state === undefined || r.state === state))
          .sort((a, b) => (a.state === b.state ? b.loss.capturedAt.localeCompare(a.loss.capturedAt) : a.state === 'awaiting_approval' ? -1 : b.state === 'awaiting_approval' ? 1 : 0));
        return { status: 200, body: { captures: rows, awaitingApproval: rows.filter((r) => r.state === 'awaiting_approval').length, asAt: deps.now() } };
      },
    },
    {
      // The second person decides a big loss captured at the store. Body: { decision: approved | rejected, reason }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/write-off-captures/:writeOffId/decide',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const writeOffId = (ctx.params['writeOffId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if ((b['decision'] !== 'approved' && b['decision'] !== 'rejected') || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_decision', whatHappened: 'A decision is { decision: "approved" | "rejected", reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the decision and why. Nothing was decided.' });
        }
        const r = latestCaptures(await deps.captures(ctx.tenantId)).get(writeOffId);
        if (r === undefined) throw notFound(`captured write-off ${writeOffId}`);
        await assertLocationInScope(ctx, r.loss.locationId, deps.locationBranches);
        if (r.state !== 'awaiting_approval') return { status: 200, body: { writeOffId, state: r.state, alreadyDecided: true } };
        if (ctx.userId === r.loss.raisedBy) {
          throw apiError(422, { code: 'self_approval', whatHappened: `${ctx.userId} raised this loss and cannot also approve it (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'Another person who handles stock decides it. Nothing was decided.' });
        }
        const reason = (b['reason'] as string).trim();
        if (b['decision'] === 'rejected') {
          const rejected: CaptureRecord = { ...r, state: 'rejected', at: deps.now(), decidedBy: ctx.userId, decisionReason: reason };
          await deps.recordCapture(ctx.tenantId, rejected);
          await seal(ctx.tenantId, ctx.userId, 'stock.write_off.captured_rejected', rejected, reason);
          return { status: 201, body: { writeOffId, state: 'rejected' } };
        }
        // Approved: the raiser's request for exactly this loss, decided by THIS person in the approvals engine, then the
        // loss through the governed route naming it — every rule of a head-office loss applies, nothing is skipped.
        const body = writeOffBodyOfCapture(r.loss);
        const asked = await deps.askApprovalAs({
          ...ctx, userId: r.loss.raisedBy, params: {},
          body: { kind: 'stock_write_off', subjectRef: writeOffId, details: { ...body, writeOffId }, valueMinor: r.valueMinor ?? null, summary: `A loss captured at the store with the line down: ${r.loss.qty} ${r.loss.uom} of ${r.loss.productId} (${r.loss.reasonCode}).`, reason: 'captured at the store; approval on sync (M28-FR-01)' },
        });
        const requestId = (asked.body as { requestId?: string }).requestId!;
        await deps.decideApprovalAs({ ...ctx, params: { requestId }, body: { decision: 'approved', reason } });
        await deps.writeOffAs({ ...ctx, userId: r.loss.raisedBy, params: { writeOffId }, body: { ...body, approvalId: requestId } });
        const posted: CaptureRecord = { ...r, state: 'posted', at: deps.now(), decidedBy: ctx.userId, decisionReason: reason };
        await deps.recordCapture(ctx.tenantId, posted);
        await seal(ctx.tenantId, ctx.userId, 'stock.write_off.captured_approved', posted, reason);
        return { status: 201, body: { writeOffId, state: 'posted', approvalId: requestId } };
      },
    },
  ];
}
