// The disk the receipt waits for — P-01, hard rules #1 and #2, §31, NFR-03.
//
// `DurableLog` has been a port with a test double behind it and nothing else. `commitLocally` is
// careful, well tested, and was writing to an interface no deployment could satisfy: the whole
// offline-first claim rested on a file that did not exist. This is that file.
//
// ── Why `appendFile` is not enough, and this is the sentence that matters ───
//
// `fs.appendFile` returns when the bytes reach the **operating system's cache**, not the disk. On
// a back-office PC in a shop with no UPS — which is every shop until somebody buys one — the
// difference is a power cut between the receipt printing and the platters catching up. The sale is
// in the customer's hand and nowhere else, the day does not balance, and the till is blamed for a
// counting error that never happened. So every append is followed by an **fsync**, and `append`
// does not resolve until it returns.
//
// `fdatasync` is the cheaper call and it is the wrong one here. It skips metadata, and for an
// append the file's **length is metadata** — the bytes can be on the disk while the inode still
// says the file is shorter, which is the same lost sale by a subtler route.
//
// The directory is synced too, once, when the file is first created. Without it the file's *entry*
// can be lost even though the file's contents were durable, and a log that survived perfectly
// inside a directory that forgot it is not a log.
//
// ── A crash mid-write must be visible, not silent ───────────────────────────
//
// Power can go while a record is half-written, which leaves a truncated last line. That line is
// **quarantined by name, never parsed and never dropped** (hard rule #6): every record carries its
// own byte length, so a short read is arithmetic rather than a judgement call about whether some
// JSON "looks complete". A half-sale silently discarded is the failure this whole file exists to
// prevent, arriving one layer down.

import { open, mkdir, stat, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DurableLog } from './durability';

/**
 * Prefix every record with its byte length, then the record, then a newline.
 *
 * **Nothing is escaped**, and that is deliberate. The first version escaped newlines so the file
 * could be read with `split('\n')` — and corrupted every record that legitimately contained the
 * two characters backslash-`n`, which is *exactly what `JSON.stringify` writes for a newline*. So
 * a sale carrying a note with a line break came back as invalid JSON: a lost sale, produced by the
 * code whose entire job is not losing sales.
 *
 * The length prefix makes escaping unnecessary. The reader takes exactly that many bytes, whatever
 * they are, and the trailing newline is a **check** rather than a delimiter — if it is missing, the
 * record was truncated.
 */
const framed = (record: string): string =>
  `${Buffer.byteLength(record, 'utf8')} ${record}\n`;

export interface FileLogOptions {
  readonly dataDir: string;
  /** What this edge may use, in bytes. `commitLocally` refuses a sale that would exceed it. */
  readonly capacityBytes: number;
  readonly fileName?: string;
}

export interface OpenFileLog extends DurableLog {
  /** Close the handle. Anything already appended is on the disk; nothing is buffered. */
  close(): Promise<void>;
  readonly path: string;
}

/**
 * Open (or create) the edge's durable log.
 *
 * The handle is opened **once and kept**. Opening per write costs an open, a sync and a close on
 * the sale path — the one path in the product that a customer stands and waits for — and races two
 * lanes writing at the same instant.
 */
export async function openFileLog(options: FileLogOptions): Promise<OpenFileLog> {
  const path = join(options.dataDir, options.fileName ?? 'sales.log');
  await mkdir(options.dataDir, { recursive: true });

  // 'a' is O_APPEND: every write goes to the current end of the file, atomically, even with two
  // writers. Never 'w' — that truncates, and this log is append-only (hard rule #2) at the level
  // where a mistake cannot be argued with.
  const handle: FileHandle = await open(path, 'a');

  // Sync the directory so the file's ENTRY survives, not just its contents. Best-effort: some
  // filesystems refuse to open a directory for sync, and failing to start over that would take a
  // shop offline for a durability nicety it may not need.
  try {
    const dir = await open(dirname(path), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch { /* not supported here; the appends below are still synced */ }

  return {
    capacityBytes: options.capacityBytes,
    path,

    append: async (record: string): Promise<void> => {
      await handle.write(framed(record));
      // The whole point of the file. `sync` rather than `datasync`: for an append the file's
      // length is metadata, and bytes on the disk under an inode that still says the file is
      // shorter is the same lost sale by a subtler route.
      await handle.sync();
    },

    // Read from the filesystem, never from a counter kept in memory. A counter is right until the
    // process restarts after a crash, which is exactly when the number is load-bearing.
    usedBytes: async (): Promise<number> => (await stat(path)).size,

    close: () => handle.close(),
  };
}

export type RecordVerdict =
  | { readonly ok: true; readonly record: string }
  | { readonly ok: false; readonly reason: 'truncated' | 'unframed'; readonly raw: string };

/**
 * Read the log back, saying which records are whole and which are not.
 *
 * Used on restart and by the recovery runbook. A truncated tail is **reported, never dropped and
 * never repaired** — a repaired half-sale is a made-up sale, and the only honest thing to do with
 * one is put it in front of a person.
 */
export async function readLog(path: string): Promise<readonly RecordVerdict[]> {
  let buffer: Buffer;
  try { buffer = await readFile(path); } catch { return []; }

  // Walked by OFFSET, not split on newlines: a record may contain a newline and splitting on one
  // would cut a sale in half — which is how the escaping bug above got in.
  const out: RecordVerdict[] = [];
  let at = 0;

  while (at < buffer.length) {
    const space = buffer.indexOf(0x20, at);
    const newline = buffer.indexOf(0x0a, at);
    // A header with no space before the next newline is not a frame at all.
    if (space < 0 || (newline >= 0 && newline < space)) {
      const end = newline < 0 ? buffer.length : newline;
      out.push({ ok: false, reason: 'unframed', raw: buffer.subarray(at, end).toString('utf8') });
      at = end + 1;
      continue;
    }

    const declared = Number(buffer.subarray(at, space).toString('utf8'));
    if (!Number.isInteger(declared) || declared < 0) {
      const end = newline < 0 ? buffer.length : newline;
      out.push({ ok: false, reason: 'unframed', raw: buffer.subarray(at, end).toString('utf8') });
      at = end + 1;
      continue;
    }

    const start = space + 1;
    const stop = start + declared;
    // Arithmetic, not a judgement about whether some JSON "looks complete": the record is short,
    // or its closing newline is missing, so the write did not finish.
    if (stop > buffer.length || buffer[stop] !== 0x0a) {
      out.push({ ok: false, reason: 'truncated', raw: buffer.subarray(at).toString('utf8') });
      break;
    }
    out.push({ ok: true, record: buffer.subarray(start, stop).toString('utf8') });
    at = stop + 1;
  }

  return out;
}
