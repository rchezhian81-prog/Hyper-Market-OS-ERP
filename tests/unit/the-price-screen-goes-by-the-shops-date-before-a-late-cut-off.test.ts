import { describe, it, expect } from 'vitest';
import { activationHoldReport } from '../../edge/store-edge/src/activation-hold';
import { cataloguePayload, type ScreenInput } from '../../edge/store-edge/src/screen-data';
import type { StorePack } from '../../edge/store-edge/src/store-pack';
import { resolvePrice, type PriceEntry } from '../../packages/price-list/src/price-list';
import { money } from '../../packages/contracts/src/money';

/**
 * **The Products and prices screen decides "today's price" by the SHOP's calendar date, also between the shop's midnight and
 * a later trading-day cut-off (M05-FR-01 · M01-FR-02 · R1c · OB-403 "A" · P-02 · P-08).**
 *
 * The clock is pinned inside the window where it went wrong: 19:30 UTC on 1 Nov 2026 is 01:00 on 2 Nov in the shop
 * (Asia/Kolkata), and the shop's cut-off is 02:00, so its TRADING day is still 1 Nov while its calendar date is 2 Nov.
 * Head office refuses a price dated before the shop's calendar today (services/pricing price-list.ts) and a price "from 2 Nov"
 * is in force from the shop's midnight (`effectiveInstant`), so the till charges it at 01:00 — but the store computer handed
 * the screen the trading day, and the screen said "No price set" beside it until 02:00. The store computer's clock-out hold
 * (OB-403) goes by the same calendar date, and reads an instant-dated entry on the shop's calendar, never its UTC date.
 */

const AT = '2026-11-01T19:30:00.000Z'; // 01:00 on 2 Nov in the shop; the UTC date is still 1 Nov
const pack = { policies: { known: true, value: { tradingDayCutoff: '02:00', timeZone: 'Asia/Kolkata' } } } as const;

function screenInput(now: string, tradingDay: string, entries: readonly { id: string; productId: string; effectiveFrom: string }[]): ScreenInput {
  const registers = {
    policies: { known: true, value: { storeId: 'S1', branchId: 'S1', branchName: 'Main', tradingDayCutoff: '02:00', timeZone: 'Asia/Kolkata', staleAfterSeconds: 300, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0 } },
    pricingPolicy: { known: true, value: { userId: 'u-pricing', approvers: ['u-owner'], marginFloorBps: 0 } },
    priceEntries: { known: true, value: entries.map((e) => ({ ...e, status: 'active', scope: 'store', scopeRef: 'S1', priceMinor: 6_200, version: 1 })) },
  };
  const storePack = new Proxy(registers, { get: (t, k) => (k in t ? t[k as keyof typeof t] : { known: false }) }) as unknown as StorePack;
  return { pack: storePack, tradingDay, now } as unknown as ScreenInput;
}

describe('the price screen goes by the shop\'s date at 01:00, before a 02:00 cut-off', () => {
  it('the store computer hands the screen the shop\'s calendar date, and the price from that date resolves as today\'s', () => {
    const cat = cataloguePayload(screenInput(AT, '2026-11-01', [{ id: 'e1', productId: 'p-rice', effectiveFrom: '2026-11-02' }]))!;
    expect(cat['today']).toBe('2026-11-02'); // the shop's calendar date — not the UTC date, not the trading day (1 Nov)
    // The screen resolves today's price at its day (catalogue-session.ts): the price "from 2 Nov" is found.
    const entry: PriceEntry = { id: 'e1', productId: 'p-rice', scope: 'store', scopeRef: 'S1', price: money(6_200, 'INR'), effectiveFrom: '2026-11-02', status: 'active', version: 1 };
    expect(resolvePrice([entry], { productId: 'p-rice', at: `${String(cat['today'])}T12:00:00.000Z`, storeId: 'S1' })?.id).toBe('e1');
    // A clock the box cannot read leaves the trading day it was given (nothing is made up).
    expect(cataloguePayload(screenInput('not a time', '2026-11-01', []))!['today']).toBe('2026-11-01');
  });

  it('a clock-out hold keeps the shop\'s calendar date of its cut-off, and reads an instant-dated price on the shop\'s calendar', () => {
    // The clock was found out at 00:30 on 2 Nov in the shop (19:00 UTC on 1 Nov); a day later it is 01:00 on 3 Nov there.
    const hold = { held: true as const, since: '2026-11-01T19:00:00.000Z', cutoffAt: '2026-11-01T19:00:00.000Z', offsetSeconds: -360, flagSeconds: 300 };
    const r = activationHoldReport({
      hold, pack, now: '2026-11-02T19:30:00.000Z',
      priceEntries: [
        { id: 'pe-2nov', productId: 'p1', effectiveFrom: '2026-11-02', status: 'active' },              // in force when the clock was trusted
        { id: 'pe-3nov-0030', productId: 'p1', effectiveFrom: '2026-11-02T19:00:00.000Z', status: 'active' }, // 00:30 on 3 Nov in the shop
      ],
    });
    expect(r.priceDay).toBe('2026-11-02'); // the cut-off's calendar date in the shop — its trading day (1 Nov) is not it
    // The 00:30-on-3-Nov price is held: its UTC date (2 Nov) would have passed it as already in force.
    expect(r.heldPrices.map((p) => p.id)).toEqual(['pe-3nov-0030']);
    const cat = cataloguePayload({ ...screenInput('2026-11-02T19:30:00.000Z', '2026-11-02', []), activationHold: r } as ScreenInput)!;
    expect(cat['today']).toBe('2026-11-02');
  });
});
