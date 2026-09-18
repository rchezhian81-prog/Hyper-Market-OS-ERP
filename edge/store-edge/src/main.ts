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
import { openFileLog, readLog, type OpenFileLog } from './file-log';
import { readSignedPack, writeSignedPack } from './signed-pack-file';
import { SyncPipeline } from './sync-pipeline';
import { canonicalHash, IdempotencyGuard } from './idempotency';
import { ReturnEntitlement, type EntitlementLine } from './entitlement';
import { buildReceiptLookup } from './receipt-lookup';
import { returnIdOf } from './cloud-return';
import { createEdgeNode, type EdgeNode } from './index';
import { startLaneServer, LANE_HOST, type LaneServer, type LaneDayCloseHandler, type LaneDayReopenHandler } from './lane-server';
import { startScreenServer, SCREEN_HOST, type ScreenServer } from './screen-server';
import { readSales } from './read-model';
import { emptyPack, readPack, type StorePack } from './store-pack';
import { managerPayload, type ScreenInput } from './screen-data';
import { hmacSigner } from '../../../services/catalogue/src/index';
import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import { closeDay as decideDayClose, reopenDay as decideReopenDay } from '../../../packages/day-close/src/day-close';
import { toCloudSale } from './cloud-sale';
import { toCloudReturn } from './cloud-return';
import { toCloudChecklist, toCloudTaskCompletion, checklistIdOf, taskIdOf } from './cloud-completion';
import { makeTradingDayRule, tradingDate, type TradingDayRule } from '../../../packages/calendar/src/trading-day';
import { readFile } from 'node:fs/promises';

/** The returns pipeline's own cursor file, so the sale and refund logs advance independently. */
const RETURNS_CURSOR = 'sync-cursor-returns';

/** The completions pipeline's own cursor file (M25-FR-02), so the third log advances independently too. */
const COMPLETIONS_CURSOR = 'sync-cursor-completions';

/** The store/day-close pipeline's own cursor file (M14-FR-04), so the fourth log advances independently. */
const DAYCLOSE_CURSOR = 'sync-cursor-day-close';

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
   * The DAY-CLOSE's own durable log — a separate file from the other three (M14-FR-04). A trading day
   * the box locked is durable before it is called done, and kept out of the other logs so each
   * pipeline's restart re-queue only ever reads its own kind of record.
   */
  readonly dayCloseLog: OpenFileLog;
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
  /** The day-close pipeline's own outbox — drained by `dayCloseAgent`, cursored separately again. */
  readonly dayCloseOutbox: SyncOutbox;
  /** What a lane talks to: price a scan, commit a sale, commit a refund, take a new pack. */
  readonly node: EdgeNode;
  /** Null when no cloud is configured — which is a supported way to run, not a fault. */
  readonly agent: SyncAgent | null;
  /** The return pipeline's own sync agent (same transport, own outbox). Null when no cloud. */
  readonly returnsAgent: SyncAgent | null;
  /** The completion pipeline's own sync agent (same transport, own outbox). Null when no cloud. */
  readonly completionsAgent: SyncAgent | null;
  /** The day-close pipeline's own sync agent (same transport, own outbox). Null when no cloud. */
  readonly dayCloseAgent: SyncAgent | null;
  /**
   * Close and LOCK the store's trading day on the box (M14-FR-04) — the authoritative close, because
   * the "no unsent items" gate can only be evaluated where the outbox lives. Reads the box's LIVE state
   * (all outbox depths + the exception register), hands the tested engine the real numbers, and on
   * success writes the locked day durably and queues it for the cloud. Refuses (with a reason) when the
   * trading day has not ended, an exception is open, an item is unsent, or the register was never
   * checked. Available with or without a cloud — the day locks locally regardless (P-01).
   */
  readonly closeDay: (
    req: { readonly dayCloseId: string; readonly closedBy: string },
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
    req: { readonly dayCloseId: string; readonly reopenedBy: string; readonly reason: string; readonly approvedBy: string },
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
   * Run exactly one drain-and-settle of both queues (sales then refunds), returning what moved.
   * Null when no cloud is configured — there is nothing to drain to. The poll loop calls the same
   * core on its timer; this is exposed so a test can drive one pass deterministically, and so an
   * operator tool can force a sync now rather than waiting for the next interval.
   */
  readonly syncOnce: (() => Promise<{ sent: number; dead: number; remaining: number }>) | null;
  /**
   * Where the six screens are served from, or null when `EDGE_SCREEN_PORT` is unset.
   *
   * Optional because a lane box and the back-office box run the same process: a till does not need
   * to serve the owner's brief, and not opening a socket is better than opening one nobody uses.
   */
  readonly screens: ScreenServer | null;
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
        payload: toCloudSale(parsed, restoredPackVersion),
      });
    },
  });
  const returnsPipeline = new SyncPipeline({
    dataDir: settings['EDGE_DATA_DIR']!, log: returnsLog, deadLetterLog: returnsDeadLetterLog,
    cursorFile: RETURNS_CURSOR, noun: 'refund', say,
    eventFor: (record, index) => {
      let parsed: unknown;
      try { parsed = JSON.parse(record) as unknown; } catch { return undefined; }
      const cloud = toCloudReturn(parsed);
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
        payload: completionKind === 'checklist' ? toCloudChecklist(body) : toCloudTaskCompletion(body),
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

  const salesRestore = await salesPipeline.restore();
  const returnsRestore = await returnsPipeline.restore();
  const completionsRestore = await completionsPipeline.restore();
  const dayCloseRestore = await dayClosePipeline.restore();
  const outbox = salesPipeline.outbox;
  const returnsOutbox = returnsPipeline.outbox;
  const completionsOutbox = completionsPipeline.outbox;
  const dayCloseOutbox = dayClosePipeline.outbox;

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
  const lanePort = settings['EDGE_LANE_PORT'];
  const lane = lanePort === undefined ? null : await startLaneServer({
    node,
    port: Number(lanePort),
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
      tradingDay: tradingDate(now.slice(0, 16), packCutoff(pack)),
      ...(heldCatalogue === undefined ? {} : { cataloguePack: heldCatalogue }),
    };
  };

  const screenPort = settings['EDGE_SCREEN_PORT'];
  const screens = screenPort === undefined ? null : await startScreenServer({
    port: Number(screenPort),
    appsDir: settings['EDGE_APPS_DIR'] ?? 'apps',
    snapshot,
    // The manager's day close (M14-FR-04) posts to this box's lane socket — tell the screen where it is.
    // Only when this box actually serves a lane; otherwise the screen stays read-only (a local preview).
    ...(lane === null ? {} : { laneWriteBase: `http://${LANE_HOST}:${lane.port}` }),
  });
  if (screens !== null) {
    say(`screens on ${SCREEN_HOST}:${screens.port} — loopback only, so nothing on the shop network can read the day's takings`);
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
    req: { readonly dayCloseId: string; readonly closedBy: string },
  ): Promise<
    | { readonly closed: true; readonly tradingDay: string; readonly locked: true }
    | { readonly closed: false; readonly reason: string }
  > => {
    const input = snapshot();
    const rule = packCutoff(input.pack);
    // The day being closed is the most-recently-ENDED trading day: the previous trading date relative
    // to now. The engine refuses to close a day whose cut-off has not passed (currentTradingDate must
    // be later than the day closed), so closing the previous date is the only one that can succeed.
    const currentTradingDate = tradingDate(input.now.slice(0, 16), rule);
    const dayToClose = ((): string => {
      const dt = new Date(`${currentTradingDate}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() - 1);
      return dt.toISOString().slice(0, 10);
    })();
    // LIVE unsent across ALL pipelines — not the manager screen's `unsentItems`, which counts only the
    // sales outbox. A day must not lock while any refund or completion is still unsent (hard rule #10).
    const unsentSyncItems = outbox.pending().length + returnsOutbox.pending().length
      + completionsOutbox.pending().length + dayCloseOutbox.pending().length;
    // The exception register EXACTLY as the manager screen computes it (so the box and the screen agree).
    // ABSENT (no loss-prevention rules → nobody is watching) is a hard block, never treated as zero.
    const openExceptions = managerPayload(input)['openExceptions'];
    if (openExceptions === undefined) {
      return { closed: false, reason: 'the day cannot close: this box has no loss-prevention rules, so its exception register was never checked' };
    }
    const unresolvedExceptions = (openExceptions as readonly unknown[]).length;

    // Gate-check with the tested engine (a throwaway outbox — the durable write + enqueue below is what
    // survives a restart, so we do not use the engine's own enqueue here). A blocker throws; surface it.
    try {
      decideDayClose({
        id: req.dayCloseId, storeId: tenantId, tradingDay: dayToClose, closedBy: req.closedBy,
        closedAtLocal: input.now.slice(0, 16), closedAt: input.now, tradingDayRule: rule,
        unresolvedExceptions, unsentSyncItems,
      }, new SyncOutbox());
    } catch (e) {
      return { closed: false, reason: e instanceof Error ? e.message : String(e) };
    }

    // Durable-write-then-enqueue, the same order as every other seam: the locked day is on the disk
    // before it is called done, then queued. `dayCloseEventFrom` re-mints the identical event on restart.
    const record = JSON.stringify({
      dayCloseId: req.dayCloseId, storeId: tenantId, tradingDay: dayToClose,
      closedBy: req.closedBy, closedAt: input.now, locked: true,
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
    req: { readonly dayCloseId: string; readonly reopenedBy: string; readonly reason: string; readonly approvedBy: string },
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
    const record = JSON.stringify({
      dayCloseId: req.dayCloseId, storeId: tenantId, tradingDay: close.tradingDay,
      reopenedBy: req.reopenedBy, approvedBy: req.approvedBy, reason: req.reason, reopenedAt: now,
    });
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
    return {
      log, returnsLog, completionsLog, dayCloseLog, outbox, returnsOutbox, completionsOutbox, dayCloseOutbox, node, lane, screens,
      agent: null, returnsAgent: null, completionsAgent: null, dayCloseAgent: null, refreshPack: null, syncOnce: null,
      // The day still locks with no cloud — that is the point of P-01. It queues durably and goes up when
      // a cloud is configured and reachable; nothing is told a lie in the meantime. Reopen is the same.
      closeDay,
      reopenDay,
      stop: async () => {
        if (lane !== null) await lane.stop();
        if (screens !== null) await screens.stop();
        await log.close();
        await returnsLog.close();
        await completionsLog.close();
        await dayCloseLog.close();
        await deadLetterLog.close();
        await returnsDeadLetterLog.close();
        await completionsDeadLetterLog.close();
        await dayCloseDeadLetterLog.close();
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

  // The INBOUND mirror of the agent: the same cloud, the other direction (SYNC-01). It fetches the
  // signed catalogue pack; the lane decides whether to trust it (via `node.takePack`); a newer,
  // verified pack is adopted and persisted atomically so it survives a reboot.
  const packSource = httpPackSource({ baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch });
  let lastPackStatus: PackPullStatus | undefined;

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
    return outcome;
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
    return {
      sent: result.acknowledged + returnsResult.acknowledged + completionsResult.acknowledged + dayCloseResult.acknowledged,
      dead: result.deadLettered + returnsResult.deadLettered + completionsResult.deadLettered + dayCloseResult.deadLettered,
      remaining: result.remaining + returnsResult.remaining + completionsResult.remaining + dayCloseResult.remaining,
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
    // The inbound refresh rides the SAME loop, AFTER the drain and just as far from the sale path
    // (hard rule #1). It never throws — an unreachable cloud is a normal answer that keeps the last
    // pack — but a disk error persisting a new pack is caught inside `refreshPack`, so this cannot
    // stop the loop either.
    try {
      await refreshPack();
    } catch (e) {
      say(`catalogue refresh failed: ${e instanceof Error ? e.message : String(e)}. Still on the last pack this box trusted.`);
    }
    if (!stopping) timer = setTimeout(() => { void pass(); }, nextInterval(quietPasses));
  };

  timer = setTimeout(() => { void pass(); }, BASE_INTERVAL_MS);

  return {
    log,
    returnsLog,
    completionsLog,
    dayCloseLog,
    outbox,
    returnsOutbox,
    completionsOutbox,
    dayCloseOutbox,
    node,
    lane,
    screens,
    agent,
    returnsAgent,
    completionsAgent,
    dayCloseAgent,
    closeDay,
    reopenDay,
    refreshPack,
    syncOnce: () => drainAndSettle(),
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
      const badge = agent.health();
      const returnsBadge = returnsAgent.health();
      const completionsBadge = completionsAgent.health();
      const dayCloseBadge = dayCloseAgent.health();
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
      if (lane !== null) await lane.stop();
      if (screens !== null) await screens.stop();
      await log.close();
      await returnsLog.close();
      await completionsLog.close();
      await dayCloseLog.close();
      await deadLetterLog.close();
      await returnsDeadLetterLog.close();
      await completionsDeadLetterLog.close();
      await dayCloseDeadLetterLog.close();
    },
  };
}
