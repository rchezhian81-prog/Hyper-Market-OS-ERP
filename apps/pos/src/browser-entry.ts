// Browser entry — the bundler's input (see `scripts/build-pos.mjs`). It wires a real `PosSession`
// for this lane and attaches the view adapter as `window.posSession`, which `web/app.js` binds to.
//
// **The durable write goes to this till's own edge, over loopback** (ADR-0004). A browser cannot
// call `fsync`, so the disk belongs to a small local process and the shell posts to it on
// `127.0.0.1`. That is not a network call in the sense hard rule #1 forbids: it does not leave the
// machine, and it cannot be affected by the shop's switch, the router or the internet. What it must
// never become is a call to anything off this till.
//
// Everything else here is local by design: the stock ledger and outbox are in memory at the lane,
// and the sync agent drains the outbox afterwards, never in the sale path.

import { InMemoryLedgerStore, Ledger } from '../../../packages/ledger/src/ledger';
import type { CommitOutcome } from '../../../edge/store-edge/src/durability';
import { SyncOutbox } from '../../../packages/sync/src/outbox';
import { CatalogueCache, type CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import { PosSession, taxRateFromPercent } from './session';
import { createPosView, type PosView } from './view-adapter';

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface PosWindow {
  posSession?: PosView;
  /** The lane's cached catalogue snapshot, injected by the edge before boot (§31). */
  posCatalogue?: CatalogueSnapshot;
}

/** Where this till's edge listens. Loopback only — see ADR-0004 and `edge/store-edge/src/lane-server.ts`. */
export const DEFAULT_LANE_PORT = 8090;

export type DurableWrite = (saleId: string, record: string) => Promise<CommitOutcome>;

/**
 * The lane's durable write: post the sale to this till's own edge and wait for the answer.
 *
 * The wait is the point. `commit` does not return, the receipt number does not exist, and the
 * screen cannot say "Sale complete" until the disk has confirmed.
 */
export function laneDurable(port: number = DEFAULT_LANE_PORT): DurableWrite {
  return async (_saleId, record) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/lane/sales`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: record,
      });
      return await response.json() as CommitOutcome;
    } catch {
      // The edge is not running, or was stopped, or the port is wrong. **Refused**, and refused is
      // right: it happens before the receipt exists and the customer is still standing there.
      // Accepting into memory instead would be a sale the cashier saw succeed that exists nowhere.
      return {
        committed: false,
        refusedBecause: 'could_not_write_durably',
        detail: `the lane's local store did not answer on port ${port}`,
        laneMessage: 'This lane is not ready to take payment. Do not take money — tell the manager and use another lane.',
      };
    }
  };
}

/**
 * Build the lane's session from its configuration.
 *
 * In deployment the lane config (lane id, cashier, trading day, currency, tax rate) comes from the
 * tenant's signed local config pack; the defaults here let the shell run standalone.
 */
export function bootPos(config?: {
  laneId?: string;
  cashierId?: string;
  tradingDay?: string;
  taxPercent?: number;
  /** The lane's cached catalogue snapshot; without it, barcode scanning is off. */
  catalogue?: CatalogueSnapshot;
  /** Where this till's edge listens. Only ever loopback. */
  lanePort?: number;
  /** Overridable for tests. Production always goes to this till's own edge. */
  durable?: DurableWrite;
}): PosView {
  const session = new PosSession(
    {
      laneId: config?.laneId ?? 'lane-1',
      cashierId: config?.cashierId ?? 'cashier',
      tradingDay: config?.tradingDay ?? '1970-01-01',
      currency: 'INR',
      defaultTaxRate: taxRateFromPercent(config?.taxPercent ?? 18),
    },
    new Ledger(new InMemoryLedgerStore()),
    new SyncOutbox(),
    config?.durable ?? laneDurable(config?.lanePort ?? DEFAULT_LANE_PORT),
  );
  // Indexing happens once at boot, so every subsequent scan is O(1) (§32).
  const catalogue = config?.catalogue ? new CatalogueCache(config.catalogue) : undefined;
  return createPosView(session, 'INR', catalogue);
}

// Attach for the view. `app.js` uses `window.posSession` when present and falls back to its
// stand-in when the bundle has not been built. In the browser `globalThis.window` IS the window,
// so this needs no DOM types.
const browserWindow = (globalThis as { window?: PosWindow }).window;
if (browserWindow !== undefined) {
  browserWindow.posSession = bootPos({ catalogue: browserWindow.posCatalogue });
}
