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
import { returnIdOf } from './cloud-return';
import { createEdgeNode, type EdgeNode } from './index';
import { startLaneServer, LANE_HOST, type LaneServer } from './lane-server';
import { startScreenServer, SCREEN_HOST, type ScreenServer } from './screen-server';
import { readSales } from './read-model';
import { emptyPack, readPack, type StorePack } from './store-pack';
import type { ScreenInput } from './screen-data';
import { hmacSigner } from '../../../services/catalogue/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import { toCloudSale } from './cloud-sale';
import { toCloudReturn } from './cloud-return';
import { makeTradingDayRule, tradingDate, type TradingDayRule } from '../../../packages/calendar/src/trading-day';
import { readFile } from 'node:fs/promises';

/** The returns pipeline's own cursor file, so the sale and refund logs advance independently. */
const RETURNS_CURSOR = 'sync-cursor-returns';

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
   * The loopback socket the lane's screen posts a sale to, or null when this edge has no lane —
   * the back-office box runs the same process and does the shop-wide work (ADR-0004).
   */
  readonly lane: LaneServer | null;
  readonly outbox: SyncOutbox;
  /** The return pipeline's own outbox — drained by `returnsAgent`, cursored separately from sales. */
  readonly returnsOutbox: SyncOutbox;
  /** What a lane talks to: price a scan, commit a sale, commit a refund, take a new pack. */
  readonly node: EdgeNode;
  /** Null when no cloud is configured — which is a supported way to run, not a fault. */
  readonly agent: SyncAgent | null;
  /** The return pipeline's own sync agent (same transport, own outbox). Null when no cloud. */
  readonly returnsAgent: SyncAgent | null;
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

  const salesRestore = await salesPipeline.restore();
  const returnsRestore = await returnsPipeline.restore();
  const outbox = salesPipeline.outbox;
  const returnsOutbox = returnsPipeline.outbox;

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
    // The refund's operation-identity guard, rebuilt from the durable log above (RR-F03).
    returnsIdempotency,
    // The refund's entitlement from trusted local sale + return history (RR-F04).
    returnsEntitlement,
    // The sale's operation-identity guard, rebuilt from the durable log above (GAP-SALE-IDEMPOTENCY-01).
    salesIdempotency,
    ...(restoredPack === undefined ? {} : { initialPack: restoredPack }),
  });

  // The lane socket. Absent `EDGE_LANE_PORT`, this edge has no screen attached and does the
  // shop-wide work instead — which is what the back-office box is.
  const lanePort = settings['EDGE_LANE_PORT'];
  const lane = lanePort === undefined ? null : await startLaneServer({ node, port: Number(lanePort) });
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
  });
  if (screens !== null) {
    say(`screens on ${SCREEN_HOST}:${screens.port} — loopback only, so nothing on the shop network can read the day's takings`);
  }

  const cloudUrl = settings['CLOUD_API_URL'];
  const cloudToken = settings['CLOUD_API_TOKEN'];

  if (cloudUrl === undefined || cloudToken === undefined) {
    // Supported, and said plainly. The lanes sell; the queue grows; nobody is told a lie about it.
    say('no cloud is configured, so nothing will be synced. The shop can still trade — that is the point.');
    return {
      log, returnsLog, outbox, returnsOutbox, node, lane, screens, agent: null, returnsAgent: null, refreshPack: null, syncOnce: null,
      stop: async () => {
        if (lane !== null) await lane.stop();
        if (screens !== null) await screens.stop();
        await log.close();
        await returnsLog.close();
        await deadLetterLog.close();
        await returnsDeadLetterLog.close();
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
    return {
      sent: result.acknowledged + returnsResult.acknowledged,
      dead: result.deadLettered + returnsResult.deadLettered,
      remaining: result.remaining + returnsResult.remaining,
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
    outbox,
    returnsOutbox,
    node,
    lane,
    screens,
    agent,
    returnsAgent,
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
      const badge = agent.health();
      const returnsBadge = returnsAgent.health();
      if (badge.unsentCount > 0) {
        say(`stopping with ${badge.unsentCount} sale(s) still to send. They are on the disk and will go when this starts again.`);
      }
      if (returnsBadge.unsentCount > 0) {
        say(`stopping with ${returnsBadge.unsentCount} refund(s) still to send. They are on the disk and will go when this starts again.`);
      }
      if (lane !== null) await lane.stop();
      if (screens !== null) await screens.stop();
      await log.close();
      await returnsLog.close();
      await deadLetterLog.close();
      await returnsDeadLetterLog.close();
    },
  };
}
