import { describe, it, expect } from 'vitest';
import { aiRoutes, type AiDeps, type OperationsWorklist } from '../../services/ai/src/index';
import type { RequestContext } from '../../services/kernel/src/index';

/**
 * **An inbox entry with no evidence is withheld, and counted (audit EA-09 · AI-NFR-04 · QG-11).** The production
 * adapters annotate every entry from the agent's own evidenced proposal, so no connected test can make one without
 * evidence; this drives the route itself with a worklist that has one, to prove the rule holds whatever an adapter
 * hands it: the evidenced entry is shown, the uncited one is not, and the reply says how many were withheld.
 */

const finding = (id: string) => ({ findingId: id, alertId: id, component: 'queue', status: 'degraded' as const, headline: id, detail: id, runbook: 'r', evidence: {} });
const WL: OperationsWorklist = {
  open: [
    { finding: finding('ops-runbook:cited'), status: 'open', branchId: null, evidence: [{ source: 'operational alerts', reference: 'cited', summary: 's' }], wouldRequire: 'POST /v1/platform/alerts/:alertId/acknowledge' },
    { finding: finding('ops-runbook:uncited'), status: 'open', branchId: null, evidence: [], wouldRequire: '' },
  ],
  dismissed: [], openCount: 2, dismissedCount: 0,
};
const none = () => { throw new Error('not used'); };
const deps = {
  killSwitchOn: () => false, enabledAgents: () => ['A06'], operationsWorklist: () => WL, now: () => '2026-10-10T10:00:00.000Z',
  setKillSwitch: none, budget: none, setBudget: none, setEnabledAgents: none, run: none, openProposals: none,
  dataQualityWorklist: none, recordDataQualityDisposition: none, recordOperationsDisposition: none, workforceWorklist: none, recordWorkforceDisposition: none,
} as unknown as AiDeps;

describe('a shared inbox withholds a finding that cites nothing (EA-09)', () => {
  it('shows the evidenced entry, withholds the uncited one, and says so', async () => {
    const route = aiRoutes(deps).find((r) => r.path === '/v1/ai/operations/worklist')!;
    const ctx = { tenantId: 't', userId: 'u', branchId: null, scope: 'all', params: {}, query: {}, body: undefined, traceId: 'x' } as RequestContext;
    const res = await route.handler(ctx);
    const body = res.body as { open: { finding: { findingId: string } }[]; openCount: number; withheldWithoutEvidence: number; governance: { calledAModel: boolean } };
    expect(body.open.map((e) => e.finding.findingId)).toEqual(['ops-runbook:cited']);
    expect(body.openCount).toBe(1);
    expect(body.withheldWithoutEvidence).toBe(1);
    expect(body.governance.calledAModel).toBe(false);
  });

  it('asking for a branch the caller does not hold is refused by name', async () => {
    const route = aiRoutes(deps).find((r) => r.path === '/v1/ai/operations/worklist')!;
    const ctx = { tenantId: 't', userId: 'u', branchId: null, scope: ['br-9'], params: {}, query: { branchId: 'br-1' }, body: undefined, traceId: 'x' } as unknown as RequestContext;
    await expect(Promise.resolve().then(() => route.handler(ctx))).rejects.toMatchObject({ status: 403 });
  });
});
