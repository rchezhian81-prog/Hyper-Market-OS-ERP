// Risk register & quality-gate blocking (M34-FR-04) on the compliance API. The register the whole
// governance model turns on: an OPEN CRITICAL risk BLOCKS the quality gates it is registered against, and
// the only way past is not to ignore it but to ACCEPT it — in a named person's own name, with a written
// reason. Acceptance is a recorded decision, and decisions have authors (§28, hard rule #2 — nothing is
// overwritten, the acceptance is a new fact).
//
// The rules are the tested `acceptRisk` / `blockedGates` / `gateCanPass` in `@sre/compliance` (the
// services-run-on-their-tested-engine guardrail). Append-only and event-sourced. Register/accept gated
// `compliance.risk.manage`; the gate reads `compliance.risk.read`.
//
// The named FR-04 follow-on is now wired too: the incident / remediation / control-health / attestation
// legs (`recordIncident` / `recordRemediation` / `controlHealth` / `overdueRemediations`). These answer the
// three questions the registers exist for — WHICH CONTROL was supposed to stop this (incident → control),
// WHAT are we doing about it and WHO owns it (incident → remediation), and DID ANYONE CHECK the control
// works (control → attestation). Every link is mandatory, because a register where the links are optional
// degrades into a list nobody reads: an incident must name a REGISTERED control, a remediation must name a
// REGISTERED incident AND an owner AND a date, and an attestation is dated and made in the caller's own
// name (a tick with no date, or nobody's name, is not evidence).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  acceptRisk, blockedGates, gateCanPass,
  recordIncident, recordRemediation, controlHealth, overdueRemediations,
  UnlinkedIncidentError, UnownedRemediationError,
  type Risk, type RiskSeverity, type RiskStatus,
  type Control, type Incident, type IncidentSeverity, type Remediation, type Attestation,
} from '../../../packages/compliance/src/index';

export type { Risk, Control, Incident, Remediation, Attestation } from '../../../packages/compliance/src/index';

const SEVERITIES: readonly RiskSeverity[] = ['critical', 'high', 'medium', 'low'];
const INCIDENT_SEVERITIES: readonly IncidentSeverity[] = ['sev1', 'sev2', 'sev3'];
// A register may set any status EXCEPT accepted — acceptance carries a mandatory rationale and a named
// author, so it cannot be back-doored through a plain register.
const REGISTERABLE: readonly RiskStatus[] = ['open', 'mitigated', 'closed'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const strArray = (v: unknown): readonly string[] | undefined =>
  v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
/** A positive integer from a query value, else the fallback — never NaN into the engine. */
const posIntOr = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
/** An ISO date (YYYY-MM-DD) from a query value, else the fallback — the engine compares dates as strings. */
const isoDateOr = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : fallback;

export interface RiskRegisterDeps {
  readonly risk: (tenantId: string, riskId: string) => Promise<Risk | undefined> | Risk | undefined;
  /** Every risk on the register — the gate-blocking reads fold over these. */
  readonly risks: (tenantId: string) => Promise<readonly Risk[]> | readonly Risk[];
  /** Append one state of a risk — append-only (register, then accept, is the audit trail). */
  readonly recordRisk: (tenantId: string, riskId: string, risk: Risk, key: string) => Promise<void> | void;
  // --- FR-04 follow-on: the incident / remediation / control-health / attestation registers ---
  /** Every control on the register — incidents link to these, and control-health folds over them. */
  readonly controls: (tenantId: string) => Promise<readonly Control[]> | readonly Control[];
  readonly saveControl: (tenantId: string, controlId: string, control: Control, key: string) => Promise<void> | void;
  readonly incidents: (tenantId: string) => Promise<readonly Incident[]> | readonly Incident[];
  readonly saveIncident: (tenantId: string, incidentId: string, incident: Incident, key: string) => Promise<void> | void;
  readonly remediations: (tenantId: string) => Promise<readonly Remediation[]> | readonly Remediation[];
  readonly saveRemediation: (tenantId: string, remediationId: string, remediation: Remediation, key: string) => Promise<void> | void;
  readonly attestations: (tenantId: string) => Promise<readonly Attestation[]> | readonly Attestation[];
  readonly saveAttestation: (tenantId: string, attestationId: string, attestation: Attestation, key: string) => Promise<void> | void;
  readonly now: () => string;
}

// A stable digest so any real change to a risk is a new append-only fact, but an exact re-send collapses.
const digestOf = (r: Risk): string =>
  [r.title, r.severity, r.status, r.ownerUserId, (r.controlIds ?? []).join('.'), (r.blocksGates ?? []).join('.'), r.acceptedBy ?? '', r.acceptanceRationale ?? ''].join('|');
const controlDigest = (c: Control): string => [c.title, c.implements, c.ownerUserId].join('|');
const incidentDigest = (i: Incident): string =>
  [i.title, i.severity, i.occurredAt, i.detectedAt, i.controlId, (i.remediationIds ?? []).join('.'), i.closedAt ?? ''].join('|');
const remediationDigest = (r: Remediation): string =>
  [r.incidentId, r.action, r.ownerUserId, r.dueOn, r.completedAt ?? ''].join('|');
const attestationDigest = (a: Attestation): string => [a.controlId, a.attestedBy, a.attestedAt, a.statement].join('|');

export function riskRegisterRoutes(deps: RiskRegisterDeps): readonly Route[] {
  return [
    {
      // Register (or re-state) a risk. Body: { title, severity, status?, ownerUserId, controlIds?,
      // blocksGates? }. `status` may not be `accepted` — that goes through the acceptance route.
      api: 'API-11', method: 'POST', path: '/v1/compliance/risks/:riskId',
      permission: 'compliance.risk.manage', idempotent: true,
      handler: async (ctx) => {
        const riskId = (ctx.params['riskId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const controlIds = strArray(b['controlIds']);
        const blocksGates = strArray(b['blocksGates']);
        const status = (b['status'] as RiskStatus | undefined) ?? 'open';
        if (riskId === '' || !isStr(b['title']) || !SEVERITIES.includes(b['severity'] as RiskSeverity)
          || !isStr(b['ownerUserId']) || controlIds === undefined || blocksGates === undefined
          || (b['status'] !== undefined && !REGISTERABLE.includes(b['status'] as RiskStatus))) {
          throw apiError(400, {
            code: 'not_readable_as_a_risk',
            whatHappened: 'A risk needs a riskId in the path and { title, severity (critical/high/medium/low), ownerUserId, status? (open/mitigated/closed — NOT accepted), controlIds?, blocksGates? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: b['status'] === 'accepted'
              ? 'To accept a risk use POST …/acceptance, which records who accepted it and why.'
              : 'Send the risk with a named owner and its severity.',
          });
        }
        const risk: Risk = {
          riskId, title: b['title'] as string, severity: b['severity'] as RiskSeverity, status,
          controlIds, ownerUserId: b['ownerUserId'] as string, ...(blocksGates.length > 0 ? { blocksGates } : {}),
        };
        await deps.recordRisk(ctx.tenantId, riskId, risk, digestOf(risk));
        return { status: 201, body: { riskId, severity: risk.severity, status: risk.status, blocksGates: risk.blocksGates ?? [] } };
      },
    },
    {
      // Accept a risk — in the caller's OWN name, with a written rationale. An accepted risk no longer
      // blocks its gates (acceptance is a recorded decision, not silence). Body: { rationale }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/risks/:riskId/acceptance',
      permission: 'compliance.risk.manage', idempotent: true,
      handler: async (ctx) => {
        const riskId = ctx.params['riskId'] ?? '';
        const rationale = (ctx.body as { rationale?: unknown } | null)?.rationale;
        if (!isStr(rationale)) {
          throw apiError(400, {
            code: 'acceptance_needs_a_rationale',
            whatHappened: 'Accepting a risk is a decision — it needs { rationale }, a written reason. The person accepting is taken from your login.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Say, in writing, why this risk is being accepted.',
          });
        }
        const existing = await deps.risk(ctx.tenantId, riskId);
        if (existing === undefined) throw notFound(`risk ${riskId}`);
        // acceptedBy is the authenticated caller — you accept in your own name (§28). The engine enforces
        // that neither the name nor the reason is blank.
        const accepted = acceptRisk(existing, ctx.userId, rationale);
        await deps.recordRisk(ctx.tenantId, riskId, accepted, digestOf(accepted));
        return { status: 200, body: { riskId, status: accepted.status, acceptedBy: accepted.acceptedBy } };
      },
    },
    {
      // The quality gates that cannot pass right now, and why — one row per (gate, open-critical-risk).
      api: 'API-11', method: 'GET', path: '/v1/compliance/gates/blocked',
      permission: 'compliance.risk.read',
      handler: async (ctx) => {
        const blocks = blockedGates(await deps.risks(ctx.tenantId));
        return { status: 200, body: { blocked: blocks, count: blocks.length, asAt: deps.now() } };
      },
    },
    {
      // Can this named gate pass? True when nothing open-and-critical is registered against it.
      api: 'API-11', method: 'GET', path: '/v1/compliance/gates/:gate/can-pass',
      permission: 'compliance.risk.read',
      handler: async (ctx) => {
        const gate = ctx.params['gate'] ?? '';
        const risks = await deps.risks(ctx.tenantId);
        return { status: 200, body: { gate, canPass: gateCanPass(gate, risks), blockedBy: blockedGates(risks).filter((b) => b.gate === gate) } };
      },
    },
    {
      // The whole risk register.
      api: 'API-11', method: 'GET', path: '/v1/compliance/risks',
      permission: 'compliance.risk.read',
      handler: async (ctx) => {
        const risks = await deps.risks(ctx.tenantId);
        return { status: 200, body: { risks, count: risks.length } };
      },
    },

    // ---- FR-04 follow-on: the incident / remediation / control-health / attestation registers ----

    {
      // Register a control — the thing meant to hold a risk down. Incidents and attestations link to it,
      // so it must exist before either can name it. Body: { title, implements, ownerUserId }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/controls/:controlId',
      permission: 'compliance.risk.manage', idempotent: true,
      handler: async (ctx) => {
        const controlId = (ctx.params['controlId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (controlId === '' || !isStr(b['title']) || !isStr(b['implements']) || !isStr(b['ownerUserId'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_control',
            whatHappened: 'A control needs a controlId in the path and { title, implements, ownerUserId } — what it is, which requirement or principle it implements, and who owns it.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the control with a named owner and the requirement it implements.',
          });
        }
        const control: Control = { controlId, title: b['title'] as string, implements: b['implements'] as string, ownerUserId: b['ownerUserId'] as string };
        await deps.saveControl(ctx.tenantId, controlId, control, controlDigest(control));
        return { status: 201, body: { controlId, ownerUserId: control.ownerUserId } };
      },
    },
    {
      // Record an incident — it MUST name a registered control (the one that was supposed to stop it). An
      // incident that links to nothing teaches nothing. Body: { title, severity (sev1/2/3), occurredAt,
      // detectedAt, controlId, remediationIds?, closedAt? }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/incidents/:incidentId',
      permission: 'compliance.risk.manage', idempotent: true,
      handler: async (ctx) => {
        const incidentId = (ctx.params['incidentId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const remediationIds = strArray(b['remediationIds']);
        if (incidentId === '' || !isStr(b['title']) || !INCIDENT_SEVERITIES.includes(b['severity'] as IncidentSeverity)
          || !isStr(b['occurredAt']) || !isStr(b['detectedAt']) || !isStr(b['controlId']) || remediationIds === undefined
          || (b['closedAt'] !== undefined && !isStr(b['closedAt']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_incident',
            whatHappened: 'An incident needs an incidentId in the path and { title, severity (sev1/sev2/sev3), occurredAt, detectedAt, controlId, remediationIds?, closedAt? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the incident naming the control that should have prevented it.',
          });
        }
        const incident: Incident = {
          incidentId, title: b['title'] as string, severity: b['severity'] as IncidentSeverity,
          occurredAt: b['occurredAt'] as string, detectedAt: b['detectedAt'] as string, controlId: b['controlId'] as string,
          ...(remediationIds.length > 0 ? { remediationIds } : {}), ...(isStr(b['closedAt']) ? { closedAt: b['closedAt'] as string } : {}),
        };
        // The engine insists on the link to a REGISTERED control (UnlinkedIncidentError). That is the whole
        // point — an incident naming a control nobody registered is a note, not evidence.
        try {
          recordIncident(incident, await deps.controls(ctx.tenantId));
        } catch (e) {
          if (e instanceof UnlinkedIncidentError) {
            throw apiError(422, {
              code: 'incident_links_to_no_control',
              whatHappened: `The incident names control "${incident.controlId}", which is not on the register — an incident that links to nothing teaches nothing.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Register the control first (POST …/controls/:controlId), then record the incident against it.',
            });
          }
          throw e;
        }
        await deps.saveIncident(ctx.tenantId, incidentId, incident, incidentDigest(incident));
        return { status: 201, body: { incidentId, controlId: incident.controlId, severity: incident.severity } };
      },
    },
    {
      // Record a remediation — it MUST name a registered incident, AND an owner, AND a due date. A
      // remediation with no owner is a wish; one that fixes an incident nobody logged is unmoored. Body:
      // { incidentId, action, ownerUserId, dueOn, completedAt? }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/remediations/:remediationId',
      permission: 'compliance.risk.manage', idempotent: true,
      handler: async (ctx) => {
        const remediationId = (ctx.params['remediationId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        // ownerUserId and dueOn are checked only for PRESENCE here — the tested engine (`recordRemediation`)
        // is the authority on "an owner and a date, or it is a wish", so a blank one reaches it and returns
        // the engine's 422, never a structural 400 that would duplicate the rule.
        if (remediationId === '' || !isStr(b['incidentId']) || !isStr(b['action'])
          || typeof b['ownerUserId'] !== 'string' || typeof b['dueOn'] !== 'string'
          || (b['completedAt'] !== undefined && !isStr(b['completedAt']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_remediation',
            whatHappened: 'A remediation needs a remediationId in the path and { incidentId, action, ownerUserId, dueOn, completedAt? }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the remediation naming the incident it fixes, an owner, and a due date.',
          });
        }
        // Link integrity: the incident must be on the register (parallel to incident → control).
        const incidents = await deps.incidents(ctx.tenantId);
        if (!incidents.some((i) => i.incidentId === b['incidentId'])) {
          throw apiError(422, {
            code: 'remediation_links_to_no_incident',
            whatHappened: `The remediation names incident "${b['incidentId'] as string}", which is not on the register.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Record the incident first (POST …/incidents/:incidentId), then its remediation.',
          });
        }
        const remediation: Remediation = {
          remediationId, incidentId: b['incidentId'] as string, action: b['action'] as string,
          ownerUserId: b['ownerUserId'] as string, dueOn: b['dueOn'] as string,
          ...(isStr(b['completedAt']) ? { completedAt: b['completedAt'] as string } : {}),
        };
        // The engine insists on a named owner and a date (UnownedRemediationError).
        try {
          recordRemediation(remediation);
        } catch (e) {
          if (e instanceof UnownedRemediationError) {
            throw apiError(422, {
              code: 'remediation_needs_owner_and_date',
              whatHappened: 'A remediation with no owner or no due date is a wish, not a plan.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Give the remediation a named owner and a due date.',
            });
          }
          throw e;
        }
        await deps.saveRemediation(ctx.tenantId, remediationId, remediation, remediationDigest(remediation));
        return { status: 201, body: { remediationId, incidentId: remediation.incidentId, dueOn: remediation.dueOn } };
      },
    },
    {
      // Attest a control — a dated statement, in the caller's OWN name, that someone checked it works. A
      // tick with no date, or nobody's name, is not evidence (§28). It MUST name a registered control.
      // Body: { controlId, statement, attestedAt? } — attestedAt defaults to now.
      api: 'API-11', method: 'POST', path: '/v1/compliance/attestations/:attestationId',
      permission: 'compliance.risk.manage', idempotent: true,
      handler: async (ctx) => {
        const attestationId = (ctx.params['attestationId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (attestationId === '' || !isStr(b['controlId']) || !isStr(b['statement'])
          || (b['attestedAt'] !== undefined && !isStr(b['attestedAt']))) {
          throw apiError(400, {
            code: 'not_readable_as_an_attestation',
            whatHappened: 'An attestation needs an attestationId in the path and { controlId, statement, attestedAt? }. The person attesting is taken from your login.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Name the control you checked and state, in writing, what you checked.',
          });
        }
        const controlId = b['controlId'] as string;
        if (!(await deps.controls(ctx.tenantId)).some((c) => c.controlId === controlId)) {
          throw apiError(422, {
            code: 'attestation_links_to_no_control',
            whatHappened: `The attestation names control "${controlId}", which is not on the register — attesting a control that does not exist checks nothing.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Register the control first, then attest it.',
          });
        }
        // attestedBy is the authenticated caller — you attest in your own name (§28), never a client field.
        const attestation: Attestation = {
          attestationId, controlId, attestedBy: ctx.userId,
          attestedAt: isStr(b['attestedAt']) ? (b['attestedAt'] as string) : deps.now(),
          statement: b['statement'] as string,
        };
        await deps.saveAttestation(ctx.tenantId, attestationId, attestation, attestationDigest(attestation));
        return { status: 201, body: { attestationId, controlId, attestedBy: attestation.attestedBy, attestedAt: attestation.attestedAt } };
      },
    },
    {
      // The state of every control: has it failed (incidents), is the fix late (overdue remediations), and
      // has anyone actually checked it lately (attestation staleness)? A control nobody has ever attested is
      // reported `needsAttestation` — an untested control is an assumption, not a control. Query: asOf?
      // (defaults today), validDays? (attestations older than this are stale; defaults 90).
      api: 'API-11', method: 'GET', path: '/v1/compliance/controls/health',
      permission: 'compliance.risk.read',
      handler: async (ctx) => {
        const asOfDate = isoDateOr(ctx.query['asOf'], deps.now().slice(0, 10));
        const attestationValidDays = posIntOr(ctx.query['validDays'], 90);
        const [controls, incidents, remediations, attestations] = await Promise.all([
          deps.controls(ctx.tenantId), deps.incidents(ctx.tenantId), deps.remediations(ctx.tenantId), deps.attestations(ctx.tenantId),
        ]);
        const health = controlHealth({ controls, incidents, remediations, attestations, asOfDate, attestationValidDays });
        return { status: 200, body: { health, count: health.length, asOf: asOfDate, attestationValidDays, needingAttestation: health.filter((h) => h.needsAttestation).length } };
      },
    },
    {
      // The follow-through report: remediation past its due date and still not done. Query: asOf? (today).
      api: 'API-11', method: 'GET', path: '/v1/compliance/remediations/overdue',
      permission: 'compliance.risk.read',
      handler: async (ctx) => {
        const asOfDate = isoDateOr(ctx.query['asOf'], deps.now().slice(0, 10));
        const overdue = overdueRemediations(await deps.remediations(ctx.tenantId), asOfDate);
        return { status: 200, body: { overdue, count: overdue.length, asOf: asOfDate } };
      },
    },
  ];
}
