// The browser wiring for the Users & roles page (Round 4c) — kept in its own file so the shared bundle entry
// (browser-entry.ts) carries one import and one call. The page's tested session is attached to `window.users` from the
// viewer the front door injected (`window.usersData`, identity only); the Sign-ins part (OB-15-c) is the tested people
// session over head office's people routes, for the platform administrator who gives sign-ins.

import { createUsersSession, usersWords, usersOutcomeWords, LIMIT_DIMENSIONS, officePrivilegeFrom, isMachineRole } from './users-session';
import { askOfficePin, type PinDoc } from './office-pin-prompt';
import { createPeopleSession, handOverWords, PERSON_PROVISION_PERMISSION, type PeoplePort } from './people-session';
import { createRoleChangeSession, permissionWords, roleChangeDoorsFrom, roleChangeWords, storePcRoleDecide, type RoleChangeDoors } from './role-change-session';

type Viewer = { readonly userId?: string; readonly permissions: readonly string[] };

/** CR-01 step 4c-2: the store computer's role-change doors, the person's PIN asked in both languages — or undefined. */
function roleDoorsOf(win: Record<string, unknown>): RoleChangeDoors | undefined {
  const doc = win['document'] as PinDoc | undefined;
  if (doc === undefined) return undefined;
  const askKey = { roleChange: 'pinAskChange', roleDecide: 'pinAskDecide' } as const;
  return roleChangeDoorsFrom(win['sreOfficePrivilege'], (what) => askOfficePin(doc, {
    ask: roleChangeWords('en', askKey[what]), askTa: roleChangeWords('ta', askKey[what]),
    ok: `${usersWords('en', 'pinOk')} · ${usersWords('ta', 'pinOk')}`, cancel: `${usersWords('en', 'pinCancel')} · ${usersWords('ta', 'pinCancel')}`,
  }));
}

/**
 * CR-01 step 4c-2: the Approvals page's decide — on the store PC a role change goes through the store computer's door with
 * the approver's PIN typed again (and is applied at once); everything else, and everything at head office, as before.
 */
export function roleAwareDecide<F extends (input: { readonly requestId: string; readonly decision: 'approved' | 'rejected'; readonly reason: string; readonly kind?: string }) => Promise<unknown>>(win: Record<string, unknown>, fallback: F): F {
  const doors = roleDoorsOf(win);
  return (doors === undefined ? fallback : storePcRoleDecide(doors, fallback)) as F;
}

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
  const askKey = { give: 'pinAskGive', approve: 'pinAskApprove', reject: 'pinAskReject', add: 'pinAskAdd', takeBack: 'pinAskTakeBack', pinSet: 'pinAskSet', pinCancel: 'pinAskCancel', pinCurrent: 'pinAskCurrent', newPin: 'pinAskNew', newPinAgain: 'pinAskNewAgain' } as const;
  const office = doc === undefined ? undefined : officePrivilegeFrom(win['sreOfficePrivilege'], (what) => askOfficePin(doc, {
    ask: usersWords('en', askKey[what]), askTa: usersWords('ta', askKey[what]),
    ok: `${usersWords('en', 'pinOk')} · ${usersWords('ta', 'pinOk')}`, cancel: `${usersWords('en', 'pinCancel')} · ${usersWords('ta', 'pinCancel')}`,
  }));
  // CR-01 step 4c-2 (ADR-0034 · OB-740 "B"): change what a role may do — asked here, approved on the Approvals page.
  const roleDoors = roleDoorsOf(win);
  win['users'] = {
    session: createUsersSession({ viewer, ...(office === undefined ? {} : { office }) }),
    words: usersWords, outcomeWords: usersOutcomeWords, dimensions: LIMIT_DIMENSIONS, isMachineRole,
    signIns, handOverWords: (lang: 'en' | 'ta', h: Parameters<typeof handOverWords>[2]) => (signIns === null ? '' : handOverWords(signIns, lang, h)),
    roleChange: createRoleChangeSession({ viewer, ...(roleDoors === undefined ? {} : { doors: roleDoors }) }),
    roleChangeWords, permissionWords,
  };
}
