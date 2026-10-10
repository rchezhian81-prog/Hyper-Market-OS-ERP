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
import { drainToBox, boxStatus } from '../../../packages/sync/src/device-drain';
import { WarehouseSession, type WarehouseAssignment } from './warehouse-session';

import { mountDemoBanner, type BannerDocument } from '../../../packages/ui/src/demo-banner';

// The practice-data strip ("TRIAL COPY · PRACTICE DATA"), exactly as the ERP shell mounts it. `PILOT_DEMO_BANNER` is a
// build-time constant baked in by esbuild (`scripts/build-app.mjs`): '1' in the hosted-demo build, empty
// in production. `typeof` guards the unbundled case (identifier absent) and a non-browser import.
declare const PILOT_DEMO_BANNER: string;
const demoBannerDoc = (globalThis as { document?: unknown }).document;
if (demoBannerDoc !== undefined && demoBannerDoc !== null) {
  mountDemoBanner(demoBannerDoc as BannerDocument, typeof PILOT_DEMO_BANNER === 'string' ? PILOT_DEMO_BANNER : '');
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface WarehouseWindow {
  warehouseSession?: WarehouseSession;
  warehouseData?: WarehouseAssignment;
  warehouseOutbox?: DeviceOutbox;
  /** Anything that went wrong with the device's own storage, for the shell to show (P-08). */
  warehouseStorageProblem?: string | null;
  /** The store computer's write base the box injected: `''` on the device socket (same origin), absent off it. */
  laneWriteBase?: string;
  warehouseRelay?: WarehouseRelay;
}

export interface WarehouseRelay {
  /**
   * One pass of the shared device → store-computer leg (SP-3a): hand the accepted scans to the box (accepted or
   * duplicate → handed; refused → a visible refusal; link down → kept, nothing lost), then ask the box where the
   * items it holds have got to and fold that into the session's sent-work list.
   */
  syncNow(): Promise<{ readonly handed: number; readonly refused: number; readonly failed: number; readonly offline: boolean }>;
}

/**
 * The warehouse handheld's leg of the shared sync path (SP-3a · S1). The handheld is served BY the box's device socket,
 * so the base is the page's own origin (`''`); the device's cookie rides on every call. `undefined` when the shell was
 * not served by a box (a file, a test server): the queue still fills and survives, and the badge says "not connected".
 */
export function openWarehouseRelay(
  laneWriteBase: string | undefined,
  session: WarehouseSession,
  outbox: DeviceOutbox,
): WarehouseRelay | undefined {
  if (laneWriteBase === undefined) return undefined;
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
  if (fetchFn === undefined) return undefined;
  return {
    syncNow: async () => {
      const result = await drainToBox({ outbox, boxBase: laneWriteBase, source: 'warehouse', fetch: fetchFn });
      const statuses = await boxStatus({ boxBase: laneWriteBase, keys: session.handedKeys(), fetch: fetchFn });
      if (statuses !== undefined) session.noteBoxStatus(statuses);
      return { handed: result.handed, refused: result.refused, failed: result.failed, offline: result.offline };
    },
  };
}

/**
 * Build the warehouse session from the assignment the handheld holds.
 *
 * Returns `null` when there is no assignment — a real state (a worker at the start of a shift with
 * nothing assigned), and the shell says so rather than showing empty bins that read as work done.
 */
/**
 * OB-37: the delivery the receiver chose (`?delivery=<poId>`), or the only one waiting, becomes the delivery this phone
 * receives against — its order lines and the goods-receipt id head office gave it. Several waiting and none chosen: no
 * delivery is preset, and the phone asks the receiver to choose (nothing is received under a made-up one).
 */
export function withChosenDelivery(data: WarehouseAssignment | undefined, chosen: string | null): WarehouseAssignment | undefined {
  const list = data?.openDeliveries;
  if (data === undefined || list === undefined) return data;
  const pick = list.find((d) => d.poId === chosen) ?? (list.length === 1 ? list[0] : undefined);
  const { grnId: _g, poId: _p, ordered: _o, ...rest } = data;
  void _g; void _p; void _o;
  return pick === undefined ? rest : { ...rest, grnId: pick.grnId, poId: pick.poId, ordered: pick.ordered };
}

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
  const search = (globalThis as { location?: { search?: string } }).location?.search ?? '';
  browserWindow.warehouseData = withChosenDelivery(browserWindow.warehouseData, new URLSearchParams(search).get('delivery'));
  browserWindow.warehouseOutbox = outbox;
  const session = bootWarehouse(browserWindow.warehouseData, outbox);
  if (session !== null) {
    browserWindow.warehouseSession = session;
    // The relay to the store computer — present only when the box served this page (it injects `laneWriteBase`).
    const relay = openWarehouseRelay(browserWindow.laneWriteBase, session, outbox);
    if (relay !== undefined) browserWindow.warehouseRelay = relay;
  }
}
