// API-06 Erasure EXECUTION — carrying out a verified erasure on the cloud, under the two-person control
// (M20-FR-04 / PRV / DPDP, owner decision). DEVELOPMENT-APPROVED; LEGAL CONFIRMATION REQUIRED — this wires
// the technical workflow; it is NOT a claim of legal compliance. The retention policy, the immutable-history
// boundary and the processor list still need a lawyer's confirmation.
//
// The plan/verify/overdue lifecycle is in `data-rights.ts`. This adds the steps that ACT:
//
//   • LOCATE — `POST/GET /v1/privacy/pii/:customerRef[/:category]` records and reads, per customer, which
//     categories of personal data the shop holds (count, statutory basis, whether minimisable). This is the
//     simulated, provider-neutral holding the executor acts on — in production the real domain stores back
//     these; here they are event-sourced so the whole path is testable now (the same "simulated sources"
//     the tested executor was built for). Recording PII for an ALREADY-ERASED subject is REFUSED
//     (prevent-restore, hard rule #10) — a late re-import cannot quietly bring a deleted person back.
//   • APPROVE — `POST …/erasure-approval` is the checker's act. Verifying the request proved WHO ASKED;
//     this is a SECOND, distinct officer authorising the deletion (maker-checker, SoD §28).
//   • EXECUTE — `POST …/erasure-execution` is the maker's act. It plans from the located PII, runs the
//     two-person authorisation (the executor's user is the maker; it refuses if the maker is also the
//     checker), carries the plan out against the holdings, SEALS a PII-free tombstone, and enqueues the
//     provider-neutral notices to the processors we shared the data with. Retained categories are never
//     touched (hard rule #6); a category with no holding is a visible exception, never a silent success.
//
// The engines are `@sre/customer` (`planErasure` / `authoriseErasureExecution` / `executeErasurePlan` /
// `sealTombstone` / `guardAgainstRestore` / `planProcessorErasureNotices`) and the notices ride the tested
// `@sre/integration` connector queue — this route composes them, it re-decides nothing. Append-only and
// event-sourced. Execution is gated `privacy.erasure.execute`, approval `privacy.erasure.approve`, and the
// PII register / reads `privacy.request.manage`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  planErasure, authoriseErasureExecution, executeErasurePlan, sealTombstone, guardAgainstRestore,
  planProcessorErasureNotices,
  type DataSubjectRequest, type DataCategory, type RetentionBasis, type ErasableSource,
  type PrivacyTombstone, type ProcessorRegistryEntry, type ErasureExecutionReport,
} from '../../../packages/customer/src/index';
import type { ConnectorMessage } from '../../../packages/integration/src/index';

/** A located holding of a customer's personal data, in one category — the simulated, erasable source. */
export interface PiiEntry {
  readonly customerRef: string;
  readonly category: string;
  readonly recordCount: number;
  readonly retentionBasis?: RetentionBasis;
  readonly retainUntil?: string;
  readonly minimisable?: boolean;
  /** Where the holding stands after any erasure: held (untouched), erased (removed), minimised (redacted). */
  readonly state: 'held' | 'erased' | 'minimised';
}

/** The checker's recorded authorisation to carry out an erasure — the second person of the two-person control. */
export interface ErasureApproval {
  readonly requestId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface ErasureExecutionDeps {
  readonly request: (tenantId: string, requestId: string) => Promise<DataSubjectRequest | undefined> | DataSubjectRequest | undefined;
  /** Append one state of a request (append-only lifecycle — same stream the data-rights routes use). */
  readonly recordRequest: (tenantId: string, requestId: string, request: DataSubjectRequest, key: string) => Promise<void> | void;
  readonly recordPii: (tenantId: string, entry: PiiEntry, key: string) => Promise<void> | void;
  readonly piiFor: (tenantId: string, customerRef: string) => Promise<readonly PiiEntry[]> | readonly PiiEntry[];
  readonly recordApproval: (tenantId: string, approval: ErasureApproval, key: string) => Promise<void> | void;
  readonly approvalFor: (tenantId: string, requestId: string) => Promise<ErasureApproval | undefined> | ErasureApproval | undefined;
  readonly recordTombstone: (tenantId: string, tombstone: PrivacyTombstone, key: string) => Promise<void> | void;
  readonly tombstonesFor: (tenantId: string) => Promise<readonly PrivacyTombstone[]> | readonly PrivacyTombstone[];
  readonly tombstoneFor: (tenantId: string, requestId: string) => Promise<PrivacyTombstone | undefined> | PrivacyTombstone | undefined;
  /** Enqueue a processor-erasure notice on the durable connector queue (M32-FR-02). */
  readonly enqueueNotice: (tenantId: string, message: ConnectorMessage, key: string) => Promise<void> | void;
  readonly now: () => string;
}

const BASES: readonly RetentionBasis[] = ['tax_invoice', 'gst_record', 'company_law', 'audit_evidence', 'legal_hold', 'fraud_investigation'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`));

const isProcessor = (v: unknown): v is ProcessorRegistryEntry => {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return isStr(p['processorId']) && isStr(p['name']) && isStr(p['connectorId']) && isStr(p['connectorVersion'])
    && Array.isArray(p['categoriesShared']) && p['categoriesShared'].every((c) => typeof c === 'string');
};

/** A held PII entry as a category the planner reads. */
const toCategory = (e: PiiEntry): DataCategory => ({
  category: e.category,
  recordCount: e.recordCount,
  ...(e.retentionBasis === undefined ? {} : { retentionBasis: e.retentionBasis }),
  ...(e.retainUntil === undefined ? {} : { retainUntil: e.retainUntil }),
  ...(e.minimisable === undefined ? {} : { minimisable: e.minimisable }),
});

export function erasureExecutionRoutes(deps: ErasureExecutionDeps): readonly Route[] {
  return [
    {
      // Record that the shop holds personal data for a customer in a category — the located, erasable
      // holding. Refused for an already-erased subject (prevent-restore). Body: { recordCount,
      // retentionBasis?, retainUntil?, minimisable? }.
      api: 'API-06', method: 'POST', path: '/v1/privacy/pii/:customerRef/:category',
      permission: 'privacy.request.manage', idempotent: true,
      handler: async (ctx) => {
        const customerRef = (ctx.params['customerRef'] ?? '').trim();
        const category = (ctx.params['category'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (customerRef === '' || category === '' || !isInt(b['recordCount'])
          || (b['retentionBasis'] !== undefined && !BASES.includes(b['retentionBasis'] as RetentionBasis))
          || (b['retainUntil'] !== undefined && !isDate(b['retainUntil']))
          || (b['minimisable'] !== undefined && typeof b['minimisable'] !== 'boolean')) {
          throw apiError(400, { code: 'not_readable_as_a_pii_holding', whatHappened: 'Recording located PII needs customerRef + category in the path and { recordCount, retentionBasis?, retainUntil?, minimisable? } in the body.', wasItSaved: 'not_saved', nextSafeAction: 'Send the count of records held and, if the law requires keeping them, the statutory basis.' });
        }
        // Prevent restore — an erased subject must not quietly come back through a late re-import (#10, P-08).
        const guard = guardAgainstRestore({ attempt: { customerRef, carriesPii: true, source: `pii-register:${category}` }, tombstones: await deps.tombstonesFor(ctx.tenantId), at: deps.now() });
        if (guard.decision === 'refused_erased_subject') {
          throw apiError(409, { code: 'subject_was_erased', whatHappened: guard.detail, wasItSaved: 'not_saved', nextSafeAction: 'This person exercised their right to erasure. Re-creating their data needs a new, lawful basis recorded first, not a silent restore.' });
        }
        const entry: PiiEntry = {
          customerRef, category, recordCount: b['recordCount'] as number, state: 'held',
          ...(b['retentionBasis'] === undefined ? {} : { retentionBasis: b['retentionBasis'] as RetentionBasis }),
          ...(b['retainUntil'] === undefined ? {} : { retainUntil: b['retainUntil'] as string }),
          ...(b['minimisable'] === undefined ? {} : { minimisable: b['minimisable'] as boolean }),
        };
        await deps.recordPii(ctx.tenantId, entry, ctx.idempotencyKey ?? `${customerRef}-${category}-held`);
        return { status: 201, body: { customerRef, category, state: entry.state } };
      },
    },
    {
      // The located PII for a customer — the categories the shop holds, and where each stands after any erasure.
      api: 'API-06', method: 'GET', path: '/v1/privacy/pii/:customerRef',
      permission: 'privacy.request.manage',
      handler: async (ctx) => {
        const customerRef = (ctx.params['customerRef'] ?? '').trim();
        const entries = [...(await deps.piiFor(ctx.tenantId, customerRef))].sort((a, b) => a.category.localeCompare(b.category));
        return { status: 200, body: { customerRef, categories: entries, count: entries.length } };
      },
    },
    {
      // The checker's approval — a SECOND, distinct officer authorising the deletion (maker-checker, SoD §28).
      api: 'API-06', method: 'POST', path: '/v1/privacy/data-requests/:requestId/erasure-approval',
      permission: 'privacy.erasure.approve', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const existing = await deps.request(ctx.tenantId, requestId);
        if (existing === undefined) throw notFound(`data-subject request ${requestId}`);
        if (existing.kind !== 'erasure') throw apiError(409, { code: 'not_an_erasure_request', whatHappened: `This is a ${existing.kind} request, not an erasure.`, wasItSaved: 'not_saved', nextSafeAction: 'Only an erasure needs a two-person approval.' });
        if (existing.verifiedBy === undefined) throw apiError(422, { code: 'not_verified', whatHappened: 'The request must be verified as coming from the data subject before it can be approved for erasure.', wasItSaved: 'not_saved', nextSafeAction: 'Verify the request first.' });
        if (existing.state === 'fulfilled' || existing.state === 'refused') throw apiError(409, { code: 'request_already_closed', whatHappened: `This request is already ${existing.state}.`, wasItSaved: 'not_saved', nextSafeAction: 'A closed request is not approved again.' });
        const approval: ErasureApproval = { requestId, approvedBy: ctx.userId, approvedAt: deps.now() };
        await deps.recordApproval(ctx.tenantId, approval, `${requestId}-approved-${ctx.userId}`);
        return { status: 200, body: { requestId, approvedBy: ctx.userId, approvedAt: approval.approvedAt } };
      },
    },
    {
      // The maker's act — carry the erasure out. Plans from the located PII, runs the two-person
      // authorisation (this caller is the maker; refused if the maker is also the checker), executes against
      // the holdings, seals a PII-free tombstone, and enqueues the processor notices. Body: { processors?[] }.
      api: 'API-06', method: 'POST', path: '/v1/privacy/data-requests/:requestId/erasure-execution',
      permission: 'privacy.erasure.execute', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const processorsIn = b['processors'];
        if (processorsIn !== undefined && !(Array.isArray(processorsIn) && processorsIn.every(isProcessor))) {
          throw apiError(400, { code: 'not_readable_as_processors', whatHappened: 'The optional { processors[] } must each be { processorId, name, connectorId, connectorVersion, categoriesShared[] }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the processors the data was shared with, or omit the field.' });
        }
        const existing = await deps.request(ctx.tenantId, requestId);
        if (existing === undefined) throw notFound(`data-subject request ${requestId}`);
        if (existing.kind !== 'erasure') throw apiError(409, { code: 'not_an_erasure_request', whatHappened: `This is a ${existing.kind} request, not an erasure.`, wasItSaved: 'not_saved', nextSafeAction: 'Use POST …/fulfilment for access/correction/export.' });
        if (existing.state === 'fulfilled' || existing.state === 'refused') throw apiError(409, { code: 'request_already_closed', whatHappened: `This request is already ${existing.state}.`, wasItSaved: 'not_saved', nextSafeAction: 'A closed request is not executed again.' });

        const approval = await deps.approvalFor(ctx.tenantId, requestId);
        // Plan from the currently-held PII (already-erased/minimised entries are not re-planned).
        const held = (await deps.piiFor(ctx.tenantId, existing.customerRef)).filter((e) => e.state === 'held');
        const plan = planErasure({ request: existing, categories: held.map(toCategory), at: deps.now() });

        // Two-person authorisation (SoD §28). The caller is the maker; the checker is the recorded approver.
        const auth = authoriseErasureExecution({ request: existing, plan, maker: ctx.userId, checker: approval?.approvedBy ?? '', at: deps.now() });
        if (!auth.authorised) {
          const status = auth.outcome === 'not_verified' ? 422 : auth.outcome === 'checker_missing' ? 428 : 409;
          throw apiError(status, {
            code: auth.outcome, whatHappened: auth.detail, wasItSaved: 'not_saved',
            nextSafeAction: auth.outcome === 'checker_missing' ? 'A second, authorised officer must approve the erasure first (POST …/erasure-approval), and it cannot be the same person who runs it.'
              : auth.outcome === 'maker_is_checker' ? 'A different officer must run the erasure than the one who approved it (SoD).'
              : auth.outcome === 'not_verified' ? 'Verify the request first. Nothing was erased.'
              : 'Nothing was erased.',
          });
        }

        // Carry the plan out against the located holdings. Each held category is an erasable source that
        // records its new state append-only; retained categories are never touched (the executor skips them).
        const sources: ErasableSource[] = held.map((entry): ErasableSource => ({
          category: entry.category,
          erase: async () => {
            await deps.recordPii(ctx.tenantId, { ...entry, recordCount: 0, state: 'erased' }, `${requestId}-erase-${entry.category}`);
            return { recordsAffected: entry.recordCount, note: `${entry.recordCount} record(s) erased` };
          },
          minimise: async () => {
            await deps.recordPii(ctx.tenantId, { ...entry, state: 'minimised' }, `${requestId}-minimise-${entry.category}`);
            return { recordsAffected: entry.recordCount, note: `${entry.recordCount} record(s) minimised` };
          },
        }));
        const report: ErasureExecutionReport = await executeErasurePlan({ plan, sources, at: deps.now() });

        // Seal the PII-free tombstone from the two-person authorisation and the report.
        const tombstone = sealTombstone({ authorisation: auth.authorisation, report, at: deps.now() });
        await deps.recordTombstone(ctx.tenantId, tombstone, `${requestId}-tombstone`);

        // Tell the processors we shared the affected data with, on the durable connector queue.
        const processors = (processorsIn as ProcessorRegistryEntry[] | undefined) ?? [];
        const enqueues = planProcessorErasureNotices({ tombstone, processors, at: deps.now() });
        for (const e of enqueues) {
          const message: ConnectorMessage = {
            messageId: e.messageId, tenantId: ctx.tenantId, connectorId: e.processor.connectorId,
            connectorVersion: e.processor.connectorVersion, kind: 'privacy.erasure', payload: e.notice,
            deliveryKey: e.deliveryKey, enqueuedAt: deps.now(), state: 'queued', attempts: 0,
          };
          await deps.enqueueNotice(ctx.tenantId, message, e.messageId);
        }

        // The request is fulfilled only when nothing was left as an exception; a partial run stays honestly
        // partially_fulfilled so the trail never claims a total erasure that did not finish (P-08).
        const state: DataSubjectRequest['state'] = report.complete && !plan.partial ? 'fulfilled' : 'partially_fulfilled';
        const updated: DataSubjectRequest = { ...existing, state };
        await deps.recordRequest(ctx.tenantId, requestId, updated, `${requestId}-${state}`);

        return {
          status: 200,
          body: {
            requestId, state, report, tombstone,
            notices: enqueues.map((e) => ({ processorId: e.processor.processorId, categories: e.notice.categories, messageId: e.messageId })),
            customerStatement: plan.customerStatement,
          },
        };
      },
    },
    {
      // Read the sealed tombstone for a request — the PII-free evidence the erasure happened.
      api: 'API-06', method: 'GET', path: '/v1/privacy/data-requests/:requestId/tombstone',
      permission: 'privacy.request.manage',
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const tombstone = await deps.tombstoneFor(ctx.tenantId, requestId);
        if (tombstone === undefined) throw notFound(`tombstone for request ${requestId}`);
        return { status: 200, body: tombstone };
      },
    },
  ];
}
