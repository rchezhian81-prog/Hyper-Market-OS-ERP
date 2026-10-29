// Browser entry — the bundler's input for the driver's phone (`pnpm build:delivery`). It wires a
// real `RouteSession` and attaches it as `window.routeSession`, which `web/app.js` binds to.
//
// ── What runs here, and where ───────────────────────────────────────────────
//
// A low-spec Android phone in a moving vehicle, on a network that comes and goes between streets.
// So the route is **cached** and everything the driver does is local (§31 delivery row): proof and
// COD are captured on the device and the queue drains when there is a signal.
//
// ── Why the queue is written to the device and not held in memory ───────────
//
// Because the driver is carrying cash. A phone that dies after four stops and remembers none of
// them leaves ₹6,000 with somebody and no record anywhere that it was ever collected. The
// settlement then has nothing to reconcile against — which is unfair to an honest driver and
// invisible for a dishonest one. This is the single most important line in this file.
//
// ── PII and location, minimised ─────────────────────────────────────────────
//
// A stop carries an order reference and a coarse area label. No customer name, no phone number, no
// full address record. The proof photograph (OB-294, owner, 23 Oct 2026: a real capture through the
// camera, kept as a document) is one small image per hand-over, queued as its own record with its
// fingerprint; the phone's location is read only at a hand-over and head office keeps only the verdict.

import { attachShopDay } from '../../../packages/calendar/src/shop-day'; // OB-607
import { openDeviceOutbox, guardedStore, type DeviceOutbox } from '../../../packages/sync/src/device-outbox';
import { drainToBox, boxStatus } from '../../../packages/sync/src/device-drain';
import { pageStamping, type SignInClock } from '../../../packages/sync/src/sign-in-stamp';
import { RouteSession, type CollectionInput, type ContributionRule, type StopInput } from './route-session';
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

/** The route the phone was given. Absent means there is no assigned work to show. */
export interface DriverData {
  readonly routeId?: string;
  readonly driverId?: string;
  readonly stops?: readonly StopInput[];
  /** WF-16 (driver): online returns booked for collection on this route, with their booked lines. */
  readonly collections?: readonly CollectionInput[];
  /** The tenant's contribution stop rule (D09). Choose-able, never hard-coded. */
  readonly contributionRule?: ContributionRule;
  /** |over/short| at or above which a cash handover needs the cash office. Per-tenant. */
  readonly handoverToleranceMinor?: number;
  /** OB-521: the signed pack's app version policy, as the store computer served it (`null` = the pack carries none). */
  readonly appVersionPolicy?: unknown;
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface DriverWindow {
  /** OB-521: this build's new-work gate — the screen applies each policy the store computer reports. */
  driverVersion?: NewWorkGate;
  routeSession?: RouteSession;
  driverData?: DriverData;
  driverOutbox?: DeviceOutbox;
  /** The tolerance the screen applies to a handover variance, from the tenant's config. */
  driverHandoverToleranceMinor?: number;
  /** Anything that went wrong with the device's own storage, for the view to show (P-08). */
  driverStorageProblem?: string | null;
  /** The store computer's write base the box injected: `''` on the device socket (same origin), absent off it. */
  laneWriteBase?: string;
  driverRelay?: DriverRelay;
}

export interface DriverRelay {
  /**
   * One pass of the shared device → store-computer leg (SP-3c-ii): hand the queued stop outcomes, the settlement and the
   * handover to the box (accepted or duplicate → handed; refused → a visible refusal; link down → kept, nothing lost — the
   * cash record is the point), then ask the box where the items it holds have got to and fold that into the sent-work list.
   */
  syncNow(): Promise<{ readonly handed: number; readonly refused: number; readonly failed: number; readonly offline: boolean }>;
}

/**
 * The driver's leg of the shared sync path (SP-3c-ii · F11's driver half). The phone is served BY the box's device socket
 * when it is on the shop wifi, so the base is the page's own origin (`''`); the device's cookie rides on every call.
 * `undefined` when the shell was not served by a box: the queue still fills and survives, and the badge says so.
 */
export function openDriverRelay(
  laneWriteBase: string | undefined,
  session: RouteSession,
  outbox: DeviceOutbox,
  /** The sign-in's clock (OB-180): each hand-over reply carries the box's time, and the clock reckons from it (L1). */
  clock?: SignInClock,
): DriverRelay | undefined {
  if (laneWriteBase === undefined) return undefined;
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return undefined;
  return {
    syncNow: async () => {
      // Three at a time: a proof photo is up to 60,000 characters, and the box takes a device batch up to 256 KB.
      const result = await drainToBox({ outbox, boxBase: laneWriteBase, source: 'driver', fetch: fetchFn, limit: 3, ...(clock === undefined ? {} : { onBoxTime: (box, phone) => clock.learn(box, phone) }) });
      const statuses = await boxStatus({ boxBase: laneWriteBase, keys: session.handedKeys(), fetch: fetchFn });
      if (statuses !== undefined) session.noteBoxStatus(statuses);
      return { handed: result.handed, refused: result.refused, failed: result.failed, offline: result.offline };
    },
  };
}

/**
 * Build the driver's session from the route the phone holds.
 *
 * Returns `null` when there is no route. A driver at the start of a shift with nothing assigned is
 * a real state, and the screen says so rather than showing an empty list that reads like a route
 * already finished.
 */
export function bootDriver(
  data: DriverData | undefined,
  outbox: DeviceOutbox,
  now: () => string = () => new Date().toISOString(),
): RouteSession | null {
  const stops = data?.stops ?? [];
  const collections = data?.collections ?? [];
  // A route of return collections alone is still a route (WF-16, driver).
  if (data?.routeId === undefined || data.driverId === undefined || (stops.length === 0 && collections.length === 0)) {
    return null;
  }
  return new RouteSession(data.routeId, data.driverId, stops, outbox, {
    currency: 'INR',
    now,
    ...(data.contributionRule === undefined ? {} : { contributionRule: data.contributionRule }),
    ...(collections.length === 0 ? {} : { collections }),
  });
}

// In the browser `globalThis.window` IS the window, so this needs no DOM types.
const browserWindow = (globalThis as { window?: DriverWindow }).window;
if (browserWindow !== undefined) {
  const storage = (globalThis as {
    localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  }).localStorage;
  browserWindow.driverStorageProblem = null;
  const route = browserWindow.driverData?.routeId ?? 'unassigned';
  const store = guardedStore(`sre.driver.outbox.${route}`, storage, (why) => {
    browserWindow.driverStorageProblem = why;
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
  const outbox = openDeviceOutbox(store, (why) => { browserWindow.driverStorageProblem = why; }, stamping?.stamp, APP_BUILD_VERSION);
  browserWindow.driverOutbox = outbox;
  // Defaulted to ₹100 and overridable per tenant. A tolerance of zero would send every driver to
  // the cash office over a rupee, and a control everybody routes around is not a control.
  browserWindow.driverHandoverToleranceMinor = browserWindow.driverData?.handoverToleranceMinor ?? 10_000;
  const session = bootDriver(browserWindow.driverData, outbox);
  if (session !== null) {
    browserWindow.routeSession = session;
    // The relay to the store computer — present only when the box served this page (it injects `laneWriteBase`).
    const relay = openDriverRelay(browserWindow.laneWriteBase, session, outbox, stamping?.clock);
    if (relay !== undefined) browserWindow.driverRelay = relay;
  }
  // OB-521: a withdrawn or too-old build finishes the route it started and starts no new one — by the store computer's
  // signed pack (served with the route, then each badge refresh), kept on this device for a reload with no signal.
  browserWindow.driverVersion = bindNewWorkGate(openNewWorkGate({
    client: 'driver', ...(storage === undefined ? {} : { storage }), key: 'sre.driver.app-version-policy',
    ...(browserWindow.driverData !== undefined && 'appVersionPolicy' in browserWindow.driverData ? { served: browserWindow.driverData.appVersionPolicy } : {}),
  }), [session]);
}

// OB-607: this page's shop's day as `window.sreShopDay` — the dates AND times of day it shows are the shop's clock, in the
// zone the store computer served from its signed pack (`window.shopTimeZone`; no network call), never this device's.
attachShopDay((globalThis as { window?: unknown }).window);
