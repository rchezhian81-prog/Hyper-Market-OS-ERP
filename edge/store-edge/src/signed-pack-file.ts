// The signed catalogue pack, held on the box's disk — SYNC-01 increment 2 (audit GAP-SYNC-01),
// P-01, §31, hard rule #6.
//
// The inbound pull (`edge/sync-agent` `pullPack`) keeps the lane's catalogue fresh in MEMORY. This
// is where the pack the box last accepted is kept on the DISK, so a reboot does not lose it and go
// back to a blank catalogue until the next pull — the box starts on the last pack it trusted, exactly
// as the lane does while running (P-01).
//
// Two properties do the work:
//
//   • **The swap is atomic.** A new pack is written to a temp file, synced, and RENAMED over the
//     live one. Rename is atomic on POSIX, so a power cut mid-write leaves either the whole old pack
//     or the whole new pack on disk — never a torn one the box would read as garbage at next boot.
//     (The sales log and the sync cursor are synced for the same reason: the one time durability
//     matters is the power cut, not the clean shutdown.)
//   • **A restored pack is verified before it is trusted**, the SAME way a lane verifies one over
//     the wire (`acceptPack` — signature + tenant). A file that is missing, unparseable, tampered,
//     or built for another tenant yields `undefined`, so the box starts with no held pack and the
//     first pull re-establishes trust — a pack that failed its check is never the baseline.

import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptPack, type SignedPack, type PackSigner } from '../../../services/catalogue/src/pack';

const FILE = 'signed-pack.json';
const TEMP = 'signed-pack.json.tmp';

/**
 * Read the last signed catalogue pack this box accepted, verifying it the SAME way a lane does
 * before trusting one. Returns `undefined` for a missing, unparseable, tampered or wrong-tenant
 * file — the box then starts on no pack and the first pull re-establishes trust.
 */
export async function readSignedPack(
  dataDir: string, signer: PackSigner, tenantId: string,
): Promise<SignedPack | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dataDir, FILE), 'utf8')) as unknown;
  } catch {
    // Missing file, or a torn/partial one — either way there is no trusted pack to restore.
    return undefined;
  }
  try {
    // The one trust path the lane and the service already share. No `held`, so only the signature
    // and the tenant are checked (there is nothing to compare a version against at boot).
    const result = acceptPack({ incoming: parsed as SignedPack, signer, tenantId });
    return result.accepted ? (parsed as SignedPack) : undefined;
  } catch {
    // A shape that is not a catalogue at all (so canonicalising it threw) is not a pack to trust.
    return undefined;
  }
}

/**
 * Persist an accepted signed pack atomically: write a temp file, sync it, rename it over the live
 * file, then sync the directory so the rename itself survives a power cut. A crash at any point
 * leaves the box holding either the previous whole pack or the new whole pack.
 */
export async function writeSignedPack(dataDir: string, pack: SignedPack): Promise<void> {
  const tempPath = join(dataDir, TEMP);

  const handle = await open(tempPath, 'w');
  try {
    await handle.write(`${JSON.stringify(pack)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }

  // The atomic step. Until this returns the live file is untouched; after it, it is wholly the new
  // pack. There is no window in which a reader sees half of either.
  await rename(tempPath, join(dataDir, FILE));

  // Persist the rename, not just the bytes: a directory entry in the OS cache and not on the disk
  // survives a clean shutdown and not a power cut, which is the one that matters.
  const dir = await open(dataDir, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
