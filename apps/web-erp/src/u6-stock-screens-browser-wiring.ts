// The browser wiring for the three U6 stock screens (UI/UX gap audit, 7 Nov 2026 · §27 Inventory "Ledger" / "Quarantine" /
// "Adjustment") — kept in one file so the shared bundle entry (browser-entry.ts) carries one import and one call. Each page's
// tested session is attached to the window from the viewer the store computer injected (identity only); creating a session
// does no I/O.

import { createStockLedgerSession } from './stock-ledger-session';
import { createQuarantineSession } from './quarantine-session';
import { createStockAdjustmentsSession } from './stock-adjustments-session';
import type { HeadOfficeHttp } from './head-office-http';
import { createShelfReturnSession } from './shelf-return-session';
import { createReceiptCorrectionSession } from './receipt-correction-session';
import {
  createPastWriteOffsSession, createCountHistorySession, createStockoutSession, createTransferSuggestionsSession,
  words as stockHistoryWords, fill, dayWords, qty, percent, failureWords, STOCKOUT_PERIODS,
} from './stock-history-session';
import { rupees } from './head-office-http';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireStockScreens(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined, http: () => HeadOfficeHttp): void {
  // Always attached, like Count plans: with no payload the viewer is "nobody", so the page says nobody is named, reads
  // nothing and offers nothing — but its words and its language toggle still work (the page never runs without a session).
  win['stockLedgerSession'] = createStockLedgerSession(viewerIdentity(win['stockLedgerData']), http());
  win['quarantineSession'] = createQuarantineSession(viewerIdentity(win['quarantineData']), http());
  win['stockAdjustmentsSession'] = createStockAdjustmentsSession(viewerIdentity(win['stockAdjustmentsData']), http());
  // S1 (batch 18c · OB-872): "Return to supplier" on the Quarantine page, for the person who may move stock.
  win['shelfReturnSession'] = createShelfReturnSession(viewerIdentity(win['quarantineData']), http());
  // R2 (batch 18c · OB-873): "Correct a saved receipt" on Goods receipt review, for the person who may move stock.
  win['receiptCorrectionSession'] = createReceiptCorrectionSession(viewerIdentity(win['goodsReceiptData']), http());
  // Batch 20b: earlier write-offs (S2) on Waste & write-off, earlier counts and their accuracy (S3) on Stock counts, what the
  // empty shelves cost (S4) on Stock health, suggested transfers (S5) on Transfers — each for its own page's viewer.
  win['stockHistory'] = Object.freeze({ words: stockHistoryWords, fill, dayWords, qty, percent, failureWords, rupees, periods: STOCKOUT_PERIODS });
  if (win['wasteData'] !== undefined) win['pastWriteOffsSession'] = createPastWriteOffsSession(viewerIdentity(win['wasteData']), http());
  if (win['countsData'] !== undefined) win['countHistorySession'] = createCountHistorySession(viewerIdentity(win['countsData']), http());
  if (win['stockHealthData'] !== undefined) win['stockoutSession'] = createStockoutSession(viewerIdentity(win['stockHealthData']), http());
  if (win['transfersData'] !== undefined) win['transferSuggestionsSession'] = createTransferSuggestionsSession(viewerIdentity(win['transfersData']), http());
}
