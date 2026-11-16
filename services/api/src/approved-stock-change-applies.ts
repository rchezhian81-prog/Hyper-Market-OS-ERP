// OB-808 A (owner, 16 Nov 2026, in writing: "OB-808 A") · daily-work defect D-013 · M28-FR-01 · M08 · ADR-0024 · §28 ·
// P-08 · hard rules #2, #5, #10.
//
// APPROVING A WRITE-OFF WRITES IT OFF AT ONCE, IN THE ASKER'S NAME.
//
// Before: the store manager approved "Write off 6 pouches of Sunflower Oil" and the page said "The person who asked can
// now go ahead — once". Nothing was written off; the asker had to come back and send the loss again. Now, when a person
// who may decide it APPROVES a `stock_write_off` (or an upward stock correction, `stock_adjustment_up`) asked through the
// governed route, head office sends exactly the asked-for action through that SAME route, as the asker, naming the
// approval — so every check of an ordinary write-off runs again and nothing is skipped:
//
//   • the asker still holds the stock permission, at the place (their own branch scope, from their grants);
//   • the approval is exactly this action (the request's own details — nothing is re-typed), unused and unexpired, and
//     its approver still holds the authority; it is spent once, by the route, just before the loss is written;
//   • the closed reason list, the count freeze, other owners' stock, the value from head office's own cost;
//   • the stock leaves by an append-only compensating movement; the write-off carries the asker (raisedBy) and the
//     approver (approvedBy), and its audit entry names both.
//
// Idempotent: the same decision re-sent, or the asker pressing "Record the loss" afterwards, never writes off twice —
// the route refuses a write-off id already on file, and this step reads that as "already written off". A loss that
// cannot be applied is NOT silent: the outcome is recorded (append-only) and said to the approver on the decision and to
// both people on their Approvals lists. Who may approve is unchanged; the engine still refuses the asker's own request.

import { createHash } from 'node:crypto';
import { InMemoryEventStore, type EventStore, type PersistedEvent } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import { AccessControl } from '../../../packages/rbac/src/rbac';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { ApiError, type Route, type RequestContext, type HandlerResult } from '../../kernel/src/index';
import type { ApprovalState } from '../../identity/src/approval-requests';
import {
  STREAM, streamName, approvalRequestsAdapter, writeOffAdapter, inventoryAdapter, effectiveGrants, effectiveRoleCatalogue, permissionsHeldBy,
} from './adapters';

/** The stock permission both governed routes require of the person whose action it is. */
const STOCK_PERMISSION = 'inventory.movement.append';

/** What happened to an approved stock change — recorded once per request, and said on the decision and the lists. */
export interface StockChangeOutcome {
  readonly requestId: string;
  readonly kind: 'stock_write_off' | 'stock_adjustment_up';
  readonly applied: boolean;
  /** The write-off id or the movement id the action carries. */
  readonly subjectRef: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly uom: string;
  /** Whose action it is (the asker) and who approved it. */
  readonly askedBy: string;
  readonly approvedBy: string;
  /** Why it was not applied, in head office's own words (absent when applied). */
  readonly reason?: string;
  readonly code?: string;
  readonly at: string;
}

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 20);
const outcomesStream = (): string => streamName(STREAM.inventory, 'approved-stock-change-outcomes');

/** The governed route an approved request's action goes through, or undefined when this request is not one of them. */
interface Action {
  readonly kind: StockChangeOutcome['kind'];
  readonly method: 'POST';
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly uom: string;
}

/**
 * The action an approved request asked for — read only from the request's own recorded details (what the engine
 * fingerprinted), never from the decision. Only requests asked through the governed routes are applied here: a write-off
 * (`details.writeOffId` is the subject) and an upward correction (an `adjusted` movement whose id is the subject). A
 * `stock_write_off` asked by another path (a held returned unit's decision, which applies itself) is left alone.
 */
export function actionOf(state: ApprovalState): Action | undefined {
  const r = state.request;
  const d = r.details as Record<string, unknown>;
  const common = isStr(d['productId']) && isStr(d['locationId']) && Number.isInteger(d['qty']) && (d['qty'] as number) > 0 && isStr(d['uom']);
  if (!common) return undefined;
  if (r.kind === 'stock_write_off' && d['writeOffId'] === r.subjectRef && isStr(d['reasonCode'])) {
    const { writeOffId: _w, ...body } = d;
    void _w;
    return {
      kind: 'stock_write_off', method: 'POST', path: '/v1/inventory/write-off/:writeOffId', params: { writeOffId: r.subjectRef },
      body: { ...body, approvalId: r.requestId },
      productId: d['productId'] as string, locationId: d['locationId'] as string, qty: d['qty'] as number, uom: d['uom'] as string,
    };
  }
  if (r.kind === 'stock_adjustment_up' && d['kind'] === 'adjusted' && d['movementId'] === r.subjectRef) {
    return {
      kind: 'stock_adjustment_up', method: 'POST', path: '/v1/inventory/movements', params: {},
      body: { ...d, approvalId: r.requestId },
      productId: d['productId'] as string, locationId: d['locationId'] as string, qty: d['qty'] as number, uom: d['uom'] as string,
    };
  }
  return undefined;
}

function indexOf(surface: readonly Route[], method: string, path: string): number {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`OB-808 wiring cannot find ${method} ${path} — an approved write-off would silently not be written off`);
  return at;
}

/**
 * Wire OB-808 A onto the finished surface (one line in main.ts, after the identity and catalogue-change wraps): the
 * engine's decide route applies an approved write-off or upward correction at once; the inbox says what became of it.
 */
export function approvedStockChangeSurface(surface: Route[], input: {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly recordAudit?: Recorder;
}): void {
  const store = input.store ?? new InMemoryEventStore();
  const { now } = input;
  const approvals = approvalRequestsAdapter({ store, now });
  const writeOffs = writeOffAdapter({ store, now });
  const inventory = inventoryAdapter({ store, now });
  indexOf(surface, 'POST', '/v1/inventory/write-off/:writeOffId');
  indexOf(surface, 'POST', '/v1/inventory/movements');

  /** The governed route's handler as it stands when called — every later wrap (OB-623 movement jobs …) runs too. */
  const routeHandler = (method: string, path: string) => (ctx: RequestContext): Promise<HandlerResult> =>
    Promise.resolve(surface[indexOf(surface, method, path)]!.handler(ctx));

  const outcomes = async (tenantId: string): Promise<Map<string, StockChangeOutcome>> => {
    const rows: PersistedEvent[] = [
      ...await store.readStream(tenantId, outcomesStream(), { type: 'ApprovedStockChangeApplied' }),
      ...await store.readStream(tenantId, outcomesStream(), { type: 'ApprovedStockChangeNotApplied' }),
    ];
    // Latest per request: a change not applied earlier (e.g. the asker had no permission) may be applied on a re-send.
    const out = new Map<string, StockChangeOutcome>();
    for (const e of rows.sort((a, b) => a.seq - b.seq)) { const o = e.event.payload as StockChangeOutcome; out.set(o.requestId, o); }
    return out;
  };

  /** Has the action already happened (applied by an earlier decide, or recorded by the asker)? */
  const alreadyDone = async (tenantId: string, action: Action): Promise<boolean> => action.kind === 'stock_write_off'
    ? Boolean(await writeOffs.writeOffExists(tenantId, action.params['writeOffId']!))
    : Boolean(await inventory.isKnown(tenantId, String(action.body['movementId'])));

  const apply = async (ctx: RequestContext, state: ApprovalState, action: Action): Promise<StockChangeOutcome> => {
    const asker = state.request.requestedBy;
    const approvedBy = state.decision!.decidedBy;
    const base = {
      requestId: state.request.requestId, kind: action.kind, subjectRef: state.request.subjectRef,
      productId: action.productId, locationId: action.locationId, qty: action.qty, uom: action.uom,
      askedBy: asker, approvedBy, at: now(),
    };
    if (await alreadyDone(ctx.tenantId, action)) return { ...base, applied: true };
    // The asker's own authority, judged now from their grants — the kernel's permission check is not in this path.
    const held = (await permissionsHeldBy(store, ctx.tenantId, asker)) ?? [];
    if (!held.includes(STOCK_PERMISSION)) {
      return { ...base, applied: false, code: 'asker_may_no_longer_move_stock', reason: `${asker} no longer holds the stock authority, so the approved change cannot be made in their name. Nothing was written off.` };
    }
    const scope = new AccessControl(await effectiveRoleCatalogue(store, ctx.tenantId), await effectiveGrants(store, ctx.tenantId)).branchScopeOf(asker, STOCK_PERMISSION);
    try {
      await routeHandler(action.method, action.path)({
        tenantId: ctx.tenantId, userId: asker, branchId: ctx.branchId, scope,
        params: action.params, query: {}, body: action.body,
        idempotencyKey: `ob808-${state.request.requestId}`, traceId: ctx.traceId,
      });
      return { ...base, applied: true };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      // A re-send racing the first apply: the route says the write-off is on file — that is applied, not a failure.
      if (e.body.code === 'write_off_already_recorded' || e.body.code === 'approval_already_used') {
        if (await alreadyDone(ctx.tenantId, action)) return { ...base, applied: true };
      }
      return { ...base, applied: false, code: e.body.code, reason: e.body.whatHappened };
    }
  };

  const record = async (ctx: RequestContext, outcome: StockChangeOutcome): Promise<void> => {
    const stored = await store.append(ctx.tenantId, outcomesStream(), makeEvent({
      id: `approved-stock-change-${digest(`${ctx.tenantId}-${outcome.requestId}-${outcome.applied}-${outcome.code ?? ''}`)}`,
      type: outcome.applied ? 'ApprovedStockChangeApplied' : 'ApprovedStockChangeNotApplied', occurredAt: outcome.at,
      idempotencyKey: `approved-stock-change-${ctx.tenantId}-${outcome.requestId}-${outcome.applied}-${outcome.code ?? ''}`,
      source: 'api/approved-stock-change', payload: outcome,
    }));
    if (!stored.deduped && !outcome.applied) {
      // The write-off route seals its own entry when it writes; a change that could NOT be made is sealed here (P-08).
      await input.recordAudit?.(ctx.tenantId, {
        actorId: ctx.userId, action: 'stock.approved_change.not_applied', objectType: 'product', objectId: outcome.productId,
        at: outcome.at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
        after: { requestId: outcome.requestId, kind: outcome.kind, askedBy: outcome.askedBy, approvedBy: outcome.approvedBy, code: outcome.code ?? '' },
        reason: outcome.reason ?? '', approvalId: outcome.requestId, correlationId: `approved-stock-change:${outcome.requestId}`,
      });
    }
  };

  // One apply at a time per request in this process; the route's own once-only checks hold across processes.
  const inFlight = new Map<string, Promise<StockChangeOutcome>>();

  // ── The decide route: an approved stock change is made at once ──────────────────────────────────────────────────
  const decideAt = indexOf(surface, 'POST', '/v1/approvals/requests/:requestId/decide');
  const engineDecide = surface[decideAt]!.handler;
  surface[decideAt] = {
    ...surface[decideAt]!,
    handler: async (ctx) => {
      const out = await engineDecide(ctx);
      const requestId = ctx.params['requestId'] ?? '';
      const state = await approvals.approvalState(ctx.tenantId, requestId);
      if (state === undefined || state.decision === undefined || state.decision.decision !== 'approved' || state.decision.decidedBy !== ctx.userId) return out;
      const action = actionOf(state);
      if (action === undefined) return out;
      const key = `${ctx.tenantId}\u0000${requestId}`;
      let running = inFlight.get(key);
      if (running === undefined) {
        running = apply(ctx, state, action).finally(() => inFlight.delete(key));
        inFlight.set(key, running);
      }
      const outcome = await running;
      await record(ctx, outcome);
      return { ...out, body: { ...(out.body as Record<string, unknown>), stockChange: outcome } };
    },
  };

  // ── The inbox says, on each approved stock change, whether it was made (P-08) ──────────────────────────────────────
  const listAt = indexOf(surface, 'GET', '/v1/approvals/requests');
  const engineList = surface[listAt]!.handler;
  surface[listAt] = {
    ...surface[listAt]!,
    handler: async (ctx) => {
      const out = await engineList(ctx);
      const body = out.body as { waitingForMe?: Record<string, unknown>[]; mine?: Record<string, unknown>[] } | undefined;
      if (body === undefined || !Array.isArray(body.mine) || !Array.isArray(body.waitingForMe)) return out;
      const all = [...body.mine, ...body.waitingForMe];
      if (!all.some((row) => row['kind'] === 'stock_write_off' || row['kind'] === 'stock_adjustment_up')) return out;
      const known = await outcomes(ctx.tenantId);
      const add = (row: Record<string, unknown>): Record<string, unknown> => {
        const o = known.get(String(row['requestId']));
        return o === undefined ? row : { ...row, stockChange: o };
      };
      return { ...out, body: { ...body, waitingForMe: body.waitingForMe.map(add), mine: body.mine.map(add) } };
    },
  };
}
