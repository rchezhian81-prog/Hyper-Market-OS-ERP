// API-01 Approval DECISIONS register (M02-FR-03 · §28 · P-04 · hard rules #5/#6/#10 — SP-2a, audit finding F11).
//
// A store manager decides an approval on the manager's screen. Until this file the decision existed nowhere: the
// screen returned `ok`, and no register, ledger, queue or audit record changed (F11). Now the decision is written to
// the screen's durable device queue, handed to the store box, held on the box's fsync'd log and relayed HERE under
// the store's sync credential — and this is the register head office keeps of it.
//
// ── What this route trusts, and what it re-verifies ────────────────────────
//
// The FACT is trusted: a named person decided a named request at the store at a named time. That is what the
// synced sale, refund and day-close routes do too — a fact that happened at the store is recorded, never rejected
// into the void. The AUTHORITY is re-verified here, because only the cloud knows who holds what:
//
//   • self_approval             — the decider is the request's own maker (§28's one absolute rule)
//   • decider_unknown           — the named decider holds no grant in this tenant at all
//   • decider_lacks_authority   — the decider holds grants, none of which carries the permission the subject needs
//   • authority_unverified      — the subject type has no known permission to check against (recorded, not guessed)
//
// Every finding is a FLAG on the recorded decision, never a silent apply and never a silent drop (hard rule #10):
// the flagged register is the visible loss surface a person works. The relay's own identity (the box) is recorded
// beside the decider so the audit trail says both who decided and which box carried it (hard rule #4).
//
// ── Conflicts ──────────────────────────────────────────────────────────────
//
// One request, one decision. The same decision arriving again (a retry after a lost reply, from any hop) is 200 and
// recorded once. A DIFFERENT decision for a request already decided is 422 and nothing is saved — the box's sync
// agent dead-letters it by name so a person compares the two (F12's repair is what makes that visible).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { DecidedRequest, Decision } from '../../../packages/approvals/src/approvals';
import type { Money, CurrencyCode } from '../../../packages/contracts/src/money';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** The permission a decider must hold to decide each subject type — the §28 authority, looked up from grants. */
export const SUBJECT_AUTHORITY: Readonly<Record<string, string>> = Object.freeze({
  refund: 'pos.return.approve',
  price_change: 'price.change.approve',
  purchase_order: 'purchase.order.approve',
  stock_adjustment: 'inventory.movement.append',
  stock_count: 'inventory.movement.append',
  day_close_reopen: 'till.dayclose.approve',
  day_reopen: 'till.dayclose.approve',
  write_off: 'inventory.writeoff.threshold.set',
});

/** The flags this route can raise — a value, so a screen can have words for every one. */
export const DECISION_FLAGS = Object.freeze([
  'self_approval', 'decider_unknown', 'decider_lacks_authority', 'authority_unverified',
] as const);
export type DecisionFlag = (typeof DECISION_FLAGS)[number];

/** The decision as head office keeps it: the decided request, where it came from, and what re-verification found. */
export interface ApprovalDecisionRecord extends DecidedRequest {
  /** The store whose screen decided it, as the screen said; null when the relay did not name one. */
  readonly storeId: string | null;
  /** Which surface decided it, e.g. `manager-screen`. */
  readonly source: string;
  /** The identity that relayed it (the store box's sync credential) — the carrier, never the decider. */
  readonly relayedBy: string;
  readonly recordedAt: string;
  readonly governanceFlags: readonly DecisionFlag[];
}

export interface ApprovalDecisionDeps {
  /** The decision on file for a request, if any (folded latest per request id). */
  readonly decision: (tenantId: string, requestId: string) => Promise<ApprovalDecisionRecord | undefined> | ApprovalDecisionRecord | undefined;
  /** Every decision on file for the tenant, in record order. */
  readonly decisions: (tenantId: string) => Promise<readonly ApprovalDecisionRecord[]> | readonly ApprovalDecisionRecord[];
  readonly recordDecision: (tenantId: string, record: ApprovalDecisionRecord) => Promise<void> | void;
  /**
   * The permissions the named user holds through their grants in this tenant — `undefined` when they hold no
   * grant at all (an unknown name). From the grants and the role catalogue, never from the body.
   */
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** Seal the decision into the domain audit trail (M34-FR-01). Optional — a bare deps stub may omit it. */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const CURRENCIES: readonly CurrencyCode[] = ['INR', 'USD', 'EUR', 'GBP'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMoney = (v: unknown): v is Money =>
  isObj(v) && typeof v['minor'] === 'number' && Number.isInteger(v['minor']) && typeof v['currency'] === 'string' && (CURRENCIES as readonly string[]).includes(v['currency']);
const isDecision = (v: unknown): v is Decision => v === 'approved' || v === 'rejected';
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

/** The decided request as the store's screen minted it, plus where it was decided. Read strictly; never repaired. */
interface SyncedDecision extends DecidedRequest {
  readonly storeId: string | null;
  readonly source: string;
}

function readSyncedDecision(body: unknown): SyncedDecision | undefined {
  if (!isObj(body)) return undefined;
  if (!isStr(body['id']) || !isStr(body['subjectType']) || !isStr(body['subjectRef']) || !isStr(body['requestedBy'])) return undefined;
  if (!isDecision(body['status']) || !isStr(body['decidedBy']) || !isStr(body['reason']) || !isIso(body['decidedAt'])) return undefined;
  const branchId = body['branchId'];
  if (!(branchId === null || branchId === undefined || isStr(branchId))) return undefined;
  const value = body['value'];
  if (!(value === null || value === undefined || isMoney(value))) return undefined;
  return {
    id: body['id'], subjectType: body['subjectType'], subjectRef: body['subjectRef'], requestedBy: body['requestedBy'],
    branchId: isStr(branchId) ? branchId : null,
    value: isMoney(value) ? value : null,
    status: body['status'], decidedBy: body['decidedBy'], reason: body['reason'], decidedAt: body['decidedAt'],
    storeId: isStr(body['storeId']) ? body['storeId'] : null,
    source: isStr(body['source']) ? body['source'] : 'unknown',
  };
}

export function approvalDecisionRoutes(deps: ApprovalDecisionDeps): readonly Route[] {
  return [
    {
      // Record a decision made at the store. Relayed under the store's sync token (`approvals.decision.sync`, held
      // by the box's identity); re-verifies the DECIDER — never the relay — and record-and-flags (hard rule #10).
      // Idempotent per request: the same decision again is 200; a different one is 422 and nothing is saved.
      api: 'API-01', method: 'POST', path: '/v1/approvals/decisions/:id/synced',
      permission: 'approvals.decision.sync', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['id'] ?? '').trim();
        const d = readSyncedDecision(ctx.body);
        if (requestId === '' || d === undefined || d.id !== requestId) {
          throw apiError(400, {
            code: 'not_readable_as_a_synced_decision',
            whatHappened: 'This payload could not be read as a decided approval — it needs the decided request (id matching the path, subjectType, subjectRef, requestedBy, branchId|null, value|null, status approved|rejected, decidedBy, reason, decidedAt).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — a decision a manager made is still a decision.',
          });
        }

        const existing = await deps.decision(ctx.tenantId, requestId);
        if (existing !== undefined) {
          if (existing.status === d.status && existing.decidedBy === d.decidedBy) {
            // The same decision again — a retry after a lost reply, from whichever hop. One record (§31.1).
            return { status: 200, body: { requestId, recorded: true, alreadyRecorded: true, status: existing.status, decidedBy: existing.decidedBy, flags: existing.governanceFlags } };
          }
          // A DIFFERENT decision for a request already decided. Two cannot both stand; nothing is saved, and the
          // refusal is a permanent one the box dead-letters for a person to compare (hard rule #10).
          throw apiError(422, {
            code: 'decision_conflicts_with_record',
            whatHappened: `Request ${requestId} is already on file as ${existing.status} by ${existing.decidedBy} at ${existing.decidedAt}; this relay says ${d.status} by ${d.decidedBy}. Both cannot stand.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The first decision stands. Have a person compare the two; a change is a new request, never an overwrite.',
          });
        }

        // §28 re-verification — the control the screen could only partly apply (it checks maker ≠ checker, scope and
        // its own limit from what the pack told it; only the cloud knows who genuinely holds the authority). Every
        // finding is a FLAG on the recorded decision, not a rejection: the decision happened at the store.
        const flags: DecisionFlag[] = [];
        if (d.decidedBy === d.requestedBy) flags.push('self_approval');
        const permissions = await deps.permissionsOfUser(ctx.tenantId, d.decidedBy);
        const required = SUBJECT_AUTHORITY[d.subjectType];
        if (permissions === undefined) flags.push('decider_unknown');
        else if (required === undefined) flags.push('authority_unverified');
        else if (!permissions.includes(required)) flags.push('decider_lacks_authority');

        const record: ApprovalDecisionRecord = {
          ...d, relayedBy: ctx.userId, recordedAt: deps.now(), governanceFlags: flags,
        };
        await deps.recordDecision(ctx.tenantId, record);
        // Sealed into the audit trail attributed to the person who DECIDED (the relayed actor), with the carrier
        // named beside them — the "who approved this, from where" record an auditor comes looking for (§28, #5).
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: d.decidedBy, action: `approval.${d.status}`, objectType: 'approval_request', objectId: requestId,
          at: record.recordedAt, origin: { tenantId: ctx.tenantId, branchId: d.branchId },
          before: { status: 'pending' },
          after: {
            status: d.status, subjectType: d.subjectType, subjectRef: d.subjectRef, requestedBy: d.requestedBy,
            relayedBy: ctx.userId, source: d.source, storeId: d.storeId ?? '', flags: flags.join(','),
          },
          reason: d.reason, approvalId: requestId, correlationId: requestId,
        });
        // 202, not 201: the decision was made at the store and this records that it happened.
        return { status: 202, body: { requestId, recorded: true, status: d.status, decidedBy: d.decidedBy, flags } };
      },
    },
    {
      // The decisions register the owner and the auditor read — every relayed decision, and which carry a §28 flag
      // (control by exception, P-03). `?flagged=true` narrows to the ones a person must look at.
      api: 'API-01', method: 'GET', path: '/v1/approvals/decisions',
      permission: 'approvals.delegation.read',
      handler: async (ctx) => {
        const all = await deps.decisions(ctx.tenantId);
        const flaggedOnly = ctx.query['flagged'] === 'true';
        const subjectType = ctx.query['subjectType'];
        const rows = all
          .filter((r) => (!flaggedOnly || r.governanceFlags.length > 0) && (subjectType === undefined || r.subjectType === subjectType))
          .map((r) => ({
            requestId: r.id, subjectType: r.subjectType, subjectRef: r.subjectRef, requestedBy: r.requestedBy,
            branchId: r.branchId, value: r.value, status: r.status, decidedBy: r.decidedBy, reason: r.reason,
            decidedAt: r.decidedAt, storeId: r.storeId, source: r.source, relayedBy: r.relayedBy,
            recordedAt: r.recordedAt, flags: r.governanceFlags,
          }));
        return { status: 200, body: { decisions: rows, flagged: all.filter((r) => r.governanceFlags.length > 0).length } };
      },
    },
  ];
}
