// The store setup head office last sent, held on the store computer's disk (Wave 4 · PA-06 = DF-3-a · P-01 · §31).
//
// Like the catalogue pack (`signed-pack-file.ts`): the swap is ATOMIC (temp file, sync, rename, sync the directory), so a
// power cut leaves either the whole old setup or the whole new one; the one replaced is kept beside it as
// `store-pack.previous.json`, so the last good setup is never lost; and a restored file is CHECKED before it is trusted —
// head office's signature, this shop, this store. An out-of-date one is still used (the till never stops, P-01) and said.

import { open, readFile, rename, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyStorePack, type StorePackEnvelope } from '../../../services/platform/src/store-packs';
import type { PackSigner } from '../../../services/catalogue/src/pack';

const FILE = 'store-pack.json';
const PREVIOUS = 'store-pack.previous.json';
const TEMP = 'store-pack.json.tmp';

/** The held setup, checked — or undefined for a missing, torn, tampered, another shop's or another store's file. */
export async function readHeldStorePack(dataDir: string, signer: PackSigner, tenantId: string, storeId: string): Promise<StorePackEnvelope | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dataDir, FILE), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  // No held version to compare against at boot, and the clock is NOT a reason to refuse a restored setup — an out-of-date
  // one still trades (P-01): check it as of its own issue time.
  const issuedAt = typeof (parsed as { issuedAt?: unknown } | null)?.issuedAt === 'string' ? (parsed as { issuedAt: string }).issuedAt : new Date(0).toISOString();
  const verdict = verifyStorePack(signer, parsed, { tenantId, storeId, heldVersion: null, now: issuedAt });
  return verdict.accepted ? (parsed as StorePackEnvelope) : undefined;
}

/** Write a verified setup atomically, keeping the one it replaces as the previous copy. */
export async function writeHeldStorePack(dataDir: string, pack: StorePackEnvelope): Promise<void> {
  try { await copyFile(join(dataDir, FILE), join(dataDir, PREVIOUS)); } catch { /* nothing held yet — nothing to keep */ }
  const tempPath = join(dataDir, TEMP);
  const handle = await open(tempPath, 'w');
  try {
    await handle.write(`${JSON.stringify(pack)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, join(dataDir, FILE));
  const dir = await open(dataDir, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}

/** The store pack payload `readPack` reads, from a held setup: its sections, under head office's version. */
export const packPayloadOf = (env: StorePackEnvelope): Record<string, unknown> => ({ ...env.sections, version: env.version });
