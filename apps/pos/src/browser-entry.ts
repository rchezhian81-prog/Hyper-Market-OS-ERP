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
 * The store computer's answer to "the next receipt number for this till" (audit PF-04 · M01-FR-02). The box issues it
 * from the lane's published range (else its own sequence for the lane, and says so) and has it on its disk before it
 * answers — so a reload, a second tab or a restart of the box never number a bill again from 1.
 */
export interface ReceiptNumberAnswer {
  readonly issued: boolean;
  readonly receiptNumber?: string;
  readonly remaining?: number;
  readonly runningLow?: boolean;
  readonly source?: 'published' | 'this_box';
  readonly refusedBecause?: string;
  readonly laneMessage?: string;
}
/** Ask for the next number under a request key; the same key re-asked gets the same number. */
export type ReceiptNumberPort = (requestKey: string) => Promise<ReceiptNumberAnswer>;

/** The till could not get a receipt number from its store computer — no money may be taken. */
export class ReceiptNumberRefusedError extends Error {
  constructor(readonly refusedBecause: string, readonly laneMessage: string) {
    super(laneMessage);
    this.name = 'ReceiptNumberRefusedError';
  }
}

const UNREACHABLE_NUMBER = 'This till cannot reach its store computer for a receipt number. Do not take money — tell the manager and use another lane.';

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
  /** The receipt template in force, injected by the edge before boot when this box has pulled one (M01-FR-02). */
  posReceiptTemplate?: PosReceiptTemplate;
  /** The refund policy the box's store pack carries — approval threshold + no-receipt cap — injected by the edge before
   *  boot (SP-9b-i · M13-FR-01). Absent when the box holds none: the till then offers NO return without a receipt. */
  posRefundPolicy?: RefundPolicy;
}

/** Where this till's edge listens. Loopback only — see ADR-0004 and `edge/store-edge/src/lane-server.ts`. */
export const DEFAULT_LANE_PORT = 8090;

/**
 * The till's SHIFT SESSION on its store computer (ADR-0020 · Wave 2b · audit PF-02): the token the box minted when the
 * cashier signed in with their staff ID and till PIN. Every money write carries it in `X-Sre-Operator`; the box refuses
 * the write before its disk unless it is live and names the person the record names. Held in memory here; the page keeps
 * it in the tab's session storage so a reload keeps the cashier — never the PIN, never anywhere else.
 */
const tillOperatorSession: { token: string | undefined } = { token: undefined };
const OPERATOR_HEADER = 'x-sre-operator';
const operatorHeaders = (): Record<string, string> => (tillOperatorSession.token === undefined ? {} : { [OPERATOR_HEADER]: tillOperatorSession.token });

/**
 * Hold (or forget) the shift session this page's lane writes carry. `bootPos`'s sign-in and resume call it; a caller that
 * drives the lane ports directly (the integration tests) signs in at the box and hands the token here.
 */
export function holdTillOperatorSession(token: string | undefined): void {
  tillOperatorSession.token = token === '' ? undefined : token;
}

/** How the box signs a cashier in, and who (if anyone) the session this till holds belongs to. */
export interface TillOperatorStatus {
  readonly signInBy: 'pin' | 'verified_sign_in';
  readonly signedIn: boolean;
  readonly userId?: string;
  readonly displayName?: string;
  readonly expiresAt?: string;
}
export type TillSignInOutcome =
  | { readonly signedIn: true; readonly token: string; readonly userId: string; readonly displayName: string; readonly expiresAt: string }
  | { readonly signedIn: false; readonly refusedBecause?: string; readonly laneMessage: string };

/** The till's three operator calls to its box (injectable for tests). */
export interface TillOperatorPort {
  status(token: string | undefined): Promise<TillOperatorStatus | null>;
  signIn(input: { readonly staffId?: string; readonly pin?: string }): Promise<TillSignInOutcome>;
  signOut(token: string | undefined): Promise<void>;
}

const UNREACHABLE_SIGN_IN = 'This till cannot reach its store computer, so nobody can sign in. Tell the manager.';
/** The hosted copy's front answers for itself before the box is asked: no sign-in, or a person who may not sell. */
const FRONT_REFUSED: Readonly<Record<number, { readonly refusedBecause: string; readonly laneMessage: string }>> = {
  401: { refusedBecause: 'not_signed_in', laneMessage: 'Your sign-in has ended. Sign in again, then come back to the till.' },
  403: { refusedBecause: 'no_till_authority', laneMessage: 'This person is not allowed to work a till in this shop. Ask the manager.' },
};

/** The operator calls over this till's own lane socket (or the hosted copy's same-origin base). */
export function laneOperator(port: number = DEFAULT_LANE_PORT): TillOperatorPort {
  return {
    status: async (token) => {
      try {
        const response = await fetch(`${laneBase(port)}/lane/operator`, { headers: token === undefined ? {} : { [OPERATOR_HEADER]: token } });
        if (!response.ok) return null;
        return await response.json() as TillOperatorStatus;
      } catch { return null; }
    },
    signIn: async (input) => {
      try {
        const response = await fetch(`${laneBase(port)}/lane/operator/sign-in`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...(input.staffId === undefined ? {} : { staffId: input.staffId }), ...(input.pin === undefined ? {} : { pin: input.pin }) }),
        });
        const front = FRONT_REFUSED[response.status];
        if (front !== undefined) return { signedIn: false, ...front };
        const body = await response.json() as { signedIn?: boolean; refusedBecause?: string; laneMessage?: string };
        return body.signedIn === true ? body as unknown as TillSignInOutcome : { signedIn: false, ...(typeof body.refusedBecause === 'string' ? { refusedBecause: body.refusedBecause } : {}), laneMessage: body.laneMessage ?? UNREACHABLE_SIGN_IN };
      } catch {
        return { signedIn: false, refusedBecause: 'lane_unreachable', laneMessage: UNREACHABLE_SIGN_IN };
      }
    },
    signOut: async (token) => {
      try {
        await fetch(`${laneBase(port)}/lane/operator/sign-out`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { [OPERATOR_HEADER]: token }) }, body: '{}',
        });
      } catch { /* the box will end the session at its expiry; the till forgets it now */ }
    },
  };
}

/** What a manager's approval at the till is for (ADR-0021): the kind, the bill (not for a no-receipt return) and the amount. */
export type TillApprovalKind = 'refund' | 'no_receipt_return' | 'exchange_refund';
export interface TillApprovalRequest {
  readonly managerId: string;
  readonly pin: string;
  readonly kind: TillApprovalKind;
  readonly billRef?: string;
  readonly valueMinor: number;
  readonly reason: string;
}
export type TillApprovalOutcome =
  | { readonly approved: true; readonly approvalId: string; readonly approvedBy: string; readonly displayName: string; readonly expiresAt: string }
  | { readonly approved: false; readonly refusedBecause?: string; readonly laneMessage: string };
/** The till's approval call to its box (injectable for tests). */
export interface TillApprovalPort {
  grant(request: TillApprovalRequest): Promise<TillApprovalOutcome>;
}

const UNREACHABLE_APPROVAL = 'This till cannot reach its store computer, so a manager cannot approve here. Do not give money back — tell the manager.';

/**
 * A manager approves at this till (ADR-0021): the manager's staff ID and their own till PIN go to the store computer,
 * which checks them itself and issues an approval bound to this one refund. The cashier's session goes with it — the
 * box issues approvals only to a till someone is signed in at, and never to that same person.
 */
export function laneApprovals(port: number = DEFAULT_LANE_PORT): TillApprovalPort {
  return {
    grant: async (request) => {
      try {
        const response = await fetch(`${laneBase(port)}/lane/approvals`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify(request),
        });
        const front = FRONT_REFUSED[response.status];
        if (front !== undefined) return { approved: false, ...front };
        const body = await response.json() as { approved?: boolean; refusedBecause?: string; laneMessage?: string };
        return body.approved === true
          ? body as unknown as TillApprovalOutcome
          : { approved: false, ...(typeof body.refusedBecause === 'string' ? { refusedBecause: body.refusedBecause } : {}), laneMessage: body.laneMessage ?? UNREACHABLE_APPROVAL };
      } catch {
        return { approved: false, refusedBecause: 'lane_unreachable', laneMessage: UNREACHABLE_APPROVAL };
      }
    },
  };
}

/** A basket the store computer is holding for this till (audit PF-05). */
export interface HeldBasket {
  readonly billId: string;
  readonly laneId: string;
  readonly cashierId: string;
  readonly heldAt: string;
  readonly lineCount: number;
  readonly valueMinor: number;
  readonly firstItem: string;
  readonly reason?: string;
}
/** What the store computer said to a hold, a recall or a give-up. */
export interface HeldAnswer {
  readonly ok: boolean;
  readonly refusedBecause?: string;
  readonly laneMessage: string;
  readonly billId?: string;
  /** On a recall: the basket was held past the shop's price window — check every price before taking money. */
  readonly repriceRequired?: boolean;
}
/** The held-basket calls to this till's own store computer. */
export interface HeldBillsPort {
  hold(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(): Promise<readonly HeldBasket[]>;
  recall(billId: string): Promise<Record<string, unknown>>;
  abandon(billId: string, reason: string): Promise<Record<string, unknown>>;
}
type SuspendedLineShape = Parameters<PosSession['restoreHeld']>[0][number];
type SuspendedAgeShape = NonNullable<Parameters<PosSession['restoreHeld']>[1]>[number];
const UNREACHABLE_HOLD = 'This till cannot reach its store computer, so the basket was not held. It is still on the till — do not clear it.';

/** Held baskets on this till's own store computer (audit PF-05), asked with the cashier's session. */
export function laneHeldBills(port: number = DEFAULT_LANE_PORT): HeldBillsPort {
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    try {
      const response = await fetch(`${laneBase(port)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify(body) });
      const front = FRONT_REFUSED[response.status];
      if (front !== undefined) return { ...front };
      return await response.json() as Record<string, unknown>;
    } catch {
      return { refusedBecause: 'lane_unreachable', laneMessage: UNREACHABLE_HOLD };
    }
  };
  return {
    hold: (body) => post('/lane/held-bills', body),
    recall: (billId) => post('/lane/held-bills/recall', { billId }),
    abandon: (billId, reason) => post('/lane/held-bills/abandon', { billId, reason }),
    list: async () => {
      try {
        const response = await fetch(`${laneBase(port)}/lane/held-bills`, { headers: operatorHeaders() });
        const body = await response.json() as { held?: HeldBasket[] };
        return Array.isArray(body.held) ? body.held : [];
      } catch {
        return [];
      }
    },
  };
}

/** The store computer's answer about one card/UPI attempt (audit PF-06). */
export interface CardAttemptAnswer {
  readonly ok: boolean;
  readonly refusedBecause?: string;
  readonly laneMessage: string;
  readonly attemptId?: string;
  /** asked · approved · declined · no_answer · recovered_paid · recovered_not_paid */
  readonly state?: string;
  readonly amountMinor?: number;
}
/** The card/UPI attempt calls to this till's own store computer. */
export interface PaymentAttemptsPort {
  ask(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  answer(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  recover(body: Record<string, unknown>): Promise<Record<string, unknown>>;
}
const UNREACHABLE_PAYMENT = 'This till cannot reach its store computer, so the payment was not recorded. Do not ask the card machine — take cash or use another lane.';

/** Card/UPI attempts on this till's own store computer (audit PF-06), asked with the cashier's session. */
export function lanePaymentAttempts(port: number = DEFAULT_LANE_PORT): PaymentAttemptsPort {
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const once = async (): Promise<Record<string, unknown>> => {
      const response = await fetch(`${laneBase(port)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify(body) });
      const front = FRONT_REFUSED[response.status];
      if (front !== undefined) return { ok: false, ...front };
      return await response.json() as Record<string, unknown>;
    };
    // Every call is safe to repeat (the attempt id is its identity), so a reply lost on the way back is asked once more.
    try { return await once(); } catch {
      try { return await once(); } catch { return { ok: false, refusedBecause: 'lane_unreachable', laneMessage: UNREACHABLE_PAYMENT }; }
    }
  };
  return {
    ask: (body) => post('/lane/payment-attempts', body),
    answer: (body) => post('/lane/payment-attempts/answer', body),
    recover: (body) => post('/lane/payment-attempts/recover', body),
  };
}

/** A request key for one number: unique to this ask, re-sent unchanged only when the reply was lost. */
function newRequestKey(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `rq-${Date.now().toString(36)}-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The next receipt number from this till's own store computer (audit PF-04). Asked with the cashier's session; a reply
 * lost on the way back is asked again ONCE with the same request key, which the box answers with the same number.
 */
export function laneReceiptNumbers(port: number = DEFAULT_LANE_PORT): ReceiptNumberPort {
  const ask = async (requestKey: string): Promise<ReceiptNumberAnswer> => {
    const response = await fetch(`${laneBase(port)}/lane/receipt-numbers`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify({ requestKey }),
    });
    const front = FRONT_REFUSED[response.status];
    if (front !== undefined) return { issued: false, ...front };
    return await response.json() as ReceiptNumberAnswer;
  };
  return async (requestKey) => {
    try {
      return await ask(requestKey);
    } catch {
      try {
        return await ask(requestKey);
      } catch {
        return { issued: false, refusedBecause: 'lane_unreachable', laneMessage: UNREACHABLE_NUMBER };
      }
    }
  };
}

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
          // The shift session (ADR-0020): the box writes nothing a signed-in cashier did not send.
          headers: { 'content-type': 'application/json', ...operatorHeaders() },
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
        // The same base a sale uses: the store's loopback, or the hosted copy's signed-in `/store-lane` (it was the loopback
        // only, so the hosted till's float and close never reached its box).
        const response = await fetch(`${laneBase(port)}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify(req),
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
      const response = await fetch(`${laneBase(port)}/lane/till-cash`);
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
  /** The manager's approval: who and why, and the approval the store computer issued for it (ADR-0021). */
  readonly approval?: { readonly by: string; readonly reason: string; readonly approvalId?: string };
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
    readonly topUp?: { readonly kind: 'cash' | 'card' | 'upi'; readonly outcome?: 'approved' | 'declined' | 'no_answer'; readonly ref?: string };
  };
  readonly approval?: { readonly by: string; readonly reason: string; readonly approvalId?: string };
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
  /** The till's receipt-number call to its box (audit PF-04). Overridable for tests; production asks this till's own edge. */
  receiptNumbers?: ReceiptNumberPort;
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
  /** The till's operator calls to its box (ADR-0020). Overridable for tests; production asks this till's own edge. */
  operatorPort?: TillOperatorPort;
  /** The till's manager-approval call to its box (ADR-0021). Overridable for tests; production asks this till's own edge. */
  approvalPort?: TillApprovalPort;
  /** The till's held-basket calls to its box (audit PF-05). Overridable for tests; production asks this till's own edge. */
  heldBillsPort?: HeldBillsPort;
  /** The till's card/UPI attempt calls to its box (audit PF-06). Overridable for tests; production asks this till's own edge. */
  paymentsPort?: PaymentAttemptsPort;
  /** The till's void-evidence call to its box (audit PF-07). Overridable for tests; production posts to this till's own edge. */
  tillActivityPost?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): PosView & {
  readonly till: ReturnType<typeof createTillSession>;
  /**
   * The next receipt number for this lane, from the store computer (audit PF-04): saved on the box before it is given,
   * so a reload or a second tab never repeats one. Rejects with `ReceiptNumberRefusedError` (the range is spent, nobody
   * is signed in, the box cannot save or cannot be reached) — the caller must then take no money.
   */
  readonly nextReceipt: () => Promise<string>;
  /** How many numbers the box said are left in this lane's range at the last answer; `undefined` before the first. */
  readonly receiptsRemaining: () => number | undefined;
  /** What the box said about the numbers at the last answer (running low, or no range published) — or `undefined`. */
  readonly receiptNotice: () => string | undefined;
  /** Look up a bill this lane rang, for the refund screen — or `null` if it did not ring it. */
  readonly lookupRefund: (receipt: string) => Promise<RefundLookup | null>;
  /** The return-without-a-receipt surface (SP-9b-i · M13-FR-01) — or `null` when this till may not offer one: no
   *  no-receipt cap was given (or it is 0, switched off), or the till has no catalogue to name the item from. */
  readonly noReceiptReturn: () => NoReceiptReturnSurface | null;
  /** The receipt template this lane prints with — header, footer and the version to stamp — or `null` when none
   *  has reached this box (print with defaults, stamp nothing). Read from the box's pack, never fetched at print time. */
  readonly receiptTemplate: () => PosReceiptTemplate | null;
  /**
   * Name the person at the till in the MODEL (the sale session and the till). The screen never calls this with a typed
   * code: it calls `signInAtTill`, which calls this only with the person the store computer verified (ADR-0020). Kept for
   * the model's own tests, whose durable write is a double rather than a box.
   */
  readonly signIn: (cashierId: string) => void;
  /** Sign in through the store computer: staff ID + till PIN (or, on the hosted copy, the verified sign-in). */
  readonly signInAtTill: (input: { readonly staffId?: string; readonly pin?: string }) => Promise<TillSignInOutcome>;
  /** After a reload: ask the box whether the session this tab kept is still live, and name its person if so. */
  readonly resumeAtTill: (token: string) => Promise<boolean>;
  /** End the session on the box and forget it here. */
  readonly signOutAtTill: () => Promise<void>;
  /** How this box signs a cashier in — `pin`, or the hosted copy's `verified_sign_in`; `null` when the box did not answer. */
  readonly tillSignInBy: () => Promise<'pin' | 'verified_sign_in' | null>;
  /** The session token this tab holds, for the page to keep across a reload (never the PIN). */
  readonly operatorToken: () => string | undefined;
  /**
   * A manager approves here, with their own till PIN, for exactly this refund (ADR-0021). The store computer checks the
   * PIN and the manager's authority and issues the approval the refund then carries; refused in the cashier's words.
   */
  readonly approveAtTill: (request: TillApprovalRequest) => Promise<TillApprovalOutcome>;
  /**
   * Hold this basket ON THE STORE COMPUTER (audit PF-05): it is on the box's disk before the till clears, so a reload,
   * a closed tab or a power cut cannot lose it. Refused (nothing cleared) when the box cannot keep it.
   */
  readonly holdAtTill: (reason?: string) => Promise<HeldAnswer>;
  /** The baskets this till may recall, oldest first — what the box holds, not what this tab remembers. */
  readonly heldAtTill: () => Promise<readonly HeldBasket[]>;
  /** Recall one held basket onto this (empty) till. A claim: the box gives it to one till, once. */
  readonly recallAtTill: (billId: string) => Promise<HeldAnswer>;
  /** Give a held basket up, with a reason — kept on the box's record, never deleted. */
  readonly abandonAtTill: (billId: string, reason: string) => Promise<HeldAnswer>;
  /**
   * Record a card or UPI payment on the store computer BEFORE the machine is asked (audit PF-06). The answer's
   * `attemptId` is the reference the machine is given. Refused while this bill has a payment that got no answer
   * (`unresolved_payment_on_this_bill` — check it with `checkCardPayment`), and when the bill already has a confirmed
   * payment (`already_paid_on_this_bill` — pay with it, do not ask the machine again).
   */
  readonly startCardPayment: (kind: 'card' | 'upi', amountMinor?: number) => Promise<CardAttemptAnswer>;
  /** What the machine said, recorded on the store computer. On `approved`, pay with `tenderCardOrUpi({ ..., ref: attemptId })`. */
  readonly answerCardPayment: (attemptId: string, outcome: 'approved' | 'declined' | 'no_answer') => Promise<CardAttemptAnswer>;
  /** Settle a payment that got no answer against the PROVIDER's record — never by hand. */
  readonly checkCardPayment: (attemptId: string) => Promise<CardAttemptAnswer>;
  /**
   * Void a line WITH evidence (audit PF-07): the line, its value and the reason go to the store computer — stamped with
   * the cashier it verified, queued for head office's loss-prevention record — and the line is removed only once the
   * box has it. Refused (the line stays) when the box cannot keep it.
   */
  readonly voidAtTill: (lineId: string, reason: string) => Promise<{ readonly ok: boolean; readonly refusedBecause?: string; readonly laneMessage: string }>;
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
      // SF-01: offers are judged against this lane's own clock — no network, no fixed date.
      clock: () => new Date().toISOString(),
    },
    new Ledger(new InMemoryLedgerStore()),
    outbox,
    config?.durable ?? laneDurable(config?.lanePort ?? DEFAULT_LANE_PORT),
  );
  // Indexing happens once at boot, so every subsequent scan is O(1) (§32).
  const catalogue = config?.catalogue ? new CatalogueCache(config.catalogue) : undefined;
  // SF-01: the switched-on offers the signed pack carried — applied at checkout from the lane's own copy (P-01).
  session.loadPromotions(config?.catalogue?.promotions ?? []);
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

  // Receipt numbering (audit PF-04 · M01-FR-02). The store computer issues each number and has it on its disk before the
  // till hears it, so a reload, a second tab or a restart continue from where the box is — never from 1, never a
  // timestamp. A refusal (range spent, nobody signed in, the box cannot save) means no money is taken.
  const receiptNumbers = config?.receiptNumbers ?? laneReceiptNumbers(config?.lanePort ?? DEFAULT_LANE_PORT);
  let lastNumberAnswer: ReceiptNumberAnswer | undefined;
  const nextReceipt = async (): Promise<string> => {
    const answer = await receiptNumbers(newRequestKey());
    if (answer.issued !== true || typeof answer.receiptNumber !== 'string' || answer.receiptNumber === '') {
      throw new ReceiptNumberRefusedError(answer.refusedBecause ?? 'not_issued', answer.laneMessage ?? UNREACHABLE_NUMBER);
    }
    lastNumberAnswer = answer;
    return answer.receiptNumber;
  };
  const receiptsRemaining = (): number | undefined => lastNumberAnswer?.remaining;
  const receiptNotice = (): string | undefined => lastNumberAnswer?.laneMessage;

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
    draft: { readonly returnId: string; readonly refundMinor: number; readonly approval?: { readonly by: string; readonly reason: string; readonly approvalId?: string } },
    cashierId: string,
  ): DecidedRequest | undefined => (draft.approval === undefined ? undefined : {
    // The store computer's approval id when it issued one (ADR-0021) — the record carries it and the box spends it.
    id: draft.approval.approvalId ?? `ovr-${draft.returnId}`, subjectType: 'pos.return', subjectRef: draft.returnId,
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
            tenders.push({ kind: topUp.kind, amount: money(q.balanceMinor, 'INR'), status: topUp.kind === 'cash' ? 'settled' : 'authorized', ...(topUp.ref === undefined ? {} : { ref: topUp.ref }) });
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

  // HELD BASKETS (audit PF-05): the basket goes to the store computer's disk; the till clears only once the box has it.
  const held = config?.heldBillsPort ?? laneHeldBills(config?.lanePort ?? DEFAULT_LANE_PORT);
  const answer = (r: Record<string, unknown>, ok: boolean, fallback: string): HeldAnswer => ({
    ok,
    laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : fallback,
    ...(typeof r['refusedBecause'] === 'string' ? { refusedBecause: r['refusedBecause'] } : {}),
    ...(typeof r['billId'] === 'string' ? { billId: r['billId'] } : {}),
  });
  const holdAtTill = async (reason?: string): Promise<HeldAnswer> => {
    if (session.operator() === undefined) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('hold a basket').laneMessage };
    const basket = session.basketToHold();
    if (basket.lines.length === 0) return { ok: false, refusedBecause: 'empty_basket', laneMessage: 'There is nothing in the basket to hold.' };
    // The basket's own id: a re-sent hold after a lost reply is the same hold, never a second copy.
    const billId = `H-${session.laneId() ?? 'lane'}-${newRequestKey().slice(3)}`;
    const now = new Date().toISOString();
    const body = { billId, lines: basket.lines, ageAnswers: basket.ageAnswers, tradingDay: session.tradingDayFor(now), ...(reason === undefined || reason.trim() === '' ? {} : { reason }) };
    let r = await held.hold(body);
    if (r['refusedBecause'] === 'lane_unreachable') r = await held.hold(body);
    if (r['held'] !== true) return answer(r, false, UNREACHABLE_HOLD);
    session.newSale();
    return answer(r, true, 'Basket held.');
  };
  const heldAtTill = (): Promise<readonly HeldBasket[]> => held.list();
  const recallAtTill = async (billId: string): Promise<HeldAnswer> => {
    if (session.operator() === undefined) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('recall a basket').laneMessage };
    if (session.basketToHold().lines.length > 0) return { ok: false, refusedBecause: 'basket_not_empty', laneMessage: 'Finish or hold the basket on the till first — a recalled basket never joins another customer\'s.' };
    const r = await held.recall(billId);
    const bill = r['bill'] as { lines?: SuspendedLineShape[]; ageAnswers?: SuspendedAgeShape[] } | undefined;
    if (r['recalled'] !== true || bill === undefined || !Array.isArray(bill.lines)) return answer(r, false, 'The store computer did not give the basket back. It is still held.');
    session.restoreHeld(bill.lines, Array.isArray(bill.ageAnswers) ? bill.ageAnswers : []);
    return { ...answer(r, true, 'Basket recalled.'), billId, ...(r['repriceRequired'] === true ? { repriceRequired: true } : {}) };
  };
  // VOIDS AS EVIDENCE (audit PF-07): on the store computer before the line goes.
  const voidAtTill = async (lineId: string, reason: string): Promise<{ readonly ok: boolean; readonly refusedBecause?: string; readonly laneMessage: string }> => {
    if (session.operator() === undefined) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('void a line').laneMessage };
    const line = view.basket().find((l) => l.lineId === lineId);
    if (line === undefined) return { ok: false, refusedBecause: 'no_such_line', laneMessage: 'That line is not on the bill.' };
    if (reason.trim() === '') return { ok: false, refusedBecause: 'reason_required', laneMessage: 'A void needs a reason.' };
    const body = {
      activityId: `V-${newRequestKey().slice(3)}`, kind: 'void', billRef: session.billRef(), lineId, productId: line.productId,
      description: line.description, valueMinor: line.unitPriceMinor * line.qty, reason,
    };
    const post = async (): Promise<Record<string, unknown>> => {
      const base = laneBase(config?.lanePort ?? DEFAULT_LANE_PORT);
      const response = await fetch(`${base}/lane/till-activity`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify(body) });
      const front = FRONT_REFUSED[response.status];
      if (front !== undefined) return { recorded: false, ...front };
      return await response.json() as Record<string, unknown>;
    };
    let r: Record<string, unknown>;
    try { r = await (config?.tillActivityPost ?? post)(body); } catch {
      try { r = await (config?.tillActivityPost ?? post)(body); } catch {
        return { ok: false, refusedBecause: 'lane_unreachable', laneMessage: 'This till cannot reach its store computer, so the void was not recorded. The line stays on the bill.' };
      }
    }
    if (r['recorded'] !== true) {
      return { ok: false, ...(typeof r['refusedBecause'] === 'string' ? { refusedBecause: r['refusedBecause'] } : {}), laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : 'The void was not recorded. The line stays on the bill.' };
    }
    view.voidLine(lineId, reason);
    return { ok: true, laneMessage: 'Line voided.' };
  };

  // CARD AND UPI (audit PF-06): the attempt is on the store computer before the machine is asked.
  const payments = config?.paymentsPort ?? lanePaymentAttempts(config?.lanePort ?? DEFAULT_LANE_PORT);
  const cardAnswer = (r: Record<string, unknown>): CardAttemptAnswer => {
    const a = (r['attempt'] ?? {}) as { attemptId?: unknown; state?: unknown; amountMinor?: unknown };
    return {
      ok: r['ok'] === true,
      laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : UNREACHABLE_PAYMENT,
      ...(typeof r['refusedBecause'] === 'string' ? { refusedBecause: r['refusedBecause'] } : {}),
      ...(typeof a.attemptId === 'string' ? { attemptId: a.attemptId } : {}),
      ...(typeof a.state === 'string' ? { state: a.state } : {}),
      ...(typeof a.amountMinor === 'number' ? { amountMinor: a.amountMinor } : {}),
    };
  };
  // The amount is the bill's payable, or — for an exchange's top-up — the difference the customer pays.
  const startCardPayment = async (kind: 'card' | 'upi', amountOverride?: number): Promise<CardAttemptAnswer> => {
    if (session.operator() === undefined) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('take a card payment').laneMessage };
    const amountMinor = amountOverride ?? session.totals().payable.minor;
    if (amountMinor <= 0) return { ok: false, refusedBecause: 'nothing_to_pay', laneMessage: 'There is nothing to pay.' };
    return cardAnswer(await payments.ask({ attemptId: `PAY-${newRequestKey().slice(3)}`, billRef: session.billRef(), kind, amountMinor }));
  };
  const answerCardPayment = async (attemptId: string, outcome: 'approved' | 'declined' | 'no_answer'): Promise<CardAttemptAnswer> =>
    cardAnswer(await payments.answer({ attemptId, outcome }));
  const checkCardPayment = async (attemptId: string): Promise<CardAttemptAnswer> => cardAnswer(await payments.recover({ attemptId }));

  const abandonAtTill = async (billId: string, reason: string): Promise<HeldAnswer> => {
    const r = await held.abandon(billId, reason);
    return answer(r, r['abandoned'] === true, 'The basket was not given up.');
  };

  // WHO IS AT THE TILL, verified by the store computer (ADR-0020). The model is told the person only once the box has
  // said who they are; the box then binds every money write to the session.
  const operators = config?.operatorPort ?? laneOperator(config?.lanePort ?? DEFAULT_LANE_PORT);
  const signInAtTill = async (input: { readonly staffId?: string; readonly pin?: string }): Promise<TillSignInOutcome> => {
    const outcome = await operators.signIn(input);
    if (outcome.signedIn) {
      tillOperatorSession.token = outcome.token;
      signIn(outcome.userId);
    }
    return outcome;
  };
  const resumeAtTill = async (token: string): Promise<boolean> => {
    const status = await operators.status(token);
    if (status?.signedIn === true && typeof status.userId === 'string') {
      tillOperatorSession.token = token;
      signIn(status.userId);
      return true;
    }
    return false;
  };
  const signOutAtTill = async (): Promise<void> => {
    const token = tillOperatorSession.token;
    tillOperatorSession.token = undefined;
    signOut();
    await operators.signOut(token);
  };
  const tillSignInBy = async (): Promise<'pin' | 'verified_sign_in' | null> => (await operators.status(undefined))?.signInBy ?? null;
  const operatorToken = (): string | undefined => tillOperatorSession.token;
  const approvals = config?.approvalPort ?? laneApprovals(config?.lanePort ?? DEFAULT_LANE_PORT);
  const approveAtTill = async (request: TillApprovalRequest): Promise<TillApprovalOutcome> => {
    // Nobody signed in → no cashier to ask for it; the box would refuse too, this says so without a round trip.
    if (session.operator() === undefined) return { approved: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('ask for an approval').laneMessage };
    return approvals.grant(request);
  };
  const lane = () => ({
    laneId: session.laneId() ?? null,
    tradingDayCutoff: config?.tradingDayCutoff ?? '00:00',
    tradingDayAt: (atIsoUtc: string) => session.tradingDayFor(atIsoUtc),
  });

  return Object.assign(view, { till, nextReceipt, receiptsRemaining, receiptNotice, holdAtTill, heldAtTill, recallAtTill, abandonAtTill, startCardPayment, answerCardPayment, checkCardPayment, voidAtTill, lookupRefund, noReceiptReturn, receiptTemplate, signIn, signOut, operator, lane, signInAtTill, resumeAtTill, signOutAtTill, tillSignInBy, operatorToken, approveAtTill });
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
    ...(browserWindow.posReceiptTemplate === undefined ? {} : { receiptTemplate: browserWindow.posReceiptTemplate }),
    // The refund policy the box was given (SP-9b-i): without it the till offers no return without a receipt.
    ...(browserWindow.posRefundPolicy === undefined ? {} : { refundPolicy: browserWindow.posRefundPolicy }),
  });
}
