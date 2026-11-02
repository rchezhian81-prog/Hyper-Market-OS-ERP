// Browser entry — the bundler's input for the concessionaire's own counter portal (`node scripts/build-app.mjs concession-app`).
// It wires the tested session (concession-portal-session.ts) and attaches it as `window.concessionPortalSession`, plus a
// small read-only `window.concessionPortal` api that `web/app.js` binds to (M27-FR-02 · OB-676 "A").
//
// Like the supplier and business-customer portals this is a surface a party OUTSIDE the business uses, so it is served from
// the CLOUD web tier, never from a store's computer. The page is fed only WHO is looking (`window.concessionData` = the
// signed-in login's userId and permissions, injected by the cloud session); the four feeds are read LIVE, each scoped to the
// login's own concessionaire ON THE SERVER — the browser has no concessionaire id to send. All four are GETs; nothing is
// written, on open or ever, from this page.

import { attachShopDay } from '../../../packages/calendar/src/shop-day'; // OB-607
import {
  createConcessionPortalSession, fetchConcessionPortal,
  type ConcessionPortalSession, type ConcessionPortalData,
} from './concession-portal-session';

export interface ConcessionScreenData {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

interface ConcessionWindow {
  concessionData?: ConcessionScreenData;
  concessionPortalSession?: ConcessionPortalSession;
  concessionPortal?: {
    refresh(): Promise<ConcessionPortalData | null>;
    present(data: ConcessionPortalData): ConcessionPortalSession;
  };
}

const EMPTY: ConcessionPortalData = Object.freeze({ concessionaireId: null, counters: null, depositHeldMinor: null, sales: null, stock: null, invoices: null, refusals: {}, asAt: '' });

/** Wire the portal onto the given window. Nothing is attached when the page carried no login payload (the sample shows). */
export function attachConcessionPortal(win: ConcessionWindow): void {
  const data = win.concessionData;
  if (data === undefined) return;
  const viewer = { userId: data.userId ?? null, permissions: data.permissions ?? [] };
  win.concessionPortalSession = createConcessionPortalSession(viewer, EMPTY);
  win.concessionPortal = {
    refresh: () => fetchConcessionPortal(),
    present: (folded) => createConcessionPortalSession(viewer, folded),
  };
}

const browserWindow = (globalThis as { window?: ConcessionWindow }).window;
if (browserWindow !== undefined) attachConcessionPortal(browserWindow);

// OB-607: this page's shop's day as `window.sreShopDay` — the dates and times it shows are the shop's clock.
attachShopDay((globalThis as { window?: unknown }).window);
