// The browser wiring for three head-office pages (round 6): Scrap and recycling (M28-FR-02), Packaging and crates (M28-FR-03)
// and Compare side by side (M29-FR-02 · §27 Owner "branch comparison") — kept in its own file so the shared bundle entry
// (browser-entry.ts) carries one import and one call. Each page's tested session is attached to `window.<page>` from the
// viewer the front door injected (`window.<page>Data`, identity only). Nothing is read or written here: every call is a click.

import { createScrapSession, scrapWords, scrapOutcomeWords, rupees as scrapRupees, kgWords, todayAtShop as scrapToday, SCRAP_CATEGORIES, SCRAP_DISPOSALS } from './scrap-session';
import { createPackagingSession, packagingWords, packagingOutcomeWords, rupees as packagingRupees, PACKAGING_KINDS, PACKAGING_MOVES } from './packaging-session';
import { createCompareSession, compareWords, compareOutcomeWords, rupees as compareRupees, rowTransactions, shareWords, todayAtShop as compareToday, COMPARE_BY } from './branch-compare-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireSalvageAndCompareScreens(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['scrapData'] !== undefined) {
    win['scrap'] = { session: createScrapSession({ viewer: viewerIdentity(win['scrapData']) }), words: scrapWords, outcomeWords: scrapOutcomeWords, rupees: scrapRupees, kg: kgWords, today: scrapToday, categories: SCRAP_CATEGORIES, disposals: SCRAP_DISPOSALS };
  }
  if (win['packagingData'] !== undefined) {
    win['packaging'] = { session: createPackagingSession({ viewer: viewerIdentity(win['packagingData']) }), words: packagingWords, outcomeWords: packagingOutcomeWords, rupees: packagingRupees, kinds: PACKAGING_KINDS, moves: PACKAGING_MOVES };
  }
  if (win['branchCompareData'] !== undefined) {
    win['branchCompare'] = { session: createCompareSession({ viewer: viewerIdentity(win['branchCompareData']) }), words: compareWords, outcomeWords: compareOutcomeWords, rupees: compareRupees, rowTransactions, share: shareWords, today: compareToday, dimensions: COMPARE_BY };
  }
}
