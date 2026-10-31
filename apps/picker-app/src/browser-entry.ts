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

import { attachShopDay } from '../../../packages/calendar/src/shop-day'; // OB-607
import { openDeviceOutbox, guardedStore, type DeviceOutbox } from '../../../packages/sync/src/device-outbox';
import { drainToBox, boxStatus } from '../../../packages/sync/src/device-drain';
import { pageStamping, type SignInClock } from '../../../packages/sync/src/sign-in-stamp';
import { PickSession, type PickLineInput } from './pick-session';
import { openNewWorkGate, bindNewWorkGate, APP_BUILD_VERSION, type NewWorkGate } from '../../../packages/platform-admin/src/client-version'; // OB-521 (R8-A) · OB-537 (R9)

import { mountDemoBanner, type BannerDocument } from '../../../packages/ui/src/demo-banner';

// The practice-data strip ("TRIAL COPY · PRACTICE DATA"), exactly as the ERP shell mounts it. `PILOT_DEMO_BANNER` is a
// build-time constant baked in by esbuild (`scripts/build-app.mjs`): '1' in the hosted-demo build, empty
// in production. `typeof` guards the unbundled case (identifier absent) and a non-browser import.
declare const PILOT_DEMO_BANNER: string;
const demoBannerDoc = (globalThis as { document?: unknown }).document;
if (demoBannerDoc !== undefined && demoBannerDoc !== null) {
  mountDemoBanner(demoBannerDoc as BannerDocument, typeof PILOT_DEMO_BANNER === 'string' ? PILOT_DEMO_BANNER : '');
}

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
  /** OB-521: the signed pack's app version policy, as the store computer served it (`null` = the pack carries none). */
  readonly appVersionPolicy?: unknown;
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface PickerWindow {
  pickSession?: PickSession;
  pickerData?: PickerData;
  pickerOutbox?: DeviceOutbox;
  /** Anything that went wrong with the device's own storage, for the view to show (P-08). */
  pickerStorageProblem?: string | null;
  /** The store computer's write base the box injected: `''` on the device socket (same origin), absent off it. */
  laneWriteBase?: string;
  pickerRelay?: PickerRelay;
  /** OB-521: this build's new-work gate — the screen applies each policy the store computer reports. */
  pickerVersion?: NewWorkGate;
}

export interface PickerRelay {
  /**
   * One pass of the shared device → store-computer leg (SP-3c-i): hand the queued outcomes and the pack to the box
   * (accepted or duplicate → handed; refused → a visible refusal; link down → kept, nothing lost), then ask the box where
   * the items it holds have got to and fold that into the session's sent-work list.
   */
  syncNow(): Promise<{ readonly handed: number; readonly refused: number; readonly failed: number; readonly offline: boolean; readonly notAllowed?: string }>;
}

/**
 * The picker handheld's leg of the shared sync path (SP-3c-i · F11's picker half). The handheld is served BY the box's
 * device socket, so the base is the page's own origin (`''`); the device's cookie rides on every call. `undefined` when
 * the shell was not served by a box (a file, a test server): the queue still fills and survives, and the badge says so.
 */
export function openPickerRelay(
  laneWriteBase: string | undefined,
  session: PickSession,
  outbox: DeviceOutbox,
  /** The sign-in's clock (OB-180): each hand-over reply carries the box's time, and the clock reckons from it (L1). */
  clock?: SignInClock,
): PickerRelay | undefined {
  if (laneWriteBase === undefined) return undefined;
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return undefined;
  return {
    syncNow: async () => {
      const result = await drainToBox({ outbox, boxBase: laneWriteBase, source: 'picker', fetch: fetchFn, ...(clock === undefined ? {} : { onBoxTime: (box, phone) => clock.learn(box, phone) }) });
      const statuses = await boxStatus({ boxBase: laneWriteBase, keys: session.handedKeys(), fetch: fetchFn });
      if (statuses !== undefined) session.noteBoxStatus(statuses);
      return { handed: result.handed, refused: result.refused, failed: result.failed, offline: result.offline, ...(result.notAllowed === undefined ? {} : { notAllowed: result.notAllowed }) };
    },
  };
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
  // The picker the wave names travels on every outcome, so head office can re-verify the person — never invented here.
  return new PickSession(data.waveId, lines, outbox, { now, ...(data.pickerId === undefined ? {} : { pickerId: data.pickerId }) });
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
  // OB-180: every record this phone queues is stamped with the sign-in it is made under (the box injected it), on a
  // clock that only moves forward and is kept beside the queue (verifier hh NEW-1); the end of the sign-in found by a
  // record locks the screen at once (L2).
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  const stamping = pageStamping(browserWindow, () => new Date().toISOString(), {
    ...(storage === undefined ? {} : { storage }),
    ...(perf === undefined ? {} : { perfNow: () => perf.now() }),
  });
  // OB-537 (Round 9): every record this handheld queues carries the app build that made it.
  const outbox = openDeviceOutbox(store, (why) => { browserWindow.pickerStorageProblem = why; }, stamping?.stamp, APP_BUILD_VERSION);
  browserWindow.pickerOutbox = outbox;
  const session = bootPicker(browserWindow.pickerData, outbox);
  if (session !== null) {
    browserWindow.pickSession = session;
    // The relay to the store computer — present only when the box served this page (it injects `laneWriteBase`).
    const relay = openPickerRelay(browserWindow.laneWriteBase, session, outbox, stamping?.clock);
    if (relay !== undefined) browserWindow.pickerRelay = relay;
  }
  // OB-521: a withdrawn or too-old build finishes the wave it started and starts no new one — by the store computer's
  // signed pack (served with the wave, then each badge refresh), kept on this device for a reload with no signal.
  browserWindow.pickerVersion = bindNewWorkGate(openNewWorkGate({
    client: 'picker', ...(storage === undefined ? {} : { storage }), key: 'sre.picker.app-version-policy',
    ...(browserWindow.pickerData !== undefined && 'appVersionPolicy' in browserWindow.pickerData ? { served: browserWindow.pickerData.appVersionPolicy } : {}),
  }), [session]);
}

// OB-607: this page's shop's day as `window.sreShopDay` — the dates AND times of day it shows are the shop's clock, in the
// zone the store computer served from its signed pack (`window.shopTimeZone`; no network call), never this device's.
attachShopDay((globalThis as { window?: unknown }).window);
