import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptNumbers } from '../../edge/store-edge/src/receipt-numbers';

// The box's receipt-number register on its own (audit PF-04 · M01-FR-02): the rules a real box is proved on in
// tests/integration/receipt-numbers-come-from-the-box.test.ts, plus the failures a box cannot easily be made to have.

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
// A head-office series that obeys the OB-81 rule (verifier r17 OB81-3), with how far head office has banked under it.
const SERIES = [{ laneId: 'L1', prefix: 'L1-', padTo: 6, rangeStart: 10, rangeEnd: 12, bankedThrough: 0 }];
const open = async (over: { published?: typeof SERIES | null; committed?: { receiptNumber: string; recordId: string }[]; dir?: string } = {}) => {
  const dir = over.dir ?? await mkdtemp(join(tmpdir(), 'sre-receipt-register-'));
  if (over.dir === undefined) dirs.push(dir);
  const reg = await ReceiptNumbers.open({ dataDir: dir, capacityBytes: 1_048_576, published: () => (over.published === undefined ? SERIES : over.published), ...(over.committed === undefined ? {} : { committed: over.committed }) });
  return { reg, dir };
};

describe('the box\'s receipt-number register (audit PF-04)', () => {
  it('a number is only given once it is on the disk: a register that cannot write gives none', async () => {
    const { reg } = await open();
    await reg.close();
    expect(await reg.issue({ laneId: 'L1', requestKey: 'k1', issuedTo: 'u1' })).toMatchObject({ issued: false, refusedBecause: 'could_not_write_durably' });
    expect(reg.status('L1')).toMatchObject({ issued: 0 });
  });

  it('issues from the published range, per lane, and refuses past its end', async () => {
    const { reg } = await open();
    const got = [];
    for (const k of ['a', 'b', 'c']) got.push(await reg.issue({ laneId: 'L1', requestKey: k, issuedTo: 'u1' }));
    expect(got.map((g) => (g.issued ? g.receiptNumber : null))).toEqual(['L1-000010', 'L1-000011', 'L1-000012']);
    expect(await reg.issue({ laneId: 'L1', requestKey: 'd', issuedTo: 'u1' })).toMatchObject({ issued: false, refusedBecause: 'receipt_numbers_used_up' });
    // another lane, with no published range and a pack that does not say how many stores: the store-coded fallback, said
    // aloud (OB-85 — never R-<lane>-)
    expect(await reg.issue({ laneId: 'L2', requestKey: 'a', issuedTo: 'u2' })).toMatchObject({ issued: true, receiptNumber: expect.stringMatching(/^ZZ[A-Z2-7]{6}-000001$/), source: 'store_default', fallbackBecause: 'store_count_not_said' });
    await reg.close();
  });

  it('a number already on the sales log counts as used at start, even if its "used" line never made it to the register', async () => {
    const { reg, dir } = await open();
    const n = await reg.issue({ laneId: 'L1', requestKey: 'a', issuedTo: 'u1' });
    await reg.close();
    const again = (await open({ dir, committed: [{ receiptNumber: n.issued ? n.receiptNumber : '', recordId: 'S-1' }] })).reg;
    expect(again.checkUse({ laneId: 'L1', receiptNumber: 'L1-000010', recordId: 'S-other' })).toMatchObject({ ok: false, refusedBecause: 'receipt_number_already_used' });
    expect(again.checkUse({ laneId: 'L1', receiptNumber: 'L1-000010', recordId: 'S-1' })).toMatchObject({ ok: true });
    await again.close();
  });

  it('a number given to one lane cannot be used on another', async () => {
    const { reg } = await open();
    await reg.issue({ laneId: 'L1', requestKey: 'a', issuedTo: 'u1' });
    expect(reg.checkUse({ laneId: 'L2', receiptNumber: 'L1-000010', recordId: 'S-1' })).toMatchObject({ ok: false, refusedBecause: 'receipt_number_not_issued' });
    expect(reg.checkUse({ laneId: 'L1', receiptNumber: undefined, recordId: 'S-1' })).toMatchObject({ ok: false, refusedBecause: 'receipt_number_missing' });
    await reg.close();
  });
});
