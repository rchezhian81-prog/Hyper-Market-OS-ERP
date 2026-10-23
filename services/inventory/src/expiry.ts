// API-04 FEFO surface (M10-FR-01) — two reads on the tested `packages/fefo` engine: the daily expiry ACTION
// LIST ("what to mark down and what to bin") and FEFO ALLOCATION ("which batches to draw a demand from,
// earliest-expiry-first"). Perishable stock leaks money at expiry, and the roadmap rule is sell-oldest-first:
//
//   • the expiry action list returns, EARLIEST-EXPIRY FIRST, every on-hand batch that is EXPIRED (→ dispose)
//     or within `nearExpiryDays` of expiry (→ markdown), so the floor pulls what is past date and marks down
//     what is close; a recall-blocked or non-`on_hand` batch is never listed (the recall block is honoured
//     at the till, M10-FR-04);
//   • FEFO allocation answers "to meet a demand for N units of a product, which batches do we draw from?" —
//     earliest expiry first, only sellable batches (expired/recalled/quarantined excluded), reporting any
//     SHORTFALL honestly rather than over-allocating. This is the allocation a pick list, a transfer or an
//     online order uses so the oldest stock leaves first (M10-FR-01 acceptance: "sales allocate the
//     earliest-expiry batch").
//
// Deliberately STATELESS. The cloud availability ledger holds no batch EXPIRY (a movement carries a batch
// id but not its use-by), and the store edge already holds the batch/expiry truth in its signed pack — one
// truth, not two (P-02). The caller supplies the on-hand batches with their expiry; these endpoints run the
// FEFO engine that nothing on the cloud could otherwise reach, and write nothing.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { expiryActions, allocateFefo, isExpired, InvalidFefoRequestError, type Batch } from '../../../packages/fefo/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { BatchBalance } from './index';
import { locationInScope, type LocationBranches } from './location-scope';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isWholeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A batch is enough to be a batch when it names itself, its product, a whole quantity and an expiry date.
 * `state`/`recallBlocked` are optional (default on_hand / not recalled); the engine reads them if present. */
const isBatch = (v: unknown): v is Batch => {
  if (v === null || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return isStr(b['batchId']) && isStr(b['productId'])
    && typeof b['qty'] === 'number' && Number.isInteger(b['qty'])
    && isStr(b['expiry']);
};

export function expiryRoutes(): readonly Route[] {
  return [
    {
      // A read masquerading as POST because the batches are an array — idempotent, writes nothing.
      api: 'API-04', method: 'POST', path: '/v1/inventory/expiry-actions',
      permission: 'inventory.availability.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const batches = b['batches'];
        if (!Array.isArray(batches) || !batches.every(isBatch) || !isStr(b['asOf']) || !isWholeNonNeg(b['nearExpiryDays'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_expiry_check',
            whatHappened: 'An expiry action list needs batches[] (each with a batchId, productId, whole qty and an expiry date), an asOf date, and nearExpiryDays (a whole number of days ≥ 0).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the on-hand batches with their expiry dates, today’s date, and how many days ahead counts as near-expiry.',
          });
        }
        try {
          const items = expiryActions(batches as Batch[], b['asOf'] as string, b['nearExpiryDays'] as number);
          // 200, not 201 — nothing was created; this is the read of what needs action today.
          return {
            status: 200,
            body: {
              items,
              asOf: b['asOf'],
              nearExpiryDays: b['nearExpiryDays'],
              disposeCount: items.filter((i) => i.action === 'dispose').length,
              markdownCount: items.filter((i) => i.action === 'markdown').length,
              totalQtyAtRisk: items.reduce((s, i) => s + i.qty, 0),
            },
          };
        } catch (err) {
          if (err instanceof InvalidFefoRequestError) {
            throw apiError(400, { code: 'invalid_expiry_request', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the offending batch date (an unparseable date) and try again.' });
          }
          throw err;
        }
      },
    },
    {
      // FEFO ALLOCATION (M10-FR-01): "to meet a demand for `requiredQty` of `productId`, which batches do we
      // draw from?" — earliest-expiry-first over the supplied on-hand batches, only sellable ones, reporting
      // any shortfall honestly. A read masquerading as POST because the batches are an array; writes nothing.
      // Body: { batches: Batch[], productId, requiredQty, asOf }.
      api: 'API-04', method: 'POST', path: '/v1/inventory/fefo-allocation',
      permission: 'inventory.availability.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const batches = b['batches'];
        if (!Array.isArray(batches) || !batches.every(isBatch) || !isStr(b['productId']) || !isWholeNonNeg(b['requiredQty']) || !isStr(b['asOf'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_fefo_allocation',
            whatHappened: 'A FEFO allocation needs batches[] (each with a batchId, productId, whole qty and an expiry date), a productId, a whole requiredQty ≥ 0, and an asOf date.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the on-hand batches for the product, how many units are needed, and today’s date.',
          });
        }
        try {
          const result = allocateFefo(batches as Batch[], b['productId'] as string, b['requiredQty'] as number, b['asOf'] as string);
          // 200, not 201 — this is a plan, nothing was drawn. A shortfall is reported honestly, never hidden.
          return { status: 200, body: { ...result, productId: b['productId'], asOf: b['asOf'] } };
        } catch (err) {
          if (err instanceof InvalidFefoRequestError) {
            throw apiError(400, { code: 'invalid_fefo_request', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the offending value (an unparseable date or a negative quantity) and try again.' });
          }
          throw err;
        }
      },
    },
  ];
}

// ── OB-288 lane 2 · P2: an expired batch MOVES to the expired state by itself (M10-FR-01 · M08-FR-02) ─────────────────
//
// M10-FR-01: "expired stock auto-moves to expired state (not sellable, M08-FR-02)". Until now nothing wrote that move: a
// batch past its date was excluded only where a reader looked at the date itself. Now a DAILY sweep (the ops-alert worker's
// pass, once per shop day, and a "run it now" route for a person) appends ONE `BatchExpired` fact per batch the day its
// date has passed — append-only (hard rule #2): the stock ledger's quantities are not touched (the units are still on the
// shelf until somebody bins them), the batch's STATE is recorded as expired from that moment, with the on-hand it had. The
// dispose action stays the M28 write-off of that batch, which the expired register shows beside the move (what is still
// there to bin, and the write-offs that binned it). "Expired" uses the FEFO engine's own rule (the date strictly before the
// shop's day), so the expiry list, the FEFO allocation and this move can never disagree. A batch moved once is never moved
// again; a correction of a wrongly-recorded date is a person's compensating act, never an overwrite.


/** One batch's move into the expired state — the fact the sweep appends, once. */
export interface ExpiredBatchMove {
  readonly productId: string;
  readonly locationId: string;
  /** null for stock received with an expiry but no batch id — still stock past its date. */
  readonly batchId: string | null;
  /** YYYY-MM-DD, the batch's own date. */
  readonly expiry: string;
  /** The on-hand the batch had when it was moved (it is still on the shelf until it is written off). */
  readonly onHandMinor: number;
  /** The shop day the move belongs to (the first day the date had passed). */
  readonly shopDay: string;
  readonly movedAt: string;
  /** Never a person: the sweep moved it (a person who runs it now is named on the trail). */
  readonly movedBy: 'expiry-sweep';
}

/** The key that makes a batch's move once-only, whoever or whatever runs the sweep. */
export const expiryMoveKey = (m: Pick<ExpiredBatchMove, 'productId' | 'locationId' | 'batchId'>): string =>
  `${m.locationId}\u001f${m.productId}\u001f${m.batchId ?? ''}`;

/**
 * The batches to move today (pure): every batch with stock on hand, a recorded expiry, and that expiry strictly before the
 * shop's day by the FEFO engine's own rule — and not already moved. Earliest expiry first. A batch with no recorded date is
 * never guessed into "expired" (P-08).
 */
export function expiredBatchesToMove(input: {
  readonly batches: readonly BatchBalance[]; readonly alreadyMoved: ReadonlySet<string>; readonly shopDay: string; readonly at: string;
}): readonly ExpiredBatchMove[] {
  return input.batches
    .filter((b) => b.expiry !== undefined && b.onHandMinor > 0 && !input.alreadyMoved.has(expiryMoveKey(b))
      && isExpired({ batchId: b.batchId ?? '', productId: b.productId, qty: b.onHandMinor, expiry: b.expiry }, input.shopDay))
    .sort((a, b) => (a.expiry! < b.expiry! ? -1 : a.expiry! > b.expiry! ? 1 : expiryMoveKey(a) < expiryMoveKey(b) ? -1 : 1))
    .map((b): ExpiredBatchMove => ({
      productId: b.productId, locationId: b.locationId, batchId: b.batchId, expiry: b.expiry!, onHandMinor: b.onHandMinor,
      shopDay: input.shopDay, movedAt: input.at, movedBy: 'expiry-sweep',
    }));
}

/** A write-off that binned stock of a batch (M28), as the expired register shows it beside the move. */
export interface BatchWriteOff { readonly id: string; readonly productId: string; readonly locationId: string; readonly batchId?: string | null; readonly qtyRemoved: number; readonly at: string }

export interface ExpiryStateDeps {
  /** Every move already recorded (append-only), oldest first. */
  readonly moves: (tenantId: string) => Promise<readonly ExpiredBatchMove[]> | readonly ExpiredBatchMove[];
  /** Head office's batch balances (the M08 projection). */
  readonly batches: (tenantId: string) => Promise<readonly BatchBalance[]> | readonly BatchBalance[];
  /** Append the day's moves — each idempotent on its own key, so a second sweep the same day records nothing new. */
  readonly recordMoves: (tenantId: string, moves: readonly ExpiredBatchMove[]) => Promise<void> | void;
  /** The write-offs (M28) — the dispose action the register links to each moved batch. Absent → none shown. */
  readonly writeOffs?: (tenantId: string) => Promise<readonly BatchWriteOff[]> | readonly BatchWriteOff[];
  readonly locationBranches?: LocationBranches;
  /** The shop's day for a moment (India Standard Time for this store). */
  readonly shopDayOf: (at: string) => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

/** Run the sweep for one shop: append today's moves; answer how many batches moved. */
export async function sweepExpiredBatches(deps: ExpiryStateDeps, tenantId: string, at: string): Promise<readonly ExpiredBatchMove[]> {
  const already = new Set((await deps.moves(tenantId)).map(expiryMoveKey));
  const moves = expiredBatchesToMove({ batches: await deps.batches(tenantId), alreadyMoved: already, shopDay: deps.shopDayOf(at), at });
  if (moves.length > 0) await deps.recordMoves(tenantId, moves);
  return moves;
}

export function expiryStateRoutes(deps: ExpiryStateDeps): readonly Route[] {
  return [
    {
      // The expired register: every batch the sweep moved, newest first, with what is still on the shelf to bin and the
      // write-offs that binned it. Scoped to the reader's branches (PA-01-r1). ?locationId= narrows. A read.
      api: 'API-04', method: 'GET', path: '/v1/inventory/expired-batches',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const only = ctx.query['locationId'];
        const balances = await deps.batches(ctx.tenantId);
        const writeOffs = deps.writeOffs === undefined ? [] : await deps.writeOffs(ctx.tenantId);
        const rows = [];
        for (const m of [...(await deps.moves(ctx.tenantId))].reverse()) {
          if (isStr(only) && m.locationId !== only) continue;
          if (!(await locationInScope(ctx, m.locationId, deps.locationBranches))) continue;
          const now = balances.find((b) => expiryMoveKey(b) === expiryMoveKey(m));
          const binned = writeOffs.filter((w) => w.productId === m.productId && w.locationId === m.locationId && (w.batchId ?? null) === m.batchId);
          const remainingMinor = Math.max(0, now?.onHandMinor ?? 0);
          rows.push({ ...m, remainingMinor, toBin: remainingMinor > 0, writeOffs: binned.map((w) => ({ id: w.id, qtyRemoved: w.qtyRemoved, at: w.at })) });
        }
        return { status: 200, body: { batches: rows, count: rows.length, toBinCount: rows.filter((r) => r.toBin).length, asAt: deps.now() } };
      },
    },
    {
      // Run today's sweep now (the worker runs it on its own each shop day). Idempotent: a batch already moved is not
      // moved again, so a second run the same day moves nothing. The person who ran it is on the trail; the moves are the
      // sweep's own.
      api: 'API-04', method: 'POST', path: '/v1/inventory/expiry-sweep',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const at = deps.now();
        const moved = await sweepExpiredBatches(deps, ctx.tenantId, at);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'inventory.expiry_sweep.run', objectType: 'expiry_sweep', objectId: deps.shopDayOf(at), at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null, after: { moved: String(moved.length) }, correlationId: deps.shopDayOf(at),
        });
        return { status: 200, body: { moved, count: moved.length, shopDay: deps.shopDayOf(at) } };
      },
    },
  ];
}
