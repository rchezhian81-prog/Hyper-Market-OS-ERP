// Round 4d (money, facilities and production) — the browser wiring for the office pages this round adds, kept in one file so
// the shared bundle entry (browser-entry.ts) carries one import and one call. Each page's tested session is attached to its
// own window global from the viewer the front door injected (identity only). Nothing is read or written here.

import { createPostingMapSession, postingMapWords, postingMapOutcomeWords, kindWords, componentWords } from './posting-map-session';
import {
  createFacilitiesSetupSession, facilitiesSetupWords, facilitiesSetupOutcomeWords, celsius,
  ASSET_KINDS, CRITICALITIES, SERVICE_KINDS, SCHEDULE_CATEGORIES, FREQUENCIES, CHECK_KINDS,
} from './facilities-setup-session';
import { createProductionRecipesSession, productionRecipesWords, productionRecipesOutcomeWords, amountWords, RECIPE_UOMS } from './production-recipes-session';
import { createProductionRepackSession, productionRepackWords, productionRepackOutcomeWords } from './production-repack-session';
import { createConcessionInvoicesSession, concessionInvoicesWords, concessionInvoicesOutcomeWords } from './concession-invoices-session';
import { rupees as concessionRupees } from './concession-session';
import { shopMomentOf } from './findings-session';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** The store the box named for a page (its own store, from its signed pack), when it named one. */
const storeOf = (raw: unknown): { storeId?: string } => {
  const id = raw !== null && typeof raw === 'object' ? (raw as { storeId?: unknown }).storeId : undefined;
  return typeof id === 'string' && id.trim() !== '' ? { storeId: id.trim() } : {};
};
const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** The shop's own date today (OB-606: the shop's zone, never the device's). */
const shopToday = (): string => shopDateIn(new Date().toISOString(), servedShopZone());

export function wireRound4d(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['postingMapData'] !== undefined) {
    win['postingMap'] = {
      session: createPostingMapSession({ viewer: viewerIdentity(win['postingMapData']) }), words: postingMapWords, outcomeWords: postingMapOutcomeWords,
      kindWords, componentWords, moment: shopMomentOf,
    };
  }
  if (win['facilitiesSetupData'] !== undefined) {
    win['facilitiesSetup'] = {
      session: createFacilitiesSetupSession({ viewer: viewerIdentity(win['facilitiesSetupData']), ...storeOf(win['facilitiesSetupData']) }),
      words: facilitiesSetupWords, outcomeWords: facilitiesSetupOutcomeWords, celsius, rupees, moment: shopMomentOf, today: shopToday,
      assetKinds: ASSET_KINDS, criticalities: CRITICALITIES, serviceKinds: SERVICE_KINDS, categories: SCHEDULE_CATEGORIES, frequencies: FREQUENCIES, checkKinds: CHECK_KINDS,
    };
  }
  if (win['productionRecipesData'] !== undefined) {
    win['productionRecipes'] = { session: createProductionRecipesSession({ viewer: viewerIdentity(win['productionRecipesData']) }), words: productionRecipesWords, outcomeWords: productionRecipesOutcomeWords, amount: amountWords, uoms: RECIPE_UOMS };
  }
  // M27-FR-03: the Concessions page's invoices and settlement in the books.
  if (win['concessionsData'] !== undefined) {
    win['concessionInvoices'] = { session: createConcessionInvoicesSession({ viewer: viewerIdentity(win['concessionsData']) }), words: concessionInvoicesWords, outcomeWords: concessionInvoicesOutcomeWords, rupees: concessionRupees, moment: shopMomentOf };
  }
  // M11-FR-03: the Production page's repack form — the departments and the kitchen place the store computer told the page.
  if (win['productionData'] !== undefined) {
    const raw = win['productionData'] as { board?: { enabledDepartments?: unknown } | null; productionLocationId?: unknown } | null;
    const departments = Array.isArray(raw?.board?.enabledDepartments) ? (raw!.board!.enabledDepartments as unknown[]).filter((d): d is string => typeof d === 'string') : [];
    win['productionRepack'] = {
      session: createProductionRepackSession({ viewer: viewerIdentity(win['productionData']) }), words: productionRepackWords, outcomeWords: productionRepackOutcomeWords,
      departments, uoms: RECIPE_UOMS, ...(typeof raw?.productionLocationId === 'string' ? { locationId: raw.productionLocationId } : {}),
    };
  }
}
