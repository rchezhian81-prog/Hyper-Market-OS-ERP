// The price kiosk's composition root (D14-FR-02 · R8-3 · P-01). The store computer serves the page with its signed
// catalogue (`window.posCatalogue`) and, when the owner has set it, the "stop quoting after" minutes
// (`window.priceKiosk.staleAfterMinutes`). Nothing here calls any network: the kiosk is read-only.

import { attachShopDay } from '../../../packages/calendar/src/shop-day'; // OB-607
import type { CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import { createPriceKiosk, type PriceKiosk } from './price-kiosk';

interface KioskWindow {
  posCatalogue?: CatalogueSnapshot;
  priceKiosk?: { readonly staleAfterMinutes?: unknown; readonly timeZone?: unknown };
  kiosk?: PriceKiosk;
}

const w = (globalThis as { window?: KioskWindow }).window;
if (w !== undefined) {
  const set = w.priceKiosk?.staleAfterMinutes;
  w.kiosk = createPriceKiosk({
    ...(w.posCatalogue === undefined ? {} : { catalogue: w.posCatalogue }),
    staleAfterMinutes: typeof set === 'number' && Number.isSafeInteger(set) && set > 0 ? set : null,
    now: () => new Date().toISOString(),
    // R1c: the shop's zone, as the store computer serves it from its pack.
    ...(typeof w.priceKiosk?.timeZone === 'string' && w.priceKiosk.timeZone !== '' ? { timeZone: w.priceKiosk.timeZone } : {}),
  });
}

// OB-607: this page's shop's day as `window.sreShopDay` — the dates AND times of day it shows are the shop's clock, in the
// zone the store computer served from its signed pack (`window.shopTimeZone`; no network call), never this device's.
attachShopDay((globalThis as { window?: unknown }).window);
