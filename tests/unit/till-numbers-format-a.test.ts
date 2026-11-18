import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptNumbers, readFormatA, type FormatAContext, type ReceiptNumberingContext } from '../../edge/store-edge/src/receipt-numbers';
import { openFileLog } from '../../edge/store-edge/src/file-log';
import { GST_INVOICE_NUMBER_MAX } from '../../packages/contracts/src/receipt-number';

// OB-847 · OB-844 A · OB-845 A · OB-846 A — the till's numbers in FORMAT A, on the store computer, offline. The rules of the
// older numbering (OB-81, OB-85, OB-87, OB-90, OB-100, OB-376, the witness) are proved where they always were; here: the new
// form, the separate return range, the 90,000 warning and the +50 overflow, the April restart in the shop's zone, the
// temporary range after a restore, and old numbers kept.

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const tmp = async (name: string): Promise<string> => { const d = await mkdtemp(join(tmpdir(), name)); dirs.push(d); return d; };

const FA = (over: Partial<FormatAContext> = {}): FormatAContext => ({ storeNumber: 1, laneCodes: { 'lane-1': 'L01', 'lane-2': 'L02', 'device:hh-1': 'Q01' }, banked: {}, ...over });

const open = async (o: { dir?: string; witnessDir?: string | null; formatA?: () => FormatAContext | null; now?: () => string; storesInBusiness?: number } = {}) => {
  const dir = o.dir ?? await tmp('sre-fa-');
  const ctx = (): ReceiptNumberingContext => ({ storeId: 'S1', storesInBusiness: o.storesInBusiness ?? 1, formatA: o.formatA === undefined ? FA() : o.formatA() });
  const reg = await ReceiptNumbers.open({
    dataDir: dir, capacityBytes: 4_194_304, published: () => null, numbering: ctx,
    ...(o.now === undefined ? {} : { now: o.now }),
    ...(o.witnessDir === undefined ? {} : { witnessDir: o.witnessDir }),
  });
  return { reg, dir };
};
const numberOf = (x: { issued: boolean; receiptNumber?: string }): string => (x.issued && x.receiptNumber !== undefined ? x.receiptNumber : `REFUSED:${JSON.stringify(x)}`);

describe('format A on the till (OB-847)', () => {
  it('bills are 1L01/26-27/00001…, returns their own range 1R01/…; each number ≤ 16 characters; a return\'s number is only a return\'s', async () => {
    const { reg } = await open({ now: () => '2026-11-18T05:00:00.000Z' });
    const a = await reg.issue({ laneId: 'lane-1', requestKey: 'a', issuedTo: 'u1' });
    const b = await reg.issue({ laneId: 'lane-1', requestKey: 'b', issuedTo: 'u1' });
    const r = await reg.issue({ laneId: 'lane-1', requestKey: 'r', issuedTo: 'u1', kind: 'return' });
    expect([numberOf(a), numberOf(b), numberOf(r)]).toEqual(['1L01/26-27/00001', '1L01/26-27/00002', '1R01/26-27/00001']);
    for (const n of [a, b, r]) expect(numberOf(n).length).toBeLessThanOrEqual(GST_INVOICE_NUMBER_MAX);
    expect(r).toMatchObject({ kind: 'return', source: 'published', financialYear: '2026-27' });
    // A lost reply re-asked: the same number.
    expect(numberOf(await reg.issue({ laneId: 'lane-1', requestKey: 'a', issuedTo: 'u1' }))).toBe('1L01/26-27/00001');
    // A bill's number cannot be a return's, nor the other way round.
    expect(reg.checkUse({ laneId: 'lane-1', receiptNumber: '1R01/26-27/00001', recordId: 'S-x', kind: 'sale' })).toMatchObject({ ok: false, refusedBecause: 'receipt_number_not_issued' });
    expect(reg.checkUse({ laneId: 'lane-1', receiptNumber: '1L01/26-27/00001', recordId: 'RT-x', kind: 'return' })).toMatchObject({ ok: false, refusedBecause: 'receipt_number_not_issued' });
    expect(reg.checkUse({ laneId: 'lane-1', receiptNumber: '1R01/26-27/00001', recordId: 'RT-1', kind: 'return' })).toMatchObject({ ok: true });
    // A handheld queue till rings bills under Q and takes no returns.
    expect(numberOf(await reg.issue({ laneId: 'device:hh-1', requestKey: 'q', issuedTo: 'u2' }))).toBe('1Q01/26-27/00001');
    expect(await reg.issue({ laneId: 'device:hh-1', requestKey: 'qr', issuedTo: 'u2', kind: 'return' })).toMatchObject({ issued: false, refusedBecause: 'no_return_range' });
    await reg.close();
  });

  it('two tills selling offline at the same moment never clash — and a restart carries each count on', async () => {
    const { reg, dir } = await open({ now: () => '2026-11-18T05:00:00.000Z' });
    const asks = [];
    for (let i = 0; i < 40; i += 1) asks.push(reg.issue({ laneId: i % 2 === 0 ? 'lane-1' : 'lane-2', requestKey: `k${i}`, issuedTo: 'u' }));
    const got = (await Promise.all(asks)).map(numberOf);
    expect(new Set(got).size).toBe(40);
    expect(got.filter((n) => n.startsWith('1L01/')).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `1L01/26-27/${String(i + 1).padStart(5, '0')}`));
    expect(got.filter((n) => n.startsWith('1L02/')).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `1L02/26-27/${String(i + 1).padStart(5, '0')}`));
    await reg.close();
    const again = (await open({ dir, now: () => '2026-11-18T06:00:00.000Z' })).reg;
    expect(numberOf(await again.issue({ laneId: 'lane-1', requestKey: 'after', issuedTo: 'u' }))).toBe('1L01/26-27/00021');
    await again.close();
  });

  it('the count starts again at 00001 on 1 April by the SHOP\'s date (IST), not UTC', async () => {
    let now = '2027-03-31T18:29:00.000Z'; // 31 March 23:59 IST
    const { reg } = await open({ now: () => now });
    expect(numberOf(await reg.issue({ laneId: 'lane-1', requestKey: 'a', issuedTo: 'u' }))).toBe('1L01/26-27/00001');
    expect(numberOf(await reg.issue({ laneId: 'lane-1', requestKey: 'b', issuedTo: 'u' }))).toBe('1L01/26-27/00002');
    now = '2027-03-31T18:30:00.000Z'; // 1 April 00:00 IST — still 31 March in UTC
    expect(numberOf(await reg.issue({ laneId: 'lane-1', requestKey: 'c', issuedTo: 'u' }))).toBe('1L01/27-28/00001');
    await reg.close();
  });

  it('resumes above what head office has banked (a replaced box never repeats a number)', async () => {
    const { reg } = await open({ formatA: () => FA({ banked: { '1L01/26-27/': 412 } }), now: () => '2026-11-18T05:00:00.000Z' });
    expect(numberOf(await reg.issue({ laneId: 'lane-1', requestKey: 'a', issuedTo: 'u' }))).toBe('1L01/26-27/00413');
    await reg.close();
  });

  it('OB-844 A: a warning from the 90,000th bill; at 99,999 the till moves to lane code + 50 by itself', async () => {
    const { reg } = await open({ formatA: () => FA({ banked: { '1L01/26-27/': 89_998 } }), now: () => '2026-11-18T05:00:00.000Z' });
    const n89999 = await reg.issue({ laneId: 'lane-1', requestKey: 'a', issuedTo: 'u' });
    expect(n89999).toMatchObject({ receiptNumber: '1L01/26-27/89999', runningLow: false });
    const n90000 = await reg.issue({ laneId: 'lane-1', requestKey: 'b', issuedTo: 'u' });
    expect(n90000).toMatchObject({ receiptNumber: '1L01/26-27/90000', runningLow: true, remaining: 9_999 });
    expect(n90000.issued && n90000.laneMessage).toMatch(/9,999 left .* moves to its next range \(1L51\) by itself/);
    expect(reg.status('lane-1')).toMatchObject({ runningLow: true });
    await reg.close();

    const full = (await open({ formatA: () => FA({ banked: { '1L01/26-27/': 99_998, '1R01/26-27/': 99_999 } }), now: () => '2026-11-18T05:00:00.000Z' })).reg;
    expect(numberOf(await full.issue({ laneId: 'lane-1', requestKey: 'x', issuedTo: 'u' }))).toBe('1L01/26-27/99999');
    expect(numberOf(await full.issue({ laneId: 'lane-1', requestKey: 'y', issuedTo: 'u' }))).toBe('1L51/26-27/00001');
    expect(numberOf(await full.issue({ laneId: 'lane-1', requestKey: 'z', issuedTo: 'u' }))).toBe('1L51/26-27/00002');
    expect(numberOf(await full.issue({ laneId: 'lane-1', requestKey: 'r', issuedTo: 'u', kind: 'return' }))).toBe('1R51/26-27/00001');
    await full.close();
  });

  it('a box restored from a backup numbers under a fresh, never-used temporary range (1T01…) until head office answers', async () => {
    const dir = await tmp('sre-fa-data-');
    const witnessDir = await tmp('sre-fa-witness-');
    const now = (): string => '2026-11-18T05:00:00.000Z';
    // The box numbers three bills; the data folder is copied (the backup) after the first.
    const first = (await open({ dir, witnessDir, now })).reg;
    expect(numberOf(await first.issue({ laneId: 'lane-1', requestKey: 'a', issuedTo: 'u' }))).toBe('1L01/26-27/00001');
    await first.close();
    const { readFile } = await import('node:fs/promises');
    const backup = await readFile(join(dir, 'receipt-numbers.log'));
    const second = (await open({ dir, witnessDir, now })).reg;
    expect(numberOf(await second.issue({ laneId: 'lane-1', requestKey: 'b', issuedTo: 'u' }))).toBe('1L01/26-27/00002');
    expect(numberOf(await second.issue({ laneId: 'lane-1', requestKey: 'c', issuedTo: 'u' }))).toBe('1L01/26-27/00003');
    await second.close();
    // The data folder is restored from the backup: the witness outside it holds 00002 and 00003, the log does not.
    await writeFile(join(dir, 'receipt-numbers.log'), backup);
    const restored = (await open({ dir, witnessDir, now })).reg;
    const t1 = await restored.issue({ laneId: 'lane-1', requestKey: 'd', issuedTo: 'u' });
    expect(t1).toMatchObject({ receiptNumber: '1T01/26-27/00001', source: 'store_default', fallbackBecause: 'restored_from_backup' });
    // A second lane takes its OWN temporary range; a return on lane-1 too — never one another lane holds.
    expect(numberOf(await restored.issue({ laneId: 'lane-2', requestKey: 'e', issuedTo: 'u' }))).toBe('1T02/26-27/00001');
    expect(numberOf(await restored.issue({ laneId: 'lane-1', requestKey: 'f', issuedTo: 'u', kind: 'return' }))).toBe('1T03/26-27/00001');
    // The lane's status says it is on the temporary range, and why.
    expect(restored.status('lane-1')).toMatchObject({ prefix: '1T01/26-27/', fallbackBecause: 'restored_from_backup' });
    await restored.close();
    // A restart while the restore is held stays on the same temporary range.
    const restart = (await open({ dir, witnessDir, now })).reg;
    expect(numberOf(await restart.issue({ laneId: 'lane-1', requestKey: 'g', issuedTo: 'u' }))).toBe('1T01/26-27/00002');
    // Head office's latest setup arrives (it banked 00003): the till goes back to 1L01, above everything ever given.
    await restart.headOfficeConfirmed('setup arrived');
    expect(numberOf(await restart.issue({ laneId: 'lane-1', requestKey: 'h', issuedTo: 'u' }))).toBe('1L01/26-27/00004');
    await restart.close();
  });

  it('a temporary range is never one head office has banked or this box used before', async () => {
    const { reg } = await open({ formatA: () => FA({ laneCodes: {}, banked: { '1T01/25-26/': 7, '1T02/26-27/': 3 } }), now: () => '2026-11-18T05:00:00.000Z' });
    expect(await reg.issue({ laneId: 'lane-9', requestKey: 'a', issuedTo: 'u' })).toMatchObject({ receiptNumber: '1T03/26-27/00001', fallbackBecause: 'till_code_not_issued' });
    await reg.close();
  });

  it('old numbers are kept: a box with older numbering history moves to format A and its old bills keep their numbers', async () => {
    const dir = await tmp('sre-fa-old-');
    // Before format A: the box numbered R-lane-1- bills (one-store business, its own history).
    const log = await openFileLog({ dataDir: dir, capacityBytes: 4_194_304, fileName: 'receipt-numbers.log' });
    await log.append(JSON.stringify({ kind: 'box', boxIdentity: 'box-1', at: '2026-11-01T00:00:00.000Z' }));
    await log.append(JSON.stringify({ kind: 'issued', laneId: 'lane-1', seriesKey: 'R-lane-1-|1|999999', seq: 57, receiptNumber: 'R-lane-1-000057', requestKey: 'old', issuedTo: 'u', at: '2026-11-01T00:00:00.000Z' }));
    await log.close();
    const reg = (await open({ dir, now: () => '2026-11-18T05:00:00.000Z' })).reg;
    // The old bill's number is still this box's and still usable by its record (nothing renumbered)…
    expect(reg.checkUse({ laneId: 'lane-1', receiptNumber: 'R-lane-1-000057', recordId: 'S-R-lane-1-000057' })).toMatchObject({ ok: true });
    // …and the next bill is the new form, starting at 00001 (OB-845 A: a new range from the day this is installed).
    expect(numberOf(await reg.issue({ laneId: 'lane-1', requestKey: 'new', issuedTo: 'u' }))).toBe('1L01/26-27/00001');
    await reg.close();
  });

  it('reads the pack\'s format-A section strictly — anything malformed is ignored, never guessed', () => {
    expect(readFormatA(undefined)).toBeNull();
    expect(readFormatA({ storeNumber: 10, laneCodes: {} })).toBeNull();
    expect(readFormatA({ storeNumber: 1, laneCodes: { a: 'L01', b: 'L50', c: 'X01', d: 'L5' }, banked: { '1L01/26-27/': 5, 'junk': 3, '1L02/26-27/': -1 } }))
      .toEqual({ storeNumber: 1, laneCodes: { a: 'L01' }, banked: { '1L01/26-27/': 5 } });
  });
});
