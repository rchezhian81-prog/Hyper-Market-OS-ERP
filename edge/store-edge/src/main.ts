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
import { openFileLog, readLog, type OpenFileLog } from './file-log';

/** Gap between drains when the last one delivered something. */
const BASE_INTERVAL_MS = 15_000;
/** Ceiling on the gap when nothing is getting through. Five minutes, not five hours. */
const MAX_INTERVAL_MS = 300_000;

export function nextInterval(consecutiveQuietPasses: number): number {
  const grown = BASE_INTERVAL_MS * 2 ** Math.min(consecutiveQuietPasses, 10);
  return Math.min(grown, MAX_INTERVAL_MS);
}

export interface EdgeProcess {
  readonly log: OpenFileLog;
  readonly outbox: SyncOutbox;
  /** Null when no cloud is configured — which is a supported way to run, not a fault. */
  readonly agent: SyncAgent | null;
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
  const cloudUrl = settings['CLOUD_API_URL'];
  const cloudToken = settings['CLOUD_API_TOKEN'];

  if (cloudUrl === undefined || cloudToken === undefined) {
    // Supported, and said plainly. The lanes sell; the queue grows; nobody is told a lie about it.
    say('no cloud is configured, so nothing will be synced. The shop can still trade — that is the point.');
    return { log, outbox, agent: null, stop: () => log.close() };
  }

  const agent = new SyncAgent(outbox, httpTransport({
    baseUrl: cloudUrl, token: cloudToken, fetch: globalThis.fetch,
  }));

  let stopping = false;
  let quietPasses = 0;
  let timer: NodeJS.Timeout | undefined;

  const pass = async (): Promise<void> => {
    // Sequential by construction: the next pass is scheduled only after this one returns, so two
    // drains can never run at once.
    try {
      const result = await agent.drain({ at: new Date().toISOString() });
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
    if (!stopping) timer = setTimeout(() => { void pass(); }, nextInterval(quietPasses));
  };

  timer = setTimeout(() => { void pass(); }, BASE_INTERVAL_MS);

  return {
    log,
    outbox,
    agent,
    stop: async () => {
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      // One last try, then go. Nothing is lost by stopping mid-drain: an unacknowledged item stays
      // pending, which is the whole reason there is an outbox.
      try { await agent.drain({ at: new Date().toISOString(), limit: 20 }); } catch { /* still queued */ }
      const badge = agent.health();
      if (badge.unsentCount > 0) {
        say(`stopping with ${badge.unsentCount} sale(s) still to send. They are on the disk and will go when this starts again.`);
      }
      await log.close();
    },
  };
}
