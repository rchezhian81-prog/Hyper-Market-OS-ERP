// The browser wiring for the three U6 stock screens (UI/UX gap audit, 7 Nov 2026 · §27 Inventory "Ledger" / "Quarantine" /
// "Adjustment") — kept in one file so the shared bundle entry (browser-entry.ts) carries one import and one call. Each page's
// tested session is attached to the window from the viewer the store computer injected (identity only); creating a session
// does no I/O.

import { createStockLedgerSession } from './stock-ledger-session';
import { createQuarantineSession } from './quarantine-session';
import { createStockAdjustmentsSession } from './stock-adjustments-session';
import type { HeadOfficeHttp } from './head-office-http';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireStockScreens(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined, http: () => HeadOfficeHttp): void {
  // Always attached, like Count plans: with no payload the viewer is "nobody", so the page says nobody is named, reads
  // nothing and offers nothing — but its words and its language toggle still work (the page never runs without a session).
  win['stockLedgerSession'] = createStockLedgerSession(viewerIdentity(win['stockLedgerData']), http());
  win['quarantineSession'] = createQuarantineSession(viewerIdentity(win['quarantineData']), http());
  win['stockAdjustmentsSession'] = createStockAdjustmentsSession(viewerIdentity(win['stockAdjustmentsData']), http());
}
