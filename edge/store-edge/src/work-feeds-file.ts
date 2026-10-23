// The store's work feeds on disk — OB-288 lane 2 · P2 (P-01, P-08).
//
// The production board and recipes, the food-safety checks in force, and the transfers with an end at this store are what
// the box's screens and handhelds work from with the line down. If they lived only in memory, a reboot with the cable out
// would leave the counter with no recipes, the chiller with no checks and the back door with no transfers — the work would
// appear to have vanished, silently. So each TAKEN feed is written here, atomically (temp file, fsync, rename), and read back
// at boot with its head-office clock intact so the screens can say how old it is. A file for another shop, or one that does
// not read as the feed it says it is (torn, hand-edited), is ignored rather than served.

import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { readWorkFeed, WORK_FEED_NAMES, type WorkFeed, type WorkFeedName } from '../../sync-agent/src/store-work-feeds';

const FILE = 'work-feeds.json';
const TEMP = 'work-feeds.json.tmp';

/** One held feed and when this box took it. */
export interface HeldWorkFeed { readonly feed: WorkFeed; readonly receivedAt: string }
export type HeldWorkFeeds = Partial<Record<WorkFeedName, HeldWorkFeed>>;

/** Restore the feeds the box last took (each that still reads whole), or none. */
export async function readHeldWorkFeeds(dataDir: string, tenantId: string): Promise<HeldWorkFeeds> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dataDir, FILE), 'utf8')) as unknown;
  } catch {
    return {}; // missing, or torn — nothing to restore
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  const raw = parsed as { readonly tenantId?: unknown; readonly feeds?: unknown };
  if (raw.tenantId !== tenantId || raw.feeds === null || typeof raw.feeds !== 'object') return {};
  const out: HeldWorkFeeds = {};
  for (const name of WORK_FEED_NAMES) {
    const held = (raw.feeds as Record<string, unknown>)[name];
    if (held === null || typeof held !== 'object') continue;
    const h = held as { feed?: unknown; receivedAt?: unknown };
    const feed = readWorkFeed(h.feed);
    if (feed === undefined || feed.name !== name || typeof h.receivedAt !== 'string' || Number.isNaN(Date.parse(h.receivedAt))) continue;
    out[name] = { feed, receivedAt: h.receivedAt };
  }
  return out;
}

/** Write every held feed atomically: a reader never sees half of either version. */
export async function writeHeldWorkFeeds(dataDir: string, tenantId: string, feeds: HeldWorkFeeds): Promise<void> {
  const tempPath = join(dataDir, TEMP);
  const handle = await open(tempPath, 'w');
  try {
    await handle.write(`${JSON.stringify({ tenantId, feeds })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, join(dataDir, FILE));
}
