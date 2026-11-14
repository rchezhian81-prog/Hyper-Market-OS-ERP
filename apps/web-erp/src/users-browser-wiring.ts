// The browser wiring for the Users & roles page (Round 4c) — kept in its own file so the shared bundle entry
// (browser-entry.ts) carries one import and one call. The page's tested session is attached to `window.users` from the
// viewer the front door injected (`window.usersData`, identity only); the Sign-ins part (OB-15-c) is the tested people
// session over head office's people routes, for the platform administrator who gives sign-ins.

import { createUsersSession, usersWords, usersOutcomeWords, LIMIT_DIMENSIONS, officePrivilegeFrom } from './users-session';
import { askOfficePin, type PinDoc } from './office-pin-prompt';
import { createPeopleSession, handOverWords, PERSON_PROVISION_PERMISSION, type PeoplePort } from './people-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

export function wireUsers(win: Record<string, unknown>, viewerIdentity: (raw: unknown) => Viewer | undefined, peoplePort: PeoplePort): void {
  if (win['usersData'] === undefined) return;
  const viewer = viewerIdentity(win['usersData']);
  const held = new Set(viewer?.permissions ?? []);
  const signIns = viewer?.userId !== undefined && held.has('platform.person.read')
    ? createPeopleSession({ userId: viewer.userId, mayProvision: held.has(PERSON_PROVISION_PERMISSION) }, peoplePort)
    : null;
  // CR-01 step 4a (ADR-0033): served by the store PC with the head-office link off — give and approve go through its own
  // doors, the person's PIN asked again for each act.
  const doc = win['document'] as PinDoc | undefined;
  const office = doc === undefined ? undefined : officePrivilegeFrom(win['sreOfficePrivilege'], (what) => askOfficePin(doc, {
    ask: usersWords('en', what === 'give' ? 'pinAskGive' : 'pinAskApprove'), askTa: usersWords('ta', what === 'give' ? 'pinAskGive' : 'pinAskApprove'),
    ok: `${usersWords('en', 'pinOk')} · ${usersWords('ta', 'pinOk')}`, cancel: `${usersWords('en', 'pinCancel')} · ${usersWords('ta', 'pinCancel')}`,
  }));
  win['users'] = {
    session: createUsersSession({ viewer, ...(office === undefined ? {} : { office }) }),
    words: usersWords, outcomeWords: usersOutcomeWords, dimensions: LIMIT_DIMENSIONS,
    signIns, handOverWords: (lang: 'en' | 'ta', h: Parameters<typeof handOverWords>[2]) => (signIns === null ? '' : handOverWords(signIns, lang, h)),
  };
}
