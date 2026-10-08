// API-01 People and their sign-ins (OB-15-c · ADR-0019 · M02-FR-01 · M02-FR-04 · SEC-03 · §28 · hard rule #4).
//
// The platform administrator gives a NAMED person a sign-in at the identity server, from the product — never a shared
// one. The rules, each a refusal by name:
//   • one person, one sign-in: a sign-in name that reads as a job, a counter or a shared account ("cashier", "till2",
//     "admin", "store") is refused (M02-FR-01: "a shared/generic account cannot be created");
//   • the sign-in holds NO authority: what the person may do is asked for and approved separately (the maker-checker
//     grant routes). So a sign-in is only given to somebody who holds no role yet — otherwise the administrator, who
//     sees the one-time password, could give themselves a way into the owner's or a manager's authority;
//   • nobody gives themselves a sign-in;
//   • every sign-in made here asks for a one-time code from the person's phone after the password (SEC-03);
//   • the one-time password is shown ONCE, to the administrator who asked, to hand over in person. It is temporary — the
//     person chooses their own at first sign-in — and it is kept nowhere: not in the ledger, not in the audit, not in a
//     replay of this request (the route's `shownOnce`), not in a log.
//
// The ledger records the attempt BEFORE the identity server is touched (`PersonSignInRequested`) and the outcome after
// (`PersonSignInIssued`), so a reply lost on the way can be finished — never duplicated, and never a second password for
// a sign-in somebody already uses.

import { randomInt } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { DirectoryUnavailableError, type IdentityDirectory } from './identity-directory';
import { isGenericName, SIGN_IN_NAME, PRODUCT_ID, tidyPersonName, readablePersonName } from '../../../packages/identity/src/sign-in-names';

export { isGenericName };

export const PERSON_PROVISION_PERMISSION = 'platform.person.provision';
export const PERSON_READ_PERMISSION = 'platform.person.read';

export type PersonSignInState = 'requested' | 'issued' | 'ended';

/** One person's sign-in, folded from the identity ledger. Never holds a password. */
export interface PersonSignIn {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly state: PersonSignInState;
  readonly secondFactor: boolean;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly issuedAt?: string;
  readonly endedAt?: string;
}

export type PersonSignInEvent =
  | { readonly type: 'PersonSignInRequested'; readonly userId: string; readonly username: string; readonly displayName: string; readonly secondFactor: boolean; readonly requestedBy: string; readonly at: string }
  | { readonly type: 'PersonSignInIssued'; readonly userId: string; readonly issuedBy: string; readonly resumed: boolean; readonly at: string }
  | { readonly type: 'PersonSignInEnded'; readonly userId: string; readonly endedBy: string; readonly reason: string; readonly at: string }
  /** The identity server refused the name: the unfinished request is closed, so another name can be tried. */
  | { readonly type: 'PersonSignInWithdrawn'; readonly userId: string; readonly reason: string; readonly at: string };

/** Fold the events, in append order, into one record per person. */
export function foldPeople(events: readonly PersonSignInEvent[]): readonly PersonSignIn[] {
  const byId = new Map<string, PersonSignIn>();
  for (const e of events) {
    const p = byId.get(e.userId);
    if (e.type === 'PersonSignInRequested') {
      if (p === undefined) {
        byId.set(e.userId, {
          userId: e.userId, username: e.username, displayName: e.displayName, state: 'requested',
          secondFactor: e.secondFactor, requestedBy: e.requestedBy, requestedAt: e.at,
        });
      }
    } else if (p !== undefined && e.type === 'PersonSignInIssued') {
      if (p.state === 'requested') byId.set(e.userId, { ...p, state: 'issued', issuedAt: e.at });
    } else if (p !== undefined && e.type === 'PersonSignInWithdrawn') {
      if (p.state === 'requested') byId.delete(e.userId);
    } else if (p !== undefined && e.type === 'PersonSignInEnded') {
      byId.set(e.userId, { ...p, state: 'ended', endedAt: e.at });
    }
  }
  return [...byId.values()];
}

// No 0/O, 1/I/L: read aloud and typed from a slip of paper.
const PASSWORD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A one-time password: four groups of four from 31 unambiguous characters (≈79 bits), e.g. `7KQ4-M2XP-9WRT-HB3D`. */
export function oneTimePassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g += 1) {
    let group = '';
    for (let i = 0; i < 4; i += 1) group += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    groups.push(group);
  }
  return groups.join('-');
}

export interface PeopleDeps {
  readonly now: () => string;
  /** Every person's sign-in, folded from the ledger. */
  readonly people: (tenantId: string) => Promise<readonly PersonSignIn[]> | readonly PersonSignIn[];
  readonly recordPerson: (tenantId: string, event: PersonSignInEvent) => Promise<void> | void;
  /** Whether the person holds any role now (grants minus revocations) — a sign-in is given only to someone who holds none. */
  readonly holdsAnyRole: (tenantId: string, userId: string) => Promise<boolean> | boolean;
  /** The identity server's directory. Absent: this deployment signs people in elsewhere, and every issue is refused. */
  readonly directory?: IdentityDirectory;
  /**
   * The ONE shop whose realm the directory provisions into (OB-15-d). A request from any other shop is answered as not
   * connected — never a person made in somebody else's realm. Absent: one shop, not pinned.
   */
  readonly directoryTenantId?: string;
  readonly generatePassword?: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const notSaved = (status: number, code: string, whatHappened: string, nextSafeAction: string) =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

export function peopleRoutes(deps: PeopleDeps): readonly Route[] {
  const directoryFor = (tenantId: string): IdentityDirectory | undefined =>
    deps.directoryTenantId !== undefined && deps.directoryTenantId !== tenantId ? undefined : deps.directory;
  return [
    {
      api: 'API-01', method: 'GET', path: '/v1/identity/people',
      permission: PERSON_READ_PERMISSION,
      handler: async (ctx) => ({
        status: 200,
        body: { people: await deps.people(ctx.tenantId), connected: directoryFor(ctx.tenantId) !== undefined },
      }),
    },
    {
      // Give a named person a sign-in. Sensitive (SEC-03): a recent sign-in with a second factor is required.
      api: 'API-01', method: 'POST', path: '/v1/identity/people',
      permission: PERSON_PROVISION_PERMISSION, idempotent: true,
      reauth: { withinSeconds: 300, amr: ['mfa'] },
      shownOnce: ['oneTimePassword'],
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const username = typeof b['signInName'] === 'string' ? b['signInName'].trim().toLowerCase() : '';
        const userId = typeof b['userId'] === 'string' && b['userId'].trim() !== '' ? b['userId'].trim() : username;
        const displayName = typeof b['displayName'] === 'string' ? tidyPersonName(b['displayName']) : '';
        if (b['password'] !== undefined || b['oneTimePassword'] !== undefined) {
          throw notSaved(400, 'password_is_never_sent', 'A password was sent. Head office makes the one-time password itself and shows it once; nobody types one in.', 'Send the person\'s sign-in name and full name only. Nothing was saved.');
        }
        if (!SIGN_IN_NAME.test(username) || !PRODUCT_ID.test(userId) || !readablePersonName(displayName)) {
          throw notSaved(400, 'not_readable_as_a_person', 'A sign-in needs { signInName (3–40 of a–z, 0–9, . _ -), displayName (the person\'s full name), userId? (the product\'s id for them; the sign-in name when absent) }.', 'Send the person\'s own sign-in name and full name. Nothing was saved.');
        }
        if (isGenericName(username) || isGenericName(userId) || isGenericName(displayName)) {
          throw notSaved(422, 'shared_or_generic_sign_in', `"${isGenericName(displayName) ? displayName : username}" names a job, a place or a shared account, not a person. Every sign-in belongs to one named person, so that every action is theirs (M02-FR-01).`, 'Use the person\'s own name — for example their first name and initial. Nothing was saved.');
        }
        if (userId === ctx.userId) {
          throw notSaved(422, 'signing_in_yourself', 'Nobody gives themselves a sign-in.', 'Ask another administrator. Nothing was saved.');
        }
        const directory = directoryFor(ctx.tenantId);
        if (directory === undefined) {
          throw notSaved(503, 'identity_server_not_connected', 'This deployment is not connected to the identity server, so no sign-in can be given from here.', 'The administrator sets the provisioner secret on the server (runbook: identity server). Nothing was saved.');
        }

        const existing = (await deps.people(ctx.tenantId)).find((p) => p.userId === userId || p.username === username);
        if (existing !== undefined && (existing.userId !== userId || existing.username !== username)) {
          throw notSaved(409, 'sign_in_name_or_person_already_used', `${existing.userId} already has the sign-in name "${existing.username}".`, 'Choose another sign-in name, or check who this person is. Nothing was saved.');
        }
        if (existing?.state === 'issued') {
          throw notSaved(409, 'person_already_has_a_sign_in', `${userId} already has a sign-in. A second one is never made, and their password is never replaced from here.`, 'If they cannot sign in, the administrator resets it at the identity server. Nothing was saved.');
        }
        if (existing?.state === 'ended') {
          throw notSaved(409, 'sign_in_ended', `${userId}'s sign-in was ended when they left. It is not revived from here.`, 'A returning person joins again through the access lifecycle. Nothing was saved.');
        }
        if (await deps.holdsAnyRole(ctx.tenantId, userId)) {
          throw notSaved(422, 'person_already_holds_authority', `${userId} already holds a role. A sign-in made here is for a new person with no authority yet — otherwise whoever saw the one-time password could act with that person's authority.`, 'The administrator gives an existing role-holder their sign-in at the identity server, in that person\'s presence (runbook). Nothing was saved.');
        }

        const at = deps.now();
        const resume = existing?.state === 'requested';
        if (!resume) {
          await deps.recordPerson(ctx.tenantId, { type: 'PersonSignInRequested', userId, username, displayName, secondFactor: true, requestedBy: ctx.userId, at });
        }
        const password = (deps.generatePassword ?? oneTimePassword)();
        let outcome;
        try {
          outcome = await directory.issue({ username, userId, displayName, secondFactor: true, temporaryPassword: password }, resume);
        } catch (e) {
          if (e instanceof DirectoryUnavailableError) {
            throw apiError(503, {
              code: 'identity_server_unavailable',
              whatHappened: `${e.message}. ${userId} is recorded as asked for; no sign-in was finished.`,
              wasItSaved: 'saved',
              nextSafeAction: 'Try again when the identity server answers — the same request finishes it.',
            });
          }
          throw e;
        }
        if (outcome.result === 'refused') {
          await deps.recordPerson(ctx.tenantId, { type: 'PersonSignInWithdrawn', userId, reason: outcome.code, at: deps.now() });
          throw notSaved(409, outcome.code, outcome.detail, 'Choose another sign-in name, or check who this person is. No sign-in was given.');
        }
        const issuedAt = deps.now();
        await deps.recordPerson(ctx.tenantId, { type: 'PersonSignInIssued', userId, issuedBy: ctx.userId, resumed: outcome.resumed, at: issuedAt });
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'person.sign_in.issue', objectType: 'user', objectId: userId,
          at: issuedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { signInName: username, displayName, secondFactor: 'required', resumed: String(outcome.resumed) },
          correlationId: ctx.idempotencyKey ?? userId,
        });
        return {
          status: 201,
          body: {
            userId, signInName: username, displayName, state: 'issued', secondFactor: 'required',
            oneTimePassword: password,
            handOver: 'Give this to the person yourself. It works once: at first sign-in they choose their own password and set up the one-time code on their phone. It is not shown again.',
          },
        };
      },
    },
  ];
}
