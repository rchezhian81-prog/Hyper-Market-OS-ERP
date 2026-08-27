// API-01 Emergency access (M02-FR-04 · SEC-11 · P-04 · §28) — the elevated access that is real,
// necessary, and the one that quietly becomes permanent. Tested since the module was written, on NO cloud
// route. Support needs the owner's rights for twenty minutes to fix something; six months later they still
// have them and nobody remembers granting it. Every rule here exists to stop that:
//
//   • it is TIME-BOUND AT THE MOMENT IT IS GRANTED — the expiry is computed now and stored, so it ends on
//     its own and does not depend on anyone remembering (SEC-11);
//   • it needs a SPECIFIC reason (reviewed afterwards) and a SEPARATE approver — the person asking for
//     elevated access can never approve their own (§28);
//   • it is CAPPED by policy — "there is no perpetual support access", so an unbounded request is refused;
//   • it is NEVER EXTENDED IN PLACE — more time is a NEW grant with a NEW approval, which is exactly what
//     makes it appear in the review instead of accreting silently;
//   • every grant is REVIEWABLE — who had elevated access, when, why, for how long, and who allowed it.
//
// The rules are the tested `grantEmergencyAccess` / `revokeEmergencyAccess` / `emergencyAccessReview` in
// `@sre/identity` (the services-run-on-their-tested-engine guardrail). Grants are recorded append-only,
// folded latest-per-grantId (a revocation supersedes). Granting/revoking is gated `identity.role.grant`
// (owner); the review reads `identity.role.read`. The authenticated caller is the APPROVER — they cannot be
// the person who requested it.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  grantEmergencyAccess, revokeEmergencyAccess, emergencyAccessReview, EmergencyAccessError,
  type EmergencyGrant, type EmergencyRequest, type EmergencyPolicy, type LifecycleApproval,
} from '../../../packages/identity/src/index';

export type { EmergencyGrant } from '../../../packages/identity/src/index';

// The longest a single emergency grant may run when the caller does not say — a few hours, never a day.
const DEFAULT_MAX_MINUTES = 240;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
/** 'all' or a list of branch ids. */
const readScope = (v: unknown): readonly string[] | 'all' | undefined =>
  v === 'all' ? 'all' : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

export interface EmergencyAccessDeps {
  readonly grant: (tenantId: string, grantId: string) => Promise<EmergencyGrant | undefined> | EmergencyGrant | undefined;
  /** Every emergency grant recorded — folded latest-per-grantId (a revocation supersedes). */
  readonly grants: (tenantId: string) => Promise<readonly EmergencyGrant[]> | readonly EmergencyGrant[];
  readonly recordGrant: (tenantId: string, grantId: string, grant: EmergencyGrant, key: string) => Promise<void> | void;
  readonly now: () => string;
}

// A stable digest so a re-send collapses but a real change (a revocation) is a new append-only fact.
const digestOf = (g: EmergencyGrant): string =>
  [g.userId, g.roleId, g.branchScope === 'all' ? 'all' : [...g.branchScope].sort().join(','), g.grantedAt, g.expiresAt, g.revokedAt ?? ''].join('|');

export function emergencyAccessRoutes(deps: EmergencyAccessDeps): readonly Route[] {
  return [
    {
      // Grant time-bound emergency access. The AUTHENTICATED CALLER is the approver (§28 — they cannot be
      // the requester). Body: { userId, roleId, branchScope ('all' | [branchId]), reason, minutes,
      // requestedBy, maxMinutes? }. The expiry is computed at grant time and stored — it never open-ends.
      api: 'API-01', method: 'POST', path: '/v1/access/emergency/:grantId',
      permission: 'identity.role.grant', idempotent: true,
      handler: async (ctx) => {
        const grantId = (ctx.params['grantId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const branchScope = readScope(b['branchScope']);
        if (grantId === '' || !isStr(b['userId']) || !isStr(b['roleId']) || !isStr(b['reason'])
          || !isStr(b['requestedBy']) || !isPosInt(b['minutes']) || branchScope === undefined
          || (b['maxMinutes'] !== undefined && !isPosInt(b['maxMinutes']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_emergency_request',
            whatHappened: 'An emergency grant needs a grantId in the path and { userId, roleId, branchScope ("all" or [branchId]), reason, minutes, requestedBy, maxMinutes? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Say who needs it, what role, in which branches, for how many minutes, why, and who asked — you (the approver) cannot be the requester.',
          });
        }
        const request: EmergencyRequest = {
          grantId, userId: b['userId'] as string, requestedBy: b['requestedBy'] as string,
          reason: b['reason'] as string, roleId: b['roleId'] as string, branchScope,
          at: deps.now(), minutes: b['minutes'],
        };
        // The caller is the approver — they approve in their own name, and the engine refuses a
        // self-approval (§28), a too-short reason, and anything over the policy cap (SEC-11).
        const approval: LifecycleApproval = { subjectRef: grantId, status: 'approved', decidedBy: ctx.userId };
        const policy: EmergencyPolicy = { maxMinutes: (b['maxMinutes'] as number | undefined) ?? DEFAULT_MAX_MINUTES, requiresApprovalBy: 'owner' };
        let granted: EmergencyGrant;
        try {
          granted = grantEmergencyAccess(request, approval, policy);
        } catch (e) {
          if (e instanceof EmergencyAccessError) {
            throw apiError(422, {
              code: 'emergency_access_refused',
              whatHappened: `Emergency access was refused: ${e.why}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Give a specific reason, keep it within the time cap, and make sure the approver is not the person who asked.',
            });
          }
          throw e;
        }
        await deps.recordGrant(ctx.tenantId, grantId, granted, digestOf(granted));
        return { status: 201, body: { grantId, userId: granted.userId, approvedBy: granted.approvedBy, expiresAt: granted.expiresAt } };
      },
    },
    {
      // End a grant early — recorded, never erased. Expiry needs no action; this is for cutting it short.
      api: 'API-01', method: 'POST', path: '/v1/access/emergency/:grantId/revoke',
      permission: 'identity.role.grant', idempotent: true,
      handler: async (ctx) => {
        const grantId = ctx.params['grantId'] ?? '';
        const existing = await deps.grant(ctx.tenantId, grantId);
        if (existing === undefined) throw notFound(`emergency grant ${grantId}`);
        const revoked = revokeEmergencyAccess(existing, deps.now());
        await deps.recordGrant(ctx.tenantId, grantId, revoked, digestOf(revoked));
        return { status: 200, body: { grantId, revokedAt: revoked.revokedAt } };
      },
    },
    {
      // The SEC-11 review: who had elevated access, when, why, for how long, who allowed it — active and
      // ended-early both visible, newest first. This is what makes "temporary" access impossible to hide.
      api: 'API-01', method: 'GET', path: '/v1/access/emergency',
      permission: 'identity.role.read',
      handler: async (ctx) => {
        const now = deps.now();
        const review = emergencyAccessReview(await deps.grants(ctx.tenantId), now);
        return { status: 200, body: { review, count: review.length, active: review.filter((r) => r.active).length, asAt: now } };
      },
    },
  ];
}
