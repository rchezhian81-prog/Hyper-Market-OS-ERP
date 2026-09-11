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

import { open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FILE = 'sync-cursor';

/**
 * The cursor file name. Defaults to the sales cursor, which every existing caller uses unchanged.
 *
 * A second durable log (offline RETURNS reconcile on sync, M13-FR-01) needs its OWN cursor: its log
 * and the sales log advance independently, and one number cannot mark two logs. So the returns
 * pipeline passes its own name, and the two files never touch. Naming it here rather than at the
 * call sites keeps the "where does the restart begin" answer in one place for both.
 */
export function cursorFileFor(name?: string): string {
  return name ?? FILE;
}

/** Records at the front of the log that are finished. Zero if nothing has been sent, or unreadable. */
export async function readCursor(dataDir: string, fileName?: string): Promise<number> {
  try {
    const text = await readFile(join(dataDir, cursorFileFor(fileName)), 'utf8');
    const n = Number(text.trim());
    // An unreadable cursor means starting from the beginning, which re-sends and dedupes. The
    // other reading — "assume everything is done" — would skip sales, permanently and silently.
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Write the cursor, durably and atomically.
 *
 * Synced for the same reason the sales log is: a cursor that reached the operating system's cache
 * and not the disk survives a clean shutdown and not a power cut, and the one time it matters is
 * the power cut.
 *
 * **Write a temp file, fsync it, then rename it over the real one.** A rename within a directory is
 * atomic, so a reader — including this box after a power cut mid-write — sees either the whole old
 * number or the whole new one, never a torn half. The earlier version truncated the real file and
 * wrote into it, which leaves a window where the file is empty or half a number on the disk; that
 * happened to read *safely* (an unreadable cursor means start from the beginning, which re-sends and
 * dedupes), but "happens to fail safe" is a weaker thing to rest a ledger on than "cannot tear".
 */
export async function writeCursor(dataDir: string, handled: number, fileName?: string): Promise<void> {
  const target = join(dataDir, cursorFileFor(fileName));
  const temp = `${target}.tmp`;
  const handle = await open(temp, 'w');
  try {
    await handle.write(`${handled}\n`);
    await handle.sync(); // the bytes of the temp file are on the disk before it becomes the cursor
  } finally {
    await handle.close();
  }
  await rename(temp, target); // atomic swap — no reader ever sees a partial number
  // Sync the directory so the rename itself survives a power cut, not just the temp file's bytes.
  try {
    const dir = await open(dirname(target), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch { /* some filesystems refuse to sync a directory; the rename is still atomic */ }
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
