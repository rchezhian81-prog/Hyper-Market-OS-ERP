// W5 (accountant books and commercial ledgers) — the browser wiring for the sections this wave adds to existing office pages,
// kept in one file so the shared bundle entry (browser-entry.ts) carries one import and one call. Each section's tested
// session is attached to its own window global from the viewer the store computer injected (identity only). Nothing is read
// or written here; every call is a person's click.

import { createBooksPostingsSession, booksWords, booksOutcomeWords, STREAMS } from './books-postings-session';
import { createAccountClassesSession, accountClassesWords, accountClassesOutcomeWords, classRows, ACCOUNT_CLASSES } from './account-classes-session';
import { createB2BBooksSession, b2bBooksWords, b2bBooksOutcomeWords } from './b2b-books-session';
import { createConcessionTagsSession, concessionTagsWords, concessionTagsOutcomeWords } from './concession-tags-session';
import { createRelatedPartyOrderSession, relatedPartyOrderWords, relatedPartyOrderOutcomeWords } from './related-party-order-session';
import { createSupplierPaymentSession, supplierPaymentWords, supplierPaymentOutcomeWords, PAY_METHODS } from './supplier-payment-session';
import { createSupplierPortalWatchSession, supplierPortalWatchWords, supplierPortalWatchOutcomeWords } from './supplier-portal-watch-session';
import { rupees } from './settlement-bank-session';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';
import { servedShopZone } from '../../../packages/calendar/src/shop-day';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** The shop's own date today (OB-606: the shop's zone, never the device's). */
const shopToday = (): string => shopDateIn(new Date().toISOString(), servedShopZone());

/** The Buying page names the signed-in person `buyerId` (PA-06), with what they hold. */
function buyerOf(raw: unknown): Viewer | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const permissions = Array.isArray(r['permissions']) ? r['permissions'].filter((p): p is string => typeof p === 'string') : [];
  const id = typeof r['buyerId'] === 'string' && r['buyerId'].trim() !== '' ? r['buyerId'] : typeof r['userId'] === 'string' && r['userId'].trim() !== '' ? r['userId'] : undefined;
  return { ...(id === undefined ? {} : { userId: id }), permissions };
}

export function wireW5Books(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  // M23-FR-01/04 · D10-FR-01 · D09-FR-06 · D02-FR-06: Month-end — movements into the books, the CA's evidence, the centres.
  if (win['financeCloseData'] !== undefined) {
    win['booksPostings'] = { session: createBooksPostingsSession({ viewer: viewerIdentity(win['financeCloseData']) }), words: booksWords, outcomeWords: booksOutcomeWords, rupees, streams: STREAMS };
  }
  // M23-FR-01: Accounts and Tally names — the account classes the profit and loss reads.
  if (win['postingMapData'] !== undefined) {
    win['accountClasses'] = { session: createAccountClassesSession({ viewer: viewerIdentity(win['postingMapData']) }), words: accountClassesWords, outcomeWords: accountClassesOutcomeWords, rows: classRows, classes: ACCOUNT_CLASSES };
  }
  // M22-FR-01/02/04 · M23: Business customers — chasing, the AR against the books, an order's chain, portal probing.
  if (win['b2bDeskData'] !== undefined) {
    win['b2bBooks'] = { session: createB2BBooksSession({ viewer: viewerIdentity(win['b2bDeskData']) }), words: b2bBooksWords, outcomeWords: b2bBooksOutcomeWords, rupees, today: shopToday };
  }
  // M27-FR-02/03/04: Concessions — counter sale lines, corrections, marking, breaches, the store's own stock value.
  if (win['concessionsData'] !== undefined) {
    win['concessionTags'] = { session: createConcessionTagsSession({ viewer: viewerIdentity(win['concessionsData']) }), words: concessionTagsWords, outcomeWords: concessionTagsOutcomeWords, rupees };
  }
  // M15-FR-03 · OB-301: Buying — the related-party check and the owner's written approval.
  if (win['buyingData'] !== undefined) {
    win['relatedPartyOrders'] = { session: createRelatedPartyOrderSession({ viewer: buyerOf(win['buyingData']) }), words: relatedPartyOrderWords, outcomeWords: relatedPartyOrderOutcomeWords };
  }
  // M23-FR-01 · §28: Suppliers — record a payment to a supplier, asked for and approved by a second person.
  if (win['suppliersData'] !== undefined) {
    win['supplierPayments'] = { session: createSupplierPaymentSession({ viewer: viewerIdentity(win['suppliersData']) }), words: supplierPaymentWords, outcomeWords: supplierPaymentOutcomeWords, rupees, methods: PAY_METHODS, today: shopToday };
  }
  // M24-FR-02/03/04: Supplier submissions — a supplier's papers and statement, and portal probing.
  if (win['supplierSubmissionsData'] !== undefined) {
    win['supplierPortalWatch'] = { session: createSupplierPortalWatchSession({ viewer: viewerIdentity(win['supplierSubmissionsData']) }), words: supplierPortalWatchWords, outcomeWords: supplierPortalWatchOutcomeWords, rupees, today: shopToday };
  }
}
