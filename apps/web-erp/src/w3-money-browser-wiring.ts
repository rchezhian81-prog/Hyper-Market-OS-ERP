// W3 (money) — the browser wiring for the office pages this wave adds or extends, kept in one file so the shared bundle
// entry (browser-entry.ts) carries one import and one call. Each page's tested session is attached to its own window global
// from the viewer the front door injected (identity only). Nothing is read or written here.

import { createSettlementSession, settlementWords, settlementOutcomeWords, rupees, INVESTIGATION_OUTCOMES } from './settlement-bank-session';
import { createRebateAccrualsSession, rebateAccrualWords, rebateAccrualOutcomeWords } from './rebate-accruals-session';
import { createLiabilitiesSession, liabilitiesWords, liabilitiesOutcomeWords } from './liabilities-session';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** The shop's own date today (OB-606: the shop's zone, never the device's). */
const shopToday = (): string => shopDateIn(new Date().toISOString(), servedShopZone());

export function wireW3Money(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  // M23-FR-03: Card, UPI and bank.
  if (win['settlementBankData'] !== undefined) {
    win['settlementBank'] = {
      session: createSettlementSession({ viewer: viewerIdentity(win['settlementBankData']) }), words: settlementWords, outcomeWords: settlementOutcomeWords,
      rupees, outcomes: INVESTIGATION_OUTCOMES, today: shopToday,
    };
  }
  // D03-FR-03 / D10-FR-04: the Rebates page measures what a scheme earned and puts it in the books.
  if (win['rebatesData'] !== undefined) {
    win['rebateAccruals'] = { session: createRebateAccrualsSession({ viewer: viewerIdentity(win['rebatesData']) }), words: rebateAccrualWords, outcomeWords: rebateAccrualOutcomeWords, rupees, today: shopToday };
  }
  // D10-FR-04: Month-end shows what the shop owes customers (points, store credit, referral rewards) against the books.
  if (win['financeCloseData'] !== undefined) {
    win['liabilities'] = { session: createLiabilitiesSession({ viewer: viewerIdentity(win['financeCloseData']) }), words: liabilitiesWords, outcomeWords: liabilitiesOutcomeWords, rupees };
  }
}
