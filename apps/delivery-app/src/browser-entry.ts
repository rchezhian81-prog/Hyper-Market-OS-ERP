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
// full address record, and the proof photograph itself never joins the queue — only the KIND of
// proof does. A route's worth of doorstep photographs syncing off a driver's phone is a privacy
// problem being uploaded, not a delivery being proved.

import { openDeviceOutbox, guardedStore, type DeviceOutbox } from '../../../packages/sync/src/device-outbox';
import { drainToBox, boxStatus } from '../../../packages/sync/src/device-drain';
import { RouteSession, type ContributionRule, type StopInput } from './route-session';

import { mountDemoBanner, type BannerDocument } from '../../../packages/ui/src/demo-banner';

// The "DEMO / PILOT — NOT PRODUCTION" strip, exactly as the ERP shell mounts it. `PILOT_DEMO_BANNER` is a
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
  /** The tenant's contribution stop rule (D09). Choose-able, never hard-coded. */
  readonly contributionRule?: ContributionRule;
  /** |over/short| at or above which a cash handover needs the cash office. Per-tenant. */
  readonly handoverToleranceMinor?: number;
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface DriverWindow {
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
): DriverRelay | undefined {
  if (laneWriteBase === undefined) return undefined;
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return undefined;
  return {
    syncNow: async () => {
      const result = await drainToBox({ outbox, boxBase: laneWriteBase, source: 'driver', fetch: fetchFn });
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
  const stops = data?.stops;
  if (data?.routeId === undefined || data.driverId === undefined || stops === undefined || stops.length === 0) {
    return null;
  }
  return new RouteSession(data.routeId, data.driverId, stops, outbox, {
    currency: 'INR',
    now,
    ...(data.contributionRule === undefined ? {} : { contributionRule: data.contributionRule }),
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
  const outbox = openDeviceOutbox(store, (why) => { browserWindow.driverStorageProblem = why; });
  browserWindow.driverOutbox = outbox;
  // Defaulted to ₹100 and overridable per tenant. A tolerance of zero would send every driver to
  // the cash office over a rupee, and a control everybody routes around is not a control.
  browserWindow.driverHandoverToleranceMinor = browserWindow.driverData?.handoverToleranceMinor ?? 10_000;
  const session = bootDriver(browserWindow.driverData, outbox);
  if (session !== null) {
    browserWindow.routeSession = session;
    // The relay to the store computer — present only when the box served this page (it injects `laneWriteBase`).
    const relay = openDriverRelay(browserWindow.laneWriteBase, session, outbox);
    if (relay !== undefined) browserWindow.driverRelay = relay;
  }
}
