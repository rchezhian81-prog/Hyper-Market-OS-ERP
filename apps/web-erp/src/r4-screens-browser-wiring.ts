// The browser wiring for the four QG-02 screens (lane 1 R4): the Dock diary, Standing orders, Supplier offer funding and
// Feature switches — kept in its own file so the shared bundle entry (browser-entry.ts) carries one import and one call.
// Each page's tested session is attached to `window.<page>` from the viewer the front door injected (`window.<page>Data`,
// identity only). Nothing is read or written here: every call is a person's click.

import { createDockDiarySession, dockDiaryWords, dockDiaryOutcomeWords, NEXT_STATUSES } from './dock-diary-session';
import { createBlanketOrdersSession, blanketWords, blanketOutcomeWords, rupees as blanketRupees } from './blanket-orders-session';
import { createPromotionFundingSession, fundingWords, fundingOutcomeWords, rupees as fundingRupees } from './promotion-funding-session';
import { createSwitchesSession, switchesWords, switchesOutcomeWords, previewWords } from './switches-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireR4Screens(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['dockDiaryData'] !== undefined) {
    win['dockDiary'] = { session: createDockDiarySession({ viewer: viewerIdentity(win['dockDiaryData']) }), words: dockDiaryWords, outcomeWords: dockDiaryOutcomeWords, next: NEXT_STATUSES };
  }
  if (win['blanketOrdersData'] !== undefined) {
    win['blanketOrders'] = { session: createBlanketOrdersSession({ viewer: viewerIdentity(win['blanketOrdersData']) }), words: blanketWords, outcomeWords: blanketOutcomeWords, rupees: blanketRupees };
  }
  if (win['promotionFundingData'] !== undefined) {
    win['promotionFunding'] = { session: createPromotionFundingSession({ viewer: viewerIdentity(win['promotionFundingData']) }), words: fundingWords, outcomeWords: fundingOutcomeWords, rupees: fundingRupees };
  }
  if (win['switchesData'] !== undefined) {
    win['switches'] = { session: createSwitchesSession({ viewer: viewerIdentity(win['switchesData']) }), words: switchesWords, outcomeWords: switchesOutcomeWords, previewWords };
  }
}
