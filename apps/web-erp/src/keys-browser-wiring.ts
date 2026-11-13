// The browser wiring for the Keys and credentials page (U6 · §27 Admin/Security "keys" · M32-FR-03) — kept in its own
// file so the shared bundle entry (browser-entry.ts) carries one import and one call. The page's tested session is attached
// to `window.keys` from the viewer the front door injected (`window.keysData`, identity only). Nothing is read or written here.

import { createKeysSession, keysWords, keysOutcomeWords, dueWords, dueState, dayWords, SECRET_KINDS, SECRET_STATES, REVOCATION_REASONS } from './keys-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireKeys(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['keysData'] === undefined) return;
  win['keys'] = {
    session: createKeysSession({ viewer: viewerIdentity(win['keysData']) }),
    words: keysWords, outcomeWords: keysOutcomeWords, dueWords, dueState, dayWords,
    secretKinds: SECRET_KINDS, secretStates: SECRET_STATES, revocationReasons: REVOCATION_REASONS,
  };
}
