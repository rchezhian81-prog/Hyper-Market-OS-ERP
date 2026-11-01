// The browser wiring for the Users & roles page (Round 4c) — kept in its own file so the shared bundle entry
// (browser-entry.ts) carries one import and one call. The page's tested session is attached to `window.users` from the
// viewer the front door injected (`window.usersData`, identity only); the Sign-ins part (OB-15-c) is the tested people
// session over head office's people routes, for the platform administrator who gives sign-ins.

import { createUsersSession, usersWords, usersOutcomeWords, LIMIT_DIMENSIONS } from './users-session';
import { createPeopleSession, handOverWords, PERSON_PROVISION_PERMISSION, type PeoplePort } from './people-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireUsers(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined, peoplePort: PeoplePort): void {
  if (win['usersData'] === undefined) return;
  const viewer = viewerIdentity(win['usersData']);
  const held = new Set(viewer?.permissions ?? []);
  const signIns = viewer?.userId !== undefined && held.has('platform.person.read')
    ? createPeopleSession({ userId: viewer.userId, mayProvision: held.has(PERSON_PROVISION_PERMISSION) }, peoplePort)
    : null;
  win['users'] = {
    session: createUsersSession({ viewer }),
    words: usersWords, outcomeWords: usersOutcomeWords, dimensions: LIMIT_DIMENSIONS,
    signIns, handOverWords: (lang: 'en' | 'ta', h: Parameters<typeof handOverWords>[2]) => (signIns === null ? '' : handOverWords(signIns, lang, h)),
  };
}
