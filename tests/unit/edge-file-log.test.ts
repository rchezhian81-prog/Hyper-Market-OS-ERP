import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileLog, readLog } from '../../edge/store-edge/src/file-log';
import { commitLocally } from '../../edge/store-edge/src/durability';

// P-01 · hard rules #1 #2 #6 · §31.
//
// `DurableLog` was a port with a test double behind it and nothing else, so `commitLocally` — the
// function that decides whether a receipt may print — was writing to an interface no deployment
// could satisfy. The offline-first claim rested on a file that did not exist.

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-edge-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('the disk the receipt waits for', () => {
  it('writes a sale and reads it back whole', async () => {
    const log = await openFileLog({ dataDir: await tempDir(), capacityBytes: 1_000_000 });
    await log.append('{"saleId":"S-1","totalMinor":64000}');
    await log.close();

    const records = await readLog(log.path);
    expect(records).toHaveLength(1);
    expect(records[0]?.ok).toBe(true);
    expect(records[0]?.ok === true && JSON.parse(records[0].record)).toMatchObject({ saleId: 'S-1' });
  });

  it('APPENDS on reopen — it never truncates what is already there (hard rule #2)', async () => {
    // 'a' rather than 'w'. The difference is a day's takings.
    const dir = await tempDir();
    const first = await openFileLog({ dataDir: dir, capacityBytes: 1_000_000 });
    await first.append('one');
    await first.close();

    const second = await openFileLog({ dataDir: dir, capacityBytes: 1_000_000 });
    await second.append('two');
    await second.close();

    const records = await readLog(second.path);
    expect(records.map((r) => (r.ok ? r.record : null))).toEqual(['one', 'two']);
  });

  it('reports its size from the FILESYSTEM, not from a counter it kept', async () => {
    // A counter is right until the process restarts after a crash, which is exactly when the
    // number is load-bearing: it decides whether the next sale is refused for want of room.
    const dir = await tempDir();
    const first = await openFileLog({ dataDir: dir, capacityBytes: 1_000_000 });
    await first.append('a sale');
    await first.close();

    const reopened = await openFileLog({ dataDir: dir, capacityBytes: 1_000_000 });
    expect(await reopened.usedBytes()).toBeGreaterThan(0);
    await reopened.close();
  });

  it('round-trips a record whose text contains backslash-n, which JSON writes for a newline', async () => {
    // The bug this caught. The first version escaped newlines so the file could be read with
    // `split()`, and mangled every record legitimately containing the two characters backslash-`n`
    // — which is exactly what `JSON.stringify` writes for a line break. A sale carrying a note with
    // a line break came back as invalid JSON: a lost sale, produced by the code whose whole job is
    // not losing sales.
    const note = 'line one\nline two';
    const log = await openFileLog({ dataDir: await tempDir(), capacityBytes: 1_000_000 });
    await log.append(JSON.stringify({ saleId: 'S-1', note }));
    await log.close();

    const records = await readLog(log.path);
    expect(records).toHaveLength(1);
    expect(records[0]?.ok === true && JSON.parse(records[0].record).note).toBe(note);
  });

  it('round-trips a record containing a RAW newline, without cutting the sale in half', async () => {
    // Nothing stops a caller writing one, and splitting on newlines would make two records out of
    // one sale — the second of them nonsense. The length prefix is what makes that impossible.
    const log = await openFileLog({ dataDir: await tempDir(), capacityBytes: 1_000_000 });
    await log.append('first half\nsecond half');
    await log.close();

    const records = await readLog(log.path);
    expect(records).toHaveLength(1);
    expect(records[0]?.ok === true && records[0].record).toBe('first half\nsecond half');
  });
});

describe('a crash mid-write is visible, never silent (hard rule #6)', () => {
  it('QUARANTINES a truncated tail instead of parsing it or dropping it', async () => {
    // Power goes while a record is half-written. A half-sale silently discarded is the failure the
    // whole file exists to prevent, arriving one layer down; a half-sale silently repaired is a
    // made-up sale. The only honest thing is to put it in front of a person.
    const dir = await tempDir();
    const log = await openFileLog({ dataDir: dir, capacityBytes: 1_000_000 });
    await log.append('{"saleId":"S-1"}');
    await log.close();

    // Simulate the power cut: the frame says more bytes than arrived.
    await appendFile(log.path, '40 {"saleId":"S-2","tot\n');

    const records = await readLog(log.path);
    expect(records).toHaveLength(2);
    expect(records[0]?.ok).toBe(true);
    expect(records[1]).toMatchObject({ ok: false, reason: 'truncated' });
    // Kept, so somebody can look at it.
    expect(records[1]?.ok === false && records[1].raw).toContain('S-2');
  });

  it('detects truncation by ARITHMETIC, not by whether the JSON looks complete', async () => {
    // A truncated record can be perfectly valid JSON — `{"saleId":"S-2"}` is a prefix of
    // `{"saleId":"S-2","totalMinor":64000}` only by luck, but `{"a":1}` truncated to `{"a":1` is
    // not, and neither judgement belongs in a durability check.
    const dir = await tempDir();
    await writeFile(join(dir, 'sales.log'), '99 {"saleId":"S-9"}\n');
    const records = await readLog(join(dir, 'sales.log'));
    expect(records[0]).toMatchObject({ ok: false, reason: 'truncated' });
  });

  it('flags a line with no frame at all rather than guessing', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'sales.log'), 'somebody edited this file by hand\n');
    expect((await readLog(join(dir, 'sales.log')))[0]).toMatchObject({ ok: false, reason: 'unframed' });
  });

  it('returns nothing for a log that does not exist, rather than throwing', async () => {
    expect(await readLog(join(await tempDir(), 'never-written.log'))).toEqual([]);
  });
});

describe('the real log satisfies the contract commitLocally was written against', () => {
  it('commits a sale, durably, and says so', async () => {
    // Comfortably above `commitLocally`'s 1 MiB default reserve — a capacity below the reserve
    // refuses every sale, which is correct behaviour and a useless fixture.
    const log = await openFileLog({ dataDir: await tempDir(), capacityBytes: 10_485_760 });
    const outcome = await commitLocally({ saleId: 'S-1', record: '{"saleId":"S-1"}', log });

    expect(outcome.committed).toBe(true);
    // Typed as the literal `true`: if it is returned, the sale is on the disk.
    expect(outcome.durable).toBe(true);
    await log.close();

    expect((await readLog(log.path))[0]?.ok).toBe(true);
  });

  it('REFUSES a sale there is no room for — before the customer pays', async () => {
    // The edge is the one place refusing a sale is correct, and it is correct because of the
    // moment: nothing has happened yet and the customer is still standing there.
    const dir = await tempDir();
    const log = await openFileLog({ dataDir: dir, capacityBytes: 64 });
    await log.append('x'.repeat(60));

    const outcome = await commitLocally({ saleId: 'S-2', record: '{"saleId":"S-2"}', log });
    expect(outcome.committed).toBe(false);
    expect(outcome.refusedBecause).toBe('no_room_left');
    await log.close();

    // And nothing half-written was left behind by the refusal.
    const records = await readLog(log.path);
    expect(records.every((r) => r.ok)).toBe(true);
  });
});
