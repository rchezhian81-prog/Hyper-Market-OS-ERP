// HEAD OFFICE TAKES A PRIVILEGE CHANGE THE STORE PC SEALED — CR-01 step 4a · OI-06 · ADR-0033 · OB-731 "A" · OB-732 "B" ·
// §28 · P-03 · hard rules #4, #5, #10.
//
// On a store PC with no identity server, the office screens cannot reach the person's own routes (`POST /v1/identity/grants`
// and `…/approve` ask for a recent second-factor sign-in, which only an identity server gives). ADR-0033: the box checks the
// person's PIN again, seals a decision record with the DEDICATED privilege-seal key and relays it here under its store token.
// These routes:
//
//   • take it only from a STORE COMPUTER's credential (its `store_computer` grant; the kernel's store binding, OB-54, has
//     already judged the credential's store), with the relay permission (`identity.grants.sync` / `identity.people.sync`);
//   • REFUSE — a code each, never a flag — a record that is not readable, for another act or shop, unsealed, sealed with
//     another key or changed since, confirmed more than 300 s ago (or ahead of this clock), or whose request id was used;
//   • then run THE SAME handler as the person's own route, AS that person: their authority here (they must hold the route's
//     own permission at head office), and §28 — the approver is never the requester and already holds what is granted;
//   • audit it in the PERSON's name, marked `via: office_pin` and naming the box that carried it; and
//   • raise an owner alert (P-03): who, what, when, approved by whom — so a change the owner did not expect is seen that day.
//
// The box never mints a token (ADR-0029 §1); nothing here signs anybody in.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { checkPrivilegeRecord, PRIVILEGE_VIA, type PrivilegeKind, type PrivilegeRecord } from '../../../packages/identity/src/privilege-seal';
import { identityRoutes, type IdentityDeps } from './index';
import type { PeopleDeps } from './people';
import { isGenericName, PRODUCT_ID, readablePersonName, tidyPersonName } from '../../../packages/identity/src/sign-in-names';

/** The relay permissions the store computer's identity holds (services/api/src/roles.ts) — they grant nothing themselves. */
export const PEOPLE_SYNC_PERMISSION = 'identity.people.sync';
export const GRANTS_SYNC_PERMISSION = 'identity.grants.sync';
export const BOX_PRIVILEGE_PATHS = Object.freeze({
  people: '/v1/identity/box/people',
  grants: '/v1/identity/box/grants',
  approve: '/v1/identity/box/grants/:grantId/approve',
  /** CR-01 step 4b-1: a second person turns a pending request down, by PIN. */
  reject: '/v1/identity/box/grants/:grantId/reject',
  /** CR-01 step 4b-1: what the Users & roles page shows the person signed in on the store PC, at this store only. */
  view: '/v1/identity/box/users-view',
});
/**
 * The authority to add a store-PC person (OB-733 "A"): the MAKER's word — the owner and the store manager, who ask for roles.
 * A store-PC person holds no authority until a role is approved by a second person, so the name alone needs one person.
 */
export const STORE_PC_PERSON_AUTHORITY = 'identity.role.request';
/** The role a store computer's credential holds (packages/platform `STORE_COMPUTER_ROLE`). */
const STORE_COMPUTER_ROLE = 'store_computer';

/** What the owner is told about one privilege change made on the store PC (ADR-0033 §5). */
export interface PrivilegeChangeAlert {
  readonly requestId: string;
  readonly kind: PrivilegeKind;
  /** Who did it — the person the store PC verified by PIN. */
  readonly actingUserId: string;
  /** Whose access it is about. */
  readonly subjectUserId: string;
  /** The role (empty for a person added — `person_provision`). */
  readonly roleId: string;
  readonly branchScope: readonly string[] | 'all';
  /** The grant request (empty for a person added). */
  readonly grantId: string;
  readonly requestedBy: string;
  /** For a person added (`person_provision`): their name. */
  readonly displayName?: string;
  /** For an approval: who approved it (the acting person). Absent for a request (it waits for a second person). */
  readonly approvedBy?: string;
  /** When the PIN was confirmed at the store PC, and when head office recorded it. */
  readonly confirmedAt: string;
  readonly at: string;
  /** The store computer that carried it, and its store. */
  readonly relayedBy: string;
  readonly storeId: string | null;
}

export interface BoxPrivilegeDeps {
  /** The SAME deps the person's own identity routes run on — so the same handler runs here. */
  readonly identity: IdentityDeps;
  /** The key derived from BOX_PRIVILEGE_SEAL_KEY (`privilegeSealKey`). Absent: every relay is refused (503), never trusted. */
  readonly privilegeSealKey?: Buffer;
  readonly now: () => string;
  /** Spend a request id ONCE, durably: 'first' the first time, 'used' every time after (a one-use list, never deleted). */
  readonly spendRequestId: (tenantId: string, use: { readonly requestId: string; readonly kind: PrivilegeKind; readonly userId: string; readonly relayedBy: string; readonly at: string }) => Promise<'first' | 'used'>;
  /** The roles a caller holds now (to know a store computer's credential from a person's). */
  readonly rolesHeldBy: (tenantId: string, userId: string) => Promise<readonly string[]> | readonly string[];
  /** Raise the owner's alert for an accepted change. Absent on a bare stub only. */
  readonly raiseOwnerAlert?: (tenantId: string, alert: PrivilegeChangeAlert) => Promise<void>;
  /**
   * CR-01 step 4b-1 (OB-733 "A"): the people register — the same one head office's people routes fold. Absent: adding a
   * person from the store PC is refused (503), never half done.
   */
  readonly people?: Pick<PeopleDeps, 'people' | 'recordPerson' | 'holdsAnyRole'>;
}

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string) =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function boxPrivilegeRoutes(deps: BoxPrivilegeDeps): readonly Route[] {
  /**
   * The person's own routes, built on the same deps for ONE relayed act — their audit entries marked as made on the store
   * PC, by PIN, naming the box that carried it and the store PC's request id.
   */
  const personRoute = (path: string, via: { readonly requestId: string; readonly relayedBy: string }): Route => {
    const routes = identityRoutes({
      ...deps.identity,
      recordAudit: async (tenantId: string, entry: AuditEntry) => {
        await deps.identity.recordAudit?.(tenantId, { ...entry, after: { ...(entry.after ?? {}), via: PRIVILEGE_VIA, relayedBy: via.relayedBy, privilegeRequestId: via.requestId } });
      },
    });
    const r = routes.find((x) => x.method === 'POST' && x.path === path);
    if (r === undefined) throw new Error(`the person's own route ${path} is missing`);
    return r;
  };
  const REQUEST_ROUTE = '/v1/identity/grants';
  const APPROVE_ROUTE = '/v1/identity/grants/:grantId/approve';
  const REJECT_ROUTE = '/v1/identity/grants/:grantId/reject';

  const mustBeStoreComputer = async (ctx: RequestContext): Promise<void> => {
    const held = await deps.rolesHeldBy(ctx.tenantId, ctx.userId);
    if (!held.includes(STORE_COMPUTER_ROLE)) {
      throw refuse(403, 'not_a_store_computer', 'Only the store PC itself relays a privilege change confirmed by PIN on its office screens, or reads for them. This credential is not a store computer\'s.', 'A person uses their own routes with their own head-office sign-in. Nothing changed.');
    }
  };

  /** Every relay: a store computer, the key, the seal, the clock, the one-use id, the person's own authority. */
  const accept = async (ctx: RequestContext, kind: PrivilegeKind, permission: string): Promise<PrivilegeRecord> => {
    await mustBeStoreComputer(ctx);
    if (deps.privilegeSealKey === undefined) {
      throw refuse(503, 'privilege_seal_key_not_set', 'Head office holds no privilege-seal key (BOX_PRIVILEGE_SEAL_KEY), so it cannot check a privilege change sealed on the store PC.', 'The administrator runs the store computer setup again, which adds the key once, then restarts the office service. Nothing changed.');
    }
    const checked = checkPrivilegeRecord(deps.privilegeSealKey, { kind, tenantId: ctx.tenantId, relayed: ctx.body, nowMs: Date.parse(deps.now()) });
    if (!checked.ok) {
      throw refuse(checked.refusedBecause === 'privilege_record_not_readable' ? 400 : 403, checked.refusedBecause, checked.why, 'Nobody\'s access changed. The person confirms with their PIN again on the store PC\'s office screen.');
    }
    const record = checked.record;
    if ((kind === 'role_grant_approval' || kind === 'role_grant_rejection') && record.body['grantId'] !== (ctx.params['grantId'] ?? '')) {
      throw refuse(403, 'privilege_record_does_not_match', `The sealed approval is for request ${String(record.body['grantId'])}, not ${ctx.params['grantId'] ?? ''}.`, 'Nobody\'s access changed.');
    }
    const spent = await deps.spendRequestId(ctx.tenantId, { requestId: record.requestId, kind, userId: record.userId, relayedBy: ctx.userId, at: deps.now() });
    if (spent === 'used') {
      throw refuse(409, 'privilege_request_already_used', `Privilege request ${record.requestId} was already used. A sealed confirmation is good for one act, once.`, 'Nobody\'s access changed by this. The person confirms with their PIN again for a new act.');
    }
    const permissions = await deps.identity.permissionsOf(ctx.tenantId, record.userId);
    if (!permissions.includes(permission)) {
      throw refuse(403, 'acting_person_lacks_authority', `${record.userId} does not hold ${permission} at head office, so they may not do this — on the store PC or anywhere.`, 'Nobody\'s access changed. Someone who holds that authority does it.');
    }
    return record;
  };

  /** Run the person's own handler as the acting person, the store PC's request id as the idempotency key. */
  const runAs = async (path: string, ctx: RequestContext, record: PrivilegeRecord, params: Readonly<Record<string, string>>, body: unknown) =>
    personRoute(path, { requestId: record.requestId, relayedBy: ctx.userId }).handler({
      tenantId: ctx.tenantId, userId: record.userId, branchId: ctx.branchId, params, query: {}, body,
      idempotencyKey: record.requestId, traceId: ctx.traceId,
    });

  const alert = async (ctx: RequestContext, a: Omit<PrivilegeChangeAlert, 'at' | 'relayedBy' | 'storeId'>): Promise<void> => {
    await deps.raiseOwnerAlert?.(ctx.tenantId, { ...a, at: deps.now(), relayedBy: ctx.userId, storeId: ctx.branchId });
  };

  return [
    {
      // OI-06 "add a person" from the store PC (CR-01 step 4b-1 · OB-733 "A"): a STORE-PC PERSON — their name and staff id
      // recorded on head office's people register, NO sign-in made anywhere (the store PC has no identity server). They hold
      // nothing until a role is asked for and approved by a second person; they sign in only on the store PC, by till PIN.
      // One person adds the name (the maker's authority, `identity.role.request`), confirmed by PIN; recorded and alerted.
      api: 'API-01', method: 'POST', path: BOX_PRIVILEGE_PATHS.people,
      permission: PEOPLE_SYNC_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const record = await accept(ctx, 'person_provision', STORE_PC_PERSON_AUTHORITY);
        if (deps.people === undefined) {
          throw refuse(503, 'people_register_not_wired', 'Head office has no people register wired here, so nobody can be added from the store PC.', 'Nobody was added. The administrator checks the office service\'s setup.');
        }
        const b = record.body;
        const userId = typeof b['userId'] === 'string' ? b['userId'].trim().toLowerCase() : '';
        const displayName = typeof b['displayName'] === 'string' ? tidyPersonName(b['displayName']) : '';
        const extra = Object.keys(b).filter((k) => k !== 'userId' && k !== 'displayName');
        if (!PRODUCT_ID.test(userId) || !readablePersonName(displayName) || extra.length > 0) {
          throw refuse(400, 'not_readable_as_a_person', 'Adding a person on the store PC needs { userId (their staff id: 3–64 of a–z, 0–9, . _ -), displayName (their full name) } and nothing else — never a PIN or a password.', 'Type the person\'s staff id and full name. Nobody was added.');
        }
        if (isGenericName(userId) || isGenericName(displayName)) {
          throw refuse(422, 'shared_or_generic_sign_in', `"${isGenericName(displayName) ? displayName : userId}" names a job, a place or a shared account, not a person. Every staff id belongs to one named person, so that every action is theirs (M02-FR-01).`, 'Use the person\'s own staff id and name. Nobody was added.');
        }
        if (userId === record.userId) {
          throw refuse(422, 'signing_in_yourself', 'Nobody adds themselves.', 'Ask another person who may add people. Nobody was added.');
        }
        const known = (await deps.people.people(ctx.tenantId)).find((p) => p.userId === userId || p.username === userId);
        if (known !== undefined) {
          throw refuse(409, 'person_already_known', `${userId} is already on the people register (${known.displayName}, ${known.state === 'ended' ? 'left' : 'here'}). A person is added once; somebody who left is not revived from here.`, 'Check the staff id. Nobody was added.');
        }
        if (await deps.people.holdsAnyRole(ctx.tenantId, userId)) {
          throw refuse(422, 'person_already_holds_authority', `${userId} already holds a role, so they are not a new person.`, 'Check the staff id. Nobody was added.');
        }
        const at = deps.now();
        await deps.people.recordPerson(ctx.tenantId, { type: 'PersonRecordedForStorePc', userId, displayName, recordedBy: record.userId, storeId: ctx.branchId, at });
        await deps.identity.recordAudit?.(ctx.tenantId, {
          actorId: record.userId, action: 'person.store_pc.record', objectType: 'user', objectId: userId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { displayName, signIn: 'none (store PC only)', via: PRIVILEGE_VIA, relayedBy: ctx.userId, privilegeRequestId: record.requestId },
          correlationId: record.requestId,
        });
        await alert(ctx, {
          requestId: record.requestId, kind: 'person_provision', actingUserId: record.userId, subjectUserId: userId,
          roleId: '', branchScope: ctx.branchId === null ? [] : [ctx.branchId], grantId: '', requestedBy: record.userId,
          displayName, confirmedAt: record.confirmedAt,
        });
        return { status: 201, body: { userId, displayName, state: 'store_pc', signIn: 'none', via: PRIVILEGE_VIA, privilegeRequestId: record.requestId } };
      },
    },
    {
      // THE MAKER's act, confirmed by PIN on the store PC: ask for a role for somebody else (the same handler as
      // POST /v1/identity/grants, run as the acting person — every refusal of that route applies).
      api: 'API-01', method: 'POST', path: BOX_PRIVILEGE_PATHS.grants,
      permission: GRANTS_SYNC_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const record = await accept(ctx, 'role_request', 'identity.role.request');
        const out = await runAs(REQUEST_ROUTE, ctx, record, {}, record.body);
        const b = (isObj(out.body) ? out.body : {}) as Record<string, unknown>;
        if (out.status === 202 && b['alreadyRequested'] !== true) {
          const scope = record.body['branchScope'];
          await alert(ctx, {
            requestId: record.requestId, kind: 'role_request', actingUserId: record.userId,
            subjectUserId: String(record.body['userId']), roleId: String(record.body['roleId']),
            branchScope: scope === 'all' ? 'all' : Array.isArray(scope) ? scope.map(String) : [],
            grantId: String(record.body['grantId']), requestedBy: record.userId, confirmedAt: record.confirmedAt,
          });
        }
        return { status: out.status, body: { ...b, via: PRIVILEGE_VIA, privilegeRequestId: record.requestId } };
      },
    },
    {
      // THE CHECKER's act, confirmed by PIN on the store PC: approve a pending request (the same handler as
      // POST /v1/identity/grants/:grantId/approve — §28: never the requester, and only what the approver already holds).
      api: 'API-01', method: 'POST', path: BOX_PRIVILEGE_PATHS.approve,
      permission: GRANTS_SYNC_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const record = await accept(ctx, 'role_grant_approval', 'identity.role.grant');
        const grantId = ctx.params['grantId'] ?? '';
        const out = await runAs(APPROVE_ROUTE, ctx, record, { grantId }, {});
        const b = (isObj(out.body) ? out.body : {}) as Record<string, unknown>;
        if (out.status === 201 && b['alreadyGranted'] !== true) {
          const pending = (await deps.identity.grantRequests(ctx.tenantId)).find((g) => g.grantId === grantId);
          await alert(ctx, {
            requestId: record.requestId, kind: 'role_grant_approval', actingUserId: record.userId,
            subjectUserId: pending?.userId ?? '', roleId: pending?.roleId ?? '', branchScope: pending?.branchScope ?? [],
            grantId, requestedBy: pending?.requestedBy ?? '', approvedBy: record.userId, confirmedAt: record.confirmedAt,
          });
        }
        return { status: out.status, body: { ...b, via: PRIVILEGE_VIA, privilegeRequestId: record.requestId } };
      },
    },
    {
      // CR-01 step 4b-1: THE CHECKER turns a pending request down, confirmed by PIN on the store PC (the same handler as
      // POST /v1/identity/grants/:grantId/reject, run as the acting person, a reason required). A rejection changes nobody's
      // access, so no owner alert; it is audited in the person's name.
      api: 'API-01', method: 'POST', path: BOX_PRIVILEGE_PATHS.reject,
      permission: GRANTS_SYNC_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const record = await accept(ctx, 'role_grant_rejection', 'identity.role.grant');
        const grantId = ctx.params['grantId'] ?? '';
        const out = await runAs(REJECT_ROUTE, ctx, record, { grantId }, { reason: record.body['reason'] });
        const b = (isObj(out.body) ? out.body : {}) as Record<string, unknown>;
        if (out.status === 200 && b['alreadyDecided'] !== true) {
          const pending = (await deps.identity.grantRequests(ctx.tenantId)).find((g) => g.grantId === grantId);
          await deps.identity.recordAudit?.(ctx.tenantId, {
            actorId: record.userId, action: 'role.grant.reject', objectType: 'user', objectId: pending?.userId ?? '',
            at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
            before: null,
            after: { roleId: pending?.roleId ?? '', requestedBy: pending?.requestedBy ?? '', rejectedBy: record.userId, reason: String(record.body['reason'] ?? ''), via: PRIVILEGE_VIA, relayedBy: ctx.userId, privilegeRequestId: record.requestId },
            correlationId: grantId,
          });
        }
        return { status: out.status, body: { ...b, via: PRIVILEGE_VIA, privilegeRequestId: record.requestId } };
      },
    },
    {
      // CR-01 step 4b-1: what the Users & roles page shows the person signed in on the store PC's office screens (`for`),
      // read by the box under its store token. Head office judges the PERSON's authority here — the same gates as the
      // person's own reads: the roles and who holds what with `identity.role.request`, what waits with `identity.role.read`
      // — and shows THIS store only: grants and requests that reach the box's own store (or every store). Read only.
      api: 'API-01', method: 'GET', path: BOX_PRIVILEGE_PATHS.view,
      permission: GRANTS_SYNC_PERMISSION,
      handler: async (ctx) => {
        await mustBeStoreComputer(ctx);
        const forUser = typeof ctx.query['for'] === 'string' ? ctx.query['for'].trim() : '';
        if (forUser === '') {
          throw refuse(400, 'needs_a_person', 'Say whose view this is: ?for=<the person signed in on the office screens>.', 'Nothing was read.');
        }
        const held = new Set(await deps.identity.permissionsOf(ctx.tenantId, forUser));
        const store = ctx.branchId;
        const here = (scope: readonly string[] | 'all'): boolean => scope === 'all' || (store !== null && scope.includes(store));
        const mayAsk = held.has('identity.role.request');
        const mayRead = held.has('identity.role.read');
        const body: Record<string, unknown> = { asAt: deps.now(), for: forUser, storeId: store, mayAsk, mayRead, mayDecide: held.has('identity.role.grant') };
        if (mayAsk || mayRead) {
          body['roles'] = await deps.identity.roles(ctx.tenantId);
          body['awaitingOwnerApproval'] = deps.identity.rolesAwaitingOwnerApproval ?? [];
        }
        if (mayAsk) {
          const grants = deps.identity.currentGrants === undefined ? [] : await deps.identity.currentGrants(ctx.tenantId);
          body['grants'] = [...grants].filter((g) => here(g.branchScope))
            .map((g) => ({ userId: g.userId, roleId: g.roleId, branchScope: g.branchScope }))
            .sort((a, b) => a.userId.localeCompare(b.userId) || a.roleId.localeCompare(b.roleId));
          const people = deps.people === undefined ? [] : await deps.people.people(ctx.tenantId);
          body['people'] = people.filter((p) => p.state !== 'ended').map((p) => ({ userId: p.userId, displayName: p.displayName, state: p.state }))
            .sort((a, b) => a.userId.localeCompare(b.userId));
        }
        if (mayRead) {
          body['pending'] = (await deps.identity.grantRequests(ctx.tenantId)).filter((g) => g.state === 'pending' && here(g.branchScope));
        }
        return { status: 200, body };
      },
    },
  ];
}

/** The owner alert's words: who, what, when, approved by whom (ADR-0033 §5). */
export function privilegeAlertWords(a: PrivilegeChangeAlert): string {
  const where = a.branchScope === 'all' ? 'every store' : a.branchScope.join(', ') || 'no store named';
  const what = a.kind === 'person_provision'
    ? `${a.actingUserId} added a new person on the store PC: ${a.displayName ?? a.subjectUserId} (staff id ${a.subjectUserId}). They hold no role yet; a role needs a second person`
    : a.kind === 'role_request'
      ? `${a.actingUserId} asked for the ${a.roleId} role for ${a.subjectUserId} (${where}); it waits for a second person to approve`
      : `${a.actingUserId} approved the ${a.roleId} role for ${a.subjectUserId} (${where}), asked for by ${a.requestedBy}`;
  const ref = a.grantId === '' ? a.requestId : a.grantId;
  return `${what}. Confirmed by PIN on the store PC${a.storeId === null ? '' : ` of store ${a.storeId}`} at ${a.confirmedAt}, recorded at ${a.at} (request ${ref}). If you did not expect this, look at Users & roles today.`;
}
