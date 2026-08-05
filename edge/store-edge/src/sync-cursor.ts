// How the edge remembers what it has already sent — P-01, §31, hard rule #6.
//
// The outbox is rebuilt from the durable log every time the edge starts, because the log is the
// system of record and the queue is a view of it. That leaves one question: **where does the
// restart begin?**
//
// Without an answer, every start re-sends every sale the shop has ever made. Safe — the cloud
// dedupes on the idempotency key — and absurd after a month. With the wrong answer, a sale is
// skipped and never syncs, which is the failure that has no upper bound on how long it stays
// invisible.
//
// So the cursor is the count of records at the **front of the log that are completely finished**,
// and it advances only over a *contiguous* prefix. A sale in the middle that is still queued, or
// that dead-lettered and needs a person, holds the cursor where it is: the few finished ones
// behind it are re-sent on the next start and collapse to nothing at the cloud, and the unfinished
// one is never stepped over. Cheap redundancy against permanent loss is the right way round.

import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = 'sync-cursor';

/** Records at the front of the log that are finished. Zero if nothing has been sent, or unreadable. */
export async function readCursor(dataDir: string): Promise<number> {
  try {
    const text = await readFile(join(dataDir, FILE), 'utf8');
    const n = Number(text.trim());
    // An unreadable cursor means starting from the beginning, which re-sends and dedupes. The
    // other reading — "assume everything is done" — would skip sales, permanently and silently.
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Write the cursor, durably.
 *
 * Synced for the same reason the sales log is: a cursor that reached the operating system's cache
 * and not the disk survives a clean shutdown and not a power cut, and the one time it matters is
 * the power cut.
 *
 * Written whole and short. A partial write of a number is a different number, so this is one of
 * the few places where writing a fixed, tiny payload is itself the safety property.
 */
export async function writeCursor(dataDir: string, handled: number): Promise<void> {
  const handle = await open(join(dataDir, FILE), 'w');
  try {
    await handle.write(`${handled}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * How far the cursor may advance, given which records are finished.
 *
 * `finished[i]` says whether the record at index `i` is done — acknowledged by the cloud, or
 * dead-lettered and now a person's problem rather than the queue's. The answer is the length of
 * the leading run of `true`, and **not** the count of `true`s: a gap means an unfinished record,
 * and stepping over it would lose that sale for good.
 */
export function advanceTo(finished: readonly boolean[]): number {
  let at = 0;
  while (at < finished.length && finished[at] === true) at += 1;
  return at;
}
