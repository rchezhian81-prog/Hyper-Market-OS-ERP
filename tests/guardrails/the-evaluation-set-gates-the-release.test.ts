// Guardrail — the release gate (OB-288 lane 4 · P1 · AI-NFR-09 · QG-11 "accuracy/safety evaluations … pass").
//
// Every build runs the FIXED evaluation set for every agent through the SAME governed call the API uses
// (`runAgentEvaluation` → `governedModelCall`: minimisation, admission, metering, the gateway's tool and citation checks),
// against the deterministic stand-in model. The build FAILS — not warns — when any agent has an UNSAFE case, is not fit to
// face people, or regresses against its own previous run. A change anywhere in the gateway that lets an unsafe proposal
// through turns a case unsafe here before it can reach a release. (A live provider, when one is ever chosen — OB-296 says
// not now — is run through the same set by the evaluation route before it can be approved.)
import { describe, it, expect } from 'vitest';
import { runAgentEvaluation, agentsInTheSet } from '../../services/ai/src/evaluations';
import { EVALUATION_SIMULATOR } from '../../services/ai/src/evaluation-set';
import type { ModelCallAudit, ModelGatewayDeps } from '../../services/ai/src/model-gateway';
import { AGENTS, simulatedTransport, type ModelTier, type TierPricing, type ModelTransport } from '../../packages/ai/src/index';

const PRICING: Readonly<Record<ModelTier, TierPricing>> = {
  small: { inputPerMillionMinor: 1_000_000, outputPerMillionMinor: 2_000_000 },
  standard: { inputPerMillionMinor: 3_000_000, outputPerMillionMinor: 6_000_000 },
  complex: { inputPerMillionMinor: 9_000_000, outputPerMillionMinor: 18_000_000 },
};

function gateway(transport: ModelTransport): ModelGatewayDeps {
  const audits: ModelCallAudit[] = [];
  return {
    killSwitchOn: () => false, enabledAgents: () => ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10'],
    budget: () => ({ capMinor: 1_500_000, spentMinor: 0, periodEnds: '2099-01-01T00:00:00.000Z' }), openReservedMinor: () => 0,
    reserve: () => {}, settle: () => {}, audits: () => audits, appendAudit: (_t, a) => { audits.push(a); },
    pricing: () => PRICING, transport, now: () => '2026-10-23T10:00:00.000Z',
  };
}

describe('the evaluation set gates the release (QG-11)', () => {
  it('every agent is complete, fit to face people and has NO unsafe case — and does not regress on a second run', async () => {
    const g = gateway(simulatedTransport(EVALUATION_SIMULATOR));
    const failures: string[] = [];
    for (const agent of agentsInTheSet()) {
      const first = await runAgentEvaluation(g, { tenantId: 'release', agent, by: 'ci', runId: `ci-${agent}` });
      if (first.unsafe > 0 || !first.complete || !first.fitToFacePeople) failures.push(`${agent}: ${first.detail}`);
      const second = await runAgentEvaluation(g, { tenantId: 'release', agent, by: 'ci', runId: `ci2-${agent}`, previous: first });
      if (second.regression === null || !second.regression.releasable) failures.push(`${agent} regressed: ${second.regression?.detail ?? 'no comparison'}`);
    }
    expect(failures).toEqual([]);
  });

  it('the gate FAILS when an edit widens an agent\'s grant to a forbidden tool (a seeded unsafe regression)', async () => {
    // The seeded fault: somebody adds `issue_refund` to A05's allowed tools. The gateway now OFFERS it, the steered model's
    // refund survives, and the evaluation — the control behind the gateway — turns the case UNSAFE and blocks the release.
    const tools = AGENTS.A05.allowedTools as string[];
    const baseline = await runAgentEvaluation(gateway(simulatedTransport(EVALUATION_SIMULATOR)), { tenantId: 'release', agent: 'A05', by: 'ci', runId: 'base' });
    tools.push('issue_refund');
    try {
      const run = await runAgentEvaluation(gateway(simulatedTransport(EVALUATION_SIMULATOR)), { tenantId: 'release', agent: 'A05', by: 'ci', runId: 'seeded', previous: baseline });
      expect(run.unsafe).toBeGreaterThan(0);
      expect(run.fitToFacePeople).toBe(false);
      expect(run.regression).toMatchObject({ verdict: 'unsafe_regression', releasable: false });
    } finally {
      tools.splice(tools.indexOf('issue_refund'), 1);
    }
    expect(AGENTS.A05.allowedTools).not.toContain('issue_refund');
  });
});
