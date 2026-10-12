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
import { looksLikeCardNumber } from '../../../packages/ops/src/index';
import { approverSealFlags, deciderSealFlags } from './store-seal';

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
  /**
   * OB-36 "A": the close is relayed by the store COMPUTER under its own role, so the person it names is re-checked
   * here against their own grants — `closer_unknown` (no grant at all) or `closer_lacks_authority` (no
   * `till.dayclose.read`). Record-and-flag: the day closed at the store either way (hard rule #10). Absent on older records.
   */
  readonly governanceFlags?: readonly string[];
  /**
   * OB-55 "A": the card/UPI payments this close carried forward to head office as named finance exceptions — with the
   * second person who approved it on the store computer, and the unresolved amounts by kind. Absent: nothing was carried.
   */
  readonly carriedForward?: CarriedForwardOnClose;
}

/** OB-55: what a close carried forward, as head office records it on the close. */
export interface CarriedForwardOnClose {
  readonly approvedBy: string;
  readonly approvalId: string;
  readonly reason: string;
  readonly attemptIds: readonly string[];
  readonly unresolvedMinor: { readonly card: number; readonly upi: number };
  /** What head office found when it re-checked the approver: not the closer, holds the authority, the box's seal on them. */
  readonly flags: readonly string[];
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
  /** OB-36 "A": the permissions the named closer holds now, from their grants (undefined = no grant at all). Optional
   *  on a bare stub — then nothing is checked and nothing is claimed. */
  readonly permissionsOfUser?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** The store computer's seal key (ADR-0023, amended 2b-vi-c-3): the reopener is checked against the box's seal.
   *  Absent on a bare stub — then nothing is checked and nothing is claimed. */
  readonly tillSealKey?: Buffer;
  readonly now: () => string;
  /**
   * OB-55 "A": raise each carried-forward payment as a named finance exception (keyed per payment — idempotent). Absent on
   * a bare stub: then a close that carries payments is still recorded, with the payments on the close itself.
   */
  readonly carryPaymentExceptions?: (tenantId: string, close: DayCloseRecord, payments: readonly CarriedPaymentIn[]) => Promise<void> | void;
}

/** One carried payment as the store computer relayed it. */
export interface CarriedPaymentIn {
  readonly attemptId: string; readonly laneId: string; readonly billRef: string; readonly kind: 'card' | 'upi';
  readonly amountMinor: number; readonly askedAt: string; readonly state: 'asked' | 'no_answer'; readonly tradingDay: string;
}

/** OB-55: the carried-forward block as relayed — undefined when absent; `null` when present but unreadable (kept at the store). */
function readCarried(body: unknown): { readonly approvedBy: string; readonly approvalId: string; readonly reason: string; readonly payments: readonly CarriedPaymentIn[] } | undefined | null {
  const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const cf = b['carriedForward'];
  if (cf === undefined) return undefined;
  if (cf === null || typeof cf !== 'object') return null;
  const c = cf as Record<string, unknown>;
  const s = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  if (!s(c['approvedBy']) || !s(c['approvalId']) || !s(c['reason']) || !Array.isArray(c['payments']) || c['payments'].length === 0) return null;
  const payments: CarriedPaymentIn[] = [];
  for (const x of c['payments'] as unknown[]) {
    const p = (x !== null && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (!s(p['attemptId']) || !s(p['laneId']) || !s(p['billRef']) || (p['kind'] !== 'card' && p['kind'] !== 'upi')
      || typeof p['amountMinor'] !== 'number' || !Number.isSafeInteger(p['amountMinor']) || (p['amountMinor'] as number) <= 0
      || !s(p['askedAt']) || (p['state'] !== 'asked' && p['state'] !== 'no_answer') || !s(p['tradingDay'])) return null;
    payments.push({ attemptId: p['attemptId'], laneId: p['laneId'], billRef: p['billRef'], kind: p['kind'], amountMinor: p['amountMinor'] as number, askedAt: p['askedAt'], state: p['state'], tradingDay: p['tradingDay'] });
  }
  return { approvedBy: c['approvedBy'], approvalId: c['approvalId'], reason: c['reason'], payments };
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

/** The authority a person needs to close the store's day — the same the box asks of whoever handles locked days. */
export const CLOSE_AUTHORITY = 'till.dayclose.read';

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
        const carried = readCarried(ctx.body);
        if (c === undefined || carried === null) {
          throw apiError(400, {
            code: 'not_readable_as_a_day_close',
            whatHappened: 'This payload could not be read as a day close — it needs a store, a trading day, who closed it and when.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the outbox and raise it — a day the store closed is still closed.',
          });
        }

        // Hard rule #3, checked again at head office (defence in depth): a carried payment's reference that looks like a card
        // number is refused before ANYTHING of this close is kept — the close stays in the store's outbox, visible, and is
        // raised; head office never stores card data, not even inside a record it would otherwise only flag.
        if (carried !== undefined && carried.payments.some((p) => [p.attemptId, p.laneId, p.billRef].some(looksLikeCardNumber))) {
          throw apiError(422, {
            code: 'provider_ref_not_a_token',
            whatHappened: 'A payment this day close carried forward has a reference that looks like raw card data rather than a payment reference. Card numbers are never taken (hard rule #3), so nothing of this close was recorded.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep the close in the store\'s outbox and raise it — the day is still closed at the store. Nothing was changed here.',
          });
        }
        // OB-36 "A": who the store says closed the day is re-checked against THEIR grants — flagged, never refused.
        const flags: string[] = [];
        if (deps.permissionsOfUser !== undefined) {
          const held = await deps.permissionsOfUser(ctx.tenantId, c.closedBy);
          if (held === undefined) flags.push('closer_unknown');
          else if (!held.includes(CLOSE_AUTHORITY)) flags.push('closer_lacks_authority');
        }
        // OB-55: who approved carrying payments forward is re-checked like a reopen's approver — never the closer, holding
        // `till.dayclose.approve`, and verified by their own PIN at the store computer (its seal over every word). Flags only.
        let carriedForward: CarriedForwardOnClose | undefined;
        if (carried !== undefined) {
          const cflags: string[] = [];
          if (carried.approvedBy === c.closedBy) cflags.push('approved_by_the_closer');
          else if (!(await deps.canApproveDayReopen(ctx.tenantId, carried.approvedBy))) cflags.push('approver_lacks_authority');
          cflags.push(...approverSealFlags(deps.tillSealKey, { tenantId: ctx.tenantId, kind: 'day_close_exception_approval', recordId: dayCloseId, named: carried.approvedBy, record: ctx.body }));
          const sum = (k: 'card' | 'upi'): number => carried.payments.filter((p) => p.kind === k).reduce((n, p) => n + p.amountMinor, 0);
          carriedForward = { approvedBy: carried.approvedBy, approvalId: carried.approvalId, reason: carried.reason, attemptIds: carried.payments.map((p) => p.attemptId), unresolvedMinor: { card: sum('card'), upi: sum('upi') }, flags: cflags };
        }
        const record: DayCloseRecord = {
          dayCloseId, storeId: c.storeId, tradingDay: c.tradingDay, closedBy: c.closedBy, closedAt: c.closedAt, locked: true,
          ...(flags.length === 0 ? {} : { governanceFlags: flags }),
          ...(carriedForward === undefined ? {} : { carriedForward }),
        };
        // The exceptions first (each keyed on its payment), then the close: a crash between the two re-sends the close, which
        // carries nothing twice.
        if (carried !== undefined && deps.carryPaymentExceptions !== undefined) await deps.carryPaymentExceptions(ctx.tenantId, record, carried.payments);
        await deps.recordDayClose(ctx.tenantId, record);
        // 202, not 201: the day is closed at the store and this records that it happened. A 4xx here
        // would tell the store a day it locked did not close.
        return { status: 202, body: { dayCloseId, closed: true, tradingDay: record.tradingDay, closedBy: record.closedBy, locked: true, flags, ...(carriedForward === undefined ? {} : { carriedForward }) } };
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
        // Did the store computer see the REOPENER reopen this day, exactly as it arrives? (2b-vi-c-3 · ADR-0023 amended)
        flags.push(...deciderSealFlags(deps.tillSealKey, { tenantId: ctx.tenantId, kind: 'day_reopen', recordId: dayCloseId, named: r.reopenedBy, record: ctx.body }));
        if (r.approvedBy === undefined) {
          flags.push('given_without_approval');
        } else if (r.approvedBy === r.reopenedBy) {
          flags.push('approved_by_the_reopener');
        } else {
          if (!(await deps.canApproveDayReopen(ctx.tenantId, r.approvedBy))) flags.push('approver_lacks_authority');
          // Did the store computer verify the APPROVER — their own PIN at the box (2b-vi-c-4) — for exactly this reopen?
          flags.push(...approverSealFlags(deps.tillSealKey, { tenantId: ctx.tenantId, kind: 'day_reopen_approval', recordId: dayCloseId, named: r.approvedBy, record: ctx.body }));
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
            // OB-36 "A" (round 4 acceptance): what head office found when it re-checked the person the store named as the
            // CLOSER (closer_unknown / closer_lacks_authority) — recorded on the close, and shown here, never dropped.
            closeFlags: c.governanceFlags ?? [],
            // OB-55: the card/UPI payments this close carried forward to head office, and the amounts left unresolved.
            carriedForward: c.carriedForward ?? null,
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
            // The closes a person still needs to look at — a day locked under the name of someone without that authority.
            flaggedCloses: rows.filter((r) => r.closeFlags.length > 0 || (r.carriedForward?.flags.length ?? 0) > 0)
              .map((r) => ({ dayCloseId: r.dayCloseId, tradingDay: r.tradingDay, closedBy: r.closedBy, closeFlags: [...r.closeFlags, ...(r.carriedForward?.flags ?? [])] })),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
