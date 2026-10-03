// The head-office assignments on disk — HA-1 (P-01, P-08, hard rule #4).
//
// The box pulls the store's open wave and route assignments on its sync loop (`pullAssignmentsFeed`) and serves them to the
// picker and driver phones. If they lived only in memory, a reboot with the cable out would leave the phones with no work —
// as if nothing had been assigned, silently. So a TAKEN feed is written here, atomically, and read back at boot the same way
// the floor indents are (`indents-feed-file.ts`), with the cloud's own clock intact so the screens can say how old it is.
//
// No signature: the feed is not a catalogue the till trades on, and it reached this box under the box's own bearer token.
// What IS checked is the tenant and the shape, through the same reader the puller uses, so a torn file is ignored, not served.

import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { readAssignmentsFeed, type AssignmentsFeed } from '../../sync-agent/src/assignments-feed';

const FILE = 'assignments-feed.json';
const TEMP = 'assignments-feed.json.tmp';

export interface HeldAssignmentsFeed {
  readonly tenantId: string;
  readonly feed: AssignmentsFeed;
  /** The box's clock when it took the feed. */
  readonly receivedAt: string;
}

/** Restore the feed the box last took, or undefined when there is none worth restoring. */
export async function readHeldAssignmentsFeed(dataDir: string, tenantId: string): Promise<HeldAssignmentsFeed | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dataDir, FILE), 'utf8')) as unknown;
  } catch {
    return undefined; // missing, or torn — nothing to restore
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const raw = parsed as { readonly tenantId?: unknown; readonly feed?: unknown; readonly receivedAt?: unknown };
  if (raw.tenantId !== tenantId) return undefined;
  const feed = readAssignmentsFeed(raw.feed);
  if (feed === undefined) return undefined;
  if (typeof raw.receivedAt !== 'string' || Number.isNaN(Date.parse(raw.receivedAt))) return undefined;
  return { tenantId, feed, receivedAt: raw.receivedAt };
}

/** Write the feed atomically: temp file, fsync, rename. A reader never sees half of either. */
export async function writeHeldAssignmentsFeed(dataDir: string, held: HeldAssignmentsFeed): Promise<void> {
  const tempPath = join(dataDir, TEMP);
  const handle = await open(tempPath, 'w');
  try {
    await handle.write(`${JSON.stringify(held)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, join(dataDir, FILE));
}
