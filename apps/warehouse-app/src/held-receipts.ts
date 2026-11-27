// D-031 (pending list 27 Nov 2026, item 3): the receiving scans a warehouse handheld HOLDS until the person presses
// "Delivery complete — send the receipt" (P-01 · P-08 · M07-FR-01 · hard rules #2 #6 #10).
//
// Before, every receiving scan was its own record on the phone's queue: it reached the store computer at once and head
// office put the goods in its stock on arrival, before the receipt was sent. Now a scan waits HERE, on the phone, and the
// whole receipt goes as ONE record when the person sends it (`WarehouseSession.completeReceiving`).
//
// What this keeps, and why:
//   • the phone's own storage (the same storage the device queue uses), written after every change — so held scans
//     survive a reload, the phone sleeping and the browser being closed. Nothing scanned may be lost;
//   • a scan the person REMOVES before sending is never dropped silently: it moves to the receipt's removed list with who
//     removed it and when, and that list travels inside the receipt (head office keeps it on the goods receipt);
//   • a saved value that cannot be read is left exactly as it is and nothing new is written over it (hard rule #6 in
//     spirit): the phone refuses to hold a new scan and says so, so a person looks before anything is overwritten.
//
// Keyed on the STORE, not on the day's assignment: a new assignment next morning must not hide yesterday's held scans.

import type { DeviceStore } from '../../../packages/sync/src/device-outbox';
import type { SignInStamp } from '../../../packages/sync/src/sign-in-stamp';

/** One receiving scan as the handheld made it (the shape an old phone queued as `ReceivingScanned`). */
export interface HeldScan {
  readonly commandId: string;
  readonly grnId: string;
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly uom: string;
  readonly source: string;
  readonly poId: string | null;
  readonly state: string;
  readonly expiry: string | null;
  readonly receivedBy: string;
  readonly storeId: string;
  readonly at: string;
  readonly temperatureC?: number;
  readonly manufacturedOn?: string;
  readonly mrpMinor?: number;
  readonly qcFailed?: true;
  /**
   * OB-180: the sign-in the scan was made under, as the phone stamps every record it makes — kept on the phone with the scan
   * (absent when the sign-in had already ended: the scan is kept, never lost, but never stamped as that person's).
   */
  readonly stamp?: SignInStamp;
}

/** A held scan the person took off the receipt before sending — kept, with who and when. */
export interface RemovedScan extends HeldScan {
  readonly removedBy: string;
  readonly removedAt: string;
}

interface HeldReceipt {
  readonly scans: HeldScan[];
  readonly removed: RemovedScan[];
}
interface Saved { readonly version: 1; readonly receipts: Record<string, HeldReceipt> }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The held receipts on this phone. Synchronous: every scan is decided on the phone with no network (P-01). */
export class HeldReceipts {
  private receipts: Record<string, HeldReceipt> = {};
  /** True when the saved value could not be read: nothing is written over it. */
  readonly unreadable: boolean;

  constructor(private readonly store: DeviceStore, onProblem: (why: string) => void = () => {}) {
    const raw = store.read();
    let unreadable = false;
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isObj(parsed) && isObj(parsed['receipts'])) {
          for (const [grnId, r] of Object.entries(parsed['receipts'])) {
            if (isObj(r) && Array.isArray(r['scans']) && Array.isArray(r['removed'])) {
              this.receipts[grnId] = { scans: [...r['scans']] as HeldScan[], removed: [...r['removed']] as RemovedScan[] };
            } else unreadable = true;
          }
        } else unreadable = true;
      } catch {
        unreadable = true;
      }
    }
    this.unreadable = unreadable;
    if (unreadable) onProblem('the scans held on this phone could not be read and have been left untouched — nothing new is held until a person looks');
  }

  private save(): void {
    const saved: Saved = { version: 1, receipts: this.receipts };
    this.store.write(JSON.stringify(saved));
  }

  /** Hold one scan. False (nothing written) when the saved value could not be read. */
  hold(scan: HeldScan): boolean {
    if (this.unreadable) return false;
    const r = this.receipts[scan.grnId] ?? { scans: [], removed: [] };
    if (r.scans.some((s) => s.commandId === scan.commandId)) return true;
    this.receipts[scan.grnId] = { scans: [...r.scans, scan], removed: r.removed };
    this.save();
    return true;
  }

  scansOf(grnId: string): readonly HeldScan[] {
    return this.receipts[grnId]?.scans ?? [];
  }

  removedOf(grnId: string): readonly RemovedScan[] {
    return this.receipts[grnId]?.removed ?? [];
  }

  /** The deliveries with anything held (scans or removals) on this phone. */
  grnIds(): readonly string[] {
    return Object.keys(this.receipts);
  }

  /** Take one held scan off the receipt, keeping it on the removed list (who, when). Undefined when it is not held. */
  remove(grnId: string, commandId: string, removedBy: string, removedAt: string): RemovedScan | undefined {
    if (this.unreadable) return undefined;
    const r = this.receipts[grnId];
    const scan = r?.scans.find((s) => s.commandId === commandId);
    if (r === undefined || scan === undefined) return undefined;
    const removed: RemovedScan = { ...scan, removedBy, removedAt };
    this.receipts[grnId] = { scans: r.scans.filter((s) => s.commandId !== commandId), removed: [...r.removed, removed] };
    this.save();
    return removed;
  }

  /** The receipt is on the phone's queue (it carries every scan and removal): nothing for it is held any more. */
  clear(grnId: string): void {
    if (this.unreadable || this.receipts[grnId] === undefined) return;
    const { [grnId]: _sent, ...rest } = this.receipts;
    void _sent;
    this.receipts = rest;
    this.save();
  }
}
