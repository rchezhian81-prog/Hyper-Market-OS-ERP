// API-11 Compliance — the licence, certificate and obligation register (M34-FR-03 / §9.3), and with it
// the two ratified R2 items it subsumes: the weighing-instrument register + re-verification alerts (B7)
// and the FSSAI licence capture + expiry alerts (B10) — a scale's stamping certificate and a food
// licence are both obligations with an authority, a reference and an expiry.
//
// A hypermarket runs on paper it did not write, and any one of those documents expiring quietly can
// close the shop for a day. `packages/compliance` holds the whole rule set — a register where every
// obligation has a NAMED responsible person, alerts that escalate as the date approaches and keep
// shouting once expired, and nothing ever deleted. It was a complete, tested engine that nothing on the
// cloud fed. This module is the HTTP skin and the event-sourced persistence around it: registering an
// obligation is an append-only fact, and "what needs attention" is PROJECTED from the register, never
// stored.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  registerObligation, expiryAlerts, isCompliant, closeObligation, missingEvidence, attachEvidence,
  MissingResponsiblePersonError,
  type Obligation, type ObligationKind, type EvidenceRef,
} from '../../../packages/compliance/src/index';

export type { Obligation } from '../../../packages/compliance/src/index';

export interface ComplianceDeps {
  /** Every obligation on the register (active and closed) — the alerts and status fold over these. */
  readonly obligations: (tenantId: string) => Promise<readonly Obligation[]> | readonly Obligation[];
  /** Register (or re-state) an obligation — append-only; idempotent on the obligation id. */
  readonly recordRegister: (tenantId: string, obligation: Obligation) => Promise<void> | void;
  readonly now: () => string;
}

const KINDS: readonly ObligationKind[] = ['licence', 'certificate', 'registration', 'inspection', 'calibration', 'insurance', 'training'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = (deps: ComplianceDeps): string => deps.now().slice(0, 10);

export function complianceRoutes(deps: ComplianceDeps): readonly Route[] {
  return [
    {
      // Register a licence / certificate / scale-stamping / food-licence with its named owner and expiry.
      api: 'API-11', method: 'POST', path: '/v1/compliance/obligations/:obligationId',
      permission: 'compliance.obligation.manage', idempotent: true,
      handler: async (ctx) => {
        const obligationId = ctx.params['obligationId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const responsible = (b['responsible'] ?? {}) as Record<string, unknown>;
        const kind = b['kind'] as ObligationKind;
        if (!KINDS.includes(kind) || typeof b['name'] !== 'string' || typeof b['authority'] !== 'string' || typeof b['validFrom'] !== 'string' || !DATE.test(b['validFrom'] as string)) {
          throw apiError(400, {
            code: 'obligation_needs_its_facts',
            whatHappened: 'An obligation needs kind (licence/certificate/registration/inspection/calibration/insurance/training), name, authority and validFrom (YYYY-MM-DD).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the obligation’s kind, name, authority, validFrom and a named responsible person.',
          });
        }
        if (b['expiresOn'] !== undefined && (typeof b['expiresOn'] !== 'string' || !DATE.test(b['expiresOn'] as string))) {
          throw apiError(400, { code: 'obligation_expiry_invalid', whatHappened: 'expiresOn, if given, must be a YYYY-MM-DD date.', wasItSaved: 'not_saved', nextSafeAction: 'Send a valid expiry date or omit it.' });
        }
        const evidence = Array.isArray(b['evidence']) ? (b['evidence'] as EvidenceRef[]) : undefined;
        const obligation: Obligation = {
          obligationId,
          tenantId: ctx.tenantId,
          branchId: (b['branchId'] as string | undefined) ?? null,
          kind,
          name: b['name'] as string,
          authority: b['authority'] as string,
          ...(typeof b['reference'] === 'string' ? { reference: b['reference'] } : {}),
          validFrom: b['validFrom'] as string,
          ...(typeof b['expiresOn'] === 'string' ? { expiresOn: b['expiresOn'] } : {}),
          responsible: {
            userId: (responsible['userId'] as string | undefined) ?? '',
            name: (responsible['name'] as string | undefined) ?? '',
            ...(typeof responsible['escalatesToUserId'] === 'string' ? { escalatesToUserId: responsible['escalatesToUserId'] } : {}),
          },
          ...(evidence === undefined ? {} : { evidence }),
          status: 'active',
        };
        try {
          registerObligation(obligation); // throws if no named responsible person
        } catch (err) {
          if (err instanceof MissingResponsiblePersonError) throw apiError(400, { code: 'obligation_needs_a_person', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Send responsible.userId and responsible.name — an alert that reaches a role reaches nobody.' });
          throw err;
        }
        await deps.recordRegister(ctx.tenantId, obligation);
        return { status: 201, body: { obligationId, kind, authority: obligation.authority, expiresOn: obligation.expiresOn ?? null } };
      },
    },
    {
      // What needs attention, worst first — expiring/expired licences and certificates, each with the
      // named person who must renew it. An expired one keeps shouting; it does not drop off the list.
      api: 'API-11', method: 'GET', path: '/v1/compliance/alerts',
      permission: 'compliance.obligation.read',
      handler: async (ctx) => {
        const asOf = ctx.query['asOf'];
        if (asOf !== undefined && !DATE.test(asOf)) throw apiError(400, { code: 'alerts_date_invalid', whatHappened: '?asOf=, if given, must be YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send a valid date or omit it for today.' });
        const on = asOf ?? today(deps);
        const alerts = expiryAlerts(await deps.obligations(ctx.tenantId), on);
        return { status: 200, body: { asOf: on, count: alerts.length, alerts } };
      },
    },
    {
      // Is every active obligation (optionally for one branch) currently valid?
      api: 'API-11', method: 'GET', path: '/v1/compliance/status',
      permission: 'compliance.obligation.read',
      handler: async (ctx) => {
        const asOf = ctx.query['asOf'];
        if (asOf !== undefined && !DATE.test(asOf)) throw apiError(400, { code: 'status_date_invalid', whatHappened: '?asOf=, if given, must be YYYY-MM-DD.', wasItSaved: 'not_saved', nextSafeAction: 'Send a valid date or omit it for today.' });
        const on = asOf ?? today(deps);
        const branchId = ctx.query['branchId'];
        const compliant = isCompliant(await deps.obligations(ctx.tenantId), on, branchId);
        return { status: 200, body: { asOf: on, ...(branchId === undefined ? {} : { branchId }), compliant } };
      },
    },
    {
      // Close an obligation that no longer applies — a scale scrapped, a licence surrendered. It leaves the
      // alert list but is NEVER deleted: the record stays for ever with its reason, because an inspector's
      // question is usually about a period you no longer operate in (hard rule #6). Closing is a new
      // append-only fact the register folds, exactly like a change to an expiry.
      api: 'API-11', method: 'POST', path: '/v1/compliance/obligations/:obligationId/close',
      permission: 'compliance.obligation.manage', idempotent: true,
      handler: async (ctx) => {
        const obligationId = ctx.params['obligationId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['reason'] !== 'string' || b['reason'].trim() === '') {
          throw apiError(400, {
            code: 'close_needs_a_reason',
            whatHappened: 'Closing an obligation needs a { reason } — the record is kept for ever with it (hard rule #6), never deleted.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send why the obligation no longer applies.',
          });
        }
        const current = (await deps.obligations(ctx.tenantId)).find((o) => o.obligationId === obligationId);
        if (current === undefined) throw notFound(obligationId);
        if (current.status === 'closed') {
          // Already closed — a no-op, so a retried close does not churn the reason.
          return { status: 200, body: { obligationId, status: 'closed', closedReason: current.closedReason ?? null, closedAt: current.closedAt ?? null, alreadyClosed: true } };
        }
        const closed = closeObligation(current, b['reason'].trim(), deps.now());
        await deps.recordRegister(ctx.tenantId, closed);
        return { status: 200, body: { obligationId, status: 'closed', closedReason: closed.closedReason, closedAt: closed.closedAt } };
      },
    },
    {
      // File evidence AFTER registration — the renewed certificate, the inspection report. Evidence is only
      // ever ADDED, never replaced or removed (hard rule #6); a re-send of the same evidenceId collapses.
      api: 'API-11', method: 'POST', path: '/v1/compliance/obligations/:obligationId/evidence',
      permission: 'compliance.obligation.manage', idempotent: true,
      handler: async (ctx) => {
        const obligationId = ctx.params['obligationId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['evidenceId'] !== 'string' || b['evidenceId'].trim() === '' || typeof b['description'] !== 'string' || b['description'].trim() === '') {
          throw apiError(400, {
            code: 'evidence_needs_id_and_description',
            whatHappened: 'Attaching evidence needs { evidenceId } and { description } — the document that proves the obligation is met.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the evidence id and a description.',
          });
        }
        if (b['recordedAt'] !== undefined && (typeof b['recordedAt'] !== 'string' || Number.isNaN(Date.parse(b['recordedAt'] as string)))) {
          throw apiError(400, { code: 'evidence_recorded_at_invalid', whatHappened: 'recordedAt, if given, must be an ISO-8601 timestamp.', wasItSaved: 'not_saved', nextSafeAction: 'Send a valid timestamp or omit it for now.' });
        }
        const current = (await deps.obligations(ctx.tenantId)).find((o) => o.obligationId === obligationId);
        if (current === undefined) throw notFound(obligationId);
        if ((current.evidence ?? []).some((e) => e.evidenceId === (b['evidenceId'] as string).trim())) {
          return { status: 200, body: { obligationId, evidenceCount: (current.evidence ?? []).length, alreadyOnFile: true } };
        }
        const evidence: EvidenceRef = {
          evidenceId: (b['evidenceId'] as string).trim(),
          description: (b['description'] as string).trim(),
          recordedAt: typeof b['recordedAt'] === 'string' ? b['recordedAt'] : deps.now(),
        };
        const updated = attachEvidence(current, evidence);
        await deps.recordRegister(ctx.tenantId, updated);
        return { status: 201, body: { obligationId, evidenceCount: (updated.evidence ?? []).length } };
      },
    },
    {
      // Active obligations with NOTHING on file to show an inspector — a finding in itself, separate from
      // any expiry date. A licence that is in date but unproven is still a gap.
      api: 'API-11', method: 'GET', path: '/v1/compliance/evidence-gaps',
      permission: 'compliance.obligation.read',
      handler: async (ctx) => {
        const gaps = missingEvidence(await deps.obligations(ctx.tenantId));
        return { status: 200, body: { count: gaps.length, obligations: gaps } };
      },
    },
  ];
}

function notFound(obligationId: string): ReturnType<typeof apiError> {
  return apiError(404, {
    code: 'unknown_obligation',
    whatHappened: `There is no obligation '${obligationId}' on the register.`,
    wasItSaved: 'not_saved',
    nextSafeAction: `Register it first with POST /v1/compliance/obligations/${obligationId}.`,
  });
}
