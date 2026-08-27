// API-01 Joiner / mover / leaver access lifecycle (M02-FR-04 · SEC-11 · P-04 · §28) — the decision that
// keeps access tracking employment reality, tested since the module was written and on NO cloud route. The
// gap between what someone can do and what their job is, is where fraud lives, and two failures cause most
// of it — both closed here as rules, not reminders:
//
//   • THE MOVER WHO ACCUMULATES. Someone transfers from the Fresh counter to the cash office and keeps both;
//     six months on they can raise a stock adjustment AND settle the till it hides in. Nobody granted that
//     combination — it assembled itself. So a move REPLACES scope; the old roles/branches are removed in the
//     same act, and their sessions close so the new scope takes effect now.
//   • THE LEAVER WHO LINGERS. The account is disabled "later", the sessions stay open, and the items they
//     owned belong to nobody. So a leaver's OWNED OPEN ITEMS MUST BE REASSIGNED FIRST — a leaver whose work
//     has no new owner is not finished, it is abandoned — and the revocation is a PRIORITY sync item (§31).
//
// The rule is the tested `applyLifecycle` in `@sre/identity` (the services-run-on-their-tested-engine
// guardrail): **it decides, the caller applies.** This is the decision surface — it returns what the person
// should hold, what is removed, whether sessions close, and the blockers that must clear first. The
// authenticated caller is the APPROVER and can never be the person who requested the change (§28). A pure
// compute — nothing is written here; the role-grant change itself goes through the identity grant events.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  applyLifecycle, SelfServiceAccessError,
  type LifecycleEvent, type AccessGrant, type LifecycleRequest, type LifecycleApproval, type OwnedItem,
} from '../../../packages/identity/src/index';

const EVENTS: readonly LifecycleEvent[] = ['joiner', 'mover', 'leaver'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
/** 'all' or a list of branch ids. */
const readScope = (v: unknown): readonly string[] | 'all' | undefined =>
  v === 'all' ? 'all' : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

/** Validate one caller-supplied access grant, or return undefined. */
function readGrant(v: unknown): AccessGrant | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const g = v as Record<string, unknown>;
  const scope = readScope(g['branchScope']);
  if (!isStr(g['userId']) || !isStr(g['roleId']) || scope === undefined) return undefined;
  return { userId: g['userId'], roleId: g['roleId'], branchScope: scope };
}

function readGrants(v: unknown): readonly AccessGrant[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: AccessGrant[] = [];
  for (const raw of v) {
    const g = readGrant(raw);
    if (g === undefined) return undefined;
    out.push(g);
  }
  return out;
}

/** Validate the caller-supplied owned open items (checked for a leaver). */
function readOwnedItems(v: unknown): readonly OwnedItem[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: OwnedItem[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const i = raw as Record<string, unknown>;
    if (!isStr(i['itemId']) || !isStr(i['kind']) || typeof i['description'] !== 'string') return undefined;
    out.push({ itemId: i['itemId'], kind: i['kind'], description: i['description'] });
  }
  return out;
}

export interface AccessLifecycleDeps {
  readonly now: () => string;
}

export function accessLifecycleRoutes(deps: AccessLifecycleDeps): readonly Route[] {
  return [
    {
      // Decide a joiner / mover / leaver. Body: { event, userId, requestedBy, reason, currentGrants,
      // grants? (target, for joiner/mover), ownedOpenItems? (checked for a leaver) }. The AUTHENTICATED
      // CALLER is the approver (§28 — never the requester). Returns what the person holds afterwards, what
      // is removed, whether sessions close, whether it is a priority sync, and any blockers to clear first.
      api: 'API-01', method: 'POST', path: '/v1/access/lifecycle/:requestId',
      permission: 'identity.role.grant', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const grants = readGrants(b['grants']);
        const currentGrants = readGrants(b['currentGrants']);
        const ownedOpenItems = readOwnedItems(b['ownedOpenItems']);
        if (requestId === '' || !EVENTS.includes(b['event'] as LifecycleEvent) || !isStr(b['userId'])
          || !isStr(b['requestedBy']) || !isStr(b['reason'])
          || grants === undefined || currentGrants === undefined || ownedOpenItems === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_lifecycle_change',
            whatHappened: 'A lifecycle change needs a requestId in the path and { event (joiner/mover/leaver), userId, requestedBy, reason, currentGrants:[{userId,roleId,branchScope}], grants? (target for joiner/mover), ownedOpenItems? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'For a joiner or mover say the access they should hold AFTER; for a leaver, list any open items they own so they can be reassigned first.',
          });
        }
        const request: LifecycleRequest = {
          requestId, event: b['event'] as LifecycleEvent, userId: b['userId'] as string,
          requestedBy: b['requestedBy'] as string, reason: b['reason'] as string, at: deps.now(),
          ...(grants.length > 0 ? { grants } : {}),
        };
        // The caller approves in their own name; the engine refuses a self-approval (§28).
        const approval: LifecycleApproval = { subjectRef: requestId, status: 'approved', decidedBy: ctx.userId };
        try {
          return { status: 200, body: applyLifecycle({ request, currentGrants, approval, ownedOpenItems }) };
        } catch (e) {
          if (e instanceof SelfServiceAccessError) {
            throw apiError(422, {
              code: 'self_service_access_refused',
              whatHappened: 'The person who requested the access change cannot be the one who approves it (§28) — access changes need a second person.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Have someone other than the requester approve this change.',
            });
          }
          throw e;
        }
      },
    },
  ];
}
