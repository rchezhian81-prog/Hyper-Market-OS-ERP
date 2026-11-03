// W5 (customers, privacy, service desk and online orders) — the browser wiring for the sections this wave adds to twelve
// existing office pages (apps/web-erp/web/customer-desk-sections.js). The tested session (customer-desk-sections-session.ts)
// is attached as `window.customerDesk` from the viewer the front door injected for THIS page (identity only). Nothing is read
// or written here.

import { createDeskSession, deskWords, deskOutcomeWords, NOMINEE_BASES, COMPENSATION_KINDS, EXCEPTION_QUEUES, SUB_PREFERENCES, CONTACT_METHODS } from './customer-desk-sections-session';
import { shopMomentOf } from './findings-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** The global each page that carries a W5 section is given by the box (or the office front). */
export const W5_PAGE_GLOBALS = Object.freeze([
  'customersData', 'dataRequestsData', 'incidentsData', 'loyaltyDeskData', 'messageQueueData', 'campaignsData', 'rolloutData',
  'serviceDeskData', 'storedValueData', 'dispatchData', 'substitutionExceptionInboxData', 'onlineOrdersData',
] as const);

const rupees = (minor: number): string => `${minor < 0 ? '-' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function wireW5Customers(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  const global = W5_PAGE_GLOBALS.find((g) => win[g] !== undefined);
  if (global === undefined) return;
  win['customerDesk'] = {
    session: createDeskSession({ viewer: viewerIdentity(win[global]) }), words: deskWords, outcomeWords: deskOutcomeWords, rupees, moment: shopMomentOf,
    bases: NOMINEE_BASES, compensationKinds: COMPENSATION_KINDS, queues: EXCEPTION_QUEUES, preferences: SUB_PREFERENCES, contactMethods: CONTACT_METHODS,
  };
}
