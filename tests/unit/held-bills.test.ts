import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeldBills } from '../../edge/store-edge/src/held-bills';
import { PosSession, taxRateFromPercent } from '../../apps/pos/src/session';
import { money } from '../../packages/contracts/src/money';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import type { SuspensionPolicy } from '../../packages/suspended-sales/src/suspended-bill';

// The box's held-basket register on its own (audit PF-05 · M12-FR-02): the shop's policy on another till recalling a
// basket, the price window, a register that cannot write — and the till session handing a basket over and taking it
// back with its prices, HSN codes, age requirements and age answers intact. A real box is proved in
// tests/integration/a-held-basket-survives-a-reload.test.ts.

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const LINE = { lineId: 'L1', productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 12_000, quantityMinor: 1, uom: 'ea', taxBps: 500, voided: false };
const open = async (policy: SuspensionPolicy | null, now: () => string = () => '2026-10-09T10:00:00.000Z') => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-held-register-'));
  dirs.push(dir);
  return HeldBills.open({ dataDir: dir, capacityBytes: 1_048_576, tenantId: 't-sre', policy: () => policy, storeId: () => 'store-1', now });
};

describe('the box\'s held-basket register (audit PF-05)', () => {
  it('another till may recall a basket only when the shop\'s policy allows it', async () => {
    const strict = await open(null);
    await strict.hold({ laneId: 'lane-1', cashierId: 'u1', billId: 'H-1', lines: [LINE] });
    expect(strict.list('lane-2')).toEqual([]);
    expect(await strict.recall({ laneId: 'lane-2', byUserId: 'u2', billId: 'H-1' })).toMatchObject({ recalled: false, refusedBecause: 'other_lane' });
    await strict.close();

    const open2 = await open({ allowCrossLaneRecall: true });
    await open2.hold({ laneId: 'lane-1', cashierId: 'u1', billId: 'H-1', lines: [LINE] });
    expect(open2.list('lane-2').map((b) => b.billId)).toEqual(['H-1']);
    expect(await open2.recall({ laneId: 'lane-2', byUserId: 'u2', billId: 'H-1' })).toMatchObject({ recalled: true });
    await open2.close();
  });

  it('a basket held past the shop\'s price window comes back marked "check every price"', async () => {
    let at = '2026-10-09T10:00:00.000Z';
    const reg = await open({ repriceAfterMinutes: 30 }, () => at);
    await reg.hold({ laneId: 'lane-1', cashierId: 'u1', billId: 'H-1', lines: [LINE] });
    at = '2026-10-09T11:00:00.000Z';
    expect(await reg.recall({ laneId: 'lane-1', byUserId: 'u1', billId: 'H-1' })).toMatchObject({
      recalled: true, repriceRequired: true, minutesParked: 60, laneMessage: expect.stringMatching(/Check each price against the shelf/),
    });
    await reg.close();
  });

  it('a register that cannot write holds nothing — and says the basket is still on the till', async () => {
    const reg = await open(null);
    await reg.close();
    expect(await reg.hold({ laneId: 'lane-1', cashierId: 'u1', billId: 'H-1', lines: [LINE] })).toMatchObject({ held: false, refusedBecause: 'could_not_write_durably', laneMessage: expect.stringMatching(/still on the till/) });
    expect(reg.list('lane-1')).toEqual([]);
  });

  it('a hold re-sent after a lost reply is the same hold, not a second copy; an unreadable basket is refused', async () => {
    const reg = await open(null);
    expect(await reg.hold({ laneId: 'lane-1', cashierId: 'u1', billId: 'H-1', lines: [LINE] })).toMatchObject({ held: true });
    expect(await reg.hold({ laneId: 'lane-1', cashierId: 'u1', billId: 'H-1', lines: [LINE] })).toMatchObject({ held: true });
    expect(reg.list('lane-1')).toHaveLength(1);
    expect(await reg.hold({ laneId: 'lane-1', cashierId: 'u1', billId: 'H-2', lines: [{ productId: 'P1' }] })).toMatchObject({ held: false, refusedBecause: 'basket_not_readable' });
    await reg.close();
  });
});

describe('the till session hands a basket over and takes it back whole (audit PF-05)', () => {
  const session = () => {
    const s = new PosSession(
      { laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-10-09', currency: 'INR', defaultTaxRate: taxRateFromPercent(18) },
      new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
      () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
    );
    s.setNow('2026-10-09T10:00:00Z');
    return s;
  };

  it('prices, tax, HSN code, age requirement and the age answer survive the round trip; the total is the same', async () => {
    const a = session();
    a.confirmAge(18, '2026-10-09T09:59:00Z', 'BEER');
    a.scan({ productId: 'BEER', description: 'Beer 650ml', unitPrice: money(18_000, 'INR'), quantityMinor: 2, uom: 'ea', taxRate: taxRateFromPercent(28), hsnCode: '22030000', minimumAge: 18 });
    a.scan({ productId: 'DAL', description: 'Toor dal 1kg', unitPrice: money(12_000, 'INR'), quantityMinor: 1, uom: 'ea', taxRate: taxRateFromPercent(5) });
    const before = a.totals();
    const held = a.basketToHold();

    // Through JSON — what the box's disk keeps — into a different session (the reloaded till).
    const b = session();
    const back = JSON.parse(JSON.stringify(held)) as typeof held;
    b.restoreHeld(back.lines, back.ageAnswers);
    expect(b.totals()).toEqual(before);
    expect(b.ageConfirmedAtLeast()).toBe(18);
    expect(b.basketToHold().lines.map((l) => [l.productId, l.unitPriceMinor, l.taxBps, l.hsnCode, l.minimumAge])).toEqual([['BEER', 18_000, 2_800, '22030000', 18], ['DAL', 12_000, 500, undefined, undefined]]);
    // And it can be paid: the age-restricted line is covered by the answer that came back with it.
    const sale = await b.commit('S-1', 'R-1', '2026-10-09T10:05:00Z', [{ kind: 'cash', amount: b.totals().payable, status: 'settled' }]);
    expect(sale.total.minor).toBe(before.payable.minor);
  });

  it('a held basket never lands on top of another customer\'s items', () => {
    const b = session();
    b.scan({ productId: 'DAL', description: 'Toor dal 1kg', unitPrice: money(12_000, 'INR'), quantityMinor: 1, uom: 'ea' });
    expect(() => b.restoreHeld([LINE])).toThrow();
  });
});
