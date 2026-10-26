// Tenant closure — governed, approved, access revoked, the law's records and the audit kept (M36-FR-03 · D12-FR-05 ·
// R8-2 · §28 · §35 · P-04 · P-06 · hard rules #2 and #6).
//
// M36-FR-03: "on closure, access revoked, legally-required records retained"; "closure is governed/approved"; "never
// delete audit evidence". The rules are the tested `closeTenant` engine (packages/platform/src/lifecycle.ts); this file
// is the HTTP and persistence skin:
//   • READINESS (a read): whether a complete export has been taken, and what would be RETAINED on closure and until when
//     — the books and tax records for the longest statute that binds them (the owner-approved statutory constants:
//     GST 72 months, income tax 6 years, Companies Act 8 years), every live legal hold, and the audit evidence always.
//   • THE EXPORT IS RECORDED. Every export a person takes is recorded (manifest only — who, when, complete or not); the
//     closure needs the latest one to be COMPLETE. Closing without the shop's own data in its hands is refused.
//   • CLOSE: asked by the IT administrator (`platform.tenant.close`) with a reason, approved by the OWNER
//     (`platform.tenant.close.approve`, approvals kind `tenant_closure`), never the asker. On closure EVERY role grant
//     is revoked in the same atomic write as the closure record — so access ends on the next request, through the one
//     fold every authority check reads — and nothing is deleted: the records the law wants and the audit trail stay.
//   • A closed shop cannot be re-opened by the genesis path (it refuses a shop that has ever granted a role).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { actionDetails, openApproval, type ApprovalPort } from '../../identity/src/approval-requests';
import { closeTenant, type ClosureResult, type RetentionObligation, type TenantExport, type TenantLifecycleState } from '../../../packages/platform/src/lifecycle';
import { statutoryRetentionDecision } from '../../../packages/audit/src/statutory-retention';
import { shopToday, type ShopCalendarOf, shopDateIn } from '../../../packages/calendar/src/shop-clock';

export const TENANT_CLOSURE_APPROVAL = 'tenant_closure';

/**
 * OB-367 (owner, 24–25 Oct 2026, in writing): on closure EVERYTHING is sealed, with access removed, until the CA or the
 * lawyer writes a closure retention schedule — nothing is deleted, not even after the statutory minimums pass. Until that
 * schedule is written it reads "not set". Said on the readiness read (the closure screen) and on the closure itself.
 */
export const CLOSURE_SEAL = Object.freeze({
  everythingSealed: true as const,
  nothingDeleted: true as const,
  retentionSchedule: Object.freeze({ state: 'not_set' as const, words: 'not set', writtenBy: 'the CA or the lawyer' }),
  en: 'On closure everything is sealed and nobody can open it. It stays sealed until the CA or the lawyer writes a closure retention schedule — nothing is deleted, not even after the dates the law asks for. Closure retention schedule: not set.',
  ta: 'கணக்கு மூடப்படும்போது எல்லாமே முத்திரையிடப்படும்; யாராலும் திறக்க முடியாது. பட்டயக் கணக்காளர் அல்லது வழக்கறிஞர் மூடல் தக்கவைப்பு அட்டவணையை எழுதும் வரை அது முத்திரையிலேயே இருக்கும் — சட்டம் கேட்கும் தேதிகள் கடந்த பின்பும் எதுவும் நீக்கப்படாது. மூடல் தக்கவைப்பு அட்டவணை: அமைக்கப்படவில்லை.',
});

/** The manifest of an export a person took (no data — the data went to them). */
export interface ExportTaken {
  readonly exportId: string;
  readonly complete: boolean;
  readonly outcome: TenantExport['outcome'];
  readonly totalRows: number;
  readonly missing: readonly string[];
  readonly requestedBy: string;
  readonly at: string;
}

export interface TenantClosedRecord {
  readonly closureId: string;
  readonly reason: string;
  readonly askedBy: string;
  readonly approvedBy: string;
  readonly approvalId: string;
  readonly at: string;
  readonly exportId: string;
  readonly retained: ClosureResult['retained'];
  readonly grantsRevoked: number;
}

export interface TenantLifecycleDeps {
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  readonly exports: (tenantId: string) => Promise<readonly ExportTaken[]>;
  readonly closure: (tenantId: string) => Promise<TenantClosedRecord | undefined>;
  /** The date of the newest business record the shop holds (YYYY-MM-DD), or undefined when it holds none. */
  readonly lastBusinessRecordOn: (tenantId: string) => Promise<string | undefined>;
  /** Legal holds still in force. */
  readonly liveHolds: (tenantId: string) => Promise<readonly { readonly holdId: string; readonly reason: string }[]>;
  /** Record the closure AND revoke every grant, in one atomic write. Answers how many grants were revoked. */
  readonly recordClosure: (tenantId: string, record: Omit<TenantClosedRecord, 'grantsRevoked'>) => Promise<number>;
  readonly approvals: ApprovalPort;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** What the law still wants kept, from the shop's own newest record and its live holds. */
export async function retentionObligationsOf(deps: Pick<TenantLifecycleDeps, 'lastBusinessRecordOn' | 'liveHolds' | 'now' | 'calendar'>, tenantId: string): Promise<readonly RetentionObligation[]> {
  const today = await shopToday(deps, tenantId);
  const last = await deps.lastBusinessRecordOn(tenantId);
  const out: RetentionObligation[] = [];
  if (last !== undefined) {
    const d = statutoryRetentionDecision({ recordDate: last, statutes: ['gst', 'income_tax', 'companies_act'], asOf: today });
    out.push({ obligationId: 'books-and-tax-records', tenantId, what: 'books of account, tax invoices and GST records', law: d.effective.label, keepUntil: d.retainUntil });
  }
  for (const h of await deps.liveHolds(tenantId)) {
    out.push({ obligationId: `legal-hold:${h.holdId}`, tenantId, what: `records under legal hold ${h.holdId} (${h.reason})`, law: 'a legal hold — kept until it is lifted', keepUntil: '9999-12-31' });
  }
  return out;
}

/** Fold an export manifest into the record kept of it. */
export function exportTakenOf(manifest: TenantExport): ExportTaken {
  return { exportId: manifest.exportId, complete: manifest.complete, outcome: manifest.outcome, totalRows: manifest.totalRows, missing: [...manifest.missing], requestedBy: manifest.requestedBy, at: manifest.at };
}

export function tenantLifecycleRoutes(deps: TenantLifecycleDeps): readonly Route[] {
  const latestExport = async (tenantId: string): Promise<ExportTaken | undefined> =>
    (await deps.exports(tenantId)).reduce<ExportTaken | undefined>((l, e) => (l === undefined || e.at >= l.at ? e : l), undefined);
  const asTenantExport = (e: ExportTaken, tenantId: string): TenantExport => ({
    exportId: e.exportId, tenantId, requestedBy: e.requestedBy, at: e.at, outcome: e.outcome, complete: e.complete,
    domains: [], missing: e.missing, totalRows: e.totalRows, totalBytes: 0, detail: '',
  });

  return [
    {
      // Readiness: the export taken (or not), what closure would keep and until when, and how to ask. Writes nothing.
      api: 'API-11', method: 'GET', path: '/v1/platform/tenant/closure',
      permission: 'platform.tenant.export',
      handler: async (ctx) => {
        const closed = await deps.closure(ctx.tenantId);
        const exp = await latestExport(ctx.tenantId);
        const obligations = await retentionObligationsOf(deps, ctx.tenantId);
        const state: TenantLifecycleState = closed === undefined ? 'active' : 'closed';
        const verdict = closeTenant({
          tenantId: ctx.tenantId, state, obligations, ...(exp === undefined ? {} : { exportTaken: asTenantExport(exp, ctx.tenantId) }),
          approvedBy: 'readiness-check', today: await shopToday(deps, ctx.tenantId),
        });
        return {
          status: 200,
          body: {
            state, closure: closed ?? null,
            latestExport: exp ?? null,
            exportReady: exp?.complete === true,
            wouldRetain: verdict.retained,
            blockers: closed !== undefined ? [] : exp === undefined ? ['no export has been taken — the shop takes its complete export first (GET /v1/platform/export)'] : exp.complete ? [] : [`the latest export (${exp.exportId}) is not complete: ${exp.outcome}`],
            askWith: { kind: TENANT_CLOSURE_APPROVAL, subjectRef: `tenant:${ctx.tenantId}`, askedBy: 'the IT administrator', approvedBy: 'the owner' },
            nothingIsDeleted: 'Closure revokes every person\'s access. Everything is kept, sealed — the records the law still wants, the audit trail, and all the rest (hard rule #6 · OB-367).',
            // OB-367: sealed until the CA or the lawyer writes the closure retention schedule ("not set" until then).
            sealed: CLOSURE_SEAL,
          },
        };
      },
    },
    {
      // Close the shop's account. Body: { reason, approvalId } — the owner's approval of exactly this closure.
      api: 'API-11', method: 'POST', path: '/v1/platform/tenant/closure',
      permission: 'platform.tenant.close', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { reason?: unknown; approvalId?: unknown };
        if (!isStr(b.reason) || b.reason.trim().length < 5) {
          throw apiError(400, { code: 'reason_required', whatHappened: 'Closing a shop\'s account carries the reason it is being closed.', wasItSaved: 'not_saved', nextSafeAction: 'Send { reason, approvalId }. Nothing changed.' });
        }
        const already = await deps.closure(ctx.tenantId);
        if (already !== undefined) {
          throw apiError(409, { code: 'already_closed', whatHappened: `This shop's account was closed on ${shopDateIn(already.at)} (${already.closureId}).`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing changed.' });
        }
        const exp = await latestExport(ctx.tenantId);
        const obligations = await retentionObligationsOf(deps, ctx.tenantId);
        const today = await shopToday(deps, ctx.tenantId);
        // The engine judges the export FIRST (refusing before any approval is spent), then the approval.
        const preJudged = closeTenant({ tenantId: ctx.tenantId, state: 'active', obligations, ...(exp === undefined ? {} : { exportTaken: asTenantExport(exp, ctx.tenantId) }), approvedBy: 'pending', today });
        if (preJudged.outcome === 'export_not_taken') {
          throw apiError(409, {
            code: 'export_not_taken', whatHappened: `${preJudged.detail}.${exp === undefined ? '' : ` The latest export (${exp.exportId}) is ${exp.outcome}.`}`,
            wasItSaved: 'not_saved', nextSafeAction: 'Take a complete export (GET /v1/platform/export) and hand it to the shop, then ask again. Nothing changed.',
          });
        }
        if (!isStr(b.approvalId)) {
          throw apiError(422, {
            code: 'closure_needs_owner_approval', whatHappened: 'Closing a shop\'s account ends the relationship: the owner approves exactly this closure first, and the person who asks can never approve their own (§28).',
            wasItSaved: 'not_saved', nextSafeAction: `Ask for approval (POST /v1/approvals/requests, kind ${TENANT_CLOSURE_APPROVAL}, subjectRef tenant:${ctx.tenantId}, with exactly this reason); then send again with the approvalId. Nothing changed.`,
          });
        }
        const approval = await openApproval(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b.approvalId.trim(), kind: TENANT_CLOSURE_APPROVAL, subjectRef: `tenant:${ctx.tenantId}`,
          details: actionDetails(ctx.body), valueMinor: null, maker: ctx.userId, usedBy: `tenant-closure:${ctx.tenantId}`, now: deps.now(),
        });
        const verdict = closeTenant({ tenantId: ctx.tenantId, state: 'active', obligations, exportTaken: asTenantExport(exp!, ctx.tenantId), approvedBy: approval.decision.decidedBy, today });
        if (!verdict.closed) {
          throw apiError(409, { code: verdict.outcome, whatHappened: verdict.detail, wasItSaved: 'not_saved', nextSafeAction: 'Nothing changed.' });
        }
        await approval.spend();
        const at = deps.now();
        const record: Omit<TenantClosedRecord, 'grantsRevoked'> = {
          closureId: `closure-${ctx.tenantId}`, reason: b.reason.trim().slice(0, 500), askedBy: ctx.userId, approvedBy: approval.decision.decidedBy,
          approvalId: approval.decision.requestId, at, exportId: exp!.exportId, retained: verdict.retained,
        };
        const grantsRevoked = await deps.recordClosure(ctx.tenantId, record);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'platform.tenant.close', objectType: 'tenant', objectId: ctx.tenantId, at,
          origin: { tenantId: ctx.tenantId, branchId: null }, before: { state: 'active' },
          after: { state: 'closed', grantsRevoked: String(grantsRevoked), approvedBy: record.approvedBy, exportId: record.exportId },
          reason: record.reason, approvalId: record.approvalId, correlationId: record.closureId,
        });
        return { status: 200, body: { closed: true, closure: { ...record, grantsRevoked }, accessRevoked: true, detail: verdict.detail, sealed: CLOSURE_SEAL } };
      },
    },
  ];
}
