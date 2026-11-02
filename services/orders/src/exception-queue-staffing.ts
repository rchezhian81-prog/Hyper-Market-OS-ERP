// API-07 — WHICH ROLES STAFF EACH DELIVERY-EXCEPTION QUEUE, as the OWNER sets and confirms it (OB-676 "A", owner, 2 Nov 2026,
// in writing · M19-FR-01 · Item 2 · P-03 · P-05 · P-08 · hard rules #2 #6).
//
//   GET  /v1/orders/exception-queue-staffing     every queue with the roles that staff it now, the starting suggestion, whether
//                                                the owner has confirmed it, and every queue nobody staffs ("unowned")
//   POST /v1/orders/exception-queue-staffing     the owner sets and confirms it { staffing: { <queue>: [roleId…] }, reason? }
//
// Before, who staffed which queue was a fixed map in code (`QUEUES_STAFFED_BY`, exception-ownership.ts) that nobody had
// approved. Now:
//   • **that map is offered as the starting suggestion** — and is what the queues run on until the owner confirms (the
//     existing behaviour stays, said "not confirmed");
//   • **the owner sets the roles per queue** — every queue named, each with the roles that work it; a role must be one that
//     may work exceptions at all (`order.exception.work`) — an outside party's login or a machine never staffs a queue;
//   • **a queue with no role is UNOWNED** — kept, shown on the Delivery exceptions page as unowned, its items still listed
//     and still escalating to the duty manager's queue, never silently dropped (P-08);
//   • **a confirmation is audited and a change is a new version** — the latest version is in force; every earlier one kept.
//
// Gated `order.exception.staffing.set` — the owner's own decision.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { ExceptionOwnerRole } from '../../../packages/orders/src/substitution-exception-ownership';

export type QueueStaffing = Readonly<Record<ExceptionOwnerRole, readonly string[]>>;

/** One version the owner confirmed, as kept (append-only). */
export interface QueueStaffingVersion {
  readonly version: number;
  readonly staffing: QueueStaffing;
  /** True when he confirmed the starting suggestion exactly as offered. */
  readonly asSuggested: boolean;
  readonly reason: string | null;
  readonly by: string;
  readonly at: string;
}

export interface QueueStaffingStanding {
  readonly state: 'confirmed' | 'not_confirmed';
  /** What the queues run on now: the owner's latest version, else the starting suggestion. */
  readonly staffing: QueueStaffing;
  readonly suggested: QueueStaffing;
  readonly confirmed: { readonly version: number; readonly by: string; readonly at: string } | null;
  /** Queues no role staffs — shown as unowned, never dropped. */
  readonly unowned: readonly ExceptionOwnerRole[];
  readonly history: readonly QueueStaffingVersion[];
}

/** The queues, in the order the screens list them. */
export const STAFFED_QUEUES: readonly ExceptionOwnerRole[] = ['fulfilment_supervisor', 'customer_service_desk', 'finance_recon_queue', 'duty_manager'];

const sortedUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** Turn a role → queues map (the code's old shape) into queue → roles, keeping only roles that may work exceptions. Pure. */
export function staffingFromRoleMap(byRole: Readonly<Record<string, readonly ExceptionOwnerRole[]>>, mayWork: readonly string[]): QueueStaffing {
  const out = Object.fromEntries(STAFFED_QUEUES.map((q) => [q, [] as string[]])) as Record<ExceptionOwnerRole, string[]>;
  for (const [role, queues] of Object.entries(byRole)) {
    if (!mayWork.includes(role)) continue;
    for (const q of queues) out[q].push(role);
  }
  return Object.fromEntries(STAFFED_QUEUES.map((q) => [q, sortedUnique(out[q])])) as unknown as QueueStaffing;
}

/** Where the staffing stands — pure. */
export function queueStaffingStanding(suggested: QueueStaffing, history: readonly QueueStaffingVersion[]): QueueStaffingStanding {
  const last = history.at(-1);
  const staffing = last?.staffing ?? suggested;
  return {
    state: last === undefined ? 'not_confirmed' : 'confirmed',
    staffing, suggested,
    confirmed: last === undefined ? null : { version: last.version, by: last.by, at: last.at },
    unowned: STAFFED_QUEUES.filter((q) => (staffing[q] ?? []).length === 0),
    history,
  };
}

/** The queues a caller's roles staff under a staffing — in the screens' order. Pure. */
export function queuesStaffedUnder(staffing: QueueStaffing, roleIds: readonly string[]): readonly ExceptionOwnerRole[] {
  return STAFFED_QUEUES.filter((q) => (staffing[q] ?? []).some((r) => roleIds.includes(r)));
}

export interface QueueStaffingDeps {
  /** The starting suggestion — the map the code ran on before OB-676. */
  readonly suggested: QueueStaffing;
  /** The roles that may work exceptions at all (hold `order.exception.work`) — the only ones a queue may name. */
  readonly rolesThatMayWork: readonly string[];
  /** Every version the owner confirmed, oldest first. */
  readonly versions: (tenantId: string) => Promise<readonly QueueStaffingVersion[]>;
  /** Keep a version — keyed on its number, so a replay lands once and a second writer of the same number is refused. */
  readonly recordVersion: (tenantId: string, v: QueueStaffingVersion) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const sameStaffing = (a: QueueStaffing, b: QueueStaffing): boolean => STAFFED_QUEUES.every((q) => JSON.stringify(sortedUnique(a[q] ?? [])) === JSON.stringify(sortedUnique(b[q] ?? [])));

/** Read the owner's body, or name what is wrong. Every queue must be named (an empty list is "unowned", on purpose). */
export function readStaffing(body: unknown, mayWork: readonly string[]): { staffing: QueueStaffing } | { problems: string[] } {
  const b = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)['staffing'] : undefined;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return { problems: ['send { staffing: { <queue>: [role ids] } } naming every queue'] };
  const raw = b as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(raw)) if (!(STAFFED_QUEUES as readonly string[]).includes(k)) problems.push(`"${k}" is not an exception queue (the queues are ${STAFFED_QUEUES.join(', ')})`);
  const out: Record<string, string[]> = {};
  for (const q of STAFFED_QUEUES) {
    const v = raw[q];
    if (!Array.isArray(v) || !v.every((r) => typeof r === 'string' && r.trim() !== '')) { problems.push(`${q} needs a list of role ids (an empty list leaves it unowned)`); continue; }
    const roles = sortedUnique(v.map((r) => (r as string).trim()));
    for (const r of roles) if (!mayWork.includes(r)) problems.push(`${q}: "${r}" is not a role that may work delivery exceptions`);
    out[q] = roles;
  }
  return problems.length > 0 ? { problems } : { staffing: out as unknown as QueueStaffing };
}

export function queueStaffingRoutes(deps: QueueStaffingDeps): readonly Route[] {
  const standing = async (tenantId: string): Promise<QueueStaffingStanding> => queueStaffingStanding(deps.suggested, await deps.versions(tenantId));
  return [
    {
      api: 'API-07', method: 'GET', path: '/v1/orders/exception-queue-staffing',
      permission: 'order.read',
      handler: async (ctx) => ({ status: 200, body: { ...(await standing(ctx.tenantId)), rolesThatMayWork: deps.rolesThatMayWork, asAt: deps.now() } }),
    },
    {
      api: 'API-07', method: 'POST', path: '/v1/orders/exception-queue-staffing',
      permission: 'order.exception.staffing.set', idempotent: true,
      handler: async (ctx) => {
        const read = readStaffing(ctx.body, deps.rolesThatMayWork);
        if ('problems' in read) {
          throw apiError(400, {
            code: 'not_readable_as_queue_staffing',
            whatHappened: `The roles for each delivery-exception queue could not be read: ${read.problems.join('; ')}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Name the roles for every queue (an empty list leaves a queue unowned). Nothing was changed.',
          });
        }
        const b = ctx.body as Record<string, unknown>;
        if (b['reason'] !== undefined && b['reason'] !== null && typeof b['reason'] !== 'string') {
          throw apiError(400, { code: 'not_readable_as_queue_staffing', whatHappened: 'reason, when sent, is words.', wasItSaved: 'not_saved', nextSafeAction: 'Send the note as words. Nothing was changed.' });
        }
        const before = await standing(ctx.tenantId);
        if (before.state === 'confirmed' && sameStaffing(before.staffing, read.staffing)) {
          return { status: 200, body: { ...before, alreadyConfirmed: true, rolesThatMayWork: deps.rolesThatMayWork, asAt: deps.now() } };
        }
        const at = deps.now();
        const reason = typeof b['reason'] === 'string' && b['reason'].trim() !== '' ? b['reason'].trim() : null;
        const v: QueueStaffingVersion = { version: before.history.length + 1, staffing: read.staffing, asSuggested: sameStaffing(read.staffing, deps.suggested), reason, by: ctx.userId, at };
        await deps.recordVersion(ctx.tenantId, v);
        const words = (s: QueueStaffing): Record<string, string> => Object.fromEntries(STAFFED_QUEUES.map((q) => [q, (s[q] ?? []).join(',') || '(unowned)']));
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'order.exception_queue_staffing.confirm', objectType: 'exception_queue_staffing', objectId: 'delivery-exception-queues',
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { ...words(before.staffing), state: before.state }, after: { ...words(v.staffing), state: 'confirmed', version: String(v.version), asSuggested: String(v.asSuggested) },
          ...(reason === null ? {} : { reason }), correlationId: 'exception-queue-staffing',
        });
        return { status: before.history.length === 0 ? 201 : 200, body: { ...(await standing(ctx.tenantId)), alreadyConfirmed: false, rolesThatMayWork: deps.rolesThatMayWork, asAt: deps.now() } };
      },
    },
  ];
}
