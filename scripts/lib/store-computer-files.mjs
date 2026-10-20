// The till's own data, copied consistently while the till keeps selling — OB-249 (backup of EVERYTHING, including the
// till's data: unsent sales, the queue, dead letters, PIN verifiers), audit lane B rows B3/B4.
//
// ── How the till writes, and so how it can be copied safely without stopping it (hard rule #1) ─────────────────────
// The store edge keeps no database. Its folder (EDGE_DATA_DIR) holds two kinds of file (edge/store-edge/src):
//
//   1. APPEND-ONLY LOGS (file-log.ts): sales.log, returns.log, dead-letters*, till-operators.log, receipt-numbers.log, …
//      Each record is framed `<byte length> <record>\n`, written with O_APPEND and fsync'd before the till says "saved".
//      A log only ever grows. So a copy of its first N bytes is a true copy of the log as it was — PROVIDED N ends on a
//      record boundary. The copy walks the frames exactly as the edge's own reader does (`readLog`) and stops after the
//      last COMPLETE record. A record being written at that instant is left for the next backup and counted
//      ("in flight"). A tail that stays incomplete (an old power cut the edge itself quarantined) is copied byte for
//      byte and flagged — never dropped, never repaired (hard rule #6).
//   2. SMALL FILES REPLACED WHOLE (sync-cursor*, signed-pack.json, till-credentials.json, the held feeds): written to a
//      temp file, fsync'd, then renamed over the old one. A reader sees the whole old file or the whole new one, never
//      half. Their `*.tmp` working copies are skipped.
//
// ORDER matters between the two, and this is the rule: the small files first, then the logs, and the bill-number log
// (receipt-numbers*) last of all. A cursor copied before its log can only point at or behind the log's end (a restored
// box re-sends a few and the cloud collapses them — the edge's own design, sync-cursor.ts); a bill-number log copied
// after the sales can only hold MORE reservations than the sales used (numbers skipped, never reused).
//
// The bill-number WITNESS (EDGE_WITNESS_DIR) is never copied (OB-87): a restore must be seen as a restore.
//
// Everything goes into ONE bundle file (then encrypted by store-computer-crypto.mjs): for each file a small header
// (name, size, SHA-256, kind, frames) and its bytes. Reading the bundle back checks every file's SHA-256 and every log's
// frames — that is what restore-check reports for the till's data.

import { createHash } from 'node:crypto';
import path from 'node:path';

const BUNDLE_MAGIC = Buffer.from('SREBNDL1\n', 'latin1');
const CHUNK = 1024 * 1024;
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
/** How long a log's incomplete last record is given to finish before it is judged an old, permanent one. */
export const IN_FLIGHT_WAIT_MS = 1500;

const sleepSync = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function readAt(fs, fd, length, position) {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

function writeAll(fs, fd, buf) {
  let done = 0;
  while (done < buf.length) done += fs.writeSync(fd, buf, done, buf.length - done);
}

/** Does this file start like a framed log (`<digits> `)? A JSON file starts with `{`; a cursor is digits and a newline. */
export function looksLikeLog(fs, file, size) {
  if (size === 0) return false;
  const fd = fs.openSync(file, 'r');
  try { return /^\d{1,12} /.test(readAt(fs, fd, Math.min(size, 16), 0).toString('latin1')); } finally { fs.closeSync(fd); }
}

/**
 * Walk a log's frames from `from` up to `limit`, the way the edge's reader does. Returns where the last complete record
 * ends (`cut`), how many complete records there were, and whether the walk stopped at an incomplete record.
 */
export function walkFrames(fs, fd, from, limit) {
  let at = from;
  let records = 0;
  let unframed = 0;
  while (at < limit) {
    const head = readAt(fs, fd, Math.min(24, limit - at), at);
    const space = head.indexOf(0x20);
    const newline = head.indexOf(0x0a);
    if (space < 0 || (newline >= 0 && newline < space)) {
      if (newline < 0 && head.length < 24) return { cut: at, records, unframed, incompleteAt: at };
      if (newline < 0) { // a long line with no frame header at all: find its end and count it, as the edge's reader does
        let end = at + head.length;
        for (;;) {
          const more = readAt(fs, fd, Math.min(4096, limit - end), end);
          if (more.length === 0) return { cut: at, records, unframed, incompleteAt: at };
          const nl = more.indexOf(0x0a);
          if (nl >= 0) { end += nl; break; }
          end += more.length;
        }
        unframed += 1; at = end + 1; continue;
      }
      unframed += 1; at += newline + 1; continue;
    }
    const declared = Number(head.subarray(0, space).toString('latin1'));
    if (!Number.isInteger(declared) || declared < 0) {
      if (newline < 0) return { cut: at, records, unframed, incompleteAt: at };
      unframed += 1; at += newline + 1; continue;
    }
    const stop = at + space + 1 + declared;
    if (stop >= limit || readAt(fs, fd, 1, stop)[0] !== 0x0a) return { cut: at, records, unframed, incompleteAt: at };
    records += 1;
    at = stop + 1;
  }
  return { cut: at, records, unframed, incompleteAt: undefined };
}

/** Every file under `dir`, as paths relative to it ('/'-separated), skipping `*.tmp` working copies. */
function listFiles(fs, p, dir) {
  const out = [];
  const walk = (rel) => {
    const abs = rel === '' ? dir : p.join(dir, ...rel.split('/'));
    for (const name of fs.readdirSync(abs).map(String).sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const st = fs.statSync(p.join(abs, name));
      if (st.isDirectory()) walk(childRel);
      else if (!name.endsWith('.tmp')) out.push(childRel);
    }
  };
  if (fs.existsSync(dir)) walk('');
  return out;
}

const isBillNumberLog = (name) => /(^|\/)receipt-numbers[^/]*$/.test(name);

/**
 * Copy `sources` consistently into a NEW bundle file. `sources` are { prefix, dir } (a folder, walked) or
 * { prefix, file } (one file), e.g. { prefix: 'till/edge-data', dir: 'C:\\SRE-data\\till\\edge-data' }.
 * Returns the bundle's table of contents (no file contents) for the manifest.
 */
export function writeBundle(fs, platform, sources, bundlePath, { waitMs = IN_FLIGHT_WAIT_MS, sleep = sleepSync } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const items = [];
  for (const s of sources) {
    if (s.dir !== undefined) for (const rel of listFiles(fs, p, s.dir)) items.push({ name: `${s.prefix}/${rel}`, abs: p.join(s.dir, ...rel.split('/')) });
    else if (s.file !== undefined && fs.existsSync(s.file)) items.push({ name: s.prefix, abs: s.file });
  }
  // Classify once, by content, then order: whole files first, then logs, the bill-number log last.
  for (const it of items) {
    const size = fs.statSync(it.abs).size;
    it.kind = looksLikeLog(fs, it.abs, size) ? 'log' : 'file';
  }
  const rank = (it) => (it.kind === 'file' ? 0 : isBillNumberLog(it.name) ? 2 : 1);
  items.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const out = fs.openSync(bundlePath, 'wx', 0o600);
  const toc = [];
  try {
    writeAll(fs, out, BUNDLE_MAGIC);
    for (const it of items) {
      const fd = fs.openSync(it.abs, 'r');
      try {
        const size0 = fs.fstatSync(fd).size;
        let length = size0;
        const meta = { name: it.name, kind: it.kind };
        if (it.kind === 'log') {
          let w = walkFrames(fs, fd, 0, size0);
          if (w.incompleteAt !== undefined) {
            // A record mid-write, or an old incomplete one? Give it a moment to finish.
            sleep(waitMs);
            const size1 = fs.fstatSync(fd).size;
            const again = walkFrames(fs, fd, w.incompleteAt, size1);
            if (again.cut > w.incompleteAt) {
              w = { cut: again.cut, records: w.records + again.records, unframed: w.unframed + again.unframed, incompleteAt: again.incompleteAt };
              meta.inFlightBytes = Math.max(0, size1 - again.cut);
            } else {
              meta.keptIncompleteTailBytes = size0 - w.cut; // old and permanent: kept byte for byte, never repaired
              w = { ...w, cut: size0 };
            }
          }
          length = w.cut;
          meta.records = w.records;
          if (w.unframed > 0) meta.unframedLines = w.unframed;
        }
        const h = createHash('sha256');
        for (let at = 0; at < length; at += CHUNK) h.update(readAt(fs, fd, Math.min(CHUNK, length - at), at));
        meta.size = length;
        meta.sha256 = h.digest('hex');
        const header = Buffer.from(JSON.stringify(meta), 'utf8');
        writeAll(fs, out, u32(header.length));
        writeAll(fs, out, header);
        // The same bytes again, from the same fixed range: a log only grows past `length`, a whole file was opened once.
        for (let at = 0; at < length; at += CHUNK) writeAll(fs, out, readAt(fs, fd, Math.min(CHUNK, length - at), at));
        toc.push(meta);
      } finally { fs.closeSync(fd); }
    }
    const end = Buffer.from(JSON.stringify({ end: true, count: toc.length }), 'utf8');
    writeAll(fs, out, u32(end.length));
    writeAll(fs, out, end);
    try { fs.fsyncSync(out); } catch { /* best effort */ }
  } finally { fs.closeSync(out); }
  return toc;
}

/**
 * Read a bundle back and check it: every file's SHA-256 and, for each log, that it holds exactly the complete records
 * its header says. Returns { ok, files, problems } — the contents are never returned (they include the till's PIN
 * verifiers and its signing key; restore-check only says what it found).
 */
export function checkBundle(fs, bundlePath) {
  const fd = fs.openSync(bundlePath, 'r');
  const problems = [];
  const files = [];
  try {
    if (!readAt(fs, fd, BUNDLE_MAGIC.length, 0).equals(BUNDLE_MAGIC)) return { ok: false, files, problems: ['it is not a till data bundle'] };
    let at = BUNDLE_MAGIC.length;
    for (;;) {
      const lenBuf = readAt(fs, fd, 4, at);
      if (lenBuf.length !== 4) { problems.push('the bundle is cut short (no end marker)'); break; }
      const raw = readAt(fs, fd, lenBuf.readUInt32BE(), at + 4);
      let meta;
      try { meta = JSON.parse(raw.toString('utf8')); } catch { problems.push('a file header in the bundle is damaged'); break; }
      at += 4 + raw.length;
      if (meta.end === true) {
        if (meta.count !== files.length) problems.push(`the bundle says ${meta.count} file(s) but holds ${files.length}`);
        break;
      }
      const h = createHash('sha256');
      for (let off = 0; off < meta.size; off += CHUNK) h.update(readAt(fs, fd, Math.min(CHUNK, meta.size - off), at + off));
      if (h.digest('hex') !== meta.sha256) problems.push(`${meta.name}: its contents do not match its SHA-256`);
      if (meta.kind === 'log' && meta.keptIncompleteTailBytes === undefined) {
        const w = walkFrames(fs, fd, at, at + meta.size);
        if (w.cut !== at + meta.size || w.records !== meta.records) problems.push(`${meta.name}: ${w.records} whole record(s) found, ${meta.records} expected`);
      }
      files.push(meta);
      at += meta.size;
    }
  } finally { fs.closeSync(fd); }
  return { ok: problems.length === 0, files, problems };
}

/** A short plain summary of the till's part of a backup, from its table of contents. */
export function tillSummary(toc) {
  const logs = toc.filter((f) => f.kind === 'log');
  const records = (re) => logs.filter((f) => re.test(f.name)).reduce((a, f) => a + (f.records ?? 0), 0);
  return {
    files: toc.length,
    logs: logs.length,
    saleRecords: records(/\/sales\.log$/),
    deadLetterRecords: records(/\/dead-letters[^/]*$/),
    pinCredentials: toc.some((f) => /till-credentials\.json$/.test(f.name)),
    inFlightBytes: toc.reduce((a, f) => a + (f.inFlightBytes ?? 0), 0),
    keptIncompleteTails: toc.filter((f) => f.keptIncompleteTailBytes !== undefined).map((f) => f.name),
  };
}
