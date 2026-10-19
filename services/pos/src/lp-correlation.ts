// D-21 (R4, OB-217) — the loss-prevention view that joins the till, shrink and counts, and CCTV kept as a reference only.
//
//   GET  /v1/loss-prevention/correlation?productId=… | cashierId=…&from=&to=
//        for a product or a cashier and a period: the till exceptions (voids, no-sale opens, price overrides, refunds),
//        the recorded waste and shrink (write-offs) and the count differences, side by side, and a PROPOSED case. It is a
//        read: nothing is opened and nothing is blamed on anyone. A person opens a case from it through the existing case
//        route (POST /v1/loss-prevention/cases/:caseId, raisedFromRef = the proposal's), naming the investigator.
//   POST /v1/loss-prevention/cases/:caseId/cctv/:evidenceId   { cameraId, from, to, collectedBy }
//        a CCTV clip recorded ONLY as a reference — camera, time from and to, who collected it — sealed onto the case's
//        evidence chain like any other item. No video is stored or analysed: a body carrying video, a file or a link is
//        refused by name. (The generic evidence route refuses the cctv_reference kind and points here.)
//
// A case cannot close without an outcome, and "unfounded" is a valid one: that is the existing case engine's rule
// (packages/loss-prevention/src/cases.ts `closeCase`), unchanged. The joins are the tested `correlateLosses`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { addEvidence, type InvestigationCase, type EvidenceItem } from '../../../packages/loss-prevention/src/cases';
import {
  correlateLosses, readCctvReference, cctvEvidenceRef,
  type TillExceptionFact, type ShrinkFact, type CountDifferenceFact, type CorrelationSubject,
} from '../../../packages/loss-prevention/src/correlate';

export interface LpCorrelationDeps {
  readonly now: () => string;
  /** Till exceptions of the trading days [from, to]: voids, no-sale opens, price overrides, refunds. */
  readonly tillExceptions: (tenantId: string, from: string, to: string) => Promise<readonly TillExceptionFact[]>;
  /** Write-offs (waste and shrink) of the days [from, to]. */
  readonly shrink: (tenantId: string, from: string, to: string) => Promise<readonly ShrinkFact[]>;
  /** Count differences of the days [from, to]. */
  readonly countDifferences: (tenantId: string, from: string, to: string) => Promise<readonly CountDifferenceFact[]>;
  readonly case: (tenantId: string, caseId: string) => Promise<InvestigationCase | undefined> | InvestigationCase | undefined;
  readonly recordEvidence: (tenantId: string, caseId: string, item: EvidenceItem) => Promise<void> | void;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 92;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function lpCorrelationRoutes(deps: LpCorrelationDeps): readonly Route[] {
  return [
    {
      api: 'API-05', method: 'GET', path: '/v1/loss-prevention/correlation',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const productId = (ctx.query['productId'] ?? '').trim();
        const cashierId = (ctx.query['cashierId'] ?? '').trim();
        const from = ctx.query['from'] ?? '';
        const to = ctx.query['to'] ?? '';
        const days = DAY.test(from) && DAY.test(to) ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1 : 0;
        if ((productId === '') === (cashierId === '') || days < 1 || days > MAX_DAYS) {
          throw apiError(400, {
            code: 'not_readable_as_a_correlation',
            whatHappened: `The view is for ONE product (?productId=) or ONE cashier (?cashierId=) and a period ?from=&to= (YYYY-MM-DD, from on or before to, at most ${MAX_DAYS} days).`,
            wasItSaved: 'not_saved', nextSafeAction: 'Name the product or the cashier and the days. Nothing was changed; this only reads.',
          });
        }
        const subject: CorrelationSubject = productId !== '' ? { kind: 'product', productId } : { kind: 'cashier', cashierId };
        const [tillExceptions, shrink, countDifferences] = await Promise.all([
          deps.tillExceptions(ctx.tenantId, from, to), deps.shrink(ctx.tenantId, from, to), deps.countDifferences(ctx.tenantId, from, to),
        ]);
        const view = correlateLosses({ subject, from, to, tillExceptions, shrink, countDifferences });
        return {
          status: 200,
          body: {
            ...view, asAt: deps.now(),
            openVia: 'POST /v1/loss-prevention/cases/:caseId — a person, naming the investigator, with the proposal\'s raisedFromRef',
          },
        };
      },
    },
    {
      api: 'API-05', method: 'POST', path: '/v1/loss-prevention/cases/:caseId/cctv/:evidenceId',
      permission: 'lp.case.manage', idempotent: true,
      handler: async (ctx) => {
        const caseId = (ctx.params['caseId'] ?? '').trim();
        const evidenceId = (ctx.params['evidenceId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const read = readCctvReference(b);
        if (!read.ok) {
          throw apiError(read.refusal === 'video_not_stored' ? 422 : 400, {
            code: read.refusal, whatHappened: `Not recorded: ${read.detail}.`, wasItSaved: 'not_saved',
            nextSafeAction: 'Send only the camera, the time from and to, and who collected the clip. The video itself stays on the CCTV recorder. Nothing was saved.',
          });
        }
        if (caseId === '' || evidenceId === '' || (b['collectedFrom'] !== undefined && !isStr(b['collectedFrom']))) {
          throw apiError(400, { code: 'not_readable_as_a_cctv_reference', whatHappened: 'A CCTV reference needs the case and an evidence id in the path.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was saved.' });
        }
        const investigation = await deps.case(ctx.tenantId, caseId);
        if (investigation === undefined) throw notFound(`case ${caseId}`);
        const r = read.ref;
        const result = addEvidence(investigation, {
          evidenceId, kind: 'cctv_reference', ref: cctvEvidenceRef(r),
          description: `CCTV reference only — camera ${r.cameraId}, from ${r.from} to ${r.to}, collected by ${r.collectedBy}. No video is stored or analysed.`,
          collectedBy: r.collectedBy, collectedAt: deps.now(), collectedFrom: isStr(b['collectedFrom']) ? (b['collectedFrom'] as string).trim() : `camera:${r.cameraId}`,
        });
        if (!result.added) {
          throw apiError(result.detail.includes('already on this case') ? 409 : 422, { code: 'evidence_refused', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const sealed = result.case.evidence[result.case.evidence.length - 1] as EvidenceItem;
        await deps.recordEvidence(ctx.tenantId, caseId, sealed);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'lp.cctv_reference.add', objectType: 'lp_case', objectId: caseId, at: sealed.collectedAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { evidenceId, cameraId: r.cameraId, from: r.from, to: r.to, collectedBy: r.collectedBy }, correlationId: `${caseId}:${evidenceId}`,
        });
        return { status: 201, body: { caseId, evidenceId, kind: sealed.kind, ref: sealed.ref, seal: sealed.seal, items: result.case.evidence.length, videoStored: false } };
      },
    },
  ];
}
