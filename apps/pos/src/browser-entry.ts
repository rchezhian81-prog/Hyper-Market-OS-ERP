// Browser entry — the bundler's input (see `scripts/build-pos.mjs`). It wires a
// real `PosSession` for this lane and attaches the view adapter as
// `window.posSession`, which `web/app.js` binds to. Everything here is local: the
// stock ledger and sync outbox are in-memory at the lane, exactly as the offline
// design requires (hard rule #1) — the durable store and sync agent attach behind
// the outbox, never in the sale path.

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

/**
 * Build the lane's session from its configuration. In deployment the lane config
 * (lane id, cashier, trading day, currency, tax rate) comes from the tenant's signed
 * local config pack; the defaults here let the shell run standalone.
 */
export function bootPos(config?: {
  laneId?: string;
  cashierId?: string;
  tradingDay?: string;
  taxPercent?: number;
  /** The lane's cached catalogue snapshot; without it, barcode scanning is off. */
  catalogue?: CatalogueSnapshot;
  /**
   * The lane's durable local write — the edge's disk (hard rule #1).
   *
   * **Required in the type and defaulted here to a refusal**, which is the honest default for a
   * browser shell that has not been handed one: a lane with nowhere to write a sale must not take
   * payment. The alternative default — accept and hold it in memory — is a sale the cashier saw
   * succeed and that exists nowhere, which is the worst failure this product has.
   */
  durable?: (saleId: string, record: string) => Promise<CommitOutcome>;
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
    config?.durable ?? (() => Promise.resolve({
      committed: false,
      refusedBecause: 'could_not_write_durably' as const,
      detail: 'this lane has no durable local store wired to it',
      laneMessage: 'This lane is not ready to take payment. Do not take money — tell the manager and use another lane.',
    })),
  );
  // Indexing happens once at boot, so every subsequent scan is O(1) (§32).
  const catalogue = config?.catalogue ? new CatalogueCache(config.catalogue) : undefined;
  return createPosView(session, 'INR', catalogue);
}

// Attach for the view. `app.js` uses `window.posSession` when present and falls
// back to its stand-in when the bundle has not been built. In the browser
// `globalThis.window` IS the window, so this needs no DOM types.
const browserWindow = (globalThis as { window?: PosWindow }).window;
if (browserWindow !== undefined) {
  browserWindow.posSession = bootPos({ catalogue: browserWindow.posCatalogue });
}
