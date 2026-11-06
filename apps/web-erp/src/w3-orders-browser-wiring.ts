// W3 (online orders · M18 · D05-FR-03) — the browser wiring for the two office pages this wave adds, kept in one file so the
// shared bundle entry (browser-entry.ts) carries one import and one call. Each page's tested session is attached to its own
// window global from the viewer the front door injected (identity only). Nothing is read or written here.

import { createOnlineOrdersSession, onlineOrdersWords, onlineOrdersOutcomeWords, rupees as orderRupees, NEXT_STEPS } from './online-orders-session';
import { createDeliveryAreaSession, deliveryAreaWords, deliveryAreaOutcomeWords, areaShown, rupees as areaRupees } from './delivery-area-session';
import { shopMomentOf } from './findings-session';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** The store the box named for a page (its own store, from its signed pack), when it named one. */
const storeOf = (raw: unknown): string | undefined => {
  const id = raw !== null && typeof raw === 'object' ? (raw as { storeId?: unknown }).storeId : undefined;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
};
/** The shop's own date today (OB-606: the shop's zone, never the device's). */
const shopToday = (): string => shopDateIn(new Date().toISOString(), servedShopZone());

export function wireW3Orders(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['onlineOrdersData'] !== undefined) {
    win['onlineOrders'] = {
      session: createOnlineOrdersSession({ viewer: viewerIdentity(win['onlineOrdersData']) }), words: onlineOrdersWords, outcomeWords: onlineOrdersOutcomeWords,
      rupees: orderRupees, nextSteps: NEXT_STEPS, moment: shopMomentOf, storeId: storeOf(win['onlineOrdersData']) ?? '',
    };
  }
  if (win['deliveryAreaData'] !== undefined) {
    win['deliveryArea'] = {
      session: createDeliveryAreaSession({ viewer: viewerIdentity(win['deliveryAreaData']) }), words: deliveryAreaWords, outcomeWords: deliveryAreaOutcomeWords,
      shown: areaShown, rupees: areaRupees, moment: shopMomentOf, today: shopToday,
    };
  }
}
