// HEAD OFFICE'S MAKER-CHECKER ENGINE (ADR-0024 · Wave 2b-vi · audit PA-03 · M02-FR-03 · §28 · hard rules #2, #5, #10).
//
// M02-FR-03: "Maker submits an action needing approval → engine routes to the authorized checker → checker approves /
// rejects with reason → action commits or is discarded → evidence recorded … A maker can never approve their own request;
// changing the amount of a pending request invalidates its approval." Head office never had the engine, so each module
// grew its own box where the person doing the work TYPED the approver's name — and the audit's triage found 26 routes
// that took that name as the approver's act. This is the engine they move onto:
//
//   1. the MAKER asks, in their own session (`POST /v1/approvals/requests`): what kind of action, on what, for how much,
//      a plain-words summary and why — and the exact details, which the engine FINGERPRINTS;
//   2. a CHECKER — anyone else who holds that kind's approval permission, never the maker — sees it in their inbox
//      (`GET /v1/approvals/requests`) and approves or rejects it with a reason, in THEIR own session
//      (`POST /v1/approvals/requests/:requestId/decide`);
//   3. the maker then does the action naming the approved request (`approvalId`); the action's route checks that it is
//      the same kind, the same subject, the same details (fingerprint), the same amount and the same maker; that it was
//      approved and has not expired; that the checker still holds the permission; and that it has not been used — then
//      spends it under its own guard, once, BEFORE the action is written: never an action without an approval, never
//      two actions with one. If the action then fails, nothing changed and the maker asks again.
//
// Escalation, delegation and value-limit routing (the rest of M02-FR-03) are not in this slice — recorded as not yet.

import { createHash, randomUUID } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, concurrentChange } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';

/** One kind of action that needs a second person: who may ask, who may approve, how long an approval lasts. */
export interface ApprovalKind {
  readonly kind: string;
  /** What the action is, in the owner's words — shown in the inbox. */
  readonly label: string;
  /** The maker must hold this (the permission of the action itself). */
  readonly makerPermission: string;
  /** The checker must hold this, and must not be the maker. */
  readonly checkerPermission: string;
  /** How long an approval may wait to be used. */
  readonly validForMinutes: number;
}

/** The kinds the engine knows. Each slice that moves a route onto the engine adds its kind here. */
export const APPROVAL_KINDS: Readonly<Record<string, ApprovalKind>> = Object.freeze({
  supplier_bank_change: {
    kind: 'supplier_bank_change', label: 'Change where a supplier is paid',
    makerPermission: 'purchase.supplier.bank', checkerPermission: 'purchase.supplier.approve', validForMinutes: 24 * 60,
  },
  // The checker is ANOTHER person already authorised to import (owner, store manager) — each checks the other's work. A
  // dedicated "approve imports" authority would be new role policy, which is the owner's to set, not the engine's.
  data_import_commit: {
    kind: 'data_import_commit', label: 'Apply a bulk import',
    makerPermission: 'purchase.import.record', checkerPermission: 'purchase.import.record', validForMinutes: 24 * 60,
  },
  // Pricing (2b-vi-b · M05-FR-02/04 · M12-FR-02): a loss-making price, list entry, promotion or quotation is approved by
  // someone holding the pricing-approval authority (`price.change.approve`) — "above the setter's authority".
  price_change: {
    kind: 'price_change', label: 'Set a price below cost or below the margin floor',
    makerPermission: 'price.change.propose', checkerPermission: 'price.change.approve', validForMinutes: 24 * 60,
  },
  price_list_entry: {
    kind: 'price_list_entry', label: 'Add a price-list entry below cost or below the margin floor',
    makerPermission: 'price.change.propose', checkerPermission: 'price.change.approve', validForMinutes: 24 * 60,
  },
  promotion_launch: {
    kind: 'promotion_launch', label: 'Launch a promotion that loses margin',
    makerPermission: 'promotion.launch', checkerPermission: 'price.change.approve', validForMinutes: 24 * 60,
  },
  quotation_below_floor: {
    kind: 'quotation_below_floor', label: 'Quote a customer below the margin floor',
    makerPermission: 'pos.quotation.write', checkerPermission: 'price.change.approve', validForMinutes: 24 * 60,
  },
});

/** A maker's request, as recorded. */
export interface ApprovalRequest {
  readonly requestId: string;
  readonly kind: string;
  readonly subjectRef: string;
  /** The amount it is for, in paise; null when the action moves no money. Changing it voids the approval. */
  readonly valueMinor: number | null;
  /** SHA-256 over the exact details the maker asked for. Changing any detail voids the approval. */
  readonly fingerprint: string;
  /** The details as asked — shown to the checker, so they approve what will actually happen. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
}

/** A checker's decision on a request. */
export interface ApprovalDecision {
  readonly requestId: string;
  readonly decision: 'approved' | 'rejected';
  readonly decidedBy: string;
  readonly reason: string;
  readonly decidedAt: string;
  /** Approved only: after this it can no longer be used. */
  readonly expiresAt: string | null;
}

/** A request, its decision once made, and the action that used it once it has been. */
export interface ApprovalState {
  readonly request: ApprovalRequest;
  readonly decision?: ApprovalDecision;
  readonly usedBy?: string;
}

export interface ApprovalRequestDeps {
  readonly recordRequest: (tenantId: string, request: ApprovalRequest) => Promise<void> | void;
  /** Append a decision under the request's own guard, read before the decision was judged (`expectedVersion`), and
   *  resolve the decision that STANDS — another checker's, when theirs landed first at the same moment. */
  readonly recordDecision: (tenantId: string, decision: ApprovalDecision, expectedVersion: number) => Promise<ApprovalDecision | void> | ApprovalDecision | void;
  readonly approvalState: (tenantId: string, requestId: string) => Promise<ApprovalState | undefined> | ApprovalState | undefined;
  readonly approvalVersion: (tenantId: string, requestId: string) => Promise<number> | number;
  readonly allRequests: (tenantId: string) => Promise<readonly ApprovalState[]> | readonly ApprovalState[];
  /** The permissions a person holds; `undefined` when head office does not know them. */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A stable text for any JSON value: object keys sorted, so the same details always fingerprint the same. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** The fingerprint of an action's exact details — the maker's request and the action's route compute it the same way. */
export function fingerprintOf(details: unknown): string {
  return createHash('sha256').update(canonical(details), 'utf8').digest('hex');
}

const notPermitted = (what: string): Error => apiError(403, {
  code: 'not_permitted_for_this_approval',
  whatHappened: what,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Nothing was recorded. Someone who holds that authority must do it.',
});

export function approvalRequestRoutes(deps: ApprovalRequestDeps): readonly Route[] {
  const holds = async (tenantId: string, userId: string, permission: string): Promise<boolean> =>
    ((await deps.permissionsOfUser(tenantId, userId)) ?? []).includes(permission);

  return [
    {
      // The maker asks, in their own session. Gated per kind on the action's own permission (checked below); the route
      // itself needs only a signed-in member of the shop.
      api: 'API-01', method: 'POST', path: '/v1/approvals/requests',
      permission: 'identity.self.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        const spec = isStr(b['kind']) ? APPROVAL_KINDS[b['kind'].trim()] : undefined;
        const valueMinor = b['valueMinor'] === undefined || b['valueMinor'] === null ? null
          : (typeof b['valueMinor'] === 'number' && Number.isSafeInteger(b['valueMinor']) && b['valueMinor'] >= 0 ? b['valueMinor'] : undefined);
        const details = b['details'] !== null && typeof b['details'] === 'object' && !Array.isArray(b['details']) ? b['details'] as Record<string, unknown> : undefined;
        if (spec === undefined || !isStr(b['subjectRef']) || valueMinor === undefined || details === undefined || !isStr(b['summary']) || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_approval_request',
            whatHappened: `An approval request names a known kind (${Object.keys(APPROVAL_KINDS).join(', ')}), what it is about (subjectRef), the exact details of the action, a plain-words summary and why; an amount in whole paise when it moves money.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was asked. Send those.',
          });
        }
        if (!(await holds(ctx.tenantId, ctx.userId, spec.makerPermission))) {
          throw notPermitted(`${ctx.userId} may not ${spec.label.toLowerCase()}, so cannot ask for it to be approved.`);
        }
        const request: ApprovalRequest = {
          requestId: `areq-${randomUUID()}`, kind: spec.kind, subjectRef: b['subjectRef'].trim(), valueMinor,
          fingerprint: fingerprintOf(details), details, summary: b['summary'].trim().slice(0, 300), reason: b['reason'].trim().slice(0, 300),
          requestedBy: ctx.userId, requestedAt: deps.now(),
        };
        await deps.recordRequest(ctx.tenantId, request);
        return { status: 201, body: { ...request, status: 'waiting' } };
      },
    },
    {
      // The inbox: what waits for the caller to decide (kinds they may approve, never their own), and what they asked.
      api: 'API-01', method: 'GET', path: '/v1/approvals/requests',
      permission: 'identity.self.read',
      handler: async (ctx) => {
        const held = (await deps.permissionsOfUser(ctx.tenantId, ctx.userId)) ?? [];
        const now = Date.parse(deps.now());
        const all = await deps.allRequests(ctx.tenantId);
        const view = (s: ApprovalState) => ({
          ...s.request, status: statusOf(s, now),
          ...(s.decision === undefined ? {} : { decidedBy: s.decision.decidedBy, decisionReason: s.decision.reason, decidedAt: s.decision.decidedAt, expiresAt: s.decision.expiresAt }),
          ...(s.usedBy === undefined ? {} : { usedBy: s.usedBy }),
          label: APPROVAL_KINDS[s.request.kind]?.label ?? s.request.kind,
        });
        const waitingForMe = all.filter((s) => s.decision === undefined && s.request.requestedBy !== ctx.userId
          && held.includes(APPROVAL_KINDS[s.request.kind]?.checkerPermission ?? '\u0000')).map(view);
        const mine = all.filter((s) => s.request.requestedBy === ctx.userId).map(view);
        return { status: 200, body: { waitingForMe, mine, asAt: deps.now() } };
      },
    },
    {
      // The checker decides, in their own session — never the maker (§28), always with a reason (M02-FR-03).
      api: 'API-01', method: 'POST', path: '/v1/approvals/requests/:requestId/decide',
      permission: 'identity.self.read', idempotent: true,
      handler: async (ctx) => {
        const requestId = ctx.params['requestId'] ?? '';
        const b = (ctx.body !== null && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>;
        const decision = b['decision'] === 'approved' || b['decision'] === 'rejected' ? b['decision'] : undefined;
        if (decision === undefined || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_decision', whatHappened: 'A decision is "approved" or "rejected", with a reason (M02-FR-03).',
            wasItSaved: 'not_saved', nextSafeAction: 'Nothing was decided. Send the decision and why.',
          });
        }
        // The request's guard first, then the request it protects — so two checkers deciding at once cannot both win.
        const version = await Promise.resolve(deps.approvalVersion(ctx.tenantId, requestId));
        const state = await Promise.resolve(deps.approvalState(ctx.tenantId, requestId));
        if (state === undefined) {
          throw apiError(404, { code: 'not_found', whatHappened: `There is no approval request ${requestId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the request in your inbox.' });
        }
        const spec = APPROVAL_KINDS[state.request.kind];
        if (spec === undefined || !(await holds(ctx.tenantId, ctx.userId, spec.checkerPermission))) {
          throw notPermitted(`${ctx.userId} may not approve "${spec?.label ?? state.request.kind}".`);
        }
        if (state.request.requestedBy === ctx.userId) {
          throw apiError(422, {
            code: 'self_approval', whatHappened: `${ctx.userId} asked for this and cannot also decide it (§28).`,
            wasItSaved: 'not_saved', nextSafeAction: 'A different person who holds the authority must decide it.',
          });
        }
        if (state.decision !== undefined) {
          if (state.decision.decidedBy === ctx.userId && state.decision.decision === decision) {
            return { status: 200, body: { ...state.decision, alreadyDecided: true } }; // the same decision, resent
          }
          throw apiError(409, {
            code: 'already_decided', whatHappened: `This request was already ${state.decision.decision} by ${state.decision.decidedBy}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'A decision is final. A change is a new request.',
          });
        }
        const decidedAt = deps.now();
        const record: ApprovalDecision = {
          requestId, decision, decidedBy: ctx.userId, reason: b['reason'].trim().slice(0, 300), decidedAt,
          expiresAt: decision === 'approved' ? new Date(Date.parse(decidedAt) + spec.validForMinutes * 60_000).toISOString() : null,
        };
        let stands: ApprovalDecision | void;
        try {
          stands = await deps.recordDecision(ctx.tenantId, record, version);
        } catch (err) {
          if (err instanceof ConcurrencyConflictError) throw concurrentChange(`approval request ${requestId}`);
          throw err;
        }
        // Two checkers at the same moment: one decision stands, and the other is TOLD — never a 201 for a decision
        // that was not recorded (hard rule #10).
        if (stands !== undefined && (stands.decidedBy !== record.decidedBy || stands.decision !== record.decision)) {
          throw apiError(409, {
            code: 'already_decided', whatHappened: `This request was ${stands.decision} by ${stands.decidedBy} at the same moment; your decision was not recorded.`,
            wasItSaved: 'not_saved', nextSafeAction: 'A decision is final. A change is a new request.',
          });
        }
        return { status: 201, body: stands ?? record };
      },
    },
  ];
}

/** Where a request stands. */
export function statusOf(s: ApprovalState, nowMs: number): 'waiting' | 'approved' | 'rejected' | 'expired' | 'used' {
  if (s.usedBy !== undefined) return 'used';
  if (s.decision === undefined) return 'waiting';
  if (s.decision.decision === 'rejected') return 'rejected';
  return s.decision.expiresAt !== null && Date.parse(s.decision.expiresAt) <= nowMs ? 'expired' : 'approved';
}

/**
 * May this action use this approved request? Same kind, same subject, same details (fingerprint), same amount, same
 * maker; approved and not expired; never used; and the checker still holds the permission. ONE use, strictly: a lost
 * reply is answered by its own idempotency key before this runs, and an action that failed after spending asks again. Resolves the decision, or throws the refusal in plain words (nothing has changed).
 */
export async function takeApproval(input: {
  readonly state: ApprovalState | undefined;
  readonly kind: string;
  readonly subjectRef: string;
  readonly details: unknown;
  readonly valueMinor: number | null;
  readonly maker: string;
  readonly usedBy: string;
  readonly now: string;
  readonly checkerHolds: (userId: string, permission: string) => Promise<boolean> | boolean;
}): Promise<ApprovalDecision> {
  const refuse = (code: string, whatHappened: string): never => {
    throw apiError(422, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. Ask for approval of exactly this, and have a different person with the authority approve it.' });
  };
  const s = input.state;
  if (s === undefined) return refuse('approval_unknown', 'Head office has no such approval request.');
  const r = s.request;
  if (s.usedBy !== undefined) return refuse('approval_already_used', `That approval was already used (${s.usedBy}); one approval allows one action.`);
  if (r.kind !== input.kind || r.subjectRef !== input.subjectRef || r.requestedBy !== input.maker
    || r.valueMinor !== input.valueMinor || r.fingerprint !== fingerprintOf(input.details)) {
    return refuse('approval_does_not_match', `That approval is for "${r.summary}", asked by ${r.requestedBy} — not exactly this. A change to the details or the amount needs a new approval.`);
  }
  if (s.decision === undefined) return refuse('approval_still_waiting', 'That request has not been decided yet.');
  if (s.decision.decision === 'rejected') return refuse('approval_rejected', `That request was rejected by ${s.decision.decidedBy}: ${s.decision.reason}`);
  if (s.decision.expiresAt !== null && Date.parse(s.decision.expiresAt) <= Date.parse(input.now)) {
    return refuse('approval_expired', `That approval expired at ${s.decision.expiresAt}.`);
  }
  const spec = APPROVAL_KINDS[r.kind];
  if (spec === undefined || !(await input.checkerHolds(s.decision.decidedBy, spec.checkerPermission))) {
    return refuse('checker_may_not_approve', `${s.decision.decidedBy} no longer holds the authority to approve this, so their approval does not count.`);
  }
  return s.decision;
}

/** Refused: the request names a second person with no approval behind it. */
export function namedSecondPersonRefusal(field: string, named: string): Error {
  return apiError(422, {
    code: 'approver_named_without_approval',
    whatHappened: `This names ${named} as ${field}, but naming a person is not their approval: they never approved it.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Ask for approval (POST /v1/approvals/requests); once a different person with the authority approves it, send the approvalId. Nothing was changed.',
  });
}

/** What an action's route needs of the engine to use an approval. */
export interface ApprovalPort {
  readonly approvalState: (tenantId: string, requestId: string) => Promise<ApprovalState | undefined> | ApprovalState | undefined;
  readonly approvalVersion: (tenantId: string, requestId: string) => Promise<number> | number;
  /** Record the one use; resolves `false` when another action's use landed first (even the same action sent twice). */
  readonly spendApproval: (tenantId: string, requestId: string, usedBy: string, expectedVersion: number) => Promise<boolean | void> | boolean | void;
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
}

/** No engine wired (a bare stub): every approval is unknown, so nothing is approved by accident. */
export const NO_APPROVALS: ApprovalPort = Object.freeze({
  approvalState: () => undefined, approvalVersion: () => 0, spendApproval: () => {}, permissionsOfUser: () => undefined,
});

/** Fields that are never part of the action itself: the approval's id, and the typed second-person fields it replaced. */
const CONTROL_FIELDS: ReadonlySet<string> = new Set(['approvalId', 'approval', 'approvedBy', 'rationale']);

/**
 * What a maker asks approval FOR: the action's own body without its control fields, plus the route's path ids. The
 * rule every client follows is the same — ask with exactly the body you will send (and the ids in its address).
 */
export function actionDetails(body: unknown, pathIds: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  const b = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (!CONTROL_FIELDS.has(k)) out[k] = v;
  return { ...out, ...pathIds };
}

/**
 * The common shape of an action that may need a second person: a typed name with no `approvalId` is refused by name;
 * no approval at all resolves `undefined` (the action's own rules then decide whether it needed one); an `approvalId`
 * is opened against exactly these details (`openApproval`).
 */
export async function approvalNamedIn(port: ApprovalPort | undefined, input: {
  readonly tenantId: string;
  readonly approvalId: unknown;
  /** The legacy typed second-person field and what it carried — refused by name when there is no approval. */
  readonly typedField: string;
  readonly typedValue: unknown;
  readonly kind: string;
  readonly subjectRef: string;
  readonly details: unknown;
  readonly valueMinor: number | null;
  readonly maker: string;
  readonly usedBy: string;
  readonly now: string;
}): Promise<{ readonly decision: ApprovalDecision; spend(): Promise<void> } | undefined> {
  if (!isStr(input.approvalId)) {
    if (isStr(input.typedValue)) throw namedSecondPersonRefusal(input.typedField, input.typedValue);
    return undefined;
  }
  return openApproval(port ?? NO_APPROVALS, {
    tenantId: input.tenantId, approvalId: input.approvalId.trim(), kind: input.kind, subjectRef: input.subjectRef,
    details: input.details, valueMinor: input.valueMinor, maker: input.maker, usedBy: input.usedBy, now: input.now,
  });
}

/**
 * Open an approval for one action: read the request's guard FIRST, then judge the approval (`takeApproval`). Resolves
 * the decision — so the route can run its own rules that need the checker (e.g. "not the supplier's creator") — and
 * `spend()`, which the route calls after every rule has passed and BEFORE the action is written. Two actions racing on
 * one approval: the second's spend is refused by name (409, nothing changed).
 */
export async function openApproval(port: ApprovalPort, input: {
  readonly tenantId: string;
  readonly approvalId: string;
  readonly kind: string;
  readonly subjectRef: string;
  readonly details: unknown;
  readonly valueMinor: number | null;
  readonly maker: string;
  readonly usedBy: string;
  readonly now: string;
}): Promise<{ readonly decision: ApprovalDecision; spend(): Promise<void> }> {
  const version = await Promise.resolve(port.approvalVersion(input.tenantId, input.approvalId));
  const state = await Promise.resolve(port.approvalState(input.tenantId, input.approvalId));
  const decision = await takeApproval({
    ...input, state,
    checkerHolds: async (userId, permission) => ((await port.permissionsOfUser(input.tenantId, userId)) ?? []).includes(permission),
  });
  return {
    decision,
    spend: async () => {
      let landed: boolean | void;
      try {
        landed = await port.spendApproval(input.tenantId, input.approvalId, input.usedBy, version);
      } catch (err) {
        if (err instanceof ConcurrencyConflictError) throw concurrentChange(`approval ${input.approvalId}`);
        throw err;
      }
      // Two actions at the same moment — even the same one sent twice: the one whose use landed proceeds; this one is
      // refused by name and changes nothing.
      if (landed === false) {
        throw apiError(409, {
          code: 'approval_already_used', whatHappened: `Approval ${input.approvalId} was used by another request at the same moment; one approval allows one action.`,
          wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. Ask for a new approval if this is a separate action.',
        });
      }
    },
  };
}
