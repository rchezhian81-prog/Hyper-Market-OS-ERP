// The browser wiring for the owner-reporting page (OB-288 lane 4 · P2 · M29-FR-03/04). Kept in its own file so the shared
// bundle entry (browser-entry.ts) carries one import and one call. The page's tested session is attached to `window` under
// the name its page script reads (`ownerAlerts`), from the viewer the page was served with (`ownerAlertsData`). Nothing
// is read or written here: every call is a person's click on the page.

import { createOwnerAlertsSession, ownerAlertsWords, ownerAlertsOutcomeWords, shownValue } from './owner-alerts-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireOwnerReportingPages(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['ownerAlertsData'] !== undefined) {
    win['ownerAlerts'] = { session: createOwnerAlertsSession({ viewer: viewerIdentity(win['ownerAlertsData']) }), words: ownerAlertsWords, outcomeWords: ownerAlertsOutcomeWords, shownValue };
  }
}
