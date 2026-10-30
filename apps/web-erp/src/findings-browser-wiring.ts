// The browser wiring for the Bill findings and attendance flags page (OB-609) — kept in its own file so the shared bundle entry
// (browser-entry.ts) carries one import and one call. The page's tested session is attached to `window.findings` from the
// viewer the front door injected (`window.findingsData`, identity only). Nothing is read or written here.

import { createFindingsSession, findingsWords, findingsOutcomeWords, flagWords, shopMomentOf } from './findings-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** OB-612: the store the box named for this page, when it named one. */
const storeOf = (raw: unknown): { storeId?: string } => {
  const id = raw !== null && typeof raw === 'object' ? (raw as { storeId?: unknown }).storeId : undefined;
  return typeof id === 'string' && id.trim() !== '' ? { storeId: id.trim() } : {};
};

export function wireFindings(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['findingsData'] === undefined) return;
  win['findings'] = {
    // OB-612: on the store PC the box names its own store (`findingsData.storeId`) — the page asks head office for it.
    session: createFindingsSession({ viewer: viewerIdentity(win['findingsData']), ...storeOf(win['findingsData']) }),
    words: findingsWords, outcomeWords: findingsOutcomeWords, flagWords, moment: shopMomentOf,
    rupees: (minor: number): string => `₹${(minor / 100).toFixed(2)}`,
  };
}
