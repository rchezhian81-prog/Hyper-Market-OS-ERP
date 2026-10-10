// API-06 Loyalty members and the earn rule (Wave 5 · PF-09-a · owner decisions OB-28 "C and 1", OB-29 "A",
// M16-FR-01, M17-FR-01, P-04, P-08).
//
//   • JOINING NEEDS CONSENT (M16-FR-02 / DPDP). A member is enrolled at the service desk by a named person who has seen
//     the number on the customer's own phone (OB-29 "A"; the SMS code is deferred to R4 in writing), with the customer's
//     recorded "yes". No consent, no member.
//   • THE PHONE NUMBER IS NEVER STORED (P-04). Head office keeps the member CODE (a keyed hash of the number) and the
//     last four digits for the desk to read back — nothing else. Leaving is a new fact; from then on the code earns
//     nothing and the desk cannot find the person by number.
//   • THE RULE IS THE OWNER'S (OB-28 "C"). Points per ₹100 and the value of a point are store-setup settings; zero
//     means loyalty is off, and every answer here says so rather than inventing a rate.
//
// Looking a member up takes the number in the BODY of a POST, never a URL — a URL ends up in logs (hard rule #4).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { memberRefFor, normaliseMobile, isMemberRef } from '../../../packages/loyalty/src/index';

/** One fact about a member, as head office keeps it — never the phone number. */
export interface MemberRecord {
  readonly memberRef: string;
  readonly mobileLast4: string;
  readonly status: 'member' | 'left';
  /** When the customer said yes to loyalty, and who enrolled them. */
  readonly consentGivenAt: string;
  readonly enrolledBy: string;
  /** How the number was checked (OB-29 "A"): seen on the customer's own phone. An SMS code is R4. */
  readonly verifiedHow: 'seen_on_phone';
  readonly leftAt?: string;
  readonly leftBy?: string;
  readonly leftReason?: string;
}

export interface LoyaltyRule {
  readonly pointsPer100Inr: number;
  readonly pointValuePaise: number;
}

export interface LoyaltyMemberDeps {
  /** The key the member code is made with — shared with the store computer. Absent → the routes refuse (said). */
  readonly memberKey?: Buffer;
  /** Every fact about one member code, oldest first. */
  readonly memberHistory: (tenantId: string, memberRef: string) => Promise<readonly MemberRecord[]> | readonly MemberRecord[];
  readonly recordMember: (tenantId: string, record: MemberRecord, key: string) => Promise<void> | void;
  readonly pointsBalance: (tenantId: string, customerId: string) => Promise<number | undefined> | number | undefined;
  readonly rule: (tenantId: string) => Promise<LoyaltyRule> | LoyaltyRule;
  readonly now: () => string;
}

/** Whether the code was a member at a moment: enrolled at or before it, and not left by then. */
export function wasMemberAt(history: readonly MemberRecord[], at: string): boolean {
  let member = false;
  for (const r of history) {
    if (r.status === 'member' && r.consentGivenAt <= at) member = true;
    if (r.status === 'left' && (r.leftAt ?? '') <= at) member = false;
  }
  return member;
}

const current = (history: readonly MemberRecord[]): MemberRecord | undefined => history[history.length - 1];

const ruleDetail = (rule: LoyaltyRule): string => rule.pointsPer100Inr > 0
  ? `A member earns ${rule.pointsPer100Inr} point(s) for every ₹100 spent${rule.pointValuePaise > 0 ? `; one point is worth ₹${(rule.pointValuePaise / 100).toFixed(2)}` : '; the value of a point is not set yet'}.`
  : 'Loyalty is OFF: the owner has not set how many points ₹100 earns. No sale earns points until it is set in store setup.';

function keyOrRefuse(deps: LoyaltyMemberDeps): Buffer {
  if (deps.memberKey === undefined) {
    throw apiError(503, {
      code: 'loyalty_not_configured',
      whatHappened: 'This head office has no member key, so it cannot turn a phone number into a member code.',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Ask the administrator to configure the pack signing key. Nothing was changed.',
    });
  }
  return deps.memberKey;
}

function mobileOrRefuse(raw: unknown): string {
  const mobile = typeof raw === 'string' ? normaliseMobile(raw) : undefined;
  if (mobile === undefined) {
    throw apiError(400, {
      code: 'not_a_mobile_number',
      whatHappened: 'That is not a 10-digit Indian mobile number.',
      wasItSaved: 'not_saved',
      nextSafeAction: 'Key the customer\'s 10-digit mobile number (it may start with +91 or 0). Nothing was changed.',
    });
  }
  return mobile;
}

export function loyaltyMemberRoutes(deps: LoyaltyMemberDeps): readonly Route[] {
  return [
    {
      // The earn rule the owner has set — or that loyalty is off.
      api: 'API-06', method: 'GET', path: '/v1/loyalty/rule',
      permission: 'loyalty.points.read',
      handler: async (ctx) => {
        const rule = await deps.rule(ctx.tenantId);
        return { status: 200, body: { ...rule, on: rule.pointsPer100Inr > 0, detail: ruleDetail(rule) } };
      },
    },
    {
      // Enrol a member at the service desk: the number, the customer's yes, and how the number was checked.
      api: 'API-06', method: 'POST', path: '/v1/loyalty/members',
      permission: 'loyalty.member.enrol', idempotent: true,
      handler: async (ctx) => {
        const key = keyOrRefuse(deps);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const mobile = mobileOrRefuse(b['mobile']);
        if (b['consent'] !== true) {
          throw apiError(422, {
            code: 'consent_required',
            whatHappened: 'The customer has not said yes to joining loyalty, so they cannot be enrolled (M16-FR-02).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask the customer whether they agree to their number being used for loyalty; enrol only on a yes.',
          });
        }
        if (b['verifiedHow'] !== 'seen_on_phone') {
          throw apiError(422, {
            code: 'number_not_checked',
            whatHappened: 'The number has not been checked. Until SMS codes arrive (R4), the desk checks it on the customer\'s own phone.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Look at the number on the customer\'s phone, then enrol with verifiedHow "seen_on_phone".',
          });
        }
        const memberRef = memberRefFor(key, mobile)!;
        const history = await deps.memberHistory(ctx.tenantId, memberRef);
        const now = current(history);
        if (now?.status === 'member') {
          return { status: 200, body: { memberRef, mobileLast4: now.mobileLast4, alreadyMember: true } };
        }
        const record: MemberRecord = {
          memberRef, mobileLast4: mobile.slice(-4), status: 'member', consentGivenAt: deps.now(),
          enrolledBy: ctx.userId, verifiedHow: 'seen_on_phone',
        };
        await deps.recordMember(ctx.tenantId, record, `${memberRef}:joined:${history.length}`);
        return { status: 201, body: { memberRef, mobileLast4: record.mobileLast4, enrolled: true, rule: ruleDetail(await deps.rule(ctx.tenantId)) } };
      },
    },
    {
      // Find a member by the number the customer gives — the number travels in the body, never the URL.
      api: 'API-06', method: 'POST', path: '/v1/loyalty/members/lookup',
      permission: 'loyalty.points.read', idempotent: true,
      handler: async (ctx) => {
        const key = keyOrRefuse(deps);
        const mobile = mobileOrRefuse(((ctx.body ?? {}) as Record<string, unknown>)['mobile']);
        const memberRef = memberRefFor(key, mobile)!;
        const now = current(await deps.memberHistory(ctx.tenantId, memberRef));
        if (now?.status !== 'member') {
          return { status: 200, body: { member: false, detail: 'This number is not a loyalty member. They can join at the service desk.' } };
        }
        const balance = await deps.pointsBalance(ctx.tenantId, memberRef);
        return { status: 200, body: { member: true, memberRef, mobileLast4: now.mobileLast4, pointsBalance: balance ?? 0 } };
      },
    },
    {
      // A member leaves (withdraws consent): a new fact; from now on the code earns nothing.
      api: 'API-06', method: 'POST', path: '/v1/loyalty/members/:memberRef/leave',
      permission: 'loyalty.member.enrol', idempotent: true,
      handler: async (ctx) => {
        const memberRef = ctx.params['memberRef'] ?? '';
        if (!isMemberRef(memberRef)) throw notFound(`loyalty member ${memberRef}`);
        const history = await deps.memberHistory(ctx.tenantId, memberRef);
        const now = current(history);
        if (now === undefined) throw notFound(`loyalty member ${memberRef}`);
        if (now.status === 'left') return { status: 200, body: { memberRef, left: true, alreadyLeft: true } };
        const reason = (ctx.body as { reason?: unknown } | null)?.reason;
        const record: MemberRecord = {
          ...now, status: 'left', leftAt: deps.now(), leftBy: ctx.userId,
          leftReason: typeof reason === 'string' && reason.trim() !== '' ? reason : 'withdrew consent',
        };
        await deps.recordMember(ctx.tenantId, record, `${memberRef}:left:${history.length}`);
        return { status: 200, body: { memberRef, left: true } };
      },
    },
  ];
}
