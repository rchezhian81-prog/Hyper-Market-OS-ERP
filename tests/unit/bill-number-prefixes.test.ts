import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GST_INVOICE_NUMBER_MAX, RECEIPT_PREFIX_MAX, RECEIPT_COUNTER_MAX, readReceiptPrefix, receiptNumberFor, storeComputerDefaultPrefix,
  isStoreComputerDefaultReceipt,
} from '../../packages/contracts/src/receipt-number';
import { ReceiptNumbers, type PackReceiptSeries, type ReceiptNumberingContext } from '../../edge/store-edge/src/receipt-numbers';
import { foldTillPrefixes, issuedSeriesFor, type ReceiptPrefixIssue } from '../../services/platform/src/receipt-prefixes';

// OB-81 "A": the one rule head office, the store computer and the screen share — the 16-character bound, distinct prefixes
// giving distinct numbers, the reserved starts, the store computer's store-qualified default — and the box's register
// choosing its series by it. The connected proof (two real stores, boxes, tills, sync, PG) is
// tests/integration/bill-numbers-are-unique-across-stores.test.ts.

describe('OB-81 — the bill-number rule', () => {
  it('THE BOUND: every prefix head office may issue, with the largest count, is at most 16 characters', () => {
    expect(RECEIPT_PREFIX_MAX).toBe(10);
    for (let len = 2; len <= RECEIPT_PREFIX_MAX; len += 1) {
      const prefix = 'S'.padEnd(len - 1, '9') + '-';
      expect(readReceiptPrefix(prefix)).toEqual({ ok: true, prefix });
      expect(receiptNumberFor(prefix, RECEIPT_COUNTER_MAX).length).toBe(len + 6);
      expect(receiptNumberFor(prefix, RECEIPT_COUNTER_MAX).length).toBeLessThanOrEqual(GST_INVOICE_NUMBER_MAX);
    }
    expect(receiptNumberFor('S1L1-', 1)).toBe('S1L1-000001');
    // One more character and it is refused, in words.
    expect(readReceiptPrefix('S2LANE0001-')).toMatchObject({ ok: false, problem: 'too_long', words: expect.stringMatching(/at most 10/) });
  });

  it('refuses what GST does not allow in an invoice number, and the reserved starts', () => {
    for (const [p, problem] of [['s1l1-', 'characters'], ['S1 L1', 'characters'], [' S1L1-', 'characters'], ['S1L1_', 'characters'], ['S', 'too_short'], [7, 'not_text'],
      ['R-L1-', 'reserved_box_numbering'], ['ZZ1-', 'reserved_store_default']] as const) {
      expect(readReceiptPrefix(p), String(p)).toMatchObject({ ok: false, problem });
    }
    expect(readReceiptPrefix('S2/L1-')).toEqual({ ok: true, prefix: 'S2/L1-' });
  });

  it('DISTINCT PREFIXES GIVE DISTINCT NUMBERS: no two prefixes, of any lengths, ever produce one number', () => {
    // Prefixes chosen to tempt a clash: one a leading part of another, digits at the end.
    const prefixes = ['S1', 'S1-', 'S1-0', 'S1-00', 'S10', 'S1L1-', 'S1L1-0', 'S1L10', 'S11', 'A/1', 'A/10'];
    const seen = new Map<string, string>();
    for (const p of prefixes) {
      for (const n of [1, 2, 9, 10, 99, 100, 999, 1_000, 99_999, 100_000, RECEIPT_COUNTER_MAX]) {
        const num = receiptNumberFor(p, n);
        expect(seen.get(num), `${num} from ${p} and ${seen.get(num) ?? ''}`).toBeUndefined();
        seen.set(num, p);
      }
    }
  });

  it('the store computer\'s default: deterministic, store-qualified, 9 characters, never a head-office prefix', () => {
    const a = storeComputerDefaultPrefix('S1', 'lane-1');
    expect(a).toBe(storeComputerDefaultPrefix('S1', 'lane-1'));
    expect(a).toMatch(/^ZZ[A-Z2-7]{6}-$/);
    expect(a).not.toBe(storeComputerDefaultPrefix('S2', 'lane-1'));
    expect(a).not.toBe(storeComputerDefaultPrefix('S1', 'lane-2'));
    expect(readReceiptPrefix(a)).toMatchObject({ ok: false, problem: 'reserved_store_default' });
    expect(receiptNumberFor(a, RECEIPT_COUNTER_MAX).length).toBe(15);
    expect(isStoreComputerDefaultReceipt(receiptNumberFor(a, 1))).toBe(true);
    expect(isStoreComputerDefaultReceipt('S1L1-000001')).toBe(false);
    expect(isStoreComputerDefaultReceipt('R-lane-1-000001')).toBe(false);
    // Spread: many stores and tills, all different.
    const many = new Set<string>();
    for (let s = 1; s <= 40; s += 1) for (let l = 1; l <= 12; l += 1) many.add(storeComputerDefaultPrefix(`S${s}`, `lane-${l}`));
    expect(many.size).toBe(480);
  });

  it('head office\'s fold: the current prefix per (store, till), its history kept; the pack series is 1…999 999, 6 digits', () => {
    const at = '2026-10-12T08:00:00.000Z';
    const issues: ReceiptPrefixIssue[] = [
      { storeId: 'S1', tillId: 'lane-1', prefix: 'S1L1-', version: 1, setBy: 'u', setAt: at },
      { storeId: 'S2', tillId: 'lane-1', prefix: 'S2L1-', version: 1, setBy: 'u', setAt: at },
      { storeId: 'S1', tillId: 'lane-1', prefix: 'S1A1-', version: 2, setBy: 'u', setAt: at },
    ];
    expect(foldTillPrefixes(issues).map((t) => [t.storeId, t.tillId, t.prefix, t.version, t.history.length])).toEqual([['S1', 'lane-1', 'S1A1-', 2, 2], ['S2', 'lane-1', 'S2L1-', 1, 1]]);
    expect(issuedSeriesFor(issues, 'S1')).toEqual([{ laneId: 'lane-1', prefix: 'S1A1-', padTo: 6, rangeStart: 1, rangeEnd: 999_999 }]);
    expect(issuedSeriesFor(issues, 'S3')).toEqual([]);
  });
});

describe('OB-81 — the box chooses a lane\'s series by the rule', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
  const open = async (state: { published: PackReceiptSeries[] | null; numbering: ReceiptNumberingContext }, dir?: string) => {
    const d = dir ?? await mkdtemp(join(tmpdir(), 'sre-ob81-reg-'));
    if (dir === undefined) dirs.push(d);
    return { reg: await ReceiptNumbers.open({ dataDir: d, capacityBytes: 1_048_576, published: () => state.published, numbering: () => state.numbering }), dir: d };
  };
  const issue = async (reg: ReceiptNumbers, lane: string, key: string) => {
    const r = await reg.issue({ laneId: lane, requestKey: key, issuedTo: 'u1' });
    if (!r.issued) throw new Error(r.laneMessage);
    return r;
  };

  it('one store: today\'s R-<lane>- numbering; two stores: the store default, said aloud; then head office\'s prefix', async () => {
    const state: { published: PackReceiptSeries[] | null; numbering: ReceiptNumberingContext } = { published: null, numbering: { storeId: 'S1', storesInBusiness: 1 } };
    const { reg, dir } = await open(state);
    expect(await issue(reg, 'lane-1', 'a')).toMatchObject({ receiptNumber: 'R-lane-1-000001', source: 'this_box' });
    state.numbering = { storeId: 'S1', storesInBusiness: 2 };
    const d = await issue(reg, 'lane-1', 'b');
    expect(d).toMatchObject({ receiptNumber: `${storeComputerDefaultPrefix('S1', 'lane-1')}000001`, source: 'store_default', laneMessage: expect.stringMatching(/more than one store/) });
    expect(reg.status('lane-1')).toMatchObject({ source: 'store_default', prefix: storeComputerDefaultPrefix('S1', 'lane-1') });
    state.published = [{ laneId: 'lane-1', prefix: 'S1L1-', padTo: 6, rangeStart: 1, rangeEnd: 999_999 }];
    const p = await issue(reg, 'lane-1', 'c');
    expect(p).toMatchObject({ receiptNumber: 'S1L1-000001', source: 'published' });
    expect(p.laneMessage).toBeUndefined();
    // A restart: the published series carries on from the disk.
    await reg.close();
    const again = await open(state, dir);
    expect(await issue(again.reg, 'lane-1', 'd')).toMatchObject({ receiptNumber: 'S1L1-000002' });
    await again.reg.close();
  });

  it('a pack that does not say how many stores (an old pack, a file) keeps today\'s numbering — unless it would pass 16 characters', async () => {
    const { reg } = await open({ published: null, numbering: { storeId: null, storesInBusiness: null } });
    expect(await issue(reg, 'lane-1', 'a')).toMatchObject({ receiptNumber: 'R-lane-1-000001' });
    // `R-checkout-07-000001` would be 20 characters: the store default instead, within 16.
    const long = await issue(reg, 'checkout-07', 'b');
    expect(long.source).toBe('store_default');
    expect(long.receiptNumber.length).toBeLessThanOrEqual(GST_INVOICE_NUMBER_MAX);
    await reg.close();
  });

  it('a range head office re-drew over numbers this box already gave is never given twice', async () => {
    const state: { published: PackReceiptSeries[] | null; numbering: ReceiptNumberingContext } = { published: [{ laneId: 'lane-1', prefix: 'S1L1-', padTo: 6, rangeStart: 1, rangeEnd: 999_999 }], numbering: { storeId: 'S1', storesInBusiness: 2 } };
    const { reg } = await open(state);
    await issue(reg, 'lane-1', 'a');
    await issue(reg, 'lane-1', 'b');
    state.published = [{ laneId: 'lane-1', prefix: 'S1L1-', padTo: 6, rangeStart: 1, rangeEnd: 500_000 }];
    expect(await issue(reg, 'lane-1', 'c')).toMatchObject({ receiptNumber: 'S1L1-000003' });
    await reg.close();
  });
});
