// API-04 Back-door receiving: dock scheduling + ASN comparison (M07-FR-01) — the tested
// `packages/receiving/src/asn.ts` engine, on the cloud. The handheld receiving scan itself is already
// driven offline by the warehouse PWA; these are the two back-door decisions that had no cloud route.
//
//   • DOCK SCHEDULING. Two lorries booked on one door at one time is a queue, not a schedule. A booking
//     that overlaps a live slot on the same dock is refused (a cancelled or no-show slot frees the door).
//   • THE ADVANCE SHIP NOTICE IS A PROMISE, NOT A RECEIPT. Booking stock from what the supplier SAID they
//     sent is how a shop books goods it never got. Comparing the ASN against what actually turned up
//     surfaces every difference (short or over) for the discrepancy path (M07-FR-03) — a match is not a
//     row, only a difference is.
//
// Both are stateless: the caller supplies the slot + the day's existing bookings, or the ASN + the
// received tallies. Nothing is stored here; the durable dock diary is the follow-on.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  bookDockSlot, compareAgainstAsn, DockConflictError,
  type Asn, type AsnLine, type DockSlot,
} from '../../../packages/receiving/src/asn';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const DOCK_STATES: readonly DockSlot['status'][] = ['booked', 'arrived', 'completed', 'no_show', 'cancelled'];
const isDockStatus = (v: unknown): v is DockSlot['status'] => typeof v === 'string' && (DOCK_STATES as readonly string[]).includes(v);
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

function readAsnLine(v: unknown): AsnLine | undefined {
  if (!isObj(v) || !isStr(v['lineId']) || !isStr(v['productId']) || !isNonNegInt(v['quantityMinor']) || !isStr(v['uom'])) return undefined;
  if (v['batchId'] !== undefined && !isStr(v['batchId'])) return undefined;
  if (v['expiry'] !== undefined && !isStr(v['expiry'])) return undefined;
  return {
    lineId: v['lineId'] as string, productId: v['productId'] as string, quantityMinor: v['quantityMinor'] as number, uom: v['uom'] as string,
    ...(isStr(v['batchId']) ? { batchId: v['batchId'] } : {}),
    ...(isStr(v['expiry']) ? { expiry: v['expiry'] } : {}),
  };
}

function readAsn(v: unknown): Asn | undefined {
  if (!isObj(v) || !isStr(v['asnId']) || !isStr(v['supplierId']) || !isStr(v['expectedAt']) || !Array.isArray(v['lines'])) return undefined;
  if (v['poId'] !== undefined && !isStr(v['poId'])) return undefined;
  const lines = v['lines'].map(readAsnLine);
  if (lines.some((l) => l === undefined)) return undefined;
  return {
    asnId: v['asnId'] as string, supplierId: v['supplierId'] as string, expectedAt: v['expectedAt'] as string, lines: lines as AsnLine[],
    ...(isStr(v['poId']) ? { poId: v['poId'] } : {}),
  };
}

// `received` is a { productId: baseUnits } tally — whole, non-negative counts of what actually arrived.
function readReceived(v: unknown): Readonly<Record<string, number>> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!isNonNegInt(val)) return undefined;
    out[k] = val;
  }
  return out;
}

function readDockSlot(v: unknown): DockSlot | undefined {
  if (!isObj(v) || !isStr(v['slotId']) || !isStr(v['storeId']) || !isStr(v['dockId'])
    || !isStr(v['startsAt']) || !isStr(v['endsAt']) || !isDockStatus(v['status'])) return undefined;
  if (v['supplierId'] !== undefined && !isStr(v['supplierId'])) return undefined;
  const poIds = v['poIds'] === undefined ? undefined : strArray(v['poIds']);
  if (v['poIds'] !== undefined && poIds === undefined) return undefined;
  return {
    slotId: v['slotId'] as string, storeId: v['storeId'] as string, dockId: v['dockId'] as string,
    startsAt: v['startsAt'] as string, endsAt: v['endsAt'] as string, status: v['status'],
    ...(isStr(v['supplierId']) ? { supplierId: v['supplierId'] } : {}),
    ...(poIds !== undefined ? { poIds } : {}),
  };
}

export function asnRoutes(): readonly Route[] {
  return [
    {
      // The advice note vs what actually turned up (M07-FR-01/03). Only the DIFFERENCES are returned — a
      // matching line is not a row — so what is surfaced is exactly what needs a person. Read-only.
      api: 'API-04', method: 'POST', path: '/v1/inventory/asn/compare',
      permission: 'inventory.availability.read', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        const asn = isObj(b) ? readAsn(b['asn']) : undefined;
        const received = isObj(b) ? readReceived(b['received']) : undefined;
        if (asn === undefined || received === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_an_asn_comparison',
            whatHappened: 'An ASN comparison needs { asn { asnId, supplierId, expectedAt, lines[{lineId,productId,quantityMinor,uom}] }, received { productId: wholeUnits } }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the advice note and the tally of what actually arrived — this only compares, it books no stock.',
          });
        }
        const differences = compareAgainstAsn(asn, received);
        return { status: 200, body: { differences, count: differences.length, matched: differences.length === 0 } };
      },
    },
    {
      // Book a dock slot (M07-FR-01). Two lorries at one door at one time is a queue, not a schedule, so a
      // booking that overlaps a live slot on the same dock is refused (a cancelled/no-show slot frees it).
      // Stateless: the caller supplies the day's existing bookings; the durable dock diary is the follow-on.
      api: 'API-04', method: 'POST', path: '/v1/inventory/dock-slots/book',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const b = ctx.body;
        const slot = isObj(b) ? readDockSlot(b['slot']) : undefined;
        const existingRaw = isObj(b) && b['existing'] !== undefined ? b['existing'] : [];
        const existing = Array.isArray(existingRaw) ? existingRaw.map(readDockSlot) : undefined;
        if (slot === undefined || existing === undefined || existing.some((s) => s === undefined)) {
          throw apiError(400, {
            code: 'not_readable_as_a_dock_booking',
            whatHappened: 'A dock booking needs a { slot } with slotId, storeId, dockId, startsAt, endsAt and status, and an optional { existing } list of the same shape.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the slot and the day’s existing bookings, then send it again.',
          });
        }
        try {
          return { status: 200, body: { booked: bookDockSlot(slot, existing as DockSlot[]) } };
        } catch (e) {
          if (e instanceof DockConflictError) {
            throw apiError(409, {
              code: 'dock_conflict',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Pick a free window on that dock, or another dock. Nothing was booked.',
            });
          }
          throw e;
        }
      },
    },
  ];
}
