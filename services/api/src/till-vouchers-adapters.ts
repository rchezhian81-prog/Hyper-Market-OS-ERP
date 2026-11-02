// Coupons and gift cards at the till — head office's side (W3 · D06-FR-03 · OB-673 · D07-FR-04 · OB-677).
//
//   • the two store-pack sections the store computer judges with no network: `coupons` (every live coupon and every
//     redemption head office holds of it) and `giftCards` (every gift card's balance, the till redemptions already in it,
//     and the owner's offline limit per till per card — a tenant setting, default ₹500);
//   • the dependencies of `tillVoucherEffects` (a banked sale's coupons and gift-card tenders) and of the till's gift-card
//     sale route, over the same append-only streams the office coupon and gift-card pages use.

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import type { ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import { balanceOf } from '../../../packages/loyalty/src/stored-value';
import type { Coupon, Redemption } from '../../../packages/loyalty/src/coupons';
import { DEFAULT_GIFT_CARD_OFFLINE_CAP_MINOR, type CouponPack, type GiftCardPack } from '../../../packages/loyalty/src/till-vouchers';
import type { TillVoucherDeps, TillGiftCardSale } from '../../customer/src/till-vouchers';
import { STREAM, streamName, couponAdapter, storedValueAdapter, posAdapter } from './adapters';

/** The coupon index the coupon register keeps (one `CouponIndexed` per code), shared with the stored fraud signals. */
export const COUPON_INDEX_STREAM = streamName(STREAM.lossPrevention, 'coupon-index');
const GIFT_CARD_TILL_SALES = streamName(STREAM.loyalty, 'gift-card-till-sales');

async function couponCodes(store: EventStore, tenantId: string): Promise<readonly string[]> {
  const rows = await store.readStream(tenantId, COUPON_INDEX_STREAM, { type: 'CouponIndexed' });
  return [...new Set(rows.map((e) => (e.event.payload as { code?: unknown }).code).filter((c): c is string => typeof c === 'string' && c !== ''))].sort();
}

/**
 * D06-FR-03 · OB-673: the `coupons` section — every coupon still valid on the shop's date today (or later) and every
 * redemption head office holds of it. Always sent (an empty list is "no live coupons", which the till says).
 */
export async function couponPackSectionFor(input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, timeZone: string): Promise<Omit<CouponPack, 'asOf'>> {
  const coupons = couponAdapter(input);
  const today = shopDateIn(input.now(), timeZone);
  const live: Coupon[] = [];
  const redemptions: Redemption[] = [];
  for (const code of await couponCodes(input.store, tenantId)) {
    const c = await coupons.coupon(tenantId, code);
    if (c === undefined || c.validUntil < today) continue;
    live.push(c);
    redemptions.push(...await coupons.redemptions(tenantId, code));
  }
  return { coupons: live, redemptions }; // no build time inside: an unchanged register is an unchanged pack (PA-06 renewal)
}

/**
 * D07-FR-04 · OB-677: the `giftCards` section — every gift card head office holds, its balance folded from every movement,
 * its expiry, the till redemptions already inside that balance, and the owner's offline limit (default ₹500).
 */
export async function giftCardPackSectionFor(
  input: { readonly store: EventStore; readonly now: () => string }, tenantId: string, offlineCapMinor: number | undefined,
): Promise<Omit<GiftCardPack, 'asOf'>> {
  const sv = storedValueAdapter(input);
  const index = await input.store.readStream(tenantId, streamName(STREAM.loyalty, 'instruments'), { type: 'StoredValueIssued' });
  const cards: GiftCardPack['cards'][number][] = [];
  for (const e of index) {
    const i = e.event.payload as { instrumentId?: unknown; kind?: unknown; expiresOn?: unknown };
    if (i.kind !== 'gift_card' || typeof i.instrumentId !== 'string') continue;
    const moves = await sv.movements(tenantId, i.instrumentId);
    cards.push({
      code: i.instrumentId, balanceMinor: balanceOf(moves, i.instrumentId),
      ...(typeof i.expiresOn === 'string' ? { expiresOn: i.expiresOn } : {}),
      appliedMovementIds: moves.filter((m) => m.movementId.startsWith('till:')).map((m) => m.movementId),
    });
  }
  return { offlineCapMinor: offlineCapMinor ?? DEFAULT_GIFT_CARD_OFFLINE_CAP_MINOR, cards };
}

/** What `tillVoucherEffects` and the till's gift-card sale route run on — the office pages' own streams. */
export function tillVoucherDepsOf(input: { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }): TillVoucherDeps {
  const coupons = couponAdapter(input);
  const sv = storedValueAdapter(input);
  const pos = posAdapter(input);
  return {
    now: input.now,
    ...(input.calendar === undefined ? {} : { calendar: input.calendar }),
    coupon: async (t, code) => coupons.coupon(t, code),
    redemptions: async (t, code) => coupons.redemptions(t, code),
    recordRedemption: async (t, r, key) => { await coupons.recordRedemption(t, r, key); },
    instrument: async (t, id) => sv.instrument(t, id),
    movements: async (t, id) => sv.movements(t, id),
    instrumentVersion: async (t, id) => (sv.instrumentVersion === undefined ? 0 : sv.instrumentVersion(t, id)),
    recordMovement: async (t, id, m, v) => { await sv.recordMovement(t, id, m, v); },
    recordIssue: async (t, i, opening) => { await sv.recordIssue(t, i, opening); },
    recordGiftCardSale: async (t, sale: TillGiftCardSale) => {
      await input.store.append(t, GIFT_CARD_TILL_SALES, makeEvent({
        id: `gc-till-sale-${sale.saleId}`, type: 'GiftCardSoldAtTill', occurredAt: input.now(),
        idempotencyKey: `gc-till-sale-${t}-${sale.saleId}`, source: 'api/customer', payload: sale,
      }));
    },
    recordExceptions: async (t, list) => { await pos.recordExceptions(t, list); },
  };
}
