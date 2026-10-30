import { describe, it, expect } from 'vitest';
import { todayFigures, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import { emptyPack, known, type StorePack } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **Round 16 (R16-A · P3 · M01-FR-02 · P-08): the manager's Today figures on the store computer count "deliveries today"
 * and "expiring soon" on the SHOP's day — a moment in the pack is read in the shop's zone, offline, from the signed pack.**
 *
 * Before round 16 `screen-data.ts` took the first ten characters of every value, so a delivery slot at 00:30 in the shop
 * (19:00 UTC the day before) was not "today", and a batch whose use-by moment is already the next shop day counted a day
 * early. A plain date (`expiresOn: '2026-10-31'`) and a date-time with no zone are already the shop's and are kept.
 */

const SHOP_DAY = '2026-10-30';
const input = (pack: StorePack): ScreenInput =>
  ({ pack, sales: [], unreadableRecords: 0, outbox: new SyncOutbox(), now: '2026-10-29T19:30:00.000Z', tradingDay: SHOP_DAY }) as unknown as ScreenInput;
const bare = (): StorePack => emptyPack('this test pulled nothing');
const slot = (orderId: string, slotStartsAt: string) => ({ orderId, slotId: 's', slotStartsAt, slotEndsAt: slotStartsAt, area: 'A', codMinor: 0 });
const withZone = (pack: StorePack, timeZone: string): StorePack => ({ ...pack, policies: known({ tradingDayCutoff: '00:00', timeZone }) as unknown as StorePack['policies'] });

describe('deliveries today are the slots on the shop\'s day (P3)', () => {
  const deliveries = known([
    slot('o-0030', '2026-10-29T19:00:00.000Z'), // 00:30 on the 30th in the shop — today
    slot('o-noon', `${SHOP_DAY}T12:00:00+05:30`), // today, written in the shop's own offset
    slot('o-next', '2026-10-31T00:30:00+05:30'), // 00:30 on the 31st in the shop — tomorrow
  ]) as StorePack['deliveries'];
  it('a slot at 00:30 shop time counts on the shop\'s day; one at 00:30 the next shop day does not', () => {
    expect(todayFigures(input({ ...bare(), deliveries }))['deliveriesToday']).toEqual({ known: true, value: 2, note: 'customer deliveries in today\'s slots' });
  });
  it('the zone is the signed pack\'s: a pack naming Europe/London counts the slots on London\'s day', () => {
    expect(todayFigures(input(withZone({ ...bare(), deliveries }, 'Europe/London')))['deliveriesToday']).toMatchObject({ value: 2 }); // o-noon (06:30 UTC) and o-next (19:00 UTC on the 30th, London's 30th)
  });
});

describe('expiring soon counts the use-by on the shop\'s day (P3)', () => {
  const policy = known({ nearExpiryDays: 1 }) as StorePack['expiryPolicy'];
  it('a use-by moment already on the shop\'s day after tomorrow is outside a one-day window; plain dates are kept', () => {
    const batches = known([
      { batchId: 'b-moment', expiresAt: '2026-10-31T19:00:00.000Z' }, // 00:30 on 1 Nov in the shop — two days on
      { batchId: 'b-date', expiresOn: '2026-10-31' }, // a plain date: tomorrow — inside the window
    ]) as StorePack['batches'];
    expect(todayFigures(input({ ...bare(), batches, expiryPolicy: policy }))['expiringSoon']).toEqual({ known: true, value: 1, note: 'within 1 days, of 2 batches' });
  });
});
