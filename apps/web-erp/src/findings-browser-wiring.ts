// The browser wiring for the Bill findings and attendance flags page (OB-608) — kept in its own file so the shared bundle entry
// (browser-entry.ts) carries one import and one call. The page's tested session is attached to `window.findings` from the
// viewer the front door injected (`window.findingsData`, identity only). Nothing is read or written here.

import { createFindingsSession, findingsWords, findingsOutcomeWords, flagWords, shopMomentOf } from './findings-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireFindings(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['findingsData'] === undefined) return;
  win['findings'] = {
    session: createFindingsSession({ viewer: viewerIdentity(win['findingsData']) }),
    words: findingsWords, outcomeWords: findingsOutcomeWords, flagWords, moment: shopMomentOf,
    rupees: (minor: number): string => `₹${(minor / 100).toFixed(2)}`,
  };
}
