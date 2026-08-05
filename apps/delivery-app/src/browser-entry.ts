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
import { RouteSession, type ContributionRule, type StopInput } from './route-session';

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
  if (session !== null) browserWindow.routeSession = session;
}
