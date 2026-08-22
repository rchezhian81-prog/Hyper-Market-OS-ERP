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
// Held as a named follow-on: the incident / remediation / attestation / control-health legs of FR-04
// (`recordIncident` / `recordRemediation` / `controlHealth` / `overdueRemediations`) — this increment is
// the risk-register-and-gate core, the part the gates actually read.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  acceptRisk, blockedGates, gateCanPass,
  type Risk, type RiskSeverity, type RiskStatus,
} from '../../../packages/compliance/src/index';

export type { Risk } from '../../../packages/compliance/src/index';

const SEVERITIES: readonly RiskSeverity[] = ['critical', 'high', 'medium', 'low'];
// A register may set any status EXCEPT accepted — acceptance carries a mandatory rationale and a named
// author, so it cannot be back-doored through a plain register.
const REGISTERABLE: readonly RiskStatus[] = ['open', 'mitigated', 'closed'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const strArray = (v: unknown): readonly string[] | undefined =>
  v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

export interface RiskRegisterDeps {
  readonly risk: (tenantId: string, riskId: string) => Promise<Risk | undefined> | Risk | undefined;
  /** Every risk on the register — the gate-blocking reads fold over these. */
  readonly risks: (tenantId: string) => Promise<readonly Risk[]> | readonly Risk[];
  /** Append one state of a risk — append-only (register, then accept, is the audit trail). */
  readonly recordRisk: (tenantId: string, riskId: string, risk: Risk, key: string) => Promise<void> | void;
  readonly now: () => string;
}

// A stable digest so any real change to a risk is a new append-only fact, but an exact re-send collapses.
const digestOf = (r: Risk): string =>
  [r.title, r.severity, r.status, r.ownerUserId, (r.controlIds ?? []).join('.'), (r.blocksGates ?? []).join('.'), r.acceptedBy ?? '', r.acceptanceRationale ?? ''].join('|');

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
  ];
}
