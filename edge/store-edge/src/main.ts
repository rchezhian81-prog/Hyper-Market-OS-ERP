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
import { readCursor, writeCursor, advanceTo } from './sync-cursor';
import { readSignedPack, writeSignedPack } from './signed-pack-file';
import { createEdgeNode, type EdgeNode } from './index';
import { startLaneServer, LANE_HOST, type LaneServer } from './lane-server';
import { startScreenServer, SCREEN_HOST, type ScreenServer } from './screen-server';
import { readSales } from './read-model';
import { emptyPack, readPack, type StorePack } from './store-pack';
import type { ScreenInput } from './screen-data';
import { hmacSigner } from '../../../services/catalogue/src/index';
import { makeEvent } from '../../../packages/contracts/src/event';
import { makeTradingDayRule, tradingDate, type TradingDayRule } from '../../../packages/calendar/src/trading-day';
import { readFile } from 'node:fs/promises';

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
   * The loopback socket the lane's screen posts a sale to, or null when this edge has no lane —
   * the back-office box runs the same process and does the shop-wide work (ADR-0004).
   */
  readonly lane: LaneServer | null;
  readonly outbox: SyncOutbox;
  /** What a lane talks to: price a scan, commit a sale, take a new pack. */
  readonly node: EdgeNode;
  /** Null when no cloud is configured — which is a supported way to run, not a fault. */
  readonly agent: SyncAgent | null;
  /**
   * Pull the latest signed catalogue pack from the cloud now, adopt it if it is newer and verifies,
   * and persist it to disk — the inbound refresh (SYNC-01). Null when no cloud is configured. The
   * poll loop calls this on its own timer; it is exposed so a test can drive one pull deterministically
   * (the same way `agent.drain` is), rather than waiting on the timer.
   */
  readonly refreshPack: (() => Promise<PackPullOutcome>) | null;
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

  // Report what was found on the disk, including anything a power cut left half-written. It is
  // quarantined rather than repaired, and it is said out loud rather than counted silently (#6).
  const found = await readLog(log.path);
  const broken = found.filter((r) => !r.ok);
  say(`store edge ready: ${found.length - broken.length} record(s) on disk, ${await log.usedBytes()} bytes used`);
  if (broken.length > 0) {
    say(`  ${broken.length} record(s) could not be read whole — most likely a power cut mid-write.`);
    say('  They are kept, not repaired: a repaired half-sale is a made-up sale. Raise this.');
  }

  const outbox = new SyncOutbox();
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

  /**
   * Rebuild the queue from the log.
   *
   * The log is the system of record and the queue is a view of it, so a restart reconstructs the
   * view rather than trusting one that died with the process. Everything after the cursor is
   * re-queued; a sale that was mid-flight when the power went is therefore sent again, and the
   * cloud dedupes it (§31.1). Re-sending is cheap; skipping is permanent.
   */
  let handledBefore = await readCursor(settings['EDGE_DATA_DIR']!);
  const whole = found.filter((r) => r.ok).map((r) => (r.ok ? r.record : ''));
  const toResend = whole.slice(handledBefore);
  for (const [i, record] of toResend.entries()) {
    let payload: unknown;
    try { payload = JSON.parse(record) as unknown; } catch { continue; }
    const saleId = (payload as { saleId?: string }).saleId ?? `record-${handledBefore + i}`;
    outbox.enqueue(makeEvent({
      id: `edge-sale-${saleId}`, type: 'SaleCommitted', occurredAt: new Date().toISOString(),
      idempotencyKey: `edge-${tenantId}-${saleId}`, source: 'edge/lane', payload,
    }));
  }
  if (toResend.length > 0) say(`${toResend.length} sale(s) from before are still to send.`);

  const signer = hmacSigner(settings['PACK_SIGNING_KEY']!);

  // The signed catalogue pack this box last accepted, restored from disk and re-verified the same
  // way a lane verifies one over the wire (SYNC-01). So a reboot starts on the last pack it trusted,
  // not a blank catalogue — and a tampered file on disk is rejected, starting from no pack instead.
  const restoredPack = await readSignedPack(settings['EDGE_DATA_DIR']!, signer, tenantId);
  if (restoredPack !== undefined) {
    say(`catalogue pack v${restoredPack.snapshot.version} restored from disk — the last one this box trusted.`);
  }

  const node = createEdgeNode({
    tenantId,
    log,
    signer,
    // The seam. Without it a sale is durable on the disk and never queued, which is exactly how
    // it was: every piece on either side built and tested, nothing joining them, nothing failing.
    outbox,
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
    return {
      pack,
      sales: recordsNow.sales,
      unreadableRecords: recordsNow.unreadable,
      outbox,
      now,
      tradingDay: tradingDate(now.slice(0, 16), packCutoff(pack)),
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
      log, outbox, node, lane, screens, agent: null, refreshPack: null,
      stop: async () => {
        if (lane !== null) await lane.stop();
        if (screens !== null) await screens.stop();
        await log.close();
      },
    };
  }

  const agent = new SyncAgent(outbox, httpTransport({
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
   * Move the cursor over the finished prefix, and persist it.
   *
   * Only a contiguous run counts: a sale still queued, or one that dead-lettered and is now a
   * person's problem, holds the cursor where it is. Stepping over it would mean the next restart
   * never re-queued it, and that sale would be gone with nothing saying so.
   */
  const advanceCursor = async (): Promise<void> => {
    // Read from the OUTBOX, not from the start-up snapshot of the log.
    //
    // The first version folded over the records found on disk at start-up, which meant a sale rung
    // up during this run was not in the list at all — so the cursor never moved and every restart
    // re-sent everything. The outbox holds exactly the right set in exactly the right order: the
    // records re-queued from the log at start, then everything committed since.
    const handledNow = handledBefore + advanceTo(outbox.all().map((i) => i.state !== 'pending'));
    if (handledNow > handledBefore) {
      handledBefore = handledNow;
      await writeCursor(settings['EDGE_DATA_DIR']!, handledNow);
    }
  };

  const pass = async (): Promise<void> => {
    // Sequential by construction: the next pass is scheduled only after this one returns, so two
    // drains can never run at once.
    try {
      const result = await agent.drain({ at: new Date().toISOString() });
      await advanceCursor();
      quietPasses = result.acknowledged > 0 ? 0 : quietPasses + 1;
      if (result.acknowledged > 0 || result.deadLettered > 0) {
        say(`sync: ${result.acknowledged} sent, ${result.deadLettered} needing a person, ${result.remaining} waiting`);
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
    outbox,
    node,
    lane,
    screens,
    agent,
    refreshPack,
    stop: async () => {
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      // One last try, then go. Nothing is lost by stopping mid-drain: an unacknowledged item stays
      // pending, which is the whole reason there is an outbox.
      try {
        await agent.drain({ at: new Date().toISOString(), limit: 20 });
        await advanceCursor();
      } catch { /* still queued, and the cursor stays where it is */ }
      const badge = agent.health();
      if (badge.unsentCount > 0) {
        say(`stopping with ${badge.unsentCount} sale(s) still to send. They are on the disk and will go when this starts again.`);
      }
      if (lane !== null) await lane.stop();
      if (screens !== null) await screens.stop();
      await log.close();
    },
  };
}
