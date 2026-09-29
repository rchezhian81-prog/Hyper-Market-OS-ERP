// The migration register on disk — Stage C3b (P-01, P-08, hard rule #4).
//
// The box pulls the cloud's migration register on its sync loop (`pullMigrationFeed`). If that register lived
// only in memory, a reboot with the cable out would put the screen back on the pack file's sections — the
// register would appear to have gone backwards, silently. So a TAKEN register is written here, atomically,
// and read back at boot the same way the signed catalogue pack is (`signed-pack-file.ts`), with its cloud
// clock intact so the screen can say how old it is rather than pretend it is fresh.
//
// There is no signature to check: the feed is not a catalogue the till trades on, and it reached this box
// under the box's own bearer token over the same channel as everything else. What IS checked is the tenant —
// a file for another shop is not a baseline — and the shape, through the same reader the puller uses, so a
// torn or hand-edited file is ignored rather than shown.

import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { readMigrationFeed, type MigrationFeed } from '../../sync-agent/src/migration-feed';

const FILE = 'migration-feed.json';
const TEMP = 'migration-feed.json.tmp';

export interface HeldMigrationFeed {
  readonly feed: MigrationFeed;
  /** The box's clock when it took the register. */
  readonly receivedAt: string;
}

/** Restore the register the box last took, or undefined when there is none worth restoring. */
export async function readHeldMigrationFeed(dataDir: string, tenantId: string): Promise<HeldMigrationFeed | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dataDir, FILE), 'utf8')) as unknown;
  } catch {
    return undefined; // missing, or torn — nothing to restore
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const raw = parsed as { readonly feed?: unknown; readonly receivedAt?: unknown };
  const feed = readMigrationFeed(raw.feed);
  if (feed === undefined || feed.tenantId !== tenantId) return undefined;
  if (typeof raw.receivedAt !== 'string' || Number.isNaN(Date.parse(raw.receivedAt))) return undefined;
  return { feed, receivedAt: raw.receivedAt };
}

/** Write the register atomically: temp file, fsync, rename. A reader never sees half of either. */
export async function writeHeldMigrationFeed(dataDir: string, held: HeldMigrationFeed): Promise<void> {
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
