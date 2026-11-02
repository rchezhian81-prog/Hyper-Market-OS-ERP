import { describe, it, expect } from 'vitest';
import { PosSession, taxRateFromPercent } from '../../apps/pos/src/session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/outbox';

// M01-FR-02 · P-02 (W3): a till the box did not tell its zone (a page from an older box, or a test) dates a sale on the
// SHOP's day — the same default zone the box uses when the pack names none, and the zone the slip's time is printed in —
// never on whatever zone the device happens to be set to. 20:00 UTC on 1 Nov is 01:30 on 2 Nov in the shop.

const till = (over: Record<string, unknown> = {}) => new PosSession(
  { laneId: 'lane-1', cashierId: 'u-cash', currency: 'INR', defaultTaxRate: taxRateFromPercent(0), ...over } as ConstructorParameters<typeof PosSession>[0],
  new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
  () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
);

describe("a till told no zone dates by the shop's clock", () => {
  it('after the shop\'s midnight but before UTC midnight, the sale is on the shop\'s new day', () => {
    expect(till().tradingDayFor('2026-11-01T20:00:00.000Z')).toBe('2026-11-02');
    expect(till().tradingDayFor('2026-11-01T18:00:00.000Z')).toBe('2026-11-01'); // 23:30 in the shop — still the 1st
  });

  it('a zone the box names is still the one used, and a fixed day still wins', () => {
    expect(till({ timeZone: 'UTC' }).tradingDayFor('2026-11-01T20:00:00.000Z')).toBe('2026-11-01');
    expect(till({ tradingDay: '2026-10-31' }).tradingDayFor('2026-11-01T20:00:00.000Z')).toBe('2026-10-31');
  });

  it('the shop\'s cut-off still applies on the shop\'s clock', () => {
    // 02:00 cut-off: 01:30 in the shop belongs to the day before.
    expect(till({ tradingDayCutoff: '02:00' }).tradingDayFor('2026-11-01T20:00:00.000Z')).toBe('2026-11-01');
  });
});
