// API-05 loss-prevention investigation cases (M15-FR-04). A case is opened when somebody may have
// taken something, and a case file is read in two adversarial places — a disciplinary meeting and a
// court — so the controls are strict and they are the engine's, not this file's:
//
//   • EVIDENCE IS APPEND-ONLY and each item is SEALED to the one before it, so a removal or an edit is
//     detectable, not merely forbidden (hard rule #6). There is no remove/update route, by design.
//   • CHAIN OF CUSTODY IS PART OF THE EVIDENCE — who collected it and from where, or it is not evidence.
//   • A CASE CANNOT CLOSE WITHOUT AN OUTCOME, and "unfounded" is a first-class outcome; a PROVEN outcome
//     needs someone other than the investigator to sign it (§28), evidence on file, and a verifying chain.
//   • OUTCOMES TUNE THE RULES — closed cases feed `ruleFeedback` so a rule that is always unfounded is
//     retired rather than left to spend the manager's attention.
//
// The rules are the pure `openCase` / `addEvidence` / `verifyEvidence` / `closeCase` / `ruleFeedback` in
// `packages/loss-prevention` (a complete engine nothing fed). This surface gives them persistence — the
// append-only event stream that IS the chain of custody — an authorization split and reads.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  openCase, addEvidence, verifyEvidence, closeCase, ruleFeedback,
  type InvestigationCase, type EvidenceItem, type EvidenceKind, type CaseOutcome,
} from '../../../packages/loss-prevention/src/cases';

const KINDS: readonly EvidenceKind[] = ['transaction_record', 'cctv_reference', 'witness_statement', 'stock_count', 'settlement_record', 'note'];
const OUTCOMES: readonly CaseOutcome[] = ['proven', 'unfounded', 'inconclusive', 'process_failure', 'referred_to_police'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export interface LpCasesDeps {
  readonly cases: (tenantId: string) => Promise<readonly InvestigationCase[]> | readonly InvestigationCase[];
  readonly case: (tenantId: string, caseId: string) => Promise<InvestigationCase | undefined> | InvestigationCase | undefined;
  readonly recordOpened: (tenantId: string, investigation: InvestigationCase) => Promise<void> | void;
  readonly recordEvidence: (tenantId: string, caseId: string, item: EvidenceItem) => Promise<void> | void;
  readonly recordClosed: (tenantId: string, c: InvestigationCase) => Promise<void> | void;
  readonly now: () => string;
}

const refuse = (code: string, whatHappened: string, status = 422): never => {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
};

export function lpCasesRoutes(deps: LpCasesDeps): readonly Route[] {
  return [
    {
      // Open a case — it must come from a raised exception/signal and name an investigator who is not
      // the subject. Open-once.
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/cases/:caseId',
      permission: 'lp.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const b = (ctx.body ?? {}) as { raisedFromRef?: unknown; subjectRef?: unknown; summary?: unknown; valueMinor?: unknown; assignedTo?: unknown };
        if (!isStr(b.raisedFromRef) || !isStr(b.subjectRef) || !isStr(b.summary) || !isStr(b.assignedTo) || !Number.isInteger(b.valueMinor) || (b.valueMinor as number) < 0) {
          refuse('not_readable_as_a_case', 'A case needs the reference it was raised from, a subject, a summary, a whole non-negative value, and a named investigator.', 400);
        }
        if ((await deps.case(ctx.tenantId, caseId)) !== undefined) {
          refuse('case_already_open', `Case ${caseId} already exists — evidence is added to it, a case is not reopened by redefining.`, 409);
        }
        const result = openCase({
          caseId, tenantId: ctx.tenantId,
          raisedFromRef: b.raisedFromRef as string, subjectRef: b.subjectRef as string,
          summary: b.summary as string, valueMinor: b.valueMinor as number,
          openedBy: ctx.userId, assignedTo: b.assignedTo as string, at: deps.now(),
        });
        if (!result.opened || result.case === undefined) refuse('case_refused', result.detail);
        await deps.recordOpened(ctx.tenantId, result.case as InvestigationCase);
        return { status: 201, body: { caseId, subjectRef: (result.case as InvestigationCase).subjectRef, assignedTo: (result.case as InvestigationCase).assignedTo, state: 'open' } };
      },
    },
    {
      // Add evidence — append-only, sealed to the chain, with a mandatory chain of custody.
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/cases/:caseId/evidence/:evidenceId',
      permission: 'lp.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const evidenceId = ctx.params['evidenceId'] ?? '';
        const b = (ctx.body ?? {}) as { kind?: unknown; ref?: unknown; description?: unknown; collectedBy?: unknown; collectedFrom?: unknown };
        if (typeof b.kind !== 'string' || !(KINDS as readonly string[]).includes(b.kind) || !isStr(b.ref) || !isStr(b.description) || !isStr(b.collectedBy) || !isStr(b.collectedFrom)) {
          refuse('not_readable_as_evidence', 'Evidence needs a kind, a reference, a description, and a chain of custody (collectedBy and collectedFrom).', 400);
        }
        const investigation = await deps.case(ctx.tenantId, caseId);
        if (investigation === undefined) throw notFound(`case ${caseId}`);

        const result = addEvidence(investigation, {
          evidenceId, kind: b.kind as EvidenceKind, ref: b.ref as string, description: b.description as string,
          collectedBy: b.collectedBy as string, collectedAt: deps.now(), collectedFrom: b.collectedFrom as string,
        });
        if (!result.added) refuse('evidence_refused', result.detail);
        const sealed = result.case.evidence[result.case.evidence.length - 1] as EvidenceItem;
        await deps.recordEvidence(ctx.tenantId, caseId, sealed);
        return { status: 201, body: { caseId, evidenceId, kind: sealed.kind, seal: sealed.seal, items: result.case.evidence.length } };
      },
    },
    {
      // Close a case with an outcome. Unfounded is first-class; proven needs someone other than the
      // investigator (§28), evidence on file, and a chain that verifies.
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/cases/:caseId/close',
      permission: 'lp.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const b = (ctx.body ?? {}) as { outcome?: unknown; note?: unknown };
        if (typeof b.outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(b.outcome) || !isStr(b.note)) {
          refuse('not_readable_as_a_close', 'Closing a case needs an outcome (proven/unfounded/inconclusive/process_failure/referred_to_police) and a note.', 400);
        }
        const investigation = await deps.case(ctx.tenantId, caseId);
        if (investigation === undefined) throw notFound(`case ${caseId}`);

        const result = closeCase({ case: investigation, outcome: b.outcome as CaseOutcome, note: b.note as string, closedBy: ctx.userId, at: deps.now() });
        if (!result.closed) refuse('close_refused', result.detail);
        await deps.recordClosed(ctx.tenantId, result.case);
        return { status: 200, body: { caseId, state: 'closed', outcome: result.case.outcome, closedBy: result.case.closedBy } };
      },
    },
    {
      // Read a case, with a live verification of its evidence chain.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/cases/:caseId',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const caseId = ctx.params['caseId'] ?? '';
        const investigation = await deps.case(ctx.tenantId, caseId);
        if (investigation === undefined) throw notFound(`case ${caseId}`);
        return { status: 200, body: { ...investigation, chain: verifyEvidence(investigation) } };
      },
    },
    {
      // The feedback loop: closed outcomes measurably retire/relax/tighten the rules that raised them.
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/rule-feedback',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const all = await deps.cases(ctx.tenantId);
        return { status: 200, body: { adjustments: ruleFeedback(all), asAt: deps.now() } };
      },
    },
  ];
}
