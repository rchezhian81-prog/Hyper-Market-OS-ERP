// Browser entry — the bundler's input for the Warehouse handheld (`pnpm build:warehouse`). It wires a
// real `WarehouseSession` on the assignment the box served and attaches it as `window.warehouseSession`,
// which the shell's `web/app.js` binds to.
//
// ── What runs here, and where ───────────────────────────────────────────────
//
// A cheap Android handheld in the racking, where the wifi dies between the freezers and the back
// wall. So the assignment is CACHED and every scan is decided locally (P-01, §31): no call blocks a
// scan, and the accepted receipts and put-aways drain to the cloud later, idempotently.
//
// The queue is written to the DEVICE, not held in memory — a receipt or a put-away that lived only
// until the handheld was closed is exactly the failure the picker handheld already had and fixed.
//
// ── PII stays off the device ────────────────────────────────────────────────
//
// A warehouse assignment carries products, bins and order references. Never a customer name. A
// handheld gets left on a shelf; what is on it should be worth nothing to whoever finds it.

import { openDeviceOutbox, guardedStore, type DeviceOutbox } from '../../../packages/sync/src/device-outbox';
import { WarehouseSession, type WarehouseAssignment } from './warehouse-session';

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface WarehouseWindow {
  warehouseSession?: WarehouseSession;
  warehouseData?: WarehouseAssignment;
  warehouseOutbox?: DeviceOutbox;
  /** Anything that went wrong with the device's own storage, for the shell to show (P-08). */
  warehouseStorageProblem?: string | null;
}

/**
 * Build the warehouse session from the assignment the handheld holds.
 *
 * Returns `null` when there is no assignment — a real state (a worker at the start of a shift with
 * nothing assigned), and the shell says so rather than showing empty bins that read as work done.
 */
export function bootWarehouse(
  data: WarehouseAssignment | undefined,
  outbox: DeviceOutbox,
  now: () => string = () => new Date().toISOString(),
): WarehouseSession | null {
  if (data?.assignmentId === undefined || data.bins === undefined) return null;
  return new WarehouseSession(data, outbox, { now });
}

// In the browser `globalThis.window` IS the window, so this needs no DOM types.
const browserWindow = (globalThis as { window?: WarehouseWindow }).window;
if (browserWindow !== undefined) {
  const storage = (globalThis as {
    localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  }).localStorage;
  browserWindow.warehouseStorageProblem = null;
  const assignment = browserWindow.warehouseData?.assignmentId ?? 'unassigned';
  const store = guardedStore(`sre.warehouse.outbox.${assignment}`, storage, (why) => {
    // A worker whose scans are not being saved needs to know before the end of the shift, not after.
    browserWindow.warehouseStorageProblem = why;
  });
  const outbox = openDeviceOutbox(store, (why) => { browserWindow.warehouseStorageProblem = why; });
  browserWindow.warehouseOutbox = outbox;
  const session = bootWarehouse(browserWindow.warehouseData, outbox);
  if (session !== null) browserWindow.warehouseSession = session;
}
