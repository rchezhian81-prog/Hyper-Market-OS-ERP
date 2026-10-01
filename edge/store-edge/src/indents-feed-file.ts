// The floor-indent register on disk — SP-8c (P-01, P-08, hard rule #4).
//
// The box pulls head office's open floor indents on its sync loop (`pullIndentsFeed`) and serves them to the warehouse
// handheld (what the back store owes) and the Indents screen (the register offline). If that register lived only in
// memory, a reboot with the cable out would leave the handheld with nothing to issue against — the work would appear to
// have vanished, silently. So a TAKEN register is written here, atomically, and read back at boot the same way the migration
// register is (`migration-feed-file.ts`), with its cloud clock intact so the screens can say how old it is.
//
// There is no signature to check: the register is not a catalogue the till trades on, and it reached this box under the
// box's own bearer token. What IS checked is the tenant — a file for another shop is not this shop's work — and the shape,
// through the same reader the puller uses, so a torn or hand-edited file is ignored rather than served.

import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { readIndentsFeed, type IndentsFeed } from '../../sync-agent/src/indents-feed';

const FILE = 'indents-feed.json';
const TEMP = 'indents-feed.json.tmp';

export interface HeldIndentsFeed {
  readonly tenantId: string;
  readonly feed: IndentsFeed;
  /** The box's clock when it took the register. */
  readonly receivedAt: string;
}

/** Restore the register the box last took, or undefined when there is none worth restoring. */
export async function readHeldIndentsFeed(dataDir: string, tenantId: string): Promise<HeldIndentsFeed | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dataDir, FILE), 'utf8')) as unknown;
  } catch {
    return undefined; // missing, or torn — nothing to restore
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const raw = parsed as { readonly tenantId?: unknown; readonly feed?: unknown; readonly receivedAt?: unknown };
  if (raw.tenantId !== tenantId) return undefined;
  const feed = readIndentsFeed(raw.feed);
  if (feed === undefined) return undefined;
  if (typeof raw.receivedAt !== 'string' || Number.isNaN(Date.parse(raw.receivedAt))) return undefined;
  return { tenantId, feed, receivedAt: raw.receivedAt };
}

/** Write the register atomically: temp file, fsync, rename. A reader never sees half of either. */
export async function writeHeldIndentsFeed(dataDir: string, held: HeldIndentsFeed): Promise<void> {
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
