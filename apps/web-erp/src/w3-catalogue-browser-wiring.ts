// Wave 3 (catalogue and pricing) — the browser wiring for the office-page sections this wave adds, kept in one file so the
// shared bundle entry (browser-entry.ts) carries one import and one call. Each section's tested session is attached to its
// own window global from the viewer the front door injected (identity only). Nothing is read or written here.
//   • window.priceChecks     — the Price mismatches page's shelf walk (D06-FR-06), from `storeOpsData`;
//   • window.tobaccoWarning  — the Product details page's tobacco health-warning section (D01-FR-05), from `productDetailsData`;
//   • window.rangeGaps       — the Store groups and seasons page's range-gap report (D02-FR-04), from `rangeClustersData`;
//   • window.markdowns       — the Expiry page's markdown and clearance sections (D06-FR-05), from `expiryData`;
//   • window.competitorRule  — the Products and prices page's competitor rule (D06-FR-05), from `catalogueData`.

import { createPriceChecksSession, priceChecksWords, priceChecksOutcomeWords, CHECK_SURFACES } from './price-checks-session';
import { createTobaccoWarningSession, tobaccoWarningWords, tobaccoWarningOutcomeWords } from './tobacco-warning-session';
import { createRangeGapsSession, rangeGapsWords, rangeGapsOutcomeWords } from './range-gaps-session';
import { createMarkdownSession, markdownWords, markdownOutcomeWords, priceChangeLink } from './markdown-session';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** The shop's own date today (OB-606: the shop's zone, never the device's). */
const shopToday = (): string => shopDateIn(new Date().toISOString(), servedShopZone());
const storeOf = (raw: unknown): string | undefined => {
  const r = raw !== null && typeof raw === 'object' ? (raw as { storeId?: unknown; branchId?: unknown }) : {};
  const id = typeof r.storeId === 'string' && r.storeId.trim() !== '' ? r.storeId : typeof r.branchId === 'string' && r.branchId.trim() !== '' ? r.branchId : undefined;
  return id?.trim();
};

export function wireWave3Catalogue(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['storeOpsData'] !== undefined) {
    win['priceChecks'] = { session: createPriceChecksSession({ viewer: viewerIdentity(win['storeOpsData']) }), words: priceChecksWords, outcomeWords: priceChecksOutcomeWords, rupees, surfaces: CHECK_SURFACES };
  }
  if (win['productDetailsData'] !== undefined) {
    win['tobaccoWarning'] = { session: createTobaccoWarningSession({ viewer: viewerIdentity(win['productDetailsData']) }), words: tobaccoWarningWords, outcomeWords: tobaccoWarningOutcomeWords, today: shopToday };
  }
  if (win['rangeClustersData'] !== undefined) {
    win['rangeGaps'] = { session: createRangeGapsSession({ viewer: viewerIdentity(win['rangeClustersData']) }), words: rangeGapsWords, outcomeWords: rangeGapsOutcomeWords, rupees, today: shopToday };
  }
  if (win['expiryData'] !== undefined) {
    const store = storeOf(win['expiryData']);
    win['markdowns'] = {
      session: createMarkdownSession({ viewer: viewerIdentity(win['expiryData']), ...(store === undefined ? {} : { storeId: store }) }),
      words: markdownWords, outcomeWords: markdownOutcomeWords, rupees, link: priceChangeLink,
    };
  }
  if (win['catalogueData'] !== undefined) {
    const store = storeOf(win['catalogueData']);
    win['competitorRule'] = {
      session: createMarkdownSession({ viewer: viewerIdentity(win['catalogueData']), ...(store === undefined ? {} : { storeId: store }) }),
      words: markdownWords, outcomeWords: markdownOutcomeWords,
    };
  }
}
