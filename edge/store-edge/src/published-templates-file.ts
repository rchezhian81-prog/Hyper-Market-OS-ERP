// The published document templates on disk — M01-FR-02 (P-01, P-08, hard rule #4).
//
// The box pulls the versions in force on its sync loop (`pullPublishedTemplates`). If they lived only in
// memory, a reboot with the cable out would put the lanes back on the pack file's defaults — the receipt
// header would go backwards, silently, on the next bill. So TAKEN templates are written here, atomically,
// and read back at boot the same way the migration register is (`migration-feed-file.ts`), with the cloud's
// clock intact so the box can say how old they are rather than pretend they are fresh.
//
// There is no signature to check: the templates are wording, not prices, and they reached this box under
// the box's own bearer token over the same channel as everything else. What IS checked is the tenant — a
// file for another shop is not this shop's receipt — and the shape, through the same reader the puller
// uses, so a torn or hand-edited file is ignored rather than printed.

import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { readPublishedTemplatesFeed, type PublishedTemplatesFeed } from '../../sync-agent/src/published-templates';

const FILE = 'document-templates.json';
const TEMP = 'document-templates.json.tmp';

export interface HeldPublishedTemplates {
  readonly feed: PublishedTemplatesFeed;
  /** The box's clock when it took the templates. */
  readonly receivedAt: string;
}

/** Restore the templates the box last took, or undefined when there is none worth restoring. */
export async function readHeldPublishedTemplates(dataDir: string, tenantId: string): Promise<HeldPublishedTemplates | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dataDir, FILE), 'utf8')) as unknown;
  } catch {
    return undefined; // missing, or torn — nothing to restore
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const raw = parsed as { readonly feed?: unknown; readonly receivedAt?: unknown };
  const feed = readPublishedTemplatesFeed(raw.feed);
  if (feed === undefined || feed.tenantId !== tenantId) return undefined;
  if (typeof raw.receivedAt !== 'string' || Number.isNaN(Date.parse(raw.receivedAt))) return undefined;
  return { feed, receivedAt: raw.receivedAt };
}

/** Write the templates atomically: temp file, fsync, rename. A reader never sees half of either. */
export async function writeHeldPublishedTemplates(dataDir: string, held: HeldPublishedTemplates): Promise<void> {
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
