// THE TILL KEEPS SAYING HOW ITS DEVICES ARE (D04-FR-05 · M12-FR-04 · M35-FR-03 · P-08 · P-01 · hard rule #1).
//
// Head office judges each till's device report by the till's OWN report time: a report older than the shop's sync-lag
// warning threshold (§32 — 15 minutes by default) is STALE and reads `unknown` (services/platform/src/box-health.ts).
// A till only reported when its device adapter spoke (at sign-in, or on a change), so a healthy, quiet till went stale.
//
// So, while a cashier is signed in and the till is running, the till re-sends its LAST KNOWN device states to its store
// computer every DEVICE_HEARTBEAT_INTERVAL_MS (5 minutes — a third of the 15-minute default, so one lost re-send still
// leaves the till fresh), and at once whenever a device's state changes. With nobody signed in nothing is sent: an
// unattended till legitimately goes stale, and the store computer tells head office that nobody is signed in there.
//
// Never on the sale path (P-01 · hard rule #1): a re-send is fire-and-forget — nothing awaits it, it never throws, and it
// is never started while a sale or refund is being written to the store computer's disk (it waits until that write has
// answered, then goes). Only one re-send is ever in flight; a slow box never piles them up.
//
// What it cannot know: the device adapter is hardware-side (external). The till re-sends what the adapter LAST said; a
// device that dies without the adapter noticing still reads as it last did — that is the adapter's job to report.
// Round 15 (verifier LOW · P-08): when the adapter says WHEN it last observed the devices (`observedAt`), that time travels
// with every re-send (`adapterObservedAt`), and head office judges the lane's freshness by it — so an adapter that has hung
// reads STALE however faithfully the till keeps re-sending its last answer. An adapter that gives no time is judged, as
// before, by the till's report time.

export interface DeviceStatus {
  readonly kind: string;
  readonly state: string;
  readonly detail?: string;
}

/** The re-send cadence: every 5 minutes while signed in — well inside the 15-minute stale threshold (§32 default). */
export const DEVICE_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

export interface DeviceHeartbeatDeps {
  /**
   * Post the devices to this till's store computer (`/lane/peripherals`), with the adapter's own last-observed time when it
   * gave one. May reject; the heartbeat swallows it.
   */
  readonly send: (devices: readonly DeviceStatus[], adapterObservedAt?: string) => Promise<unknown>;
  /** Is a cashier signed in at this till now? */
  readonly signedIn: () => boolean;
  /** Is a sale or refund being written to the store computer right now? Nothing is sent while it is. */
  readonly committing: () => boolean;
  /** Run `fn` every `ms`; answers a cancel. Default: `setInterval` (unref'd, so it never holds a process open). */
  readonly every?: (ms: number, fn: () => void) => () => void;
  /** Run `fn` soon, off the current call stack. Default: `setTimeout(fn, 0)`. */
  readonly soon?: (fn: () => void) => void;
  readonly intervalMs?: number;
  /**
   * Round 15: the device adapter's OWN clock — when it last observed the devices — asked at each re-send, when the adapter
   * offers one (`window.sreDevices.lastObservedAt()`). Absent, or answering nothing readable → the time it gave with its
   * last answer, if any.
   */
  readonly adapterObservedAt?: () => unknown;
}

export interface DeviceHeartbeat {
  /**
   * The adapter says how the devices are now (and, when it can, WHEN it observed them): kept as the last known, and sent at
   * once if anything changed.
   */
  readonly update: (devices: readonly DeviceStatus[], observedAt?: string) => void;
  /** Keep these as the last known WITHOUT sending (the caller has just sent them itself). */
  readonly remember: (devices: readonly DeviceStatus[], observedAt?: string) => void;
  /** A cashier signed in: start the cadence. */
  readonly start: () => void;
  /** The cashier signed out (or the till is closing): stop the cadence; nothing more is sent until the next sign-in. */
  readonly stop: () => void;
  /** A sale or refund write has answered: send anything that waited for it. */
  readonly commitEnded: () => void;
  /** One re-send now, if allowed (signed in, not committing, nothing in flight, something known). True when it sent. */
  readonly tick: () => Promise<boolean>;
  readonly running: () => boolean;
  readonly lastKnown: () => readonly DeviceStatus[] | undefined;
  /** When the adapter last said it observed the devices; undefined when it never gave a time. */
  readonly lastObservedAt: () => string | undefined;
}

/** An adapter's observation time, when it is a readable instant; anything else is ignored (never invented). */
const instant = (v: unknown): string | undefined => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : undefined);

const keyOf = (devices: readonly DeviceStatus[] | undefined): string =>
  devices === undefined ? '' : JSON.stringify(devices.map((d) => [d.kind, d.state, d.detail ?? '']));

const copy = (devices: readonly DeviceStatus[]): readonly DeviceStatus[] =>
  devices.map((d) => ({ kind: d.kind, state: d.state, ...(d.detail === undefined ? {} : { detail: d.detail }) }));

const defaultEvery = (ms: number, fn: () => void): (() => void) => {
  const handle = setInterval(fn, ms) as unknown as { unref?: () => void };
  if (typeof handle.unref === 'function') handle.unref();
  return () => { clearInterval(handle as unknown as ReturnType<typeof setInterval>); };
};
const defaultSoon = (fn: () => void): void => { setTimeout(fn, 0); };

export function createDeviceHeartbeat(deps: DeviceHeartbeatDeps): DeviceHeartbeat {
  const every = deps.every ?? defaultEvery;
  const soon = deps.soon ?? defaultSoon;
  const intervalMs = deps.intervalMs ?? DEVICE_HEARTBEAT_INTERVAL_MS;
  let last: readonly DeviceStatus[] | undefined;
  let observedAt: string | undefined;
  let cancel: (() => void) | undefined;
  let inFlight = false;
  /** A send was due while a sale was being written (or another send was in flight): owed once that ends. */
  let owed = false;

  const tick = async (): Promise<boolean> => {
    if (cancel === undefined || !deps.signedIn() || last === undefined) return false;
    if (deps.committing() || inFlight) { owed = true; return false; }
    owed = false;
    inFlight = true;
    const devices = last;
    const at = instant(deps.adapterObservedAt?.()) ?? observedAt;
    try {
      await (at === undefined ? deps.send(devices) : deps.send(devices, at));
    } catch {
      /* the box could not be reached: the next tick tries again; the manager sees the lane go stale, never a cashier error */
    } finally {
      inFlight = false;
    }
    if (owed && keyOf(last) !== keyOf(devices)) soon(() => { void tick(); }); // a change arrived mid-send: send it too
    else owed = false;
    return true;
  };

  return {
    update: (devices, at) => {
      const changed = keyOf(devices) !== keyOf(last);
      last = copy(devices);
      observedAt = instant(at);
      if (changed) soon(() => { void tick(); });
    },
    remember: (devices, at) => { last = copy(devices); observedAt = instant(at); },
    start: () => {
      if (cancel !== undefined) return;
      cancel = every(intervalMs, () => { void tick(); });
    },
    stop: () => {
      cancel?.();
      cancel = undefined;
      owed = false;
    },
    commitEnded: () => {
      if (owed && !deps.committing()) soon(() => { void tick(); });
    },
    tick,
    running: () => cancel !== undefined,
    lastKnown: () => last,
    lastObservedAt: () => instant(deps.adapterObservedAt?.()) ?? observedAt,
  };
}
