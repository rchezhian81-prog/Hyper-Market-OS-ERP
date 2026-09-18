// API-05 Store/day close reconcile-on-sync (M14-FR-04) — the cloud RECORDS a store day that was
// closed (and locked) at the edge, and re-verifies a controlled REOPEN.
//
// **Why this is a recording route, not a decision route.** The day-close DECISION belongs to the
// store edge (P-01, packages/day-close): a day may close only once its trading-day cut-off has
// passed (M01-FR-02) AND the store is fully reconciled — no unsent sales and no unresolved
// exceptions. That "no unsent items" gate can only be evaluated where the outbox lives — the edge —
// so the cloud cannot re-decide it. This route therefore does for the day close exactly what
// `/v1/sales/:saleId/returns/synced` does for an offline refund: it TRUSTS the fact that happened at
// the store (relayed under the store's sync token) and records it — it never rejects a day the store
// already closed. The one thing the edge could not fully check, and this route can, is whether the
// person who APPROVED a reopen genuinely holds the §28 authority; a breach there is recorded and
// FLAGGED (hard rule #10 — a visible exception), never silently dropped and never a rejection.
//
// A closed day is LOCKED — corrections after it are new compensating events, never edits (hard
// rule #2). The recorded day-close/reopen facts are the spine the day-close evidence pack is built
// from, and the read here is what feeds finance (M23) and the owner (M29).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';

/** A store day close as it is recorded on the cloud — the fact the edge relayed, plus its lock. */
export interface DayCloseRecord {
  readonly dayCloseId: string;
  readonly storeId: string;
  /** The trading day (YYYY-MM-DD) that was closed, dated at the edge to the trading-day cut-off. */
  readonly tradingDay: string;
  /** Who closed the day at the store — captured at the edge and trusted here, as a synced sale's cashier is. */
  readonly closedBy: string;
  /** ISO-8601 UTC moment of the close. */
  readonly closedAt: string;
  /** A closed day is locked; corrections are new compensating events only (hard rule #2). */
  readonly locked: true;
}

/**
 * A controlled, audited reopen of a locked day (M14-FR-04 / §28). Append-only — it never edits the
 * close. `governanceFlags` names any §28 breach found when the cloud re-verified the approver
 * (record-and-flag, hard rule #10): the reopen still happened at the store, so it is recorded, and
 * the breach is surfaced for a person rather than the reopen being rejected.
 */
export interface DayReopenRecord {
  readonly dayCloseId: string;
  readonly storeId: string;
  readonly tradingDay: string;
  readonly reopenedBy: string;
  /** The named approver, or null when the reopen arrived with none (a flagged breach). */
  readonly approvedBy: string | null;
  readonly reason: string;
  readonly reopenedAt: string;
  readonly governanceFlags: readonly string[];
}

export interface DayCloseDeps {
  readonly dayClose: (tenantId: string, dayCloseId: string) => Promise<DayCloseRecord | undefined> | DayCloseRecord | undefined;
  readonly recordDayClose: (tenantId: string, record: DayCloseRecord) => Promise<void> | void;
  readonly dayReopen: (tenantId: string, dayCloseId: string) => Promise<DayReopenRecord | undefined> | DayReopenRecord | undefined;
  readonly recordDayReopen: (tenantId: string, record: DayReopenRecord) => Promise<void> | void;
  readonly dayCloses: (tenantId: string) => Promise<readonly DayCloseRecord[]> | readonly DayCloseRecord[];
  readonly dayReopens: (tenantId: string) => Promise<readonly DayReopenRecord[]> | readonly DayReopenRecord[];
  /** Does this user genuinely hold the §28 authority to APPROVE a day-close reopen (till.dayclose.approve)? */
  readonly canApproveDayReopen: (tenantId: string, userId: string) => Promise<boolean> | boolean;
  readonly now: () => string;
}

/** The close as the sync agent relays it — the fact captured at the edge. */
interface SyncedClose {
  readonly storeId: string;
  readonly tradingDay: string;
  readonly closedBy: string;
  readonly closedAt: string;
}
function readClose(body: unknown): SyncedClose | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof b[k] === 'string' && (b[k] as string).trim() !== '' ? (b[k] as string) : undefined;
  const storeId = str('storeId');
  const tradingDay = str('tradingDay');
  const closedBy = str('closedBy');
  const closedAt = str('closedAt');
  if (storeId === undefined || tradingDay === undefined || closedBy === undefined || closedAt === undefined) return undefined;
  return { storeId, tradingDay, closedBy, closedAt };
}

/** The reopen as the sync agent relays it — the reopen the store performed with a local approval. */
interface SyncedReopen {
  readonly reopenedBy: string;
  readonly reason: string;
  /** The named approver, if any — its authority is re-verified here (§28). */
  readonly approvedBy?: string;
}
function readReopen(body: unknown): SyncedReopen | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const reopenedBy = typeof b['reopenedBy'] === 'string' && (b['reopenedBy'] as string).trim() !== '' ? (b['reopenedBy'] as string) : undefined;
  // A reopen is audited and MUST carry a reason (M14-FR-04); a blank one is malformed, kept at the
  // store rather than dropped, not a governance flag.
  const reason = typeof b['reason'] === 'string' && (b['reason'] as string).trim() !== '' ? (b['reason'] as string) : undefined;
  if (reopenedBy === undefined || reason === undefined) return undefined;
  const approvedBy = typeof b['approvedBy'] === 'string' && (b['approvedBy'] as string).trim() !== '' ? (b['approvedBy'] as string) : undefined;
  return { reopenedBy, reason, ...(approvedBy === undefined ? {} : { approvedBy }) };
}

export function dayCloseRoutes(deps: DayCloseDeps): readonly Route[] {
  return [
    {
      // Record a store day the edge already closed and locked. Relayed under the store's sync token;
      // trusts the fact (the day closed at the store) and never rejects it. Idempotent per day-close id.
      api: 'API-05', method: 'POST', path: '/v1/pos/day-close/:dayCloseId/synced',
      permission: 'till.dayclose.sync', idempotent: true,
      handler: async (ctx) => {
        const dayCloseId = ctx.params['dayCloseId'] ?? '';
        const already = await deps.dayClose(ctx.tenantId, dayCloseId);
        if (already !== undefined) {
          const reopened = (await deps.dayReopen(ctx.tenantId, dayCloseId)) !== undefined;
          return { status: 200, body: { dayCloseId, closed: true, tradingDay: already.tradingDay, locked: !reopened, alreadyClosed: true } };
        }

        const c = readClose(ctx.body);
        if (c === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_day_close',
            whatHappened: 'This payload could not be read as a day close — it needs a store, a trading day, who closed it and when.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the outbox and raise it — a day the store closed is still closed.',
          });
        }

        const record: DayCloseRecord = {
          dayCloseId, storeId: c.storeId, tradingDay: c.tradingDay, closedBy: c.closedBy, closedAt: c.closedAt, locked: true,
        };
        await deps.recordDayClose(ctx.tenantId, record);
        // 202, not 201: the day is closed at the store and this records that it happened. A 4xx here
        // would tell the store a day it locked did not close.
        return { status: 202, body: { dayCloseId, closed: true, tradingDay: record.tradingDay, closedBy: record.closedBy, locked: true } };
      },
    },
    {
      // Record a controlled reopen of a locked day, re-verifying the §28 approver's authority on the
      // cloud. Record-and-flag, never reject (the reopen happened at the store). Idempotent per day.
      api: 'API-05', method: 'POST', path: '/v1/pos/day-close/:dayCloseId/reopen/synced',
      permission: 'till.dayclose.sync', idempotent: true,
      handler: async (ctx) => {
        const dayCloseId = ctx.params['dayCloseId'] ?? '';
        const closed = await deps.dayClose(ctx.tenantId, dayCloseId);
        if (closed === undefined) {
          // A reopen with no close to reopen is not a fact this cloud can place — kept at the store.
          throw notFound(`closed day ${dayCloseId}`);
        }
        const existing = await deps.dayReopen(ctx.tenantId, dayCloseId);
        if (existing !== undefined) {
          return { status: 200, body: { dayCloseId, reopened: true, reopenedBy: existing.reopenedBy, flags: existing.governanceFlags, alreadyReopened: true } };
        }

        const r = readReopen(ctx.body);
        if (r === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_day_reopen',
            whatHappened: 'This payload could not be read as a day reopen — it needs who reopened it and a stated reason.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. A reopen is audited and needs a reason; send who reopened it and why.',
          });
        }

        // §28 re-verification — the one control the edge could not fully apply (it can only check the
        // approver differs from the reopener; only the cloud knows who holds the authority). Every
        // breach is a FLAG on the recorded reopen, not a rejection (hard rule #10). Defensive: the
        // edge should have blocked a missing/self approval, but a synced fact is recorded regardless.
        const flags: string[] = [];
        if (r.approvedBy === undefined) {
          flags.push('given_without_approval');
        } else if (r.approvedBy === r.reopenedBy) {
          flags.push('approved_by_the_reopener');
        } else if (!(await deps.canApproveDayReopen(ctx.tenantId, r.approvedBy))) {
          flags.push('approver_lacks_authority');
        }

        const record: DayReopenRecord = {
          dayCloseId, storeId: closed.storeId, tradingDay: closed.tradingDay,
          reopenedBy: r.reopenedBy, approvedBy: r.approvedBy ?? null, reason: r.reason,
          reopenedAt: deps.now(), governanceFlags: flags,
        };
        await deps.recordDayReopen(ctx.tenantId, record);
        return { status: 202, body: { dayCloseId, reopened: true, tradingDay: record.tradingDay, reopenedBy: record.reopenedBy, approvedBy: record.approvedBy, flags } };
      },
    },
    {
      // The locked-day list the finance close (M23) and the owner (M29) read: which trading days are
      // final, and which reopens carry an unresolved §28 breach (control by exception, P-03).
      api: 'API-05', method: 'GET', path: '/v1/pos/day-close',
      permission: 'till.dayclose.read',
      handler: async (ctx) => {
        const closes = await deps.dayCloses(ctx.tenantId);
        const reopens = await deps.dayReopens(ctx.tenantId);
        const reopenById = new Map(reopens.map((r) => [r.dayCloseId, r] as const));
        const rows = closes.map((c) => {
          const reopen = reopenById.get(c.dayCloseId);
          return {
            dayCloseId: c.dayCloseId, storeId: c.storeId, tradingDay: c.tradingDay,
            closedBy: c.closedBy, closedAt: c.closedAt,
            // Locked iff it was closed and not since reopened. A reopened day is open again.
            locked: reopen === undefined,
            reopened: reopen !== undefined,
            reopenedBy: reopen?.reopenedBy ?? null,
            approvedBy: reopen?.approvedBy ?? null,
            reopenReason: reopen?.reason ?? null,
            reopenedAt: reopen?.reopenedAt ?? null,
            governanceFlags: reopen?.governanceFlags ?? [],
          };
        });
        return {
          status: 200,
          body: {
            dayCloses: rows,
            lockedCount: rows.filter((r) => r.locked).length,
            // The reopens a person still needs to look at — a §28 breach nobody has resolved.
            flaggedReopens: rows.filter((r) => r.governanceFlags.length > 0)
              .map((r) => ({ dayCloseId: r.dayCloseId, tradingDay: r.tradingDay, reopenedBy: r.reopenedBy, approvedBy: r.approvedBy, governanceFlags: r.governanceFlags })),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
