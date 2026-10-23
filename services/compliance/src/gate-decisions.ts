// The gate-decision register on the compliance API (QG-12 · roadmap §22, §36).
//
// "Every gate ends GO, HOLD or REWORK with evidence; silence is not approval." The rules are the tested engine in
// `packages/compliance/src/gate-decisions.ts`; this is its durable, permissioned surface.
//
//   POST /v1/compliance/gate-decisions/:gate/:release   decide a gate for a release        compliance.gate.decide (owner)
//   GET  /v1/compliance/gate-decisions/:gate/:release   that gate's decision history       compliance.gate.read
//   GET  /v1/compliance/gate-register?release=R5        every gate's standing for a release compliance.gate.read
//
// The decider is the authenticated caller (§36: the owner is accountable for GO/HOLD/REWORK) — never a body field.
// A GO is refused (422, naming each blocker) while an open critical/high risk or finding, or a gate check that reads
// HOLD, stands against the gate. A gate nobody decided reads "undecided": there is no default. Append-only.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  decideGate, gateRegister, summariseGateRegister, undecidedGateBlockers, assertGate, assertRelease, RELEASES,
  UnknownGateError, UnknownReleaseError, DecisionNotReadableError, GoWhileBlockedError,
  type GateDecision, type GateBlocker,
} from '../../../packages/compliance/src/index';

export interface GateDecisionDeps {
  readonly decisions: (tenantId: string) => Promise<readonly GateDecision[]> | readonly GateDecision[];
  readonly recordDecision: (tenantId: string, decision: GateDecision) => Promise<void> | void;
  /** Everything that blocks any gate right now: risks, findings, gate checks (QG-08 rehearsals). */
  readonly blockers: (tenantId: string) => Promise<readonly GateBlocker[]> | readonly GateBlocker[];
  /** A fresh, unique decision id. */
  readonly newDecisionId: (gate: string, release: string, at: string) => string;
  readonly now: () => string;
}

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string) =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

function gateAndRelease(params: Readonly<Record<string, string>>): { gate: string; release: string } {
  const gate = (params['gate'] ?? '').trim().toUpperCase();
  const release = (params['release'] ?? '').trim().toUpperCase();
  try {
    assertGate(gate);
    assertRelease(release);
  } catch (e) {
    if (e instanceof UnknownGateError) throw refuse(400, 'unknown_gate', e.message, 'Use QG-01 … QG-12.');
    if (e instanceof UnknownReleaseError) throw refuse(400, 'unknown_release', e.message, `Use one of ${RELEASES.join(', ')}.`);
    throw e;
  }
  return { gate, release };
}

export function gateDecisionRoutes(deps: GateDecisionDeps): readonly Route[] {
  const allBlockers = async (tenantId: string, release: string, decisions: readonly GateDecision[]): Promise<readonly GateBlocker[]> =>
    [...await deps.blockers(tenantId), ...undecidedGateBlockers(decisions, release)];

  return [
    {
      // Decide a gate for a release. Body: { decision: GO|HOLD|REWORK, evidence: [{ label, ref }, …], rationale }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/gate-decisions/:gate/:release',
      permission: 'compliance.gate.decide', idempotent: true,
      handler: async (ctx) => {
        const { gate, release } = gateAndRelease(ctx.params);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const decisions = await deps.decisions(ctx.tenantId);
        const at = deps.now();
        let decision: GateDecision;
        try {
          decision = decideGate({
            decisionId: deps.newDecisionId(gate, release, at), gate, release,
            decision: b['decision'], evidence: b['evidence'], rationale: b['rationale'],
            decidedBy: ctx.userId, decidedAt: at, blockers: await allBlockers(ctx.tenantId, release, decisions),
          });
        } catch (e) {
          if (e instanceof DecisionNotReadableError) {
            throw refuse(400, 'gate_decision_not_readable', `${e.message}.`, 'Send { decision, evidence: [{ label, ref }], rationale }. You decide in your own name.');
          }
          if (e instanceof GoWhileBlockedError) {
            // The message names every blocker; GET …/gate-register lists them one by one.
            throw refuse(422, 'go_refused_while_blocked', `${e.message}.`, 'Clear each blocker first (fix the finding, close or accept the risk, run the missing rehearsal), or record HOLD or REWORK with the evidence.');
          }
          throw e;
        }
        await deps.recordDecision(ctx.tenantId, decision);
        return { status: 201, body: { decision } };
      },
    },
    {
      // One gate's decision history for a release, oldest first (nothing is overwritten; the latest stands).
      api: 'API-11', method: 'GET', path: '/v1/compliance/gate-decisions/:gate/:release',
      permission: 'compliance.gate.read',
      handler: async (ctx) => {
        const { gate, release } = gateAndRelease(ctx.params);
        const history = (await deps.decisions(ctx.tenantId))
          .filter((d) => d.gate === gate && d.release === release)
          .slice().sort((a, z) => (a.decidedAt < z.decidedAt ? -1 : a.decidedAt > z.decidedAt ? 1 : 0));
        return { status: 200, body: { gate, release, history, count: history.length } };
      },
    },
    {
      // Every gate's standing for one release. Query: release (required — R0 … R8). A gate nobody decided reads
      // "undecided" (decision: null); a GO something now blocks reads GO_NOW_BLOCKED.
      api: 'API-11', method: 'GET', path: '/v1/compliance/gate-register',
      permission: 'compliance.gate.read',
      handler: async (ctx) => {
        const release = (ctx.query['release'] ?? '').trim().toUpperCase();
        if (!RELEASES.includes(release)) {
          throw refuse(400, 'register_needs_a_release', `The gate register is read for one release: ?release= one of ${RELEASES.join(', ')}.`, 'Choose the release whose gates you want to see.');
        }
        const decisions = await deps.decisions(ctx.tenantId);
        const blockers = await allBlockers(ctx.tenantId, release, decisions);
        const gates = gateRegister(decisions, release, blockers);
        return { status: 200, body: { release, gates, summary: summariseGateRegister(gates), releases: RELEASES, asAt: deps.now() } };
      },
    },
  ];
}
