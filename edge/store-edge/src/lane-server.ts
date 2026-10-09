// The socket between the till's screen and the till's disk — P-01, hard rule #1, ADR-0004.
//
// The POS is a web shell and a browser cannot call `fsync`. The disk belongs to the edge process,
// which is why `PosSession` takes the durable write as a port — and until this file, that port had
// nothing on the other side of it. The shell's default was a refusal, which was honest and meant a
// lane could not take money.
//
// ── Loopback first, then server-side authorization ──────────────────────────
//
// This binds to `127.0.0.1`. Not `0.0.0.0`, not the machine's LAN address: the lane's browser and
// the lane's edge are the same machine (ADR-0004), so nothing off that machine can reach the socket,
// and no device on the shop wifi — a customer's phone included — can post into the till's log.
//
// The bind is necessary but **not sufficient**, and an earlier version of this file wrongly treated
// it (with CORS response headers) as the whole control. A page open in the till's own browser is ON
// this machine: it can issue a cross-origin request to loopback, and a CORS *simple* request — one
// carrying `text/plain` — is delivered with no preflight. The server then wrote the record and only
// the missing CORS header stopped the attacker reading the reply, which is too late: the durable
// mutation already happened (review finding RR-F01). CORS is a control on reading a reply in a
// browser; it is not authorization to mutate.
//
// So authorization is now decided **server-side, before the body is read or anything is written**
// (`laneCallRefusal`): a foreign `Origin` is refused (403), and the content type must be
// `application/json` (415 otherwise) — the one type a cross-origin caller cannot send without a
// preflight this socket refuses for non-loopback origins. A request with no `Origin` (a same-origin
// call, or a non-browser client already on this machine) is allowed with the right content type: an
// attacker who can forge headers from a shell on the till is already inside the trust boundary the
// loopback bind draws, and a shared secret in the same browser would buy nothing against them.
//
// ── The screen and the socket are the same machine but not the same port ────
//
// The till's screen is served on one loopback port (the screens server) and this write socket is on
// another. A browser treats two ports as two ORIGINS, so the screen's `fetch` to this socket is a
// cross-origin request, and a cross-origin POST carrying JSON is one the browser refuses to send at
// all unless this socket answers the preflight `OPTIONS` first and names the caller's origin back.
// The first version answered neither — it hard-coded `access-control-allow-origin: null` and ignored
// `OPTIONS` — so a real browser till could never post a sale, only the in-process tests could. That
// is the same class of "every piece works apart, the join was never exercised in a browser" gap the
// sale-to-books seam was.
//
// So this permits a cross-origin call **from a loopback origin only** — `127.0.0.1`, `localhost` or
// `[::1]`, on any port. That is not a widening of the security control: the bind address already
// means nothing off this machine can reach the socket at all, and every loopback origin is by
// definition another page on this same till. A request from any other origin gets no allow header,
// so the browser blocks it — belt to the bind's braces.
//
// ── Why it is otherwise deliberately tiny ───────────────────────────────────
//
// Two write routes, one method. Everything this server can do is commit a sale — or a refund — that
// has already been priced and settled by the tested session model. It holds no pricing, no tender
// rules and no catalogue: adding any of them would put a second, untested copy of the shop's rules on
// the far side of a socket from the first. `/lane/returns` is the exact mirror of `/lane/sales`: the
// refund is durable on the disk before the lane calls it done, then queued for the cloud (M13-FR-01).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LaneSyncStatus } from './sync-status';
import { returnIdOf, toCloudReturn } from './cloud-return';
import { toCloudSale } from './cloud-sale';
import type { OperatorStamp, TillSealSubject } from '../../../packages/identity/src/till-seal';
import { concessionTagIdOf } from './cloud-concession-tag';
import type { EdgeNode } from './index';
import {
  DEVICE_OUTBOX_PATH, DEVICE_OUTBOX_STATUS_PATH, readRelayBatch,
  type BoxItemStatus, type RelayReply,
} from '../../../packages/sync/src/device-relay';
import type {
  CashMovementRequest, CashMovementOutcome, ShiftCloseRequest, ShiftCloseOutcome, TillCashStatus, CountedDenomination,
} from './till-cash';
import type { CashMovementKind } from '../../../packages/cash/src/cash';
import { OPERATOR_HEADER, type CheckOutcome, type SignInOutcome } from './till-operators';
import type { GrantOutcome, ReturnCheck } from './till-approvals';
import type { IssueOutcome, ReceiptNumberStatus, UseCheck } from './receipt-numbers';
import type { HoldOutcome, RecallOutcome, HeldSummary } from './held-bills';

/** The one address this may listen on. Named so the test can assert on it. */
export const LANE_HOST = '127.0.0.1';

/** The write routes this socket serves — a sale, and a refund. Both loopback-only, both POST. */
const LANE_ROUTES = ['/lane/sales', '/lane/returns', '/lane/concession-tags'] as const;

/**
 * The one READ route: look up a bill this lane rang, for the refund screen (M13-FR-01). A GET, so it
 * mutates nothing — the RR-F01 "a text/plain write slipped through" problem cannot arise, because
 * there is no write. It returns a customer's bill, so it is still restricted to a loopback origin
 * (another page on this same till): a foreign origin is refused outright rather than relying on the
 * browser to withhold the reply. Read-only and loopback-only.
 */
const LANE_LOOKUP_ROUTE = '/lane/lookup';

/**
 * The DAY-CLOSE write route: POST /lane/day-close (M14-FR-04). The manager's screen asks the box to
 * close and LOCK the trading day. The DECISION is the box's — `edge.closeDay` reads the live outbox
 * depths and the exception register; this socket only relays the request under the same loopback +
 * application/json authorization the sale and refund routes use (RR-F01). Distinct from those because
 * its body is `{ dayCloseId, closedBy }`, not a sale/refund record with an id of its own.
 */
const LANE_DAY_CLOSE_ROUTE = '/lane/day-close';

/**
 * The DAY-REOPEN write route: POST /lane/day-reopen (M14-FR-04 / §28). An accountant/owner's screen asks
 * the box to REOPEN a locked trading day. The DECISION is the box's — `edge.reopenDay` enforces §28 (the
 * approver must be a different person than the reopener) and appends a compensating reopen to the durable
 * day-close log. Its body is `{ dayCloseId, reopenedBy, reason, approvedBy }`.
 */
const LANE_DAY_REOPEN_ROUTE = '/lane/day-reopen';
/**
 * The STATUS read route (Stage G slice 2 · design system §1 rule 4). The box's own account of its link to head
 * office — cloud reachability, everything still unsent across its queues, dead letters, when something last got
 * through — so the sync badge on the till and the manager screens shows a fact instead of a constant.
 * Not exported: the edge's public surface offers the lane nothing whose name suggests a network path (hard rule #1 —
 * tests/unit/store-edge.test.ts); the screens and the tests use the literal path.
 */
const LANE_SYNC_STATUS_ROUTE = '/lane/sync-status';

/**
 * The DEVICE OUTBOX write route: POST /lane/outbox (SP-2a · F11 · §31). A screen or handheld hands the box a
 * batch of work it did on its own device — an approval decided on the manager's screen first — and the box
 * answers PER ITEM: accepted (durable on the box's disk and queued for head office), duplicate (already held —
 * a retry after a lost reply lands here, one effect), refused (not a record this box relays; a person must
 * look), or not_saved (the box could not write it; the device keeps it). The same loopback + application/json
 * authorization as every other write, decided BEFORE the body is read (RR-F01). The DECISION of what to accept
 * is the box's (`relayDeviceEvents` — the allow-list, the dedupe set and the fsync'd log live there); this
 * socket carries the batch. Its companion GET /lane/outbox/status?keys= answers where accepted items have got
 * to (pending on the box · posted at head office · refused), so a screen can say so instead of guessing.
 */
const LANE_DEVICE_OUTBOX_ROUTE: string = DEVICE_OUTBOX_PATH;
const LANE_DEVICE_OUTBOX_STATUS_ROUTE: string = DEVICE_OUTBOX_STATUS_PATH;

/**
 * The till's CASH routes (SP-4c · F10 · M14-FR-01/02). `POST /lane/cash-movements` records a float, loan, pickup or safe
 * drop; `POST /lane/shift-close` closes the shift against the cashier's blind count; `GET /lane/till-cash` says whether a
 * float is out and who holds it. The DECISIONS are the box's (`recordCashMovement` / `closeShift` in main.ts: the chain,
 * the figures, the day, the durable write); this socket carries the requests under the same loopback + application/json
 * authorization as every other write (RR-F01). None of the three ever answers a balance or an expected figure — the
 * drawer is counted blind (M14-FR-02).
 */
const LANE_CASH_MOVEMENTS_ROUTE = '/lane/cash-movements';
const LANE_SHIFT_CLOSE_ROUTE = '/lane/shift-close';
const LANE_TILL_CASH_ROUTE = '/lane/till-cash';

/**
 * WHO IS AT THE TILL (ADR-0020 · Wave 2b · audit PF-02). `GET /lane/operator` says how this box signs a person in and
 * whether the session the till holds is live; `POST /lane/operator/sign-in` takes a staff ID and a till PIN (or, on the
 * hosted copy only, the verified sign-in the front passes on) and answers with a session; `POST /lane/operator/sign-out`
 * ends it. Every money write below then carries the session in `X-Sre-Operator`, and the box refuses it BEFORE the disk
 * unless the session is live and names the person the record names.
 */
const LANE_OPERATOR_ROUTE = '/lane/operator';
const LANE_OPERATOR_SIGN_IN_ROUTE = '/lane/operator/sign-in';
const LANE_OPERATOR_SIGN_OUT_ROUTE = '/lane/operator/sign-out';
/**
 * A MANAGER'S APPROVAL at this till (ADR-0021): `POST /lane/approvals` with the manager's staff ID and own till PIN and
 * what it is for. The box issues an approval bound to that refund — and spends it when the refund reaches the disk.
 */
const LANE_APPROVALS_ROUTE = '/lane/approvals';

/**
 * RECEIPT NUMBERS from this box (audit PF-04 · M01-FR-02): `POST /lane/receipt-numbers` with the till's request key gives
 * the next number for this lane, saved on this box's disk first; `GET /lane/receipt-numbers` is the lane's account —
 * issued, used, left, and every number issued that no bill used.
 */
const LANE_RECEIPT_NUMBERS_ROUTE = '/lane/receipt-numbers';

/**
 * HELD BASKETS on this box (audit PF-05 · M12-FR-02): `POST /lane/held-bills` parks the basket on the box's disk,
 * `GET /lane/held-bills` lists what this till may recall, `POST /lane/held-bills/recall` claims one (once), and
 * `POST /lane/held-bills/abandon` gives one up — kept, never deleted. Only the person signed in at this till.
 */
const LANE_HELD_BILLS_ROUTE = '/lane/held-bills';
const LANE_HELD_BILLS_RECALL_ROUTE = '/lane/held-bills/recall';
const LANE_HELD_BILLS_ABANDON_ROUTE = '/lane/held-bills/abandon';

/** The held-basket register this socket asks (`HeldBills`). */
export interface LaneHeldBillsPort {
  hold(input: { readonly laneId: string; readonly cashierId: string; readonly billId: unknown; readonly lines: unknown; readonly ageAnswers?: unknown; readonly tradingDay?: unknown; readonly reason?: unknown }): Promise<HoldOutcome>;
  list(laneId: string): readonly HeldSummary[];
  recall(input: { readonly laneId: string; readonly byUserId: string; readonly billId: unknown }): Promise<RecallOutcome>;
  abandon(input: { readonly laneId: string; readonly byUserId: string; readonly billId: unknown; readonly reason: unknown }): Promise<{ readonly abandoned: boolean; readonly laneMessage: string }>;
}

/** The receipt-number register this socket asks (`ReceiptNumbers`). */
export interface LaneReceiptNumberPort {
  issue(input: { readonly laneId: string; readonly requestKey: unknown; readonly issuedTo: string }): Promise<IssueOutcome>;
  checkUse(input: { readonly laneId: string; readonly receiptNumber: unknown; readonly recordId: string }): UseCheck;
  status(laneId: string): ReceiptNumberStatus;
}

/** The approval register this socket asks (`TillApprovals`). */
export interface LaneApprovalPort {
  grant(input: {
    readonly token: string | undefined; readonly laneId: string; readonly managerId: string; readonly pin: string;
    readonly kind: unknown; readonly billRef: unknown; readonly valueMinor: unknown; readonly reason: unknown;
  }): Promise<GrantOutcome>;
  checkReturn(input: { readonly record: unknown; readonly requestedBy: string; readonly laneId: string; readonly returnId: string }): Promise<ReturnCheck>;
}

/** The till-operator register this socket asks (`TillOperators`), with the lane this box IS and how it signs people in. */
export interface LaneOperatorPort {
  readonly laneId: string;
  /** True only on the hosted copy, behind its own sign-in (`EDGE_LANE_TRUST_FORWARDED_USER=1`, ADR-0020 §6). */
  readonly trustForwardedUser: boolean;
  signIn(input: { readonly staffId: string; readonly pin: string; readonly laneId: string }): Promise<SignInOutcome>;
  signInVerified(input: { readonly userId: string; readonly laneId: string }): Promise<SignInOutcome>;
  check(token: string | undefined, laneId: string): CheckOutcome;
  signOut(token: string | undefined): Promise<boolean>;
  /**
   * Seal what this box verified (ADR-0023): the fact, the record, the till, the person, how, and how much — under the
   * seal key and this box's tenant, so head office can tell a record that passed through this till from one that did not.
   * Every store box wires it (`main.ts`); absent only where a test drives this socket alone, and then the stamp travels
   * unsealed and head office flags it.
   */
  seal?(subject: Omit<TillSealSubject, 'tenantId'>): string;
}

/** What the box does when the manager asks to close the day — the authoritative `EdgeProcess.closeDay`. */
export type LaneDayCloseHandler = (
  req: { readonly dayCloseId: string; readonly closedBy: string },
) => Promise<
  | { readonly closed: true; readonly tradingDay: string; readonly locked: true }
  | { readonly closed: false; readonly reason: string }
>;

/**
 * What the box does with a batch of device work (SP-2a): validate each item against the allow-list, dedupe by
 * key, write it durably, queue it for head office, and answer per item. The items arrive unread — the box reads
 * each strictly itself, so the socket never decides what a valid record is.
 */
export type LaneDeviceRelayHandler = (
  /** `deviceId` is present when the batch came over the authenticated device socket (SP-3a), naming the handheld. */
  batch: {
    readonly source: string; readonly items: readonly unknown[]; readonly deviceId?: string;
    /**
     * The person this box verified for the request (2b-vi-c-3): the till session sent with it, or on the hosted copy the
     * person the front's sign-in named. Absent when nobody was verified — the decisions then travel unstamped.
     */
    readonly verifiedPerson?: { readonly userId: string; readonly via: string; readonly laneId: string };
  },
) => Promise<RelayReply>;

/** Where the items a device handed over have got to, by key — from the box's own pipeline (SP-2a). */
export type LaneDeviceStatusHandler = (keys: readonly string[]) => readonly BoxItemStatus[];

/** What the box does when an authority asks to reopen a locked day — the authoritative `EdgeProcess.reopenDay`. */
export type LaneDayReopenHandler = (
  req: {
    readonly dayCloseId: string; readonly reopenedBy: string; readonly reason: string; readonly approvedBy: string;
    /** The person this box verified for the request (2b-vi-c-3) — the box seals the reopen when it is the reopener. */
    readonly verifiedPerson?: { readonly userId: string; readonly via: string; readonly laneId: string };
    /** The reopener's and the approver's own till PINs (2b-vi-c-4), checked by the box and never written anywhere. */
    readonly reopenerPin?: string;
    readonly approverPin?: string;
  },
) => Promise<
  | { readonly reopened: true; readonly tradingDay: string }
  | { readonly reopened: false; readonly reason: string }
>;

/** What the box does when the till records cash (SP-4c) — the authoritative `EdgeProcess.recordCashMovement`. */
export type LaneCashMovementHandler = (req: CashMovementRequest) => Promise<CashMovementOutcome>;
/** What the box does when the till closes the shift (SP-4c) — the authoritative `EdgeProcess.closeShift`. */
export type LaneShiftCloseHandler = (req: ShiftCloseRequest) => Promise<ShiftCloseOutcome>;
/** Where the till's cash stands on the box — custody, never a figure (SP-4c). */
export type LaneTillCashHandler = () => Promise<TillCashStatus>;

/**
 * Is this `Origin` header another page on this same machine? `127.0.0.1`, `localhost` and IPv6
 * `[::1]` on any port; nothing else. Undefined (a same-origin or non-browser call that sends no
 * Origin) is not cross-origin, so it needs no allowance and is not one of these.
 *
 * Pure and exported so the decision is unit-tested directly rather than only through a socket.
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (typeof origin !== 'string' || origin === '') return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  // A URL parses `[::1]` back to `::1`; accept both the bracketed and bare forms.
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Is this the lane protocol's content type? `application/json` only (a charset parameter is fine).
 *
 * This is a **server-side authorization control, not tidiness** (RR-F01). A cross-origin `fetch`
 * carrying `application/json` is never a CORS "simple request", so the browser must ask this socket's
 * permission with a preflight `OPTIONS` first — which is refused for any non-loopback origin. The
 * bypass the review found used `text/plain`, which *is* a simple request and is sent with no
 * preflight at all: the browser delivers it, the server writes the record, and only then does the
 * missing CORS header stop the attacker reading the reply — too late, the durable mutation happened.
 * Requiring `application/json` closes that door: the only content type the real till ever sends, and
 * the one that cannot cross an origin without this socket's say-so.
 */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  const base = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return base === 'application/json';
}

/**
 * May this request mutate the lane's log at all? Decided BEFORE the body is read or anything is
 * written (RR-F01). Loopback binding and CORS response headers do not establish caller
 * authorization — a request that carries a foreign `Origin`, or a content type the lane protocol
 * does not speak, is refused here rather than parsed and committed. A request with no `Origin` (a
 * same-origin call, or a non-browser client already on this machine, which the loopback bind treats
 * as in the trust boundary — see the note at the top) is allowed if its content type is right.
 */
export function laneCallRefusal(
  origin: string | undefined,
  contentType: string | undefined,
): { readonly status: number; readonly reason: string } | undefined {
  if (typeof origin === 'string' && origin !== '' && !isLoopbackOrigin(origin)) {
    return { status: 403, reason: 'this request did not come from this till and was refused before anything was written' };
  }
  if (!isJsonContentType(contentType)) {
    return { status: 415, reason: 'the lane accepts application/json only; this request was refused before anything was written' };
  }
  return undefined;
}

/** The CORS headers to answer a loopback caller with — or nothing at all for any other origin. */
function corsHeadersFor(origin: string | undefined): Record<string, string> {
  if (!isLoopbackOrigin(origin)) return {};
  return {
    'access-control-allow-origin': origin!,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': `content-type, idempotency-key, ${OPERATOR_HEADER}`,
    'access-control-max-age': '600',
    // The allowed origin depends on the request, so caches must key on it.
    vary: 'Origin',
  };
}

export interface LaneServer {
  readonly port: number;
  stop(): Promise<void>;
}

const send = (res: ServerResponse, status: number, body: unknown, cors: Record<string, string> = {}): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
    // Present only for a loopback caller (another page on this same till); absent for any other
    // origin, so the browser blocks it. See the note at the top of this file.
    ...cors,
  });
  res.end(text);
};

export function startLaneServer(input: {
  readonly node: EdgeNode;
  readonly port: number;
  /** Largest sale payload accepted. A body cap is a denial-of-service control, not tidiness. */
  readonly maxBytes?: number;
  /**
   * Close and lock the trading day (M14-FR-04). Absent on a box that does not close the day (e.g. a
   * standalone lane), in which case POST /lane/day-close answers 404. The manager's screen posts
   * `{ dayCloseId, closedBy }`; the box makes the authoritative decision.
   */
  readonly closeDay?: LaneDayCloseHandler;
  /**
   * Reopen a locked trading day (M14-FR-04 / §28). Absent on a box that does not reopen days, in which
   * case POST /lane/day-reopen answers 404. The accountant/owner's screen posts
   * `{ dayCloseId, reopenedBy, reason, approvedBy }`; the box makes the authoritative decision.
   */
  readonly reopenDay?: LaneDayReopenHandler;
  /**
   * The box's sync status for the screens' badges (GET /lane/sync-status). Absent on a lane that does not report
   * one, in which case the route answers 404 and the screen says it could not ask.
   */
  readonly syncStatus?: () => LaneSyncStatus;
  /**
   * Take a batch of work a screen or handheld did on its own device (SP-2a): POST /lane/outbox. Absent on a
   * box that relays no device work, in which case the route answers 404 and the device keeps everything.
   */
  readonly relayDeviceEvents?: LaneDeviceRelayHandler;
  /** Where device items the box took have got to: GET /lane/outbox/status?keys=k1,k2. Absent → 404. */
  readonly deviceEventStatus?: LaneDeviceStatusHandler;
  /**
   * The till's cash on the box (SP-4c · F10): record a movement, close the shift, say where the cash stands. Absent on a
   * box that keeps no till cash (e.g. a back-office box with no lane), in which case the three routes answer 404 and the
   * till says it is not connected to its store computer.
   */
  readonly recordCashMovement?: LaneCashMovementHandler;
  readonly closeShift?: LaneShiftCloseHandler;
  readonly tillCash?: LaneTillCashHandler;
  /**
   * The till-operator register (ADR-0020). Present on every store box (`main.ts` always wires it): the sign-in routes
   * answer, and a sale, a refund, a cash movement and a till close are refused before the disk unless they carry a live
   * session for the person they name. Absent only where a test drives this socket alone.
   */
  readonly operators?: LaneOperatorPort;
  /**
   * The manager-approval register (ADR-0021). Wired beside `operators` on every store box: the approval route answers,
   * and a refund is refused before the disk unless it needs no approval or carries one this box issued for it.
   */
  readonly approvals?: LaneApprovalPort;
  /**
   * The receipt-number register (audit PF-04). Wired beside `operators` on every store box: the till's numbers come from
   * here, and a sale or refund is refused before the disk unless its number is one this box issued to this lane and no
   * other record used.
   */
  readonly receiptNumbers?: LaneReceiptNumberPort;
  /** The held-basket register (audit PF-05). Wired beside `operators` on every store box. */
  readonly heldBills?: LaneHeldBillsPort;
}): Promise<LaneServer> {
  const maxBytes = input.maxBytes ?? 256 * 1024;

  /** The session the till sent with this request, if any (never logged, never echoed). */
  const operatorTokenOf = (req: IncomingMessage): string | undefined => {
    const v = req.headers[OPERATOR_HEADER];
    const token = Array.isArray(v) ? v[0] : v;
    return typeof token === 'string' && token !== '' ? token : undefined;
  };

  /**
   * Who this box verified for this request, if anybody (2b-vi-c-3): the till session it carries, or — on the hosted copy
   * only — the person the front's sign-in named in `X-Sre-User`. Never a body value.
   */
  const verifiedPersonOf = (req: IncomingMessage): { readonly userId: string; readonly via: string; readonly laneId: string } | undefined => {
    const ops = input.operators;
    if (ops === undefined || ops.laneId.trim() === '') return undefined;
    const check = ops.check(operatorTokenOf(req), ops.laneId);
    if (check.ok) return { userId: check.userId, via: check.via, laneId: ops.laneId };
    const forwarded = req.headers['x-sre-user'];
    const user = ops.trustForwardedUser && typeof forwarded === 'string' ? forwarded.trim() : '';
    return user === '' ? undefined : { userId: user, via: 'verified_sign_in', laneId: ops.laneId };
  };

  /**
   * Is the person this money write NAMES the person signed in at this till? (ADR-0020 §5.) `undefined` = go on (and the
   * verified person, to stamp); otherwise the refusal in the cashier's words. With no register wired (a test of this
   * socket alone) there is nothing to check against and the write goes on unstamped.
   */
  const operatorRefusal = (req: IncomingMessage, named: unknown): { readonly refusedBecause: string; readonly laneMessage: string } | { readonly verified: { readonly userId: string; readonly via: string; readonly laneId: string } } | undefined => {
    const ops = input.operators;
    if (ops === undefined) return undefined;
    // A box that was never told which till it is takes no money at all — the same refusal its cash routes give.
    if (ops.laneId.trim() === '') return { refusedBecause: 'no_lane', laneMessage: 'This store computer has not been told which till it is. Nothing was saved — tell the manager.' };
    const check = ops.check(operatorTokenOf(req), ops.laneId);
    if (!check.ok) return { refusedBecause: check.refusedBecause, laneMessage: check.laneMessage };
    if (typeof named !== 'string' || named.trim() !== check.userId) {
      return {
        refusedBecause: 'operator_not_the_one_named',
        laneMessage: `${check.displayName} is signed in at this till, but this names ${typeof named === 'string' && named.trim() !== '' ? named : 'nobody'}. Nothing was saved — sign in as yourself.`,
      };
    }
    return { verified: { userId: check.userId, via: check.via, laneId: ops.laneId } };
  };

  /**
   * The stamp a verified money write carries (ADR-0023): the person, how they signed in, this till — and the box's seal
   * over that AND the fact, the record and the amount. Never a clock reading, so a re-sent record stamps the same.
   */
  const stampOf = (
    verified: { readonly userId: string; readonly via: string; readonly laneId: string },
    fact: Exclude<TillSealSubject['fact'], 'approval'>, recordId: string, amountMinor: number,
  ): Partial<OperatorStamp> & Omit<OperatorStamp, 'seal'> => {
    const seal = input.operators?.seal;
    return seal === undefined ? { ...verified } : { ...verified, seal: seal({ fact, recordId, amountMinor, ...verified }) };
  };
  const sealedOnly = (stamp: (Partial<OperatorStamp> & Omit<OperatorStamp, 'seal'>) | undefined): { operatorVerified?: OperatorStamp } =>
    (stamp?.seal === undefined ? {} : { operatorVerified: { ...stamp, seal: stamp.seal } });

  /**
   * Read a bounded JSON body, or answer for the caller and resolve `undefined`: 413 when it is too large (the request
   * is destroyed), 400 when it does not parse. The `refused` shape is the route's own — `{ committed: false, … }` for a
   * movement, `{ closed: false, … }` for a close — so a caller always reads the answer it expects.
   */
  const readJsonBody = (req: IncomingMessage, res: ServerResponse, cors: Record<string, string>, refused: (reason: string) => unknown): Promise<unknown | undefined> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes && !tooBig) {
          tooBig = true;
          send(res, 413, refused('the request is too large'), cors);
          req.destroy();
          resolve(undefined);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) return;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          send(res, 400, refused('the request could not be read'), cors);
          resolve(undefined);
        }
      });
    });

  // A refused-durable-write answer, in the words the cashier needs with a customer watching. `noun`
  // is 'sale' or 'refund' so the same shape serves both routes without either lying about the other.
  const refusal = (noun: string, detail?: string): Record<string, unknown> => ({
    committed: false,
    refusedBecause: 'could_not_write_durably',
    ...(detail === undefined ? {} : { detail }),
    laneMessage: `This lane could not save the ${noun}. Do not take payment or hand over ${noun === 'sale' ? 'the goods' : 'cash'} — use another lane and tell the manager.`,
  });

  const server: Server = createServer((req, res) => {
    const cors = corsHeadersFor(req.headers.origin);
    // The path only — the lookup route carries a `?receipt=` query the write routes never do.
    const pathname = ((): string => {
      try { return new URL(req.url ?? '', 'http://lane').pathname; } catch { return req.url ?? ''; }
    })();
    const route = LANE_ROUTES.find((r) => r === req.url);

    // The READ route: GET /lane/lookup?receipt=… — resolve a bill this lane rang for the refund
    // screen (M13-FR-01). No write happens here, so a foreign-origin call cannot mutate anything; but
    // it returns a customer's bill, so a foreign origin is refused outright (403, no data) rather than
    // computed-and-withheld. A loopback origin (another page on this same till) is served.
    if (req.method === 'GET' && pathname === LANE_LOOKUP_ROUTE) {
      if (typeof req.headers.origin === 'string' && req.headers.origin !== '' && !isLoopbackOrigin(req.headers.origin)) {
        send(res, 403, { error: 'this request did not come from this till' }, cors);
        return;
      }
      const receipt = ((): string => {
        try { return new URL(req.url ?? '', 'http://lane').searchParams.get('receipt') ?? ''; } catch { return ''; }
      })();
      if (receipt === '') {
        send(res, 400, { error: 'a receipt number or sale id is required' }, cors);
        return;
      }
      void (async () => {
        try {
          const result = await input.node.lookupSale(receipt);
          // 200 either way: the request was understood. `found` lets the screen tell "no such bill on
          // this lane" (send them to look it up online / at the desk) from a lane that is broken.
          send(res, 200, result === undefined ? { found: false } : { found: true, ...result }, cors);
        } catch (e) {
          send(res, 200, { found: false, detail: e instanceof Error ? e.message : String(e) }, cors);
        }
      })();
      return;
    }

    // WHO IS AT THE TILL (ADR-0020): how this box signs people in, and whether the till's session is live. A foreign origin
    // is refused — who is signed in at a till is the shop's business.
    if (req.method === 'GET' && pathname === LANE_OPERATOR_ROUTE) {
      if (typeof req.headers.origin === 'string' && req.headers.origin !== '' && !isLoopbackOrigin(req.headers.origin)) {
        send(res, 403, { error: 'this request did not come from this till' }, cors);
        return;
      }
      const ops = input.operators;
      if (ops === undefined) { send(res, 404, { error: 'this box does not sign till operators in' }, cors); return; }
      const signInBy = ops.trustForwardedUser ? 'verified_sign_in' : 'pin';
      const check = ops.check(operatorTokenOf(req), ops.laneId);
      send(res, 200, check.ok
        ? { signInBy, signedIn: true, userId: check.userId, displayName: check.displayName, via: check.via, expiresAt: check.expiresAt }
        : { signInBy, signedIn: false }, { ...cors, 'cache-control': 'no-store' });
      return;
    }

    if (req.method === 'POST' && (pathname === LANE_OPERATOR_SIGN_IN_ROUTE || pathname === LANE_OPERATOR_SIGN_OUT_ROUTE)) {
      const ops = input.operators;
      const refused = (laneMessage: string) => ({ signedIn: false, refusedBecause: 'not_readable', laneMessage });
      if (ops === undefined) { send(res, 404, refused('this box does not sign till operators in'), cors); req.resume(); return; }
      const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
      if (authRefusal !== undefined) { send(res, authRefusal.status, refused(authRefusal.reason), cors); req.resume(); return; }
      void (async () => {
        const body = await readJsonBody(req, res, cors, refused);
        if (body === undefined) return;
        if (pathname === LANE_OPERATOR_SIGN_OUT_ROUTE) {
          send(res, 200, { signedOut: await ops.signOut(operatorTokenOf(req)) }, { ...cors, 'cache-control': 'no-store' });
          return;
        }
        const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const staffId = typeof b['staffId'] === 'string' ? b['staffId'] : '';
        const pin = typeof b['pin'] === 'string' ? b['pin'] : '';
        // The hosted copy ONLY (ADR-0020 §6): the front's sign-in already verified this person and set X-Sre-User itself.
        const forwarded = req.headers['x-sre-user'];
        const verifiedUser = ops.trustForwardedUser && typeof forwarded === 'string' ? forwarded.trim() : '';
        try {
          const outcome = verifiedUser !== '' && pin === ''
            ? await ops.signInVerified({ userId: verifiedUser, laneId: ops.laneId })
            : await ops.signIn({ staffId, pin, laneId: ops.laneId });
          send(res, 200, outcome, { ...cors, 'cache-control': 'no-store' });
        } catch (e) {
          send(res, 200, refused(e instanceof Error ? e.message : String(e)), cors);
        }
      })();
      return;
    }

    // HELD BASKETS (audit PF-05): park, list, recall once, give up — each by the person signed in at this till, each on
    // the box's disk before the till is answered.
    if ((req.method === 'POST' && (pathname === LANE_HELD_BILLS_ROUTE || pathname === LANE_HELD_BILLS_RECALL_ROUTE || pathname === LANE_HELD_BILLS_ABANDON_ROUTE))
      || (req.method === 'GET' && pathname === LANE_HELD_BILLS_ROUTE)) {
      const ops = input.operators;
      const held = input.heldBills;
      const refused = (refusedBecause: string, laneMessage: string) => ({ held: false, recalled: false, abandoned: false, refusedBecause, laneMessage });
      if (ops === undefined || held === undefined) { send(res, 404, refused('not_served', 'this box does not hold baskets'), cors); req.resume(); return; }
      if (req.method === 'GET') {
        if (typeof req.headers.origin === 'string' && req.headers.origin !== '' && !isLoopbackOrigin(req.headers.origin)) {
          send(res, 403, { error: 'this request did not come from this till' }, cors);
          return;
        }
        const check = ops.check(operatorTokenOf(req), ops.laneId);
        if (!check.ok) { send(res, 200, { held: [], refusedBecause: check.refusedBecause, laneMessage: check.laneMessage }, { ...cors, 'cache-control': 'no-store' }); return; }
        send(res, 200, { held: held.list(ops.laneId) }, { ...cors, 'cache-control': 'no-store' });
        return;
      }
      const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
      if (authRefusal !== undefined) { send(res, authRefusal.status, refused('unauthorized_request', authRefusal.reason), cors); req.resume(); return; }
      void (async () => {
        const body = await readJsonBody(req, res, cors, (m: string) => refused('request_not_readable', m));
        if (body === undefined) return;
        if (ops.laneId.trim() === '') { send(res, 200, refused('no_lane', 'This store computer has not been told which till it is. Nothing was done — tell the manager.'), cors); return; }
        const check = ops.check(operatorTokenOf(req), ops.laneId);
        if (!check.ok) { send(res, 200, refused(check.refusedBecause, check.laneMessage), cors); return; }
        const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        try {
          const out = pathname === LANE_HELD_BILLS_ROUTE
            ? await held.hold({ laneId: ops.laneId, cashierId: check.userId, billId: b['billId'], lines: b['lines'], ageAnswers: b['ageAnswers'], tradingDay: b['tradingDay'], reason: b['reason'] })
            : pathname === LANE_HELD_BILLS_RECALL_ROUTE
              ? await held.recall({ laneId: ops.laneId, byUserId: check.userId, billId: b['billId'] })
              : await held.abandon({ laneId: ops.laneId, byUserId: check.userId, billId: b['billId'], reason: b['reason'] });
          send(res, 200, out, { ...cors, 'cache-control': 'no-store' });
        } catch (e) {
          send(res, 200, refused('could_not_write_durably', e instanceof Error ? e.message : String(e)), cors);
        }
      })();
      return;
    }

    // The next receipt number for this lane (audit PF-04): asked by the person signed in at this till, saved on this box's
    // disk before it is answered. Re-asked with the same request key (a lost reply), the same number comes back.
    if (req.method === 'POST' && pathname === LANE_RECEIPT_NUMBERS_ROUTE) {
      const ops = input.operators;
      const numbers = input.receiptNumbers;
      const refused = (refusedBecause: string, laneMessage: string) => ({ issued: false, refusedBecause, laneMessage });
      if (ops === undefined || numbers === undefined) { send(res, 404, refused('not_served', 'this box does not give receipt numbers'), cors); req.resume(); return; }
      const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
      if (authRefusal !== undefined) { send(res, authRefusal.status, refused('unauthorized_request', authRefusal.reason), cors); req.resume(); return; }
      void (async () => {
        const body = await readJsonBody(req, res, cors, (m: string) => refused('request_not_readable', m));
        if (body === undefined) return;
        if (ops.laneId.trim() === '') { send(res, 200, refused('no_lane', 'This store computer has not been told which till it is. No number was given — tell the manager.'), cors); return; }
        // Only the person signed in at this till may draw this till's numbers.
        const check = ops.check(operatorTokenOf(req), ops.laneId);
        if (!check.ok) { send(res, 200, refused(check.refusedBecause, check.laneMessage), cors); return; }
        const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        try {
          send(res, 200, await numbers.issue({ laneId: ops.laneId, requestKey: b['requestKey'], issuedTo: check.userId }), { ...cors, 'cache-control': 'no-store' });
        } catch (e) {
          send(res, 200, refused('could_not_write_durably', e instanceof Error ? e.message : String(e)), cors);
        }
      })();
      return;
    }
    // The lane's account of its numbers — counts, the range and the unused numbers; refused to a foreign origin.
    if (req.method === 'GET' && pathname === LANE_RECEIPT_NUMBERS_ROUTE) {
      if (typeof req.headers.origin === 'string' && req.headers.origin !== '' && !isLoopbackOrigin(req.headers.origin)) {
        send(res, 403, { error: 'this request did not come from this till' }, cors);
        return;
      }
      if (input.operators === undefined || input.receiptNumbers === undefined) { send(res, 404, { error: 'this box does not give receipt numbers' }, cors); return; }
      send(res, 200, input.receiptNumbers.status(input.operators.laneId), { ...cors, 'cache-control': 'no-store' });
      return;
    }

    // A manager approves at this till (ADR-0021). The cashier's session asks; the manager's own PIN answers.
    if (req.method === 'POST' && pathname === LANE_APPROVALS_ROUTE) {
      const ops = input.operators;
      const approvals = input.approvals;
      const refused = (laneMessage: string) => ({ approved: false, refusedBecause: 'approval_not_readable', laneMessage });
      if (ops === undefined || approvals === undefined) { send(res, 404, refused('this box does not give approvals at the till'), cors); req.resume(); return; }
      const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
      if (authRefusal !== undefined) { send(res, authRefusal.status, refused(authRefusal.reason), cors); req.resume(); return; }
      void (async () => {
        const body = await readJsonBody(req, res, cors, refused);
        if (body === undefined) return;
        const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        try {
          const outcome = await approvals.grant({
            token: operatorTokenOf(req), laneId: ops.laneId,
            managerId: typeof b['managerId'] === 'string' ? b['managerId'] : '', pin: typeof b['pin'] === 'string' ? b['pin'] : '',
            kind: b['kind'], billRef: b['billRef'], valueMinor: b['valueMinor'], reason: b['reason'],
          });
          send(res, 200, outcome, { ...cors, 'cache-control': 'no-store' });
        } catch (e) {
          send(res, 200, refused(e instanceof Error ? e.message : String(e)), cors);
        }
      })();
      return;
    }

    // The STATUS read route: GET /lane/sync-status — the box's own account of its link to head office, for the
    // sync badge on the till and the manager screens (design system §1 rule 4). Counts and times only, never a
    // record; still refused to a foreign origin, because how far behind a shop is is the shop's business.
    if (req.method === 'GET' && pathname === LANE_SYNC_STATUS_ROUTE) {
      if (typeof req.headers.origin === 'string' && req.headers.origin !== '' && !isLoopbackOrigin(req.headers.origin)) {
        send(res, 403, { error: 'this request did not come from this till' }, cors);
        return;
      }
      if (input.syncStatus === undefined) {
        send(res, 404, { error: 'this lane does not report its sync status' }, cors);
        return;
      }
      // Never cached: a badge showing this morning's "online" is the fault the badge exists to prevent (P-08).
      send(res, 200, input.syncStatus(), { ...cors, 'cache-control': 'no-store' });
      return;
    }

    // The DEVICE-OUTBOX STATUS read route: GET /lane/outbox/status?keys=k1,k2 (SP-2a). Per-key state of items
    // a device handed over — counts and states, never a record — refused to a foreign origin like the sync status.
    if (req.method === 'GET' && pathname === LANE_DEVICE_OUTBOX_STATUS_ROUTE) {
      if (typeof req.headers.origin === 'string' && req.headers.origin !== '' && !isLoopbackOrigin(req.headers.origin)) {
        send(res, 403, { error: 'this request did not come from this till' }, cors);
        return;
      }
      const status = input.deviceEventStatus;
      if (status === undefined) {
        send(res, 404, { error: 'this box does not relay device work' }, cors);
        return;
      }
      const keys = ((): string[] => {
        try {
          return (new URL(req.url ?? '', 'http://lane').searchParams.get('keys') ?? '').split(',').map((k) => k.trim()).filter((k) => k !== '');
        } catch { return []; }
      })();
      // Never cached: a stale "pending" is exactly the guess this route exists to replace (P-08).
      send(res, 200, { items: status(keys) }, { ...cors, 'cache-control': 'no-store' });
      return;
    }

    // The DEVICE-OUTBOX write route: POST /lane/outbox (SP-2a · F11). A screen or handheld hands over a batch of
    // work done on its device; the box answers per item. Same loopback + application/json authorization as every
    // other write, decided BEFORE the body is read (RR-F01). 404 on a box that relays no device work. 200 with
    // the acks on a batch that was understood; 400 on one that was not (the device keeps every item).
    if (req.method === 'POST' && pathname === LANE_DEVICE_OUTBOX_ROUTE) {
      const relay = input.relayDeviceEvents;
      if (relay === undefined) {
        send(res, 404, { acks: [], reason: 'this box does not relay device work' }, cors);
        req.resume();
        return;
      }
      const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
      if (authRefusal !== undefined) {
        send(res, authRefusal.status, { acks: [], reason: authRefusal.reason }, cors);
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes && !tooBig) {
          tooBig = true;
          send(res, 413, { acks: [], reason: 'the device batch is too large — send fewer items at a time' }, cors);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) return;
        void (async () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          } catch {
            send(res, 400, { acks: [], reason: 'the device batch could not be read' }, cors);
            return;
          }
          const batch = readRelayBatch(body);
          if (!batch.ok) {
            send(res, 400, { acks: [], reason: batch.reason }, cors);
            return;
          }
          try {
            const verifiedPerson = verifiedPersonOf(req);
            send(res, 200, await relay({ source: batch.source, items: batch.items, ...(verifiedPerson === undefined ? {} : { verifiedPerson }) }), cors);
          } catch (e) {
            // The box itself failed mid-batch: no verdict on any item. The device keeps them all (a 5xx is a
            // failed attempt, never a refusal) and tries again.
            send(res, 500, { acks: [], reason: e instanceof Error ? e.message : String(e) }, cors);
          }
        })();
      });
      return;
    }

    // The DAY-CLOSE write route: POST /lane/day-close (M14-FR-04). The manager's screen asks the box to
    // close and LOCK the trading day; the box makes the authoritative decision (edge.closeDay reads the
    // live outbox depths + exception register). Same loopback + application/json authorization as the
    // sale/refund routes (RR-F01), decided BEFORE the body is read. Answered 404 on a box that does not
    // close the day. 200 either way on a real attempt: the *request* was understood; the body says
    // whether the day closed or the stated blocker why not (P-08).
    if (req.method === 'POST' && pathname === LANE_DAY_CLOSE_ROUTE) {
      const doClose = input.closeDay;
      if (doClose === undefined) {
        send(res, 404, { closed: false, reason: 'this box does not close the day' }, cors);
        req.resume();
        return;
      }
      const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
      if (authRefusal !== undefined) {
        send(res, authRefusal.status, { closed: false, reason: authRefusal.reason }, cors);
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes && !tooBig) {
          tooBig = true;
          send(res, 413, { closed: false, reason: 'day-close request too large' }, cors);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) return;
        void (async () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          } catch {
            send(res, 400, { closed: false, reason: 'the day-close request could not be read' }, cors);
            return;
          }
          const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
          const dayCloseId = typeof b['dayCloseId'] === 'string' && b['dayCloseId'] !== '' ? (b['dayCloseId'] as string) : undefined;
          const closedBy = typeof b['closedBy'] === 'string' && b['closedBy'] !== '' ? (b['closedBy'] as string) : undefined;
          if (dayCloseId === undefined || closedBy === undefined) {
            send(res, 400, { closed: false, reason: 'closing the day needs a day-close id and who is closing it' }, cors);
            return;
          }
          try {
            send(res, 200, await doClose({ dayCloseId, closedBy }), cors);
          } catch (e) {
            send(res, 200, { closed: false, reason: e instanceof Error ? e.message : String(e) }, cors);
          }
        })();
      });
      return;
    }

    // The DAY-REOPEN write route: POST /lane/day-reopen (M14-FR-04 / §28). An accountant/owner's screen
    // asks the box to REOPEN a locked day; the box makes the authoritative decision (edge.reopenDay enforces
    // approver ≠ reopener). Same loopback + application/json authorization as every other write (RR-F01),
    // decided BEFORE the body is read. 404 on a box that does not reopen days. 200 either way on a real
    // attempt: the *request* was understood; the body says whether it reopened or the stated reason why not.
    if (req.method === 'POST' && pathname === LANE_DAY_REOPEN_ROUTE) {
      const doReopen = input.reopenDay;
      if (doReopen === undefined) {
        send(res, 404, { reopened: false, reason: 'this box does not reopen days' }, cors);
        req.resume();
        return;
      }
      const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
      if (authRefusal !== undefined) {
        send(res, authRefusal.status, { reopened: false, reason: authRefusal.reason }, cors);
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes && !tooBig) {
          tooBig = true;
          send(res, 413, { reopened: false, reason: 'day-reopen request too large' }, cors);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) return;
        void (async () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          } catch {
            send(res, 400, { reopened: false, reason: 'the day-reopen request could not be read' }, cors);
            return;
          }
          const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
          const str = (k: string): string | undefined =>
            typeof b[k] === 'string' && (b[k] as string).trim() !== '' ? (b[k] as string) : undefined;
          const dayCloseId = str('dayCloseId');
          const reopenedBy = str('reopenedBy');
          const reason = str('reason');
          const approvedBy = str('approvedBy');
          // A reopen is audited and §28-governed: it needs the day, who is reopening, why, and who
          // approved it. A blank any of these is malformed — refused here rather than sent on half-formed.
          if (dayCloseId === undefined || reopenedBy === undefined || reason === undefined || approvedBy === undefined) {
            send(res, 400, { reopened: false, reason: 'a reopen needs a day-close id, who is reopening, a reason, and who approved it' }, cors);
            return;
          }
          try {
            const verifiedPerson = verifiedPersonOf(req);
            // The two PINs go to the box's PIN register and nowhere else — never logged, never echoed (ADR-0020).
            const pinOf = (k: string): string | undefined => (typeof b[k] === 'string' && b[k] !== '' ? (b[k] as string) : undefined);
            const reopenerPin = pinOf('reopenerPin');
            const approverPin = pinOf('approverPin');
            send(res, 200, await doReopen({
              dayCloseId, reopenedBy, reason, approvedBy,
              ...(verifiedPerson === undefined ? {} : { verifiedPerson }),
              ...(reopenerPin === undefined ? {} : { reopenerPin }),
              ...(approverPin === undefined ? {} : { approverPin }),
            }), cors);
          } catch (e) {
            send(res, 200, { reopened: false, reason: e instanceof Error ? e.message : String(e) }, cors);
          }
        })();
      });
      return;
    }

    // The till's CASH read route: GET /lane/till-cash (SP-4c). Custody only — whether a float is out and who holds it —
    // never a balance (the drawer is counted blind). Refused to a foreign origin like every other read; 404 on a box
    // that keeps no till cash; never cached, because "a shift is open" from an hour ago is exactly the guess to avoid.
    if (req.method === 'GET' && pathname === LANE_TILL_CASH_ROUTE) {
      if (typeof req.headers.origin === 'string' && req.headers.origin !== '' && !isLoopbackOrigin(req.headers.origin)) {
        send(res, 403, { error: 'this request did not come from this till' }, cors);
        return;
      }
      const status = input.tillCash;
      if (status === undefined) {
        send(res, 404, { error: 'this box keeps no till cash' }, cors);
        return;
      }
      void (async () => {
        try {
          send(res, 200, await status(), { ...cors, 'cache-control': 'no-store' });
        } catch (e) {
          send(res, 500, { error: e instanceof Error ? e.message : String(e) }, cors);
        }
      })();
      return;
    }

    // The till's CASH write route: POST /lane/cash-movements (SP-4c · F10 · M14-FR-01). The till hands the box a float, a
    // loan, a pickup or a safe drop; the box judges it against the till's own chain, dates it, writes it durably and
    // queues it for head office, and answers in the cashier's words. Same authorization as every other write, decided
    // BEFORE the body is read (RR-F01). 200 on a refusal too: the request was understood; the answer is in the body.
    if (req.method === 'POST' && pathname === LANE_CASH_MOVEMENTS_ROUTE) {
      const record = input.recordCashMovement;
      const refused = (reason: string) => ({ committed: false, refusedBecause: 'not_readable', laneMessage: reason });
      if (record === undefined) {
        send(res, 404, { committed: false, refusedBecause: 'no_store_box', laneMessage: 'this box keeps no till cash' }, cors);
        req.resume();
        return;
      }
      const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
      if (authRefusal !== undefined) {
        send(res, authRefusal.status, refused(authRefusal.reason), cors);
        req.resume();
        return;
      }
      void (async () => {
        const body = await readJsonBody(req, res, cors, refused);
        if (body === undefined) return;
        const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const str = (k: string): string | undefined => (typeof b[k] === 'string' && (b[k] as string).trim() !== '' ? (b[k] as string) : undefined);
        const movementId = str('movementId'); const movementKind = str('movementKind'); const at = str('at');
        const custodianId = str('custodianId'); const performedBy = str('performedBy') ?? custodianId;
        const amountMinor = b['amountMinor'];
        if (movementId === undefined || movementKind === undefined || at === undefined || custodianId === undefined || performedBy === undefined
          || typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || Number.isNaN(Date.parse(at))) {
          send(res, 400, refused('a cash movement needs a movement id, a kind, a whole amount, a moment, and who holds the till'), cors);
          return;
        }
        // The person who holds the till is the person signed in at it (ADR-0020 §5) — refused before anything is written.
        const who = operatorRefusal(req, custodianId);
        if (who !== undefined && !('verified' in who)) { send(res, 200, { committed: false, ...who }, cors); return; }
        // Who recorded it is the person signed in at this till — never a name in the body (ADR-0023 · PF-02) — and the
        // box seals that it verified them.
        const verifiedStamp = who === undefined ? undefined : stampOf(who.verified, 'cash_movement', movementId, amountMinor);
        try {
          send(res, 200, await record({
            movementId, movementKind: movementKind as CashMovementKind, amountMinor, at, custodianId,
            performedBy: who === undefined ? performedBy : who.verified.userId,
            ...sealedOnly(verifiedStamp),
          }), cors);
        } catch (e) {
          send(res, 200, { committed: false, refusedBecause: 'could_not_write_durably', laneMessage: e instanceof Error ? e.message : String(e) }, cors);
        }
      })();
      return;
    }

    // The till's CLOSE write route: POST /lane/shift-close (SP-4c · F10 · M14-FR-02). The till hands the box exactly what
    // a cashier knows — which shift, when, who, what was counted, and a reason once asked for one; the box works out the
    // expected figure from its own records, decides, writes the close durably and queues it. Same authorization, same
    // 200-on-a-refusal answer. Never a figure before the count: the count is in the request.
    if (req.method === 'POST' && pathname === LANE_SHIFT_CLOSE_ROUTE) {
      const close = input.closeShift;
      const refused = (reason: string) => ({ closed: false, refusedBecause: 'not_readable', laneMessage: reason });
      if (close === undefined) {
        send(res, 404, { closed: false, refusedBecause: 'no_store_box', laneMessage: 'this box keeps no till cash' }, cors);
        req.resume();
        return;
      }
      const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
      if (authRefusal !== undefined) {
        send(res, authRefusal.status, refused(authRefusal.reason), cors);
        req.resume();
        return;
      }
      void (async () => {
        const body = await readJsonBody(req, res, cors, refused);
        if (body === undefined) return;
        const b = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const str = (k: string): string | undefined => (typeof b[k] === 'string' && (b[k] as string).trim() !== '' ? (b[k] as string) : undefined);
        const shiftId = str('shiftId'); const closedAt = str('closedAt'); const cashierId = str('cashierId'); const reasonCode = str('reasonCode');
        const countedMinor = b['countedMinor'];
        const denominations = Array.isArray(b['denominations'])
          ? (b['denominations'] as unknown[]).flatMap((d): CountedDenomination[] => {
            const x = (d ?? {}) as Record<string, unknown>;
            return Number.isSafeInteger(x['denominationMinor']) && Number.isSafeInteger(x['count'])
              ? [{ denominationMinor: x['denominationMinor'] as number, count: x['count'] as number }] : [];
          })
          : undefined;
        if (shiftId === undefined || closedAt === undefined || cashierId === undefined
          || typeof countedMinor !== 'number' || !Number.isSafeInteger(countedMinor) || Number.isNaN(Date.parse(closedAt))) {
          send(res, 400, refused('closing the till needs a shift id, a moment, who is closing, and the counted cash as a whole amount'), cors);
          return;
        }
        // The person closing is the person signed in at the till (ADR-0020 §5).
        const who = operatorRefusal(req, cashierId);
        if (who !== undefined && !('verified' in who)) { send(res, 200, { closed: false, ...who }, cors); return; }
        const verifiedStamp = who === undefined ? undefined : stampOf(who.verified, 'shift_close', shiftId, countedMinor);
        try {
          send(res, 200, await close({
            shiftId, closedAt, cashierId, countedMinor,
            ...sealedOnly(verifiedStamp),
            ...(denominations === undefined ? {} : { denominations }),
            ...(reasonCode === undefined ? {} : { reasonCode }),
          }), cors);
        } catch (e) {
          send(res, 200, { closed: false, refusedBecause: 'could_not_write_durably', laneMessage: e instanceof Error ? e.message : String(e) }, cors);
        }
      })();
      return;
    }

    // The browser's preflight for the cross-origin POST from the till's or manager's screen. Answered
    // only for a loopback origin; anything else gets no allow header and the browser refuses the POST.
    if (req.method === 'OPTIONS' && (route !== undefined || pathname === LANE_DAY_CLOSE_ROUTE || pathname === LANE_DAY_REOPEN_ROUTE || pathname === LANE_SYNC_STATUS_ROUTE || pathname === LANE_DEVICE_OUTBOX_ROUTE || pathname === LANE_DEVICE_OUTBOX_STATUS_ROUTE
      || pathname === LANE_CASH_MOVEMENTS_ROUTE || pathname === LANE_SHIFT_CLOSE_ROUTE || pathname === LANE_TILL_CASH_ROUTE
      || pathname === LANE_OPERATOR_ROUTE || pathname === LANE_OPERATOR_SIGN_IN_ROUTE || pathname === LANE_OPERATOR_SIGN_OUT_ROUTE
      || pathname === LANE_APPROVALS_ROUTE || pathname === LANE_RECEIPT_NUMBERS_ROUTE
      || pathname === LANE_HELD_BILLS_ROUTE || pathname === LANE_HELD_BILLS_RECALL_ROUTE || pathname === LANE_HELD_BILLS_ABANDON_ROUTE)) {
      res.writeHead(isLoopbackOrigin(req.headers.origin) ? 204 : 403, { 'content-length': '0', ...cors });
      res.end();
      return;
    }

    if (req.method !== 'POST' || route === undefined) {
      const serves = [...LANE_ROUTES.map((r) => `POST ${r}`), `POST ${LANE_DAY_CLOSE_ROUTE}`, `POST ${LANE_DAY_REOPEN_ROUTE}`, `POST ${LANE_DEVICE_OUTBOX_ROUTE}`, `POST ${LANE_CASH_MOVEMENTS_ROUTE}`, `POST ${LANE_SHIFT_CLOSE_ROUTE}`, `GET ${LANE_LOOKUP_ROUTE}?receipt=…`, `GET ${LANE_SYNC_STATUS_ROUTE}`, `GET ${LANE_DEVICE_OUTBOX_STATUS_ROUTE}?keys=…`, `GET ${LANE_TILL_CASH_ROUTE}`, `GET ${LANE_OPERATOR_ROUTE}`, `POST ${LANE_OPERATOR_SIGN_IN_ROUTE}`, `POST ${LANE_OPERATOR_SIGN_OUT_ROUTE}`, `POST ${LANE_APPROVALS_ROUTE}`, `POST ${LANE_RECEIPT_NUMBERS_ROUTE}`, `GET ${LANE_RECEIPT_NUMBERS_ROUTE}`, `POST ${LANE_HELD_BILLS_ROUTE}`, `GET ${LANE_HELD_BILLS_ROUTE}`, `POST ${LANE_HELD_BILLS_RECALL_ROUTE}`, `POST ${LANE_HELD_BILLS_ABANDON_ROUTE}`].join(', ');
      send(res, 404, { error: `the lane socket serves: ${serves}` }, cors);
      return;
    }
    const isReturn = route === '/lane/returns';
    // A concession docket line (M27-FR-03): the till's partner-counter line, durable here first, then queued.
    const isTag = route === '/lane/concession-tags';
    const noun = isTag ? 'partner-counter line' : isReturn ? 'refund' : 'sale';

    // Server-side authorization, BEFORE the body is read or anything is written (RR-F01). A foreign
    // Origin or a non-JSON content type is refused here — CORS headers and the loopback bind are not
    // caller authorization. This is what stops a `text/plain` cross-origin write from mutating the
    // log and only being "blocked" after the durable record already exists.
    const authRefusal = laneCallRefusal(req.headers.origin, req.headers['content-type']);
    if (authRefusal !== undefined) {
      send(res, authRefusal.status, { committed: false, refusedBecause: 'unauthorized_request', detail: authRefusal.reason }, cors);
      req.resume(); // drain and discard the body; nothing here reads or persists it
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes && !refused) {
        refused = true;
        send(res, 413, { error: `${noun} payload too large` }, cors);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (refused) return;
      void (async () => {
        // Read the record's OWN identity field: a sale's is `id` (as `commitSale` shapes it); a
        // refund's is `returnId` (the shape `packages/returns` mints), tolerating a bare `id`. Read
        // the shape that exists, not a hoped-for one — that mismatch is a lane that cannot take money.
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } catch {
          send(res, 400, refusal(noun), cors);
          return;
        }
        const id = isTag
          ? concessionTagIdOf(parsed)
          : isReturn
            ? returnIdOf(parsed)
            : ((parsed as { id?: string } | null)?.id);
        if (typeof id !== 'string' || id === '') {
          send(res, 400, refusal(noun), cors);
          return;
        }

        // WHO rang it (ADR-0020 §5): a sale names its cashier, a refund the person processing it — and that person must be
        // the one signed in at this till. Refused BEFORE the disk; on success the box stamps who it verified and how.
        // (A partner-counter line is not money and is recorded by its own page; it is not gated here yet.)
        if (!isTag) {
          const named = isReturn ? (parsed as { processedBy?: unknown } | null)?.processedBy : (parsed as { cashierId?: unknown } | null)?.cashierId;
          const who = operatorRefusal(req, named);
          if (who !== undefined && !('verified' in who)) {
            send(res, 200, { committed: false, ...who }, cors);
            return;
          }
          // The stamp is the person and the way they signed in — never a clock reading: a till re-sending the SAME sale after
          // a lost reply must hash the same, or the box would call its own replay a conflict (GAP-SALE-IDEMPOTENCY-01).
          // Sealed over the fact as head office will read it — the same translation the sync agent sends (ADR-0023).
          if (who !== undefined) {
            const cloud = isReturn ? toCloudReturn(parsed) : undefined;
            const sale = isReturn ? undefined : toCloudSale(parsed, 0);
            parsed = {
              ...(parsed as Record<string, unknown>),
              operatorVerified: cloud !== undefined
                ? stampOf(who.verified, 'return', cloud.returnId, cloud.refundMinor)
                : stampOf(who.verified, 'sale', sale!.saleId, sale!.totalMinor),
            };
          }
          // A refund's manager approval (ADR-0021): needed by the shop's threshold, or named on the record, it must be one
          // THIS box issued for exactly this refund — spent here, once. The box writes the approver it verified.
          if (isReturn && who !== undefined && input.approvals !== undefined && input.operators !== undefined) {
            const approval = await input.approvals.checkReturn({ record: parsed, requestedBy: who.verified.userId, laneId: input.operators.laneId, returnId: id });
            if (!approval.ok) {
              send(res, 200, { committed: false, refusedBecause: approval.refusedBecause, laneMessage: approval.laneMessage }, cors);
              return;
            }
            if (approval.stamp !== undefined) {
              // The approval it issued and spent, sealed to this refund and its amount (ADR-0023).
              const refund = toCloudReturn(parsed);
              const laneId = input.operators.laneId;
              const seal = input.operators.seal?.({
                fact: 'approval', recordId: refund.returnId, laneId, userId: approval.stamp.approvedBy, via: 'approval',
                amountMinor: refund.refundMinor, approvalId: approval.stamp.approvalId,
              });
              parsed = {
                ...(parsed as Record<string, unknown>), approvedBy: approval.stamp.approvedBy,
                approvalVerified: { ...approval.stamp, laneId, ...(seal === undefined ? {} : { seal }) },
              };
            }
          }
        }

        // The bill's number (audit PF-04): one this box issued to this lane, not on another record. A sale carries it as
        // `receiptNumber` (the till's record calls it `number`), a refund as `number`. Checked before the disk; its use is noted once the record is there.
        let numberUse: UseCheck | undefined;
        if (!isTag && input.receiptNumbers !== undefined && input.operators !== undefined) {
          const r = (parsed ?? {}) as Record<string, unknown>;
          numberUse = input.receiptNumbers.checkUse({ laneId: input.operators.laneId, receiptNumber: isReturn ? r['number'] : (r['receiptNumber'] ?? r['number']), recordId: id });
          if (!numberUse.ok) {
            send(res, 200, { committed: false, refusedBecause: numberUse.refusedBecause, laneMessage: numberUse.laneMessage }, cors);
            return;
          }
        }

        try {
          // The whole of this server. `commit`/`commitReturn` writes to the disk, waits for the
          // fsync, and only then queues for the cloud — the order is the rule and it lives in the
          // edge, not here.
          const outcome = isTag
            ? await input.node.commitConcessionTag(id, JSON.stringify(parsed))
            : isReturn
              ? await input.node.commitReturn(id, JSON.stringify(parsed))
              : await input.node.commit(id, JSON.stringify(parsed));
          if (outcome.committed && numberUse?.ok === true) await numberUse.record();
          // 200 on a refusal too: the *request* was understood, and the answer is in the body. A
          // 5xx here would make a refused sale look like a broken lane, and the cashier needs to
          // know which it is — one means use another lane, the other means try again.
          send(res, 200, outcome, cors);
        } catch (e) {
          send(res, 200, refusal(noun, e instanceof Error ? e.message : String(e)), cors);
        }
      })();
    });
  });

  return new Promise((resolve) => {
    // The bind address IS the control. See the note at the top of this file.
    server.listen(input.port, LANE_HOST, () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : input.port,
        // Stop accepting, then drop the connections still open. A browser keeps its sockets alive after the
        // page is done with them, and `close()` alone waits for those to go idle — on a busy tab that can be
        // longer than anyone waiting for the box to stop will accept (the e2e hook timed out on exactly this).
        stop: () => new Promise<void>((done) => { server.close(() => { done(); }); server.closeAllConnections(); }),
      });
    });
  });
}
