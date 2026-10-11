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
import { returnIdOf } from './cloud-return';
import { createEdgeNode, type EdgeNode } from './index';
import { startLaneServer, LANE_HOST, type LaneServer, type LaneDayCloseHandler, type LaneDayReopenHandler, type LaneDeviceRelayHandler, type LaneDeviceStatusHandler, type LaneTillActivityHandler } from './lane-server';
import { commitLocally } from './durability';
import { readRelayItem, isRelayable, type BoxItemStatus, type DeviceAck } from '../../../packages/sync/src/device-relay';
import { laneSyncStatus, type LaneSyncStatus, type QueueHealth } from './sync-status';
import { startScreenServer, SCREEN_HOST, type ScreenServer } from './screen-server';
import { startDeviceServer, DEVICE_HOST, type DeviceServer } from './device-server';
import { DeviceEnrolments, readPackDevices } from './device-enrolments';
import { TillOperators, loadTillCredentials } from './till-operators';
import { phoneOperatorsOf } from './handheld-sign-in';
import { TillApprovals } from './till-approvals';
import { ReceiptNumbers } from './receipt-numbers';
import { HeldBills } from './held-bills';
import { PaymentAttempts, type PaymentProviderPort } from './payment-attempts';
import { LoyaltyWallets } from './loyalty-wallets';
import { ConcessionTrading } from './concession-trading';
import { pullConcessionTradingFeed, type ConcessionTradingPullOutcome } from '../../sync-agent/src/concession-trading-feed';
import { httpWalletFeedSource, pullWalletFeed, type WalletFeedPullOutcome } from '../../sync-agent/src/loyalty-wallets-feed';
import { peopleFrom, permissionsOf } from './screen-navigation';
import { tillPinKey } from '../../../packages/identity/src/till-pin';
import { sealDecision, sealTillFact, tillSealKey } from '../../../packages/identity/src/till-seal';
import { withDeciderSeal } from './decision-seal';
import { readSales } from './read-model';
import { emptyPack, readPack, withMigrationFeed, withPublishedTemplates, withIndentsFeed, withAssignmentsFeed, type StorePack } from './store-pack';
import { managerPayload, type ScreenInput } from './screen-data';
import { hmacSigner } from '../../../services/catalogue/src/index';
import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import { closeDay as decideDayClose, reopenDay as decideReopenDay } from '../../../packages/day-close/src/day-close';
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
import { makeTradingDayRule, tradingDate, wallClockIn, type TradingDayRule } from '../../../packages/calendar/src/trading-day';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    },
  });
}

/** Gap between drains when the last one delivered something. */
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
export function packCutoff(pack: { readonly policies: { readonly known: boolean; readonly value?: { readonly tradingDayCutoff: string } } }): TradingDayRule {
  return makeTradingDayRule(pack.policies.known ? pack.policies.value!.tradingDayCutoff : '00:00');
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
    },
  ) => Promise<
    | { readonly closed: true; readonly tradingDay: string; readonly locked: true }
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
   * Run exactly one drain-and-settle of both queues (sales then refunds), returning what moved.
   * Null when no cloud is configured — there is nothing to drain to. The poll loop calls the same
   * core on its timer; this is exposed so a test can drive one pass deterministically, and so an
   * operator tool can force a sync now rather than waiting for the next interval.
   */
  readonly syncOnce: (() => Promise<{ sent: number; dead: number; remaining: number }>) | null;
  /**
   * The box's own account of its link to head office (Stage G slice 2 · design system §1 rule 4): cloud
   * reachability, everything unsent across every queue, dead letters, when something last got through. Served
   * read-only on the lane socket as `GET /lane/sync-status`, so the till's and the manager's sync badges show a
   * fact the box knows instead of a constant the shell assumed. Always present — a box with no cloud says so.
   */
  readonly syncStatus: () => LaneSyncStatus;
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
  const unsentAcrossAllQueues = (): number => outbox.pending().length + returnsOutbox.pending().length
    + completionsOutbox.pending().length + dayCloseOutbox.pending().length + concessionTagsOutbox.pending().length
    + deviceEventsOutbox.pending().length + tillCashOutbox.pending().length;

  // Every device-event key this box has EVER taken, rebuilt from the whole durable log — not from the outbox,
  // which after a restart holds only the unfinished tail. A device that lost the box's reply and retries a key
  // the box acknowledged and cursored past weeks ago must still hear `duplicate`, never `accepted` twice (§31.1).
  const deviceEventKeys = new Set<string>();
  for (const entry of await readLog(deviceEventsLog.path)) {
    if (!entry.ok) continue;
    try {
      const key = (JSON.parse(entry.record) as { idempotencyKey?: unknown }).idempotencyKey;
      if (typeof key === 'string' && key !== '') deviceEventKeys.add(key);
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
      const event = withDeciderSeal(sealKey, tenantId, read.item.event, batch.verifiedPerson);
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
  const recordTillActivity: LaneTillActivityHandler = async ({ laneId, cashierId, via, body }) => {
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
        && whole(body['quantityMinor']) && (body['quantityMinor'] as number) > 0 && whole(value) && (value as number) > 0));
    if (!readable) {
      return { recorded: false, refusedBecause: 'not_readable', laneMessage: kind === 'void'
        ? 'The till did not say which line, how much and why. Nothing was removed — try again.'
        : 'The till did not say what was done, to which line, for how much and why. Nothing was done — try again.' };
    }
    const key = `till-activity-${tenantId}-${body['activityId']}`;
    if (deviceEventKeys.has(key)) return { recorded: true, laneMessage: 'Already recorded.' };
    // A SUPERVISOR OVERRIDE (no-sale, price change) needs a manager's approval issued on THIS box for exactly this — the
    // one-use approval refunds use (PF-02) — spent by this action before anything is written. Offline: nothing here asks
    // head office.
    let approval: { readonly approvalId: string; readonly approvedBy: string } | undefined;
    if (kind === 'no_sale' || kind === 'price_override') {
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
    const tradingDay = tradingDate(wallClockIn(at), packCutoff(pack));
    const common = { activityId: body['activityId'], kind, laneId, cashierId, via, reason: (body['reason'] as string).trim(), at, tradingDay };
    const payload = kind === 'void'
      ? { ...common, billRef: body['billRef'], lineId: body['lineId'], productId: body['productId'], description: body['description'], valueMinor: value }
      : kind === 'no_sale'
        ? { ...common, ...(str(body['billRef']) ? { billRef: body['billRef'] } : {}), valueMinor: 0, approvalId: approval!.approvalId, approvedBy: approval!.approvedBy }
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
  const returnsRecords = (await readLog(returnsLog.path)).flatMap((r) => (r.ok ? [r.record] : []));
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
  const syncStatus = (): LaneSyncStatus => syncStatusRelay.current?.()
    ?? laneSyncStatus({ configured: 'starting', queues: queuesNow(), lastPackStatus: undefined, lastContactAt: null, now: new Date().toISOString() });

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
      tradingDay: tradingDate(wallClockIn(req.at), packCutoff(pack)),
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
      tradingDay: tradingDate(wallClockIn(req.closedAt), packCutoff(pack)),
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
  const receiptNumbers = tillOperators === null ? null : await ReceiptNumbers.open({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    published: () => (pack.receiptSeries.known ? pack.receiptSeries.value : null),
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
  // HELD BASKETS (audit PF-05 · M12-FR-02): parked on this box's disk, recalled once, never deleted. The shop's hold
  // policy is the CURRENT pack's; the store is the pack's own.
  const heldBills = tillOperators === null ? null : await HeldBills.open({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']), tenantId,
    policy: () => (pack.suspensionPolicy.known ? pack.suspensionPolicy.value : null),
    storeId: () => (pack.policies.known ? pack.policies.value.storeId : 'this-store'),
  });
  // CARD AND UPI ATTEMPTS (audit PF-06): recorded before the machine is asked; a no-answer settles only against the
  // provider's record — through the provider port, which no live provider fills yet.
  const payments = tillOperators === null ? null : await PaymentAttempts.open({
    dataDir: settings['EDGE_DATA_DIR']!, capacityBytes: Number(settings['EDGE_CAPACITY_BYTES']),
    ...(ports.paymentProvider === undefined ? {} : { provider: ports.paymentProvider }),
  });
  if (tillOperators !== null) {
    say(trustForwardedTillUser
      ? 'till sign-in: the person the hosted sign-in names (EDGE_LANE_TRUST_FORWARDED_USER) — only right behind the hosted front.'
      : `till sign-in: staff ID and till PIN, checked on this box (${tillOperators.live().length} session(s) still open).`);
  }
  const lane = lanePort === undefined ? null : await startLaneServer({
    node,
    port: Number(lanePort),
    syncStatus,
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
    ...(payments === null ? {} : {
      payments: {
        ask: (i) => payments.ask(i),
        answer: (i) => payments.answer(i),
        recover: (i) => payments.recover(i),
        checkTenders: (i) => payments.checkTenders(i),
        status: (laneId) => payments.status(laneId),
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
        tradingDate(wallClockIn(new Date().toISOString()), packCutoff(pack)),
        (pack.policies.known ? pack.policies.value.branchId : undefined) ?? undefined,
      ),
    },
    closeDay: (req) => {
      const fn = dayCloseRelay.current;
      return fn !== undefined ? fn(req) : Promise.resolve({ closed: false as const, reason: 'the box is still starting up — try the day close again in a moment' });
    },
    reopenDay: (req) => {
      const fn = dayReopenRelay.current;
      return fn !== undefined ? fn(req) : Promise.resolve({ reopened: false as const, reason: 'the box is still starting up — try the reopen again in a moment' });
    },
  });
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
      tradingDay: tradingDate(wallClockIn(now), packCutoff(pack)),
      ...(heldCatalogue === undefined ? {} : { cataloguePack: heldCatalogue }),
      ...(payments === null ? {} : { pendingPayments: payments.pending() }),
    };
  };

  const screenPort = settings['EDGE_SCREEN_PORT'];
  const screenHost = settings['EDGE_SCREEN_HOST'];
  const screens = screenPort === undefined ? null : await startScreenServer({
    port: Number(screenPort),
    ...(screenHost === undefined ? {} : { host: screenHost }),
    appsDir: settings['EDGE_APPS_DIR'] ?? 'apps',
    snapshot,
    // Which lane this box is — told to the served till so every sale names it (SP-4b · F09).
    ...(laneOfBox === undefined ? {} : { laneId: laneOfBox }),
    // The manager's day close (M14-FR-04) posts to this box's lane socket — tell the screen where it is.
    // Only when this box actually serves a lane; otherwise the screen stays read-only (a local preview).
    ...(lane === null ? {} : { laneWriteBase: `http://${LANE_HOST}:${lane.port}` }),
    // Behind the hosted front's authenticated relay only (OB-16): the ERP screens run as the person who signed in.
    ...(settings['EDGE_SCREEN_TRUST_FORWARDED_USER'] === '1' ? { trustForwardedUser: true } : {}),
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
  const devices = devicePort === undefined || enrolments === null ? null : await startDeviceServer({
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
  });
  if (devices !== null && enrolments !== null) {
    say(devices.host === DEVICE_HOST || devices.host === 'localhost'
      ? `device socket on ${devices.host}:${devices.port} — loopback only; name EDGE_DEVICE_HOST with the shop's address for the handhelds on the wifi to reach it`
      : `device socket on ${devices.host}:${devices.port} — reachable on the shop network; only handhelds enrolled with a head-office code may use it, and it serves the handheld screens only (ADR-0019)`);
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
    },
  ): Promise<
    | { readonly closed: true; readonly tradingDay: string; readonly locked: true }
    | { readonly closed: false; readonly reason: string }
  > => {
    const input = snapshot();
    const rule = packCutoff(input.pack);
    // Round 4: the day close names the STORE this box is (its setup's store id), not the tenant.
    const storeIdHere = (input.pack.policies.known ? (input.pack.policies.value.storeId ?? input.pack.policies.value.branchId) : undefined) ?? tenantId;
    // The day being closed is the most-recently-ENDED trading day: the previous trading date relative
    // to now. The engine refuses to close a day whose cut-off has not passed (currentTradingDate must
    // be later than the day closed), so closing the previous date is the only one that can succeed.
    const currentTradingDate = tradingDate(wallClockIn(input.now), rule);
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
      if (tradingDate(wallClockIn(state.openedAt), rule) > dayToClose) return [];
      return [{ tillId, custodian: state.custodian, openedAt: state.openedAt }];
    });
    // D04-FR-02 · PF-06 · WF-12: every card/UPI payment asked on or before the day being closed that still has no final
    // answer — read from the box's own payment-attempt log. A payment asked on the NEW day does not hold yesterday.
    const pendingPayments = (payments?.pending() ?? [])
      .filter((a) => tradingDate(wallClockIn(a.askedAt), rule) <= dayToClose)
      .map((a) => ({ attemptId: a.attemptId, laneId: a.laneId, billRef: a.billRef, kind: a.kind, amountMinor: a.amountMinor, askedAt: a.askedAt, state: a.state as 'asked' | 'no_answer' }));

    // Gate-check with the tested engine (a throwaway outbox — the durable write + enqueue below is what
    // survives a restart, so we do not use the engine's own enqueue here). A blocker throws; surface it.
    try {
      decideDayClose({
        id: req.dayCloseId, storeId: storeIdHere, tradingDay: dayToClose, closedBy: (req.closedBy ?? '').trim() || (req.verifiedPerson?.userId ?? 'unconfirmed'),
        closedAtLocal: wallClockIn(input.now), closedAt: input.now, tradingDayRule: rule,
        unresolvedExceptions, unsentSyncItems, openShifts, pendingPayments,
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
    // Durable-write-then-enqueue, the same order as every other seam: the locked day is on the disk
    // before it is called done, then queued. `dayCloseEventFrom` re-mints the identical event on restart.
    const record = JSON.stringify({
      dayCloseId: req.dayCloseId, storeId: storeIdHere, tradingDay: dayToClose,
      closedBy: closer, closedAt: input.now, locked: true,
    });
    await dayCloseLog.append(record);
    const event = dayCloseEventFrom(record, 0);
    if (event !== undefined) dayCloseOutbox.enqueue(event);
    return { closed: true, tradingDay: dayToClose, locked: true };
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
        if (screens !== null) await screens.stop();
        if (devices !== null) await devices.stop();
        if (enrolments !== null) await enrolments.close();
        if (receiptNumbers !== null) await receiptNumbers.close();
        if (heldBills !== null) await heldBills.close();
        if (payments !== null) await payments.close();
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
      },
    };
  }

  const agent = new SyncAgent(outbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch,
  }));
  // The return pipeline's own agent — same transport, its own outbox. A second agent is simpler and
  // safer than teaching one agent about two queues: the sale drain and its cursor stay exactly as they
  // were, and the refund drain sits beside them without ever crossing into the sale path.
  const returnsAgent = new SyncAgent(returnsOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch,
  }));
  // The completion pipeline's own agent (M25-FR-02) — same transport, its own outbox, for the same
  // reason a refund has its own: three small agents beside one another keep each drain and each cursor
  // exactly its own, so a completion that cannot get through never holds a sale or a refund, and none
  // of the three can ever be re-queued as another.
  const completionsAgent = new SyncAgent(completionsOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch,
  }));
  // The day-close pipeline's own agent (M14-FR-04) — same transport, its own outbox, for the same
  // reason each of the others has its own: a day close that cannot get through never holds a sale, a
  // refund or a completion, and none of the four can ever be re-queued as another.
  const dayCloseAgent = new SyncAgent(dayCloseOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch,
  }));
  // The concession-tag pipeline's own agent (M27-FR-03) — same transport, its own outbox, for the same reason
  // each of the others has its own: a partner-counter line that cannot get through never holds a sale, a
  // refund, a completion or a day close, and none of the five can ever be re-queued as another.
  const concessionTagsAgent = new SyncAgent(concessionTagsOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch,
  }));
  // The device-events pipeline's own agent (SP-2a · F11) — same transport, its own outbox, for the same reason each
  // of the others has its own: a decision head office refuses never holds a sale, and none of the six can ever be
  // re-queued as another. The transport's route table addresses each device event type to its re-verifying synced
  // route; a type with no route is dead-lettered by name (visible on the manager's screen as refused, hard rule #6).
  const deviceEventsAgent = new SyncAgent(deviceEventsOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch,
  }));
  // The till-cash pipeline's own agent (SP-4c · F10) — same transport, its own outbox, for the same reason each of the
  // others has its own: a float or a close head office refuses never holds a sale, and none of the seven can ever be
  // re-queued as another. Routed to the cash and shift SYNCED routes, which re-verify the cashier and record-and-flag.
  const tillCashAgent = new SyncAgent(tillCashOutbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch,
  }));

  // The INBOUND mirror of the agent: the same cloud, the other direction (SYNC-01). It fetches the
  // signed catalogue pack; the lane decides whether to trust it (via `node.takePack`); a newer,
  // verified pack is adopted and persisted atomically so it survives a reboot.
  const packSource = httpPackSource({ baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch });
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
  const feedSource = httpMigrationFeedSource({ baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch });
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
  const templatesSource = httpPublishedTemplatesSource({ baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch });
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
  const indentsSource = httpIndentsFeedSource({ baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch });
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
  const assignmentsSource = storeIdOfBox === undefined ? null : httpAssignmentsFeedSource({ baseUrl: cloudUrl, token: cloudToken, storeId: storeIdOfBox, fetch: globalThis.fetch });
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
  const walletsSource = httpWalletFeedSource({ baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch });
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
    baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch, now: new Date().toISOString(),
    receiver: { tenantId, heldFeed: () => concessionTrading.heldFeed(), takeFeed: (feed, receivedAt) => concessionTrading.takeFeed(feed, receivedAt) },
  });

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
  const storePackSource = headOfficeStoreId === undefined ? null : httpStorePackSource({ baseUrl: cloudUrl, token: cloudToken, storeId: headOfficeStoreId, fetch: globalThis.fetch });
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
          pack = withHeldFeeds(readPack(packPayloadOf(env), receivedAt));
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
    return outcome;
  };

  // DF-3-b-2 (SF-08 hand-over): tell head office which catalogue and which setup this box trades on, whenever that changes.
  const reportHeld = headOfficeStoreId === undefined ? null : httpHeldVersionsReporter({ baseUrl: cloudUrl, token: cloudToken, storeId: headOfficeStoreId, fetch: globalThis.fetch });
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
  const reportWatermarks = watermarkStoreId === undefined ? null : httpSyncWatermarkReporter({ baseUrl: cloudUrl, token: cloudToken, storeId: watermarkStoreId, fetch: globalThis.fetch });
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
  const drainAndSettle = async (opts?: { readonly limit?: number }): Promise<{ sent: number; dead: number; remaining: number }> => {
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
    return {
      sent: result.acknowledged + returnsResult.acknowledged + completionsResult.acknowledged + dayCloseResult.acknowledged + concessionTagsResult.acknowledged + deviceEventsResult.acknowledged + tillCashResult.acknowledged,
      dead: result.deadLettered + returnsResult.deadLettered + completionsResult.deadLettered + dayCloseResult.deadLettered + concessionTagsResult.deadLettered + deviceEventsResult.deadLettered + tillCashResult.deadLettered,
      remaining: result.remaining + returnsResult.remaining + completionsResult.remaining + dayCloseResult.remaining + concessionTagsResult.remaining + deviceEventsResult.remaining + tillCashResult.remaining,
    };
  };

  const pass = async (): Promise<void> => {
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
    refreshAssignmentsFeed,
    refreshLoyaltyWallets,
    loyaltyWallets,
    refreshConcessionTrading,
    refreshStorePack,
    storeSetup: storeSetupStatus,
    reportHeldVersions,
    reportSyncWatermarks,
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
      if (screens !== null) await screens.stop();
      if (devices !== null) await devices.stop();
      if (enrolments !== null) await enrolments.close();
      if (receiptNumbers !== null) await receiptNumbers.close();
      if (heldBills !== null) await heldBills.close();
      if (payments !== null) await payments.close();
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
    },
  };
}
