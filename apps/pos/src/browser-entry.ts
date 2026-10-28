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
import { posRolloutOf, type PosRollout } from './lane-rollout'; // OB-288 P4 (R8-9 · OB-316)
import type { CommitOutcome } from '../../../edge/store-edge/src/durability';
import type { SaleLookupResult } from '../../../edge/store-edge/src/receipt-lookup';
import { SyncOutbox } from '../../../packages/sync/src/outbox';
import { CatalogueCache, type CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import { quotationAtTill, laneQuotations, barcodesByProduct, QUOTATION_TILL_WORDS, type QuotationsLanePort, type QuotationAtTill } from './quotation-at-till'; // R7-C · OB-506
import { billCancelAtTill, BILL_CANCEL_WORDS, type BillCancelAnswer } from './bill-cancel-at-till'; // R8-B · OB-523
import { money } from '../../../packages/contracts/src/money';
import type { TenderKind } from '../../../packages/contracts/src/enums';
import { PAID_ON_OLD_ERP_WORDS } from '../../../packages/tender/src/paid-on-old-erp';
import { readOldErpBillNumber } from '../../../packages/tender/src/old-erp-bill-number';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';
import { PosSession, taxRateFromPercent, NoOperatorError, TillRuleRefusedError, SaleUnconfirmedError, GUEST_SALES_ONLY_WORDS, type RefusedOffer } from './session';
import type { LaneScales } from '../../../packages/restricted-sales/src/till-gate';
import {
  createTillSession, TILL_CASH_WORDS_FOR_THE_LANE,
  type CashMovementWrite, type ShiftCloseWrite, type TillCashRead, type CashMovementOutcome, type ShiftCloseOutcome, type TillCashStatus,
} from './till-session';
import { createPosView, type PosView } from './view-adapter';
import { customerDisplayFrame, CUSTOMER_DISPLAY_CHANNEL, type CustomerDisplayFrame } from './customer-display';
import { createDeviceHeartbeat, type DeviceHeartbeat, type DeviceStatus } from './device-heartbeat';
import {
  createRefundView, refundOutcomeOf, type RefundPolicy, type RefundLineChoice, type RefundScreenOutcome,
} from './refund-view';
import type { ReturnableLine } from '../../../packages/returns/src/return-register';
import { assessExchange, returnedValueAtOriginalPrices, type ExchangeBalanceKind } from '../../../packages/returns/src/exchange';
import { refundRequiresApproval, type ExchangeSettlementInput } from '../../../packages/returns/src/returns';
import { settle, type Tender } from '../../../packages/tender/src/tender';
import { billReceipt, billTaxInvoice, type BillReceipt, type BillTaxInvoice } from './bill-receipt';
import { billCopyPrint, type BillCopyPrint, type BillCopyAnswer } from './bill-copy'; // OB-373
import type { TaxInvoiceIdentity, InvoiceLanguage } from '../../../packages/receipt/src/tax-invoice';
import { fssaiLicenceNumberOn } from '../../../packages/receipt/src/receipt';
import type { B2cDynamicQrSetting } from '../../../packages/receipt/src/b2c-dynamic-qr';
import { readMachineReference, type MachineRefReading } from '../../../packages/tender/src/machine-reference';

import { mountDemoBanner, type BannerDocument } from '../../../packages/ui/src/demo-banner';
import { floorRefusal } from '../../../packages/price-guard/src/till-override'; // OB-500 (R7-A)
import { APP_BUILD_VERSION, judgeClientVersion, readPackVersionPolicy, type ClientKind, type ClientVersionJudgement } from '../../../packages/platform-admin/src/client-version'; // OB-501 (R7-A) · OB-521 (R8-A)

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
/**
 * D04-FR-05 (OB-288 Pkg 6b): a page the store computer serves on its DEVICE socket — the queue handheld — reaches the same
 * lane routes on that socket, same origin, through its own door (`/queue-pos/lane/…`), never the phone's own loopback.
 * Set once by that page's entry before it boots; unset everywhere else, so the till is exactly as before.
 */
let servedLaneBase: string | undefined;
export function serveLaneFrom(base: string | undefined): void {
  servedLaneBase = base === undefined || base === '' ? undefined : base;
}
/** The base URL of this till's edge: the store's loopback, unless the DEMO build says otherwise. */
export function laneBase(port: number, demoBase: string = DEMO_LANE_BASE): string {
  if (servedLaneBase !== undefined) return servedLaneBase;
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
  readonly source?: 'published' | 'this_box' | 'store_default';
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
  /** R1 (M01-FR-02): the shop's time zone from the store pack — the till dates by it. Absent on a page from an older box. */
  readonly timeZone?: string;
  readonly tradingDay: string;
  readonly storeId: string | null;
  /**
   * B6: the weighing scales this lane takes weight from, from the store pack — `known: false` (with why) when the box was
   * never told. Absent on a page from an older box: the till then sells nothing by weight (no stamp can be shown current).
   */
  readonly scales?: LaneScales;
  /**
   * B13 (OB-138): the hallmark HUIDs this store computer has already sold (from its own sales on disk) — so a gold piece
   * already sold is refused at the scan with no network. Absent on a page from an older box.
   */
  readonly soldHuids?: readonly string[];
  /**
   * OB-252: whether this till takes guest sales only (no customer number, no loyalty) and who turned it on — the store
   * pack or the store computer's own setting. Absent on a page from an older box: off.
   */
  readonly guestSalesOnly?: { readonly on: boolean; readonly by: 'store_pack' | 'store_computer_setting' | null };
  /**
   * OB-256: whether this till is in the MIRROR PILOT (every sale and refund is "Paid on old system") and who turned it on.
   * Absent on a page from an older box: off.
   */
  readonly mirrorPilot?: { readonly on: boolean; readonly by: 'store_pack' | 'store_computer_setting' | null };
  /**
   * OB-271: whether this till is in REAL TRADING (its bill is the legal tax invoice) and who turned it on — the box's own
   * `EDGE_REAL_TRADING=1` or the store pack. Absent on a page from an older box: off.
   */
  readonly realTrading?: { readonly on: boolean; readonly by: 'store_pack' | 'store_computer_setting' | null };
  /** OB-271: the shop's legal identity for the tax invoice, from the store's setup in the pack — `null` when not set up. */
  readonly taxInvoice?: TaxInvoiceIdentity | null;
  /** OB-271: the bill's paper when no published receipt template names one (`thermal-80` or `thermal-58`). */
  readonly billPaper?: string;
  /**
   * B10: the store's current FSSAI licence (number, last valid day) from the store pack — printed on every bill while it
   * is in force by this till's clock. Absent / null → no number is printed (never a made-up or expired one).
   */
  readonly fssaiLicence?: { readonly number: string; readonly validUntil?: string } | null;
  /** A22 (OB-326, switched off): the B2C dynamic QR switch and the shop's UPI ID, bank account and IFSC, from the store pack. */
  readonly b2cDynamicQr?: B2cDynamicQrSetting | null;
  /** OB-348 (B17): the shop's state (ISO 3166-2:IN code) from the store pack — liquor is judged by it. Null → "not set". */
  readonly shopState?: string | null;
  /** OB-299 (M12-FR-02): the catalogue product whose signed price is the delivery-fee line. Null → the owner has not set it. */
  readonly tillDeliveryFeeProductId?: string | null;
  /** OB-288 P4 (R8-9 · OB-316): this lane's rollout switches, resolved by the box from the signed pack (read by lane-rollout.ts). */
  readonly rollout?: unknown;
  /** OB-403 "A" · §31.1: the store computer's clock is 5+ minutes out — no offer starting after `cutoffAt` applies. */
  readonly offerHold?: { readonly held: boolean; readonly cutoffAt: string | null };
  /** OB-500 (R7-A): each product's lowest allowed price, from the signed store pack. Null → the box was not told. */
  readonly priceFloors?: Readonly<Record<string, number>> | null;
  /** OB-501 (R7-A): the app version policy from the signed store pack. Null → none set, nothing enforced. */
  readonly appVersionPolicy?: unknown;
}

/** The browser global this bundle attaches to (typed without needing the DOM lib). */
interface PosWindow {
  posSession?: PosView;
  /** Which lane this box is and when its day ends, injected by the edge before boot (SP-4b · F09). */
  posLane?: PosLane;
  /** OB-288 P4 (R8-9 · OB-316): is a trial feature on for this lane? From the signed pack, offline (lane-rollout.ts). */
  posRollout?: PosRollout;
  /** The lane's cached catalogue snapshot, injected by the edge before boot (§31). */
  posCatalogue?: CatalogueSnapshot;
  /** This lane's reserved receipt-number range, injected by the edge before boot (per lane). */
  /** The receipt template in force, injected by the edge before boot when this box has pulled one (M01-FR-02). */
  posReceiptTemplate?: PosReceiptTemplate;
  /** The refund policy the box's store pack carries — approval threshold + no-receipt cap — injected by the edge before
   *  boot (SP-9b-i · M13-FR-01). Absent when the box holds none: the till then offers NO return without a receipt. */
  posRefundPolicy?: RefundPolicy;
  /** The box's own lane socket, as the box that served this page names it (`http://127.0.0.1:<port>`). */
  laneWriteBase?: string;
}

/** Where this till's edge listens. Loopback only — see ADR-0004 and `edge/store-edge/src/lane-server.ts`. */
export const DEFAULT_LANE_PORT = 8090;

/**
 * The lane port the box that served this page names (`window.laneWriteBase`, `http://127.0.0.1:<port>`) — so a till
 * whose box listens on another port (installed with `--lane-port`, or a test box on a free port) posts where its box
 * listens. Anything else (absent, not this PC's loopback, not a port) is not a port, and the till keeps its default.
 */
export function lanePortFrom(laneWriteBase: unknown): number | undefined {
  if (typeof laneWriteBase !== 'string') return undefined;
  const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(laneWriteBase.trim());
  if (m === null) return undefined;
  const port = Number(m[1]);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

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

/**
 * What lowering a line to a new price takes off it — measured from the line's FIRST price (OB-500) — with the line, its
 * first price, quantity and unit the store computer needs to work the cut out itself; or why it cannot be lowered.
 */
export type PriceChangeValue =
  | { readonly ok: true; readonly reductionMinor: number; readonly fromUnitMinor: number; readonly productId: string; readonly lineId: string; readonly quantityMinor: number; readonly uom: string; readonly ownerOnly?: true }
  | { readonly ok: false; readonly laneMessage: string; readonly laneMessageTa?: string };

/** What a manager's approval at the till is for (ADR-0021): the kind, the bill (not for a no-receipt return) and the amount. */
export type TillApprovalKind = 'refund' | 'no_receipt_return' | 'exchange_refund' | 'no_sale' | 'price_override' | 'late_payment_answer' | 'card_refund_on_machine';
export interface TillApprovalRequest {
  readonly managerId: string;
  readonly pin: string;
  readonly kind: TillApprovalKind;
  readonly billRef?: string;
  readonly valueMinor: number;
  readonly reason: string;
  /** OB-500 (R7-A): for a price cut — the product and the new unit price, judged by the store computer's floor and limits. */
  readonly productId?: string;
  readonly toUnitMinor?: number;
  /** OB-500: and the line, its FIRST price (before any cut), its quantity and unit — the store computer works out the cut itself. */
  readonly lineId?: string;
  readonly fromUnitMinor?: number;
  readonly quantityMinor?: number;
  readonly uom?: string;
}
export type TillApprovalOutcome =
  | { readonly approved: true; readonly approvalId: string; readonly approvedBy: string; readonly displayName: string; readonly expiresAt: string }
  | { readonly approved: false; readonly refusedBecause?: string; readonly laneMessage: string; readonly laneMessageTa?: string };
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
        const body = await response.json() as { approved?: boolean; refusedBecause?: string; laneMessage?: string; laneMessageTa?: string };
        return body.approved === true
          ? body as unknown as TillApprovalOutcome
          : {
            approved: false, ...(typeof body.refusedBecause === 'string' ? { refusedBecause: body.refusedBecause } : {}), laneMessage: body.laneMessage ?? UNREACHABLE_APPROVAL,
            ...(typeof body.laneMessageTa === 'string' ? { laneMessageTa: body.laneMessageTa } : {}), // OB-500: the box's Tamil words
          };
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
// ── OB-350 scan-and-go (customer & delivery follow-ups) — begin: additive; the held-bill pattern, for a phone basket ──
/** What the till did with a customer's phone basket: the lines it rang through its OWN pack, and any it could not. */
export interface PhoneBasketAtTill {
  readonly ok: boolean;
  readonly refusedBecause?: string;
  readonly laneMessage: string;
  readonly code?: string;
  /** Rung through this till's pack — at the till's price, never the phone's. */
  readonly added?: readonly { readonly lineId: string; readonly description: string; readonly qty: number }[];
  /** Not rung: the cashier deals with each (an age to ask, an item this pack does not sell) — never dropped silently. */
  readonly notAdded?: readonly { readonly productId: string; readonly name: string; readonly qty: number; readonly laneMessage: string }[];
}
/** The phone-basket call to this till's own store computer (which asks head office under its own credential). */
export interface PhoneBasketsLanePort {
  recall(code: string): Promise<Record<string, unknown>>;
}
/** Phone baskets through this till's own store computer, asked with the cashier's session (OB-350). */
export function lanePhoneBaskets(port: number = DEFAULT_LANE_PORT): PhoneBasketsLanePort {
  return {
    recall: async (code) => {
      try {
        const response = await fetch(`${laneBase(port)}/lane/phone-baskets/recall`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify({ code }) });
        const front = FRONT_REFUSED[response.status];
        if (front !== undefined) return { ...front };
        return await response.json() as Record<string, unknown>;
      } catch {
        return { refusedBecause: 'lane_unreachable', laneMessage: 'This till cannot reach its store computer, so the phone basket cannot be brought up. Scan the items as usual.' };
      }
    },
  };
}
// ── OB-350 scan-and-go — end ──
// ── D04-FR-05 queue-busting (OB-288 Pkg 6b) — begin: additive; the phone-basket pattern, for a handheld's basket ──
/** The queue-basket call to this till's own store computer, which holds what its queue handhelds handed over (offline). */
export interface QueueBasketsLanePort {
  recall(code: string): Promise<Record<string, unknown>>;
}
export function laneQueueBaskets(port: number = DEFAULT_LANE_PORT): QueueBasketsLanePort {
  return {
    recall: async (code) => {
      try {
        const response = await fetch(`${laneBase(port)}/lane/queue-baskets/recall`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify({ code }) });
        const front = FRONT_REFUSED[response.status];
        if (front !== undefined) return { ...front };
        return await response.json() as Record<string, unknown>;
      } catch {
        return { refusedBecause: 'lane_unreachable', laneMessage: 'This till cannot reach its store computer, so the handheld basket cannot be brought up. Scan the items as usual.' };
      }
    },
  };
}
// ── D04-FR-05 — end ──
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
/** What the store computer says a member may spend now (PF-09 step 3). Amounts in paise. */
export interface LoyaltyWalletAnswer {
  readonly ok: boolean;
  readonly refusedBecause?: string;
  readonly laneMessage: string;
  readonly points?: number;
  readonly pointValuePaise?: number;
  readonly pointsValueMinor?: number;
  readonly storeCreditMinor?: number;
  readonly capRemainingMinor?: number;
  /** Head office's clock on the box's copy — how old the balances are (P-08). */
  readonly asOf?: string;
  readonly last4?: string;
  /**
   * OB-295: the member's tier as the box's copy says — `tiersSet: false` while the owner has set no tiers ("not set"); else
   * the tier's name (null below the lowest tier) and its points multiplier in basis points (10 000 = 1×).
   */
  readonly tier?: { readonly tiersSet: false } | { readonly tiersSet: true; readonly name: string | null; readonly multiplierBps: number };
}

export interface CardAttemptAnswer {
  readonly ok: boolean;
  readonly refusedBecause?: string;
  readonly laneMessage: string;
  readonly attemptId?: string;
  /** asked · approved · declined · no_answer · recovered_paid · recovered_not_paid */
  readonly state?: string;
  readonly amountMinor?: number;
  /** OB-271: the machine's approval / reference number the box recorded for an approved payment (real trading). */
  readonly machineRef?: string;
}
/** The card/UPI attempt calls to this till's own store computer. */
export interface PaymentAttemptsPort {
  ask(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  answer(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  recover(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** OB-271: the box's account of this till's card/UPI payments (GET), with each machine reference. Optional for test doubles. */
  list?(): Promise<Record<string, unknown>>;
}

/** OB-271 · audit A9: one card or UPI payment as the box recorded it, with the machine's approval / reference number. */
export interface CardPaymentRow {
  readonly attemptId: string;
  readonly kind: 'card' | 'upi';
  readonly amountMinor: number;
  readonly state: string;
  readonly askedAt: string;
  readonly askedBy: string;
  readonly machineRef?: string;
  readonly saleId?: string;
}
/** OB-271 · audit A11: a card/UPI refund done on the shop's own machine, as the box recorded it. */
export interface CardRefundRow {
  readonly returnId: string;
  readonly kind: 'card' | 'upi';
  readonly amountMinor: number;
  readonly machineRef: string;
  readonly at: string;
  readonly by: string;
  readonly approvedBy: string;
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
    list: async () => {
      const response = await fetch(`${laneBase(port)}/lane/payment-attempts`, { headers: { ...operatorHeaders() } });
      return await response.json() as Record<string, unknown>;
    },
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

/** What the till says while a sale's answer is still awaited (A8). Never "saved", never "do not take money". */
export const SALE_UNCONFIRMED_WORDS = 'The store computer has not answered yet, so the till does not know whether this sale was saved. Do not ring it again. The till keeps asking until the store computer says saved or not saved.';
/** What the till says while a refund's answer is still awaited (RR-F02 · A8). */
export const REFUND_UNCONFIRMED_WORDS = 'This lane could not confirm the refund was saved yet. Do NOT hand back cash and do NOT run it again. The till keeps asking until the store computer says saved or not saved.';

/** How many times, and how far apart, a write whose answer was lost is re-sent before the till says "unconfirmed". */
export interface LaneRetry {
  readonly attempts?: number;
  readonly retryDelayMs?: number;
}

/**
 * The lane's durable write: post the sale to this till's own edge and wait for the answer.
 *
 * The wait is the point. `commit` does not return, the receipt number does not exist, and the
 * screen cannot say "Sale complete" until the disk has confirmed.
 *
 * **A lost reply is not a refusal (audit A8).** The edge has been idempotent on the sale id since GAP-SALE-IDEMPOTENCY-01
 * (12 Sep 2026): the same record sent again is answered with the original outcome and writes nothing new. So a dropped
 * answer is resolved the way a refund's always was — the SAME record is re-posted under the SAME id. Only when the box
 * still does not answer is the outcome **unconfirmed**; the session then holds the sale and keeps asking
 * (`PosSession.confirmPendingSale`). The till used to call a lost reply "Do not take money", which for a sale the box had
 * in fact saved left a phantom sale (the drawer short) and, when the customer was rung again, a second sale.
 */
export function laneDurable(port: number = DEFAULT_LANE_PORT, retry: LaneRetry = {}): DurableWrite {
  return laneDurableTo('/lane/sales', port, SALE_UNCONFIRMED_WORDS, {
    ...retry,
    // A sale is on the box when the box's own bill lookup finds it under this id.
    onTheBox: async (id) => {
      const found = await askLookup(port, id);
      if (found === 'unknown') return 'unknown';
      return found !== null && found.sale.saleId === id ? 'saved' : 'not_saved';
    },
  });
}

/**
 * The lane's durable write for a REFUND: post it to this till's own edge on `/lane/returns` and wait
 * (M13-FR-01). The mirror of `laneDurable`: a lost reply is resolved by re-posting under the SAME id, which the edge
 * treats idempotently (RR-F03), so a retry can never cause a second refund — it only learns whether the first attempt
 * recorded (RR-F02).
 */
export function laneDurableReturn(port: number = DEFAULT_LANE_PORT, retry: LaneRetry = {}): DurableWrite {
  return laneDurableTo('/lane/returns', port, REFUND_UNCONFIRMED_WORDS, {
    ...retry,
    // A refund against a bill is on the box when that bill's lookup lists it. One with no bill (no receipt) cannot be
    // looked up this way, so it stays unconfirmed rather than being guessed either way.
    onTheBox: async (id, record) => {
      const original = ((): unknown => { try { return (JSON.parse(record) as { originalSaleId?: unknown }).originalSaleId; } catch { return undefined; } })();
      if (typeof original !== 'string' || original === '') return 'unknown';
      const found = await askLookup(port, original);
      if (found === 'unknown' || found === null) return 'unknown';
      return found.refunds.some((r) => r.returnId === id) || found.returns.some((r) => r.returnId === id) ? 'saved' : 'not_saved';
    },
  });
}

/** The box's own bill lookup (read-only): the bill, `null` when the box says it has none, `'unknown'` when it did not answer. */
async function askLookup(port: number, receiptOrId: string): Promise<SaleLookupResult | null | 'unknown'> {
  try {
    const response = await fetch(`${laneBase(port)}/lane/lookup?receipt=${encodeURIComponent(receiptOrId)}`);
    const body = await response.json() as { found?: boolean; detail?: unknown } & Partial<SaleLookupResult>;
    if (body.found === true && body.sale !== undefined) return { sale: body.sale, returns: body.returns ?? [], refunds: body.refunds ?? [] };
    // `found: false` with a detail is the box failing to read its own logs — not an answer.
    return body.found === false && body.detail === undefined ? null : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Post a record to one of the till's edge write routes and wait for its durable answer.
 *
 * A lost reply is not the same as a refusal (RR-F02 · A8). Both routes are idempotent on the record's id, so a dropped
 * response is retried by re-posting the SAME record: the edge returns the original outcome for a repeat, so the retry
 * resolves whether the first attempt landed without any risk of a double effect.
 *
 * One more case is closed here: once a reply has been lost, a LATER answer that refuses (a check the box runs before its
 * idempotency guard — the cashier's session ended, the pack changed) cannot be read as "not saved", because the first
 * attempt may already be on the disk. The till then asks the box's own bill lookup: there → saved; not there → the
 * refusal stands; no answer → unconfirmed. Only when the store cannot be reached at all is the outcome **unconfirmed**:
 * `committed` is false, but it must never be read as a definite failure that invites running the write again.
 */
function laneDurableTo(
  path: '/lane/sales' | '/lane/returns',
  port: number,
  unconfirmedWords: string,
  opts: LaneRetry & { readonly onTheBox: (id: string, record: string) => Promise<'saved' | 'not_saved' | 'unknown'> },
): DurableWrite {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const retryDelayMs = opts.retryDelayMs ?? 100;
  return async (id, record) => {
    let lastError: unknown;
    let replyLost = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let answer: CommitOutcome;
      try {
        const response = await fetch(`${laneBase(port)}${path}`, {
          method: 'POST',
          // The shift session (ADR-0020): the box writes nothing a signed-in cashier did not send.
          headers: { 'content-type': 'application/json', ...operatorHeaders() },
          body: record,
        });
        answer = await response.json() as CommitOutcome;
      } catch (e) {
        // The reply was lost, or the store did not answer. The same record is re-posted (same identity), so the edge
        // dedupes it — a retry cannot double-record.
        lastError = e;
        replyLost = true;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        continue;
      }
      if (answer.committed || !replyLost) return answer;
      // Refused AFTER an earlier reply was lost: the earlier attempt may be on the disk. Ask the box which.
      const onTheBox = await opts.onTheBox(id, record);
      if (onTheBox === 'saved') {
        return { committed: true, durable: true, detail: `${id} was saved by an earlier attempt whose answer was lost`, laneMessage: 'Saved on the store computer.' };
      }
      if (onTheBox === 'not_saved') return answer;
      return {
        committed: false, unconfirmed: true, refusedBecause: 'could_not_write_durably',
        detail: `the store computer refused a re-send of ${id} and could not say whether the first attempt was saved: ${answer.detail}`,
        laneMessage: unconfirmedWords,
      };
    }
    // Could not reach the store after the safe retries. The record MIGHT be saved — we do not know, and saying
    // "definitely failed" here is what leads to a second sale or a second refund. Report it as unconfirmed instead.
    return {
      committed: false,
      unconfirmed: true,
      refusedBecause: 'could_not_write_durably',
      detail: `the lane's local store did not answer on port ${port} after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      laneMessage: unconfirmedWords,
    };
  };
}

/**
 * Look up a bill this lane rang, over the loopback READ route (M13-FR-01) — read-only, never a
 * write. The mirror of the durable-write helpers, for the refund screen: the edge answers from its
 * own logs, so it works offline for a bill this lane knows. A bill it did not ring resolves `null`.
 */
export type LaneLookup = (receipt: string) => Promise<SaleLookupResult | null>;

/** M12-FR-01: a till's scan-to-line figures for today as the store computer keeps them, or why there are none. */
export type ScanSpeedRead =
  | { readonly known: true; readonly day: string; readonly samples: number; readonly p95Ms: number; readonly medianMs: number; readonly maxMs: number; readonly overTargetCount: number; readonly targetMs: number; readonly withinTarget: boolean; readonly droppedSamples: number; readonly waiting: number }
  | { readonly known: false; readonly why: string; readonly waiting: number };

/** M12-FR-01: how many timed scans the till holds for the box at most, and after how many it sends them. */
export const SCAN_TIMES_HELD = 1_000;
export const SCAN_TIMES_SEND_EVERY = 25;

/**
 * OB-264: look up the mirror sale that carries this OLD ERP bill number, over the same loopback READ route — the box finds
 * it in its own register (offline on the box). Resolves `null` when no sale carries it.
 */
export function laneLookupByOldBill(port: number = DEFAULT_LANE_PORT): LaneLookup {
  return async (oldBill) => {
    const response = await fetch(`${laneBase(port)}/lane/lookup?oldBill=${encodeURIComponent(oldBill)}`);
    const body = await response.json() as { found?: boolean } & Partial<SaleLookupResult>;
    return body.found === true && body.sale !== undefined
      ? { sale: body.sale, returns: body.returns ?? [], refunds: body.refunds ?? [] }
      : null;
  };
}

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
    readonly topUp?: { readonly kind: 'cash' | 'card' | 'upi'; readonly outcome?: 'approved' | 'declined' | 'no_answer'; readonly ref?: string; readonly machineRef?: string };
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
  /**
   * OB-390: what `quantityMinor` of a product on this bill is worth at the price the bill charged for it (the engine's own
   * `returnedValueAtOriginalPrices`, over the bill's earlier returns), never above what is still refundable — the refund
   * AMOUNT the screen offers by default. Only the amount: the method is always the cashier's choice, and the cashier may
   * still change the amount (the engine judges whatever is sent, M13-FR-03).
   */
  readonly lineValueMinor: (productId: string, quantityMinor: number) => number;
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
  /** R1 (M01-FR-02): the shop's IANA time zone (the box serves the pack's). Absent = this device's own wall clock. */
  timeZone?: string;
  /** B6: the weighing scales this lane takes weight from (store pack, via the box). Absent = never told → no weighed sale. */
  laneScales?: LaneScales;
  /** B13: the HUIDs the store computer has already sold (served with the page). */
  soldHuids?: readonly string[];
  taxPercent?: number;
  /** The lane's cached catalogue snapshot; without it, barcode scanning is off. */
  catalogue?: CatalogueSnapshot;
  /** OB-403 "A" · §31.1: offers starting after this instant do not apply (the store computer's clock is out). Absent: none held. */
  offerHoldCutoff?: string | null;
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
  /** OB-264: look up a mirror sale by the old ERP's bill number. Overridable for tests; production asks this till's own edge. */
  laneLookupByOldBill?: LaneLookup;
  /** The till's operator calls to its box (ADR-0020). Overridable for tests; production asks this till's own edge. */
  operatorPort?: TillOperatorPort;
  /** The till's manager-approval call to its box (ADR-0021). Overridable for tests; production asks this till's own edge. */
  approvalPort?: TillApprovalPort;
  /** The till's held-basket calls to its box (audit PF-05). Overridable for tests; production asks this till's own edge. */
  heldBillsPort?: HeldBillsPort;
  /** OB-350: the till's phone-basket call to its box. Overridable for tests; production asks this till's own edge. */
  phoneBasketsPort?: PhoneBasketsLanePort;
  /** D04-FR-05: the till's queue-basket call to its box. Overridable for tests; production asks this till's own edge. */
  queueBasketsPort?: QueueBasketsLanePort;
  /** R7-C · OB-506: the till's quotation call to its box. Overridable for tests; production asks this till's own edge. */
  quotationsPort?: QuotationsLanePort;
  /** The till's card/UPI attempt calls to its box (audit PF-06). Overridable for tests; production asks this till's own edge. */
  paymentsPort?: PaymentAttemptsPort;
  /** The till's void-evidence call to its box (audit PF-07). Overridable for tests; production posts to this till's own edge. */
  tillActivityPost?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /**
   * The device re-send's timer (D04-FR-05 · P-08): `every(ms, fn)` answers a cancel, `soon(fn)` runs off the call stack.
   * Overridable for tests (a simulated clock); production uses `setInterval` / `setTimeout`.
   */
  deviceHeartbeatTimers?: { readonly every?: (ms: number, fn: () => void) => () => void; readonly soon?: (fn: () => void) => void };
  /** The till's loyalty-balance call to its box (PF-09 step 3). Overridable for tests; production posts to this till's own edge. */
  loyaltyWalletPost?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** OB-252: guest sales only — no customer number, no loyalty — as the box told the page. Absent = off. */
  guestSalesOnly?: boolean;
  /** OB-256 · OB-258: the mirror pilot — every sale and refund is "Paid on old system" — as the box told the page. Absent = off. */
  mirrorPilot?: boolean;
  /** OB-271: real trading — every sale's bill is the legal tax invoice, checked before the disk — as the box told the page. Absent = off. */
  realTrading?: boolean;
  /** OB-271: the shop's legal identity for the tax invoice (legal name, address, GSTIN) — `null`/absent when not set up. */
  taxInvoice?: TaxInvoiceIdentity | null;
  /** OB-271: the bill's paper when no receipt template names one (`thermal-80` default, or `thermal-58`). */
  billPaper?: string;
  /** B10: the store's current FSSAI licence from the store pack — its number printed on every bill while in force. */
  fssaiLicence?: { readonly number: string; readonly validUntil?: string } | null;
  /** A22 (OB-326): the B2C dynamic QR — printed on the tax invoice only when switched on and every detail is set. */
  b2cDynamicQr?: B2cDynamicQrSetting | null;
  /** OB-348 (B17): the shop's state from the store pack (absent → "not set"; liquor is refused either way). */
  shopState?: string;
  /** OB-299: the delivery-fee product from the store pack (absent → not set; the till refuses to mark a bill for delivery). */
  tillDeliveryFeeProductId?: string;
  /** OB-500 (R7-A): each product's lowest allowed price from the signed pack (absent/null → not told). */
  priceFloors?: Readonly<Record<string, number>> | null;
  /** OB-501 (R7-A): the app version policy from the signed pack (absent/null → nothing enforced). */
  appVersionPolicy?: unknown;
  /** OB-501: this till's build (tests). Absent → the build this bundle was made from (`APP_BUILD_VERSION`). */
  appVersion?: string;
  /** OB-521 (R8-A): which till this is — the queue till's refusal names the basket, not the bill. Absent → a fixed till. */
  clientKind?: ClientKind;
}): PosView & {
  /** OB-252: whether this till takes guest sales only — the screen shows it whenever it is on. */
  readonly guestSalesOnly: () => boolean;
  /** OB-256: whether this till is in the mirror pilot — then "Paid on old system" is its only tender, for sales and refunds. */
  readonly mirrorPilot: () => boolean;
  /** OB-271: whether this till is in real trading — then each bill is the legal tax invoice, printed on paper. */
  readonly realTrading: () => boolean;
  /**
   * OB-271: the TAX INVOICE of the sale this till last committed (real trading), laid out for paper in English or Tamil —
   * a reprint marked DUPLICATE — or why there is none. Every Rule 46 field is checked on the render before it is handed out.
   */
  readonly taxInvoice: (options?: { readonly language?: InvoiceLanguage; readonly duplicate?: boolean }) => BillTaxInvoice;
  /**
   * OB-373: a COPY of any bill this store computer holds, by its number (a handheld queue till's above all) — recorded on the
   * box (who, which copy, why) before it is answered, printed marked as a duplicate. `ok: false` says why, in words.
   */
  readonly printBillCopy: (input: { readonly billNumber: string; readonly reason: string; readonly language?: InvoiceLanguage }) => Promise<BillCopyPrint & { readonly laneMessage: string; readonly laneMessageTa?: string; readonly refusedBecause?: string }>;
  /** OB-271: what the cashier typed as the card machine's / UPI's approval or reference number — the kept form, or why not. */
  readonly readMachineRef: (typed: string) => MachineRefReading;
  /**
   * OB-271 · audit A9: the card and UPI payments this till's store computer recorded as paid, with the machine's approval /
   * reference number for each, and the card/UPI refunds done on the machine — the list the day is matched against the
   * machine's settlement slip with. `null` when the box did not answer.
   */
  readonly cardPayments: () => Promise<{ readonly paid: readonly CardPaymentRow[]; readonly unresolved: readonly CardPaymentRow[]; readonly refundsOnMachine: readonly CardRefundRow[] } | null>;
  /**
   * OB-271 · audit A11: a refund to a card or UPI, DONE on the shop's own machine — recorded on the store computer with the
   * machine's own refund reference and a second person's approval (a manager, with their own PIN), instead of staying
   * "pending" forever.
   */
  readonly recordCardRefundOnMachine: (input: { readonly returnId: string; readonly refundMinor: number; readonly refundTender: 'card' | 'upi'; readonly machineRef: string; readonly approval: { readonly approvalId: string } }) => Promise<{ readonly ok: boolean; readonly refusedBecause?: string; readonly laneMessage: string }>;
  /** A8 · RR-F02: the refund whose answer was lost, still waiting for the store computer — or null. */
  readonly pendingRefund: () => { readonly returnId: string; readonly number: string } | null;
  /** A8 · RR-F02: ask the store computer again about that refund (same record, same id) — one screen state, never throws. */
  readonly confirmPendingRefund: () => Promise<RefundScreenOutcome>;
  /**
   * A8, after a reload: the page no longer holds the record it sent, so it can only ASK the box whether a sale (by its id)
   * or a refund (by its id and the bill it was against) is on its disk: `saved`, `not_saved`, or `unknown` (no answer).
   */
  readonly saleOnBox: (saleId: string) => Promise<'saved' | 'not_saved' | 'unknown'>;
  readonly refundOnBox: (returnId: string, originalSaleId: string | null) => Promise<'saved' | 'not_saved' | 'unknown'>;
  /**
   * What the named loyalty member may spend at this till now (PF-09 step 3): their points (and what they are worth), their
   * store credit, and what the owner's daily till limit still allows — from the store computer's copy of head office's
   * balances, with how old that copy is. Refused when no member is named or the box has no balances yet.
   */
  readonly loyaltyWallet: () => Promise<LoyaltyWalletAnswer>;
  /** D04-FR-05 · M12-FR-01: what the customer display shows now, from this till's own basket — no network. */
  readonly customerDisplay: () => CustomerDisplayFrame;
  /** The BroadcastChannel the display page listens on. */
  readonly customerDisplayChannelName: () => string;
  /** D04-FR-05: send what this till's devices say to the store computer (needs a signed-in cashier). */
  readonly reportDevices: (devices: readonly { readonly kind: string; readonly state: string; readonly detail?: string }[], adapterObservedAt?: string) => Promise<{ readonly recorded: boolean; readonly refusedBecause?: string; readonly laneMessage?: string }>;
  /** Round 15: the device adapter's own clock (when it last observed the devices), asked at each re-send. */
  readonly deviceAdapterClock: (clock: (() => unknown) | undefined) => void;
  /**
   * D04-FR-05 · P-08: the device adapter says how the devices are now. Kept as the last known and sent to the store
   * computer at once if anything changed; re-sent every 5 minutes while a cashier is signed in (`device-heartbeat.ts`).
   * Fire-and-forget: never awaited, never on the sale path, nothing sent while a sale is being written.
   */
  readonly devicesSaid: (devices: readonly { readonly kind: string; readonly state: string; readonly detail?: string }[], adapterObservedAt?: string) => void;
  /**
   * M12-FR-01 (QG-05 · §32 "scan-to-line p95 ≤ 300 ms — measured and shown"): the screen tells the till how long one scan
   * took, from the scanner's last key to the line on the screen. Kept here (at most 1 000 waiting), sent to the store
   * computer every 25 scans — after the scan, never on it, and never while a sale is being saved (hard rule #1).
   */
  readonly noteScanTime: (ms: number) => void;
  /**
   * M12-FR-01: send what is waiting and read THIS till's scan-to-line figures for today from the store computer — scans
   * timed, p95, median, slowest, how many over the 300 ms target. `known: false` with the reason when none was timed today
   * or the box cannot be reached — never a made-up figure (P-08).
   */
  readonly scanSpeed: () => Promise<ScanSpeedRead>;
  /** The device re-send itself — for the page and the tests (`running`, `tick`, `lastKnown`). */
  readonly deviceHeartbeat: DeviceHeartbeat;
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
  /**
   * OB-264: a MIRROR refund finds its sale by the old ERP's bill number on the customer's bill — `null` if no sale on the
   * store computer carries it. The refund rules then apply exactly as for `lookupRefund` (within the bill, approvals).
   */
  readonly lookupRefundByOldBill: (oldBill: string) => Promise<RefundLookup | null>;
  /** OB-264: what the keyer typed as an old bill number, judged (Rule 46(b) shape, no personal data) — the kept form, or why not. */
  readonly readOldBill: (typed: string) => { readonly ok: true; readonly value: string } | { readonly ok: false; readonly refusedBecause: string; readonly laneMessage: string };
  /** The return-without-a-receipt surface (SP-9b-i · M13-FR-01) — or `null` when this till may not offer one: no
   *  no-receipt cap was given (or it is 0, switched off), or the till has no catalogue to name the item from. */
  readonly noReceiptReturn: () => NoReceiptReturnSurface | null;
  /** The receipt template this lane prints with — header, footer and the version to stamp — or `null` when none
   *  has reached this box (print with defaults, stamp nothing). Read from the box's pack, never fetched at print time. */
  readonly receiptTemplate: () => PosReceiptTemplate | null;
  /**
   * B13 · M31-FR-02: the bill of the sale this till last committed, as it prints — through `@sre/receipt`, on the paper
   * format and with the header/footer of the template above — or why it could not be made (the sale stays saved).
   */
  readonly receiptLines: () => BillReceipt;
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
   * OB-350 scan-and-go: bring a customer's phone basket up by the six-digit code on their phone (onto an EMPTY till), and
   * ring every line through this till's own pack — the till's price, never the phone's. Payment and the bag check follow
   * as for any bill. A line the till cannot ring is listed for the cashier, never dropped. Offline: refused in words; the
   * cashier scans the items (the sale never needs it).
   */
  readonly recallPhoneBasketAtTill: (code: string) => Promise<PhoneBasketAtTill>;
  /**
   * D04-FR-05 queue-busting: bring up a basket a staff handheld scanned in the queue, by the four-digit code it showed (onto
   * an EMPTY till), from THIS till's store computer — offline — and ring every line through this till's own pack, exactly
   * as a phone basket. A line the till cannot ring is listed for the cashier, never dropped.
   */
  readonly recallQueueBasketAtTill: (code: string) => Promise<PhoneBasketAtTill>;
  /**
   * R7-C · OB-506 (M12-FR-02): ring a retail quotation up by its number (onto an EMPTY till) — head office converts it (once;
   * expired or withdrawn refused), the till rings each line through its own pack at the quoted price — lowered or raised
   * (owner, 28 Oct 2026), never above the MRP: a line quoted above it is refused in words. Needs head office: with it out of reach nothing is rung and the screen says so (`quotation-at-till.ts`).
   */
  readonly ringQuotationAtTill: (quotationNumber: string) => Promise<QuotationAtTill>;
  readonly quotationWords: (lang: 'en' | 'ta') => (typeof QUOTATION_TILL_WORDS)['en' | 'ta'];
  /**
   * R8-B · OB-523: cancel the whole bill before it is paid, with a reason — the store computer keeps every line's void and
   * frees each quotation this bill rang up (queued for head office, sent once), then the till starts a fresh bill. Nothing
   * is cleared unless the box has it; a paid bill is refunded, never cancelled here.
   */
  readonly cancelBillAtTill: (reason: string) => Promise<BillCancelAnswer>;
  readonly billCancelWords: (lang: 'en' | 'ta') => (typeof BILL_CANCEL_WORDS)['en' | 'ta'];
  /** R8-B · OB-523: the quotations rung up on the bill in progress (what a cancel would free). */
  readonly quotationsOnBill: () => readonly string[];
  /**
   * Record a card or UPI payment on the store computer BEFORE the machine is asked (audit PF-06). The answer's
   * `attemptId` is the reference the machine is given. Refused while this bill has a payment that got no answer
   * (`unresolved_payment_on_this_bill` — check it with `checkCardPayment`), and when the bill already has a confirmed
   * payment (`already_paid_on_this_bill` — pay with it, do not ask the machine again).
   */
  readonly startCardPayment: (kind: 'card' | 'upi', amountMinor?: number) => Promise<CardAttemptAnswer>;
  /** What the machine said, recorded on the store computer. On `approved`, pay with `tenderCardOrUpi({ ..., ref: attemptId })`. */
  /** OB-55: an answer for an attempt of an EARLIER trading day needs a manager's approval at this till (`approvalId`). */
  /** OB-271: in real trading an `approved` answer carries the machine's approval / reference number (`machineRef`). */
  readonly answerCardPayment: (attemptId: string, outcome: 'approved' | 'declined' | 'no_answer', approvalId?: string, machineRef?: string) => Promise<CardAttemptAnswer>;
  /** Settle a payment that got no answer against the PROVIDER's record — never by hand. */
  readonly checkCardPayment: (attemptId: string) => Promise<CardAttemptAnswer>;
  /**
   * Void a line WITH evidence (audit PF-07): the line, its value and the reason go to the store computer — stamped with
   * the cashier it verified, queued for head office's loss-prevention record — and the line is removed only once the
   * box has it. Refused (the line stays) when the box cannot keep it.
   */
  readonly voidAtTill: (lineId: string, reason: string) => Promise<{ readonly ok: boolean; readonly refusedBecause?: string; readonly laneMessage: string }>;
  /** What lowering a line to `toUnitMinor` takes off it — the amount a manager approves (audit PF-07). */
  readonly priceChangeValue: (lineId: string, toUnitMinor: number) => PriceChangeValue;
  /**
   * Lower a line's price WITH a manager's approval issued on the store computer (audit PF-07 · M12-FR-04): the change, the
   * reason and the approval go to the box first; the price changes only once the box has them. Refused (price kept)
   * otherwise.
   */
  readonly priceChangeAtTill: (lineId: string, toUnitMinor: number, reason: string, approval: { readonly approvalId: string }) => Promise<{ readonly ok: boolean; readonly refusedBecause?: string; readonly laneMessage: string; readonly activityId?: string }>;
  /** The bill now on the till — what a manager's approval of a price change is bound to (PF-07). */
  readonly currentBillRef: () => string;
  /** Open the drawer with no sale, WITH a manager's approval — recorded on the box before the cashier is told to open it. */
  readonly noSaleAtTill: (reason: string, approval: { readonly approvalId: string }) => Promise<{ readonly ok: boolean; readonly refusedBecause?: string; readonly laneMessage: string; readonly activityId?: string }>;
  readonly signOut: () => void;
  /** Who is at the till now, or undefined when nobody is signed in. */
  readonly operator: () => string | undefined;
  /** Which lane this till is (null = the box never said) and the trading day a moment falls on, per the shop's cut-off. */
  readonly lane: () => { readonly laneId: string | null; readonly tradingDayCutoff: string; readonly tradingDayAt: (atIsoUtc: string) => string };
  /** NEW-1 (B19): offers in the pack this till refused to apply because they target a carry bag — for the lane to say. */
  readonly refusedOffers: () => readonly RefusedOffer[];
  /** OB-403 "A" · §31.1: the store computer's hold on new offers (its clock 5+ minutes out) — null lifts it. */
  readonly holdOffersStartingAfter: (cutoffAt: string | null) => void;
  /** OB-403: the loaded offers this till is not applying now, held while the store computer's clock is out. */
  readonly heldOffers: () => readonly string[];
  /**
   * OB-501 (R7-A): judge this till's build against a version policy (from the signed pack, re-read from the box's status) and
   * stop or allow STARTING new bills — a bill in progress is always finished. Returns the judgement.
   */
  readonly applyVersionPolicy: (policy: unknown) => ClientVersionJudgement;
  /** OB-501: the build this till runs. */
  readonly appVersion: string;
} {
  const outbox = new SyncOutbox();
  // The lane's catalogue, once indexed below — the session reads each product's pack flags from it (B14 · B19).
  const catalogueRef: { cache?: CatalogueCache } = {};
  // D04-FR-05 · P-01: how many sale/refund writes to the box are waiting for its answer. The device re-send never starts
  // while one is (`device-heartbeat.ts`); it goes once the write has answered. Counting only — no network here.
  let commitsInFlight = 0;
  const heartbeat: { ref?: DeviceHeartbeat } = {};
  const whileCommitting = (write: DurableWrite): DurableWrite => async (id, record) => {
    commitsInFlight += 1;
    try {
      return await write(id, record);
    } finally {
      commitsInFlight -= 1;
      if (commitsInFlight === 0) heartbeat.ref?.commitEnded();
    }
  };
  // Only what was GIVEN goes in: no lane, cashier or day is ever made up here (F09).
  const identity = {
    ...(config?.laneId === undefined ? {} : { laneId: config.laneId }),
    ...(config?.cashierId === undefined ? {} : { cashierId: config.cashierId }),
    ...(config?.tradingDay === undefined ? {} : { tradingDay: config.tradingDay }),
    ...(config?.tradingDayCutoff === undefined ? {} : { tradingDayCutoff: config.tradingDayCutoff }),
    ...(config?.timeZone === undefined ? {} : { timeZone: config.timeZone }),
  };
  const session = new PosSession(
    {
      ...identity,
      currency: 'INR',
      defaultTaxRate: taxRateFromPercent(config?.taxPercent ?? 18),
      // SF-01: offers are judged against this lane's own clock — no network, no fixed date.
      clock: () => new Date().toISOString(),
      // B6: weight only from a scale whose stamp is current — this lane's scales, as the box's store pack names them.
      ...(config?.laneScales === undefined ? {} : { laneScales: config.laneScales }),
      // B13: the HUIDs the store computer has sold, as it served them with this page — read once, held in memory.
      ...(config?.soldHuids === undefined ? {} : { soldHuids: ((sold) => () => sold)(new Set(config.soldHuids)) }),
      // B14 · B19: the commit's second gate reads each product's flags from the lane's own signed catalogue.
      regulatedFlagsOf: (productId: string) => catalogueRef.cache?.findByProductId(productId)?.regulatedFlags,
      // A7: the compensation cess each product's HSN carries, from the lane's own signed pack.
      cessOf: (productId: string) => catalogueRef.cache?.findByProductId(productId)?.cess,
      // B6 · NEW-2: whether a line is weighed comes from the lane's own signed catalogue, not only the line's unit.
      baseUomOf: (productId: string) => catalogueRef.cache?.findByProductId(productId)?.baseUom,
      // B17 · OB-348: each product's HSN from the lane's signed pack (an alcoholic-drink heading is refused), and the shop's state.
      hsnCodeOf: (productId: string) => catalogueRef.cache?.findByProductId(productId)?.hsnCode,
      // OB-506: each product's MRP from the lane's signed pack — a line raised to a quotation's price never passes it.
      mrpOf: (productId: string) => catalogueRef.cache?.findByProductId(productId)?.mrpMinor,
      ...(config?.shopState === undefined ? {} : { shopState: config.shopState }),
      // OB-306: a bundle line is exploded into its components from the lane's signed pack.
      bundleOf: (productId: string) => catalogueRef.cache?.bundleOf(productId),
      // OB-299: the delivery-fee product the store pack names (absent → not set; delivery bills are refused in words).
      ...(config?.tillDeliveryFeeProductId === undefined ? {} : { deliveryFeeProductId: config.tillDeliveryFeeProductId }),
      // OB-252: guest sales only — no customer number, no points or store credit.
      ...(config?.guestSalesOnly === true ? { guestSalesOnly: true } : {}),
      // OB-256: the mirror pilot — "Paid on old system" is the only tender.
      ...(config?.mirrorPilot === true ? { mirrorPilot: true } : {}),
      // OB-271: real trading — the bill is the legal tax invoice, checked before the disk.
      ...(config?.realTrading === true ? { realTrading: { identity: config.taxInvoice ?? null } } : {}),
      // OB-501 (R7-A): every sale names the build that rang it.
      appVersion: config?.appVersion ?? APP_BUILD_VERSION,
    },
    new Ledger(new InMemoryLedgerStore()),
    outbox,
    whileCommitting(config?.durable ?? laneDurable(config?.lanePort ?? DEFAULT_LANE_PORT)),
  );
  // Indexing happens once at boot, so every subsequent scan is O(1) (§32).
  const catalogue = config?.catalogue ? new CatalogueCache(config.catalogue) : undefined;
  catalogueRef.cache = catalogue;
  // SF-01: the switched-on offers the signed pack carried — applied at checkout from the lane's own copy (P-01).
  session.loadPromotions(config?.catalogue?.promotions ?? []);
  // OB-403 "A": a till opened while the store computer's clock is 5+ minutes out starts with the box's hold on new offers.
  session.holdOffersStartingAfter(config?.offerHoldCutoff ?? null);
  // OB-501 (R7-A): a withdrawn or too-old build starts no new bill (it finishes the one in progress) — from the signed pack.
  const appVersion = config?.appVersion ?? APP_BUILD_VERSION;
  const applyVersionPolicy = (policy: unknown): ClientVersionJudgement => {
    const judged = judgeClientVersion(appVersion, readPackVersionPolicy(policy), config?.clientKind ?? 'till');
    session.barNewBills(judged.mayStartBill || judged.words === undefined ? null : judged.words);
    return judged;
  };
  applyVersionPolicy(config?.appVersionPolicy);
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
      ...(config?.guestSalesOnly === true ? { guestSalesOnly: true } : {}),
      // OB-258: a mirror-pilot refund goes back to "Paid on old system".
      ...(config?.mirrorPilot === true ? { mirrorPilot: true } : {}),
      // M13-FR-02: a recalled unit coming back is held, never put back for sale — from this lane's own signed pack.
      recallOf: (productId: string) => catalogueRef.cache?.findByProductId(productId),
      // OB-306: a returned bundle comes back as its components, from this lane's own signed pack.
      bundleOf: (productId: string) => catalogueRef.cache?.bundleOf(productId),
      baseUomOf: (productId: string) => catalogueRef.cache?.findByProductId(productId)?.baseUom,
    },
    new Ledger(new InMemoryLedgerStore()),
    outbox,
    {
      // The refund's durable write goes to this till's own edge, exactly as the sale's does.
      durableReturn: whileCommitting(config?.durableReturn ?? laneDurableReturn(lanePort)),
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
  // OB-279 · OB-285 (real trading): an exchange's replacement is charged its tax invoice's rounded total — the till's own
  // payable for the goods on the bill now (its lines plus a round off of 0 down to −₹1). Off real trading: nothing.
  const replacementRoundOff = (): { readonly replacementRoundOffMinor?: number } => {
    const roundOff = session.totals().roundOffMinor;
    return roundOff === undefined || roundOff === 0 ? {} : { replacementRoundOffMinor: roundOff };
  };

  const lookupByOldBill = config?.laneLookupByOldBill ?? laneLookupByOldBill(config?.lanePort ?? DEFAULT_LANE_PORT);
  const lookupRefundByOldBill = async (oldBill: string): Promise<RefundLookup | null> => {
    const read = readOldErpBillNumber(oldBill);
    if (!read.ok) return null;
    const found = await lookupByOldBill(read.value);
    return found === null ? null : refundLookupOf(found);
  };
  const readOldBill = (typed: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly refusedBecause: string; readonly laneMessage: string } => {
    const read = readOldErpBillNumber(typed);
    return read.ok ? { ok: true, value: read.value } : { ok: false, refusedBecause: read.refusedBecause, laneMessage: read.laneMessage };
  };
  const lookupRefund = async (receipt: string): Promise<RefundLookup | null> => {
    const found = await lookup(receipt);
    return found === null ? null : refundLookupOf(found);
  };
  const refundLookupOf = (found: SaleLookupResult): RefundLookup => {
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
      lineValueMinor: (productId, quantityMinor) => Math.max(0, Math.min(
        refundView.maxRefundMinor(originalSale),
        returnedValueAtOriginalPrices(originalSale, [{ productId, quantityMinor }], found.returns.flatMap((r) => r.lines)),
      )),
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
        // OB-279 · OB-285 (real trading): the replacement's round off as the till's own payable has it — the bill the
        // customer is charged for the new goods. Off real trading the till charges the lines, and nothing is passed.
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
              // OB-279 · OB-285: in real trading the replacement is charged its tax invoice's rounded total (never above it).
              ...replacementRoundOff(),
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
              ...replacementRoundOff(),
            },
          }))();
          if (!q.ok) return { kind: 'invalid', laneMessage: `${q.detail} Nothing was recorded.` };
          // OB-258: in the mirror pilot an exchange is keyed as a refund plus a sale, each on the old system's payment.
          if (config?.mirrorPilot === true) return { kind: 'invalid', laneMessage: PAID_ON_OLD_ERP_WORDS.noExchange };

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
            tenders.push({
              kind: topUp.kind, amount: money(q.balanceMinor, 'INR'), status: topUp.kind === 'cash' ? 'settled' : 'authorized', ...(topUp.ref === undefined ? {} : { ref: topUp.ref }),
              // OB-271: the shop's own machine's approval number, in real trading.
              ...(topUp.machineRef === undefined || topUp.machineRef === '' ? {} : { machineRef: topUp.machineRef }),
            });
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
            // The replacement sale's answer was lost (A8): it MAY be saved. Not "half done" yet — the screen keeps asking
            // the store computer (`confirmPendingSale`) and only then says which.
            if (e instanceof SaleUnconfirmedError) throw e;
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
  // B10: the store's FSSAI licence number on every bill — while it is in force by this till's own clock (offline).
  const fssaiLicenceNo = (): string | undefined => {
    const day = session.laneToday();
    return day === undefined ? undefined : fssaiLicenceNumberOn(config?.fssaiLicence, day);
  };
  const receiptLines = (): BillReceipt => billReceipt(session.lastBill(), receiptTemplate(), ((n) => (n === undefined ? {} : { fssaiLicenceNo: n }))(fssaiLicenceNo()));
  // OB-271: the tax invoice of the last real-trading sale, on the template's paper, else the box's own paper, else 80 mm.
  const billPaperTemplate = (): { readonly version: number; readonly header: readonly string[]; readonly footer: readonly string[]; readonly paperFormat?: string } | null => {
    const t = receiptTemplate();
    if (t !== null) return t.paperFormat === undefined && config?.billPaper !== undefined ? { ...t, paperFormat: config.billPaper } : t;
    return config?.billPaper === undefined ? null : { version: 0, header: [], footer: [], paperFormat: config.billPaper };
  };
  const taxInvoice = (options: { readonly language?: InvoiceLanguage; readonly duplicate?: boolean } = {}): BillTaxInvoice =>
    billTaxInvoice(session.lastBill(), {
      template: billPaperTemplate(), ...((n) => (n === undefined ? {} : { fssaiLicenceNo: n }))(fssaiLicenceNo()),
      ...(config?.b2cDynamicQr === undefined || config.b2cDynamicQr === null ? {} : { b2cDynamicQr: config.b2cDynamicQr }), ...options,
    });

  // The cashier signs in ONCE for both surfaces — the sale and the till name the same person (SP-4b · F09).
  // D04-FR-05 · P-08: the device re-send runs only while somebody is signed in (it is defined further down).
  const signIn = (cashierId: string): void => { session.signIn(cashierId); till.signIn(cashierId); heartbeat.ref?.start(); };
  const signOut = (): void => { heartbeat.ref?.stop(); session.signOut(); till.signOut(); };
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

  // SUPERVISOR OVERRIDES AS EVIDENCE (audit PF-07 · M12-FR-04 · M15-FR-01): a no-sale (the drawer opened with no sale)
  // and a price lowered on a line. Each needs a manager's approval issued on the store computer for exactly this, and is
  // on the box's disk — with the cashier and the manager it verified — before the till acts on it. Offline: only the box.
  type TillActivityAnswer = { readonly ok: boolean; readonly refusedBecause?: string; readonly laneMessage: string; readonly activityId?: string };
  const sendTillActivity = async (body: Record<string, unknown>, unreachable: string): Promise<Record<string, unknown>> => {
    const post = async (): Promise<Record<string, unknown>> => {
      const base = laneBase(config?.lanePort ?? DEFAULT_LANE_PORT);
      const response = await fetch(`${base}/lane/till-activity`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify(body) });
      const front = FRONT_REFUSED[response.status];
      if (front !== undefined) return { recorded: false, ...front };
      return await response.json() as Record<string, unknown>;
    };
    // A lost reply is asked again under the SAME activity id — the box answers "already recorded" for a repeat.
    try { return await (config?.tillActivityPost ?? post)(body); } catch {
      try { return await (config?.tillActivityPost ?? post)(body); } catch {
        return { recorded: false, refusedBecause: 'lane_unreachable', laneMessage: unreachable };
      }
    }
  };
  const refusedActivity = (r: Record<string, unknown>, fallback: string): TillActivityAnswer => ({
    ok: false, ...(typeof r['refusedBecause'] === 'string' ? { refusedBecause: r['refusedBecause'] } : {}),
    laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : fallback,
  });
  /** What lowering a line to `toUnitMinor` takes off it — the amount the manager approves. */
  const priceChangeValue = (lineId: string, toUnitMinor: number): PriceChangeValue => {
    try {
      const value = session.overrideValue(lineId, toUnitMinor);
      const onBill = session.basket().find((l) => l.lineId === lineId);
      const productId = onBill?.productId ?? '';
      // OB-500 (R7-A): never below the product's lowest allowed price — refused here, before a manager is asked, offline.
      const floor = floorRefusal({ toUnitMinor, floorMinor: config?.priceFloors?.[productId] });
      if (floor !== undefined) return { ok: false, laneMessage: floor.en, laneMessageTa: floor.ta };
      // OB-520 (R8-A): a product the pack gives no floor for (never received at a cost) — only the owner may approve its cut.
      // Said here so the cashier calls the owner; the store computer refuses anyone else's approval.
      const floors = config?.priceFloors;
      const ownerOnly = floors !== undefined && floors !== null && value.reductionMinor > 0 && floors[productId] === undefined;
      // OB-500: the line, its first price, its quantity and unit go with the request — the store computer works out the cut itself.
      return { ok: true, ...value, productId, lineId, quantityMinor: onBill?.quantityMinor ?? 0, uom: onBill?.uom ?? '', ...(ownerOnly ? { ownerOnly: true as const } : {}) };
    } catch (e) {
      // B19: a carry bag cannot be made free — said in the gate's own words.
      if (e instanceof TillRuleRefusedError) return { ok: false, laneMessage: e.laneMessage };
      return { ok: false, laneMessage: 'A price can only be lowered here, on a line that is on the bill.' };
    }
  };
  const priceChangeAtTill = async (lineId: string, toUnitMinor: number, reason: string, approval: { readonly approvalId: string }): Promise<TillActivityAnswer> => {
    if (session.operator() === undefined) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('change a price').laneMessage };
    const line = session.basket().find((l) => l.lineId === lineId && !l.voided);
    if (line === undefined) return { ok: false, refusedBecause: 'no_such_line', laneMessage: 'That line is not on the bill.' };
    if (reason.trim() === '') return { ok: false, refusedBecause: 'reason_required', laneMessage: 'A price change needs a reason.' };
    const value = priceChangeValue(lineId, toUnitMinor);
    if (!value.ok) return { ok: false, refusedBecause: 'not_lower', laneMessage: value.laneMessage };
    const activityId = `O-${newRequestKey().slice(3)}`;
    const body = {
      activityId, kind: 'price_override', billRef: session.billRef(), lineId, productId: line.productId, description: line.description,
      fromUnitMinor: value.fromUnitMinor, toUnitMinor, quantityMinor: line.quantityMinor, uom: line.uom, valueMinor: value.reductionMinor, reason, approvalId: approval.approvalId,
    };
    const r = await sendTillActivity(body, 'This till cannot reach its store computer, so the price change was not recorded. The line keeps its price.');
    if (r['recorded'] !== true) return refusedActivity(r, 'The price change was not recorded. The line keeps its price.');
    session.overridePrice(lineId, toUnitMinor, { approvedBy: typeof r['approvedBy'] === 'string' ? r['approvedBy'] : 'manager', activityId });
    return { ok: true, laneMessage: 'Price changed.', activityId };
  };
  const noSaleAtTill = async (reason: string, approval: { readonly approvalId: string }): Promise<TillActivityAnswer> => {
    if (session.operator() === undefined) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('open the drawer').laneMessage };
    if (reason.trim() === '') return { ok: false, refusedBecause: 'reason_required', laneMessage: 'Opening the drawer with no sale needs a reason.' };
    const activityId = `N-${newRequestKey().slice(3)}`;
    const body = { activityId, kind: 'no_sale', valueMinor: 0, reason, approvalId: approval.approvalId };
    const r = await sendTillActivity(body, 'This till cannot reach its store computer, so the no-sale was not recorded. Do not open the drawer.');
    if (r['recorded'] !== true) return refusedActivity(r, 'The no-sale was not recorded. Do not open the drawer.');
    return { ok: true, laneMessage: 'Recorded — the drawer may be opened.', activityId };
  };

  // OB-271 · audit A11: a card/UPI refund done on the shop's own machine — a till action on the box with the machine's refund
  // reference and a manager's approval spent for exactly this refund and amount; recorded before the cashier is told "done".
  const recordCardRefundOnMachine = async (input: { readonly returnId: string; readonly refundMinor: number; readonly refundTender: 'card' | 'upi'; readonly machineRef: string; readonly approval: { readonly approvalId: string } }): Promise<TillActivityAnswer> => {
    if (session.operator() === undefined) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('record a card refund').laneMessage };
    const ref = readMachineReference(input.machineRef);
    if (!ref.ok) return { ok: false, refusedBecause: ref.refusedBecause, laneMessage: ref.laneMessage };
    const activityId = `R-${newRequestKey().slice(3)}`;
    const body = {
      activityId, kind: 'card_refund_on_machine', billRef: input.returnId, valueMinor: input.refundMinor, refundTender: input.refundTender,
      machineRef: ref.value, reason: 'refund done on the shop\'s card machine', approvalId: input.approval.approvalId,
    };
    const r = await sendTillActivity(body, 'This till cannot reach its store computer, so the card refund was not recorded. It stays pending — try again.');
    if (r['recorded'] !== true) return refusedActivity(r, 'The card refund was not recorded. It stays pending.');
    return { ok: true, laneMessage: 'Recorded — the refund was done on the machine.', activityId };
  };

  // OB-373: A COPY OF ANY BILL BY ITS NUMBER — this till's, another lane's on this store computer, or one a handheld queue
  // till took (which has no printer). The store computer records the copy (who, which bill, which copy, why) BEFORE it
  // answers; the till then prints the bill as it was saved, marked as a duplicate. Offline: only the box is asked.
  const printBillCopy = async (input: { readonly billNumber: string; readonly reason: string; readonly language?: InvoiceLanguage }): Promise<BillCopyPrint & { readonly laneMessage: string; readonly laneMessageTa?: string; readonly refusedBecause?: string }> => {
    const by = session.operator();
    if (by === undefined) { const m = new NoOperatorError('print a copy of a bill').laneMessage; return { ok: false, why: m, refusedBecause: 'operator_not_signed_in', laneMessage: m }; }
    const billNumber = input.billNumber.trim();
    if (billNumber === '' || input.reason.trim() === '') return { ok: false, why: 'A copy needs the bill number and why.', refusedBecause: 'not_readable', laneMessage: 'Type the bill number and choose why a copy is needed. Nothing was printed.' };
    const body = { copyId: `C-${newRequestKey().slice(3)}`, billNumber, reason: input.reason.trim() };
    const post = async (): Promise<Record<string, unknown>> => {
      const base = laneBase(config?.lanePort ?? DEFAULT_LANE_PORT);
      const response = await fetch(`${base}/lane/bill-copies`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify(body) });
      const front = FRONT_REFUSED[response.status];
      if (front !== undefined) return { printed: false, ...front };
      return await response.json() as Record<string, unknown>;
    };
    let r: Record<string, unknown>;
    // A lost reply is asked again under the SAME copy id — the box answers the same copy, never a second one.
    try { r = await post(); } catch {
      try { r = await post(); } catch {
        const m = 'This till cannot reach its store computer, so no copy was printed. Try again in a moment.';
        return { ok: false, why: m, refusedBecause: 'lane_unreachable', laneMessage: m };
      }
    }
    const said = typeof r['laneMessage'] === 'string' ? r['laneMessage'] : 'No copy was printed.';
    const saidTa = typeof r['laneMessageTa'] === 'string' ? r['laneMessageTa'] : undefined;
    if (r['printed'] !== true) return { ok: false, why: said, laneMessage: said, ...(saidTa === undefined ? {} : { laneMessageTa: saidTa }), ...(typeof r['refusedBecause'] === 'string' ? { refusedBecause: r['refusedBecause'] } : {}) };
    const printed = billCopyPrint(r as unknown as BillCopyAnswer, {
      realTrading: config?.realTrading === true, identity: config?.taxInvoice ?? null, ...(input.language === undefined ? {} : { language: input.language }),
      template: billPaperTemplate(), ...((n) => (n === undefined ? {} : { fssaiLicenceNo: n }))(fssaiLicenceNo()),
      ...(config?.b2cDynamicQr === undefined || config.b2cDynamicQr === null ? {} : { b2cDynamicQr: config.b2cDynamicQr }),
      reason: body.reason, by, at: new Date().toISOString(),
    });
    return { ...printed, laneMessage: said, ...(saidTa === undefined ? {} : { laneMessageTa: saidTa }) };
  };

  // CARD AND UPI (audit PF-06): the attempt is on the store computer before the machine is asked.
  const payments = config?.paymentsPort ?? lanePaymentAttempts(config?.lanePort ?? DEFAULT_LANE_PORT);
  const cardAnswer = (r: Record<string, unknown>): CardAttemptAnswer => {
    const a = (r['attempt'] ?? {}) as { attemptId?: unknown; state?: unknown; amountMinor?: unknown; machineRef?: unknown };
    return {
      ok: r['ok'] === true,
      laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : UNREACHABLE_PAYMENT,
      ...(typeof r['refusedBecause'] === 'string' ? { refusedBecause: r['refusedBecause'] } : {}),
      ...(typeof a.attemptId === 'string' ? { attemptId: a.attemptId } : {}),
      ...(typeof a.state === 'string' ? { state: a.state } : {}),
      ...(typeof a.amountMinor === 'number' ? { amountMinor: a.amountMinor } : {}),
      // OB-271: the machine's approval / reference number the box recorded for this payment, when it has one.
      ...(typeof a.machineRef === 'string' ? { machineRef: a.machineRef } : {}),
    };
  };
  // The amount is the bill's payable, or — for an exchange's top-up — the difference the customer pays.
  const startCardPayment = async (kind: 'card' | 'upi', amountOverride?: number): Promise<CardAttemptAnswer> => {
    if (session.operator() === undefined) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('take a card payment').laneMessage };
    const amountMinor = amountOverride ?? session.totals().payable.minor;
    if (amountMinor <= 0) return { ok: false, refusedBecause: 'nothing_to_pay', laneMessage: 'There is nothing to pay.' };
    return cardAnswer(await payments.ask({ attemptId: `PAY-${newRequestKey().slice(3)}`, billRef: session.billRef(), kind, amountMinor }));
  };
  const answerCardPayment = async (attemptId: string, outcome: 'approved' | 'declined' | 'no_answer', approvalId?: string, machineRef?: string): Promise<CardAttemptAnswer> =>
    cardAnswer(await payments.answer({ attemptId, outcome, ...(approvalId === undefined ? {} : { approvalId }), ...(machineRef === undefined || machineRef === '' ? {} : { machineRef }) }));
  const checkCardPayment = async (attemptId: string): Promise<CardAttemptAnswer> => cardAnswer(await payments.recover({ attemptId }));
  // OB-271 · audit A9: the box's list of card/UPI payments with each machine reference, for the day's matching.
  const cardPayments = async (): Promise<{ readonly paid: readonly CardPaymentRow[]; readonly unresolved: readonly CardPaymentRow[]; readonly refundsOnMachine: readonly CardRefundRow[] } | null> => {
    if (payments.list === undefined) return null;
    const r = await payments.list().catch(() => null);
    if (r === null || !Array.isArray(r['paid'])) return null;
    const rowOf = (a: unknown): CardPaymentRow => {
      const o = (a ?? {}) as Record<string, unknown>;
      return {
        attemptId: String(o['attemptId'] ?? ''), kind: o['kind'] === 'upi' ? 'upi' : 'card', amountMinor: typeof o['amountMinor'] === 'number' ? o['amountMinor'] : 0,
        state: String(o['state'] ?? ''), askedAt: String(o['askedAt'] ?? ''), askedBy: String(o['askedBy'] ?? ''),
        ...(typeof o['machineRef'] === 'string' ? { machineRef: o['machineRef'] } : {}),
        ...(typeof o['appliedToSaleId'] === 'string' ? { saleId: o['appliedToSaleId'] } : {}),
      };
    };
    const refundOf = (a: unknown): CardRefundRow => {
      const o = (a ?? {}) as Record<string, unknown>;
      return {
        returnId: String(o['returnId'] ?? ''), kind: o['refundTender'] === 'upi' ? 'upi' : 'card', amountMinor: typeof o['refundMinor'] === 'number' ? o['refundMinor'] : 0,
        machineRef: String(o['machineRef'] ?? ''), at: String(o['at'] ?? ''), by: String(o['by'] ?? ''), approvedBy: String(o['approvedBy'] ?? ''),
      };
    };
    return {
      paid: (r['paid'] as unknown[]).map(rowOf),
      unresolved: Array.isArray(r['unresolved']) ? (r['unresolved'] as unknown[]).map(rowOf) : [],
      refundsOnMachine: Array.isArray(r['refundsOnMachine']) ? (r['refundsOnMachine'] as unknown[]).map(refundOf) : [],
    };
  };

  // ── OB-350 scan-and-go — begin: the phone basket rung through this till's own pack ──
  const phoneBaskets = config?.phoneBasketsPort ?? lanePhoneBaskets(config?.lanePort ?? DEFAULT_LANE_PORT);
  const recallPhoneBasketAtTill = async (code: string): Promise<PhoneBasketAtTill> => {
    if (session.operator() === undefined) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('bring up a phone basket').laneMessage };
    if (!/^\d{6}$/.test(code.trim())) return { ok: false, refusedBecause: 'not_a_basket_code', laneMessage: 'Key the six digits the customer\'s phone shows.' };
    // A bill just paid is finished (its lines stay on screen until the next scan); anything else on the till is a customer's.
    if (session.currentState() !== 'committed' && session.basketToHold().lines.length > 0) return { ok: false, refusedBecause: 'basket_not_empty', laneMessage: 'Finish or hold the basket on the till first — a phone basket never joins another customer\'s.' };
    if (!view.hasCatalogue()) return { ok: false, refusedBecause: 'no_catalogue', laneMessage: 'This till has no price pack, so it cannot price the phone basket. Scan the items once the pack is here.' };
    return ringBroughtUp(await phoneBaskets.recall(code.trim()), code.trim(), 'Phone basket', 'The phone basket was not brought up. Scan the items as usual.');
  };
  /** Ring the lines a phone or a queue handheld handed over through THIS till's own pack — the till's price, never theirs. */
  const ringBroughtUp = (r: Record<string, unknown>, code: string, label: string, notBrought: string): PhoneBasketAtTill => {
    const lines = Array.isArray(r['lines']) ? r['lines'] as { productId?: unknown; name?: unknown; quantityMinor?: unknown; barcode?: unknown }[] : undefined;
    if (r['recalled'] !== true || lines === undefined) {
      return { ok: false, ...(typeof r['refusedBecause'] === 'string' ? { refusedBecause: r['refusedBecause'] } : {}), laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : notBrought };
    }
    if (session.currentState() === 'committed') view.newSale();
    const added: { lineId: string; description: string; qty: number }[] = [];
    const notAdded: { productId: string; name: string; qty: number; laneMessage: string }[] = [];
    for (const l of lines) {
      const qty = typeof l.quantityMinor === 'number' && Number.isInteger(l.quantityMinor) && l.quantityMinor > 0 ? l.quantityMinor : 1;
      const name = typeof l.name === 'string' ? l.name : String(l.productId ?? '');
      try {
        if (typeof l.barcode !== 'string' || l.barcode === '') throw new Error('no barcode came with this line — scan it');
        // The till's OWN pack prices it (and refuses what it does not sell, a recalled item, an age not yet asked).
        const out = view.scanBarcode(l.barcode);
        if (qty > 1 && out.qty === 1) view.setQuantity(out.lineId, qty);
        added.push({ lineId: out.lineId, description: out.description, qty: qty > 1 && out.qty === 1 ? qty : out.qty });
      } catch (e) {
        const said = (e as { laneMessage?: unknown }).laneMessage;
        notAdded.push({ productId: String(l.productId ?? ''), name, qty, laneMessage: typeof said === 'string' ? said : e instanceof Error ? e.message : String(e) });
      }
    }
    return {
      ok: true, code, added, notAdded,
      laneMessage: notAdded.length === 0 ? `${label} ${code}: ${added.length} line(s) rung at the till's prices. Check the bag, then take the payment.`
        : `${label} ${code}: ${added.length} line(s) rung; ${notAdded.length} need the cashier — scan or ask about each one.`,
    };
  };
  // ── OB-350 scan-and-go — end ──
  // ── D04-FR-05 queue-busting — begin: a handheld's basket, from this till's own store computer, rung the same way ──
  const queueBaskets = config?.queueBasketsPort ?? laneQueueBaskets(config?.lanePort ?? DEFAULT_LANE_PORT);
  const recallQueueBasketAtTill = async (code: string): Promise<PhoneBasketAtTill> => {
    if (session.operator() === undefined) return { ok: false, refusedBecause: 'operator_not_signed_in', laneMessage: new NoOperatorError('bring up a handheld basket').laneMessage };
    if (!/^\d{4}$/.test(code.trim())) return { ok: false, refusedBecause: 'not_a_queue_code', laneMessage: 'Key the four digits the handheld shows.' };
    if (session.currentState() !== 'committed' && session.basketToHold().lines.length > 0) return { ok: false, refusedBecause: 'basket_not_empty', laneMessage: 'Finish or hold the basket on the till first — a handheld basket never joins another customer\'s.' };
    if (!view.hasCatalogue()) return { ok: false, refusedBecause: 'no_catalogue', laneMessage: 'This till has no price pack, so it cannot price the handheld basket. Scan the items once the pack is here.' };
    return ringBroughtUp(await queueBaskets.recall(code.trim()), code.trim(), 'Handheld basket', 'The handheld basket was not brought up. Scan the items as usual.');
  };
  // ── D04-FR-05 — end ──
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
  // POINTS AND STORE CREDIT (PF-09 step 3): what the named member may spend here now, from the store computer's copy.
  const loyaltyWallet = async (): Promise<LoyaltyWalletAnswer> => {
    // OB-252: no member is named on a guest-only till, so there is no balance to ask about.
    if (config?.guestSalesOnly === true) return { ok: false, refusedBecause: 'guest_sales_only', laneMessage: GUEST_SALES_ONLY_WORDS };
    const mobile = session.loyaltyMobileForBox();
    if (mobile === undefined) return { ok: false, refusedBecause: 'no_member_named', laneMessage: 'Key the loyalty member\'s mobile number first.' };
    const body = { mobile, tradingDay: session.tradingDayFor(new Date().toISOString()) };
    const post = async (): Promise<Record<string, unknown>> => {
      const base = laneBase(config?.lanePort ?? DEFAULT_LANE_PORT);
      const response = await fetch(`${base}/lane/loyalty/wallet`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify(body) });
      const front = FRONT_REFUSED[response.status];
      if (front !== undefined) return { known: false, ...front };
      return await response.json() as Record<string, unknown>;
    };
    let r: Record<string, unknown>;
    try { r = await (config?.loyaltyWalletPost ?? post)(body); } catch {
      return { ok: false, refusedBecause: 'lane_unreachable', laneMessage: 'This till cannot reach its store computer, so points and store credit cannot be spent now. Take another payment.' };
    }
    const num = (k: string): number => (typeof r[k] === 'number' ? r[k] as number : 0);
    if (r['known'] !== true) {
      return { ok: false, refusedBecause: typeof r['refusedBecause'] === 'string' ? r['refusedBecause'] : 'wallets_not_known', laneMessage: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : 'This store computer has not yet received the members\' balances from head office.' };
    }
    return {
      ok: true, laneMessage: '', points: num('points'), pointValuePaise: num('pointValuePaise'), pointsValueMinor: num('pointsValueMinor'),
      storeCreditMinor: num('storeCreditMinor'), capRemainingMinor: num('capRemainingMinor'),
      ...(typeof r['asOf'] === 'string' ? { asOf: r['asOf'] } : {}), ...(typeof r['last4'] === 'string' ? { last4: r['last4'] } : {}),
      // OB-295: the tier multiplier, off ("not set") until the owner sets tiers.
      tier: typeof r['tierMultiplierBps'] === 'number'
        ? { tiersSet: true as const, name: typeof r['tierName'] === 'string' ? r['tierName'] : null, multiplierBps: r['tierMultiplierBps'] }
        : { tiersSet: false as const },
    };
  };

  const lane = () => ({
    laneId: session.laneId() ?? null,
    tradingDayCutoff: config?.tradingDayCutoff ?? '00:00',
    tradingDayAt: (atIsoUtc: string) => session.tradingDayFor(atIsoUtc),
  });

  // D04-FR-05 · M12-FR-04: what this till's devices say — the scanner, printer, scale, drawer and card machine — sent to
  // the store computer through the signed-in session, for the manager's Today screen. The device adapter that knows is
  // hardware-side (external); this only carries its words. A device failing never stops a sale.
  const reportDevices = async (devices: readonly { readonly kind: string; readonly state: string; readonly detail?: string }[], adapterObservedAt?: string): Promise<{ readonly recorded: boolean; readonly refusedBecause?: string; readonly laneMessage?: string }> => {
    // Kept as the last known, so the 5-minute re-send carries it on (P-08) — even when this send is refused or lost.
    if (Array.isArray(devices) && devices.length > 0) deviceHeartbeat.remember(devices, adapterObservedAt);
    return postDevices(devices, deviceHeartbeat.lastObservedAt());
  };
  const postDevices = async (devices: readonly DeviceStatus[], adapterObservedAt?: string): Promise<{ readonly recorded: boolean; readonly refusedBecause?: string; readonly laneMessage?: string }> => {
    if (session.operator() === undefined) return { recorded: false, refusedBecause: 'operator_not_signed_in', laneMessage: 'Sign in before the till reports its devices.' };
    try {
      const base = laneBase(config?.lanePort ?? DEFAULT_LANE_PORT);
      const response = await fetch(`${base}/lane/peripherals`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify({ devices, ...(adapterObservedAt === undefined ? {} : { adapterObservedAt }) }) });
      const front = FRONT_REFUSED[response.status];
      if (front !== undefined) return { recorded: false, ...front };
      const r = await response.json() as Record<string, unknown>;
      return r['recorded'] === true ? { recorded: true } : { recorded: false, ...(typeof r['refusedBecause'] === 'string' ? { refusedBecause: r['refusedBecause'] } : {}), ...(typeof r['laneMessage'] === 'string' ? { laneMessage: r['laneMessage'] } : {}) };
    } catch {
      return { recorded: false, refusedBecause: 'lane_unreachable', laneMessage: 'This till cannot reach its store computer; the device report was not sent.' };
    }
  };

  // D04-FR-05 · P-08: keep the last known device states and re-send them while a cashier is signed in, and at once on a
  // change — so a healthy, quiet till stays fresh at head office. Fire-and-forget; never on the sale path (hard rule #1).
  let adapterClock: (() => unknown) | undefined;
  const deviceAdapterClock = (clock: (() => unknown) | undefined): void => { adapterClock = clock; };
  const deviceHeartbeat = createDeviceHeartbeat({
    send: postDevices,
    adapterObservedAt: () => { try { return adapterClock?.(); } catch { return undefined; } },
    // DEV-1: only an adapter that offers its own clock (`lastObservedAt`) gives a liveness time; a change-only time is not one.
    offersLiveness: () => adapterClock !== undefined,
    signedIn: () => session.operator() !== undefined,
    committing: () => commitsInFlight > 0,
    ...(config?.deviceHeartbeatTimers?.every === undefined ? {} : { every: config.deviceHeartbeatTimers.every }),
    ...(config?.deviceHeartbeatTimers?.soon === undefined ? {} : { soon: config.deviceHeartbeatTimers.soon }),
  });
  heartbeat.ref = deviceHeartbeat;
  if (session.operator() !== undefined) deviceHeartbeat.start();
  const devicesSaid = (devices: readonly DeviceStatus[], adapterObservedAt?: string): void => {
    if (Array.isArray(devices) && devices.length > 0) deviceHeartbeat.update(devices, adapterObservedAt);
  };

  // M12-FR-01: scan-to-line timings, kept here and sent to the box after the scan — never on it (hard rule #1).
  const scanTimes: number[] = [];
  let droppedScanTimes = 0;
  let sendingScanTimes = false;
  const sendScanTimes = async (): Promise<ScanSpeedRead> => {
    const waiting = (): number => scanTimes.length;
    if (session.operator() === undefined) return { known: false, why: 'Sign in to read this till\'s scan speed.', waiting: waiting() };
    const batch = scanTimes.splice(0, scanTimes.length);
    const dropped = droppedScanTimes;
    droppedScanTimes = 0;
    const putBack = (): void => {
      // Not sent: the samples wait for the next try (oldest let go past the limit — counted, never hidden).
      scanTimes.unshift(...batch);
      const over = scanTimes.length - SCAN_TIMES_HELD;
      if (over > 0) { scanTimes.splice(0, over); droppedScanTimes += over; }
      droppedScanTimes += dropped;
    };
    try {
      const base = laneBase(config?.lanePort ?? DEFAULT_LANE_PORT);
      const response = await fetch(`${base}/lane/peripherals`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeaders() }, body: JSON.stringify({ scanTimings: batch, ...(dropped > 0 ? { droppedScanTimings: dropped } : {}) }) });
      const front = FRONT_REFUSED[response.status];
      if (front !== undefined) { putBack(); return { known: false, why: front.laneMessage, waiting: waiting() }; }
      const r = await response.json() as Record<string, unknown>;
      if (r['recorded'] !== true) { putBack(); return { known: false, why: typeof r['laneMessage'] === 'string' ? r['laneMessage'] : 'The store computer did not keep the scan timings.', waiting: waiting() }; }
      const s = r['scanSpeed'] as Record<string, unknown> | null | undefined;
      if (s === null || s === undefined || typeof s['p95Ms'] !== 'number') return { known: false, why: 'No scan has been timed on this till today yet.', waiting: waiting() };
      return {
        known: true, day: String(s['day']), samples: Number(s['samples']), p95Ms: s['p95Ms'], medianMs: Number(s['medianMs']), maxMs: Number(s['maxMs']),
        overTargetCount: Number(s['overTargetCount']), targetMs: Number(s['targetMs']), withinTarget: s['withinTarget'] === true, droppedSamples: Number(s['droppedSamples'] ?? 0), waiting: waiting(),
      };
    } catch {
      putBack();
      return { known: false, why: 'This till cannot reach its store computer, so its scan speed cannot be read now. The timings wait here and go when it can.', waiting: waiting() };
    }
  };
  const noteScanTime = (ms: number): void => {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 60_000) return;
    scanTimes.push(Math.round(ms));
    if (scanTimes.length > SCAN_TIMES_HELD) { scanTimes.shift(); droppedScanTimes += 1; }
    if (scanTimes.length >= SCAN_TIMES_SEND_EVERY && !sendingScanTimes && commitsInFlight === 0 && session.operator() !== undefined) {
      sendingScanTimes = true;
      // After the scan: a later turn of the event loop, so the line is already on the screen.
      setTimeout(() => { void sendScanTimes().finally(() => { sendingScanTimes = false; }); }, 0);
    }
  };
  const scanSpeed = (): Promise<ScanSpeedRead> => sendScanTimes();

  // D04-FR-05 · M12-FR-01: the customer display's frame, from the till's own basket — no network (see customer-display.ts).
  let displaySeq = 0;
  const customerDisplay = (): CustomerDisplayFrame => {
    const totals = session.totals();
    displaySeq += 1;
    return customerDisplayFrame({
      laneId: session.laneId() ?? null, basket: view.basket(),
      // Each line at its own price before the offer; the offer is shown once, as the saving.
      lineTotalsMinor: session.replacementLines().map((l) => l.lineTotalMinor + (l.discountMinor ?? 0)),
      promotionDiscountMinor: totals.promotionDiscount.minor, payableMinor: totals.payable.minor, currency: totals.payable.currency, seq: displaySeq,
    });
  };
  const customerDisplayChannelName = (): string => CUSTOMER_DISPLAY_CHANNEL;

  // A8 · RR-F02: the refund whose answer was lost — asked again under its own id, shown exactly as a first answer would be.
  const confirmPendingRefund = (): Promise<RefundScreenOutcome> => refundOutcomeOf(() => till.confirmPendingRefund());
  const pendingRefund = (): { readonly returnId: string; readonly number: string } | null => till.pendingRefund() ?? null;
  const saleOnBox = async (saleId: string): Promise<'saved' | 'not_saved' | 'unknown'> => {
    const found = await askLookup(lanePort, saleId);
    if (found === 'unknown') return 'unknown';
    return found !== null && found.sale.saleId === saleId ? 'saved' : 'not_saved';
  };
  const refundOnBox = async (returnId: string, originalSaleId: string | null): Promise<'saved' | 'not_saved' | 'unknown'> => {
    if (originalSaleId === null || originalSaleId === '') return 'unknown';
    const found = await askLookup(lanePort, originalSaleId);
    if (found === 'unknown' || found === null) return 'unknown';
    return found.refunds.some((r) => r.returnId === returnId) || found.returns.some((r) => r.returnId === returnId) ? 'saved' : 'not_saved';
  };
  const guestSalesOnly = (): boolean => config?.guestSalesOnly === true;
  const mirrorPilot = (): boolean => config?.mirrorPilot === true;
  const realTrading = (): boolean => config?.realTrading === true;
  const readMachineRef = (typed: string): MachineRefReading => readMachineReference(typed);

  // ── R7-C · OB-506 — begin: a quotation rung up by its number (its own file; nothing on the sale path) ──
  const barcodeOfProduct = barcodesByProduct(config?.catalogue);
  const ringQuotationAtTill = quotationAtTill({
    port: config?.quotationsPort ?? laneQuotations({ base: () => laneBase(config?.lanePort ?? DEFAULT_LANE_PORT), headers: operatorHeaders, frontRefused: FRONT_REFUSED }),
    barcodeOf: (productId) => barcodeOfProduct.get(productId),
    ops: {
      signedIn: () => session.operator() !== undefined,
      basketInProgress: () => session.currentState() !== 'committed' && session.basketToHold().lines.length > 0,
      committed: () => session.currentState() === 'committed',
      hasCatalogue: () => view.hasCatalogue(),
      newSale: () => { view.newSale(); },
      billRef: () => session.billRef(),
      scanBarcode: (code) => view.scanBarcode(code),
      setQuantity: (lineId, qty) => { view.setQuantity(lineId, qty); },
      unitPriceOf: (lineId) => view.basket().find((l) => l.lineId === lineId)?.unitPriceMinor,
      lowerPrice: (lineId, toUnitMinor, evidence) => { session.overridePrice(lineId, toUnitMinor, evidence); },
      raisePrice: (lineId, toUnitMinor, quotationId) => { session.chargeQuotedPrice(lineId, toUnitMinor, quotationId); },
      packOf: (productId) => {
        const p = catalogueRef.cache?.findByProductId(productId);
        return p === undefined ? undefined : { unitPriceMinor: p.unitPriceMinor, ...(p.mrpMinor === undefined ? {} : { mrpMinor: p.mrpMinor }) };
      },
    },
  });
  const quotedView = Object.assign(view, { ringQuotationAtTill, quotationWords: (lang: 'en' | 'ta') => QUOTATION_TILL_WORDS[lang] });
  // ── R7-C · OB-506 — end ──
  // ── R8-B · OB-523 — begin: cancel the whole bill (its own file); a quotation rung up on it is freed through the box ──
  // The quotations rung up on the bill in progress — remembered against the bill's own reference, so a fresh bill has none.
  const onBill: { billRef: string | undefined; ids: string[] } = { billRef: undefined, ids: [] };
  const quotationsOnBill = (): readonly string[] => (onBill.billRef === session.billRef() ? [...onBill.ids] : []);
  const ringQuotationRemembered = async (quotationNumber: string): Promise<QuotationAtTill> => {
    const out = await ringQuotationAtTill(quotationNumber);
    if (out.ok && out.quotationId !== undefined) {
      const ref = session.billRef();
      if (onBill.billRef !== ref) { onBill.billRef = ref; onBill.ids = []; }
      if (!onBill.ids.includes(out.quotationId)) onBill.ids.push(out.quotationId);
    }
    return out;
  };
  const cancelBillAtTill = billCancelAtTill({
    ops: {
      signedIn: () => session.operator() !== undefined,
      committed: () => session.currentState() === 'committed',
      awaitingSave: () => session.pendingSale() !== undefined,
      billRef: () => session.billRef(),
      liveLines: () => view.basket().filter((l) => !l.voided).map((l) => ({ lineId: l.lineId, productId: l.productId, description: l.description, valueMinor: l.amountMinor })),
      quotationsOnBill,
      voidLine: (lineId, reason) => { view.voidLine(lineId, reason); },
      newSale: () => { onBill.billRef = undefined; onBill.ids = []; view.newSale(); },
      newActivityId: () => `BV-${newRequestKey().slice(3)}`,
    },
    post: (body) => sendTillActivity(body, 'This till cannot reach its store computer, so the bill was not cancelled. The bill stays as it is.'),
  });
  const cancellableView = Object.assign(quotedView, { ringQuotationAtTill: ringQuotationRemembered, cancelBillAtTill, quotationsOnBill, billCancelWords: (lang: 'en' | 'ta') => BILL_CANCEL_WORDS[lang] });
  // ── R8-B · OB-523 — end ──
  return Object.assign(cancellableView, { guestSalesOnly, mirrorPilot, realTrading, taxInvoice, printBillCopy, readMachineRef, cardPayments, recordCardRefundOnMachine, pendingRefund, confirmPendingRefund, saleOnBox, refundOnBox, customerDisplay, customerDisplayChannelName, reportDevices, devicesSaid, noteScanTime, scanSpeed, deviceAdapterClock, deviceHeartbeat, till, nextReceipt, receiptsRemaining, receiptNotice, holdAtTill, heldAtTill, recallAtTill, abandonAtTill, recallPhoneBasketAtTill, recallQueueBasketAtTill, startCardPayment, answerCardPayment, checkCardPayment, voidAtTill, priceChangeValue, priceChangeAtTill, noSaleAtTill, currentBillRef: () => session.billRef(), lookupRefund, lookupRefundByOldBill, readOldBill, noReceiptReturn, receiptTemplate, receiptLines, signIn, signOut, operator, lane, signInAtTill, resumeAtTill, signOutAtTill, tillSignInBy, operatorToken, approveAtTill, loyaltyWallet, refusedOffers: () => session.refusedOffers(), holdOffersStartingAfter: (cutoffAt: string | null) => { session.holdOffersStartingAfter(cutoffAt); }, heldOffers: () => session.heldOffers(), applyVersionPolicy, appVersion });
}

// Attach for the view. `app.js` uses `window.posSession` when present and falls back to its
// stand-in when the bundle has not been built. In the browser `globalThis.window` IS the window,
// so this needs no DOM types.
const browserWindow = (globalThis as { window?: PosWindow }).window;
// D04-FR-05: the queue handheld's page boots its own session from this module (apps/queue-pos) — it is not a till to auto-boot.
if (browserWindow !== undefined && (globalThis as { sreQueueTill?: unknown }).sreQueueTill !== true) {
  // Who this till IS comes from the box (SP-4b · F09): the lane it was told it is and the shop's cut-off. Who the CASHIER
  // is never comes from here — the person signs in on the screen. Nothing below invents a lane, a cashier or a day.
  const lane = browserWindow.posLane;
  const lanePort = lanePortFrom(browserWindow.laneWriteBase);
  browserWindow.posSession = bootPos({
    catalogue: browserWindow.posCatalogue,
    // The box that served this page says where its lane socket is; without it the till posts to its default port.
    ...(lanePort === undefined ? {} : { lanePort }),
    ...(lane?.laneId === undefined || lane.laneId === null || lane.laneId === '' ? {} : { laneId: lane.laneId }),
    ...(lane === undefined ? {} : { tradingDayCutoff: lane.tradingDayCutoff }),
    ...(typeof lane?.timeZone === 'string' && lane.timeZone !== '' ? { timeZone: lane.timeZone } : {}), // R1: the shop's zone
    // B6: this lane's scales as the box's store pack names them; a page without them sells nothing by weight.
    ...(lane?.scales === undefined ? {} : { laneScales: lane.scales }),
    // OB-403 "A" · §31.1: the box's hold on new offers while its clock is 5+ minutes out (re-read with the badge every 10 s).
    ...(lane?.offerHold?.held === true && typeof lane.offerHold.cutoffAt === 'string' ? { offerHoldCutoff: lane.offerHold.cutoffAt } : {}),
    ...(Array.isArray(lane?.soldHuids) ? { soldHuids: lane.soldHuids } : {}),
    // OB-252: guest sales only, when the box says so (store pack or the box's own setting).
    ...(lane?.guestSalesOnly?.on === true ? { guestSalesOnly: true } : {}),
    // OB-256: the mirror pilot, when the box says so — "Paid on old system" is then the only tender.
    ...(lane?.mirrorPilot?.on === true ? { mirrorPilot: true } : {}),
    // OB-271: real trading, when the box says so — each bill is the legal tax invoice, from the shop's setup in the pack.
    ...(lane?.realTrading?.on === true ? { realTrading: true, taxInvoice: lane.taxInvoice ?? null } : {}),
    ...(typeof lane?.billPaper === 'string' ? { billPaper: lane.billPaper } : {}),
    // B10: the store's FSSAI licence, from the box's store pack.
    ...(lane?.fssaiLicence === undefined || lane.fssaiLicence === null ? {} : { fssaiLicence: lane.fssaiLicence }),
    // A22: the B2C dynamic QR switch and details, from the box's store pack (absent → off).
    ...(lane?.b2cDynamicQr === undefined || lane.b2cDynamicQr === null ? {} : { b2cDynamicQr: lane.b2cDynamicQr }),
    // OB-348: the shop's state, and OB-299: the delivery-fee product — each from the box's store pack, absent when not set.
    ...(typeof lane?.shopState === 'string' && lane.shopState !== '' ? { shopState: lane.shopState } : {}),
    ...(typeof lane?.tillDeliveryFeeProductId === 'string' && lane.tillDeliveryFeeProductId !== '' ? { tillDeliveryFeeProductId: lane.tillDeliveryFeeProductId } : {}),
    // OB-500 · OB-501 (R7-A): the floors and the app version policy, from the box's signed pack.
    ...(lane?.priceFloors === undefined || lane.priceFloors === null ? {} : { priceFloors: lane.priceFloors }),
    ...(lane?.appVersionPolicy === undefined || lane.appVersionPolicy === null ? {} : { appVersionPolicy: lane.appVersionPolicy }),
    ...(browserWindow.posReceiptTemplate === undefined ? {} : { receiptTemplate: browserWindow.posReceiptTemplate }),
    // The refund policy the box was given (SP-9b-i): without it the till offers no return without a receipt.
    ...(browserWindow.posRefundPolicy === undefined ? {} : { refundPolicy: browserWindow.posRefundPolicy }),
  });
  // OB-288 P4 (R8-9 · OB-316): the lane's rollout switches, beside the session — nothing in the sale path waits on them.
  browserWindow.posRollout = posRolloutOf(lane?.rollout);
}
