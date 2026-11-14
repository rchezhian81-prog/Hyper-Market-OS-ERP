// The browser wiring for the Electronic shelf labels page (U6 · §27 "Product — label/ESL") — kept in its own file so the
// shared bundle entry carries one import and one call. The page's tested session is attached to `window.esl` from the viewer
// the store computer injected (`window.eslData`: identity and the box's own store). Nothing is read or written here.

import { createEslSession, eslWords, eslOutcomeWords, fill, pushStateOf } from './esl-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

const storeOf = (raw: unknown): { storeId?: string } => {
  const id = raw !== null && typeof raw === 'object' ? (raw as { storeId?: unknown }).storeId : undefined;
  return typeof id === 'string' && id.trim() !== '' ? { storeId: id.trim() } : {};
};

export function wireEsl(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined): void {
  if (win['eslData'] === undefined) return;
  win['esl'] = {
    session: createEslSession({ viewer: viewerIdentity(win['eslData']), ...storeOf(win['eslData']) }),
    words: eslWords, outcomeWords: eslOutcomeWords, fill, pushStateOf,
    rupees: (minor: number): string => `₹${(minor / 100).toFixed(2)}`,
  };
}
