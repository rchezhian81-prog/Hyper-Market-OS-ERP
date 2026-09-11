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
import { ReservedRangeAllocator } from '../../../packages/numbering/src/numbering';
import { PosSession, taxRateFromPercent } from './session';
import { createTillSession } from './till-session';
import { createPosView, type PosView } from './view-adapter';

/**
 * This lane's reserved receipt-number range (M01-FR-02), provisioned per lane in the signed local
 * config pack. Two offline lanes drawing from DISTINCT ranges can never mint the same receipt
 * number, so the day's numbers stay gap-free and collision-free with no network (audit GAP-SYNC-02).
 * The range is reconciled/refreshed on sync — a follow-on that rides the inbound pack path (SYNC-01).
 */
export interface PosReceiptSeries {
  readonly prefix: string;
  readonly padTo: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface PosWindow {
  posSession?: PosView;
  /** The lane's cached catalogue snapshot, injected by the edge before boot (§31). */
  posCatalogue?: CatalogueSnapshot;
  /** This lane's reserved receipt-number range, injected by the edge before boot (per lane). */
  posReceiptSeries?: PosReceiptSeries;
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
  // A sale is NOT safe to re-post on a lost reply: the edge is not yet idempotent on the sale id
  // (GAP-SALE-IDEMPOTENCY-01), so a blind retry could double-record. A lost reply is therefore a
  // refusal, as before — the sale has no receipt yet and the customer is still there.
  return laneDurableTo('/lane/sales', port,
    'This lane is not ready to take payment. Do not take money — tell the manager and use another lane.',
    { safeRetry: false });
}

/**
 * The lane's durable write for a REFUND: post it to this till's own edge on `/lane/returns` and wait
 * (M13-FR-01). The mirror of `laneDurable`, with one difference that RR-F02 turns on: a lost reply is
 * resolved by re-posting under the SAME id, which the edge treats idempotently (RR-F03), so a retry
 * can never cause a second refund — it only learns whether the first attempt recorded.
 */
export function laneDurableReturn(port: number = DEFAULT_LANE_PORT): DurableWrite {
  return laneDurableTo('/lane/returns', port,
    'This lane is not ready to record a refund. Do not hand back cash — tell the manager and use another lane.',
    { safeRetry: true });
}

/**
 * Post a record to one of the till's edge write routes and wait for its durable answer.
 *
 * A lost reply is not the same as a refusal (RR-F02). When the route is idempotent (`safeRetry`), a
 * dropped response is retried by re-posting the SAME record: the edge returns the original outcome for
 * a repeat, so the retry resolves whether the first attempt landed without any risk of a double
 * effect. Only when the store cannot be reached at all — after those retries — is the outcome
 * reported as **unconfirmed**: `committed` is false, but it must never be read as a definite failure
 * that invites running the refund again. For a non-idempotent route a lost reply stays a refusal.
 */
function laneDurableTo(
  path: '/lane/sales' | '/lane/returns',
  port: number,
  refusedLaneMessage: string,
  opts: { readonly safeRetry: boolean; readonly attempts?: number; readonly retryDelayMs?: number },
): DurableWrite {
  const attempts = opts.safeRetry ? (opts.attempts ?? 4) : 1;
  const retryDelayMs = opts.retryDelayMs ?? 100;
  return async (_id, record) => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: record,
        });
        return await response.json() as CommitOutcome;
      } catch (e) {
        lastError = e;
        // The reply was lost, or the store did not answer. On an idempotent route the same record is
        // re-posted (same identity), so the edge dedupes it — a retry cannot double-record.
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
    if (opts.safeRetry) {
      // Could not reach the store after safe retries. The refund MIGHT be recorded — we do not know,
      // and saying "definitely failed" here is what leads to a second refund (RR-F02). Report it as
      // unconfirmed instead: hold, do not hand back cash, do not re-run it.
      return {
        committed: false,
        unconfirmed: true,
        refusedBecause: 'could_not_write_durably',
        detail: `the lane's local store did not answer on port ${port} after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        laneMessage: 'This lane could not confirm the refund was saved. Do NOT hand back cash and do NOT run it again — get the manager to check whether it recorded first.',
      };
    }
    // A non-idempotent route (a sale): a lost reply is refused, and refused is right — it happens
    // before the receipt exists and accepting into memory would be a sale that exists nowhere.
    return {
      committed: false,
      refusedBecause: 'could_not_write_durably',
      detail: `the lane's local store did not answer on port ${port}`,
      laneMessage: refusedLaneMessage,
    };
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
  tillId?: string;
  /** |over/short| at or above which a cash-up variance needs a manager. Per-tenant. */
  varianceToleranceMinor?: number;
  /** Overridable for tests. Production always goes to this till's own edge. */
  durable?: DurableWrite;
  /** The refund's durable write. Overridable for tests; production goes to this till's own edge. */
  durableReturn?: DurableWrite;
  /** This lane's reserved receipt-number range (M01-FR-02), provisioned per lane. */
  receipt?: PosReceiptSeries;
}): PosView & {
  readonly till: ReturnType<typeof createTillSession>;
  /** The next receipt number for this lane — gap-free within its reserved range. Throws when the
   * range is exhausted (the lane must obtain a fresh range on sync); the caller must then take no
   * money. Without a provisioned range (a standalone/demo shell) a timestamp is returned, which is
   * NOT collision-safe across lanes and is only for a single unprovisioned till. */
  readonly nextReceipt: () => string;
  /** How many receipt numbers remain in this lane's range, or Infinity when unprovisioned. */
  readonly receiptsRemaining: () => number;
} {
  const outbox = new SyncOutbox();
  const session = new PosSession(
    {
      laneId: config?.laneId ?? 'lane-1',
      cashierId: config?.cashierId ?? 'cashier',
      tradingDay: config?.tradingDay ?? '1970-01-01',
      currency: 'INR',
      defaultTaxRate: taxRateFromPercent(config?.taxPercent ?? 18),
    },
    new Ledger(new InMemoryLedgerStore()),
    outbox,
    config?.durable ?? laneDurable(config?.lanePort ?? DEFAULT_LANE_PORT),
  );
  // Indexing happens once at boot, so every subsequent scan is O(1) (§32).
  const catalogue = config?.catalogue ? new CatalogueCache(config.catalogue) : undefined;
  const view = createPosView(session, 'INR', catalogue);

  // The till itself — money in and out of the drawer, refunds, closing the shift. A separate
  // object rather than more methods on the sale view, because it is a different job done by a
  // different person at a different time, and because keeping the expected-cash figure out of the
  // sale surface is what makes the blind count structural.
  const till = createTillSession(
    {
      tillId: config?.tillId ?? 'till-1',
      laneId: config?.laneId ?? 'lane-1',
      cashierId: config?.cashierId ?? 'cashier',
      tradingDay: config?.tradingDay ?? '1970-01-01',
      varianceToleranceMinor: config?.varianceToleranceMinor ?? 10_000,
    },
    new Ledger(new InMemoryLedgerStore()),
    new Ledger(new InMemoryLedgerStore()),
    outbox,
    // The refund's durable write goes to this till's own edge, exactly as the sale's does.
    config?.durableReturn ?? laneDurableReturn(config?.lanePort ?? DEFAULT_LANE_PORT),
  );

  // Receipt numbering (M01-FR-02). A provisioned reserved range gives gap-free, collision-free
  // numbers across offline lanes; the allocator throws when the range is spent, which the shell
  // surfaces as a safe-stop (take no money) rather than reusing a number. Absent a provisioned range
  // this is a standalone/demo shell, so a timestamp stands in — explicitly NOT collision-safe.
  const receiptAllocator = config?.receipt === undefined ? undefined : new ReservedRangeAllocator(
    { prefix: config.receipt.prefix, padTo: config.receipt.padTo },
    { start: config.receipt.rangeStart, end: config.receipt.rangeEnd },
  );
  const nextReceipt = (): string => (receiptAllocator === undefined
    ? `R-${Date.now().toString(36).toUpperCase()}`
    : receiptAllocator.allocate().formatted);
  const receiptsRemaining = (): number => receiptAllocator?.remaining() ?? Number.POSITIVE_INFINITY;

  return Object.assign(view, { till, nextReceipt, receiptsRemaining });
}

// Attach for the view. `app.js` uses `window.posSession` when present and falls back to its
// stand-in when the bundle has not been built. In the browser `globalThis.window` IS the window,
// so this needs no DOM types.
const browserWindow = (globalThis as { window?: PosWindow }).window;
if (browserWindow !== undefined) {
  browserWindow.posSession = bootPos({
    catalogue: browserWindow.posCatalogue,
    ...(browserWindow.posReceiptSeries === undefined ? {} : { receipt: browserWindow.posReceiptSeries }),
  });
}
