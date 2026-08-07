// Browser entry — the bundler's input for the picker handheld (`pnpm build:picker`). It wires a
// real `PickSession` and attaches it as `window.pickSession`, which `web/app.js` binds to.
//
// ── What runs here, and where ───────────────────────────────────────────────
//
// A cheap Android handheld in the aisles, with the shop's wifi dropping between the freezers and
// the back wall. So the wave is **cached** and everything the picker does is local (§31 picking
// row): no call blocks a scan, and the queue drains later.
//
// The queue is written to the device, not held in memory. Until this existed a wave picked
// correctly and entirely offline lived only until the handheld was closed — the session's own
// docstring said the scans "queue for sync afterwards" and nothing queued anywhere.
//
// ── PII stays off the device ────────────────────────────────────────────────
//
// A pick line carries an order reference and an area of the shop. Never a customer name, never a
// phone number, never an address. A handheld gets left on a shelf and walks out of the building in
// somebody's pocket; what is on it should be worth nothing to whoever finds it.

import { openDeviceOutbox, guardedStore, type DeviceOutbox } from '../../../packages/sync/src/device-outbox';
import { PickSession, type PickLineInput } from './pick-session';

/** The wave the handheld was given. Absent means there is no assigned work to show. */
export interface PickerData {
  readonly waveId?: string;
  readonly pickerId?: string;
  readonly lines?: readonly PickLineInput[];
  /**
   * How the list came to be in the order it is in (M04-FR-02).
   *
   * Carried rather than assumed, exactly as the driver is told whether a dispatcher wrote their
   * route by hand. A picker who believes a list is in shelf order when it is not walks it trusting
   * a sequence nobody applied, and the wasted minutes look like the shop being badly laid out.
   */
  readonly orderedBy?: string;
  /** Products the shop has no shelf address for. Named, because each is a walk back. */
  readonly unmapped?: readonly string[];
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface PickerWindow {
  pickSession?: PickSession;
  pickerData?: PickerData;
  pickerOutbox?: DeviceOutbox;
  /** Anything that went wrong with the device's own storage, for the view to show (P-08). */
  pickerStorageProblem?: string | null;
}

/**
 * Build the picker's session from the wave the handheld holds.
 *
 * Returns `null` when there is no wave. That is a real state — a picker at the start of a shift
 * with nothing assigned — and the screen says so rather than showing an empty list that looks like
 * a wave already finished.
 */
export function bootPicker(
  data: PickerData | undefined,
  outbox: DeviceOutbox,
  now: () => string = () => new Date().toISOString(),
): PickSession | null {
  const lines = data?.lines;
  if (data?.waveId === undefined || lines === undefined || lines.length === 0) return null;
  return new PickSession(data.waveId, lines, outbox, { now });
}

// In the browser `globalThis.window` IS the window, so this needs no DOM types.
const browserWindow = (globalThis as { window?: PickerWindow }).window;
if (browserWindow !== undefined) {
  const storage = (globalThis as {
    localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  }).localStorage;
  browserWindow.pickerStorageProblem = null;
  const wave = browserWindow.pickerData?.waveId ?? 'unassigned';
  const store = guardedStore(`sre.picker.outbox.${wave}`, storage, (why) => {
    // Recorded where the view can read it, never swallowed. A picker whose scans are not being
    // saved needs to know before the end of the wave, not after it.
    browserWindow.pickerStorageProblem = why;
  });
  const outbox = openDeviceOutbox(store, (why) => { browserWindow.pickerStorageProblem = why; });
  browserWindow.pickerOutbox = outbox;
  const session = bootPicker(browserWindow.pickerData, outbox);
  if (session !== null) browserWindow.pickSession = session;
}
