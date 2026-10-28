// D-11 (R3, OB-141 "A") — the direct-store-delivery door check-in on the warehouse handheld. Offline by construction
// (P-01, §31): the van is at the back door, often with the wifi down, so every step is decided locally with the SAME
// engine head office runs (`packages/receiving/src/dsd-checkin.ts`), and at close ONE record is queued to the device
// outbox (`DsdCheckInClosed`) for the store computer to relay. Head office re-judges it against its own order or route
// sheet and re-verifies the receiver; this phone decides nothing it could be wrong about.
//
// No cash at the door: there is no field for money on this screen. The close needs the signed delivery note — its
// reference and the driver's name as signed — and states what was kept and what was handed back.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { BarcodeResolution } from '../../../packages/receiving/src/asn';
import type { PackHierarchy } from '../../../packages/product/src/pack';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import {
  reconcileDsd, signDeliveryNote, DsdRefusedError, DSD_HAND_BACK_REASONS,
  type DsdExpectedLine, type DsdScan, type DsdHandBack, type DsdHandBackReason, type DsdReconciliation,
} from '../../../packages/receiving/src/dsd-checkin';

export const DSD_CHECK_IN_CLOSED = 'DsdCheckInClosed';

/** Every outcome code this screen can show — each has words in English and Tamil in web/app.js (DSD_WORDS). */
export const DSD_FEEDBACK_CODES = Object.freeze([
  'dsd_started', 'dsd_scanned', 'dsd_handed_back', 'dsd_closed', 'unknown_barcode', 'not_a_quantity', 'no_reason',
  'hand_back_more_than_scanned', 'delivery_note_not_signed', 'no_cash_at_the_door', 'dsd_not_started', 'dsd_already_closed', 'dsd_needs_vendor',
  // OB-521: a check-in refused to START on a withdrawn or too-old build (one already open is finished).
  'app_version_too_old',
] as const);
export type DsdFeedbackCode = (typeof DSD_FEEDBACK_CODES)[number];

export interface DsdSignal { readonly feedback: 'accept' | 'warn' | 'reject'; readonly code: DsdFeedbackCode; readonly detail: string; readonly sound: 'ok' | 'warn' | 'error'; readonly vibrateMs: number; readonly detailTa?: string }
const signal = (feedback: DsdSignal['feedback'], code: DsdFeedbackCode, detail: string): DsdSignal => ({
  feedback, code, detail, sound: feedback === 'accept' ? 'ok' : feedback === 'warn' ? 'warn' : 'error', vibrateMs: feedback === 'accept' ? 40 : feedback === 'warn' ? 120 : 300,
});

/**
 * A vendor's route sheet as the box served it (R3 D-11): what that van brings when it comes with no purchase order. It
 * names the place it is for; a check-in against it is made for that place, as head office judges it.
 */
export interface DsdRouteOnPhone { readonly routeId: string; readonly supplierId: string; readonly storeId?: string; readonly version?: number; readonly lines: readonly DsdExpectedLine[] }
export interface DsdDoorData {
  readonly workerId: string;
  readonly storeId: string;
  readonly barcodes?: readonly BarcodeResolution[];
  readonly packs?: readonly PackHierarchy[];
  readonly openDeliveries?: readonly { readonly poId: string; readonly number: string; readonly supplierId: string; readonly ordered: readonly { readonly productId: string; readonly quantityMinor: number; readonly unitCost: { readonly minor: number } }[] }[];
  /** Vendors' route sheets the box served (head office's, for this store); absent = none on this phone, and only orders are offered. */
  readonly dsdRoutes?: readonly DsdRouteOnPhone[];
}

interface Open {
  readonly checkInId: string; readonly supplierId: string; readonly storeId: string; readonly against: { kind: 'po'; poId: string } | { kind: 'route'; routeId: string };
  readonly driverName: string; readonly vehicleRef: string | null; readonly arrivedAt: string; readonly expected: readonly DsdExpectedLine[];
  scans: DsdScan[]; handBacks: DsdHandBack[]; closed: boolean;
}

export class DsdDoorSession {
  private current: Open | null = null;
  /** OB-521: set while this build may not START a new check-in — the words to refuse it with. */
  private newWorkBar: { readonly en: string; readonly ta: string } | null = null;
  /** OB-521: bar (or, with `null`, lift the bar on) starting a new check-in; one already open is always finished. */
  barNewWork(words: { readonly en: string; readonly ta: string } | null): void {
    this.newWorkBar = words;
  }
  constructor(private readonly data: DsdDoorData, private readonly outbox: SyncOutbox, private readonly now: () => string = () => new Date().toISOString()) {}

  /** What the phone holds to check against: the store's open orders, and any route sheets. */
  choices(): { readonly orders: readonly { poId: string; number: string; supplierId: string }[]; readonly routes: readonly { routeId: string; supplierId: string }[] } {
    return {
      orders: (this.data.openDeliveries ?? []).map((d) => ({ poId: d.poId, number: d.number, supplierId: d.supplierId })),
      routes: (this.data.dsdRoutes ?? []).map((r) => ({ routeId: r.routeId, supplierId: r.supplierId })),
    };
  }

  start(input: { readonly checkInId: string; readonly poId?: string; readonly routeId?: string; readonly supplierId?: string; readonly driverName: string; readonly vehicleRef?: string }): DsdSignal {
    if (this.current !== null && !this.current.closed) return signal('warn', 'dsd_started', `check-in ${this.current.checkInId} is already open — close it first`);
    if (this.newWorkBar !== null) return { ...signal('reject', 'app_version_too_old', this.newWorkBar.en), detailTa: this.newWorkBar.ta };
    const order = input.poId === undefined ? undefined : (this.data.openDeliveries ?? []).find((d) => d.poId === input.poId);
    const route = input.routeId === undefined ? undefined : (this.data.dsdRoutes ?? []).find((r) => r.routeId === input.routeId);
    const supplierId = order?.supplierId ?? route?.supplierId ?? input.supplierId;
    if (supplierId === undefined || supplierId.trim() === '' || (input.poId === undefined) === (input.routeId === undefined)) {
      return signal('reject', 'dsd_needs_vendor', 'choose the delivery: its purchase order, or the vendor and its route');
    }
    if (input.driverName.trim() === '') return signal('reject', 'dsd_needs_vendor', 'the driver\'s name is needed for the delivery note');
    const expected: DsdExpectedLine[] = order !== undefined
      ? order.ordered.map((o) => ({ productId: o.productId, expectedMinor: o.quantityMinor, unitCostMinor: o.unitCost.minor }))
      : [...(route?.lines ?? [])];
    this.current = {
      checkInId: input.checkInId, supplierId, storeId: route?.storeId ?? this.data.storeId, against: input.poId !== undefined ? { kind: 'po', poId: input.poId } : { kind: 'route', routeId: input.routeId! },
      driverName: input.driverName.trim(), vehicleRef: input.vehicleRef?.trim() || null, arrivedAt: this.now(), expected, scans: [], handBacks: [], closed: false,
    };
    return signal('accept', 'dsd_started', `checking in ${supplierId} against ${input.poId ?? input.routeId}`);
  }

  /** A barcode off the van. A case barcode counts as its case size (the pack hierarchy the box served). */
  scan(scanId: string, barcode: string): DsdSignal {
    const c = this.current;
    if (c === null) return signal('reject', 'dsd_not_started', 'start the check-in first');
    if (c.closed) return signal('reject', 'dsd_already_closed', `check-in ${c.checkInId} is closed`);
    const hit = (this.data.barcodes ?? []).find((b) => b.barcode === barcode);
    if (hit === undefined) return signal('reject', 'unknown_barcode', `${barcode} is not a product this phone knows — hand it back or ask the office`);
    const level = (this.data.packs ?? []).find((p) => p.productId === hit.productId)?.levels.find((l) => l.level === hit.level);
    const qty = level === undefined ? 1 : Math.max(1, (level as { containsMinor?: number }).containsMinor ?? 1);
    c.scans.push({ scanId, productId: hit.productId, quantityMinor: qty, at: this.now() });
    return signal('accept', 'dsd_scanned', `${hit.productId} +${qty}`);
  }

  handBack(handBackId: string, productId: string, quantityMinor: number, reason: DsdHandBackReason): DsdSignal {
    const c = this.current;
    if (c === null) return signal('reject', 'dsd_not_started', 'start the check-in first');
    if (c.closed) return signal('reject', 'dsd_already_closed', `check-in ${c.checkInId} is closed`);
    const hb: DsdHandBack = { handBackId, productId, quantityMinor, reason, note: null, at: this.now() };
    try { reconcileDsd({ against: c.against.kind, expected: c.expected, scans: c.scans, handBacks: [...c.handBacks, hb] }); } catch (e) {
      if (e instanceof DsdRefusedError) return signal('reject', e.code as DsdFeedbackCode, e.message);
      throw e;
    }
    c.handBacks.push(hb);
    return signal('accept', 'dsd_handed_back', `${quantityMinor} × ${productId} handed back (${reason}) — on the delivery's debit note`);
  }

  /** The live view: what was expected, scanned, handed back and kept, and every difference by name. */
  view(): (DsdReconciliation & { readonly checkInId: string; readonly supplierId: string; readonly against: string; readonly closed: boolean }) | null {
    const c = this.current;
    if (c === null) return null;
    const r = reconcileDsd({ against: c.against.kind, expected: c.expected, scans: c.scans, handBacks: c.handBacks });
    return { ...r, checkInId: c.checkInId, supplierId: c.supplierId, against: c.against.kind === 'po' ? c.against.poId : c.against.routeId, closed: c.closed };
  }

  /** Close with the signed delivery note. Queues ONE record; refuses an unsigned note by name. No cash field exists. */
  close(note: { readonly noteRef: string; readonly driverSignedName: string }): DsdSignal {
    const c = this.current;
    if (c === null) return signal('reject', 'dsd_not_started', 'start the check-in first');
    if (c.closed) return signal('warn', 'dsd_already_closed', `check-in ${c.checkInId} was already closed`);
    const at = this.now();
    let reconciliation: DsdReconciliation;
    try {
      reconciliation = reconcileDsd({ against: c.against.kind, expected: c.expected, scans: c.scans, handBacks: c.handBacks });
      signDeliveryNote({ body: { deliveryNote: note }, reconciliation, receiverId: this.data.workerId, at });
    } catch (e) {
      if (e instanceof DsdRefusedError) return signal('reject', e.code as DsdFeedbackCode, e.message);
      throw e;
    }
    this.outbox.enqueue(makeEvent({
      id: `dsd-${c.checkInId}`, type: DSD_CHECK_IN_CLOSED, occurredAt: at, idempotencyKey: `dsd:${c.checkInId}`, source: 'warehouse-handheld',
      payload: {
        checkInId: c.checkInId, supplierId: c.supplierId, storeId: c.storeId,
        ...(c.against.kind === 'po' ? { poId: c.against.poId } : { routeId: c.against.routeId }),
        driverName: c.driverName, ...(c.vehicleRef === null ? {} : { vehicleRef: c.vehicleRef }), arrivedAt: c.arrivedAt,
        receivedBy: this.data.workerId, scans: c.scans, handBacks: c.handBacks,
        deliveryNote: { noteRef: note.noteRef.trim(), driverSignedName: note.driverSignedName.trim() }, at,
      },
    }));
    c.closed = true;
    const kept = reconciliation.lines.reduce((n, l) => n + l.keptMinor, 0);
    const back = reconciliation.handedBack.reduce((n, h) => n + h.quantityMinor, 0);
    return signal('accept', 'dsd_closed', `delivery note ${note.noteRef.trim()} signed by ${note.driverSignedName.trim()}: ${kept} kept, ${back} handed back, ${reconciliation.discrepancies.length} differences — no cash, paid later as a supplier bill`);
  }
}

export { DSD_HAND_BACK_REASONS };
