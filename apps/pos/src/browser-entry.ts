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
import type { SaleLookupResult } from '../../../edge/store-edge/src/receipt-lookup';
import { SyncOutbox } from '../../../packages/sync/src/outbox';
import { CatalogueCache, type CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import { ReservedRangeAllocator } from '../../../packages/numbering/src/numbering';
import { money } from '../../../packages/contracts/src/money';
import type { TenderKind } from '../../../packages/contracts/src/enums';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';
import { PosSession, taxRateFromPercent, NoOperatorError } from './session';
import {
  createTillSession, TILL_CASH_WORDS_FOR_THE_LANE,
  type CashMovementWrite, type ShiftCloseWrite, type TillCashRead, type CashMovementOutcome, type ShiftCloseOutcome, type TillCashStatus,
} from './till-session';
import { createPosView, type PosView } from './view-adapter';
import {
  createRefundView, type RefundPolicy, type RefundLineChoice, type RefundScreenOutcome,
} from './refund-view';
import type { ReturnableLine } from '../../../packages/returns/src/return-register';
import { assessExchange, type ExchangeBalanceKind } from '../../../packages/returns/src/exchange';
import { refundRequiresApproval, type ExchangeSettlementInput } from '../../../packages/returns/src/returns';
import { settle, type Tender } from '../../../packages/tender/src/tender';

import { mountDemoBanner, type BannerDocument } from '../../../packages/ui/src/demo-banner';

// The practice-data strip ("TRIAL COPY · PRACTICE DATA"), exactly as the ERP shell mounts it. `PILOT_DEMO_BANNER` is a
// build-time constant baked in by esbuild (`scripts/build-app.mjs`): '1' in the hosted-demo build, empty
// in production. `typeof` guards the unbundled case (identifier absent) and a non-browser import.
declare const PILOT_DEMO_BANNER: string;

// DEMO ONLY (ADR-0016). Where this till's edge answers. A build-time constant (esbuild `define`): the
// hosted-demo build sets it to the same-origin path of the demo store box (`/store-lane`), so a till in a
// remote browser reaches the demo edge through the signed-in HTTPS front. A production build leaves it
// empty, which compiles to the store's own loopback — `http://127.0.0.1:<port>` — exactly as before.
declare const PILOT_DEMO_LANE_BASE: string;
const DEMO_LANE_BASE = typeof PILOT_DEMO_LANE_BASE === 'string' ? PILOT_DEMO_LANE_BASE : '';
/** The base URL of this till's edge: the store's loopback, unless the DEMO build says otherwise. */
export function laneBase(port: number, demoBase: string = DEMO_LANE_BASE): string {
  return demoBase === '' ? `http://127.0.0.1:${port}` : demoBase;
}
const demoBannerDoc = (globalThis as { document?: unknown }).document;
if (demoBannerDoc !== undefined && demoBannerDoc !== null) {
  mountDemoBanner(demoBannerDoc as BannerDocument, typeof PILOT_DEMO_BANNER === 'string' ? PILOT_DEMO_BANNER : '');
}

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

/**
 * The RECEIPT template head office published, as the store box last pulled it (M01-FR-02 · §31). Injected by
 * the edge beside the catalogue (`window.posReceiptTemplate`) so a bill printed with the cable out carries the
 * header and footer in force — and the VERSION it was printed under, stamped on the bill, so a reprint next year
 * is rendered under the layout the original had. Absent when no published template has reached this box: the
 * lane prints with its defaults and stamps no version, rather than inventing one (P-08).
 */
export interface PosReceiptTemplate {
  readonly version: number;
  readonly header: readonly string[];
  readonly footer: readonly string[];
  readonly language: string;
  readonly paperFormat?: string;
  readonly publishedAt: string;
  /** The cloud's clock on the set, the box's clock when it took it, and how far behind the cloud it is. */
  readonly generatedAt: string;
  readonly receivedAt: string;
  readonly ageHours: number;
}

/**
 * Who this till IS, as the store box told the served page (SP-4b · F09): the lane (`EDGE_LANE_ID`) and the shop's
 * trading-day cut-off. `laneId` is null when the box was never told — the till then refuses to take payment and says
 * so. The cashier is NOT here: the person signs in at the till with their staff code (hard rule #4).
 */
export interface PosLane {
  readonly laneId: string | null;
  readonly tradingDayCutoff: string;
  readonly tradingDayCutoffKnown: boolean;
  readonly tradingDay: string;
  readonly storeId: string | null;
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface PosWindow {
  posSession?: PosView;
  /** Which lane this box is and when its day ends, injected by the edge before boot (SP-4b · F09). */
  posLane?: PosLane;
  /** The lane's cached catalogue snapshot, injected by the edge before boot (§31). */
  posCatalogue?: CatalogueSnapshot;
  /** This lane's reserved receipt-number range, injected by the edge before boot (per lane). */
  posReceiptSeries?: PosReceiptSeries;
  /** The receipt template in force, injected by the edge before boot when this box has pulled one (M01-FR-02). */
  posReceiptTemplate?: PosReceiptTemplate;
  /** The refund policy the box's store pack carries — approval threshold + no-receipt cap — injected by the edge before
   *  boot (SP-9b-i · M13-FR-01). Absent when the box holds none: the till then offers NO return without a receipt. */
  posRefundPolicy?: RefundPolicy;
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
        const response = await fetch(`${laneBase(port)}${path}`, {
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
 * Look up a bill this lane rang, over the loopback READ route (M13-FR-01) — read-only, never a
 * write. The mirror of the durable-write helpers, for the refund screen: the edge answers from its
 * own logs, so it works offline for a bill this lane knows. A bill it did not ring resolves `null`.
 */
export type LaneLookup = (receipt: string) => Promise<SaleLookupResult | null>;

export function laneLookup(port: number = DEFAULT_LANE_PORT): LaneLookup {
  return async (receipt) => {
    const response = await fetch(`${laneBase(port)}/lane/lookup?receipt=${encodeURIComponent(receipt)}`);
    const body = await response.json() as { found?: boolean } & Partial<SaleLookupResult>;
    return body.found === true && body.sale !== undefined
      ? { sale: body.sale, returns: body.returns ?? [], refunds: body.refunds ?? [] }
      : null;
  };
}

/**
 * The till's CASH ports to its own box (SP-4c · F10 · M14-FR-01/02): a float, loan, pickup or safe drop on
 * `/lane/cash-movements`; the shift close on `/lane/shift-close`; where the till's cash stands on `/lane/till-cash`.
 * The box owns the record and the decision; these carry the request over the same loopback socket a sale uses. Both
 * write routes are idempotent on the till's own id, so a lost reply is resolved by re-posting the SAME request: the box
 * answers `alreadyRecorded` / `alreadyClosed` for a repeat, and a retry can never move the money twice. Only when the
 * box cannot be reached at all is the outcome `lane_unreachable` — and it says so in the cashier's words, never as a
 * refusal that invites a fresh id.
 */
function laneCashTo<TReq, TOut>(
  path: '/lane/cash-movements' | '/lane/shift-close', port: number, unreachable: () => TOut,
  opts: { readonly attempts?: number; readonly retryDelayMs?: number } = {},
): (req: TReq) => Promise<TOut> {
  const attempts = opts.attempts ?? 4;
  const retryDelayMs = opts.retryDelayMs ?? 100;
  return async (req) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req),
        });
        return await response.json() as TOut;
      } catch {
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
    return unreachable();
  };
}

export function laneCashMovement(port: number = DEFAULT_LANE_PORT): CashMovementWrite {
  return laneCashTo('/lane/cash-movements', port, (): CashMovementOutcome =>
    ({ committed: false, refusedBecause: 'lane_unreachable', laneMessage: TILL_CASH_WORDS_FOR_THE_LANE.lane_unreachable }));
}

export function laneShiftClose(port: number = DEFAULT_LANE_PORT): ShiftCloseWrite {
  return laneCashTo('/lane/shift-close', port, (): ShiftCloseOutcome =>
    ({ closed: false, refusedBecause: 'lane_unreachable', laneMessage: TILL_CASH_WORDS_FOR_THE_LANE.lane_unreachable }));
}

/** Where the till's cash stands, read from the box — custody only, never a figure. `null` when the box did not answer. */
export function laneTillCash(port: number = DEFAULT_LANE_PORT): TillCashRead {
  return async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/lane/till-cash`);
      if (!response.ok) return null;
      return await response.json() as TillCashStatus;
    } catch {
      return null;
    }
  };
}

/** What the refund screen passes back to complete a refund — display primitives + an optional
 * manager approval captured at the lane (§28: the manager's staff id, which must differ from the
 * cashier, and a reason). The edge/cloud re-verify that the approver truly holds the authority. */
export interface RefundDraftInput {
  readonly returnId: string;
  readonly number: string;
  readonly reasonCode: string;
  readonly lines: readonly RefundLineChoice[];
  readonly refundMinor: number;
  readonly refundTender: TenderKind;
  readonly noReceipt?: boolean;
  readonly approval?: { readonly by: string; readonly reason: string };
  /** The customer a store-credit refund is issued to (M13-FR-03 / §31), so an offline store-credit
   *  refund can issue the credit to them when it reconciles at the cloud. */
  readonly customerRef?: string;
}

/**
 * What an EXCHANGE against this bill would come to, against the replacement goods on the bill NOW (SP-9b-ii ·
 * M13-FR-03): the credit for the goods coming back at the bill's own price, the replacement as rung, and which way
 * the difference goes. `ok: false` names why it cannot happen (nothing on the bill to replace with, more coming back
 * than was sold, a credit past what the bill was paid…) — nothing is recorded by a quote.
 */
export interface ExchangeQuote {
  readonly ok: boolean;
  readonly refusedBecause?: string;
  readonly detail: string;
  readonly returnedValueMinor: number;
  readonly replacementTotalMinor: number;
  readonly balance: ExchangeBalanceKind;
  readonly balanceMinor: number;
  readonly appliedMinor: number;
  /** Whether the refund of the balance needs a manager (§28) — never for an even exchange or a top-up. */
  readonly needsApproval: boolean;
}

/** The exchange as the screen assembled it. Two documents are minted at the lane: the return (`exchangeId`, `number`)
 *  and the replacement sale (`replacementSaleId`, `replacementReceipt`), both from the lane's own reserved range. */
export interface ExchangeDraftInput {
  readonly exchangeId: string;
  readonly number: string;
  readonly reasonCode: string;
  readonly returnLines: readonly RefundLineChoice[];
  readonly replacementSaleId: string;
  readonly replacementReceipt: string;
  readonly settlement: {
    /** How the shop refunds the balance, when it owes one. */
    readonly refundTender?: TenderKind;
    /** The customer a store-credit balance is issued to (M13-FR-03). */
    readonly customerRef?: string;
    /** How the customer pays the balance, when they owe one. Card/UPI carry what the terminal said (M12-FR-03). */
    readonly topUp?: { readonly kind: 'cash' | 'card' | 'upi'; readonly outcome?: 'approved' | 'declined' | 'no_answer' };
  };
  readonly approval?: { readonly by: string; readonly reason: string };
}

/**
 * The one screen state an exchange resolves to. `done` carries both documents and how the balance moved; `half_done`
 * is the state this screen exists to make VISIBLE (P-08): the goods coming back are recorded as a credit on the bill
 * but the replacement sale could not be — do not hand over the new goods, get the manager. The rest are the refund's
 * own refusals (nothing recorded).
 */
export type ExchangeOutcome =
  | {
    readonly kind: 'done'; readonly balance: ExchangeBalanceKind; readonly balanceMinor: number; readonly returnedValueMinor: number;
    readonly refundStatus: 'settled' | 'pending'; readonly number: string; readonly replacementReceipt: string; readonly laneMessage: string;
  }
  | { readonly kind: 'half_done'; readonly number: string; readonly returnedValueMinor: number; readonly laneMessage: string }
  | Exclude<RefundScreenOutcome, { kind: 'settled' } | { kind: 'pending' }>;

/** A looked-up bill, ready for the refund screen to show and act on. */
export interface RefundLookup {
  readonly sale: { readonly saleId: string; readonly number: string; readonly totalMinor: number };
  readonly returnable: readonly ReturnableLine[];
  readonly maxRefundMinor: number;
  /** Whether a refund of this amount needs a §28 approver, so the screen asks for a manager first. */
  readonly needsApproval: (refundMinor: number, noReceipt?: boolean) => boolean;
  /** Complete the refund, resolving to exactly one plain-English screen state. Never throws. */
  readonly submit: (draft: RefundDraftInput) => Promise<RefundScreenOutcome>;
  /** The EXCHANGE against this bill (SP-9b-ii): quote it against the goods on the bill now; complete it. */
  readonly exchange: {
    readonly quote: (returnLines: readonly RefundLineChoice[]) => ExchangeQuote;
    /** Record the exchange: the return (credit) FIRST, then the replacement sale paid with that credit plus any top-up.
     *  Resolves to exactly one screen state. Never throws. */
    readonly complete: (draft: ExchangeDraftInput) => Promise<ExchangeOutcome>;
  };
}

/** An item named for a return with no receipt — from the lane's catalogue, never judged for sale (SP-9b-i). */
export interface NoReceiptItem {
  readonly productId: string;
  readonly name: string;
  readonly uom: string;
}

/**
 * The till's surface for a return WITHOUT a receipt (M13-FR-01 · §28). There is no bill to look up, so the item is
 * named from the lane's own catalogue (barcode, SKU or id — a delisted or blocked product can still come back), the
 * refund is bounded by the cap the box was GIVEN, and a second person ALWAYS approves. The cloud re-checks the cap,
 * the approver and the stock location when the return reconciles, and flags a breach as a visible exception.
 */
export interface NoReceiptReturnSurface {
  /** The most a no-receipt refund may be on this lane, in minor units — the policy's cap, never invented. */
  readonly capMinor: number;
  /** Name the item the customer is holding, or `null` when this lane's catalogue does not know the code. */
  readonly findProduct: (code: string) => NoReceiptItem | null;
  /** Always true: every no-receipt return needs a manager who is not the cashier (§28). Here so the screen asks. */
  readonly needsApproval: () => boolean;
  /** Complete the return, resolving to exactly one plain-English screen state. Never throws. */
  readonly submit: (draft: RefundDraftInput) => Promise<RefundScreenOutcome>;
}

/**
 * Build the lane's session from its configuration.
 *
 * In deployment the LANE comes from the store box's own setting (`EDGE_LANE_ID`) and the trading-day cut-off from the
 * store pack, both injected into the served page; the CASHIER signs in with their staff code (SP-4b · F09). There are
 * no stand-in values: a till that knows no lane, or has nobody signed in, refuses to take payment and says why.
 */
export function bootPos(config?: {
  /** Which lane this till IS. Absent = the box never said → a sale is refused (`NoLaneError`). */
  laneId?: string;
  /** The cashier at boot (tests / a kiosk). In the shop nobody is passed here — the person signs in. */
  cashierId?: string;
  /** A FIXED trading day (tests). Absent → each sale is dated at the moment it is taken, per the cut-off. */
  tradingDay?: string;
  /** Where this shop's trading day ends, "HH:MM" local (M01-FR-02). Absent = midnight. */
  tradingDayCutoff?: string;
  taxPercent?: number;
  /** The lane's cached catalogue snapshot; without it, barcode scanning is off. */
  catalogue?: CatalogueSnapshot;
  /** Where this till's edge listens. Only ever loopback. */
  lanePort?: number;
  /** Overridable for tests. Production always goes to this till's own edge. */
  durable?: DurableWrite;
  /** The refund's durable write. Overridable for tests; production goes to this till's own edge. */
  durableReturn?: DurableWrite;
  /** The till's cash ports to its box (SP-4c): a movement, the shift close, where the cash stands. Overridable for tests. */
  cashMovement?: CashMovementWrite;
  shiftClose?: ShiftCloseWrite;
  tillCash?: TillCashRead;
  /** This lane's reserved receipt-number range (M01-FR-02), provisioned per lane. */
  receipt?: PosReceiptSeries;
  /** The receipt template in force as the box last pulled it (M01-FR-02); absent = print with defaults, stamp no version. */
  receiptTemplate?: PosReceiptTemplate;
  /**
   * The refund policy for this tenant (M13, §28) — the approval threshold and no-receipt cap. These
   * are owner-input-pending numbers, so they are GIVEN here (from the signed local config pack in
   * deployment), never invented. Default: threshold 0 — every refund needs a §28 approver — and no
   * no-receipt cap, so the no-receipt path is unavailable until one is configured (fail safe).
   */
  refundPolicy?: RefundPolicy;
  /** Look up a bill for a refund. Overridable for tests; production reads this till's own edge. */
  laneLookup?: LaneLookup;
}): PosView & {
  readonly till: ReturnType<typeof createTillSession>;
  /** The next receipt number for this lane — gap-free within its reserved range. Throws when the
   * range is exhausted (the lane must obtain a fresh range on sync); the caller must then take no
   * money. Without a provisioned range (a standalone/demo shell) a timestamp is returned, which is
   * NOT collision-safe across lanes and is only for a single unprovisioned till. */
  readonly nextReceipt: () => string;
  /** How many receipt numbers remain in this lane's range, or Infinity when unprovisioned. */
  readonly receiptsRemaining: () => number;
  /** Look up a bill this lane rang, for the refund screen — or `null` if it did not ring it. */
  readonly lookupRefund: (receipt: string) => Promise<RefundLookup | null>;
  /** The return-without-a-receipt surface (SP-9b-i · M13-FR-01) — or `null` when this till may not offer one: no
   *  no-receipt cap was given (or it is 0, switched off), or the till has no catalogue to name the item from. */
  readonly noReceiptReturn: () => NoReceiptReturnSurface | null;
  /** The receipt template this lane prints with — header, footer and the version to stamp — or `null` when none
   *  has reached this box (print with defaults, stamp nothing). Read from the box's pack, never fetched at print time. */
  readonly receiptTemplate: () => PosReceiptTemplate | null;
  /** A cashier signs in with their staff code (SP-4b · F09): the sale session AND the till name them from here on. */
  readonly signIn: (cashierId: string) => void;
  readonly signOut: () => void;
  /** Who is at the till now, or undefined when nobody is signed in. */
  readonly operator: () => string | undefined;
  /** Which lane this till is (null = the box never said) and the trading day a moment falls on, per the shop's cut-off. */
  readonly lane: () => { readonly laneId: string | null; readonly tradingDayCutoff: string; readonly tradingDayAt: (atIsoUtc: string) => string };
} {
  const outbox = new SyncOutbox();
  // Only what was GIVEN goes in: no lane, cashier or day is ever made up here (F09).
  const identity = {
    ...(config?.laneId === undefined ? {} : { laneId: config.laneId }),
    ...(config?.cashierId === undefined ? {} : { cashierId: config.cashierId }),
    ...(config?.tradingDay === undefined ? {} : { tradingDay: config.tradingDay }),
    ...(config?.tradingDayCutoff === undefined ? {} : { tradingDayCutoff: config.tradingDayCutoff }),
  };
  const session = new PosSession(
    {
      ...identity,
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
  const lanePort = config?.lanePort ?? DEFAULT_LANE_PORT;
  const till = createTillSession(
    {
      ...(identity.laneId === undefined ? {} : { laneId: identity.laneId }),
      ...(identity.cashierId === undefined ? {} : { cashierId: identity.cashierId }),
      ...(identity.tradingDay === undefined ? {} : { tradingDay: identity.tradingDay }),
    },
    new Ledger(new InMemoryLedgerStore()),
    outbox,
    {
      // The refund's durable write goes to this till's own edge, exactly as the sale's does.
      durableReturn: config?.durableReturn ?? laneDurableReturn(lanePort),
      // And so does every cash movement and the close (SP-4c · F10): the box records, decides and dates them.
      cashMovement: config?.cashMovement ?? laneCashMovement(lanePort),
      shiftClose: config?.shiftClose ?? laneShiftClose(lanePort),
      tillCash: config?.tillCash ?? laneTillCash(lanePort),
    },
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

  // The refund screen's surface. Look up a bill this lane rang, then hand the screen a small object
  // that can show what is returnable and complete the refund — the money rules stay in the tested
  // refund view + the till behind it; this only converts the shape and maps a manager's lane approval
  // into the §28 `DecidedRequest` the engine checks (decidedBy ≠ processedBy; the cloud re-verifies
  // the approver truly holds the authority on sync).
  const refundPolicy: RefundPolicy = config?.refundPolicy ?? { approvalThresholdMinor: 0 };
  const lookup = config?.laneLookup ?? laneLookup(config?.lanePort ?? DEFAULT_LANE_PORT);

  // A manager's lane approval, as the §28 `DecidedRequest` the engine checks (decidedBy ≠ processedBy; the cloud
  // re-verifies the approver truly holds the authority on sync). Shared by the receipted and the no-receipt return.
  const decidedAtTheLane = (
    draft: { readonly returnId: string; readonly refundMinor: number; readonly approval?: { readonly by: string; readonly reason: string } },
    cashierId: string,
  ): DecidedRequest | undefined => (draft.approval === undefined ? undefined : {
    id: `ovr-${draft.returnId}`, subjectType: 'pos.return', subjectRef: draft.returnId,
    requestedBy: cashierId, branchId: null, value: money(draft.refundMinor, 'INR'),
    status: 'approved', decidedBy: draft.approval.by, reason: draft.approval.reason,
    decidedAt: new Date().toISOString(),
  });
  // Nobody signed in → refused in the till's words, before anything is written (F09).
  const nobodyAtTheTill = (): { readonly kind: 'refused'; readonly laneMessage: string } => ({ kind: 'refused', laneMessage: new NoOperatorError('take a refund').laneMessage });
  // The two outcomes that mean the return IS on the disk (settled at the lane, or a reversal pending) — everything else is a refusal.
  const creditRecorded = (o: RefundScreenOutcome): o is Extract<RefundScreenOutcome, { kind: 'settled' | 'pending' }> => o.kind === 'settled' || o.kind === 'pending';

  const lookupRefund = async (receipt: string): Promise<RefundLookup | null> => {
    const found = await lookup(receipt);
    if (found === null) return null;
    const originalSale = found.sale;
    const refundView = createRefundView({
      refund: till.refund,
      now: () => new Date().toISOString(),
      policy: refundPolicy,
      priorReturns: found.returns,
      priorRefunds: found.refunds,
    });
    return {
      sale: { saleId: originalSale.saleId, number: originalSale.number, totalMinor: originalSale.totalMinor },
      returnable: refundView.returnable(originalSale),
      maxRefundMinor: refundView.maxRefundMinor(originalSale),
      needsApproval: (refundMinor, noReceipt = false) => refundView.needsApproval({
        returnId: '', number: '', originalSale, reasonCode: '', lines: [], refundMinor, refundTender: 'cash', noReceipt,
      }),
      submit: (draft) => {
        // The refund is asked for by whoever is signed in NOW (F09); nobody signed in → refused in the till's words.
        const cashierId = session.operator();
        if (cashierId === undefined) return Promise.resolve(nobodyAtTheTill());
        const approval = decidedAtTheLane(draft, cashierId);
        return refundView.submit({
          returnId: draft.returnId, number: draft.number, originalSale,
          reasonCode: draft.reasonCode, lines: draft.lines,
          refundMinor: draft.refundMinor, refundTender: draft.refundTender,
          noReceipt: draft.noReceipt ?? false,
          ...(approval === undefined ? {} : { approval }),
          ...(draft.customerRef === undefined ? {} : { customerRef: draft.customerRef }),
        });
      },
      exchange: {
        // The arithmetic is the tested engine's (`assessExchange`), run over the bill's own history and the goods on
        // the bill NOW: the credit at the bill's own price, the replacement as rung (promotions attributed per line, as
        // the sale record carries them), the balance and whether a refunded balance needs a manager. Nothing recorded.
        quote: (returnLines) => {
          const a = assessExchange({
            sale: originalSale, priorReturns: found.returns, priorRefunds: found.refunds,
            exchange: {
              exchangeId: '',
              returnLines: returnLines.map((l) => ({ productId: l.productId, uom: l.uom, quantityMinor: l.quantityMinor, disposition: l.disposition })),
              replacementLines: session.replacementLines(),
            },
          });
          return {
            ok: a.ok, ...(a.refusedBecause === undefined ? {} : { refusedBecause: a.refusedBecause }), detail: a.detail,
            returnedValueMinor: a.returnedValueMinor, replacementTotalMinor: a.replacementTotalMinor,
            balance: a.balance, balanceMinor: a.balanceMinor, appliedMinor: a.appliedMinor,
            needsApproval: a.balance === 'refund' && refundRequiresApproval(a.balanceMinor, false, refundPolicy.approvalThresholdMinor),
          };
        },
        // Decide everything, THEN record the return (the credit against the bill, through the same durable-first
        // refund path as any return), THEN the replacement sale paid with that credit plus any top-up (through the same
        // durable-first sale path as any sale). The credit goes first so goods never leave against a credit that was
        // not recorded; if the sale half then cannot be recorded, the screen is told so by name (`half_done`, P-08) —
        // the credit stands on the bill for the manager to complete, and the new goods stay on the counter.
        complete: async (draft): Promise<ExchangeOutcome> => {
          const cashierId = session.operator();
          if (cashierId === undefined) return nobodyAtTheTill();
          const q = (() => assessExchange({
            sale: originalSale, priorReturns: found.returns, priorRefunds: found.refunds,
            exchange: {
              exchangeId: draft.exchangeId,
              returnLines: draft.returnLines.map((l) => ({ productId: l.productId, uom: l.uom, quantityMinor: l.quantityMinor, disposition: l.disposition })),
              replacementLines: session.replacementLines(),
            },
          }))();
          if (!q.ok) return { kind: 'invalid', laneMessage: `${q.detail} Nothing was recorded.` };

          // The settlement, from what the screen captured — refused in words before anything is written.
          const tenders: Tender[] = q.appliedMinor > 0 ? [{ kind: 'exchange_credit', amount: money(q.appliedMinor, 'INR'), status: 'settled' }] : [];
          let balanceTender: TenderKind | undefined;
          let topUpTenders: ExchangeSettlementInput['topUpTenders'];
          if (q.balance === 'refund') {
            balanceTender = draft.settlement.refundTender;
            if (balanceTender === undefined) return { kind: 'invalid', laneMessage: 'The shop owes the customer the difference — choose how it is refunded. Nothing was recorded.' };
            if (balanceTender === 'store_credit' && draft.settlement.customerRef === undefined) {
              return { kind: 'invalid', laneMessage: 'Store credit must go to a customer. Scan their loyalty card or key their number — or choose a different refund method. Nothing was recorded.' };
            }
          } else if (q.balance === 'top_up') {
            const topUp = draft.settlement.topUp;
            if (topUp === undefined) return { kind: 'invalid', laneMessage: 'The customer owes the difference — choose how they pay it. Nothing was recorded.' };
            if (topUp.kind !== 'cash' && topUp.outcome !== 'approved') {
              // The terminal did not approve: declined is declined, and silence is NOT approval (M12-FR-03) — nothing is recorded.
              return { kind: 'refused', laneMessage: topUp.outcome === 'declined' ? 'The card/UPI payment was declined. Nothing was recorded — the goods stay on the counter.' : 'The terminal has not answered. Do not hand over the goods — nothing was recorded; try again once the machine answers.' };
            }
            tenders.push({ kind: topUp.kind, amount: money(q.balanceMinor, 'INR'), status: topUp.kind === 'cash' ? 'settled' : 'authorized' });
            topUpTenders = [{ kind: topUp.kind, amountMinor: q.balanceMinor }];
          }
          if (!settle(money(q.replacementTotalMinor, 'INR'), tenders).fullyPaid) {
            return { kind: 'invalid', laneMessage: 'The credit and the payment do not cover the replacement. Nothing was recorded.' };
          }

          // 1. The return — the credit against the bill — through the tested refund view + till (durable first).
          const exchange: ExchangeSettlementInput = {
            replacementSaleId: draft.replacementSaleId, replacementTotalMinor: q.replacementTotalMinor, appliedMinor: q.appliedMinor,
            balance: q.balance, balanceMinor: q.balanceMinor,
            ...(balanceTender === undefined ? {} : { balanceTender }),
            ...(topUpTenders === undefined ? {} : { topUpTenders }),
          };
          const approval = decidedAtTheLane({ returnId: draft.exchangeId, refundMinor: q.balanceMinor, ...(draft.approval === undefined ? {} : { approval: draft.approval }) }, cashierId);
          const credit = await refundView.submit({
            returnId: draft.exchangeId, number: draft.number, originalSale,
            reasonCode: draft.reasonCode, lines: draft.returnLines,
            refundMinor: q.returnedValueMinor, refundTender: 'exchange', exchange,
            ...(approval === undefined ? {} : { approval }),
            ...(draft.settlement.customerRef === undefined ? {} : { customerRef: draft.settlement.customerRef }),
          });
          if (!creditRecorded(credit)) return credit;

          // 2. The replacement — a real sale, paid with the credit (+ any top-up), through the same durable-first path.
          try {
            const sale = await session.commit(draft.replacementSaleId, draft.replacementReceipt, new Date().toISOString(), tenders);
            const moved = q.balance === 'even' ? 'Even exchange — nothing to pay, nothing to refund.'
              : q.balance === 'top_up' ? `Collect ₹${(q.balanceMinor / 100).toFixed(2)} from the customer.`
                : credit.kind === 'pending' ? `Refund of ₹${(q.balanceMinor / 100).toFixed(2)} sent for reversal — PENDING, do not hand over cash.`
                  : `Refund ₹${(q.balanceMinor / 100).toFixed(2)} to the customer.`;
            return {
              kind: 'done', balance: q.balance, balanceMinor: q.balanceMinor, returnedValueMinor: q.returnedValueMinor,
              refundStatus: credit.kind === 'pending' ? 'pending' : 'settled', number: credit.number, replacementReceipt: sale.number,
              laneMessage: `Exchange recorded. ${moved}`,
            };
          } catch (e) {
            const why = e !== null && typeof e === 'object' && 'laneMessage' in e && typeof (e as { laneMessage: unknown }).laneMessage === 'string'
              ? (e as { laneMessage: string }).laneMessage : String(e instanceof Error ? e.message : e);
            return {
              kind: 'half_done', number: credit.number, returnedValueMinor: q.returnedValueMinor,
              laneMessage: `The goods coming back are recorded as a credit of ₹${(q.returnedValueMinor / 100).toFixed(2)} on bill ${originalSale.number} (${credit.number}), but the replacement sale could NOT be recorded: ${why} Do not hand over the new goods — get the manager to complete the exchange.`,
            };
          }
        },
      },
    };
  };

  // The return WITHOUT a receipt (SP-9b-i · M13-FR-01). Offered only when the box GAVE a positive cap and the till has
  // a catalogue to name the item from — a till without either must not guess a limit or an item (fail safe). There is
  // no bill, so there are no prior returns to check against: the cap, the mandatory second person and the cloud's
  // own re-check on sync are the controls; the engine refuses an amount above the cap before anything is written.
  const noReceiptReturn = (): NoReceiptReturnSurface | null => {
    const capMinor = refundPolicy.noReceiptCapMinor;
    if (capMinor === undefined || !Number.isSafeInteger(capMinor) || capMinor <= 0 || catalogue === undefined) return null;
    const refundView = createRefundView({ refund: till.refund, now: () => new Date().toISOString(), policy: refundPolicy });
    return {
      capMinor,
      findProduct: (code) => {
        const product = catalogue.findProduct(code);
        return product === undefined ? null : { productId: product.productId, name: product.name, uom: product.baseUom };
      },
      needsApproval: () => true,
      submit: (draft) => {
        const cashierId = session.operator();
        if (cashierId === undefined) return Promise.resolve(nobodyAtTheTill());
        const approval = decidedAtTheLane(draft, cashierId);
        return refundView.submit({
          returnId: draft.returnId, number: draft.number, noReceipt: true,
          reasonCode: draft.reasonCode, lines: draft.lines,
          refundMinor: draft.refundMinor, refundTender: draft.refundTender,
          ...(approval === undefined ? {} : { approval }),
          ...(draft.customerRef === undefined ? {} : { customerRef: draft.customerRef }),
        });
      },
    };
  };

  const receiptTemplate = (): PosReceiptTemplate | null => config?.receiptTemplate ?? null;

  // The cashier signs in ONCE for both surfaces — the sale and the till name the same person (SP-4b · F09).
  const signIn = (cashierId: string): void => { session.signIn(cashierId); till.signIn(cashierId); };
  const signOut = (): void => { session.signOut(); till.signOut(); };
  const operator = (): string | undefined => session.operator();
  const lane = () => ({
    laneId: session.laneId() ?? null,
    tradingDayCutoff: config?.tradingDayCutoff ?? '00:00',
    tradingDayAt: (atIsoUtc: string) => session.tradingDayFor(atIsoUtc),
  });

  return Object.assign(view, { till, nextReceipt, receiptsRemaining, lookupRefund, noReceiptReturn, receiptTemplate, signIn, signOut, operator, lane });
}

// Attach for the view. `app.js` uses `window.posSession` when present and falls back to its
// stand-in when the bundle has not been built. In the browser `globalThis.window` IS the window,
// so this needs no DOM types.
const browserWindow = (globalThis as { window?: PosWindow }).window;
if (browserWindow !== undefined) {
  // Who this till IS comes from the box (SP-4b · F09): the lane it was told it is and the shop's cut-off. Who the CASHIER
  // is never comes from here — the person signs in on the screen. Nothing below invents a lane, a cashier or a day.
  const lane = browserWindow.posLane;
  browserWindow.posSession = bootPos({
    catalogue: browserWindow.posCatalogue,
    ...(lane?.laneId === undefined || lane.laneId === null || lane.laneId === '' ? {} : { laneId: lane.laneId }),
    ...(lane === undefined ? {} : { tradingDayCutoff: lane.tradingDayCutoff }),
    ...(browserWindow.posReceiptSeries === undefined ? {} : { receipt: browserWindow.posReceiptSeries }),
    ...(browserWindow.posReceiptTemplate === undefined ? {} : { receiptTemplate: browserWindow.posReceiptTemplate }),
    // The refund policy the box was given (SP-9b-i): without it the till offers no return without a receipt.
    ...(browserWindow.posRefundPolicy === undefined ? {} : { refundPolicy: browserWindow.posRefundPolicy }),
  });
}
