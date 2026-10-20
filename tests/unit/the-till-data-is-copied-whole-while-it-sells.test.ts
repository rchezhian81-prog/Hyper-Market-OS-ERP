import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileLog, readLog } from '../../edge/store-edge/src/file-log';
import { checkBundle, tillSummary, writeBundle } from '../../scripts/lib/store-computer-files.mjs';

/**
 * OB-249 · audit lane B B3 — the till's own data (unsent sales, the queue, dead letters, PIN checks) is backed up while the
 * till keeps selling (hard rule #1: the backup never stops a sale). The store edge keeps no database: append-only framed
 * logs (`<length> <record>\n`, fsync'd) and small files replaced whole (temp + rename). So each log is copied up to its
 * last COMPLETE record — the way the edge's own reader walks it — a record being written that moment is left for the next
 * backup, an OLD incomplete tail is kept byte for byte (never dropped or repaired, hard rule #6), the small files go first,
 * the bill-number log last, `*.tmp` working copies never, and the witness is never even looked at (OB-87).
 */

const frame = (r: string): string => `${Buffer.byteLength(r, 'utf8')} ${r}\n`;
const folder = (): string => mkdtempSync(join(tmpdir(), 'sre-till-copy-'));

describe("the till's data bundle", () => {
  it('copies every whole record of a log the REAL edge wrote — a note with a newline in it included — and the bundle checks out', async () => {
    const d = folder();
    const data = join(d, 'edge-data');
    const log = await openFileLog({ dataDir: data, capacityBytes: 1e9 });
    await log.append(JSON.stringify({ saleId: 'S-1', note: 'two\nlines' }));
    await log.append(JSON.stringify({ saleId: 'S-2' }));
    await log.close();
    writeFileSync(join(data, 'sync-cursor'), '1\n');
    writeFileSync(join(data, 'signed-pack.json.tmp'), '{"half":');
    const toc = writeBundle(fs, 'linux', [{ prefix: 'till/edge-data', dir: data }], join(d, 'b'));
    expect(toc.map((e) => [e.name, e.kind, e.records])).toEqual([['till/edge-data/sync-cursor', 'file', undefined], ['till/edge-data/sales.log', 'log', 2]]);
    const check = checkBundle(fs, join(d, 'b'));
    expect(check).toMatchObject({ ok: true, problems: [] });
    expect(tillSummary(check.files)).toMatchObject({ files: 2, saleRecords: 2, inFlightBytes: 0 });
  });

  it('a record being written at that instant is NOT cut in half: it is left for the next backup, or taken whole once it finishes', () => {
    const d = folder();
    const data = join(d, 'edge-data');
    mkdirSync(data);
    const whole = frame('{"saleId":"S-1"}');
    const half = frame('{"saleId":"S-2","total":12345}');
    writeFileSync(join(data, 'sales.log'), whole + half.slice(0, 10));
    // The edge finishes its write while the copy waits: the record is then whole, and it goes in.
    const finished = writeBundle(fs, 'linux', [{ prefix: 'till/edge-data', dir: data }], join(d, 'b1'), { waitMs: 1, sleep: () => { appendFileSync(join(data, 'sales.log'), half.slice(10)); } });
    expect(finished[0]).toMatchObject({ records: 2, size: Buffer.byteLength(whole + half) });
    // A write still unfinished, and the next one already begun: only the whole records go in; the rest waits.
    writeFileSync(join(data, 'sales.log'), whole + half.slice(0, 10));
    const waiting = writeBundle(fs, 'linux', [{ prefix: 'till/edge-data', dir: data }], join(d, 'b2'), { waitMs: 1, sleep: () => { appendFileSync(join(data, 'sales.log'), `${half.slice(10)}${frame('{"saleId":"S-3"}').slice(0, 4)}`); } });
    expect(waiting[0]).toMatchObject({ records: 2, size: Buffer.byteLength(whole + half), inFlightBytes: 4 });
    expect(checkBundle(fs, join(d, 'b2')).ok).toBe(true);
  });

  it('an OLD incomplete tail (a power cut the edge itself quarantined) is kept byte for byte and flagged — never dropped, never repaired', () => {
    const d = folder();
    const data = join(d, 'edge-data');
    mkdirSync(data);
    const text = frame('{"saleId":"S-1"}') + frame('{"saleId":"S-2"}').slice(0, 9);
    writeFileSync(join(data, 'returns.log'), text);
    const [e] = writeBundle(fs, 'linux', [{ prefix: 'till/edge-data', dir: data }], join(d, 'b'), { waitMs: 1, sleep: () => undefined });
    expect(e).toMatchObject({ records: 1, size: Buffer.byteLength(text), keptIncompleteTailBytes: 9 });
    expect(tillSummary([e!]).keptIncompleteTails).toEqual(['till/edge-data/returns.log']);
    expect(checkBundle(fs, join(d, 'b')).ok).toBe(true);
  });

  it('order: the small files first, then the logs, the bill-number log LAST (more reservations than sales is the safe way round)', () => {
    const d = folder();
    const data = join(d, 'edge-data');
    mkdirSync(data);
    writeFileSync(join(data, 'receipt-numbers.log'), frame('{"n":1}'));
    writeFileSync(join(data, 'sales.log'), frame('{"s":1}'));
    writeFileSync(join(data, 'dead-letters'), frame('{"k":1}'));
    writeFileSync(join(data, 'till-credentials.json'), '{"version":1,"credentials":[]}\n');
    writeFileSync(join(data, 'sync-cursor'), '0\n');
    writeFileSync(join(d, 'till.env'), 'EDGE_LANE_ID=lane-1\n');
    const toc = writeBundle(fs, 'linux', [{ prefix: 'till/edge-data', dir: data }, { prefix: 'till/till.env', file: join(d, 'till.env') }, { prefix: 'records', dir: join(d, 'no-records-yet') }], join(d, 'b'));
    expect(toc.map((e) => e.name)).toEqual([
      'till/edge-data/sync-cursor', 'till/edge-data/till-credentials.json', 'till/till.env',
      'till/edge-data/dead-letters', 'till/edge-data/sales.log',
      'till/edge-data/receipt-numbers.log',
    ]);
    expect(tillSummary(toc)).toMatchObject({ saleRecords: 1, deadLetterRecords: 1, pinCredentials: true });
  });

  it('a bundle that was changed, cut short or is not one is said plainly by the check', () => {
    const d = folder();
    const data = join(d, 'edge-data');
    mkdirSync(data);
    writeFileSync(join(data, 'sales.log'), frame('{"saleId":"S-1"}') + frame('{"saleId":"S-2"}'));
    writeBundle(fs, 'linux', [{ prefix: 'till/edge-data', dir: data }], join(d, 'b'));
    const good = readFileSync(join(d, 'b'));
    const changed = Buffer.from(good);
    changed[good.indexOf('S-2') + 2] = 0x39;
    writeFileSync(join(d, 'changed'), changed);
    expect(checkBundle(fs, join(d, 'changed')).problems).toEqual(['till/edge-data/sales.log: its contents do not match its SHA-256']);
    writeFileSync(join(d, 'cut'), good.subarray(0, good.length - 12));
    expect(checkBundle(fs, join(d, 'cut')).ok).toBe(false);
    writeFileSync(join(d, 'other'), 'hello');
    expect(checkBundle(fs, join(d, 'other')).problems).toEqual(['it is not a till data bundle']);
  });

  it('what the copy keeps is exactly what the edge itself reads back', async () => {
    const d = folder();
    const data = join(d, 'edge-data');
    const log = await openFileLog({ dataDir: data, capacityBytes: 1e9, fileName: 'dead-letters' });
    for (let i = 0; i < 5; i += 1) await log.append(JSON.stringify({ key: `k${i}`, kind: 'dead_lettered', reason: 'refused\r\n by the books' }));
    await log.close();
    const [e] = writeBundle(fs, 'linux', [{ prefix: 'till/edge-data', dir: data }], join(d, 'b'));
    const edgeSees = (await readLog(join(data, 'dead-letters'))).filter((v) => v.ok).length;
    expect(e!.records).toBe(edgeSees);
    expect(e!.records).toBe(5);
  });
});
