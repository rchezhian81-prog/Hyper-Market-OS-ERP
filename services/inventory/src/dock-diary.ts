// API-04 The durable DOCK DIARY (M07-FR-01 "ASN/direct-store-delivery, dock scheduling and receiving"; OB-288 P3).
//
// The stateless booking route (`/v1/inventory/dock-slots/book`) judged a slot against bookings the CALLER sent. Here the
// diary is head office's own record, so an overlap is refused against the bookings it HOLDS:
//
//   • BOOK (`POST /v1/inventory/dock-diary/:slotId`) — { storeId, dockId, startsAt, endsAt, supplierId?, poIds? }. Refused by
//     name when it overlaps a live booking on the same door (booked or arrived; a cancelled or no-show slot frees it), with
//     the clashing slot named. Written under the door's own write guard, so two bookings for one door at once: one lands.
//     The same slot id sent again with the same details is the same booking; with different details it is refused.
//   • STATUS (`…/status`) — arrived · completed · no_show · cancelled, each a new append-only fact with who and when:
//     booked → arrived | no_show | cancelled; arrived → completed. Anything else is refused by name.
//   • READ (`GET /v1/inventory/dock-diary?storeId=&date=`) — the store's day, door by door, with every booking still marked
//     booked after its window ended listed as LATE (control by exception, P-03) — never silently dropped.
//
// The tested `bookDockSlot` (packages/receiving) is the overlap rule. A person books at a store inside their own branches.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, concurrentChange } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import { bookDockSlot, DockConflictError, type DockSlot } from '../../../packages/receiving/src/asn';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { assertLocationInScope, stockReadScope, type LocationBranches } from './location-scope';

export interface DiaryBooking extends DockSlot {
  readonly bookedBy: string;
  readonly bookedAt: string;
  readonly history: readonly { readonly status: DockSlot['status']; readonly by: string; readonly at: string; readonly reason?: string }[];
}

export interface DockDiaryDeps {
  /** Every booking at its current state (latest status), the history kept. */
  readonly bookings: (tenantId: string) => Promise<readonly DiaryBooking[]> | readonly DiaryBooking[];
  /** The door's write guard version — read BEFORE the bookings it protects. */
  readonly doorVersion: (tenantId: string, storeId: string, dockId: string) => Promise<number> | number;
  /** Record a booking under the door's guard (else `ConcurrencyConflictError`). */
  readonly recordBooking: (tenantId: string, booking: DiaryBooking, guard: { readonly key: string; readonly expectedVersion: number }) => Promise<void>;
  readonly recordStatus: (tenantId: string, slotId: string, status: DockSlot['status'], by: string, at: string, reason: string | undefined) => Promise<void> | void;
  readonly locationBranches?: LocationBranches;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

export const dockGuardKey = (storeId: string, dockId: string): string => `dock:${storeId}:${dockId}`;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const NEXT: Readonly<Record<DockSlot['status'], readonly DockSlot['status'][]>> = {
  booked: ['arrived', 'no_show', 'cancelled'], arrived: ['completed'], completed: [], no_show: [], cancelled: [],
};
const sameBooking = (a: DockSlot, b: DockSlot): boolean => a.storeId === b.storeId && a.dockId === b.dockId && a.startsAt === b.startsAt
  && a.endsAt === b.endsAt && (a.supplierId ?? '') === (b.supplierId ?? '') && (a.poIds ?? []).join(',') === (b.poIds ?? []).join(',');

export function dockDiaryRoutes(deps: DockDiaryDeps): readonly Route[] {
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/dock-diary/:slotId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const slotId = (ctx.params['slotId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const poIds = b['poIds'];
        if (slotId === '' || !isStr(b['storeId']) || !isStr(b['dockId']) || !isIso(b['startsAt']) || !isIso(b['endsAt'])
          || (b['supplierId'] !== undefined && !isStr(b['supplierId'])) || (poIds !== undefined && !(Array.isArray(poIds) && poIds.every(isStr)))) {
          throw apiError(400, {
            code: 'not_readable_as_a_dock_booking',
            whatHappened: 'A dock booking needs the slotId in the path and { storeId, dockId, startsAt, endsAt (date-times), supplierId?, poIds? } in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the store, the door and the window. Nothing was booked.',
          });
        }
        const storeId = (b['storeId'] as string).trim();
        await assertLocationInScope(ctx, storeId, deps.locationBranches);
        const slot: DockSlot = {
          slotId, storeId, dockId: (b['dockId'] as string).trim(), startsAt: new Date(b['startsAt'] as string).toISOString(), endsAt: new Date(b['endsAt'] as string).toISOString(),
          status: 'booked', ...(isStr(b['supplierId']) ? { supplierId: b['supplierId'] } : {}), ...(Array.isArray(poIds) ? { poIds: poIds as string[] } : {}),
        };
        const key = dockGuardKey(slot.storeId, slot.dockId);
        const expectedVersion = await deps.doorVersion(ctx.tenantId, slot.storeId, slot.dockId);
        const all = await deps.bookings(ctx.tenantId);
        const existing = all.find((x) => x.slotId === slotId);
        if (existing !== undefined) {
          if (sameBooking(existing, slot)) return { status: 200, body: { booking: existing, alreadyBooked: true } };
          throw apiError(409, { code: 'slot_id_already_used', whatHappened: `Slot ${slotId} is already booked with different details (${existing.dockId}, ${existing.startsAt}–${existing.endsAt}).`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new slot id for a new booking, or cancel the old one first. Nothing was booked.' });
        }
        try {
          bookDockSlot(slot, all.filter((x) => x.storeId === slot.storeId));
        } catch (e) {
          if (e instanceof DockConflictError) {
            throw apiError(409, {
              code: e.clashingSlotId === '(invalid window)' ? 'dock_window_invalid' : 'dock_conflict',
              whatHappened: e.clashingSlotId === '(invalid window)' ? 'The booking ends before (or when) it starts.' : e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Pick a free window on that door, or another door. Nothing was booked.',
            });
          }
          throw e;
        }
        const at = deps.now();
        const booking: DiaryBooking = { ...slot, bookedBy: ctx.userId, bookedAt: at, history: [{ status: 'booked', by: ctx.userId, at }] };
        try {
          await deps.recordBooking(ctx.tenantId, booking, { key, expectedVersion });
        } catch (e) {
          if (e instanceof ConcurrencyConflictError) throw concurrentChange(`dock ${slot.dockId} at ${slot.storeId} (another booking was made for it a moment ago)`);
          throw e;
        }
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'dock.book', objectType: 'dock_slot', objectId: slotId, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { storeId: slot.storeId, dockId: slot.dockId, startsAt: slot.startsAt, endsAt: slot.endsAt, supplierId: slot.supplierId ?? '' }, correlationId: slotId,
        });
        return { status: 201, body: { booking, alreadyBooked: false } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/dock-diary/:slotId/status',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const slotId = (ctx.params['slotId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const status = b['status'];
        if (status !== 'arrived' && status !== 'completed' && status !== 'no_show' && status !== 'cancelled') {
          throw apiError(400, { code: 'not_readable_as_a_dock_status', whatHappened: 'A dock status is one of arrived, completed, no_show or cancelled.', wasItSaved: 'not_saved', nextSafeAction: 'Send { status, reason? }. Nothing was changed.' });
        }
        const booking = (await deps.bookings(ctx.tenantId)).find((x) => x.slotId === slotId);
        if (booking === undefined) throw notFound(`dock booking ${slotId}`);
        await assertLocationInScope(ctx, booking.storeId, deps.locationBranches);
        if (booking.status === status) return { status: 200, body: { booking, alreadySet: true } };
        if (!NEXT[booking.status].includes(status)) {
          throw apiError(409, { code: 'dock_status_not_allowed', whatHappened: `Slot ${slotId} is ${booking.status}; it cannot become ${status}.`, wasItSaved: 'not_saved', nextSafeAction: 'A booked slot is marked arrived, no-show or cancelled; an arrived one completed. Nothing was changed.' });
        }
        const reason = isStr(b['reason']) ? b['reason'].trim() : undefined;
        if ((status === 'cancelled' || status === 'no_show') && reason === undefined) {
          throw apiError(422, { code: 'reason_required', whatHappened: `Marking a slot ${status === 'cancelled' ? 'cancelled' : 'a no-show'} needs a reason for the supplier's record.`, wasItSaved: 'not_saved', nextSafeAction: 'Send { status, reason }. Nothing was changed.' });
        }
        const at = deps.now();
        await deps.recordStatus(ctx.tenantId, slotId, status, ctx.userId, at, reason);
        return { status: 200, body: { booking: { ...booking, status, history: [...booking.history, { status, by: ctx.userId, at, ...(reason === undefined ? {} : { reason }) }] }, alreadySet: false } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/dock-diary',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const storeId = ctx.query['storeId'];
        const date = ctx.query['date'];
        if (!isStr(storeId) || !(date === undefined || /^\d{4}-\d{2}-\d{2}$/.test(date))) {
          throw apiError(400, { code: 'store_required', whatHappened: 'Say which store\'s dock diary to read: ?storeId= (and ?date=YYYY-MM-DD for one day).', wasItSaved: 'not_saved', nextSafeAction: 'Send the store. Nothing was changed.' });
        }
        const scope = await stockReadScope(ctx, deps.locationBranches);
        if (!scope.covers(storeId)) throw apiError(403, { code: 'outside_your_branches', whatHappened: `${storeId} is outside your branches.`, wasItSaved: 'not_saved', nextSafeAction: 'Ask for a store you work at. Nothing was changed.' });
        const now = deps.now();
        const day = (await deps.bookings(ctx.tenantId)).filter((x) => x.storeId === storeId && (date === undefined || x.startsAt.slice(0, 10) === date))
          .sort((a, b) => (a.dockId === b.dockId ? a.startsAt.localeCompare(b.startsAt) : a.dockId.localeCompare(b.dockId)));
        const late = day.filter((x) => x.status === 'booked' && x.endsAt < now).map((x) => ({ slotId: x.slotId, dockId: x.dockId, supplierId: x.supplierId ?? null, endedAt: x.endsAt }));
        return { status: 200, body: { storeId, date: date ?? null, bookings: day, count: day.length, late, asAt: now } };
      },
    },
  ];
}
