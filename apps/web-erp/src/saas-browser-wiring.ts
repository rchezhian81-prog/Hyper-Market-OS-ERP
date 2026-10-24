// The browser wiring for the OB-288 P4 page "Trial switches and shop account" — kept in its own file so the shared bundle
// entry (browser-entry.ts) carries one import and one call. The page's tested session is attached to `window.rollout`
// from the viewer the front door injected (`window.rolloutData`). Nothing is read or written here: every call is a click.

import { createRolloutSession, rolloutWords, rolloutOutcomeWords, rupees } from './rollout-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireSaasPages(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['rolloutData'] !== undefined) {
    win['rollout'] = { session: createRolloutSession({ viewer: viewerIdentity(win['rolloutData']) }), words: rolloutWords, outcomeWords: rolloutOutcomeWords, rupees };
  }
}
