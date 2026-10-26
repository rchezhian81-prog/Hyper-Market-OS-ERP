// The access review and the permission-matrix export on head office's API (M02-FR-01 · M02-FR-02 · SEC-11 · §28 · P-03).
//
// `accessReview` existed in the identity package and nothing called it (audit M02-FR-02 (3)). This is its route: every
// person and machine that holds a role here — what they hold, where (branches and departments), up to how much (the
// server's money limits), whether their sign-in is live or ended, whether a second factor was set up — with the rows that
// need a second look flagged (control by exception). And the permission matrix, as data and as a CSV a person can open.
// Read-only: a review changes nobody's access; a change goes through the joiner/mover/leaver routes, by two people.

import type { Route } from '../../kernel/src/index';
import {
  reviewAccess, permissionMatrix, permissionMatrixCsv, ACCESS_REVIEW_FLAGS,
  type ReviewPerson, type ReviewGrant, type ReviewEmergencyGrant, type ReviewRole,
} from '../../../packages/identity/src/access-review';
import { LIMITED_SUBJECTS, authorityWords, type Authority } from '../../../packages/approvals/src/authority-rules';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';

export interface AccessReviewDeps {
  readonly people: (tenantId: string) => Promise<readonly ReviewPerson[]>;
  /** Live grants, each with its department scope (absent = all departments). */
  readonly grants: (tenantId: string) => Promise<readonly ReviewGrant[]>;
  /** Emergency grants still live now (not revoked, not expired). */
  readonly emergency: (tenantId: string) => Promise<readonly ReviewEmergencyGrant[]>;
  readonly roles: () => readonly ReviewRole[];
  readonly machineRoleIds: readonly string[];
  readonly isItRole: (roleId: string) => boolean;
  /** The server's money authority (OB-290) — shown per person. Optional on a bare stub. */
  readonly authorityOf?: (tenantId: string, userId: string, subjectType: string) => Promise<Authority>;
  readonly now: () => string;
}

export function accessReviewRoutes(deps: AccessReviewDeps): readonly Route[] {
  return [
    {
      // Who holds what, where and up to how much — and which rows deserve a second look. `?flagged=true` narrows to those.
      api: 'API-01', method: 'GET', path: '/v1/identity/access-review',
      permission: 'identity.access.review',
      handler: async (ctx) => {
        const [people, grants, emergency] = await Promise.all([deps.people(ctx.tenantId), deps.grants(ctx.tenantId), deps.emergency(ctx.tenantId)]);
        const rows = reviewAccess({ people, grants, emergency, roles: deps.roles(), machineRoleIds: deps.machineRoleIds, isItRole: deps.isItRole });
        const withLimits = await Promise.all(rows.map(async (r) => ({
          ...r,
          ...(deps.authorityOf === undefined || r.machine ? {} : {
            moneyLimits: Object.fromEntries(await Promise.all(LIMITED_SUBJECTS.map(async (s) => {
              const a = await deps.authorityOf!(ctx.tenantId, r.userId, s);
              return [s, { state: a.state, limitMinor: a.limitMinor, words: authorityWords(a) }] as const;
            }))),
          }),
        })));
        const shown = ctx.query['flagged'] === 'true' ? withLimits.filter((r) => r.flags.length > 0) : withLimits;
        return {
          status: 200,
          body: {
            asAt: deps.now(), rows: shown, count: shown.length, flagged: withLimits.filter((r) => r.flags.length > 0).length,
            flagCodes: ACCESS_REVIEW_FLAGS,
            lastSignInNote: 'The time of each person\'s last sign-in is kept by the identity server, not by head office.',
          },
        };
      },
    },
    {
      // Every role against every permission it grants. `?format=csv` hands the same matrix as a CSV to save.
      api: 'API-01', method: 'GET', path: '/v1/identity/permission-matrix',
      permission: 'identity.access.review',
      handler: async (ctx) => {
        const roles = deps.roles();
        if (ctx.query['format'] === 'csv') {
          return { status: 200, body: { format: 'csv', filename: `permission-matrix-${shopDateIn(deps.now())}.csv`, csv: permissionMatrixCsv(roles) } };
        }
        return { status: 200, body: { asAt: deps.now(), ...permissionMatrix(roles), roleNames: Object.fromEntries(roles.map((r) => [r.id, r.name])) } };
      },
    },
  ];
}
