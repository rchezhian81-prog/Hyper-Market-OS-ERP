// The store edge as a running process — P-01, hard rule #1, §19, §31, P-08.
//
// Everything the edge needs has existed and none of it has ever been started. This is the
// composition root for the box in the back office: it opens the durable log, holds the catalogue
// pack the lanes trade on, and drains the outbox to the cloud whenever there is a line.
//
// ── The one thing this file exists to demonstrate ───────────────────────────
//
// **It starts, and trades, with no cloud configuration at all.** `STORE_EDGE_CONFIG` lists no
// cloud URL and no cloud token as required, and this process honours that: with neither set it
// opens its disk, reports itself ready to sell, and says in plain words that nothing will be
// synced until somebody configures where to. It does not refuse to start, and — the part that
// matters — **it does not pretend to sync**.
//
// That is P-01 stopped being a claim. If the edge needed the cloud to boot, offline-first would be
// a paragraph in a document rather than a property of the software, and the first power cut with a
// dead router would prove it.
//
// ── Why the sync loop is nowhere near the sale path ─────────────────────────
//
// Nothing below is on the path a customer waits for. A sale reaches `commitLocally`, hits the
// disk, and the receipt prints; this loop runs on its own timer afterwards and could stop entirely
// without a lane noticing (hard rule #1). Three properties keep that true:
//
//   • **Passes never overlap.** A drain slower than the interval must not have a second one start
//     behind it — that is two processes sending the same queue, which is safe (the cloud dedupes)
//     and produces a pile-up and a log nobody can read.
//   • **Backoff when the line is down**, so a shop with a dead router is not making a request a
//     second all night. The agent already stops a pass early; this widens the gap between passes.
//   • **SIGTERM finishes the item in flight and stops.** Nothing is lost by stopping mid-drain:
//     an unacknowledged item stays pending in the outbox, which is what the outbox is for. So this
//     drains briefly and then goes, rather than holding a shop's PC open at closing time.

import { loadConfig, STORE_EDGE_CONFIG } from '../../../services/kernel/src/index';
import { SyncOutbox } from '../../../packages/sync/src/outbox';
import { SyncAgent } from '../../../edge/sync-agent/src/agent';
import { httpTransport } from '../../../edge/sync-agent/src/http-transport';
import { httpPackSource } from '../../../edge/sync-agent/src/pack-source';
import { pullPack, type PackPullOutcome, type PackPullStatus } from '../../../edge/sync-agent/src/pack-puller';
import { httpSyncWatermarkReporter, type SyncWatermarkReport } from '../../../edge/sync-agent/src/sync-watermark-report';
import { httpBoxHealthReporter, boxHealthReportOf, type BoxHealthReport } from '../../../edge/sync-agent/src/box-health-report';
import { statfs } from 'node:fs/promises';
import { SALE_RESERVE_BYTES } from './durability';
import { httpStorePackSource, httpHeldVersionsReporter, pullStorePack, type StorePackPullOutcome, type StorePackPullStatus } from '../../../edge/sync-agent/src/store-pack-feed';
import { readHeldStorePack, writeHeldStorePack, packPayloadOf } from './store-pack-held';
import type { StorePackEnvelope } from '../../../services/platform/src/store-packs';
import type { StoreSetupStatus } from './sync-status';
import {
  httpMigrationFeedSource, pullMigrationFeed,
  type MigrationFeedPullOutcome, type MigrationFeedPullStatus, type MigrationFeedReceiver,
} from '../../../edge/sync-agent/src/migration-feed';
import {
  httpPublishedTemplatesSource, pullPublishedTemplates,
  type PublishedTemplatesPullOutcome, type PublishedTemplatesPullStatus, type PublishedTemplatesReceiver,
} from '../../../edge/sync-agent/src/published-templates';
import {
  httpIndentsFeedSource, pullIndentsFeed,
  type IndentsFeedPullOutcome, type IndentsFeedPullStatus, type IndentsFeedReceiver,
} from '../../../edge/sync-agent/src/indents-feed';
import { openFileLog, readLog, type OpenFileLog } from './file-log';
import { readSignedPack, writeSignedPack } from './signed-pack-file';
import { readHeldMigrationFeed, writeHeldMigrationFeed, type HeldMigrationFeed } from './migration-feed-file';
import { readHeldPublishedTemplates, writeHeldPublishedTemplates, type HeldPublishedTemplates } from './published-templates-file';
import { readHeldIndentsFeed, writeHeldIndentsFeed, type HeldIndentsFeed } from './indents-feed-file';
import { readHeldAssignmentsFeed, writeHeldAssignmentsFeed, type HeldAssignmentsFeed } from './assignments-feed-file';
import {
  httpAssignmentsFeedSource, pullAssignmentsFeed,
  type AssignmentsFeedReceiver, type AssignmentsFeedPullOutcome, type AssignmentsFeedPullStatus,
} from '../../../edge/sync-agent/src/assignments-feed';
import { SyncPipeline } from './sync-pipeline';
import { canonicalHash, IdempotencyGuard } from './idempotency';
import { ReturnEntitlement, type EntitlementLine } from './entitlement';
import { buildReceiptLookup } from './receipt-lookup';
import { openOldErpBills } from './old-erp-bills';
import { openEveningCheckBox } from './evening-check-box';
import { OFFICE_LANE } from './office-sign-in';
import { returnIdOf } from './cloud-return';
import { readMachineReference } from '../../../packages/tender/src/machine-reference';
import { createEdgeNode, type EdgeNode } from './index';
import { startLaneServer, LANE_HOST, type LaneServer, type LaneDayCloseHandler, type LaneDayReopenHandler, type LaneDeviceRelayHandler, type LaneDeviceStatusHandler, type LaneTillActivityHandler } from './lane-server';
import { commitLocally } from './durability';
import { selfCheckoutBasketRecorder } from './self-checkout-baskets'; // OB-288 P6 (R8-3 · R8-7)
import { readRelayItem, isRelayable, type BoxItemStatus, type DeviceAck } from '../../../packages/sync/src/device-relay';
import { laneSyncStatus, type LaneSyncStatus, type QueueHealth } from './sync-status';
import { watchStoreComputerStatus } from './store-computer-status-file';
import { startScreenServer, SCREEN_HOST, type ScreenServer } from './screen-server';
import { startDeviceServer, DEVICE_HOST, type DeviceServer } from './device-server';
import { ensureDeviceTls, sayDeviceTlsEvent, socketAddressesFor, type DeviceTlsMaterial } from './device-tls'; // OB-422
import type { HandheldSealSource } from './handheld-seal'; // OB-424
import { DeviceEnrolments, readPackDevices } from './device-enrolments';
import { TillOperators, loadTillCredentials, deviceLaneOf, TILL_AUTHORITY, type SignInLogEntry } from './till-operators';
import { phoneOperatorsOf, personNamedBy } from './handheld-sign-in';
import { TillApprovals } from './till-approvals';
import { ReceiptNumbers } from './receipt-numbers';
import { HeldBills } from './held-bills';
import { httpPhoneBaskets } from './phone-baskets';
import { PaymentAttempts, type PaymentProviderPort } from './payment-attempts';
import { PeripheralReports } from './peripheral-health';
// D04-FR-05 mobile POS and queue-busting (OB-288 Pkg 6b) — begin: additive
import { QueueBaskets } from './queue-baskets';
import { queuePosDoor, type QueuePosSwitches } from './queue-pos-door';
import { billCopyRecorder, priorCopiesIn, saleIn } from './bill-copies'; // OB-373: a copy of a bill by its number
import { laneRollout, laneSwitchOn } from '../../../packages/platform/src/rollout';
import { QUEUE_BUSTING_SWITCH, MOBILE_POS_PAYMENT_SWITCH } from '../../../packages/suspended-sales/src/queue-basket';
// D04-FR-05 — end
import { LoyaltyWallets } from './loyalty-wallets';
import { ConcessionTrading } from './concession-trading';
import { pullConcessionTradingFeed, type ConcessionTradingPullOutcome } from '../../sync-agent/src/concession-trading-feed';
import { httpWalletFeedSource, pullWalletFeed, type WalletFeedPullOutcome } from '../../sync-agent/src/loyalty-wallets-feed';
import { peopleFrom, permissionsOf } from './screen-navigation';
import { openOfficeGate } from './office-sign-in';
import { createHeadOfficeLink, headOfficeLinkSettingsFrom } from './head-office-link'; // OB-388 · ADR-0029
import { tillPinKey } from '../../../packages/identity/src/till-pin';
import { sealDecision, sealTillFact, tillSealKey } from '../../../packages/identity/src/till-seal';
import { withDeciderSeal } from './decision-seal';
import { readSales } from './read-model';
import { emptyPack, readPack, withMigrationFeed, withPublishedTemplates, withIndentsFeed, withAssignmentsFeed, type StorePack } from './store-pack';
import { managerPayload, tillCatalogue, posLanePayload, posReceiptTemplate, payloadFor, catalogueFreshness, type ScreenInput } from './screen-data';
import { checkTillRules, laneScalesFor, type GateProduct } from './lane-scales';
import { checkStaffPurchase, packStaffPurchaseOf } from './staff-purchase-gate'; // OB-301
import { SoldHuids } from './sold-huids';
import { hmacSigner } from '../../../services/catalogue/src/index';
import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import { closeDay as decideDayClose, reopenDay as decideReopenDay, carriedForwardOf } from '../../../packages/day-close/src/day-close';
import { toCloudSale } from './cloud-sale';
import { toCloudReturn } from './cloud-return';
import { toCloudConcessionTag } from './cloud-concession-tag';
import { toCloudChecklist, toCloudTaskCompletion, checklistIdOf, taskIdOf } from './cloud-completion';
import {
  readTillCashRecord, foldTillCash, decideCashMovement, decideShiftClose, shiftFigures, tillCashEventFactory, TILL_CASH_WORDS,
  type TillCashRecord, type CashMovementOutcome, type ShiftCloseOutcome, type TillCashStatus, type TillCashRefusal,
} from './till-cash';
import type { CashMovementKind } from '../../../packages/cash/src/cash';
import { loyaltyMemberKey, memberRefFor } from '../../../packages/loyalty/src/earn-rule';
import { type TradingDayRule } from '../../../packages/calendar/src/trading-day';
import { packRule, packTimeZone, packTradingDay, packCalendarDate, packWallClock, zoneCheck, type ZoneCheck } from './shop-zone';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// OB-288 lane 2 · P2: the store's work feeds (production, food safety, transfers) and the clock check (§31.1 · OB-327).
import { httpWorkFeedSource, pullWorkFeed, WORK_FEED_NAMES, type WorkFeedName, type WorkFeedPullOutcome } from '../../sync-agent/src/store-work-feeds';
import { readHeldWorkFeeds, writeHeldWorkFeeds, type HeldWorkFeeds } from './work-feeds-file';
import { ClockGuard, clockObservingFetch, readClockThresholds, type ClockCheck } from './clock-guard';
import { boxLoginGate } from './box-login-gate'; // OB-429
import { activationHoldReport, type ActivationHoldReport } from './activation-hold';
import type { BoxCapturedRun } from './store-work';

/** The returns pipeline's own cursor file, so the sale and refund logs advance independently. */
const RETURNS_CURSOR = 'sync-cursor-returns';

/** The completions pipeline's own cursor file (M25-FR-02), so the third log advances independently too. */
const COMPLETIONS_CURSOR = 'sync-cursor-completions';
/** The concession-tag pipeline's own cursor file (M27-FR-03), so the fifth log advances independently too. */
const CONCESSION_TAGS_CURSOR = 'sync-cursor-concession-tags';

/** The store/day-close pipeline's own cursor file (M14-FR-04), so the fourth log advances independently. */
const DAYCLOSE_CURSOR = 'sync-cursor-day-close';
/** The device-events pipeline's own cursor file (SP-2a · F11), so the sixth log advances independently too. */
const DEVICE_EVENTS_CURSOR = 'sync-cursor-device-events';
/** The till-cash pipeline's own cursor file (SP-4c · F10), so the seventh log advances independently too. */
const TILL_CASH_CURSOR = 'sync-cursor-till-cash';

/** Who may ask to reopen a locked day at the store computer (2b-vi-c-4): anyone who may see the locked days. */
const REOPEN_AUTHORITY = 'till.dayclose.read';
/** Round 4: the authority a person needs to CLOSE the day on the box — the one head office re-checks (OB-36). */
const CLOSE_AUTHORITY = 'till.dayclose.read';
/** Who may approve a reopen — the permission head office re-checks on every synced reopen (§28). */
const APPROVE_REOPEN_AUTHORITY = 'till.dayclose.approve';

/** OB-55 "A": what the manager screen sends to close the day with pending card/UPI payments carried forward. */
export interface CarryForwardRequest {
  /** Every pending payment, by attempt id — the box refuses unless it is exactly the pending set. */
  readonly attemptIds: readonly string[];
  /** The SECOND person's staff ID — never the closer — and their own till PIN (to the PIN register only, never written). */
  readonly approvedBy: string;
  readonly approverPin: string;
  readonly reason: string;
}

/**
 * Mint the cloud event from a day-close log record — used BOTH by the pipeline's restart re-queue and
 * by the run-time enqueue in `closeDay`/`reopenDay`, so both mint the identical event (the cloud routes
 * are idempotent per `dayCloseId` regardless). The record is the cloud's synced contract as the
 * EdgeProcess method wrote it. Read defensively — it is untrusted JSON off the disk.
 *
 * ONE log holds both closes and reopens (M14-FR-04), so this discriminates on the record's shape: a
 * record carrying `reopenedBy` is a reopen (mint `StoreDayReopened`, routed to `.../reopen/synced`);
 * anything else is a close (`StoreDayClosed`). Getting this wrong would re-mint a reopen as a close on
 * restart — a locked day silently coming back from a reopen — so the discriminator is the whole point.
 */
function dayCloseEventFrom(record: string, index: number): DomainEvent | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(record) as unknown; } catch { return undefined; }
  const p = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const dayCloseId = typeof p['dayCloseId'] === 'string' && p['dayCloseId'] !== '' ? (p['dayCloseId'] as string) : `record-${index}`;

  // OB-55 / PF-06: a machine answer typed in late for an earlier day's attempt, on a manager's approval — relayed once.
  const lateAttemptId = p['lateAnswerAttemptId'];
  if (typeof lateAttemptId === 'string' && lateAttemptId !== '') {
    return makeEvent({
      id: `edge-late-payment-answer-${lateAttemptId}`,
      type: 'LatePaymentAnswerRecorded',
      occurredAt: typeof p['answeredAt'] === 'string' ? (p['answeredAt'] as string) : new Date().toISOString(),
      idempotencyKey: `late-payment-answer:${lateAttemptId}`,
      source: 'edge/box',
      payload: {
        attemptId: lateAttemptId, laneId: p['laneId'], billRef: p['billRef'], kind: p['kind'], amountMinor: p['amountMinor'], askedAt: p['askedAt'],
        tradingDay: p['tradingDay'], outcome: p['outcome'], answeredBy: p['answeredBy'], approvedBy: p['approvedBy'], approvalId: p['approvalId'],
        answeredAt: p['answeredAt'], storeId: p['storeId'],
      },
    });
  }

  // OB-69 "A": a card/UPI attempt the till recorded as NO ANSWER — relayed to head office the moment it is recorded (queued
  // here while the line is down, sent on reconnect), once per attempt, keyed on it.
  const noAnswerAttemptId = p['noAnswerAttemptId'];
  if (typeof noAnswerAttemptId === 'string' && noAnswerAttemptId !== '') {
    return makeEvent({
      id: `edge-payment-no-answer-${noAnswerAttemptId}`,
      type: 'PaymentNoAnswerRaised',
      occurredAt: typeof p['recordedAt'] === 'string' ? (p['recordedAt'] as string) : new Date().toISOString(),
      idempotencyKey: `payment-no-answer:${noAnswerAttemptId}`,
      source: 'edge/box',
      payload: {
        attemptId: noAnswerAttemptId, laneId: p['laneId'], billRef: p['billRef'], kind: p['kind'], amountMinor: p['amountMinor'], askedAt: p['askedAt'],
        tradingDay: p['tradingDay'], recordedAt: p['recordedAt'], recordedBy: p['recordedBy'], storeId: p['storeId'],
      },
    });
  }

  // OB-55: the provider's later answer on a payment a close carried forward — relayed once per payment, keyed on it.
  const resolvedAttemptId = p['resolvedAttemptId'];
  if (typeof resolvedAttemptId === 'string' && resolvedAttemptId !== '') {
    return makeEvent({
      id: `edge-carried-payment-resolved-${resolvedAttemptId}`,
      type: 'CarriedPaymentResolved',
      occurredAt: typeof p['resolvedAt'] === 'string' ? (p['resolvedAt'] as string) : new Date().toISOString(),
      idempotencyKey: `carried-payment-resolved:${resolvedAttemptId}`,
      source: 'edge/box',
      payload: {
        attemptId: resolvedAttemptId, dayCloseId: p['dayCloseId'], storeId: p['storeId'], paid: p['paid'], owedToCustomerMinor: p['owedToCustomerMinor'],
        amountMinor: p['amountMinor'], detail: p['detail'], resolvedAt: p['resolvedAt'],
      },
    });
  }

  // A reopen record — the controlled, audited unlock of a locked day (§28). Its payload is the body
  // `POST /v1/pos/day-close/:dayCloseId/reopen/synced` reads (reopenedBy, approvedBy, reason), which the
  // cloud re-verifies. Kept idempotent per day on `day-reopen:` so a restart re-queue is a no-op there.
  if (typeof p['reopenedBy'] === 'string') {
    return makeEvent({
      id: `edge-day-reopen-${dayCloseId}`,
      type: 'StoreDayReopened',
      occurredAt: typeof p['reopenedAt'] === 'string' ? (p['reopenedAt'] as string) : new Date().toISOString(),
      idempotencyKey: `day-reopen:${dayCloseId}`,
      source: 'edge/box',
      payload: {
        dayCloseId,
        storeId: p['storeId'],
        tradingDay: p['tradingDay'],
        reopenedBy: p['reopenedBy'],
        approvedBy: p['approvedBy'],
        reason: p['reason'],
        // The box's seal on the reopener, exactly as written (2b-vi-c-3); absent when it verified nobody.
        ...(p['deciderVerified'] === undefined ? {} : { deciderVerified: p['deciderVerified'] }),
        ...(p['approverVerified'] === undefined ? {} : { approverVerified: p['approverVerified'] }),
      },
    });
  }

  return makeEvent({
    id: `edge-day-close-${dayCloseId}`,
    type: 'StoreDayClosed',
    occurredAt: typeof p['closedAt'] === 'string' ? (p['closedAt'] as string) : new Date().toISOString(),
    idempotencyKey: `day-close:${dayCloseId}`,
    source: 'edge/box',
    payload: {
      dayCloseId,
      storeId: p['storeId'],
      tradingDay: p['tradingDay'],
      closedBy: p['closedBy'],
      closedAt: p['closedAt'],
      locked: true,
      // OB-55: the payments carried forward to head office by name, and the box's seal on the second person who approved.
      ...(p['carriedForward'] === undefined ? {} : { carriedForward: p['carriedForward'] }),
      ...(p['approverVerified'] === undefined ? {} : { approverVerified: p['approverVerified'] }),
    },
  });
}

/** Gap between drains when the last one delivered something. */
/**
 * The box's catalogue as the till's legal gate reads it (B14 · B19): name and pack flags, by product id. Indexed once per
 * catalogue the box holds (the same object until a new pack or pack file lands), so a sale does not re-index 40,000
 * products.
 */
const gateIndex = new WeakMap<object, ReadonlyMap<string, GateProduct>>();
function gateProductsOf(pack: StorePack, cataloguePack: Parameters<typeof tillCatalogue>[1], now: string): ReadonlyMap<string, GateProduct> {
  // Head office's pulled pack wins whenever the box holds one; else the pack file (`tillCatalogue`). Either is replaced,
  // never edited, when a new one lands — so the object itself is the key.
  const key: object = cataloguePack ?? pack;
  const held = gateIndex.get(key);
  if (held !== undefined) return held;
  const catalogue = tillCatalogue(pack, cataloguePack, now);
  const map = new Map((catalogue?.products ?? []).map((p) => [p.productId, {
    name: p.name, baseUom: p.uom, unitPriceMinor: p.unitPriceMinor, ...(p.regulatedFlags === undefined ? {} : { regulatedFlags: p.regulatedFlags }),
    // B17 · OB-348: the HSN, so an alcoholic-drink heading is refused before the disk even without a liquor flag.
    ...(p.hsnCode === undefined ? {} : { hsnCode: p.hsnCode }),
  }] as const));
  gateIndex.set(key, map);
  return map;
}

/** OB-348 (B17): the shop's state as this box's store pack names it — text, or absent ("not set"). */
function shopStateOf(pack: StorePack): string | undefined {
  const v = pack.policies.known ? (pack.policies.value as { readonly shopState?: unknown }).shopState : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

const BASE_INTERVAL_MS = 15_000;
/** Ceiling on the gap when nothing is getting through. Five minutes, not five hours. */
const MAX_INTERVAL_MS = 300_000;

/**
 * The store's trading-day cut-off, from the pack.
 *
 * Midnight when the pack has not said, which is the commonest real answer and is stated rather
 * than hidden — a shop that trades past midnight and has not configured a cut-off would otherwise
 * silently split one trading day into two, and nobody would find out until the day close.
 */
export function packCutoff(pack: { readonly policies: { readonly known: boolean; readonly value?: { readonly tradingDayCutoff: string; readonly timeZone?: string } } }): TradingDayRule {
  return packRule(pack);
}

export function nextInterval(consecutiveQuietPasses: number): number {
  const grown = BASE_INTERVAL_MS * 2 ** Math.min(consecutiveQuietPasses, 10);
  return Math.min(grown, MAX_INTERVAL_MS);
}

export interface EdgeProcess {
  readonly log: OpenFileLog;
  /**
   * The RETURN's own durable log — a separate file from the sale log (M13-FR-01). A refund is money
   * leaving the drawer, so it is durable before it is called done; keeping it out of the sale log is
   * what lets the sale path's restart re-queue stay exactly as it was.
   */
  readonly returnsLog: OpenFileLog;
  /**
   * The COMPLETION's own durable log — a separate file from the sale and return logs (M25-FR-02). A
   * checklist/task completed offline is durable before it is called done, and kept out of the other
   * two logs so each pipeline's restart re-queue only ever reads its own kind of record.
   */
  readonly completionsLog: OpenFileLog;
  /**
   * The CONCESSION TAG's own durable log — a separate file again (M27-FR-03). A partner-counter line the till
   * recorded is durable before it is called recorded, and kept out of the other logs for the same reason.
   */
  readonly concessionTagsLog: OpenFileLog;
  /**
   * The DAY-CLOSE's own durable log — a separate file from the other three (M14-FR-04). A trading day
   * the box locked is durable before it is called done, and kept out of the other logs so each
   * pipeline's restart re-queue only ever reads its own kind of record.
   */
  readonly dayCloseLog: OpenFileLog;
  /**
   * The DEVICE EVENTS' own durable log (SP-2a · F11) — work a screen or handheld did on its own device and handed
   * to this box over `/lane/outbox` (an approval decided on the manager's screen first). Durable here before the
   * device is told "accepted", kept out of every other log for the same reason the others are, and carried to
   * head office by its own agent over the shared transport's routes.
   */
  readonly deviceEventsLog: OpenFileLog;
  /**
   * The TILL's CASH log (SP-4c · F10 · M14-FR-01/02) — every float, loan, pickup, safe drop and shift close on the lane
   * this box serves, durable here BEFORE the till is told "recorded" (the till itself keeps nothing: a browser tab is
   * not a place for cash). Its own file, like the other six, and carried to head office by its own agent.
   */
  readonly tillCashLog: OpenFileLog;
  /**
   * The loopback socket the lane's screen posts a sale to, or null when this edge has no lane —
   * the back-office box runs the same process and does the shop-wide work (ADR-0004).
   */
  readonly lane: LaneServer | null;
  readonly outbox: SyncOutbox;
  /** The return pipeline's own outbox — drained by `returnsAgent`, cursored separately from sales. */
  readonly returnsOutbox: SyncOutbox;
  /** The completion pipeline's own outbox — drained by `completionsAgent`, cursored separately again. */
  readonly completionsOutbox: SyncOutbox;
  /** The concession-tag pipeline's own outbox — drained by `concessionTagsAgent`, cursored separately again. */
  readonly concessionTagsOutbox: SyncOutbox;
  /** The day-close pipeline's own outbox — drained by `dayCloseAgent`, cursored separately again. */
  readonly dayCloseOutbox: SyncOutbox;
  /** The device-events pipeline's own outbox — drained by `deviceEventsAgent`, cursored separately again (SP-2a). */
  readonly deviceEventsOutbox: SyncOutbox;
  /** The till-cash pipeline's own outbox — drained by `tillCashAgent`, cursored separately again (SP-4c). */
  readonly tillCashOutbox: SyncOutbox;
  /** What a lane talks to: price a scan, commit a sale, commit a refund, take a new pack. */
  readonly node: EdgeNode;
  /** Null when no cloud is configured — which is a supported way to run, not a fault. */
  readonly agent: SyncAgent | null;
  /** The return pipeline's own sync agent (same transport, own outbox). Null when no cloud. */
  readonly returnsAgent: SyncAgent | null;
  /** The completion pipeline's own sync agent (same transport, own outbox). Null when no cloud. */
  readonly completionsAgent: SyncAgent | null;
  /** The concession-tag pipeline's own sync agent (same transport, own outbox). Null when no cloud. */
  readonly concessionTagsAgent: SyncAgent | null;
  /** The day-close pipeline's own sync agent (same transport, own outbox). Null when no cloud. */
  readonly dayCloseAgent: SyncAgent | null;
  /** The device-events pipeline's own sync agent (same transport, own outbox). Null when no cloud (SP-2a). */
  readonly deviceEventsAgent: SyncAgent | null;
  /** The till-cash pipeline's own sync agent (same transport, own outbox). Null when no cloud (SP-4c). */
  readonly tillCashAgent: SyncAgent | null;
  /**
   * The till's cash, decided and recorded on the box (SP-4c · F10 · M14-FR-01/02). `recordCashMovement` judges a float,
   * loan, pickup or safe drop against the lane's own chain with the same guard head office runs, dates it by the shop's
   * cut-off, writes it durably and queues it; `closeShift` works the shift's figures out from the box's OWN logs (the
   * float and pickups here, the cash taken on the sale log, the cash refunded on the return log), decides the close
   * against the cashier's blind count, writes and queues it; `tillCash` says whether a float is out and who holds it —
   * never a balance. Both writes are idempotent on the till's own id, so a retry after a lost reply is one effect.
   */
  readonly recordCashMovement: (req: {
    readonly movementId: string; readonly movementKind: CashMovementKind; readonly amountMinor: number;
    readonly at: string; readonly custodianId: string; readonly performedBy: string;
  }) => Promise<CashMovementOutcome>;
  readonly closeShift: (req: {
    readonly shiftId: string; readonly closedAt: string; readonly cashierId: string; readonly countedMinor: number;
    readonly denominations?: readonly { readonly denominationMinor: number; readonly count: number }[]; readonly reasonCode?: string;
  }) => Promise<ShiftCloseOutcome>;
  readonly tillCash: () => Promise<TillCashStatus>;
  /**
   * Close and LOCK the store's trading day on the box (M14-FR-04) — the authoritative close, because
   * the "no unsent items" gate can only be evaluated where the outbox lives. Reads the box's LIVE state
   * (all outbox depths + the exception register), hands the tested engine the real numbers, and on
   * success writes the locked day durably and queues it for the cloud. Refuses (with a reason) when the
   * trading day has not ended, an exception is open, an item is unsent, or the register was never
   * checked. Available with or without a cloud — the day locks locally regardless (P-01).
   */
  readonly closeDay: (
    req: {
      readonly dayCloseId: string;
      /** Who says they are closing — only ever checked against the person the box verifies (their PIN or their signed-in session). */
      readonly closedBy?: string;
      /** The closer's own till PIN, keyed by them on the manager screen; goes to the PIN register only, never written. */
      readonly closerPin?: string;
      /** The person this box already verified for the request (their till session or the hosted sign-in). */
      readonly verifiedPerson?: { readonly userId: string; readonly via: string; readonly laneId: string };
      /** OB-55: close with the named pending card/UPI payments carried forward — a SECOND person's staff ID and own till PIN. */
      readonly carryForward?: CarryForwardRequest;
    },
  ) => Promise<
    | { readonly closed: true; readonly tradingDay: string; readonly locked: true; readonly carriedForward?: readonly string[]; readonly unresolvedMinor?: { readonly card: number; readonly upi: number } }
    | { readonly closed: false; readonly reason: string }
  >;
  /**
   * Reopen a locked day on the box (M14-FR-04 / §28) — the controlled, audited unlock. Appends a
   * COMPENSATING reopen to the same durable day-close log (never edits the close — hard rule #2) and
   * queues `StoreDayReopened` for the cloud. Enforces §28's "a different person approved it" via the
   * tested engine (approver ≠ reopener); the approver's actual authority is re-verified at the cloud.
   * Idempotent per day. Available with or without a cloud — the unlock is local regardless (P-01).
   */
  readonly reopenDay: (
    req: { readonly dayCloseId: string; readonly reopenedBy: string; readonly reason: string; readonly approvedBy: string; readonly verifiedPerson?: { readonly userId: string; readonly via: string; readonly laneId: string }; readonly reopenerPin?: string; readonly approverPin?: string },
  ) => Promise<
    | { readonly reopened: true; readonly tradingDay: string }
    | { readonly reopened: false; readonly reason: string }
  >;
  /**
   * Pull the latest signed catalogue pack from the cloud now, adopt it if it is newer and verifies,
   * and persist it to disk — the inbound refresh (SYNC-01). Null when no cloud is configured. The
   * poll loop calls this on its own timer; it is exposed so a test can drive one pull deterministically
   * (the same way `agent.drain` is), rather than waiting on the timer.
   */
  readonly refreshPack: (() => Promise<PackPullOutcome>) | null;
  /**
   * Pull the cloud's migration register now (Stage C3b) and lay it over the store pack's migration sections
   * so the migration screen shows the register — exceptions, totals, days, differences — with the desk's
   * decisions folded in, and says how old it is. Null when no cloud is configured. Rides the same loop as
   * `refreshPack`; exposed for the same reason.
   */
  readonly refreshMigrationFeed: (() => Promise<MigrationFeedPullOutcome>) | null;
  /**
   * Pull the cloud's PUBLISHED document templates now (M01-FR-02 · §31) and lay them into the lane's pack, so
   * the till prints the receipt header and footer head office put in force — under their version — with the
   * cable out. Null when no cloud is configured. Rides the same loop as `refreshPack`; exposed for the same reason.
   */
  readonly refreshPublishedTemplates: (() => Promise<PublishedTemplatesPullOutcome>) | null;
  /**
   * Pull head office's open floor indents now (SP-8c · F08) and lay them into the pack, so the warehouse handheld knows
   * what the back store owes and the Indents screen has its register with the cable out. Null when no cloud is
   * configured. Rides the same loop as `refreshPack`; exposed for the same reason.
   */
  readonly refreshIndentsFeed: (() => Promise<IndentsFeedPullOutcome>) | null;
  /** HA-1: pull head office's open wave / route assignments for this store now. Null without a cloud or a store id. */
  readonly refreshAssignmentsFeed: (() => Promise<AssignmentsFeedPullOutcome>) | null;
  /**
   * PF-09 step 3: pull head office's loyalty balances (member codes, points, store credit, the owner's rule and till spend
   * cap) now, so the till can let a member spend with the cable out. Null without a cloud. Rides the same loop.
   */
  readonly refreshLoyaltyWallets: (() => Promise<WalletFeedPullOutcome>) | null;
  /** PF-09 step 3: the box's copy of the loyalty balances and its record of till spends. */
  readonly loyaltyWallets: LoyaltyWallets;
  /** PF-13: pull the partner counters' agreement terms now. Null without a cloud. Rides the same loop. */
  readonly refreshConcessionTrading: (() => Promise<ConcessionTradingPullOutcome>) | null;
  /** PA-06 = DF-3-a: pull this store's setup from head office now. Null unless the box is set to take it from head office. */
  readonly refreshStorePack: (() => Promise<StorePackPullOutcome>) | null;
  /** Where this box's store setup came from, which version, and whether it is out of date (P-08). */
  readonly storeSetup: () => StoreSetupStatus;
  /** DF-3-b-2: tell head office which catalogue and setup this box holds (when changed). Null unless taking setup from head office. */
  readonly reportHeldVersions: (() => Promise<boolean>) | null;
  /**
   * EA-01: tell head office each queue's last complete sync (its watermark), so the owner's figures say how fresh
   * they really are. Null without a cloud or without EDGE_STORE_ID. Rides the sync loop after the drains.
   */
  readonly reportSyncWatermarks?: (() => Promise<boolean>) | null;
  /**
   * M35-FR-03: tell head office how this box's disk, queue and tills' devices are (D04-FR-05), so its observed health
   * judges them instead of "unknown". Null without a cloud or without EDGE_STORE_ID. Rides the sync loop after the drains.
   */
  readonly reportBoxHealth?: (() => Promise<boolean>) | null;
  /**
   * Run exactly one drain-and-settle of both queues (sales then refunds), returning what moved.
   * Null when no cloud is configured — there is nothing to drain to. The poll loop calls the same
   * core on its timer; this is exposed so a test can drive one pass deterministically, and so an
   * operator tool can force a sync now rather than waiting for the next interval.
   */
  readonly syncOnce: (() => Promise<{ sent: number; dead: number; remaining: number; readonly signInLog?: { sent: number; dead: number; remaining: number } }>) | null;
  /**
   * The box's own account of its link to head office (Stage G slice 2 · design system §1 rule 4): cloud
   * reachability, everything unsent across every queue, dead letters, when something last got through. Served
   * read-only on the lane socket as `GET /lane/sync-status`, so the till's and the manager's sync badges show a
   * fact the box knows instead of a constant the shell assumed. Always present — a box with no cloud says so.
   */
  readonly syncStatus: () => LaneSyncStatus;
  /**
   * OB-288 lane 2 · P2: pull head office's production board and recipes, food-safety checks and transfers now, and keep them
   * on disk, so the screens and handhelds work with the cable out. Null without a cloud. Rides the sync loop.
   */
  readonly refreshWorkFeeds: (() => Promise<readonly WorkFeedPullOutcome[]>) | null;
  /** OB-288 lane 2 · §31.1 · OB-327: this box's clock against head office's, as last measured. */
  readonly clockCheck: () => ClockCheck;
  /** OB-403 "A" · §31.1: what this box holds (new prices, offers, bill-number year) while its clock is 5+ minutes out. */
  readonly activationHold: () => ActivationHoldReport;
  /** R1a (M01-FR-02 · P-08): this machine's time zone against the shop's, as the signed pack names it. */
  readonly zoneCheck: () => ZoneCheck;
  /**
   * Where the six screens are served from, or null when `EDGE_SCREEN_PORT` is unset.
   *
   * Optional because a lane box and the back-office box run the same process: a till does not need
   * to serve the owner's brief, and not opening a socket is better than opening one nobody uses.
   */
  readonly screens: ScreenServer | null;
  /**
   * The handhelds' DEVICE socket (SP-3a · ADR-0019), or null when `EDGE_DEVICE_PORT` is unset. Serves only the
   * handheld shells and the device routes, to enrolled handhelds only; loopback unless `EDGE_DEVICE_HOST` names
   * the shop's address.
   */
  readonly devices: DeviceServer | null;
  /** The box's register of enrolled handhelds, or null when there is no device socket. */
  readonly enrolments: DeviceEnrolments | null;
  stop(): Promise<void>;
}

/**
 * Start the edge.
 *
 * Exported so a test can start it exactly as the container does, and so the container's entry
 * point stays three lines.
 */
export async function startEdge(
  env: Readonly<Record<string, string | undefined>> = process.env,
  say: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  /**
   * Ports with no live counterpart in this build (audit PF-06): the card/UPI payment provider. No provider is connected
   * in production yet (an external gate — credentials and certification); tests pass a stand-in.
   */
  ports: { readonly paymentProvider?: PaymentProviderPort } = {},
): Promise<EdgeProcess | undefined> {
  const config = loadConfig(STORE_EDGE_CONFIG, env);
  if (!config.ok) {
    process.stderr.write(`\n${config.detail}\n\n`);
    process.exitCode = 78; // EX_CONFIG
    return undefined;
  }
  const settings = config.value!;

  const log = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
  });

  // The RETURN's own durable log, in the same data dir but a separate file (M13-FR-01). A refund is
  // money out of the drawer, so it is durable before it is called done — but it must never share the
  // sale log: the sale re-queue below reads every sale-log record as a `SaleCommitted`, and a return
  // among them would be re-sent to `/v1/sales` as a broken sale. Its own file keeps the two apart.
  const returnsLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'returns.log',
  });

  // The durable failed-sync stores — one per pipeline (RR-F06). A dead-lettered sale or refund is
  // appended here BEFORE the cursor moves past it, so a restart recovers it with its reason, attempts
  // and history intact instead of losing it with the process. Append-only, like every ledger the edge
  // keeps (hard rule #6): a resolution is a new entry, never an edit.
  const deadLetterLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'dead-letters',
  });
  const returnsDeadLetterLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'dead-letters-returns',
  });

  // The COMPLETION's own durable log and its own failed-sync store (M25-FR-02) — a checklist or task
  // completed with the cable out is durable before it is called done, exactly as a sale and a refund
  // are, and kept out of both their logs so no restart re-queue ever reads one kind as another (hard
  // rule #1). Its file is separate for the same reason the returns file is.
  const completionsLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'completions.log',
  });
  const completionsDeadLetterLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'dead-letters-completions',
  });

  // The CONCESSION TAG's own durable log and its own failed-sync store (M27-FR-03) — a partner-counter line
  // the till recorded with the cable out is durable before it is called recorded, and kept out of every other
  // log so no restart re-queue ever reads one kind as another (hard rule #1).
  const concessionTagsLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'concession-tags.log',
  });
  const concessionTagsDeadLetterLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'dead-letters-concession-tags',
  });

  // The DAY-CLOSE's own durable log and its own failed-sync store (M14-FR-04) — a trading day the box
  // locked is durable before it is called done, and kept out of the other three logs so each pipeline's
  // restart re-queue only ever reads its own kind of record. A once-a-day, low-volume fourth pipeline.
  const dayCloseLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'day-close.log',
  });
  const dayCloseDeadLetterLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'dead-letters-day-close',
  });

  // The DEVICE EVENTS' own durable log and failed-sync store (SP-2a · F11) — work done on a screen or handheld
  // and handed to this box over `/lane/outbox`. Durable here BEFORE the device is told "accepted" (the device
  // then drops its own copy of the pending state), so the box holds the only copy that matters — and it is
  // fsync'd. Its own file, like the other five, so no restart re-queue ever reads one kind as another.
  const deviceEventsLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'device-events.log',
  });
  const deviceEventsDeadLetterLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'dead-letters-device-events',
  });

  // The TILL's CASH log and its failed-sync store (SP-4c · F10 · M14-FR-01/02) — a float, a pickup, a shift close, each
  // durable here BEFORE the till is told "recorded" (the till keeps none of it: a browser tab dies with a reload, and
  // that is exactly how a float used to vanish). Its own file, like the other six, so no restart re-queue ever reads
  // one kind as another.
  const tillCashLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'till-cash.log',
  });
  const tillCashDeadLetterLog = await openFileLog({
    dataDir: settings['EDGE_DATA_DIR']!,
    capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    fileName: 'dead-letters-till-cash',
  });

  // Report what was found on the disk, including anything a power cut left half-written. It is
  // quarantined rather than repaired, and it is said out loud rather than counted silently (#6).
  const found = await readLog(log.path);
  const broken = found.filter((r) => !r.ok);
  say(`store edge ready: ${found.length - broken.length} record(s) on disk, ${await log.usedBytes()} bytes used`);
  if (broken.length > 0) {
    say(`  ${broken.length} record(s) could not be read whole — most likely a power cut mid-write.`);
    say('  They are kept, not repaired: a repaired half-sale is a made-up sale. Raise this.');
  }

  const tenantId = settings['EDGE_TENANT_ID']!;

  /**
   * The day, as this box can see it.
   *
   * Re-read on every screen request rather than held from boot: a manager opening the screen at
   * four o'clock must be shown four o'clock's sales, and a projection frozen at start-up would
   * quietly report the shop as having taken nothing all day.
   */
  let recordsNow = readSales(found.filter((r) => r.ok).map((r) => (r.ok ? r.record : '')));
  const reread = async (): Promise<void> => {
    const all = await readLog(log.path);
    recordsNow = readSales(all.filter((r) => r.ok).map((r) => (r.ok ? r.record : '')));
    recordsNow = { sales: recordsNow.sales, unreadable: all.filter((r) => !r.ok).length };
  };

  const signer = hmacSigner(settings['PACK_SIGNING_KEY']!);

  // The signed catalogue pack this box last accepted, restored from disk and re-verified the same
  // way a lane verifies one over the wire (SYNC-01). So a reboot starts on the last pack it trusted,
  // not a blank catalogue — and a tampered file on disk is rejected, starting from no pack instead.
  // Read BEFORE the re-queue below, because a re-sent sale is translated to the cloud contract and
  // stamped with the pack version this box holds (the disk record does not carry it).
  const restoredPack = await readSignedPack(settings['EDGE_DATA_DIR']!, signer, tenantId);
  if (restoredPack !== undefined) {
    say(`catalogue pack v${restoredPack.snapshot.version} restored from disk — the last one this box trusted.`);
  }

  /**
   * What the cloud last told this box.
   *
   * It starts as `emptyPack()` — every section saying it does not know — and that is the honest
   * state of a freshly installed box. **Not one section defaults to empty**, because an empty
   * approvals list and an unheard-of approvals list mean opposite things, and the manager's day
   * close is built to refuse the second.
   */
  let pack: StorePack = emptyPack();
  const packPath = settings['EDGE_PACK_FILE'];
  if (packPath !== undefined) {
    try {
      const raw = await readFile(packPath, 'utf8');
      pack = readPack(JSON.parse(raw) as unknown, new Date().toISOString());
      say(`store pack version ${pack.version} loaded from ${packPath}`);
    } catch (e) {
      // Said out loud and then carried on with a pack that knows nothing — which is exactly what
      // this box has. A box that refused to start would take the lanes down over a report.
      say(`the store pack at ${packPath} could not be read (${e instanceof Error ? e.message : String(e)}).`);
      say('  This box will tell every screen it has not been told anything, which is true.');
    }
  } else {
    say('no store pack is configured, so the screens will be told this box knows nothing yet.');
  }

  // PA-06 = DF-3-a (OB-26 "A"): the store's setup from HEAD OFFICE — signed, for this shop and this store, always current.
  // Switched on per box (EDGE_STORE_PACK_SOURCE=head-office + EDGE_STORE_ID). The last setup head office sent is held on
  // disk and checked before it is trusted; once one is held it replaces the pack file entirely (one truth, P-02). Until the
  // first arrives, the pack file (if any) is used — and said.
  const storePackSourceSetting = (settings['EDGE_STORE_PACK_SOURCE'] ?? '').trim();
  const headOfficeStoreId = storePackSourceSetting === 'head-office' ? ((settings['EDGE_STORE_ID'] ?? '').trim() || undefined) : undefined;
  if (storePackSourceSetting === 'head-office' && headOfficeStoreId === undefined) {
    say('EDGE_STORE_PACK_SOURCE is head-office but no EDGE_STORE_ID is set — this box cannot ask head office for its setup, so it uses the pack file.');
  }
  let heldStorePack: StorePackEnvelope | undefined;
  if (headOfficeStoreId !== undefined) {
    heldStorePack = await readHeldStorePack(settings['EDGE_DATA_DIR']!, signer, tenantId, headOfficeStoreId);
    if (heldStorePack !== undefined) {
      pack = readPack(packPayloadOf(heldStorePack), heldStorePack.issuedAt);
      say(`store setup ${heldStorePack.version} from head office (issued ${heldStorePack.issuedAt}) restored from disk${Date.parse(heldStorePack.expiresAt) <= Date.now() ? ' — it is OUT OF DATE: the till keeps trading on it until head office is reached' : ''}.`);
    } else {
      say(`no store setup from head office is held yet for store ${headOfficeStoreId} — ${packPath !== undefined ? 'the pack file is used until the first one arrives' : 'the screens are told this box knows nothing yet'}.`);
    }
  }
  /** What the screens and the badge say about where this box's setup came from (P-08). */
  const storeSetupStatus = (): StoreSetupStatus => (heldStorePack !== undefined
    ? { source: 'head-office', version: heldStorePack.version, issuedAt: heldStorePack.issuedAt, expiresAt: heldStorePack.expiresAt, expired: Date.parse(heldStorePack.expiresAt) <= Date.now() }
    : { source: packPath !== undefined ? 'file' : 'none', version: pack.version, issuedAt: null, expiresAt: null, expired: false });

  // R1a (M01-FR-02 · P-08): the box dates by the SHOP's zone from its signed pack, never the machine's. When the machine's
  // own zone is not the shop's (a container on UTC), that is said in the log here and on the manager's screen, every time.
  const zoneNow = (): ZoneCheck => zoneCheck(pack);
  {
    const z = zoneNow();
    say(z.needsAttention ? `TIME ZONE: ${z.staffMessage}` : `time zone: ${z.staffMessage} (${z.shopTimeZoneFrom === 'store_pack' ? 'from the store pack' : 'the shop default — the store pack names none'})`);
  }

  // Which store this box IS, as its store pack names it — stamped on every sale that leaves here as the stock
  // location (M08-FR-01, Stage D slice 2), for a sale rung live and for one re-queued below on restart. Read live:
  // a later pull may replace the pack. A box with no pack knows no store and stamps nothing (the cloud then says
  // it assumed the lane — P-08 — rather than this box guessing).
  const storeIdOfThisBox = (): string | undefined =>
    (pack.policies.known && typeof pack.policies.value.storeId === 'string' && pack.policies.value.storeId !== '' ? pack.policies.value.storeId : undefined);

  // Which LANE this box is (SP-4b · F09): its own setting, never a default. Stamped on every sale that leaves here when
  // the till's record names none, and told to the served till so a sale is never filed under a lane that does not exist.
  const laneIdOfThisBox = (): string | undefined => {
    const v = settings['EDGE_LANE_ID'];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };
  const laneOfBox = laneIdOfThisBox();

  // OB-252 (owner, 20 Oct 2026, "Guest sales only"): this box's own setting, or the store pack's — read live, because a
  // later pull may replace the pack. Who turned it on is said, so the switch is never a mystery on the till.
  const guestSalesOnly = (): { readonly on: boolean; readonly by: 'store_pack' | 'store_computer_setting' | null } => {
    if (settings['EDGE_GUEST_SALES_ONLY'] === '1') return { on: true, by: 'store_computer_setting' };
    if (pack.policies.known && pack.policies.value.guestSalesOnly === true) return { on: true, by: 'store_pack' };
    return { on: false, by: null };
  };
  if (settings['EDGE_GUEST_SALES_ONLY'] === '1') say('guest sales only (OB-252, EDGE_GUEST_SALES_ONLY=1): the tills this box serves take no customer mobile number and no loyalty.');

  // OB-256 · OB-258 (owner, 20 Oct 2026): the MIRROR PILOT — this box's own setting, or the store pack's, read live like
  // guest sales only. Every sale and refund its tills record is "Paid on old system", and nothing else.
  const mirrorPilot = (): { readonly on: boolean; readonly by: 'store_pack' | 'store_computer_setting' | null } => {
    if (settings['EDGE_MIRROR_PILOT'] === '1') return { on: true, by: 'store_computer_setting' };
    if (pack.policies.known && pack.policies.value.mirrorPilot === true) return { on: true, by: 'store_pack' };
    return { on: false, by: null };
  };
  // Both switches are checked here, at the start: the mirror pilot takes no customer details (OB-252), so a box set for
  // the mirror pilot with guest sales only off does not start — said plainly, never a silent guess. (A later store pack
  // that turns the mirror pilot on without guest sales only is refused on every sale and refund instead.)
  if (mirrorPilot().on && !guestSalesOnly().on) {
    process.stderr.write(`\nThis store computer is set for the mirror pilot (${mirrorPilot().by === 'store_pack' ? 'the store pack says so' : 'EDGE_MIRROR_PILOT=1'}) but "guest sales only" is off. `
      + 'The mirror pilot needs both: set EDGE_GUEST_SALES_ONLY=1 as well (or turn the mirror pilot off), then start again. Nothing was started.\n\n');
    process.exitCode = 78; // EX_CONFIG
    // Nothing started: the logs opened above are let go again, so a refused start holds no file.
    for (const l of [log, returnsLog, completionsLog, dayCloseLog, deadLetterLog, returnsDeadLetterLog, completionsDeadLetterLog, dayCloseDeadLetterLog,
      concessionTagsLog, concessionTagsDeadLetterLog, deviceEventsLog, deviceEventsDeadLetterLog, tillCashLog, tillCashDeadLetterLog]) await l.close();
    return undefined;
  }
  // OB-271 (owner, 21 Oct 2026): REAL TRADING — this box's own `EDGE_REAL_TRADING=1`, or the store pack's, read live like the
  // mirror pilot. Off unless one of them says so; the installer never writes it (the owner sets it after the pilot passes
  // and his written GO). While on, each bill is the legal tax invoice and card/UPI payments carry the machine's number.
  const realTrading = (): { readonly on: boolean; readonly by: 'store_pack' | 'store_computer_setting' | null } => {
    if (settings['EDGE_REAL_TRADING'] === '1') return { on: true, by: 'store_computer_setting' };
    if (pack.policies.known && pack.policies.value.realTrading === true) return { on: true, by: 'store_pack' };
    return { on: false, by: null };
  };
  // The shop's legal identity for the tax invoice, from the store pack (head office's GST registration and the store's
  // address) — read live; `null` when the pack does not carry it, and a real-trading sale is then refused in words.
  const taxInvoiceIdentity = (): { readonly legalName: string; readonly gstin: string; readonly placeOfBusiness: readonly string[] } | null => {
    const t = pack.policies.known ? pack.policies.value.taxInvoice : undefined;
    if (t === undefined || t === null || typeof t !== 'object') return null;
    return {
      legalName: typeof t.legalName === 'string' ? t.legalName : '', gstin: typeof t.gstin === 'string' ? t.gstin : '',
      placeOfBusiness: Array.isArray(t.placeOfBusiness) ? t.placeOfBusiness.filter((l): l is string => typeof l === 'string') : [],
    };
  };
  // Mirror and real trading are never on together (OB-248 · OB-271): a box set for both does not start — said plainly.
  if (mirrorPilot().on && realTrading().on) {
    process.stderr.write(`\nThis store computer is set for the mirror pilot (${mirrorPilot().by === 'store_pack' ? 'the store pack says so' : 'EDGE_MIRROR_PILOT=1'}) AND for real trading (${realTrading().by === 'store_pack' ? 'the store pack says so' : 'EDGE_REAL_TRADING=1'}). `
      + 'They are never on together: during the mirror pilot the old system bills the customer; in real trading this system does. Turn one of them off, then start again. Nothing was started.\n\n');
    process.exitCode = 78; // EX_CONFIG
    for (const l of [log, returnsLog, completionsLog, dayCloseLog, deadLetterLog, returnsDeadLetterLog, completionsDeadLetterLog, dayCloseDeadLetterLog,
      concessionTagsLog, concessionTagsDeadLetterLog, deviceEventsLog, deviceEventsDeadLetterLog, tillCashLog, tillCashDeadLetterLog]) await l.close();
    return undefined;
  }
  if (realTrading().on) say(`REAL TRADING (OB-271, ${realTrading().by === 'store_pack' ? 'store pack' : 'EDGE_REAL_TRADING=1'}): each bill the tills print is the legal GST tax invoice; a sale whose bill would miss a required field is refused.${taxInvoiceIdentity() === null ? ' The store pack carries no legal name, address and GSTIN yet, so every sale will be refused until it does.' : ''}`);
  if (mirrorPilot().on) say(`mirror pilot (OB-256, ${mirrorPilot().by === 'store_pack' ? 'store pack' : 'EDGE_MIRROR_PILOT=1'}): the tills this box serves record every sale and refund as "Paid on old system" — the old ERP bills and takes the money; no money goes in or out of the drawer here.`);
  say(laneOfBox === undefined
    ? 'no EDGE_LANE_ID is set: the till this box serves will refuse to take payment until this box is told which lane it is.'
    : `this box is lane ${laneOfBox}: every sale it rings names it.`);

  /**
   * Rebuild each queue from its durable log and its durable dead-letter store.
   *
   * The log is the system of record and the queue is a view of it, so a restart reconstructs the
   * view rather than trusting one that died with the process. `SyncPipeline` owns the rule that used
   * to live inline here and got two things subtly wrong (RR-F05/RR-F06): it re-queues what is
   * unfinished, restores every known failure so it stays visible with its history, and derives the
   * checkpoint per *log position* so a duplicate record cannot strand the cursor and a dead-letter is
   * never stepped over into oblivion. Each record is translated to the cloud contract on its way in
   * (the same seam `createEdgeNode.commit` uses), so a record re-sent after a crash is read by the
   * cloud exactly like one sent live and dedupes there (§31.1) — re-sending is cheap, skipping is
   * permanent.
   *
   * The two pipelines never share a file — one number cannot mark two logs — so the sale path is
   * untouched by anything the refund pipeline does, and the reverse.
   */
  const restoredPackVersion = restoredPack?.snapshot.version ?? 0;
  const salesPipeline = new SyncPipeline({
    dataDir: settings['EDGE_DATA_DIR']!, log, deadLetterLog, cursorFile: undefined, noun: 'sale', say,
    eventFor: (record, index) => {
      let parsed: unknown;
      try { parsed = JSON.parse(record) as unknown; } catch { return undefined; }
      const saleId = (parsed as { id?: string; saleId?: string }).id
        ?? (parsed as { saleId?: string }).saleId ?? `record-${index}`;
      return makeEvent({
        id: `edge-sale-${saleId}`, type: 'SaleCommitted', occurredAt: new Date().toISOString(),
        idempotencyKey: `edge-${tenantId}-${saleId}`, source: 'edge/lane',
        payload: toCloudSale(parsed, restoredPackVersion, storeIdOfThisBox(), laneIdOfThisBox()),
      });
    },
  });
  const returnsPipeline = new SyncPipeline({
    dataDir: settings['EDGE_DATA_DIR']!, log: returnsLog, deadLetterLog: returnsDeadLetterLog,
    cursorFile: RETURNS_CURSOR, noun: 'refund', say,
    eventFor: (record, index) => {
      let parsed: unknown;
      try { parsed = JSON.parse(record) as unknown; } catch { return undefined; }
      const cloud = toCloudReturn(parsed, storeIdOfThisBox()); // the store stamp survives a restart too (F17)
      const returnId = cloud.returnId !== '' ? cloud.returnId : `record-${index}`;
      return makeEvent({
        id: `edge-return-${returnId}`, type: 'ReturnAccepted', occurredAt: new Date().toISOString(),
        idempotencyKey: `edge-return-${tenantId}-${returnId}`, source: 'edge/lane',
        payload: cloud,
      });
    },
  });

  // The COMPLETION pipeline (M25-FR-02) — the same machine as the sale and refund pipelines over a
  // third file, so the offline completion queue reuses the tested restart-recovery rule rather than
  // re-implementing it. Each on-disk record is an envelope the lane wrote (`{ completionKind, body }`),
  // so `eventFor` routes a checklist to `ChecklistCompleted` and a task to `TaskCompleted` without
  // guessing from the record's shape (P-08). The event it mints matches `commitCompletion`'s exactly
  // — same id, type, key and payload — so a record re-sent after a crash dedupes at the cloud against
  // the one that may already have gone live (§31.1). Never shares a file with sales or refunds.
  const completionsPipeline = new SyncPipeline({
    dataDir: settings['EDGE_DATA_DIR']!, log: completionsLog, deadLetterLog: completionsDeadLetterLog,
    cursorFile: COMPLETIONS_CURSOR, noun: 'completion', say,
    eventFor: (record, index) => {
      let envelope: unknown;
      try { envelope = JSON.parse(record) as unknown; } catch { return undefined; }
      const env = (envelope !== null && typeof envelope === 'object' ? envelope : {}) as { completionKind?: unknown; body?: unknown };
      const completionKind = env.completionKind === 'task' ? 'task' : env.completionKind === 'checklist' ? 'checklist' : undefined;
      if (completionKind === undefined) return undefined;
      const body = env.body;
      const id = (completionKind === 'checklist' ? checklistIdOf(body) : taskIdOf(body)) ?? `record-${index}`;
      return makeEvent({
        id: `edge-completion-${completionKind}-${id}`,
        type: completionKind === 'checklist' ? 'ChecklistCompleted' : 'TaskCompleted',
        occurredAt: new Date().toISOString(),
        idempotencyKey: `edge-completion-${tenantId}-${completionKind}-${id}`,
        source: 'edge/lane',
        payload: completionKind === 'checklist' ? toCloudChecklist(body, storeIdOfThisBox()) : toCloudTaskCompletion(body),
      });
    },
  });

  // The DAY-CLOSE pipeline (M14-FR-04) — the same machine as the other three over a fourth file. A
  // trading day the box locked is durable before it is called done, then queued for the cloud and
  // carried up by its own agent via the `StoreDayClosed` route (already in EVENT_ROUTES). `eventFor`
  // re-mints the same event on restart, so a close that had not yet reached the cloud when the box
  // stopped goes when it starts again — never lost (hard rule #6). Never shares a file with the others.
  const dayClosePipeline = new SyncPipeline({
    dataDir: settings['EDGE_DATA_DIR']!, log: dayCloseLog, deadLetterLog: dayCloseDeadLetterLog,
    cursorFile: DAYCLOSE_CURSOR, noun: 'day close', say,
    eventFor: dayCloseEventFrom,
  });

  // The CONCESSION TAG pipeline (M27-FR-03) — the same machine over a fifth file. `eventFor` re-mints exactly
  // the event `commitConcessionTag` queued (same id, type, key and payload), so a line that had not reached the
  // cloud when the box stopped goes when it starts again and dedupes there against one that may already have
  // gone (§31.1). Never shares a file with the others.
  const concessionTagsPipeline = new SyncPipeline({
    dataDir: settings['EDGE_DATA_DIR']!, log: concessionTagsLog, deadLetterLog: concessionTagsDeadLetterLog,
    cursorFile: CONCESSION_TAGS_CURSOR, noun: 'partner-counter line', say,
    eventFor: (record, index) => {
      let parsed: unknown;
      try { parsed = JSON.parse(record) as unknown; } catch { return undefined; }
      const cloud = toCloudConcessionTag(parsed);
      const tagId = cloud.tagId !== '' ? cloud.tagId : `record-${index}`;
      return makeEvent({
        id: `edge-concession-tag-${tagId}`, type: 'ConcessionTagCaptured', occurredAt: new Date().toISOString(),
        idempotencyKey: `edge-concession-tag-${tenantId}-${tagId}`, source: 'edge/lane',
        payload: cloud,
      });
    },
  });

  // The DEVICE EVENTS pipeline (SP-2a · F11) — the same machine over a sixth file. Each record IS the event the
  // device minted, stored whole (id, type, key, payload, …), so `eventFor` re-mints exactly what was queued and
  // a restart re-sends exactly what had not reached head office — deduped there by the device's own key (§31.1).
  // A record that does not read back as a relayable event is the pipeline's malformed case (visible, durable,
  // never skipped). Never shares a file with the others.
  const deviceEventsPipeline = new SyncPipeline({
    dataDir: settings['EDGE_DATA_DIR']!, log: deviceEventsLog, deadLetterLog: deviceEventsDeadLetterLog,
    cursorFile: DEVICE_EVENTS_CURSOR, noun: 'screen record', say,
    eventFor: (record) => {
      let parsed: unknown;
      try { parsed = JSON.parse(record) as unknown; } catch { return undefined; }
      const key = (parsed as { idempotencyKey?: unknown } | null)?.idempotencyKey;
      const read = readRelayItem({ key, event: parsed });
      return read.ok ? read.item.event : undefined;
    },
  });

  // The TILL-CASH pipeline (SP-4c · F10) — the same machine over a seventh file. `eventFor` re-mints exactly the event
  // the box queued when it recorded the movement or the close (`tillCashEventFactory`: same id, type, key and payload),
  // so a float or a close that had not reached head office when the box stopped goes when it starts again and dedupes
  // there against one that may already have gone (§31.1). Never shares a file with the others.
  const tillCashEvent = tillCashEventFactory(tenantId);
  const tillCashPipeline = new SyncPipeline({
    dataDir: settings['EDGE_DATA_DIR']!, log: tillCashLog, deadLetterLog: tillCashDeadLetterLog,
    cursorFile: TILL_CASH_CURSOR, noun: 'till cash record', say,
    eventFor: tillCashEvent,
  });

  const salesRestore = await salesPipeline.restore();
  const returnsRestore = await returnsPipeline.restore();
  const completionsRestore = await completionsPipeline.restore();
  const dayCloseRestore = await dayClosePipeline.restore();
  const concessionTagsRestore = await concessionTagsPipeline.restore();
  const deviceEventsRestore = await deviceEventsPipeline.restore();
  const tillCashRestore = await tillCashPipeline.restore();
  const outbox = salesPipeline.outbox;
  const returnsOutbox = returnsPipeline.outbox;
  const completionsOutbox = completionsPipeline.outbox;
  const dayCloseOutbox = dayClosePipeline.outbox;
  const concessionTagsOutbox = concessionTagsPipeline.outbox;
  const deviceEventsOutbox = deviceEventsPipeline.outbox;
  const tillCashOutbox = tillCashPipeline.outbox;
  // LIVE unsent across ALL pipelines — the day close's gate, and (PA-04) what this box tells head office it still holds.
  // OB-55 / PF-06: a payment exception's relay (a late answer, a carried payment's provider answer) rides the day-close
  // queue AHEAD of the next close event, so it reaches head office first; it is not trading the day still owes the cloud,
  // and counting it would stop an offline store closing (P-01). It stays visible on the queue and is relayed once.
  const EXCEPTION_RELAYS = new Set(['LatePaymentAnswerRecorded', 'CarriedPaymentResolved', 'PaymentNoAnswerRaised']);
  const unsentAcrossAllQueues = (): number => outbox.pending().length + returnsOutbox.pending().length
    + completionsOutbox.pending().length + dayCloseOutbox.pending().filter((i) => !EXCEPTION_RELAYS.has(i.event.type)).length + concessionTagsOutbox.pending().length
    + deviceEventsOutbox.pending().length + tillCashOutbox.pending().length;

  // Every device-event key this box has EVER taken, rebuilt from the whole durable log — not from the outbox,
  // which after a restart holds only the unfinished tail. A device that lost the box's reply and retries a key
  // the box acknowledged and cursored past weeks ago must still hear `duplicate`, never `accepted` twice (§31.1).
  const deviceEventKeys = new Set<string>();
  // OB-271 · audit A11: the card/UPI refunds done on the shop's own machine, as recorded here (the till's day list reads them).
  const cardRefundsOnMachine: Record<string, unknown>[] = [];
  for (const entry of await readLog(deviceEventsLog.path)) {
    if (!entry.ok) continue;
    try {
      const event = JSON.parse(entry.record) as { idempotencyKey?: unknown; type?: unknown; payload?: Record<string, unknown> };
      const key = event.idempotencyKey;
      if (typeof key === 'string' && key !== '') deviceEventKeys.add(key);
      if (event.type === 'TillActivityRecorded' && event.payload?.['kind'] === 'card_refund_on_machine') cardRefundsOnMachine.push(event.payload);
    } catch { /* the pipeline already surfaced it as malformed */ }
  }

  /**
   * Take a batch of work a screen or handheld did on its own device (SP-2a · F11): the box's `/lane/outbox`
   * decision. Per item, in order: read it strictly (a malformed item is REFUSED with the reason — the device
   * dead-letters it for a person, never repairs it); check the allow-list for this source (a type nobody reviewed
   * must not ride the store's credential to head office → refused); dedupe by key (a retry after a lost reply →
   * `duplicate`, one effect); write it durably (fsync'd, with the capacity reserve) and only THEN queue it and say
   * `accepted`. A write the disk refused is `not_saved` — the device keeps the item; nothing was lost anywhere.
   * The key is reserved before the write so two batches carrying the same key cannot both be accepted.
   */
  // The seal key (ADR-0023): derived from the pack signing key under the seal's own label — never written anywhere.
  const sealKey = tillSealKey(settings['PACK_SIGNING_KEY']!);
  // The loyalty member-code key head office uses too — both from the pack signing key (PF-09).
  const loyaltyKey = loyaltyMemberKey(settings['PACK_SIGNING_KEY']!);
  const relayDeviceEvents: LaneDeviceRelayHandler = async (batch) => {
    const acks: DeviceAck[] = [];
    for (const raw of batch.items) {
      const read = readRelayItem(raw);
      if (!read.ok) {
        acks.push({ key: read.key ?? '', status: 'refused', reason: read.reason });
        continue;
      }
      const { key } = read.item;
      // A back-office decision is sealed here when the person this box verified is the one it names (2b-vi-c-3);
      // any stamp the device sent itself is removed — only the box vouches.
      // OB-172: a HANDHELD's record reaches here only once the device socket has checked that the person it names held THIS
      // phone this shift, signed in with their own PIN (DF-3-c). OB-180 "A": a record STAMPED with the sign-in it was made
      // under — a stamp the device socket verified (this phone, this record, inside that sign-in) — is sealed for the
      // person whose sign-in made it, even if somebody else holds the phone now. An UNSTAMPED record (a phone queue from
      // before OB-180) keeps verifier r2final NEW-4's rule: sealed only for the person holding the phone NOW; naming
      // anybody else it travels UNSEALED and head office flags it as not accepted (hard rule #10).
      const verified = batch.deviceId === undefined ? batch.verifiedPerson : (() => {
        const named = personNamedBy(read.item.event);
        if (!named.ok) return undefined;
        const stampedBy = batch.stampedBy?.[key];
        const vouched = stampedBy !== undefined ? stampedBy === named.userId : batch.phoneHolder !== undefined && named.userId === batch.phoneHolder;
        return vouched ? { userId: named.userId, via: 'phone_pin', laneId: deviceLaneOf(batch.deviceId) } : undefined;
      })();
      const event = withDeciderSeal(sealKey, tenantId, read.item.event, verified);
      if (!isRelayable(event.type, batch.source)) {
        acks.push({ key, status: 'refused', reason: `${event.type} is not a record this box relays for ${batch.source}` });
        continue;
      }
      if (deviceEventKeys.has(key)) {
        acks.push({ key, status: 'duplicate' });
        continue;
      }
      deviceEventKeys.add(key);
      const outcome = await commitLocally({ saleId: key, record: JSON.stringify(event), log: deviceEventsLog });
      if (!outcome.committed) {
        deviceEventKeys.delete(key);
        acks.push({ key, status: 'not_saved', reason: outcome.detail });
        continue;
      }
      deviceEventsOutbox.enqueue(event);
      acks.push({ key, status: 'accepted' });
    }
    // A handheld's batch names the device it came from (the device socket authenticated it): said in the log, so the
    // box's own record shows which handheld handed over what — counts only, never a record or a credential.
    if (batch.deviceId !== undefined) {
      const taken = acks.filter((a) => a.status === 'accepted').length;
      const refused = acks.filter((a) => a.status === 'refused').length;
      say(`handheld ${batch.deviceId} (${batch.source}) handed over ${taken} record(s)${refused > 0 ? `, ${refused} refused` : ''}`);
    }
    return { acks };
  };

  /**
   * A TILL ACTION kept as loss-prevention evidence (audit PF-07 · M15-FR-01): a void — the line, its value, the reason —
   * stamped with the cashier THIS box verified (never a name the till typed), written to the device-events log (fsync'd)
   * and only then queued for head office as `TillActivityRecorded`, on the same dedupe set, cursor and dead-letter queue
   * as every relayed record. The till removes the line only once this says `recorded`. A re-sent void is the same one.
   */
  // OB-288 P6 (R8-3 · R8-7): a self-checkout basket's evidence rides the same door, kept as its own record (self-checkout-baskets.ts).
  const recordSelfCheckoutBasket = selfCheckoutBasketRecorder({ tenantId, keys: deviceEventKeys, log: deviceEventsLog, outbox: deviceEventsOutbox, now: () => new Date().toISOString(), tradingDayOf: (at) => packTradingDay(pack, at) });
  const recordTillActivity: LaneTillActivityHandler = async ({ laneId, cashierId, via, body }) => {
    if (body['kind'] === 'self_checkout_basket') return recordSelfCheckoutBasket({ laneId, cashierId, via, body });
    const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
    const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    const kind = body['kind'];
    const value = body['valueMinor'];
    // What each kind must say. A void and a price override name the line; a no-sale (the drawer opened with no sale)
    // names no line and moves no value (audit PF-07 · M15-FR-01 · M12-FR-04).
    const readable = str(body['activityId']) && str(body['reason']) && (
      (kind === 'void' && str(body['billRef']) && str(body['lineId']) && str(body['productId']) && typeof body['description'] === 'string' && whole(value))
      || (kind === 'no_sale' && (value === undefined || value === 0) && (body['billRef'] === undefined || str(body['billRef'])))
      || (kind === 'price_override' && str(body['billRef']) && str(body['lineId']) && str(body['productId']) && typeof body['description'] === 'string'
        && whole(body['fromUnitMinor']) && whole(body['toUnitMinor']) && (body['toUnitMinor'] as number) < (body['fromUnitMinor'] as number)
        && whole(body['quantityMinor']) && (body['quantityMinor'] as number) > 0 && whole(value) && (value as number) > 0)
      // OB-271 · audit A11: a card/UPI refund done on the shop's own machine — the refund (billRef), its amount, its tender,
      // and the machine's refund reference (read below, never card data).
      || (kind === 'card_refund_on_machine' && str(body['billRef']) && whole(value) && (value as number) > 0 && (body['refundTender'] === 'card' || body['refundTender'] === 'upi')));
    if (!readable) {
      return { recorded: false, refusedBecause: 'not_readable', laneMessage: kind === 'void'
        ? 'The till did not say which line, how much and why. Nothing was removed — try again.'
        : 'The till did not say what was done, to which line, for how much and why. Nothing was done — try again.' };
    }
    const key = `till-activity-${tenantId}-${body['activityId']}`;
    if (deviceEventKeys.has(key)) return { recorded: true, laneMessage: 'Already recorded.' };
    // OB-271 · audit A11: only in real trading (off during the mirror pilot), for a card/UPI refund THIS box holds as pending,
    // for exactly its amount and tender, once — with the machine's own refund reference.
    let machineRef: string | undefined;
    if (kind === 'card_refund_on_machine') {
      if (!realTrading().on) return { recorded: false, refusedBecause: 'not_in_real_trading', laneMessage: 'A card refund on the machine is recorded only in real trading. Nothing was done.' };
      const ref = readMachineReference(body['machineRef']);
      if (!ref.ok) return { recorded: false, refusedBecause: ref.refusedBecause, laneMessage: ref.laneMessage };
      machineRef = ref.value;
      const returnId = body['billRef'] as string;
      if (cardRefundsOnMachine.some((r) => r['billRef'] === returnId)) {
        return { recorded: false, refusedBecause: 'card_refund_already_recorded', laneMessage: 'This refund was already recorded as done on the machine. Do not refund it again.' };
      }
      let held: Record<string, unknown> | undefined;
      for (const entry of await readLog(returnsLog.path)) {
        if (!entry.ok) continue;
        try { const r = JSON.parse(entry.record) as Record<string, unknown>; if (returnIdOf(r) === returnId) { held = r; break; } } catch { /* not a refund */ }
      }
      // What left the shop on a card or UPI: a refund's own amount and tender — or, for an EXCHANGE whose difference the shop
      // owed the customer, that difference and the tender it went back on (OB-271: done on the machine exactly the same way).
      const exchange = held !== undefined && held['refundTender'] === 'exchange' && held['exchange'] !== null && typeof held['exchange'] === 'object'
        ? held['exchange'] as Record<string, unknown> : undefined;
      const refundMinor = held === undefined ? undefined
        : held['refundTender'] === 'exchange' ? (exchange?.['balance'] === 'refund' && typeof exchange['balanceMinor'] === 'number' ? exchange['balanceMinor'] : undefined)
          : typeof held['refundMinor'] === 'number' ? held['refundMinor']
            : typeof (held['refund'] as { minor?: unknown } | undefined)?.minor === 'number' ? (held['refund'] as { minor: number }).minor : undefined;
      const heldTender = held === undefined ? undefined : held['refundTender'] === 'exchange' ? (exchange?.['balance'] === 'refund' ? exchange['balanceTender'] : undefined) : held['refundTender'];
      if (held === undefined || held['laneId'] !== laneId || heldTender !== body['refundTender'] || refundMinor !== value) {
        return { recorded: false, refusedBecause: 'card_refund_not_here', laneMessage: 'This store computer holds no card or UPI refund on this till for that amount. Nothing was recorded — check the refund number.' };
      }
    }
    // A SUPERVISOR OVERRIDE (no-sale, price change) needs a manager's approval issued on THIS box for exactly this — the
    // one-use approval refunds use (PF-02) — spent by this action before anything is written. Offline: nothing here asks
    // head office.
    let approval: { readonly approvalId: string; readonly approvedBy: string } | undefined;
    if (kind === 'no_sale' || kind === 'price_override' || kind === 'card_refund_on_machine') {
      if (tillApprovals === null) return { recorded: false, refusedBecause: 'not_served', laneMessage: 'This store computer does not approve overrides. Nothing was done.' };
      const spent = await tillApprovals.spendOverride({
        approvalId: body['approvalId'], kind, billRef: kind === 'no_sale' ? null : body['billRef'] as string, valueMinor: kind === 'no_sale' ? 0 : value as number,
        requestedBy: cashierId, laneId, activityId: body['activityId'] as string,
      });
      if (!spent.ok) return { recorded: false, refusedBecause: spent.refusedBecause, laneMessage: spent.laneMessage };
      approval = spent.stamp;
    }
    const at = new Date().toISOString();
    // The trading day it belongs to, by the shop's cut-off from the pack — head office judges days by it.
    const tradingDay = packTradingDay(pack, at);
    const common = { activityId: body['activityId'], kind, laneId, cashierId, via, reason: (body['reason'] as string).trim(), at, tradingDay };
    const payload = kind === 'void'
      ? { ...common, billRef: body['billRef'], lineId: body['lineId'], productId: body['productId'], description: body['description'], valueMinor: value }
      : kind === 'no_sale'
        ? { ...common, ...(str(body['billRef']) ? { billRef: body['billRef'] } : {}), valueMinor: 0, approvalId: approval!.approvalId, approvedBy: approval!.approvedBy }
        : kind === 'card_refund_on_machine'
          ? { ...common, billRef: body['billRef'], valueMinor: value, refundTender: body['refundTender'], machineRef, approvalId: approval!.approvalId, approvedBy: approval!.approvedBy }
          : {
          ...common, billRef: body['billRef'], lineId: body['lineId'], productId: body['productId'], description: body['description'],
          fromUnitMinor: body['fromUnitMinor'], toUnitMinor: body['toUnitMinor'], quantityMinor: body['quantityMinor'], valueMinor: value,
          approvalId: approval!.approvalId, approvedBy: approval!.approvedBy,
        };
    const event: DomainEvent = makeEvent({
      id: `till-activity-${body['activityId']}`, type: 'TillActivityRecorded', occurredAt: at, idempotencyKey: key, source: `store-box/${laneId}`,
      payload,
    });
    deviceEventKeys.add(key);
    const outcome = await commitLocally({ saleId: key, record: JSON.stringify(event), log: deviceEventsLog });
    if (!outcome.committed) {
      deviceEventKeys.delete(key);
      return { recorded: false, refusedBecause: outcome.refusedBecause ?? 'could_not_write_durably', laneMessage: kind === 'void'
        ? 'The store computer could not record the void, so the line stays on the bill. Tell the manager.'
        : 'The store computer could not record this, so nothing was done. Tell the manager.' };
    }
    deviceEventsOutbox.enqueue(event);
    if (kind === 'card_refund_on_machine') cardRefundsOnMachine.push(payload as Record<string, unknown>);
    return { recorded: true, laneMessage: 'Recorded.', ...(approval === undefined ? {} : { approvedBy: approval.approvedBy }) };
  };

  /**
   * Where the device items this box took have got to (SP-2a): `posted` once head office acknowledged, `refused`
   * with the reason when it is in the visible dead-letter queue, `pending` while still to send, `unknown` for a
   * key this box never took. A key below the cursor and not in the outbox was acknowledged in an earlier run.
   */
  const deviceEventStatus: LaneDeviceStatusHandler = (keys) => keys.map((key): BoxItemStatus => {
    const item = deviceEventsOutbox.find(key);
    if (item !== undefined) {
      if (item.state === 'acknowledged') return { key, state: 'posted', attempts: item.attempts };
      if (item.state === 'dead_letter') return { key, state: 'refused', attempts: item.attempts, reason: item.reason ?? 'refused' };
      return { key, state: 'pending', attempts: item.attempts };
    }
    return deviceEventKeys.has(key) ? { key, state: 'posted', attempts: 0 } : { key, state: 'unknown', attempts: 0 };
  });

  if (salesRestore.resendCount > 0) say(`${salesRestore.resendCount} sale(s) from before are still to send.`);
  if (salesRestore.restoredDeadLetters > 0) {
    say(`  ${salesRestore.restoredDeadLetters} sale(s) the cloud refused earlier are still waiting for a person — kept, with their history.`);
  }
  if (returnsRestore.brokenCount > 0) {
    say(`  ${returnsRestore.brokenCount} refund record(s) could not be read whole — kept, not repaired. Raise this.`);
  }
  if (returnsRestore.resendCount > 0) say(`${returnsRestore.resendCount} refund(s) from before are still to send.`);
  if (returnsRestore.restoredDeadLetters > 0) {
    say(`  ${returnsRestore.restoredDeadLetters} refund(s) the cloud refused earlier are still waiting for a person — kept, with their history.`);
  }
  if (completionsRestore.brokenCount > 0) {
    say(`  ${completionsRestore.brokenCount} completion record(s) could not be read whole — kept, not repaired. Raise this.`);
  }
  if (completionsRestore.resendCount > 0) say(`${completionsRestore.resendCount} completion(s) from before are still to send.`);
  if (completionsRestore.restoredDeadLetters > 0) {
    say(`  ${completionsRestore.restoredDeadLetters} completion(s) the cloud refused earlier are still waiting for a person — kept, with their history.`);
  }
  if (dayCloseRestore.brokenCount > 0) {
    say(`  ${dayCloseRestore.brokenCount} day-close record(s) could not be read whole — kept, not repaired. Raise this.`);
  }
  if (dayCloseRestore.resendCount > 0) say(`${dayCloseRestore.resendCount} day close(s) from before are still to send.`);
  if (dayCloseRestore.restoredDeadLetters > 0) {
    say(`  ${dayCloseRestore.restoredDeadLetters} day close(s) the cloud refused earlier are still waiting for a person — kept, with their history.`);
  }
  if (concessionTagsRestore.brokenCount > 0) {
    say(`  ${concessionTagsRestore.brokenCount} partner-counter line record(s) could not be read whole — kept, not repaired. Raise this.`);
  }
  if (concessionTagsRestore.resendCount > 0) say(`${concessionTagsRestore.resendCount} partner-counter line(s) from before are still to send.`);
  if (concessionTagsRestore.restoredDeadLetters > 0) {
    say(`  ${concessionTagsRestore.restoredDeadLetters} partner-counter line(s) the cloud refused earlier are still waiting for a person — kept, with their history.`);
  }
  if (deviceEventsRestore.brokenCount > 0) {
    say(`  ${deviceEventsRestore.brokenCount} screen record(s) could not be read whole — kept, not repaired. Raise this.`);
  }
  if (deviceEventsRestore.resendCount > 0) say(`${deviceEventsRestore.resendCount} screen record(s) from before are still to send.`);
  if (deviceEventsRestore.restoredDeadLetters > 0) {
    say(`  ${deviceEventsRestore.restoredDeadLetters} screen record(s) head office refused earlier are still waiting for a person — kept, with their history.`);
  }
  if (tillCashRestore.brokenCount > 0) {
    say(`  ${tillCashRestore.brokenCount} till cash record(s) could not be read whole — kept, not repaired. Raise this.`);
  }
  if (tillCashRestore.resendCount > 0) say(`${tillCashRestore.resendCount} till cash record(s) from before are still to send.`);
  if (tillCashRestore.restoredDeadLetters > 0) {
    say(`  ${tillCashRestore.restoredDeadLetters} till cash record(s) head office refused earlier are still waiting for a person — kept, with their history.`);
  }

  // The refund operation-identity guard (RR-F03), rebuilt from the durable returns log so the rule
  // holds across a restart: every refund already on the disk is remembered by its id and the
  // canonical hash of the record it committed with. A reused id then returns the original outcome
  // (identical payload) or is refused as a conflict (different money) — before anything is written.
  const returnsIdempotency = new IdempotencyGuard(
    (await readLog(returnsLog.path))
      .flatMap((r) => (r.ok ? [r.record] : []))
      .flatMap((rec) => {
        let parsed: unknown;
        try { parsed = JSON.parse(rec); } catch { return []; }
        const id = returnIdOf(parsed);
        return id === undefined ? [] : [[id, canonicalHash(rec)] as const];
      }),
  );

  // Refund entitlement from trusted local data (RR-F04), rebuilt from the durable logs: how much
  // each sale THIS edge rang actually sold, and how much has already been returned against it. A
  // refund that would take back more than was sold is refused using these totals, never the numbers
  // the request supplies. A `lines` parser tolerant of the on-disk shape (a sale record's own
  // `lines[].quantityMinor`; a refund's via `toCloudReturn`).
  const linesOf = (rec: string): EntitlementLine[] => {
    try {
      const parsed = JSON.parse(rec) as { lines?: unknown };
      return Array.isArray(parsed.lines)
        ? (parsed.lines as { productId?: unknown; quantityMinor?: unknown }[])
            .flatMap((l) => (typeof l.productId === 'string' && typeof l.quantityMinor === 'number'
              ? [{ productId: l.productId, quantityMinor: l.quantityMinor }] : []))
        : [];
    } catch { return []; }
  };
  const salesRecords = (await readLog(log.path)).flatMap((r) => (r.ok ? [r.record] : []));
  // B13 (OB-138): every hallmark HUID this box has sold, from its own disk — refused again at the till and before the disk.
  const soldHuids = new SoldHuids(salesRecords);
  const returnsRecords = (await readLog(returnsLog.path)).flatMap((r) => (r.ok ? [r.record] : []));
  // OB-264: the old ERP's bill numbers on this box's mirror sales, and the refunds against them, from its own disk — so a
  // number keyed twice is refused, and a mirror refund finds its sale by the number on the customer's old bill.
  const oldErpBills = openOldErpBills(salesRecords, returnsRecords);
  const returnsEntitlement = new ReturnEntitlement(
    salesRecords.flatMap((rec) => {
      let id: unknown;
      try { id = (JSON.parse(rec) as { id?: unknown }).id; } catch { return []; }
      return typeof id === 'string' && id !== '' ? [{ saleId: id, lines: linesOf(rec) }] : [];
    }),
    returnsRecords.flatMap((rec) => {
      let parsed: unknown;
      try { parsed = JSON.parse(rec); } catch { return []; }
      const cloud = toCloudReturn(parsed);
      return typeof cloud.originalSaleId === 'string' && cloud.originalSaleId !== ''
        ? [{ originalSaleId: cloud.originalSaleId, lines: cloud.lines.map((l) => ({ productId: l.productId, quantityMinor: l.quantityMinor })) }]
        : [];
    }),
  );

  // The SALE operation-identity guard (GAP-SALE-IDEMPOTENCY-01) — the mirror of the returns guard,
  // rebuilt from the durable sale log so the rule holds across a restart: a reused sale id then
  // returns the original outcome (identical payload) or is refused as a conflict (different payload),
  // before anything is written.
  const salesIdempotency = new IdempotencyGuard(
    salesRecords.flatMap((rec) => {
      let id: unknown;
      try { id = (JSON.parse(rec) as { id?: unknown }).id; } catch { return []; }
      return typeof id === 'string' && id !== '' ? [[id, canonicalHash(rec)] as const] : [];
    }),
  );

  // PF-09 step 3: the members' balances as this box last pulled them, and every spend the till made — read back from the sale
  // log, so a reboot with the cable out still knows what this box has already let each member spend.
  const loyaltyWallets = await LoyaltyWallets.open({ dataDir: settings['EDGE_DATA_DIR']!, tenantId, saleRecords: salesRecords });
  // PF-13: the partner counters' agreement terms as this box last pulled them.
  const concessionTrading = await ConcessionTrading.open({ dataDir: settings['EDGE_DATA_DIR']!, tenantId });
  if (loyaltyWallets.heldCopy() !== undefined) say(`loyalty balances as of ${loyaltyWallets.heldCopy()!.feed.generatedAt} restored from disk.`);

  const node = createEdgeNode({
    tenantId,
    log,
    soldHuids,
    signer,
    // The seam. Without it a sale is durable on the disk and never queued, which is exactly how
    // it was: every piece on either side built and tested, nothing joining them, nothing failing.
    outbox,
    // The refund's mirror of that seam, on its own log and its own outbox (M13-FR-01).
    returnsLog,
    returnsOutbox,
    // The completion's mirror of that seam, on its own log and its own outbox (M25-FR-02).
    completionsLog,
    completionsOutbox,
    // The concession tag's mirror of that seam, on its own log and its own outbox (M27-FR-03).
    concessionTagsLog,
    concessionTagsOutbox,
    // The refund's operation-identity guard, rebuilt from the durable log above (RR-F03).
    returnsIdempotency,
    // The refund's entitlement from trusted local sale + return history (RR-F04).
    returnsEntitlement,
    // The sale's operation-identity guard, rebuilt from the durable log above (GAP-SALE-IDEMPOTENCY-01).
    salesIdempotency,
    // Receipt lookup for the refund screen (M13-FR-01). Reads BOTH durable logs live on each call —
    // rare (only when a refund is being taken) and always fresh, so a bill rung earlier in this same
    // session is found, not just those on disk at boot. Read-only; never a network call.
    lookupSale: async (receiptOrId: string) => {
      const sales = (await readLog(log.path)).flatMap((r) => (r.ok ? [r.record] : []));
      const returns = (await readLog(returnsLog.path)).flatMap((r) => (r.ok ? [r.record] : []));
      return buildReceiptLookup(sales, returns)(receiptOrId);
    },
    ...(restoredPack === undefined ? {} : { initialPack: restoredPack }),
    // Which store this box is — stamped on every sale it queues as the stock location (M08-FR-01, Stage D slice 2).
    storeId: storeIdOfThisBox,
    // Which lane this box is — stamped on a sale whose record names none (SP-4b · F09).
    laneId: laneIdOfThisBox,
  });

  // The lane socket. Absent `EDGE_LANE_PORT`, this edge has no screen attached and does the
  // shop-wide work instead — which is what the back-office box is.
  //
  // The manager's day close (M14-FR-04) posts to this socket too, but the authoritative `closeDay` is
  // defined further down (it needs `snapshot()`, the pack and all four outboxes). So the socket is wired
  // now through a late-bound relay and `closeDay` is attached to it once it exists — no reordering of the
  // sale/refund money path above, and a POST that somehow arrives before then gets an honest "starting up".
  const dayCloseRelay: { current?: LaneDayCloseHandler } = {};
  const dayReopenRelay: { current?: LaneDayReopenHandler } = {};
  // The box's own account of its link to head office, for the sync badge on every served screen (design system
  // §1 rule 4). Late-bound like the day close: the agents that know when something last got through are created
  // further down, so the socket is wired now and the answer is filled in once they exist — until then it says
  // "starting", never a guess.
  const queuesNow = (): QueueHealth[] => [outbox, returnsOutbox, completionsOutbox, dayCloseOutbox, concessionTagsOutbox, deviceEventsOutbox, tillCashOutbox]
    .map((q) => ({ unsentCount: q.unsentCount(), deadLetterCount: q.deadLetters().length, lastSuccessAt: null }));
  const syncStatusRelay: { current?: () => LaneSyncStatus } = {};
  // Audit row 6: on the shop's store computer, its own check (store-computer status) rides along with the sync status, so
  // the office screens show its red banner. Read off the sale path, every 30 seconds; never written here.
  const storeComputerFile = settings['EDGE_STORE_COMPUTER_STATUS_FILE'];
  const storeComputer = storeComputerFile === undefined ? undefined : watchStoreComputerStatus({ file: storeComputerFile, read: (f) => readFile(f, 'utf8') });
  if (storeComputer !== undefined) await storeComputer.refresh();
  const syncStatus = (): LaneSyncStatus => {
    const s = syncStatusRelay.current?.()
      ?? laneSyncStatus({ configured: 'starting', queues: queuesNow(), lastPackStatus: undefined, lastContactAt: null, now: new Date().toISOString() });
    // OB-403 "A" · §31.1: the till reads this every 10 s and applies no offer starting after the cut-off while it is held.
    const hold = seriesClockRef.guard?.activationHold();
    const withHold = hold === undefined ? s : { ...s, offerHold: { held: hold.held, cutoffAt: hold.held ? hold.cutoffAt : null } };
    return storeComputer === undefined ? withHold : { ...withHold, storeComputer: storeComputer.current() };
  };

  // ── The till's cash, on the box (SP-4c · F10 · M14-FR-01 · M14-FR-02) ──────────────────────────────────────────
  //
  // The DECISION and the RECORD belong here, not in the till's browser: the box has the disk, survives a reload, and
  // holds the only honest account of what this lane took (its sale log), gave back (its return log) and moved (this cash
  // log). The till sends what a cashier knows; the box adds the lane, the day, the sign and — for the close — every
  // figure but the count. Same durable-write-then-enqueue order as every other seam; its own pipeline carries it up.
  const tillCashRecords = async (): Promise<TillCashRecord[]> =>
    (await readLog(tillCashLog.path)).flatMap((r) => {
      if (!r.ok) return [];
      let parsed: unknown;
      try { parsed = JSON.parse(r.record) as unknown; } catch { return []; }
      const read = readTillCashRecord(parsed);
      return read === undefined ? [] : [read];
    });
  const parsedRecords = async (path: string): Promise<unknown[]> =>
    (await readLog(path)).flatMap((r) => {
      if (!r.ok) return [];
      try { return [JSON.parse(r.record) as unknown]; } catch { return []; }
    });
  /** The pack's cash tolerance, when it names one; `undefined` makes the box apply its default AND say so on the close. */
  const cashToleranceOfPack = (): number | undefined => {
    const t = pack.policies.known ? pack.policies.value.cashVarianceToleranceMinor : undefined;
    return typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 ? t : undefined;
  };
  const refuseCash = (refusedBecause: TillCashRefusal): CashMovementOutcome => ({ committed: false, refusedBecause, laneMessage: TILL_CASH_WORDS[refusedBecause] });
  const refuseClose = (refusedBecause: TillCashRefusal, varianceMinor?: number): ShiftCloseOutcome =>
    ({ closed: false, refusedBecause, laneMessage: TILL_CASH_WORDS[refusedBecause], ...(varianceMinor === undefined ? {} : { varianceMinor }) });

  const recordCashMovement: EdgeProcess['recordCashMovement'] = async (req) => {
    const laneId = laneIdOfThisBox();
    if (laneId === undefined) return refuseCash('no_lane');
    if (Number.isNaN(Date.parse(req.at))) return refuseCash('not_readable');
    const records = await tillCashRecords();
    const prior = records.find((r) => r.kind === 'movement' && r.movementId === req.movementId);
    if (prior !== undefined && prior.kind === 'movement') {
      // A retry after a lost reply: the box already holds it. The same answer, one effect (§31.1).
      const now = foldTillCash(records, laneId);
      return { committed: true, alreadyRecorded: true, movementId: prior.movementId, kind: prior.movementKind, custodian: now.custodian, tradingDay: prior.tradingDay, laneMessage: 'Already recorded.' };
    }
    const state = foldTillCash(records, laneId);
    // The cash the drawer took in trade since the float, so a pickup of the takings is not judged an "overdraw".
    const trade = shiftFigures({ state, laneId, closedAt: req.at, sales: await parsedRecords(log.path), returns: await parsedRecords(returnsLog.path) });
    const decision = decideCashMovement({
      state, request: req, laneId,
      tradingDay: packTradingDay(pack, req.at),
      tradingCashMinor: trade.cashSalesMinor - trade.cashRefundsMinor,
    });
    if (!decision.ok) return refuseCash(decision.refusedBecause);
    // Durable-write-then-enqueue, the same order as every other seam: on the disk before the till hears "recorded".
    const record = JSON.stringify(decision.record);
    const outcome = await commitLocally({ saleId: req.movementId, record, log: tillCashLog });
    if (!outcome.committed) return refuseCash(outcome.refusedBecause === 'no_room_left' ? 'no_room_left' : 'could_not_write_durably');
    const event = tillCashEvent(record, 0);
    if (event !== undefined) tillCashOutbox.enqueue(event);
    return { committed: true, movementId: req.movementId, kind: req.movementKind, custodian: decision.custodianAfter, tradingDay: decision.record.tradingDay, laneMessage: 'Recorded on the store computer.' };
  };

  const closeShift: EdgeProcess['closeShift'] = async (req) => {
    const laneId = laneIdOfThisBox();
    if (laneId === undefined) return refuseClose('no_lane');
    if (Number.isNaN(Date.parse(req.closedAt))) return refuseClose('not_readable');
    const records = await tillCashRecords();
    const prior = records.find((r) => r.kind === 'close' && r.shiftId === req.shiftId);
    if (prior !== undefined && prior.kind === 'close') {
      return {
        closed: true, alreadyClosed: true, shiftId: prior.shiftId, tradingDay: prior.tradingDay, countedMinor: prior.countedMinor,
        varianceMinor: prior.varianceMinor, exceptionRaised: prior.exceptionRaised, reasonCode: prior.reasonCode, laneMessage: 'This shift was already closed.',
      };
    }
    const state = foldTillCash(records, laneId);
    const figures = shiftFigures({ state, laneId, closedAt: req.closedAt, sales: await parsedRecords(log.path), returns: await parsedRecords(returnsLog.path) });
    const decision = decideShiftClose({
      state, request: req, laneId, figures,
      tradingDay: packTradingDay(pack, req.closedAt),
      toleranceMinor: cashToleranceOfPack(),
    });
    if (!decision.ok) return refuseClose(decision.refusedBecause, decision.varianceMinor);
    const record = JSON.stringify(decision.record);
    const outcome = await commitLocally({ saleId: req.shiftId, record, log: tillCashLog });
    if (!outcome.committed) return refuseClose(outcome.refusedBecause === 'no_room_left' ? 'no_room_left' : 'could_not_write_durably');
    const event = tillCashEvent(record, 0);
    if (event !== undefined) tillCashOutbox.enqueue(event);
    const r = decision.record;
    return {
      closed: true, shiftId: r.shiftId, tradingDay: r.tradingDay, countedMinor: r.countedMinor, varianceMinor: r.varianceMinor,
      exceptionRaised: r.exceptionRaised, reasonCode: r.reasonCode,
      laneMessage: r.exceptionRaised ? 'Closed, with a difference the cash office will review.' : 'Closed.',
    };
  };

  const tillCash: EdgeProcess['tillCash'] = async () => {
    const laneId = laneIdOfThisBox();
    if (laneId === undefined) return { tillId: null, laneId: null, custodian: null, openedAt: null, shiftOpen: false };
    const state = foldTillCash(await tillCashRecords(), laneId);
    return { tillId: laneId, laneId, custodian: state.custodian, openedAt: state.openedAt, shiftOpen: state.custodian !== null };
  };

  const lanePort = settings['EDGE_LANE_PORT'];
  // WHO IS AT THE TILL (ADR-0020): the box verifies each cashier's till PIN itself, offline, against the verifiers its
  // administrator issued on this box, and binds every money write to the shift session. The people and their till
  // authority are read from the CURRENT pack at each decision, so a leaver's session ends at their next write.
  const credentialsFile = settings['EDGE_TILL_CREDENTIALS_FILE'] ?? join(settings['EDGE_DATA_DIR']!, 'till-credentials.json');
  const trustForwardedTillUser = settings['EDGE_LANE_TRUST_FORWARDED_USER'] === '1';
  // DF-3-c (OB-30 "A"): the SAME register signs people in on the phones, with the same PIN — so it runs whenever this box
  // has a till OR a phone socket. Only the till's money paths are gated on the lane.
  const staffSignIn = lanePort === undefined && settings['EDGE_DEVICE_PORT'] === undefined ? null : await TillOperators.open({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    key: tillPinKey(settings['PACK_SIGNING_KEY']!),
    credentials: () => loadTillCredentials(credentialsFile),
    pack: {
      people: () => (pack.people.known ? peopleFrom(pack.people.value) : null),
      permissionsOf: (userId) => permissionsOf(userId, pack),
    },
  });
  const tillOperators = lanePort === undefined ? null : staffSignIn;
  // OB-365 (owner, 24–25 Oct 2026, in writing): the till sign-in log goes to head office — so the owner's after-hours and
  // failed-sign-in alerts can fire there. Each record is written to its OWN fsync'd relay log and queued on its OWN outbox,
  // cursor and dead-letter file (like each other queue, so it never mixes with the trading queues, never counts as trading
  // the day still owes and never holds back a day's close), keyed on the record's own id, so it is sent ONCE, offline or
  // not. Never a token's hash, never a PIN (`SignInLogEntry`). Nothing here holds up a sign-in: a record that could not be
  // queued now is queued from the operator register's own log at the next start.
  const signInRelayFiles = staffSignIn === null ? null : {
    log: await openFileLog({ dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']), fileName: 'till-sign-in-relay.log' }),
    dead: await openFileLog({ dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']), fileName: 'dead-letters-till-sign-in' }),
  };
  const signInRelay = signInRelayFiles === null ? null : new SyncPipeline({
    dataDir: settings['EDGE_DATA_DIR']!, log: signInRelayFiles.log, deadLetterLog: signInRelayFiles.dead,
    cursorFile: 'sync-cursor-till-sign-in', noun: 'till sign-in record', say,
    eventFor: (record) => {
      let parsed: unknown;
      try { parsed = JSON.parse(record) as unknown; } catch { return undefined; }
      const key = (parsed as { idempotencyKey?: unknown } | null)?.idempotencyKey;
      const read = readRelayItem({ key, event: parsed });
      return read.ok && read.item.event.type === 'TillSignInLogged' ? read.item.event : undefined;
    },
  });
  if (staffSignIn !== null && signInRelay !== null && signInRelayFiles !== null) {
    const restoredRelay = await signInRelay.restore();
    if (restoredRelay.restoredDeadLetters > 0) say(`  ${restoredRelay.restoredDeadLetters} till sign-in record(s) head office refused earlier are still waiting for a person — kept.`);
    // Every key this relay has EVER taken, from its whole durable log — so a record acknowledged weeks ago is never re-queued.
    const relayed = new Set<string>();
    for (const entry of await readLog(signInRelayFiles.log.path)) {
      if (!entry.ok) continue;
      try { const k = (JSON.parse(entry.record) as { idempotencyKey?: unknown }).idempotencyKey; if (typeof k === 'string') relayed.add(k); } catch { /* not a relay record */ }
    }
    const relaySignIn = async (entry: SignInLogEntry): Promise<void> => {
      const key = `till-sign-in-${tenantId}-${entry.entryId}`;
      if (relayed.has(key)) return;
      const event: DomainEvent = makeEvent({
        id: `till-sign-in-${entry.entryId}`, type: 'TillSignInLogged', occurredAt: entry.at, idempotencyKey: key,
        source: `store-box/${entry.laneId ?? 'box'}`, payload: { ...entry },
      });
      relayed.add(key);
      const outcome = await commitLocally({ saleId: key, record: JSON.stringify(event), log: signInRelayFiles.log });
      if (!outcome.committed) {
        relayed.delete(key);
        say(`a till sign-in record could not be queued for head office (${outcome.refusedBecause ?? 'not written'}) — it stays in this box's own log and is queued again at the next start.`);
        return;
      }
      signInRelay.outbox.enqueue(event);
    };
    let backlog = 0;
    for (const entry of staffSignIn.relayable()) {
      const before = relayed.size;
      await relaySignIn(entry);
      if (relayed.size > before) backlog += 1;
    }
    if (backlog > 0) say(`${backlog} till sign-in record(s) queued for head office from this box's own log.`);
    staffSignIn.onLogged(relaySignIn);
  }
  // A MANAGER'S APPROVAL at the till (ADR-0021): issued here against the manager's own PIN, spent once by the refund it
  // was given for. The threshold is the CURRENT pack's; a box with no service policy treats every refund as needing one.
  const tillApprovals = tillOperators === null ? null : await TillApprovals.open({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    operators: tillOperators,
    approvalThresholdMinor: () => (pack.servicePolicy.known ? pack.servicePolicy.value.approvalThresholdMinor : null),
  });
  // RECEIPT NUMBERS (audit PF-04 · M01-FR-02): issued by this box from the lane's published range (else its own sequence,
  // said aloud), on its disk before the till hears them, and bound to the record that used them. The numbers already on
  // the sales and refunds logs count as used, so a crash between a record and its "used" line frees nothing.
  // A2 · §31.1 · OB-327: the financial year a bill is numbered in is judged by this box's clock — trusted unless the clock
  // check (opened below) has found it far enough out that bills are being flagged (OB-327's 5 minutes, or this store
  // computer's own setting). While it is that far out, a till keeps the year it last numbered in (last-known-good) and
  // moves to the new year's prefix once the clock is back in step. Never blocks a sale (hard rule #1).
  const seriesClockRef: { guard?: ClockGuard } = {};
  const receiptNumbers = tillOperators === null ? null : await ReceiptNumbers.open({
    // OB-403 "A": the same hold as new prices and offers (the clock guard's `activationHold`, from its fsync'd log).
    seriesClock: () => ({ nowIso: new Date().toISOString(), trusted: seriesClockRef.guard?.activationHold().held !== true }),
    // M01-FR-02 (T1): the year a bill is in is its date in the SHOP's zone, from the current signed pack (shop-zone.ts).
    timeZone: () => packTimeZone(pack),
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    // OB-87 "A": the witness log lives OUTSIDE the data folder, so a backup of the data folder never carries it and a
    // restored (older) folder is told apart from an ordinary restart (receipt-numbers.ts header).
    witnessDir: settings['EDGE_WITNESS_DIR'] ?? `${settings['EDGE_DATA_DIR']!.replace(/[\\/]+$/, '')}-witness`,
    published: () => (pack.receiptSeries.known ? pack.receiptSeries.value : null),
    // OB-81 "A" · OB-85 "A": the box's store and how many stores the business has, from the CURRENT pack — so a second store
    // opening moves an unissued till off `R-<lane>-` onto this box's store-coded fallback on the next pull, without a restart;
    // a pack that does not say (a file, first boot) is never read as one store (edge/store-edge/src/receipt-numbers.ts).
    numbering: () => ({
      storeId: storeIdOfThisBox() ?? headOfficeStoreId ?? null,
      storesInBusiness: pack.receiptNumbering?.known === true && Number.isSafeInteger(pack.receiptNumbering.value.storesInBusiness) ? pack.receiptNumbering.value.storesInBusiness : null,
      // OB-85 · verifier r17: the R-<lane>- history head office banked for this store (a replaced box resumes above it).
      boxSeriesBankedThrough: pack.receiptNumbering?.known === true && pack.receiptNumbering.value.boxSeriesBankedThrough !== null && typeof pack.receiptNumbering.value.boxSeriesBankedThrough === 'object' ? pack.receiptNumbering.value.boxSeriesBankedThrough : null,
    }),
    committed: [
      ...(await readLog(log.path)).flatMap((r) => {
        if (!r.ok) return [];
        try { const x = JSON.parse(r.record) as { id?: unknown; receiptNumber?: unknown; number?: unknown }; const n = x.receiptNumber ?? x.number; return typeof n === 'string' && typeof x.id === 'string' ? [{ receiptNumber: n, recordId: x.id }] : []; } catch { return []; }
      }),
      ...(await readLog(returnsLog.path)).flatMap((r) => {
        if (!r.ok) return [];
        try { const x = JSON.parse(r.record) as { returnId?: unknown; id?: unknown; number?: unknown }; const id = typeof x.returnId === 'string' ? x.returnId : x.id; return typeof x.number === 'string' && typeof id === 'string' ? [{ receiptNumber: x.number, recordId: id }] : []; } catch { return []; }
      }),
    ],
  });
  // Verifier r19 OB87-1/OB87-2 — THE WITNESS SELF-CHECK, said out loud at start: a witness folder that cannot be opened (a
  // read-only root with no witness volume), one inside the data folder, or one shared with another store computer is a
  // fault the owner must see — the box still never repeats a bill number (every start is then a possible restore), but it
  // is never a silent new prefix each boot. The same words are on the status read and the health report to head office.
  if (receiptNumbers !== null) {
    const wh = await receiptNumbers.witnessHealth();
    if (wh.witness === 'unavailable' || wh.sharedWith.length > 0 || wh.fault !== undefined) say(`!!! ${wh.says}`);
  }
  // HELD BASKETS (audit PF-05 · M12-FR-02): parked on this box's disk, recalled once, never deleted. The shop's hold
  // policy is the CURRENT pack's; the store is the pack's own.
  const heldBills = tillOperators === null ? null : await HeldBills.open({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']), tenantId,
    policy: () => (pack.suspensionPolicy.known ? pack.suspensionPolicy.value : null),
    storeId: () => (pack.policies.known ? pack.policies.value.storeId : 'this-store'),
    tradingDayOf: (iso) => packTradingDay(pack, iso), // R1a: the shop's zone and cut-off, from the pack
  });
  // CARD AND UPI ATTEMPTS (audit PF-06): recorded before the machine is asked; a no-answer settles only against the
  // provider's record — through the provider port, which no live provider fills yet.
  const payments = tillOperators === null ? null : await PaymentAttempts.open({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    ...(ports.paymentProvider === undefined ? {} : { provider: ports.paymentProvider }),
    // OB-271 · audit A9: in real trading an approved card/UPI payment carries the machine's approval / reference number.
    requireMachineRef: () => realTrading().on,
  });
  // D04-FR-05: what the till's devices last said, kept on this box's disk for the manager's Today screen.
  const peripheralReports = tillOperators === null ? null : await PeripheralReports.open({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
  });
  if (tillOperators !== null) {
    say(trustForwardedTillUser
      ? 'till sign-in: the person the hosted sign-in names (EDGE_LANE_TRUST_FORWARDED_USER) — only right behind the hosted front.'
      : `till sign-in: staff ID and till PIN, checked on this box (${tillOperators.live().length} session(s) still open).`);
  }
  // OB-55 "A": a payment the day close CARRIED FORWARD to head office is settled later by the provider's record (the till's
  // Check payment button) — and that answer is relayed to head office ONCE, on the day-close log (durable first, then
  // queued; re-minted on a restart), so the finance exception it raised is resolved there. A payment not carried forward
  // is recovered exactly as before.
  // OB-69 "A": a no-answer RAISED to head office the moment it was recorded is an open finance item there too — its provider
  // answer is relayed the same way (once), whether or not a day close has carried it yet.
  const carriedOnBox = async (): Promise<Map<string, { dayCloseId: string | null; resolved: boolean; carried: boolean }>> => {
    const out = new Map<string, { dayCloseId: string | null; resolved: boolean; carried: boolean }>();
    for (const entry of await readLog(dayCloseLog.path)) {
      if (entry.ok !== true) continue;
      let p: Record<string, unknown>;
      try { p = JSON.parse(entry.record) as Record<string, unknown>; } catch { continue; }
      const raisedId = p['noAnswerAttemptId'];
      if (typeof raisedId === 'string' && !out.has(raisedId)) out.set(raisedId, { dayCloseId: null, resolved: false, carried: false });
      const cf = p['carriedForward'] as { payments?: { attemptId?: unknown }[] } | undefined;
      const dc = p['dayCloseId'];
      if (cf !== undefined && Array.isArray(cf.payments) && typeof dc === 'string') {
        for (const x of cf.payments) {
          if (typeof x.attemptId !== 'string') continue;
          const c = out.get(x.attemptId);
          if (c === undefined) out.set(x.attemptId, { dayCloseId: dc, resolved: false, carried: true });
          else if (!c.carried) { c.dayCloseId = dc; c.carried = true; }
        }
      }
      const r = p['resolvedAttemptId'];
      if (typeof r === 'string') { const c = out.get(r); if (c !== undefined) c.resolved = true; }
    }
    return out;
  };
  /**
   * OB-69 "A" (owner, 11 Oct 2026, "The moment it happens"): the till recorded the machine's NO ANSWER on this attempt —
   * relay it to head office NOW as an open finance item: durable on the day-close log first, then queued (sent at once when
   * the line is up, on reconnect when it is not; re-minted on a restart). Once per attempt.
   */
  const raiseNoAnswer = async (a: { readonly attemptId: string; readonly laneId: string; readonly billRef: string; readonly kind: string; readonly amountMinor: number; readonly askedAt: string; readonly answeredBy?: string; readonly answeredAt?: string; readonly askedBy: string }): Promise<void> => {
    if ((await carriedOnBox()).has(a.attemptId)) return;
    const record = JSON.stringify({
      noAnswerAttemptId: a.attemptId, attemptId: a.attemptId, laneId: a.laneId, billRef: a.billRef, kind: a.kind, amountMinor: a.amountMinor, askedAt: a.askedAt,
      tradingDay: packTradingDay(pack, a.askedAt), recordedAt: a.answeredAt ?? new Date().toISOString(), recordedBy: a.answeredBy ?? a.askedBy, storeId: storeIdOfThisBox(),
    });
    await dayCloseLog.append(record);
    const event = dayCloseEventFrom(record, 0);
    if (event !== undefined) dayCloseOutbox.enqueue(event);
  };
  // A no-answer recorded before this box relayed them (or whose relay write failed) is raised when the box starts.
  if (payments !== null) {
    for (const a of payments.pending()) {
      if (a.state !== 'no_answer') continue;
      try { await raiseNoAnswer(a); } catch (e) { say(`could not queue the no-answer on ${a.attemptId} for head office: ${e instanceof Error ? e.message : String(e)} — it stays on the till's unresolved list`); }
    }
  }
  const recoverCarrying = async (pa: PaymentAttempts, i: { readonly laneId: string; readonly attemptId: unknown }): ReturnType<PaymentAttempts['recover']> => {
    const id = typeof i.attemptId === 'string' ? i.attemptId : '';
    const known = (await carriedOnBox()).get(id);
    const carried = known?.carried === true ? known : undefined;
    const out = await pa.recover({ ...i, ...(carried === undefined ? {} : { allowAsked: true }) });
    if (known !== undefined && !known.resolved && out.ok && (out.attempt.state === 'recovered_paid' || out.attempt.state === 'recovered_not_paid')) {
      const a = out.attempt;
      const record = JSON.stringify({
        resolvedAttemptId: a.attemptId, attemptId: a.attemptId, ...(known.dayCloseId === null ? {} : { dayCloseId: known.dayCloseId }), storeId: storeIdOfThisBox(),
        paid: a.state === 'recovered_paid', owedToCustomerMinor: a.owedToCustomerMinor ?? 0, amountMinor: a.amountMinor,
        detail: a.recoveryDetail ?? '', resolvedAt: a.recoveredAt ?? new Date().toISOString(),
      });
      await dayCloseLog.append(record);
      const event = dayCloseEventFrom(record, 0);
      if (event !== undefined) dayCloseOutbox.enqueue(event);
    }
    return out;
  };
  // OB-55 / PF-06 (P-04): the machine's answer typed in for a card/UPI attempt of an EARLIER trading day lifts the day-close
  // hold, so it is not one cashier's act: it needs a manager's one-use approval at this till for exactly that attempt and
  // amount (spent here), and it is relayed to head office as a person's answer — never mistaken for the provider's. An
  // answer on the same trading day keeps today's flow.
  const answerGuarded = async (pa: PaymentAttempts, i: { readonly laneId: string; readonly by: string; readonly attemptId: unknown; readonly outcome: unknown; readonly approvalId?: string; readonly machineRef?: unknown }): ReturnType<PaymentAttempts['answer']> => {
    const a = pa.get(i.attemptId);
    const rule = packCutoff(pack);
    const late = a !== undefined && a.state === 'asked' && a.laneId === i.laneId && (i.outcome === 'approved' || i.outcome === 'declined')
      && packTradingDay(pack, a.askedAt, rule) < packTradingDay(pack, new Date().toISOString(), rule);
    if (!late || a === undefined) return pa.answer(i);
    if (tillApprovals === null) return { ok: false, refusedBecause: 'approval_required', laneMessage: 'This payment was asked on an earlier day. Its answer needs a manager\'s approval, and this store computer cannot take one. Nothing was recorded.', attempt: a };
    const spent = await tillApprovals.spendOverride({ approvalId: i.approvalId, kind: 'late_payment_answer', billRef: a.attemptId, valueMinor: a.amountMinor, requestedBy: i.by, laneId: i.laneId, activityId: `late-answer:${a.attemptId}` });
    if (!spent.ok) return { ok: false, refusedBecause: spent.refusedBecause, laneMessage: `This payment was asked on an earlier trading day, so the machine's answer needs a manager's approval for it. ${spent.laneMessage}`, attempt: a };
    const out = await pa.answer(i);
    if (out.ok && out.attempt.state === i.outcome) {
      const record = JSON.stringify({
        lateAnswerAttemptId: a.attemptId, attemptId: a.attemptId, laneId: a.laneId, billRef: a.billRef, kind: a.kind, amountMinor: a.amountMinor,
        askedAt: a.askedAt, tradingDay: packTradingDay(pack, a.askedAt, rule), outcome: i.outcome, answeredBy: i.by,
        approvedBy: spent.stamp!.approvedBy, approvalId: spent.stamp!.approvalId, answeredAt: out.attempt.answeredAt ?? new Date().toISOString(), storeId: storeIdOfThisBox(),
      });
      await dayCloseLog.append(record);
      const event = dayCloseEventFrom(record, 0);
      if (event !== undefined) dayCloseOutbox.enqueue(event);
    }
    return out;
  };
  // OB-259: on the store PC the office screens ask for the person's own till PIN (edge/store-edge/src/office-sign-in.ts) —
  // and so do the lane socket's office doors (the day close, a reopen, the office screens' decisions), with the same gate.
  // Behind the hosted front's own sign-in (EDGE_SCREEN_TRUST_FORWARDED_USER) the front decides instead.
  const officeGate = settings['EDGE_SCREEN_PORT'] === undefined || settings['EDGE_OFFICE_SIGN_IN'] !== 'pin' || settings['EDGE_SCREEN_TRUST_FORWARDED_USER'] === '1' ? null : await openOfficeGate({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']), pins: staffSignIn, pack: () => pack,
  });
  // B6 · B14 · B19: the till's legal gates, judged for one lane's scales (this box's till, or a queue handheld's lane).
  const tillRulesFor = (laneId: string | undefined): { check(record: Record<string, unknown>): ReturnType<typeof checkTillRules> } => ({
    check: (record) => {
      const now = new Date().toISOString();
      return checkTillRules(record, {
        products: gateProductsOf(pack, node.pack(), now),
        scales: laneScalesFor(pack, laneId),
        today: packCalendarDate(pack, now),
        soldHuids: soldHuids.asSet(),
        // OB-348 (B17): liquor is judged by the shop's state, as this box's store pack names it.
        ...((st) => (st === undefined ? {} : { shopState: st }))(shopStateOf(pack)),
      });
    },
  });
  // D04-FR-05 (OB-316): is queue-busting on for this box's lane — and may its handhelds take money? From the signed pack.
  const queuePosSwitches = (): QueuePosSwitches => {
    const laneId = laneIdOfThisBox();
    const r = laneRollout(pack.rollout?.known === true ? pack.rollout.value : undefined, laneId);
    const on = laneSwitchOn(r, QUEUE_BUSTING_SWITCH);
    return { laneId: laneId ?? null, known: r.known, why: r.known ? null : r.why, queueBusting: on, payments: on && laneSwitchOn(r, MOBILE_POS_PAYMENT_SWITCH) };
  };
  // D04-FR-05: the baskets queue handhelds hand to this box, recalled once at its till — only where this box is a till.
  const queueBaskets = tillOperators === null ? null : await QueueBaskets.open({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
  });
  if (queueBaskets !== null && queueBaskets.unreadableRecords > 0) say(`${queueBaskets.unreadableRecords} queue-basket record(s) could not be read whole — kept, not repaired. Raise this.`);
  // OB-373: a copy of a bill by its number — any bill on this box's disk (a handheld queue till's above all), for the person
  // signed in at the till; the copy's record is kept on the device-events log before the bill is answered, then relayed.
  const recordBillCopy = billCopyRecorder({
    tenantId, keys: deviceEventKeys, log: deviceEventsLog, outbox: deviceEventsOutbox, now: () => new Date().toISOString(),
    tradingDayOf: (at) => packTradingDay(pack, at),
    findSale: async (numberOrId) => saleIn((await readLog(log.path)).flatMap((r) => (r.ok ? [r.record] : [])), numberOrId),
    priorCopies: async () => priorCopiesIn((await readLog(deviceEventsLog.path)).flatMap((r) => (r.ok ? [r.record] : []))),
    productName: (productId) => {
      const own = pack.products.known ? pack.products.value.find((p) => p.productId === productId) : undefined;
      if (own !== undefined) return { name: own.name, ...(own.nameTa === undefined ? {} : { nameTa: own.nameTa }) };
      const signed = node.pack()?.snapshot.products.find((p) => p.productId === productId);
      return signed === undefined ? undefined : { name: signed.name };
    },
  });
  const laneInputs: Omit<Parameters<typeof startLaneServer>[0], 'port'> = {
    node,
    syncStatus,
    billCopies: recordBillCopy,
    // OB-259 completeness: the office doors need the office sign-in and its permission, and are done AS that person.
    ...(officeGate === null ? {} : {
      officeScreens: {
        check: (token) => officeGate.check(token),
        permissionsOf: (userId) => permissionsOf(userId, pack),
        noteRefusedAct: (i) => officeGate.noteRefusedAct(i),
      },
    }),
    ...(tillOperators === null ? {} : {
      operators: {
        laneId: laneIdOfThisBox() ?? '',
        trustForwardedUser: trustForwardedTillUser,
        signIn: (i) => tillOperators.signIn(i),
        signInVerified: (i) => tillOperators.signInVerified(i),
        check: (token, laneId) => tillOperators.check(token, laneId),
        signOut: (token) => tillOperators.signOut(token),
        // The box's seal on who it verified (ADR-0023), under its own key and this box's tenant.
        seal: (subject) => sealTillFact(sealKey, { ...subject, tenantId }),
      },
    }),
    ...(peripheralReports === null ? {} : { peripherals: { report: (i) => peripheralReports.report(i) } }),
    ...(payments === null ? {} : {
      payments: {
        ask: (i) => payments.ask(i),
        // OB-69: a NO ANSWER is relayed to head office the moment it is recorded (durable, queued, once). The till's answer
        // stands either way: a relay that cannot be queued now is raised again when the box starts (never lost).
        answer: async (i) => {
          const out = await answerGuarded(payments, i);
          if (out.ok && out.attempt.state === 'no_answer') {
            try { await raiseNoAnswer(out.attempt); } catch (e) { say(`could not queue the no-answer on ${out.attempt.attemptId} for head office: ${e instanceof Error ? e.message : String(e)} — raised again at the next start`); }
          }
          return out;
        },
        recover: (i) => recoverCarrying(payments, i),
        checkTenders: (i) => payments.checkTenders(i),
        // OB-271 · audit A9 / A11: today's paid card/UPI payments with the machine's numbers, and the card refunds done on the
        // machine — the till's list for matching the day against the machine's settlement slip.
        status: (laneId) => {
          const rule = packCutoff(pack);
          const today = packTradingDay(pack, new Date().toISOString(), rule);
          const onToday = (at: unknown): boolean => typeof at === 'string' && packTradingDay(pack, at, rule) === today;
          const s = payments.status(laneId);
          return {
            ...s, tradingDay: today, paid: payments.paid(laneId).filter((a) => onToday(a.askedAt)),
            refundsOnMachine: cardRefundsOnMachine.filter((r) => r['laneId'] === laneId && onToday(r['at'])).map((r) => ({
              returnId: r['billRef'], refundTender: r['refundTender'], refundMinor: r['valueMinor'], machineRef: r['machineRef'], at: r['at'], by: r['cashierId'], approvedBy: r['approvedBy'],
            })),
          };
        },
      },
    }),
    // OB-350: scan-and-go baskets from head office, under this box's own credential — only when a cloud is configured.
    ...(settings['CLOUD_API_URL'] === undefined || settings['CLOUD_API_TOKEN'] === undefined ? {} : {
      phoneBaskets: httpPhoneBaskets({ baseUrl: settings['CLOUD_API_URL'], token: settings['CLOUD_API_TOKEN'], fetch: globalThis.fetch.bind(globalThis) }),
    }),
    // D04-FR-05: a basket a queue handheld handed to this box, brought up here by its code — while the switch is on.
    ...(queueBaskets === null ? {} : {
      queueBaskets: {
        recall: (i) => (queuePosSwitches().queueBusting
          ? queueBaskets.recall(i)
          : Promise.resolve({ recalled: false as const, refusedBecause: 'queue_busting_off', laneMessage: 'Queue-busting is switched off for this till (pos.queue_busting). Scan the items as usual.' })),
      },
    }),
    ...(heldBills === null ? {} : {
      heldBills: {
        hold: (i) => heldBills.hold(i),
        list: (laneId) => heldBills.list(laneId),
        recall: (i) => heldBills.recall(i),
        abandon: (i) => heldBills.abandon(i),
      },
    }),
    ...(receiptNumbers === null ? {} : {
      receiptNumbers: {
        issue: (i) => receiptNumbers.issue(i),
        checkUse: (i) => receiptNumbers.checkUse(i),
        status: (laneId) => receiptNumbers.status(laneId),
      },
    }),
    ...(tillApprovals === null ? {} : {
      approvals: {
        grant: (i) => tillApprovals.grant(i),
        checkReturn: (i) => tillApprovals.checkReturn(i),
      },
    }),
    // The till's cash lives on this box (SP-4c · F10): the float, the pickups and the close come in here, durably.
    recordCashMovement,
    closeShift,
    tillCash,
    // The shared device → box leg (SP-2a): the manager screen's decisions arrive here, durably, before anything
    // is told "accepted"; the handhelds join on the same route in SP-3.
    relayDeviceEvents,
    deviceEventStatus,
    recordTillActivity,
    // PF-09 step 2: the cashier's keyed mobile number becomes the loyalty member code HERE, before the disk (P-04).
    memberCode: (mobile: string) => memberRefFor(loyaltyKey, mobile),
    // OB-252: while guest sales only is on, no customer reaches this box's disk and no loyalty is spent.
    guestSalesOnly: () => guestSalesOnly().on,
    // OB-256 · OB-258: while the mirror pilot is on, "Paid on old system" is the only tender, for sales and refunds.
    mirrorPilot: () => mirrorPilot().on,
    // OB-271: while real trading is on, a sale is kept only when its bill is a complete tax invoice (never with the mirror).
    realTrading: () => realTrading().on,
    taxInvoice: taxInvoiceIdentity,
    // OB-264: every mirror sale's old ERP bill number, never keyed twice; a mirror refund looks its sale up by it.
    oldErpBills,
    // PF-09 step 3: a sale paying with points or store credit is decided against this box's copy, one at a time.
    loyalty: {
      check: (record) => loyaltyWallets.check(record),
      note: (spends) => { loyaltyWallets.note(spends); },
      serialise: (fn) => loyaltyWallets.serialise(fn),
      availability: (memberRef, tradingDay) => loyaltyWallets.availability(memberRef, tradingDay),
    },
    // PF-13: a new partner-counter sale line is decided by the box's own trading day, for the store this box is.
    concessionTrading: {
      check: (record) => concessionTrading.check(
        record,
        packTradingDay(pack, new Date().toISOString()),
        (pack.policies.known ? pack.policies.value.branchId : undefined) ?? undefined,
      ),
    },
    // B6 · B14 · B19: the till's legal gates again, before the disk — from this box's own catalogue and this lane's scales.
    tillRules: tillRulesFor(laneIdOfThisBox()),
    // OB-301 (M15-FR-03): a staff member's own shopping, judged from this box's store pack, before the disk.
    staffPurchases: { check: (record, lane) => checkStaffPurchase(record, lane, packStaffPurchaseOf(pack.policies.known ? pack.policies.value : undefined)) },
    closeDay: (req) => {
      const fn = dayCloseRelay.current;
      return fn !== undefined ? fn(req) : Promise.resolve({ closed: false as const, reason: 'the box is still starting up — try the day close again in a moment' });
    },
    reopenDay: (req) => {
      const fn = dayReopenRelay.current;
      return fn !== undefined ? fn(req) : Promise.resolve({ reopened: false as const, reason: 'the box is still starting up — try the reopen again in a moment' });
    },
  };
  const lane = lanePort === undefined ? null : await startLaneServer({ ...laneInputs, port: Number(lanePort) });
  // D04-FR-05 (OB-288 Pkg 6b): each queue handheld's OWN lane pipeline (`device:<id>`) — the till's tested route for a card or
  // UPI sale, on loopback, started on first use. Only what a queue till needs: no cash, refunds, approvals, holds or day close.
  const queuePosLanes = new Map<string, Promise<LaneServer>>();
  const queuePosLaneFor = async (deviceId: string): Promise<{ readonly host: string; readonly port: number } | null> => {
    if (tillOperators === null || lanePort === undefined) return null;
    let started = queuePosLanes.get(deviceId);
    if (started === undefined) {
      const handheldLane = deviceLaneOf(deviceId);
      const ops = tillOperators;
      started = startLaneServer({
        node, port: 0, syncStatus,
        operators: {
          laneId: handheldLane,
          trustForwardedUser: false,
          signIn: () => Promise.resolve({ signedIn: false as const, refusedBecause: 'not_readable' as const, laneMessage: 'Sign in on the handheld\'s own queue-till page.' }),
          signInVerified: () => Promise.resolve({ signedIn: false as const, refusedBecause: 'not_readable' as const, laneMessage: 'Sign in on the handheld\'s own queue-till page.' }),
          // Only a sign-in opened for SELLING on this phone rings a sale here — a warehouse or picker sign-in never does.
          check: (token, laneId) => {
            const c = ops.check(token, laneId);
            return c.ok && c.authority !== TILL_AUTHORITY
              ? { ok: false as const, refusedBecause: 'operator_lost_till_authority' as const, laneMessage: 'This handheld sign-in is not for the queue till. Sign in on the queue-till page. Nothing was saved.' }
              : c;
          },
          signOut: (token) => ops.signOut(token),
          seal: (subject) => sealTillFact(sealKey, { ...subject, tenantId }),
        },
        ...(laneInputs.payments === undefined ? {} : { payments: laneInputs.payments }),
        ...(laneInputs.receiptNumbers === undefined ? {} : { receiptNumbers: laneInputs.receiptNumbers }),
        ...(laneInputs.recordTillActivity === undefined ? {} : { recordTillActivity: laneInputs.recordTillActivity }),
        ...(laneInputs.memberCode === undefined ? {} : { memberCode: laneInputs.memberCode }),
        ...(laneInputs.loyalty === undefined ? {} : { loyalty: laneInputs.loyalty }),
        ...(laneInputs.guestSalesOnly === undefined ? {} : { guestSalesOnly: laneInputs.guestSalesOnly }),
        ...(laneInputs.mirrorPilot === undefined ? {} : { mirrorPilot: laneInputs.mirrorPilot }),
        ...(laneInputs.realTrading === undefined ? {} : { realTrading: laneInputs.realTrading }),
        ...(laneInputs.taxInvoice === undefined ? {} : { taxInvoice: laneInputs.taxInvoice }),
        ...(laneInputs.oldErpBills === undefined ? {} : { oldErpBills: laneInputs.oldErpBills }),
        ...(laneInputs.staffPurchases === undefined ? {} : { staffPurchases: laneInputs.staffPurchases }),
        // The legal gates again, before the disk — for the handheld's lane, which has no scale of its own.
        tillRules: tillRulesFor(handheldLane),
      });
      queuePosLanes.set(deviceId, started);
      started.catch(() => { queuePosLanes.delete(deviceId); });
    }
    const server = await started;
    return { host: LANE_HOST, port: server.port };
  };
  const stopQueuePosLanes = async (): Promise<void> => {
    for (const started of queuePosLanes.values()) { try { await (await started).stop(); } catch { /* it never started */ } }
    queuePosLanes.clear();
  };
  if (lane !== null) say(`lane socket on ${LANE_HOST}:${lane.port} — loopback only, nothing on the shop network can reach it`);


  // The cloud's migration register as this box last pulled it (C3b), restored from disk and laid over the
  // pack's migration sections — so a reboot with the cable out still shows the register as it stood, with
  // the cloud's own clock on it (P-01, P-08). Nothing restored means the screen says so.
  let heldFeed: HeldMigrationFeed | undefined = await readHeldMigrationFeed(settings['EDGE_DATA_DIR']!, tenantId);
  if (heldFeed !== undefined) {
    pack = withMigrationFeed(pack, heldFeed.feed, heldFeed.receivedAt);
    say(`migration register as of ${heldFeed.feed.generatedAt} restored from disk — the last one this box pulled.`);
  }

  // Head office's open floor indents as this box last pulled them (SP-8c), restored from disk and laid into the pack — so
  // a reboot with the cable out still gives the warehouse handheld what the back store owes, under the cloud's own clock.
  let heldIndents: HeldIndentsFeed | undefined = await readHeldIndentsFeed(settings['EDGE_DATA_DIR']!, tenantId);
  if (heldIndents !== undefined) {
    pack = withIndentsFeed(pack, heldIndents.feed, heldIndents.receivedAt);
    say(`floor indents as of ${heldIndents.feed.asAt} restored from disk — the last register this box pulled.`);
  }

  // OB-288 lane 2 · P2: the production board and recipes, the food-safety checks and the transfers this box last pulled,
  // restored from disk — so a reboot with the cable out still gives the counter, the chiller and the back door their work.
  let workFeeds: HeldWorkFeeds = await readHeldWorkFeeds(settings['EDGE_DATA_DIR']!, tenantId);
  for (const name of WORK_FEED_NAMES) {
    const h = workFeeds[name];
    if (h !== undefined) say(`${name} work as of ${h.feed.asAt} restored from disk — the last one this box pulled.`);
  }
  // §31.1 · OB-327: the clock check — a warning at 2 minutes from head office's clock, bills flagged at 5 (both changeable
  // in this store computer's settings). Its log is restored, so a bill taken while the clock was out stays flagged.
  const clockSetting = readClockThresholds(settings['EDGE_CLOCK_WARN_SECONDS'], settings['EDGE_CLOCK_FLAG_SECONDS']);
  if (clockSetting.problem !== undefined) say(clockSetting.problem);
  const clockGuard = await ClockGuard.open(clockSetting.thresholds, settings['EDGE_DATA_DIR']!);
  seriesClockRef.guard = clockGuard; // A2: the bill series' year switch now follows the clock check
  /** OB-403 "A" · §31.1: what this box holds while its clock is 5+ minutes out — the offers and prices due, by name. */
  const activationHoldNow = (now: string): ActivationHoldReport => activationHoldReport({
    hold: clockGuard.activationHold(), pack, now, tradingDay: packTradingDay(pack, now),
    promotions: node.pack()?.snapshot.promotions ?? [],
    priceEntries: pack.priceEntries.known ? pack.priceEntries.value : [],
  });
  /** OB-333: the quality-hold releases this box's facilities screen took and still holds (the device-events queue). */
  const boxQualityReleases = (): readonly { batchId: string; releasedBy: string; at: string; state: string; reason: string | null }[] => deviceEventsOutbox.all()
    .filter((i) => i.event.type === 'QualityHoldReleaseDecided')
    .flatMap((i) => {
      const p = i.event.payload as Record<string, unknown>;
      return typeof p['batchId'] === 'string' && typeof p['releasedBy'] === 'string' && typeof p['at'] === 'string'
        ? [{ batchId: p['batchId'], releasedBy: p['releasedBy'], at: p['at'], state: String(i.state), reason: i.reason }] : [];
    });
  /** The production runs this box's screen captured and still holds (the device-events queue) — labelled before head office has them. */
  const boxCapturedRuns = (): readonly BoxCapturedRun[] => deviceEventsOutbox.all()
    .filter((i) => i.event.type === 'ProductionRunCaptured')
    .flatMap((i) => {
      const p = i.event.payload as Record<string, unknown>;
      return typeof p['runId'] === 'string' && typeof p['recipeId'] === 'string' && typeof p['outputBatchId'] === 'string' && typeof p['at'] === 'string'
        ? [{ runId: p['runId'], recipeId: p['recipeId'], outputBatchId: p['outputBatchId'], actualOutputMinor: Number(p['actualOutputMinor'] ?? 0), producedBy: String(p['producedBy'] ?? ''), at: p['at'] }]
        : [];
    });

  // Head office's open wave / route assignments as this box last pulled them (HA-1), restored from disk and laid into the
  // pack — so a reboot with the cable out still gives the picker and the driver their work, under the cloud's own clock.
  let heldAssignments: HeldAssignmentsFeed | undefined = await readHeldAssignmentsFeed(settings['EDGE_DATA_DIR']!, tenantId);
  if (heldAssignments !== undefined) {
    pack = withAssignmentsFeed(pack, heldAssignments.feed, heldAssignments.receivedAt);
    say(`assignments as of ${heldAssignments.feed.asAt} restored from disk — ${heldAssignments.feed.waves.length} wave(s), ${heldAssignments.feed.routes.length} route(s).`);
  }

  // The document templates in force as this box last pulled them (M01-FR-02), restored from disk and laid into the
  // pack — so a reboot with the cable out still prints the receipt header head office published, under its
  // version (P-01, P-08). Nothing restored means the till prints with its defaults and stamps no version.
  let heldTemplates: HeldPublishedTemplates | undefined = await readHeldPublishedTemplates(settings['EDGE_DATA_DIR']!, tenantId);
  if (heldTemplates !== undefined) {
    pack = withPublishedTemplates(pack, heldTemplates.feed, heldTemplates.receivedAt);
    const receipt = heldTemplates.feed.templates.find((t) => t.kind === 'receipt');
    say(`document templates as of ${heldTemplates.feed.generatedAt} restored from disk${receipt === undefined ? ' — nothing published for receipts' : ` — receipts print with template v${receipt.version}`}.`);
  }

  // OB-263: the evening check from the old ERP's item-wise and bill-wise files — kept and judged on THIS box, offline, and
  // each decision relayed to head office as a parallel-run day (sealed for the person this box verified, like the device
  // relay above). Read only when the office screen asks; never on the sale path.
  const eveningCheckBox = await openEveningCheckBox({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    sources: {
      tenantId,
      cutoverId: () => (pack.migrationPolicy.known ? pack.migrationPolicy.value.cutoverId : undefined),
      reconcilerUserId: () => (pack.migrationPolicy.known ? pack.migrationPolicy.value.dailyReconcilerUserId : undefined),
      department: () => (pack.migrationPolicy.known ? pack.migrationPolicy.value.pilotDepartment : undefined),
      catalogue: () => tillCatalogue(pack, node.pack(), new Date().toISOString())?.products.map((p) => ({
        productId: p.productId, name: p.name, barcodes: p.barcodes.map((b) => b.code), uom: p.uom,
        ...(p.categoryId === undefined ? {} : { categoryId: p.categoryId }), ...(p.taxBps === undefined ? {} : { taxBps: p.taxBps }),
      })),
      records: async () => ({ sales: await parsedRecords(log.path), refunds: await parsedRecords(returnsLog.path) }),
      tradingDayOf: (iso) => packTradingDay(pack, iso),
      relay: async (event, by, via = 'office_pin') => {
        const sealed = withDeciderSeal(sealKey, tenantId, event, { userId: by, via, laneId: OFFICE_LANE });
        if (deviceEventKeys.has(sealed.idempotencyKey)) return { queued: true, detail: 'already queued' };
        deviceEventKeys.add(sealed.idempotencyKey);
        const outcome = await commitLocally({ saleId: sealed.idempotencyKey, record: JSON.stringify(sealed), log: deviceEventsLog });
        if (!outcome.committed) { deviceEventKeys.delete(sealed.idempotencyKey); return { queued: false, detail: outcome.detail }; }
        deviceEventsOutbox.enqueue(sealed);
        return { queued: true };
      },
    },
  });
  if (eveningCheckBox.unreadableRecords > 0) say(`evening check: ${eveningCheckBox.unreadableRecords} record(s) could not be read whole — kept, not repaired. Raise this.`);

  /**
   * OB-271 · audit A9: the box's card/UPI day — every till's payments recorded as paid today (approved, or confirmed by the
   * provider), those still with no answer, and the card/UPI refunds done on the machine today — by the shop's own trading
   * day (the pack's cut-off), the same day the till's own list uses.
   */
  const cardDayOf = (pa: PaymentAttempts, nowIso: string): NonNullable<ScreenInput['cardPayments']> => {
    const rule = packCutoff(pack);
    const today = packTradingDay(pack, nowIso, rule);
    const onToday = (at: unknown): boolean => typeof at === 'string' && packTradingDay(pack, at, rule) === today;
    const lanes = [...new Set(pa.all().map((a) => a.laneId))];
    return {
      tradingDay: today,
      paid: lanes.flatMap((l) => pa.paid(l)).filter((a) => onToday(a.askedAt)),
      unresolved: pa.pending().filter((a) => onToday(a.askedAt)),
      refundsOnMachine: cardRefundsOnMachine.filter((r) => onToday(r['at'])),
    };
  };

  // OB-392: the box's last send to head office, for the manager's lane cards — set once the drains exist (a box with no
  // head office configured has none, and its cards say the link is not known).
  const laneLinkRelay: { current: (() => { readonly lastSentAt: string | null }) | undefined } = { current: undefined };
  // The screens socket. Built from the CURRENT state on every request, so a screen reloaded at
  // four o'clock shows four o'clock's exceptions rather than the ones this process saw at boot.
  const snapshot = (): ScreenInput => {
    const now = new Date().toISOString();
    // Fire-and-forget: the next request sees the newly-read records. Awaiting a disk read inside
    // a page request would put a file read on the path a manager waits on, and the day moves by
    // seconds rather than milliseconds.
    void reread();
    // The signed catalogue pack this box is trading on — the source of the pack-age badge every
    // screen shows (SYNC-01). Absent until the first pull (or restore) lands, which the badge states
    // honestly rather than hiding.
    const heldCatalogue = node.pack();
    return {
      pack,
      sales: recordsNow.sales,
      unreadableRecords: recordsNow.unreadable,
      outbox,
      now,
      // The shop's own wall clock, not UTC: dated in UTC, a Tamil Nadu shop was on the wrong day for five and a half
      // hours after midnight UTC (SP-4b). The till dates each sale by the same rule at the moment it is taken.
      tradingDay: packTradingDay(pack, now),
      ...(heldCatalogue === undefined ? {} : { cataloguePack: heldCatalogue }),
      ...(payments === null ? {} : { pendingPayments: payments.pending() }),
      // OB-271 · audit A9: REAL TRADING only — today's card/UPI payments on every till of this box with the machine's
      // approval numbers, and the refunds done on the machine, for the manager's day close. Absent in the mirror pilot.
      ...(payments === null || !realTrading().on ? {} : { cardPayments: cardDayOf(payments, now) }),
      ...(peripheralReports === null ? {} : { peripheralReports: peripheralReports.latest() }),
      // OB-392: the lane cards — this box's own lane, and its last send to head office.
      ...(laneOfBox === undefined ? {} : { ownLaneId: laneOfBox }),
      ...(laneLinkRelay.current === undefined ? {} : { laneLink: laneLinkRelay.current() }),
      // OB-256: the till is told it is in the mirror pilot, and who turned it on.
      mirrorPilot: mirrorPilot(),
      // OB-264: the mirror sales and their old ERP bill numbers, for the evening check's bill-wise list.
      oldErpBills: oldErpBills.bills(),
      // OB-263: the evening check kept on this box — its mappings and the days loaded (the figures are read per day).
      eveningCheck: { mappings: eveningCheckBox.mappings(), days: eveningCheckBox.days() },
      // OB-288 lane 2 · P2: the store's work feeds, the runs captured on this box, and the clock check (OB-327).
      workFeeds,
      boxCapturedRuns: boxCapturedRuns(),
      boxQualityReleases: boxQualityReleases(), // OB-333
      clock: clockGuard.check(),
      clockFlaggedBills: clockGuard.flaggedBills(recordsNow.sales),
      zone: zoneNow(), // R1a · P-08: the machine's zone against the shop's
      activationHold: activationHoldNow(now), // OB-403 "A" · §31.1: what the 5-minute clock flag is holding
    };
  };

  const screenPort = settings['EDGE_SCREEN_PORT'];
  const screenHost = settings['EDGE_SCREEN_HOST'];
  if (officeGate !== null) say(`office screens: staff ID and own till PIN, checked on this box; a cashier opens only the till (${officeGate.live().length} office sign-in(s) still open).`);
  // OB-388 · ADR-0029: the office pages reach head office as the person signed in — their own head-office login and second
  // step, their own session carried to head office (never this box's machine credential, never a PIN). Off unless both
  // the identity server and head office's API are named; the boot log says which, and never prints either address.
  const headOfficeLinkSetting = headOfficeLinkSettingsFrom(settings);
  if (headOfficeLinkSetting.on) say('office pages: each person signs in to head office with their own login and second step on this PC; their own session is carried to head office (OB-388).');
  else if (headOfficeLinkSetting.why !== null) say(`office pages: the head-office sign-in is NOT on — ${headOfficeLinkSetting.why}. The pages say head office cannot be reached.`);
  // OB-424 · ADR-0030: the "Handheld seal" panel on these loopback screens reads the RUNNING door's authority — set once
  // the door below is opened, or shut with the box's own words why. Never a seal the door is not using.
  const sealRelay: { current: () => HandheldSealSource } = {
    current: settings['EDGE_DEVICE_PORT'] === undefined ? () => ({ kind: 'no_door' }) : () => ({ kind: 'starting' }),
  };
  const screens = screenPort === undefined ? null : await startScreenServer({
    handheldSeal: () => sealRelay.current(),
    ...(officeGate === null ? {} : { officeSignIn: officeGate }),
    ...(headOfficeLinkSetting.on ? {
      headOffice: (origin: string) => createHeadOfficeLink({
        settings: { ...headOfficeLinkSetting.settings, origin }, fetch: globalThis.fetch,
        audit: (l) => { say(`head-office sign-in: ${l.event}${l.userId === undefined ? '' : ` — ${l.userId}`}${l.why === undefined ? '' : ` (${l.why})`}`); },
      }),
    } : {}),
    port: Number(screenPort),
    ...(screenHost === undefined ? {} : { host: screenHost }),
    appsDir: settings['EDGE_APPS_DIR'] ?? 'apps',
    snapshot,
    // Which lane this box is — told to the served till so every sale names it (SP-4b · F09).
    ...(laneOfBox === undefined ? {} : { laneId: laneOfBox }),
    // B13: the HUIDs this box has sold, read per request, so a reloaded till refuses a piece another till sold.
    soldHuids: () => soldHuids.list(),
    // OB-252: the till is told whether it takes guest sales only, per request.
    guestSalesOnly,
    // OB-271: real trading (off unless set), the shop's legal identity for the tax invoice, and the bill's paper.
    realTrading: () => {
      const rt = realTrading();
      return { ...rt, taxInvoice: rt.on ? taxInvoiceIdentity() : null, ...(settings['EDGE_BILL_PAPER'] === undefined ? {} : { billPaper: settings['EDGE_BILL_PAPER'] }) };
    },
    // The manager's day close (M14-FR-04) posts to this box's lane socket — tell the screen where it is.
    // Only when this box actually serves a lane; otherwise the screen stays read-only (a local preview).
    ...(lane === null ? {} : { laneWriteBase: `http://${LANE_HOST}:${lane.port}` }),
    // Behind the hosted front's authenticated relay only (OB-16): the ERP screens run as the person who signed in.
    ...(settings['EDGE_SCREEN_TRUST_FORWARDED_USER'] === '1' ? { trustForwardedUser: true } : {}),
    // OB-263: the evening check's doors on the migration screen — only while the box is in the mirror pilot.
    eveningCheck: { box: eveningCheckBox, on: () => mirrorPilot().on },
  });
  if (screens !== null) {
    say(screens.host === SCREEN_HOST || screens.host === 'localhost'
      ? `screens on ${screens.host}:${screens.port} — loopback only, so nothing on the shop network can read the day's takings`
      : `screens on ${screens.host}:${screens.port} — NOT loopback: anything that can reach this address can read the day's takings. Only right inside a private container network with the public proxy in front of it and no host port published (ADR-0018).`);
  }

  // The handhelds' DEVICE socket (SP-3a · ADR-0019): the shop-network-facing door for ENROLLED handhelds only. It
  // serves the handheld shells and the device routes — never the till, the manager, the owner or the takings — and
  // nothing at all to a device that has not enrolled with the one-time code head office issued for it. Loopback
  // unless `EDGE_DEVICE_HOST` names the shop's address, and the boot log says in words when it has.
  const devicePort = settings['EDGE_DEVICE_PORT'];
  const enrolments = devicePort === undefined ? null : await DeviceEnrolments.open({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
  });
  const deviceHost = settings['EDGE_DEVICE_HOST'];
  // OB-422 · ADR-0030: the door speaks TLS only. Its lock — the store computer's own signing authority and the door's
  // certificate — lives OUTSIDE the data folder (a backup never carries a private key off the box). Made at install,
  // checked and renewed here. A lock that cannot be made or read keeps the door SHUT and says why; the till sells on.
  const deviceTlsDir = settings['EDGE_DEVICE_TLS_DIR'] ?? `${settings['EDGE_DATA_DIR']!.replace(/[\\/]+$/, '')}-device-tls`;
  const deviceTls = ((): { readonly dir: string; readonly addresses: readonly string[]; readonly material: DeviceTlsMaterial } | null => {
    if (devicePort === undefined) return null;
    const where = socketAddressesFor(deviceHost ?? DEVICE_HOST);
    if (!where.ok) { say(`handheld door NOT opened: ${where.problem}. The till keeps selling; the handhelds cannot reach this box until this is fixed.`); sealRelay.current = () => ({ kind: 'shut', problem: where.problem }); return null; }
    const made = ensureDeviceTls({ dir: deviceTlsDir, addresses: where.addresses, now: new Date() });
    if (!made.ok) { say(`handheld door NOT opened: ${made.problem}. The till keeps selling; the handhelds cannot reach this box until this is fixed.`); sealRelay.current = () => ({ kind: 'shut', problem: made.problem }); return null; }
    for (const e of made.events) say(sayDeviceTlsEvent(e));
    return { dir: deviceTlsDir, addresses: where.addresses, material: made.tls };
  })();
  const devices = devicePort === undefined || enrolments === null || deviceTls === null ? null : await startDeviceServer({
    tls: deviceTls,
    onTls: say,
    port: Number(devicePort),
    ...(deviceHost === undefined ? {} : { host: deviceHost }),
    appsDir: settings['EDGE_APPS_DIR'] ?? 'apps',
    snapshot,
    enrolments,
    // The pack's fleet register is the truth about which handhelds belong to the shop; none known → none served.
    devices: () => { const register = snapshot().pack.devices; return register.known ? readPackDevices(register.value) : undefined; },
    relayDeviceEvents,
    deviceEventStatus,
    syncStatus,
    // DF-3-c (OB-30 "A"): who is holding each phone — the till's register, addressed by the device.
    operators: staffSignIn === null ? null : phoneOperatorsOf(staffSignIn),
    now: () => new Date().toISOString(),
    // D04-FR-05 (OB-288 Pkg 6b): the queue till's door — its switch, its sign-in for selling, its lane pipeline, its baskets.
    queuePos: queuePosDoor({
      appsDir: settings['EDGE_APPS_DIR'] ?? 'apps',
      switches: queuePosSwitches,
      operators: staffSignIn === null ? null : phoneOperatorsOf(staffSignIn),
      queueBaskets,
      laneFor: queuePosLaneFor,
      page: (handheldLane) => {
        const snap = snapshot();
        const rt = realTrading();
        const template = posReceiptTemplate(snap);
        return {
          posCatalogue: payloadFor('pos', snap),
          posLane: {
            ...posLanePayload(snap, handheldLane), soldHuids: soldHuids.list(), guestSalesOnly: guestSalesOnly(),
            realTrading: { on: rt.on, by: rt.by }, taxInvoice: rt.on ? taxInvoiceIdentity() : null,
            ...(settings['EDGE_BILL_PAPER'] === undefined ? {} : { billPaper: settings['EDGE_BILL_PAPER'] }),
          },
          catalogueFreshness: catalogueFreshness(snap),
          ...(template === undefined ? {} : { posReceiptTemplate: template }),
        };
      },
      now: () => new Date().toISOString(),
    }),
  });
  if (devices !== null) sealRelay.current = () => ({ kind: 'door', authority: devices.authority() }); // OB-424
  if (devices !== null && enrolments !== null) {
    say(devices.host === DEVICE_HOST || devices.host === 'localhost'
      ? `device socket on https://${devices.host}:${devices.port} — loopback only; name EDGE_DEVICE_HOST with the shop's address for the handhelds on the wifi to reach it`
      : `device socket on https://${devices.host}:${devices.port} — reachable on the shop network; only handhelds enrolled with a head-office code may use it, and it serves the handheld screens only (ADR-0019)`);
    say(`  locked (OB-422): https only, plain http refused; a handheld trusts this store computer's authority once, at enrolment — fingerprint ${devices.authority().fingerprint}; the door's certificate runs to ${devices.certificate().notAfter} and is renewed by this box`);
    const live = enrolments.enrolled().filter((e) => e.revokedAt === null).length;
    if (live > 0) say(`  ${live} handheld(s) enrolled on this box`);
    say('  phone sign-in: each person signs in on the phone with their staff ID and the same PIN as the till; their work is recorded as theirs (OB-30)');
    if (enrolments.unreadableRecords > 0) say(`  ${enrolments.unreadableRecords} enrolment record(s) could not be read whole — kept, not repaired. Raise this.`);
  }

  // Close and LOCK the store's trading day, on the box where the live facts live (M14-FR-04, P-01).
  //
  // The DECISION belongs here, not in the manager's browser: the "no unsent items" gate can only be
  // evaluated where the outbox is (the cloud cannot know what has not reached it, and the browser holds
  // only a last-synced snapshot). So this reads the box's LIVE state — the depth of ALL four outboxes,
  // and the exception register computed exactly as the manager screen shows it — and hands the tested
  // engine the real numbers. On success the locked day is durable on the disk BEFORE it is called done,
  // then queued; its own sync agent carries it to the cloud (`StoreDayClosed`), restart-safe. Offline
  // makes no difference to the lock — the day is locked locally; the cloud simply hears about it later.
  const closeDay = async (
    req: {
      readonly dayCloseId: string;
      /** Who says they are closing — only ever checked against the person the box verifies (their PIN or their signed-in session). */
      readonly closedBy?: string;
      /** The closer's own till PIN, keyed by them on the manager screen; goes to the PIN register only, never written. */
      readonly closerPin?: string;
      /** The person this box already verified for the request (their till session or the hosted sign-in). */
      readonly verifiedPerson?: { readonly userId: string; readonly via: string; readonly laneId: string };
      /** OB-55: close with the named pending card/UPI payments carried forward — a SECOND person's staff ID and own till PIN. */
      readonly carryForward?: CarryForwardRequest;
    },
  ): Promise<
    | { readonly closed: true; readonly tradingDay: string; readonly locked: true; readonly carriedForward?: readonly string[]; readonly unresolvedMinor?: { readonly card: number; readonly upi: number } }
    | { readonly closed: false; readonly reason: string }
  > => {
    const input = snapshot();
    const rule = packCutoff(input.pack);
    // Round 4: the day close names the STORE this box is (its setup's store id), not the tenant.
    const storeIdHere = (input.pack.policies.known ? (input.pack.policies.value.storeId ?? input.pack.policies.value.branchId) : undefined) ?? tenantId;
    // The day being closed is the most-recently-ENDED trading day: the previous trading date relative
    // to now. The engine refuses to close a day whose cut-off has not passed (currentTradingDate must
    // be later than the day closed), so closing the previous date is the only one that can succeed.
    const currentTradingDate = packTradingDay(input.pack, input.now, rule);
    const dayToClose = ((): string => {
      const dt = new Date(`${currentTradingDate}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() - 1);
      return dt.toISOString().slice(0, 10);
    })();
    // LIVE unsent across ALL pipelines — not the manager screen's `unsentItems`, which counts only the
    // sales outbox. A day must not lock while any refund or completion is still unsent (hard rule #10).
    const unsentSyncItems = unsentAcrossAllQueues();
    // The exception register EXACTLY as the manager screen computes it (so the box and the screen agree).
    // ABSENT (no loss-prevention rules → nobody is watching) is a hard block, never treated as zero.
    const openExceptions = managerPayload(input)['openExceptions'];
    if (openExceptions === undefined) {
      return { closed: false, reason: 'the day cannot close: this box has no loss-prevention rules, so its exception register was never checked' };
    }
    const unresolvedExceptions = (openExceptions as readonly unknown[]).length;
    // PF-08: every till whose shift is still open and was opened on or before the day being closed — read from the
    // box's own till-cash log, never the screen's word. A shift a cashier opened on the NEW day does not hold back
    // yesterday's close.
    const cashRecords = await tillCashRecords();
    const openShifts = [...new Set(cashRecords.map((r) => r.tillId))].sort().flatMap((tillId) => {
      const state = foldTillCash(cashRecords, tillId);
      if (state.custodian === null || state.openedAt === null) return [];
      if (packTradingDay(input.pack, state.openedAt, rule) > dayToClose) return [];
      return [{ tillId, custodian: state.custodian, openedAt: state.openedAt }];
    });
    // D04-FR-02 · PF-06 · WF-12: every card/UPI payment asked on or before the day being closed that still has no final
    // answer — read from the box's own payment-attempt log. A payment asked on the NEW day does not hold yesterday.
    const pendingPayments = (payments?.pending() ?? [])
      .filter((a) => packTradingDay(input.pack, a.askedAt, rule) <= dayToClose)
      .map((a) => ({ attemptId: a.attemptId, laneId: a.laneId, billRef: a.billRef, kind: a.kind, amountMinor: a.amountMinor, askedAt: a.askedAt, state: a.state as 'asked' | 'no_answer' }));

    // Gate-check with the tested engine (a throwaway outbox — the durable write + enqueue below is what
    // survives a restart, so we do not use the engine's own enqueue here). A blocker throws; surface it.
    // OB-55 "A": a pending payment may be CARRIED FORWARD — only with a second person's approval naming each one (the engine
    // checks the names and that the approver is not the closer; the approver's PIN is checked below, after the closer's).
    const cf = req.carryForward;
    const carryInput = cf === undefined || pendingPayments.length === 0 ? undefined
      : { approvalId: 'to-be-issued', approvedBy: (cf.approvedBy ?? '').trim(), reason: (cf.reason ?? '').trim(), attemptIds: Array.isArray(cf.attemptIds) ? cf.attemptIds.filter((a): a is string => typeof a === 'string') : [] };
    try {
      decideDayClose({
        id: req.dayCloseId, storeId: storeIdHere, tradingDay: dayToClose, closedBy: (req.closedBy ?? '').trim() || (req.verifiedPerson?.userId ?? 'unconfirmed'),
        closedAtLocal: packWallClock(input.pack, input.now), closedAt: input.now, tradingDayRule: rule,
        unresolvedExceptions, unsentSyncItems, openShifts, pendingPayments,
        ...(carryInput === undefined ? {} : { carriedForward: carryInput }),
      }, new SyncOutbox());
    } catch (e) {
      return { closed: false, reason: e instanceof Error ? e.message : String(e) };
    }

    // Round 4 (P-04 · hard rule #4 · §28): the close is the CLOSER's own act, verified HERE, offline, after the gates and BEFORE anything is written — never a typed name.
    //   • their own staff ID and till PIN, checked by the same PIN register as the till's sign-in (same guess limits), or
    //   • the session this box already verified for the request (their till sign-in / the hosted sign-in);
    // and either way they must hold the day-close authority in the store's setup from head office (`till.dayclose.read`,
    // the same authority head office re-checks after the fact — OB-36). A cashier is refused before anything is locked.
    if (tillOperators === null) {
      return { closed: false, reason: 'this store computer cannot check people here, so it cannot close the day — tell the manager' };
    }
    const named = (req.closedBy ?? '').trim();
    let closer: string | undefined;
    if (typeof req.closerPin === 'string' && req.closerPin !== '') {
      if (named === '') return { closed: false, reason: 'the person closing the day must give their staff ID with their till PIN' };
      const who = await tillOperators.verifyPerson({ staffId: named, pin: req.closerPin, laneId: laneIdOfThisBox() ?? '', authority: CLOSE_AUTHORITY, lacking: 'no_approval_authority' });
      if (!who.ok) return { closed: false, reason: `the person closing the day was not confirmed: ${who.laneMessage}` };
      closer = who.userId;
    } else if (req.verifiedPerson !== undefined && req.verifiedPerson.userId.trim() !== '') {
      const vp = req.verifiedPerson.userId.trim();
      if (named !== '' && named !== vp) return { closed: false, reason: 'the day can only be closed in the name of the person signed in here' };
      if (!(permissionsOf(vp, snapshot().pack) ?? []).includes(CLOSE_AUTHORITY)) {
        return { closed: false, reason: `${vp} does not hold the authority to close the day — a manager must close it with their own till PIN` };
      }
      closer = vp;
    }
    if (closer === undefined) {
      return { closed: false, reason: 'the person closing the day must confirm it is them — their staff ID and till PIN; a typed name closes nothing' };
    }
    // OB-55 "A": the SECOND person approves on this box, with their own staff ID and till PIN — the one-use approval register
    // (PF-02) issues it for exactly this close, these payments and their total, and this close spends it. Offline: nothing
    // here asks head office. Never the closer; they must hold the day-close approval authority. Without it, nothing locks.
    let carried: ReturnType<typeof carriedForwardOf> | undefined;
    let approverVerified: ReturnType<typeof sealDecision> | undefined;
    if (carryInput !== undefined && cf !== undefined) {
      if (carryInput.approvedBy === closer) return { closed: false, reason: 'a second person must approve closing with a payment carried forward — never the person closing the day' };
      if (tillApprovals === null) return { closed: false, reason: 'this store computer cannot take a second person\'s approval, so the payment cannot be carried forward — the day stays open' };
      const valueMinor = pendingPayments.reduce((n, p) => n + p.amountMinor, 0);
      const approval = await tillApprovals.approveDayCloseException({
        dayCloseId: req.dayCloseId, closerId: closer, laneId: laneIdOfThisBox() ?? '', approverId: carryInput.approvedBy,
        approverPin: typeof cf.approverPin === 'string' ? cf.approverPin : '', reason: carryInput.reason, attemptIds: carryInput.attemptIds, valueMinor,
      });
      if (!approval.ok) return { closed: false, reason: `the second person's approval was not confirmed: ${approval.laneMessage}` };
      const block = carriedForwardOf({ ...carryInput, approvalId: approval.approvalId, approvedBy: approval.approvedBy }, pendingPayments);
      // Each payment carries the trading day it was asked on — the day whose tender figures it leaves unresolved.
      carried = { ...block, payments: block.payments.map((p) => ({ ...p, tradingDay: packTradingDay(input.pack, p.askedAt, rule) })) };
    }
    // Durable-write-then-enqueue, the same order as every other seam: the locked day is on the disk
    // before it is called done, then queued. `dayCloseEventFrom` re-mints the identical event on restart.
    const relayedClose = {
      dayCloseId: req.dayCloseId, storeId: storeIdHere, tradingDay: dayToClose,
      closedBy: closer, closedAt: input.now, locked: true,
      ...(carried === undefined ? {} : { carriedForward: carried }),
    };
    if (carried !== undefined) {
      // The box seals the second person it verified by PIN, over every word head office receives (ADR-0023 amended).
      approverVerified = sealDecision(sealKey, { tenantId, kind: 'day_close_exception_approval', recordId: req.dayCloseId, record: relayedClose, laneId: laneIdOfThisBox() ?? '', userId: carried.approvedBy, via: 'pin' });
    }
    const record = JSON.stringify({ ...relayedClose, ...(approverVerified === undefined ? {} : { approverVerified }) });
    await dayCloseLog.append(record);
    const event = dayCloseEventFrom(record, 0);
    if (event !== undefined) dayCloseOutbox.enqueue(event);
    return { closed: true, tradingDay: dayToClose, locked: true, ...(carried === undefined ? {} : { carriedForward: carried.payments.map((p) => p.attemptId), unresolvedMinor: carried.unresolvedMinor }) };
  };
  // The lane socket, wired above through a relay, can now reach the authoritative close.
  dayCloseRelay.current = closeDay;

  // Reopen a locked day — the controlled, audited unlock (M14-FR-04 / §28). The box owns this for the
  // same reason it owns the close: the locked day it holds is the source of truth, and the reopen is a
  // COMPENSATING event appended to the same durable log, never an edit of the close (hard rule #2). The
  // §28 "a different person approved it" gate is enforced HERE by the tested engine (approver ≠
  // reopener); whether that named approver genuinely holds `till.dayclose.approve` is re-verified at the
  // cloud (record-and-flag, never a rejection — hard rule #10). Idempotent per day: a second reopen of an
  // already-reopened day is a no-op success, never a duplicate compensating event.
  const reopenDay = async (
    req: { readonly dayCloseId: string; readonly reopenedBy: string; readonly reason: string; readonly approvedBy: string; readonly verifiedPerson?: { readonly userId: string; readonly via: string; readonly laneId: string }; readonly reopenerPin?: string; readonly approverPin?: string },
  ): Promise<
    | { readonly reopened: true; readonly tradingDay: string }
    | { readonly reopened: false; readonly reason: string }
  > => {
    // Find the close this reopen names, and whether it has already been reopened, from the box's own
    // durable log — the only honest record of what this box locked. A reopen with no close to reopen, or
    // a day still open, is refused rather than inventing a compensating event for a lock that isn't there.
    let close: { readonly tradingDay: string } | undefined;
    let alreadyReopened = false;
    for (const entry of await readLog(dayCloseLog.path)) {
      if (entry.ok !== true) continue;
      let p: Record<string, unknown>;
      try { p = JSON.parse(entry.record) as Record<string, unknown>; } catch { continue; }
      if (p['dayCloseId'] !== req.dayCloseId) continue;
      if (typeof p['reopenedBy'] === 'string') alreadyReopened = true;
      else if (typeof p['tradingDay'] === 'string') close = { tradingDay: p['tradingDay'] };
    }
    if (close === undefined) {
      return { reopened: false, reason: 'that day is not closed on this box, so there is nothing to reopen' };
    }
    if (alreadyReopened) {
      // Already reopened — the day is open again. Say so as a success, without a second compensating event.
      return { reopened: true, tradingDay: close.tradingDay };
    }

    // BOTH people are verified by this box (2b-vi-c-4 · §28 · ADR-0023 amended) — never a name typed on a screen.
    //   • the REOPENER: the person the box verified for the request (the hosted sign-in) or their own staff ID and till PIN,
    //     holding `till.dayclose.read`;
    //   • the APPROVER: their own staff ID and till PIN, holding `till.dayclose.approve`, and never the reopener.
    // Checked by the same PIN register as the till's sign-in and approvals (same guess limits); PINs are never written.
    if (tillOperators === null) {
      return { reopened: false, reason: 'this store computer cannot check people here, so it cannot reopen a day — tell the manager' };
    }
    const lane = laneIdOfThisBox() ?? '';
    const vp = req.verifiedPerson;
    let reopener: { readonly userId: string; readonly via: string } | undefined;
    if (vp !== undefined && vp.userId !== '' && vp.userId === req.reopenedBy.trim()) {
      reopener = { userId: vp.userId, via: vp.via };
    } else if (typeof req.reopenerPin === 'string' && req.reopenerPin !== '') {
      const who = await tillOperators.verifyPerson({ staffId: req.reopenedBy, pin: req.reopenerPin, laneId: lane, authority: REOPEN_AUTHORITY });
      if (!who.ok) return { reopened: false, reason: `the person reopening was not confirmed: ${who.laneMessage}` };
      reopener = { userId: who.userId, via: 'pin' };
    }
    if (reopener === undefined) {
      return { reopened: false, reason: 'the person reopening the day must confirm it is them — their staff ID and till PIN' };
    }
    if (req.approvedBy.trim() === reopener.userId) {
      return { reopened: false, reason: 'a different person must approve the reopen — never the person reopening it' };
    }
    if (typeof req.approverPin !== 'string' || req.approverPin === '') {
      return { reopened: false, reason: 'the person approving must key their own till PIN here — a typed name is not an approval' };
    }
    const approver = await tillOperators.verifyPerson({ staffId: req.approvedBy, pin: req.approverPin, laneId: lane, authority: APPROVE_REOPEN_AUTHORITY });
    if (!approver.ok) return { reopened: false, reason: `the approver was not confirmed: ${approver.laneMessage}` };

    const now = new Date().toISOString();
    // Gate-check with the tested engine (a throwaway outbox — the durable write + enqueue below is what
    // survives a restart). It throws unless the reopen carries an approval by a DIFFERENT person (§28).
    // The approval is minted from the named approver; the cloud re-verifies that approver's authority.
    try {
      decideReopenDay({
        id: req.dayCloseId, storeId: tenantId, tradingDay: close.tradingDay,
        reopenedBy: req.reopenedBy, reopenedAt: now, reason: req.reason,
        approval: {
          id: `reopen:${req.dayCloseId}`, subjectType: 'day_close_reopen', subjectRef: req.dayCloseId,
          requestedBy: req.reopenedBy, branchId: null, value: null,
          status: 'approved', decidedBy: req.approvedBy, reason: req.reason, decidedAt: now,
        },
      }, new SyncOutbox());
    } catch (e) {
      return { reopened: false, reason: e instanceof Error ? e.message : String(e) };
    }

    // Durable-write-then-enqueue, the close's mirror. `dayCloseEventFrom` sees `reopenedBy` and mints
    // `StoreDayReopened` (both on this run and on a restart re-queue), routed to `.../reopen/synced`.
    // The box seals the reopen for the person it verified when that person is the reopener (2b-vi-c-3): the seal covers
    // the body head office receives, word for word. Anybody else — or nobody verified — and the reopen goes unsealed.
    const reopenPack = snapshot().pack;
    const relayed = { dayCloseId: req.dayCloseId, storeId: (reopenPack.policies.known ? (reopenPack.policies.value.storeId ?? reopenPack.policies.value.branchId) : undefined) ?? tenantId, tradingDay: close.tradingDay, reopenedBy: req.reopenedBy, approvedBy: req.approvedBy, reason: req.reason };
    const deciderVerified = sealDecision(sealKey, { tenantId, kind: 'day_reopen', recordId: req.dayCloseId, record: relayed, laneId: lane, userId: reopener.userId, via: reopener.via });
    const approverVerified = sealDecision(sealKey, { tenantId, kind: 'day_reopen_approval', recordId: req.dayCloseId, record: relayed, laneId: lane, userId: approver.userId, via: 'pin' });
    const record = JSON.stringify({ ...relayed, reopenedAt: now, deciderVerified, approverVerified });
    await dayCloseLog.append(record);
    const event = dayCloseEventFrom(record, 0);
    if (event !== undefined) dayCloseOutbox.enqueue(event);
    return { reopened: true, tradingDay: close.tradingDay };
  };
  // The lane socket can reach the authoritative reopen too.
  dayReopenRelay.current = reopenDay;

  const cloudUrl = settings['CLOUD_API_URL'];
  const cloudToken = settings['CLOUD_API_TOKEN'];

  if (cloudUrl === undefined || cloudToken === undefined) {
    // Supported, and said plainly. The lanes sell; the queue grows; nobody is told a lie about it.
    say('no cloud is configured, so nothing will be synced. The shop can still trade — that is the point.');
    // The badge on every screen says exactly that, from the box's own mouth (design system §1 rule 4).
    syncStatusRelay.current = () => laneSyncStatus({ configured: false, queues: queuesNow(), lastPackStatus: undefined, lastContactAt: null, now: new Date().toISOString() });
    return {
      log, returnsLog, completionsLog, dayCloseLog, concessionTagsLog, deviceEventsLog, tillCashLog, outbox, returnsOutbox, completionsOutbox, dayCloseOutbox, concessionTagsOutbox, deviceEventsOutbox, tillCashOutbox, node, lane, screens, devices, enrolments, syncStatus,
      agent: null, returnsAgent: null, completionsAgent: null, dayCloseAgent: null, concessionTagsAgent: null, deviceEventsAgent: null, tillCashAgent: null, refreshPack: null, refreshMigrationFeed: null, refreshPublishedTemplates: null, refreshIndentsFeed: null, refreshAssignmentsFeed: null, refreshStorePack: null, refreshLoyaltyWallets: null, loyaltyWallets, refreshConcessionTrading: null, storeSetup: storeSetupStatus, reportHeldVersions: null, syncOnce: null,
      refreshWorkFeeds: null, clockCheck: () => clockGuard.check(), activationHold: () => activationHoldNow(new Date().toISOString()), zoneCheck: zoneNow,
      // The day still locks with no cloud — that is the point of P-01. It queues durably and goes up when
      // a cloud is configured and reachable; nothing is told a lie in the meantime. Reopen is the same.
      closeDay,
      reopenDay,
      // The till's cash records and closes with no cloud too — the box is the record; head office hears later.
      recordCashMovement,
      closeShift,
      tillCash,
      stop: async () => {
        if (lane !== null) await lane.stop();
        await stopQueuePosLanes();
        if (screens !== null) await screens.stop();
        if (devices !== null) await devices.stop();
        if (enrolments !== null) await enrolments.close();
        if (receiptNumbers !== null) await receiptNumbers.close();
        if (queueBaskets !== null) await queueBaskets.close();
        if (heldBills !== null) await heldBills.close();
        if (payments !== null) await payments.close();
        if (peripheralReports !== null) await peripheralReports.close();
        await eveningCheckBox.close();
        await log.close();
        await returnsLog.close();
        await completionsLog.close();
        await dayCloseLog.close();
        await deadLetterLog.close();
        await returnsDeadLetterLog.close();
        await completionsDeadLetterLog.close();
        await dayCloseDeadLetterLog.close();
        await concessionTagsLog.close();
        await concessionTagsDeadLetterLog.close();
        await deviceEventsLog.close();
        await deviceEventsDeadLetterLog.close();
        await tillCashLog.close();
        await tillCashDeadLetterLog.close();
        await signInRelayFiles?.log.close();
        await signInRelayFiles?.dead.close();
      },
    };
  }

  // §31.1 · OB-327: every answer from head office has its clock measured against this box's (the call itself unchanged).
  // OB-429: the first `401 unauthenticated` head office gives the box's OWN login closes this gate — no further call with it
  // leaves the box, so head office counts one failed sign-in from the shop's address, never the five that would lock every
  // person signing in to head office on the store PC. Restarting the box (with a renewed login) opens it again.
  const boxLogin = boxLoginGate(globalThis.fetch, {
    onRefused: (at) => { say(`head office refused this store computer's own login at ${at}. It has stopped contacting head office so the shop's sign-ins are not locked. Selling continues and everything stays queued. Renew the store computer's head-office login (CLOUD_API_TOKEN) and restart it.`); },
  });
  const cloudFetch = clockObservingFetch(boxLogin.fetch, clockGuard);
  const agent = new SyncAgent(outbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch,
  }));
  // The return pipeline's own agent — same transport, its own outbox. A second agent is simpler and
  // safer than teaching one agent about two queues: the sale drain and its cursor stay exactly as they
  // were, and the refund drain sits beside them without ever crossing into the sale path.
  const returnsAgent = new SyncAgent(returnsOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch,
  }));
  // OB-392: the lane cards say when a bill or a refund from this box last reached head office.
  laneLinkRelay.current = () => {
    const times = [agent.health().lastSuccessAt, returnsAgent.health().lastSuccessAt].filter((t): t is string => t !== null).sort();
    return { lastSentAt: times[times.length - 1] ?? null };
  };
  // The completion pipeline's own agent (M25-FR-02) — same transport, its own outbox, for the same
  // reason a refund has its own: three small agents beside one another keep each drain and each cursor
  // exactly its own, so a completion that cannot get through never holds a sale or a refund, and none
  // of the three can ever be re-queued as another.
  const completionsAgent = new SyncAgent(completionsOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch,
  }));
  // The day-close pipeline's own agent (M14-FR-04) — same transport, its own outbox, for the same
  // reason each of the others has its own: a day close that cannot get through never holds a sale, a
  // refund or a completion, and none of the four can ever be re-queued as another.
  const dayCloseAgent = new SyncAgent(dayCloseOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch,
  }));
  // The concession-tag pipeline's own agent (M27-FR-03) — same transport, its own outbox, for the same reason
  // each of the others has its own: a partner-counter line that cannot get through never holds a sale, a
  // refund, a completion or a day close, and none of the five can ever be re-queued as another.
  const concessionTagsAgent = new SyncAgent(concessionTagsOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch,
  }));
  // The device-events pipeline's own agent (SP-2a · F11) — same transport, its own outbox, for the same reason each
  // of the others has its own: a decision head office refuses never holds a sale, and none of the six can ever be
  // re-queued as another. The transport's route table addresses each device event type to its re-verifying synced
  // route; a type with no route is dead-lettered by name (visible on the manager's screen as refused, hard rule #6).
  const deviceEventsAgent = new SyncAgent(deviceEventsOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch,
  }));
  // The till-cash pipeline's own agent (SP-4c · F10) — same transport, its own outbox, for the same reason each of the
  // others has its own: a float or a close head office refuses never holds a sale, and none of the seven can ever be
  // re-queued as another. Routed to the cash and shift SYNCED routes, which re-verify the cashier and record-and-flag.
  const tillCashAgent = new SyncAgent(tillCashOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch,
  }));
  // OB-365: the till sign-in log's own agent — same transport, its own outbox; never counted with the trading queues.
  const signInRelayAgent = signInRelay === null ? null : new SyncAgent(signInRelay.outbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch,
  }));

  // The INBOUND mirror of the agent: the same cloud, the other direction (SYNC-01). It fetches the
  // signed catalogue pack; the lane decides whether to trust it (via `node.takePack`); a newer,
  // verified pack is adopted and persisted atomically so it survives a reboot.
  const packSource = httpPackSource({ baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch });
  let lastPackStatus: PackPullStatus | undefined;
  /** When head office last answered a catalogue pull — the box's record of contact beyond what the drains send. */
  let lastContactAt: string | null = null;
  // The agents exist now, so the badge's answer is the real one: every queue's health, the last pull's verdict.
  syncStatusRelay.current = () => laneSyncStatus({
    configured: true,
    queues: [agent, returnsAgent, completionsAgent, dayCloseAgent, concessionTagsAgent, deviceEventsAgent].map((a) => a.health()),
    lastPackStatus,
    lastContactAt,
    now: new Date().toISOString(),
    boxLogin: boxLogin.state(),
    // Verifier r19 OB87-1: the bill-number witness check, on the box's own status read (P-08).
    ...(receiptNumbers === null ? {} : { billNumbering: receiptNumbers.witnessHealthNow() }),
  });

  const refreshPack = async (): Promise<PackPullOutcome> => {
    const outcome = await pullPack({ source: packSource, receiver: node, now: new Date().toISOString() });
    if (outcome.status === 'updated') {
      // The lane moved to a newer, verified pack — persist it so the box does not lose it on a reboot.
      // A failed write is not a failed update: the pack is already live in memory and will be re-pulled.
      try {
        await writeSignedPack(settings['EDGE_DATA_DIR']!, node.pack()!);
      } catch (e) {
        say(`the new catalogue pack could not be saved to disk (${e instanceof Error ? e.message : String(e)}). It is live now and will be pulled again next time.`);
      }
      say(outcome.staffMessage);
    } else if (outcome.status !== lastPackStatus) {
      // Only a CHANGE of state is worth a line — going offline, a rejected pack, none published.
      // Saying "still on the newest pack" every quiet pass would bury the lines that matter (P-08).
      say(outcome.staffMessage);
    }
    lastPackStatus = outcome.status;
    // Anything but `offline` means head office answered — that is contact, whether or not a pack moved.
    if (outcome.status !== 'offline') lastContactAt = new Date().toISOString();
    return outcome;
  };

  // The migration screen's inbound mirror (C3b), on the same loop as the catalogue pull and shaped like it:
  // the cloud's register is fetched, taken only if it is this shop's and not older than what is held, laid
  // over the pack's migration sections, and persisted so a reboot keeps it. A section the cloud did not send
  // stays exactly as it was — never filled in (the cutover gate reads absence as an unanswered question).
  const feedSource = httpMigrationFeedSource({ baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch });
  const feedReceiver: MigrationFeedReceiver = {
    tenantId,
    heldFeed: () => heldFeed?.feed,
    takeFeed: (feed, receivedAt) => {
      heldFeed = { feed, receivedAt };
      pack = withMigrationFeed(pack, feed, receivedAt);
    },
  };
  let lastFeedStatus: MigrationFeedPullStatus | undefined;

  const refreshMigrationFeed = async (): Promise<MigrationFeedPullOutcome> => {
    const outcome = await pullMigrationFeed({ source: feedSource, receiver: feedReceiver, now: new Date().toISOString() });
    if (outcome.status === 'updated') {
      // Live in memory already; the disk copy is what a reboot restores. A failed write is said, not fatal.
      try {
        if (heldFeed !== undefined) await writeHeldMigrationFeed(settings['EDGE_DATA_DIR']!, heldFeed);
      } catch (e) {
        say(`the migration register could not be saved to disk (${e instanceof Error ? e.message : String(e)}). It is live now and will be pulled again next time.`);
      }
      say(outcome.staffMessage);
    } else if (outcome.status !== 'unchanged' && outcome.status !== lastFeedStatus) {
      // A CHANGE of state is worth a line — going offline, another shop's register. A quiet re-confirmation
      // every pass is not (P-03 / P-08: the lines that matter must not be buried).
      say(outcome.staffMessage);
    }
    lastFeedStatus = outcome.status;
    return outcome;
  };

  // The published document templates ride the same loop (M01-FR-02): fetched, taken only if this shop's and not
  // older than what is held, laid into the lane's pack, persisted so a reboot keeps them. A kind the cloud no
  // longer lists as published leaves the pack — the lane must not keep printing wording nobody has in force.
  const templatesSource = httpPublishedTemplatesSource({ baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch });
  const templatesReceiver: PublishedTemplatesReceiver = {
    tenantId,
    heldTemplates: () => heldTemplates?.feed,
    takeTemplates: (feed, receivedAt) => {
      heldTemplates = { feed, receivedAt };
      pack = withPublishedTemplates(pack, feed, receivedAt);
    },
  };
  let lastTemplatesStatus: PublishedTemplatesPullStatus | undefined;

  const refreshPublishedTemplates = async (): Promise<PublishedTemplatesPullOutcome> => {
    const outcome = await pullPublishedTemplates({ source: templatesSource, receiver: templatesReceiver, now: new Date().toISOString() });
    if (outcome.status === 'updated') {
      // Live in memory already; the disk copy is what a reboot restores. A failed write is said, not fatal.
      try {
        if (heldTemplates !== undefined) await writeHeldPublishedTemplates(settings['EDGE_DATA_DIR']!, heldTemplates);
      } catch (e) {
        say(`the document templates could not be saved to disk (${e instanceof Error ? e.message : String(e)}). They are live now and will be pulled again next time.`);
      }
      say(outcome.staffMessage);
    } else if (outcome.status !== 'unchanged' && outcome.status !== lastTemplatesStatus) {
      say(outcome.staffMessage);
    }
    lastTemplatesStatus = outcome.status;
    return outcome;
  };

  // SP-8c: head office's open floor indents ride the same loop — fetched under the box's credential, taken when not older
  // than what is held, laid into the pack for the warehouse handheld (what the back store owes) and the Indents screen
  // (the register offline), persisted so a reboot keeps them. The whole register replaces what was held, so a closed or
  // cancelled indent leaves the handheld's list.
  const indentsSource = httpIndentsFeedSource({ baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch });
  const indentsReceiver: IndentsFeedReceiver = {
    heldFeed: () => heldIndents?.feed,
    takeFeed: (feed, receivedAt) => {
      heldIndents = { tenantId, feed, receivedAt };
      pack = withIndentsFeed(pack, feed, receivedAt);
    },
  };
  let lastIndentsStatus: IndentsFeedPullStatus | undefined;

  // HA-1: head office's open wave / route assignments ride the same loop — fetched under the box's credential for THIS store,
  // taken when not older than what is held, laid into the pack for the picker and driver phones, persisted so a reboot keeps
  // them. The whole feed replaces what was held, so a packed wave or a settled route leaves the phones by itself. A box whose
  // pack names no store cannot ask, and says so once.
  const storeIdOfBox = pack.policies.known ? pack.policies.value.storeId : undefined;
  const assignmentsSource = storeIdOfBox === undefined ? null : httpAssignmentsFeedSource({ baseUrl: cloudUrl, token: cloudToken, storeId: storeIdOfBox, fetch: cloudFetch });
  if (assignmentsSource === null) say('this box\'s pack names no store, so head office cannot be asked for assignments — the phones use the pack file\'s wave and route.');
  const assignmentsReceiver: AssignmentsFeedReceiver = {
    heldFeed: () => heldAssignments?.feed,
    takeFeed: (feed, receivedAt) => {
      heldAssignments = { tenantId, feed, receivedAt };
      pack = withAssignmentsFeed(pack, feed, receivedAt);
    },
  };
  let lastAssignmentsStatus: AssignmentsFeedPullStatus | undefined;
  const refreshAssignmentsFeed = assignmentsSource === null ? null : async (): Promise<AssignmentsFeedPullOutcome> => {
    const outcome = await pullAssignmentsFeed({ source: assignmentsSource, receiver: assignmentsReceiver, now: new Date().toISOString() });
    if (outcome.status === 'updated') {
      try {
        if (heldAssignments !== undefined) await writeHeldAssignmentsFeed(settings['EDGE_DATA_DIR']!, heldAssignments);
      } catch (e) {
        say(`the assignments could not be saved to disk (${e instanceof Error ? e.message : String(e)}). They are live now and will be pulled again next time.`);
      }
      say(outcome.staffMessage);
    } else if (outcome.status !== 'unchanged' && outcome.status !== lastAssignmentsStatus) {
      say(outcome.staffMessage);
    }
    lastAssignmentsStatus = outcome.status;
    return outcome;
  };

  // PF-09 step 3: the loyalty balances ride the same loop — taken when newer and this shop's, written to disk before they are
  // believed; on a failure the till keeps the copy this box holds and says how old it is.
  const walletsSource = httpWalletFeedSource({ baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch });
  let lastWalletsStatus: WalletFeedPullOutcome['status'] | undefined;
  const refreshLoyaltyWallets = async (): Promise<WalletFeedPullOutcome> => {
    const outcome = await pullWalletFeed({
      source: walletsSource, now: new Date().toISOString(),
      receiver: { tenantId, heldFeed: () => loyaltyWallets.heldFeed(), takeFeed: (feed, receivedAt) => loyaltyWallets.takeFeed(feed, receivedAt) },
    });
    if (outcome.status !== lastWalletsStatus) {
      say(outcome.status === 'updated' ? `loyalty balances as of ${outcome.asOf} taken.` : `loyalty balances not refreshed (${outcome.reason ?? outcome.status}); the till keeps the copy as of ${outcome.asOf ?? 'never'}.`);
    }
    lastWalletsStatus = outcome.status;
    return outcome;
  };

  // PF-13: the counters' agreement terms ride the same loop; a failure keeps what this box holds.
  const refreshConcessionTrading = async (): Promise<ConcessionTradingPullOutcome> => pullConcessionTradingFeed({
    baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch, now: new Date().toISOString(),
    receiver: { tenantId, heldFeed: () => concessionTrading.heldFeed(), takeFeed: (feed, receivedAt) => concessionTrading.takeFeed(feed, receivedAt) },
  });

  // OB-288 lane 2 · P2: the work feeds ride the same loop; each that changed is written to disk (one atomic file) and shown on
  // the next page load. An unreachable cloud keeps what this box holds and says how old it is (P-08).
  const workSources = WORK_FEED_NAMES.map((name) => httpWorkFeedSource(name, { baseUrl: cloudUrl, token: cloudToken, fetch: cloudFetch, ...(storeIdOfThisBox() === undefined ? {} : { storeId: storeIdOfThisBox()! }) }));
  const lastWorkStatus = new Map<WorkFeedName, string>();
  const refreshWorkFeeds = async (): Promise<readonly WorkFeedPullOutcome[]> => {
    const outcomes: WorkFeedPullOutcome[] = [];
    let changed = false;
    for (const source of workSources) {
      const outcome = await pullWorkFeed({
        source, now: new Date().toISOString(),
        held: () => workFeeds[source.name]?.feed,
        take: (feed, receivedAt) => { workFeeds = { ...workFeeds, [source.name]: { feed, receivedAt } }; },
      });
      if (outcome.status === 'updated') { changed = true; say(outcome.staffMessage); }
      else if (outcome.status !== 'unchanged' && lastWorkStatus.get(source.name) !== outcome.status) say(outcome.staffMessage);
      lastWorkStatus.set(source.name, outcome.status);
      outcomes.push(outcome);
    }
    if (changed) {
      try { await writeHeldWorkFeeds(settings['EDGE_DATA_DIR']!, tenantId, workFeeds); } catch (e) {
        say(`the store's work (production, food safety, transfers) could not be saved to disk (${e instanceof Error ? e.message : String(e)}). It is live now and will be pulled again next time.`);
      }
    }
    return outcomes;
  };

  const refreshIndentsFeed = async (): Promise<IndentsFeedPullOutcome> => {
    const outcome = await pullIndentsFeed({ source: indentsSource, receiver: indentsReceiver, now: new Date().toISOString() });
    if (outcome.status === 'updated') {
      try {
        if (heldIndents !== undefined) await writeHeldIndentsFeed(settings['EDGE_DATA_DIR']!, heldIndents);
      } catch (e) {
        say(`the floor indents could not be saved to disk (${e instanceof Error ? e.message : String(e)}). They are live now and will be pulled again next time.`);
      }
      say(outcome.staffMessage);
    } else if (outcome.status !== 'unchanged' && outcome.status !== lastIndentsStatus) {
      say(outcome.staffMessage);
    }
    lastIndentsStatus = outcome.status;
    return outcome;
  };

  // PA-06 = DF-3-a: this store's setup from head office rides the same loop, FIRST — the other feeds are laid over it. A
  // verified, newer setup is written to disk atomically (the one it replaces kept as the previous copy) and then becomes the
  // pack, with every held feed laid back over it. Anything else keeps the setup this box has (P-01) and is said once.
  const withHeldFeeds = (base: StorePack): StorePack => {
    let p = base;
    if (heldFeed !== undefined) p = withMigrationFeed(p, heldFeed.feed, heldFeed.receivedAt);
    if (heldIndents !== undefined) p = withIndentsFeed(p, heldIndents.feed, heldIndents.receivedAt);
    if (heldAssignments !== undefined) p = withAssignmentsFeed(p, heldAssignments.feed, heldAssignments.receivedAt);
    if (heldTemplates !== undefined) p = withPublishedTemplates(p, heldTemplates.feed, heldTemplates.receivedAt);
    return p;
  };
  const storePackSource = headOfficeStoreId === undefined ? null : httpStorePackSource({ baseUrl: cloudUrl, token: cloudToken, storeId: headOfficeStoreId, fetch: cloudFetch });
  let lastStorePackStatus: StorePackPullStatus | undefined;
  const refreshStorePack = storePackSource === null || headOfficeStoreId === undefined ? null : async (): Promise<StorePackPullOutcome> => {
    const outcome = await pullStorePack({
      source: storePackSource, signer, now: new Date().toISOString(),
      receiver: {
        tenantId, storeId: headOfficeStoreId,
        held: () => heldStorePack,
        take: async (env, receivedAt) => {
          try {
            await writeHeldStorePack(settings['EDGE_DATA_DIR']!, env);
          } catch (e) {
            say(`the new store setup could not be saved to disk (${e instanceof Error ? e.message : String(e)}). It is in use now and will be pulled again next time.`);
          }
          heldStorePack = env;
          const zoneBefore = zoneNow();
          pack = withHeldFeeds(readPack(packPayloadOf(env), receivedAt));
          const zoneAfter = zoneNow();
          if (zoneAfter.needsAttention && (!zoneBefore.needsAttention || zoneBefore.shopTimeZone !== zoneAfter.shopTimeZone)) say(`TIME ZONE: ${zoneAfter.staffMessage}`);
        },
        // PA-06-r1: the same setup signed again — keep the renewed envelope (version, issue, expiry); nothing is rebuilt.
        renew: async (env) => {
          try {
            await writeHeldStorePack(settings['EDGE_DATA_DIR']!, env);
          } catch (e) {
            say(`the renewed store setup could not be saved to disk (${e instanceof Error ? e.message : String(e)}). It is in use now and will be pulled again next time.`);
          }
          heldStorePack = env;
        },
      },
    });
    if (outcome.status === 'updated' || (outcome.status !== 'unchanged' && outcome.status !== lastStorePackStatus)) say(outcome.staffMessage);
    lastStorePackStatus = outcome.status;
    // OB-87 "A": head office ANSWERED with its latest setup (new, re-signed or the very one held) — so the pack now carries
    // head office's bankedThrough, and a box numbering under a fresh prefix after a restore goes back to the ordinary rule,
    // above what head office holds. An offline, refused or not-set-up answer keeps the fresh prefix.
    if (receiptNumbers !== null && (outcome.status === 'updated' || outcome.status === 'renewed' || outcome.status === 'unchanged')) {
      if (await receiptNumbers.headOfficeConfirmed(`head office's store setup ${outcome.heldVersion ?? '?'} arrived (${outcome.status})`)) {
        say('this store computer had been restored from a backup and was numbering bills under a brand-new prefix; head office\'s latest setup has arrived, so it now numbers above the last bill head office holds.');
      }
    }
    return outcome;
  };
  // OB-87 "A": a box that found its data restored asks head office for its latest setup at once, not on the first sync pass
  // (never in the way of a sale — it sells under its fresh prefix meanwhile).
  if (refreshStorePack !== null && receiptNumbers !== null && receiptNumbers.restoreState().held) {
    say(`this store computer's data looks restored from a backup (${receiptNumbers.restoreState().because ?? 'possible restore'}); it numbers bills under a brand-new prefix until head office's latest setup arrives.`);
    void refreshStorePack().catch(() => undefined);
  }

  // DF-3-b-2 (SF-08 hand-over): tell head office which catalogue and which setup this box trades on, whenever that changes.
  const reportHeld = headOfficeStoreId === undefined ? null : httpHeldVersionsReporter({ baseUrl: cloudUrl, token: cloudToken, storeId: headOfficeStoreId, fetch: cloudFetch });
  // PA-04: with how many records it still holds unsent — head office will not let the branch close permanently over them,
  // and will not take an OLD count as current: it is re-said, unchanged, at least every half of the store's own
  // staleness limit (the setting head office judges it by), so a box that is online never reads as stale.
  let lastReportedHeld: string | undefined;
  let lastReportedAtMs = 0;
  const reportHeldVersions = reportHeld === null ? null : async (): Promise<boolean> => {
    const held = { catalogueVersion: node.pack()?.snapshot.version ?? null, storePackVersion: heldStorePack?.version ?? null, unsentItems: unsentAcrossAllQueues() };
    const key = JSON.stringify(held);
    const staleAfterSeconds = pack.policies.known ? pack.policies.value.staleAfterSeconds : undefined;
    const due = staleAfterSeconds !== undefined && Date.now() - lastReportedAtMs >= (staleAfterSeconds * 1000) / 2;
    if (key === lastReportedHeld && !due) return true;
    const ok = await reportHeld(held);
    if (ok) { lastReportedHeld = key; lastReportedAtMs = Date.now(); }
    return ok;
  };

  // EA-01: after each pass, each queue's watermark goes to head office — the owner's freshness, from the box's own word.
  const watermarkStoreId = (settings['EDGE_STORE_ID'] ?? '').trim() || undefined;
  const reportWatermarks = watermarkStoreId === undefined ? null : httpSyncWatermarkReporter({ baseUrl: cloudUrl, token: cloudToken, storeId: watermarkStoreId, fetch: cloudFetch });
  const reportSyncWatermarks = reportWatermarks === null ? null : async (): Promise<boolean> => {
    const named: readonly (readonly [string, SyncAgent])[] = [
      ['sales', agent], ['refunds', returnsAgent], ['completions', completionsAgent], ['day_close', dayCloseAgent],
      ['concession_tags', concessionTagsAgent], ['device_events', deviceEventsAgent], ['till_cash', tillCashAgent],
    ];
    const report: SyncWatermarkReport = {
      observedAt: new Date().toISOString(),
      domains: named.map(([domain, a]) => {
        const h = a.health();
        return { domain, completeThrough: h.completeThrough, unsent: h.unsentCount, deadLettered: h.deadLetterCount };
      }),
    };
    return reportWatermarks(report);
  };
  // M35-FR-03: after each pass the box's own health goes to head office too — its disk (can it record the next sale, by
  // its own rule), its queues' depth and its tills' latest device reports. The store is the credential's (OB-54).
  const boxHealthReporter = watermarkStoreId === undefined ? null : httpBoxHealthReporter({ baseUrl: cloudUrl, token: cloudToken, storeId: watermarkStoreId, fetch: cloudFetch });
  const reportBoxHealth = boxHealthReporter === null ? null : async (): Promise<boolean> => {
    // Round 25 · OB-93 (verifier r24 NEW-1): every await first (the filesystem, the sales log's size, the witness folder),
    // then the queues' counts and the per-prefix lists in ONE synchronous step (`boxHealthReportOf`) — a sale committed while
    // the report is made is in both or neither, so an honest report never contradicts its own queue.
    const report: BoxHealthReport = await boxHealthReportOf({
      now: () => new Date().toISOString(),
      // R3 · P-08: this machine's zone against the shop's — told to head office as well as said on the box's screens.
      zone: zoneNow,
      // §31.1 · OB-403 "A": this box's clock against head office's, and what it is holding while 5+ minutes out.
      clock: () => ({ check: clockGuard.check(), hold: activationHoldNow(new Date().toISOString()) }),
      disk: async () => {
        const fsInfo = await statfs(settings['EDGE_DATA_DIR']!);
        return {
          freeBytes: Number(fsInfo.bavail) * Number(fsInfo.bsize), totalBytes: Number(fsInfo.blocks) * Number(fsInfo.bsize),
          salesLogUsedBytes: await log.usedBytes(), salesLogCapacityBytes: log.capacityBytes, reserveBytes: SALE_RESERVE_BYTES,
        };
      },
      queues: () => [agent, returnsAgent, completionsAgent, dayCloseAgent, concessionTagsAgent, deviceEventsAgent, tillCashAgent].map((a) => a.health()),
      // What the tills' devices last said (kept on this disk); the cashier who sent it stays on the box. `attended`: is
      // anybody signed in at that till now (P-08) — a signed-in till re-sends its devices every 5 minutes, an unattended
      // one stops, so head office can say whether a stale lane is expected (nobody there) or a till to check.
      tills: () => (peripheralReports?.latest() ?? []).map((r) => ({
        laneId: r.laneId, reportedAt: r.reportedAt, devices: r.devices,
        // Round 15: the device adapter's own last-observed time, when the till sent it — head office ages the lane by it.
        ...(r.adapterObservedAt === undefined ? {} : { adapterObservedAt: r.adapterObservedAt }),
        attended: (tillOperators?.live() ?? []).some((s) => s.laneId === r.laneId),
      })),
      // Verifier r18 item 6: the highest count GIVEN per bill-number prefix (a voided bill keeps its number) — head office
      // keeps a replaced box above it. r20 LOST-1: with each prefix, the bills under it still waiting in this box's sales and
      // refund queues; r21: with when the oldest of them was made, and the bills this box GAVE UP sending (its dead letters).
      // Round 25 · OB-94: and the numbers it gave and never put on a bill (`unused`) — never "never received".
      ...(receiptNumbers === null ? {} : {
        issued: () => receiptNumbers.issuedThrough(),
        pending: () => [...outbox.pending(), ...returnsOutbox.pending()].map((i) => ({ payload: i.event.payload, occurredAt: i.event.occurredAt })),
        deadLetters: () => [...outbox.deadLetters(), ...returnsOutbox.deadLetters()].map((i) => ({ payload: i.event.payload, occurredAt: i.event.occurredAt })),
        // Verifier r19 OB87-1: the box's own check of its bill-number witness (and a held restore) — head office shows it on
        // the store computer's health (`box_bill_numbers:<store>`), so a box with no witness is never a silent ZZ every boot.
        billNumbering: () => receiptNumbers.witnessHealth(),
      }),
    });
    return boxHealthReporter(report);
  };

  let stopping = false;
  let quietPasses = 0;
  let timer: NodeJS.Timeout | undefined;

  /**
   * Settle a pipeline after a drain: persist anything newly dead-lettered to the durable store, THEN
   * advance the cursor over the finished leading run.
   *
   * The order is the safety property (RR-F06). A dead-letter is on the disk before the cursor is
   * allowed past it, so a crash between the two only means the record is re-queued and re-recorded
   * next start — never lost. Advancing itself is now safe over a durable dead-letter, because the
   * failure is preserved in its own store and restored, visible, on the next boot. A record still
   * pending in the middle holds the cursor exactly as before, so nothing unfinished is stepped over.
   */
  const settleSales = async (at: string): Promise<void> => {
    await salesPipeline.persistNewDeadLetters(at);
    await salesPipeline.advanceCursor();
  };
  const settleReturns = async (at: string): Promise<void> => {
    await returnsPipeline.persistNewDeadLetters(at);
    await returnsPipeline.advanceCursor();
  };
  const settleCompletions = async (at: string): Promise<void> => {
    await completionsPipeline.persistNewDeadLetters(at);
    await completionsPipeline.advanceCursor();
  };
  const settleDayClose = async (at: string): Promise<void> => {
    await dayClosePipeline.persistNewDeadLetters(at);
    await dayClosePipeline.advanceCursor();
  };
  const settleConcessionTags = async (at: string): Promise<void> => {
    await concessionTagsPipeline.persistNewDeadLetters(at);
    await concessionTagsPipeline.advanceCursor();
  };
  const settleDeviceEvents = async (at: string): Promise<void> => {
    await deviceEventsPipeline.persistNewDeadLetters(at);
    await deviceEventsPipeline.advanceCursor();
  };
  const settleTillCash = async (at: string): Promise<void> => {
    await tillCashPipeline.persistNewDeadLetters(at);
    await tillCashPipeline.advanceCursor();
  };

  /**
   * One drain of both queues, each settled straight after: sales drain, sales settle (persist any
   * new dead-letter, then advance the sales cursor), then the same for refunds. The refund queue
   * drains right after the sale queue, on the same loop and just as far from the sale path — its own
   * drain, its own cursor, so a refund that cannot get through never holds a sale.
   *
   * Exposed as `syncOnce` so a test can drive exactly one pass deterministically, the same way
   * `refreshPack` drives one inbound pull — the timer-based `pass` below is the only other caller.
   */
  const drainAndSettle = async (opts?: { readonly limit?: number }): Promise<{ sent: number; dead: number; remaining: number; signInLog?: { sent: number; dead: number; remaining: number } }> => {
    // OB-429: with the box's login refused nothing is attempted, so no queued item spends its retry budget on it.
    if (boxLogin.state().refused) return { sent: 0, dead: 0, remaining: queuesNow().reduce((n, q) => n + q.unsentCount, 0) };
    const at = new Date().toISOString();
    const result = await agent.drain({ at, ...(opts?.limit === undefined ? {} : { limit: opts.limit }) });
    await settleSales(at);
    const returnsResult = await returnsAgent.drain({ at, ...(opts?.limit === undefined ? {} : { limit: opts.limit }) });
    await settleReturns(at);
    // The completion queue drains right after the refund queue, on the same loop and just as far from
    // the sale path — its own drain, its own cursor, so a completion that cannot get through never holds
    // a sale or a refund.
    const completionsResult = await completionsAgent.drain({ at, ...(opts?.limit === undefined ? {} : { limit: opts.limit }) });
    await settleCompletions(at);
    // The day-close queue drains right after the completion queue, on the same loop and just as far from
    // the sale path — its own drain, its own cursor.
    const dayCloseResult = await dayCloseAgent.drain({ at, ...(opts?.limit === undefined ? {} : { limit: opts.limit }) });
    await settleDayClose(at);
    // The concession-tag queue drains last, on the same loop and just as far from the sale path — its own
    // drain, its own cursor.
    const concessionTagsResult = await concessionTagsAgent.drain({ at, ...(opts?.limit === undefined ? {} : { limit: opts.limit }) });
    await settleConcessionTags(at);
    // The device-events queue drains last (SP-2a), on the same loop and just as far from the sale path — its own
    // drain, its own cursor.
    const deviceEventsResult = await deviceEventsAgent.drain({ at, ...(opts?.limit === undefined ? {} : { limit: opts.limit }) });
    await settleDeviceEvents(at);
    // The till-cash queue drains last (SP-4c), on the same loop and just as far from the sale path — its own drain, its
    // own cursor, so a float or a close head office is slow to take never holds a sale.
    const tillCashResult = await tillCashAgent.drain({ at, ...(opts?.limit === undefined ? {} : { limit: opts.limit }) });
    await settleTillCash(at);
    // OB-365: the till sign-in log drains after the trading queues, on the same loop and just as far from the sale path;
    // said on its own (never mixed into what the trading queues sent), its refusals kept on its own dead-letter file.
    const signInResult = signInRelayAgent === null || signInRelay === null ? null : await signInRelayAgent.drain({ at, ...(opts?.limit === undefined ? {} : { limit: opts.limit }) });
    if (signInRelay !== null) { await signInRelay.persistNewDeadLetters(at); await signInRelay.advanceCursor(); }
    if (signInResult !== null && (signInResult.acknowledged > 0 || signInResult.deadLettered > 0)) {
      say(`sync: ${signInResult.acknowledged} till sign-in record(s) sent, ${signInResult.deadLettered} needing a person, ${signInResult.remaining} waiting`);
    }
    return {
      ...(signInResult === null ? {} : { signInLog: { sent: signInResult.acknowledged, dead: signInResult.deadLettered, remaining: signInResult.remaining } }),
      sent: result.acknowledged + returnsResult.acknowledged + completionsResult.acknowledged + dayCloseResult.acknowledged + concessionTagsResult.acknowledged + deviceEventsResult.acknowledged + tillCashResult.acknowledged,
      dead: result.deadLettered + returnsResult.deadLettered + completionsResult.deadLettered + dayCloseResult.deadLettered + concessionTagsResult.deadLettered + deviceEventsResult.deadLettered + tillCashResult.deadLettered,
      remaining: result.remaining + returnsResult.remaining + completionsResult.remaining + dayCloseResult.remaining + concessionTagsResult.remaining + deviceEventsResult.remaining + tillCashResult.remaining,
    };
  };

  const pass = async (): Promise<void> => {
    // OB-429: head office refused the box's own login — no call is made at all until the box is restarted with a renewed one.
    if (boxLogin.state().refused) {
      if (!stopping) timer = setTimeout(() => { void pass(); }, MAX_INTERVAL_MS);
      return;
    }
    // Sequential by construction: the next pass is scheduled only after this one returns, so two
    // drains can never run at once.
    try {
      const { sent, dead, remaining } = await drainAndSettle();
      quietPasses = sent > 0 ? 0 : quietPasses + 1;
      if (sent > 0 || dead > 0) {
        say(`sync: ${sent} sent, ${dead} needing a person, ${remaining} waiting`);
      }
    } catch (e) {
      // A drain that throws is a bug, not a lost sale — the outbox still holds everything. Say so
      // and keep the loop alive, because a dead sync loop is a shop that silently stops syncing.
      quietPasses += 1;
      say(`sync pass failed: ${e instanceof Error ? e.message : String(e)}. Everything is still queued.`);
    }
    if (reportSyncWatermarks !== null) {
      try { await reportSyncWatermarks(); } catch { /* retried next pass; head office's last report simply ages, and the owner sees it stale */ }
    }
    if (reportBoxHealth !== null) {
      try { await reportBoxHealth(); } catch { /* retried next pass; head office's last report ages into stale by itself */ }
    }
    // The inbound refresh rides the SAME loop, AFTER the drain and just as far from the sale path
    // (hard rule #1). It never throws — an unreachable cloud is a normal answer that keeps the last
    // pack — but a disk error persisting a new pack is caught inside `refreshPack`, so this cannot
    // stop the loop either.
    if (refreshStorePack !== null) {
      try {
        await refreshStorePack();
      } catch (e) {
        say(`store setup refresh failed: ${e instanceof Error ? e.message : String(e)}. This box keeps the setup it has.`);
      }
    }
    try {
      await refreshPack();
    } catch (e) {
      say(`catalogue refresh failed: ${e instanceof Error ? e.message : String(e)}. Still on the last pack this box trusted.`);
    }
    if (reportHeldVersions !== null) {
      try { await reportHeldVersions(); } catch { /* said nowhere on purpose: retried next pass, and head office shows the store as not reported */ }
    }
    // The migration register rides the same loop, after the catalogue, for the same reasons (C3b).
    try {
      await refreshMigrationFeed();
    } catch (e) {
      say(`migration register refresh failed: ${e instanceof Error ? e.message : String(e)}. The screen keeps the register this box holds.`);
    }
    // The published templates ride the same loop too (M01-FR-02) — the lanes keep what this box holds on a failure.
    try {
      await refreshPublishedTemplates();
    } catch (e) {
      say(`document template refresh failed: ${e instanceof Error ? e.message : String(e)}. The lanes keep the templates this box holds.`);
    }
    // SP-8c: the floor indents ride the same loop too — the handheld keeps what this box holds on a failure.
    try {
      await refreshIndentsFeed();
    } catch (e) {
      say(`floor indents refresh failed: ${e instanceof Error ? e.message : String(e)}. The handheld keeps the indents this box holds.`);
    }
    // OB-288 lane 2 · P2: the store's work feeds too — the screens keep what this box holds on a failure.
    try {
      await refreshWorkFeeds();
    } catch (e) {
      say(`the store's work refresh failed: ${e instanceof Error ? e.message : String(e)}. The screens keep what this box holds.`);
    }
    // PF-13: the counters' agreement terms too — the counters keep what this box holds on a failure.
    try {
      await refreshConcessionTrading();
    } catch (e) {
      say(`partner counter agreements refresh failed: ${e instanceof Error ? e.message : String(e)}. The counters keep what this box holds.`);
    }
    // PF-09 step 3: the loyalty balances ride the same loop too — the till keeps what this box holds on a failure.
    try {
      await refreshLoyaltyWallets();
    } catch (e) {
      say(`loyalty balances refresh failed: ${e instanceof Error ? e.message : String(e)}. The till keeps the balances this box holds.`);
    }
    // HA-1: the assignments ride the same loop too — the phones keep what this box holds on a failure.
    if (refreshAssignmentsFeed !== null) {
      try {
        await refreshAssignmentsFeed();
      } catch (e) {
        say(`assignments refresh failed: ${e instanceof Error ? e.message : String(e)}. The phones keep the assignments this box holds.`);
      }
    }
    if (!stopping) timer = setTimeout(() => { void pass(); }, nextInterval(quietPasses));
  };

  timer = setTimeout(() => { void pass(); }, BASE_INTERVAL_MS);

  return {
    log,
    returnsLog,
    completionsLog,
    dayCloseLog,
    concessionTagsLog,
    deviceEventsLog,
    tillCashLog,
    outbox,
    returnsOutbox,
    completionsOutbox,
    dayCloseOutbox,
    concessionTagsOutbox,
    deviceEventsOutbox,
    tillCashOutbox,
    node,
    lane,
    screens,
    devices,
    enrolments,
    agent,
    returnsAgent,
    completionsAgent,
    dayCloseAgent,
    concessionTagsAgent,
    deviceEventsAgent,
    tillCashAgent,
    closeDay,
    reopenDay,
    recordCashMovement,
    closeShift,
    tillCash,
    refreshPack,
    refreshMigrationFeed,
    refreshPublishedTemplates,
    refreshIndentsFeed,
    refreshWorkFeeds,
    clockCheck: () => clockGuard.check(),
    activationHold: () => activationHoldNow(new Date().toISOString()),
    zoneCheck: zoneNow,
    refreshAssignmentsFeed,
    refreshLoyaltyWallets,
    loyaltyWallets,
    refreshConcessionTrading,
    refreshStorePack,
    storeSetup: storeSetupStatus,
    reportHeldVersions,
    reportSyncWatermarks,
    reportBoxHealth,
    syncOnce: () => drainAndSettle(),
    syncStatus,
    stop: async () => {
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      // One last try, then go. Nothing is lost by stopping mid-drain: an unacknowledged item stays
      // pending, which is the whole reason there is an outbox. Sales first, then refunds — both queues
      // get a final drain, both cursors advance over what got through.
      const at = new Date().toISOString();
      try {
        await agent.drain({ at, limit: 20 });
        await settleSales(at);
      } catch { /* still queued, and the cursor stays where it is */ }
      try {
        await returnsAgent.drain({ at, limit: 20 });
        await settleReturns(at);
      } catch { /* still queued, and the returns cursor stays where it is */ }
      try {
        await completionsAgent.drain({ at, limit: 20 });
        await settleCompletions(at);
      } catch { /* still queued, and the completions cursor stays where it is */ }
      try {
        await dayCloseAgent.drain({ at, limit: 20 });
        await settleDayClose(at);
      } catch { /* still queued, and the day-close cursor stays where it is */ }
      try {
        await concessionTagsAgent.drain({ at, limit: 20 });
        await settleConcessionTags(at);
      } catch { /* still queued, and the concession-tags cursor stays where it is */ }
      try {
        await deviceEventsAgent.drain({ at, limit: 20 });
        await settleDeviceEvents(at);
      } catch { /* still queued, and the device-events cursor stays where it is */ }
      try {
        await tillCashAgent.drain({ at, limit: 20 });
        await settleTillCash(at);
      } catch { /* still queued, and the till-cash cursor stays where it is */ }
      const tillCashBadge = tillCashAgent.health();
      if (tillCashBadge.unsentCount > 0) {
        say(`stopping with ${tillCashBadge.unsentCount} till cash record(s) still to send. They are on the disk and will go when this starts again.`);
      }
      const deviceEventsBadge = deviceEventsAgent.health();
      if (deviceEventsBadge.unsentCount > 0) {
        say(`stopping with ${deviceEventsBadge.unsentCount} screen record(s) still to send. They are on the disk and will go when this starts again.`);
      }
      const badge = agent.health();
      const returnsBadge = returnsAgent.health();
      const completionsBadge = completionsAgent.health();
      const dayCloseBadge = dayCloseAgent.health();
      const concessionTagsBadge = concessionTagsAgent.health();
      if (badge.unsentCount > 0) {
        say(`stopping with ${badge.unsentCount} sale(s) still to send. They are on the disk and will go when this starts again.`);
      }
      if (returnsBadge.unsentCount > 0) {
        say(`stopping with ${returnsBadge.unsentCount} refund(s) still to send. They are on the disk and will go when this starts again.`);
      }
      if (completionsBadge.unsentCount > 0) {
        say(`stopping with ${completionsBadge.unsentCount} completion(s) still to send. They are on the disk and will go when this starts again.`);
      }
      if (dayCloseBadge.unsentCount > 0) {
        say(`stopping with ${dayCloseBadge.unsentCount} day close(s) still to send. They are on the disk and will go when this starts again.`);
      }
      if (concessionTagsBadge.unsentCount > 0) {
        say(`stopping with ${concessionTagsBadge.unsentCount} partner-counter line(s) still to send. They are on the disk and will go when this starts again.`);
      }
      if (lane !== null) await lane.stop();
      await stopQueuePosLanes();
      if (screens !== null) await screens.stop();
      if (devices !== null) await devices.stop();
      if (enrolments !== null) await enrolments.close();
      if (receiptNumbers !== null) await receiptNumbers.close();
      if (queueBaskets !== null) await queueBaskets.close();
      if (heldBills !== null) await heldBills.close();
      if (payments !== null) await payments.close();
      if (peripheralReports !== null) await peripheralReports.close();
      await eveningCheckBox.close();
      await log.close();
      await returnsLog.close();
      await completionsLog.close();
      await dayCloseLog.close();
      await deadLetterLog.close();
      await returnsDeadLetterLog.close();
      await completionsDeadLetterLog.close();
      await dayCloseDeadLetterLog.close();
      await concessionTagsLog.close();
      await concessionTagsDeadLetterLog.close();
      await deviceEventsLog.close();
      await deviceEventsDeadLetterLog.close();
      await tillCashLog.close();
      await tillCashDeadLetterLog.close();
      await signInRelayFiles?.log.close();
      await signInRelayFiles?.dead.close();
    },
  };
}
