// An outbox that survives the device it is running on (P-01, §31 picking and delivery rows).
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// A handheld in the aisles and a phone in a moving vehicle are not the lane. The lane has a small
// process beside it that can call `fsync` (ADR-0004); a picker's terminal is a cheap Android device
// that gets dropped, runs out of battery, and is closed by the operating system to free memory in
// the middle of a shift.
//
// Until this existed, a picker's scans and a driver's proof and cash lived only in a JavaScript
// object. **The two session docstrings both said the work "queues for sync afterwards" and nothing
// queued anywhere at all** — the ninth instance in this project of a control that was described,
// believed, and absent.
//
// For the picker that would have lost a wave. For the driver it is worse and it is the reason this
// is a package rather than a helper: **COD collected is cash in somebody's pocket.** A phone that
// dies after four deliveries and remembers none of them leaves ₹6,000 with a driver and nothing
// anywhere saying it was ever collected. There is no reconciliation that recovers from that,
// because there is nothing to reconcile against.
//
// ── What it is not ──────────────────────────────────────────────────────────
//
// It is not `fsync`. A browser cannot force a write to physical storage and this does not pretend
// to; the guarantee is "survives the app closing and the device restarting", not "survives the
// power being cut mid-write". Where the difference matters — a sale — the work goes to the lane's
// own disk instead (hard rule #1). Saying which of the two you have is the point.

import type { OutboxItem } from './outbox';
import { SyncOutbox } from './outbox';

/** The device's own storage, as a string in and a string out. Injectable, so it can be tested. */
export interface DeviceStore {
  read(): string | null;
  write(value: string): void;
}

/** A store that keeps nothing — for a device that offers no storage at all. */
export function noDeviceStore(): DeviceStore {
  let held: string | null = null;
  return { read: () => held, write: (v) => { held = v; } };
}

/**
 * Wrap a device's storage so a failure is **reported, never thrown and never silent**.
 *
 * Three things go wrong on real devices and all three are handled the same way: private-browsing
 * modes throw on write, a full device throws on write, and a corrupt value must not stop the app
 * opening. A picker who cannot start their shift because of a bad byte is worse off than one whose
 * queue is empty — but a picker who does not know their scans are not being saved is worse off
 * than either, which is why nothing here fails quietly.
 */
export function guardedStore(
  key: string,
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | undefined,
  onProblem: (why: string) => void,
): DeviceStore {
  if (storage === undefined) {
    onProblem('this device offers no storage, so work done offline will not survive a restart');
    return noDeviceStore();
  }
  return {
    read: () => {
      try {
        return storage.getItem(key);
      } catch {
        onProblem('the saved work could not be read and has been left untouched');
        return null;
      }
    },
    write: (value) => {
      try {
        storage.setItem(key, value);
      } catch {
        onProblem('this could not be saved on the device — do not close the app before it syncs');
      }
    },
  };
}

/**
 * Read an outbox back from the device.
 *
 * A value that cannot be parsed, or that is not a list, is treated as **unreadable rather than
 * empty** — and left exactly where it is. Deleting it is the one action that cannot be undone, and
 * an unreadable queue is still evidence that work was done (hard rule #6 in spirit).
 */
export function restoreItems(store: DeviceStore, onProblem: (why: string) => void): OutboxItem[] {
  const raw = store.read();
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      onProblem('the saved work could not be read and has been left untouched');
      return [];
    }
    return parsed as OutboxItem[];
  } catch {
    onProblem('the saved work could not be read and has been left untouched');
    return [];
  }
}

/**
 * A `SyncOutbox` that writes itself to the device after every change.
 *
 * It subclasses rather than wraps so that **every** path that mutates the queue is covered —
 * enqueue, acknowledge, failure and dead-letter. A decorator that forwarded only `enqueue` would
 * persist the work and lose the fact that it had already been sent, and the next boot would send
 * all of it again.
 */
export class DeviceOutbox<TType extends string = string, TPayload = unknown>
  extends SyncOutbox<TType, TPayload>
{
  constructor(
    private readonly store: DeviceStore,
    restored: readonly OutboxItem<TType, TPayload>[] = [],
  ) {
    super(restored);
  }

  private save(): void {
    this.store.write(JSON.stringify(this.all()));
  }

  override enqueue(event: Parameters<SyncOutbox<TType, TPayload>['enqueue']>[0]): OutboxItem<TType, TPayload> {
    const item = super.enqueue(event);
    this.save();
    return item;
  }

  override acknowledge(key: string): void {
    super.acknowledge(key);
    this.save();
  }

  override recordFailure(key: string): number {
    const attempts = super.recordFailure(key);
    this.save();
    return attempts;
  }

  override deadLetter(key: string, reason: string): void {
    super.deadLetter(key, reason);
    this.save();
  }
}

/** Open a device-backed outbox: restore whatever is there, then keep writing to it. */
export function openDeviceOutbox<TType extends string = string, TPayload = unknown>(
  store: DeviceStore,
  onProblem: (why: string) => void,
): DeviceOutbox<TType, TPayload> {
  const restored = restoreItems(store, onProblem) as OutboxItem<TType, TPayload>[];
  return new DeviceOutbox<TType, TPayload>(store, restored);
}
