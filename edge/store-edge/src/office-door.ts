// THE HOSTED COPY'S OFFICE DOOR — each office page's work is held to its OWN permission, never to "may sell"
// (OB-572 "B", owner, 31 Oct 2026, in writing · SEC-1's rule · P-04 · P-07 · hard rule #10).
//
// Behind the hosted front, an office page hands its decisions to the store computer's lane socket (`/lane/outbox`: an
// approval decided, a supplier bill captured, a delivery booked in, a count, an indent, a production run, a food-safety
// check, a quality release, a meter reading, a stock loss, an SOP read, an attendance mark, a migration decision) and the
// manager's day close and reopen (`/lane/day-close`, `/lane/day-reopen`). Until now those went through the TILL's door,
// which the front opens only to a person who may SELL — so the owner, the accountant or a buyer, who do not sell, could
// not decide anything on the hosted demo. The owner chose "B": each office page checks its own permission, as the
// handhelds now do (Round 3, `HANDHELD_DOOR`).
//
// So the box has an OFFICE door. The hosted front marks it `X-Sre-Door: office` and names the person its sign-in let
// through (`X-Sre-User`, overwritten by the front, never passed through). On that door the box takes office work ONLY —
// the office lane routes (`OFFICE_LANE_ROUTES`) and an office page's (`manager`) batch — and holds the named person, ITEM
// BY ITEM, to that work's own permission in THIS box's role register (the store pack): exactly the word head office
// re-checks on that record when it arrives. An item they may not do is REFUSED by name (the page keeps it as a refused
// record a person must look at, never quietly dropped); the rest go on. Nobody named → 401. A store box (no front) never
// trusts either header, and the till's own door is unchanged.

import { SUBJECT_AUTHORITY } from '../../../services/identity/src/approval-decisions';
import type { DeviceAck } from '../../../packages/sync/src/device-relay';
import { readRelayItem } from '../../../packages/sync/src/device-relay';

/** The front's mark for this door. */
export const OFFICE_DOOR = 'office';

/** The surface an office page's batch claims (`packages/sync/src/device-relay.ts`). */
export const OFFICE_SOURCE = 'manager';

/** The migration page's own permission (apps/web-erp/src/navigation.ts) — a parallel-run day is the named reconciler's,
 *  which head office checks; the box holds the person to the page. */
const MIGRATION_PAGE = 'migration.cleaning.read';

/**
 * For each kind of office work, the permission its person must hold — the word head office re-checks on that record (its
 * `…/synced` route). An approval is the authority its subject needs (`SUBJECT_AUTHORITY`); a subject head office has no
 * word for is refused here too (never guessed). A record type not listed is refused (fails closed).
 */
export const OFFICE_WORK_AUTHORITY: Readonly<Record<string, (payload: Record<string, unknown>) => string | undefined>> = Object.freeze({
  ApprovalDecided: (p) => (typeof p['subjectType'] === 'string' ? SUBJECT_AUTHORITY[p['subjectType']] : undefined),
  SupplierInvoiceCaptured: () => 'purchase.invoice.capture',
  GoodsReceived: () => 'inventory.movement.append',
  StockCounted: () => 'inventory.movement.append',
  FloorIndentRequested: () => 'inventory.indent.request',
  FloorIndentReceived: () => 'inventory.movement.append',
  ShelfCounted: () => 'shelf.count.record',
  MigrationExceptionResolved: () => 'migration.exception.resolve',
  MigrationTotalSigned: () => 'migration.controltotal.sign',
  MigrationParallelDayEntered: () => MIGRATION_PAGE,
  MigrationParallelDaySigned: () => MIGRATION_PAGE,
  ProductionRunCaptured: () => 'production.plan.commit',
  WeighedRunCaptured: () => 'production.plan.commit',
  ProductionReleaseDecided: () => 'production.release',
  FoodSafetyCheckRecorded: () => 'facilities.task.record',
  QualityHoldReleaseDecided: () => 'quality.hold.release',
  QualitySampleRecorded: () => 'quality.hold.manage',
  EquipmentReadingRecorded: () => 'facilities.reading.record',
  WriteOffCaptured: () => 'inventory.movement.append',
  SopAcknowledged: () => 'workforce.sop.ack.self',
  AttendanceMarked: () => 'workforce.attendance.mark',
});

/** What the office door says about a whole request before any item is read. Undefined = not this door, or go on. */
export function officeDoorRefusal(input: {
  readonly trustForwardedUser: boolean;
  readonly door: string | string[] | undefined;
  readonly user: string | string[] | undefined;
  readonly pathname: string;
  readonly officeRoutes: readonly string[];
}): { readonly status: 401 | 403; readonly refusedBecause: string; readonly reason: string } | undefined {
  if (!input.trustForwardedUser || input.door !== OFFICE_DOOR) return undefined;
  if (!input.officeRoutes.includes(input.pathname)) {
    return { status: 403, refusedBecause: 'not_office_work', reason: `The office door takes office pages' work only, not ${input.pathname}. Nothing was taken.` };
  }
  const user = typeof input.user === 'string' ? input.user.trim() : '';
  if (user === '') return { status: 401, refusedBecause: 'nobody_signed_in', reason: 'Nobody is signed in, so this work was not taken. Sign in and it is sent again.' };
  return undefined;
}

/** The person the office door names (only on that door, behind the front). */
export function officeDoorPerson(trustForwardedUser: boolean, door: string | string[] | undefined, user: string | string[] | undefined): string | undefined {
  if (!trustForwardedUser || door !== OFFICE_DOOR || typeof user !== 'string' || user.trim() === '') return undefined;
  return user.trim();
}

/**
 * Split an office batch into the items the named person may hand over and the refusals for the rest, in their words.
 * An item that cannot be read is passed on, so the relay refuses it with its own reason.
 */
export function judgeOfficeItems(items: readonly unknown[], person: string, permissions: readonly string[] | null): { readonly allowed: readonly unknown[]; readonly refused: readonly DeviceAck[] } {
  const held = new Set(permissions ?? []);
  const allowed: unknown[] = [];
  const refused: DeviceAck[] = [];
  for (const raw of items) {
    const read = readRelayItem(raw);
    if (!read.ok) { allowed.push(raw); continue; }
    const { event } = read.item;
    const payload = event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
    const needs = OFFICE_WORK_AUTHORITY[event.type]?.(payload);
    if (needs === undefined) {
      refused.push({ key: read.item.key, status: 'refused', reason: `${event.type} is not work an office page hands over here, so ${person} cannot send it. Nothing was taken.` });
    } else if (!held.has(needs)) {
      refused.push({ key: read.item.key, status: 'refused', reason: `${person} may not do this (${event.type} needs ${needs}, which their role here does not give). Nothing was taken; the owner or the store manager can do it.` });
    } else {
      allowed.push(raw);
    }
  }
  return { allowed, refused };
}

/** The relay's acks and the door's refusals, back in the order the page sent the items. */
export function inSentOrder(items: readonly unknown[], relayed: readonly DeviceAck[], refused: readonly DeviceAck[]): DeviceAck[] {
  const byKey = new Map<string, DeviceAck>();
  for (const a of [...relayed, ...refused]) byKey.set(a.key, a);
  const ordered: DeviceAck[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const key = raw !== null && typeof raw === 'object' && typeof (raw as { key?: unknown }).key === 'string' ? (raw as { key: string }).key : undefined;
    if (key !== undefined && byKey.has(key) && !seen.has(key)) { ordered.push(byKey.get(key)!); seen.add(key); }
  }
  for (const a of [...relayed, ...refused]) if (!seen.has(a.key)) { ordered.push(a); seen.add(a.key); }
  return ordered;
}
