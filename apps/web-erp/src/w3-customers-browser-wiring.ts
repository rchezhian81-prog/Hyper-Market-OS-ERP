// W3 (customers) — the browser wiring for the office pages this wave adds for customers, kept in one file so the shared bundle
// entry (browser-entry.ts) carries one import and one call. Each page's tested session is attached to its own window global
// from the viewer the front door injected (identity only). Nothing is read or written here.

import { createDataRequestsSession, dataRequestsWords, dataRequestsOutcomeWords, REQUEST_KINDS } from './data-requests-session';
import { createCustomerValueSession, customerValueWords, customerValueOutcomeWords } from './customer-value-session';
import { createMessageQueueSession, messageQueueWords, messageQueueOutcomeWords, MESSAGE_CHANNELS } from './message-queue-session';
import { createCompensationLimitsSession, compensationLimitsWords, compensationLimitsOutcomeWords } from './compensation-limits-session';
import { createGiftCardsSession, giftCardsWords, giftCardsOutcomeWords, REDEEM_CHANNELS } from './gift-cards-session';
import { newId } from './r4-insight-call';
import { shopMomentOf } from './findings-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

const rupees = (minor: number): string => `${minor < 0 ? '-' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function wireW3Customers(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['dataRequestsData'] !== undefined) {
    win['dataRequests'] = { session: createDataRequestsSession({ viewer: viewerIdentity(win['dataRequestsData']) }), words: dataRequestsWords, outcomeWords: dataRequestsOutcomeWords, kinds: REQUEST_KINDS, moment: shopMomentOf };
  }
  if (win['customerValueData'] !== undefined) {
    win['customerValue'] = { session: createCustomerValueSession({ viewer: viewerIdentity(win['customerValueData']) }), words: customerValueWords, outcomeWords: customerValueOutcomeWords, rupees };
  }
  if (win['messageQueueData'] !== undefined) {
    win['messageQueue'] = { session: createMessageQueueSession({ viewer: viewerIdentity(win['messageQueueData']) }), words: messageQueueWords, outcomeWords: messageQueueOutcomeWords, channels: MESSAGE_CHANNELS, rupees };
  }
  if (win['compensationLimitsData'] !== undefined) {
    win['compensationLimits'] = { session: createCompensationLimitsSession({ viewer: viewerIdentity(win['compensationLimitsData']) }), words: compensationLimitsWords, outcomeWords: compensationLimitsOutcomeWords, rupees };
  }
  if (win['giftCardsData'] !== undefined) {
    win['giftCards'] = {
      session: createGiftCardsSession({ viewer: viewerIdentity(win['giftCardsData']) }), words: giftCardsWords, outcomeWords: giftCardsOutcomeWords,
      channels: REDEEM_CHANNELS, rupees, moment: shopMomentOf, newPress: () => newId('gcr'),
    };
  }
}
