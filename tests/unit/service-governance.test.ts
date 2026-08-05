import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps } from '../../services/migration/src/index';
import { mayRun, acceptProposal, aiRoutes, type Budget, type AgentId, type AiDeps, type Proposal } from '../../services/ai/src/index';
import { buildRouter, handle, MemoryIdempotencyStore } from '../../services/kernel/src/index';
import { AccessControl } from '../../packages/rbac/src/rbac';
import { VERIFIES, type DataDomain } from '../../packages/migration/src/extraction';
import type { DomainFinding } from '../../packages/migration/src/verification-report';

// API-12 Migration · API-13 AI — the two governance surfaces.

const NOW = '2026-08-07T12:00:00Z';

const ACCESS = new AccessControl(
  [{
    id: 'all', name: 'All', permissions: [
      'migration.verification.read', 'migration.exception.accept',
      'ai.agent.run', 'ai.proposal.read', 'ai.budget.read', 'ai.killswitch.set',
    ],
  }],
  [{ userId: 'u-owner', roleId: 'all', branchScope: 'all' }],
);

const kernelFor = (routes: ReturnType<typeof migrationRoutes>) => {
  const built = buildRouter(routes);
  expect(built.ok, built.refusals.map((r) => r.detail).join('; ')).toBe(true);
  return {
    router: built.router!,
    authenticate: () => ({ tenantId: 't-sre', userId: 'u-owner', branchId: null }),
    access: ACCESS, idempotency: new MemoryIdempotencyStore(), newTraceId: () => 'trace-1',
  };
};

describe('API-12 — the migration service cannot point at production', () => {
  const findings: readonly DomainFinding[] = (Object.keys(VERIFIES) as DataDomain[]).map((domain) => ({
    domain, verdict: 'proved', figureMinor: 1_000, provedBy: VERIFIES[domain],
    whatItCannotProve: 'the evidence shows what arrived, not that nothing was missed',
    ownerAction: 'nothing',
  }));

  const deps = (over: Partial<MigrationDeps> = {}): MigrationDeps => ({
    target: () => ({ targetId: 'tgt-1', tenantId: 't-sre', kind: 'rehearsal', label: 'migration rehearsal' }),
    findings: () => findings, acceptances: () => [], signatures: () => [],
    recordAcceptance: () => {}, ownerId: () => 'u-owner',
    extractionOperator: () => 'u-operator', now: () => NOW, ...over,
  });

  it('REFUSES every route when the target is production (hard rule #7)', async () => {
    // Checked per request, not once at boot: a target can be re-pointed by configuration between
    // requests, and a check that only ran at startup is worth nothing.
    const k = kernelFor(migrationRoutes(deps({
      target: () => ({ targetId: 'tgt-live', tenantId: 't-sre', kind: 'production', label: 'live' }),
    })));
    for (const path of ['/v1/migration/verification', '/v1/migration/verification/page']) {
      const res = await handle(k, { method: 'GET', path, headers: { authorization: 'Bearer good' } });
      expect(res.status, path).toBe(403);
      expect((res.body as { error: { code: string } }).error.code).toBe('target_is_production');
    }
  });

  it('serves the verification report against a rehearsal target', async () => {
    const k = kernelFor(migrationRoutes(deps()));
    const res = await handle(k, {
      method: 'GET', path: '/v1/migration/verification', headers: { authorization: 'Bearer good' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { proved: number }).proved).toBe(12);
  });

  it('refuses to produce a report covering only some domains', async () => {
    const k = kernelFor(migrationRoutes(deps({ findings: () => findings.slice(0, 4) })));
    const res = await handle(k, {
      method: 'GET', path: '/v1/migration/verification', headers: { authorization: 'Bearer good' },
    });
    expect(res.status).toBe(422);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_every_domain_covered');
  });

  it('REFUSES an exception accepted by anybody but the owner', async () => {
    const k = kernelFor(migrationRoutes(deps()));
    const res = await handle(k, {
      method: 'POST', path: '/v1/migration/acceptances',
      body: { domain: 'batches', acceptedBy: 'u-manager', acceptedOn: NOW, reason: 'a long enough reason to pass' },
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-1' },
    });
    expect(res.status).toBe(403);
    expect((res.body as { error: { whatHappened: string } }).error.whatHappened)
      .toContain('the owner\'s decision and nobody else\'s');
  });

  it('offers no endpoint that marks a domain verified', async () => {
    // A domain becomes verified by its evidence agreeing. Setting the verdict directly is a way to
    // sign the report without doing the work.
    const paths = buildRouter(migrationRoutes(deps())).router!.list().map((r) => `${r.method} ${r.path}`);
    for (const p of paths) expect(p).not.toMatch(/verdict|mark-verified|approve-domain/i);
  });
});

describe('API-13 — nothing an agent produces can commit anything', () => {
  const budget = (over: Partial<Budget> = {}): Budget => ({
    capMinor: 500_000, spentMinor: 100_000, periodEnds: '2026-08-31', ...over,
  });

  it('lets an enabled agent run inside its budget', () => {
    const r = mayRun({
      agent: 'A02', killSwitchOn: false, budget: budget(),
      estimatedCostMinor: 1_000, enabledAgents: ['A02'],
    });
    expect(r.ok).toBe(true);
  });

  it('the KILL SWITCH stops everything and needs nobody\'s approval', () => {
    // A control that needs a second person is a control that does not work at 2am.
    const r = mayRun({
      agent: 'A02', killSwitchOn: true, budget: budget(),
      estimatedCostMinor: 1, enabledAgents: ['A02'],
    });
    expect(r.refusedBecause).toBe('kill_switch_is_on');
    expect(r.detail).toContain('the rest of the system carries on exactly as before');
  });

  it('checks the kill switch BEFORE the budget — a killed agent spends nothing finding out', () => {
    const r = mayRun({
      agent: 'A02', killSwitchOn: true, budget: budget({ spentMinor: 500_000 }),
      estimatedCostMinor: 999_999, enabledAgents: [],
    });
    expect(r.refusedBecause).toBe('kill_switch_is_on');
  });

  it('enforces the budget BEFORE the call, not after it', () => {
    const r = mayRun({
      agent: 'A02', killSwitchOn: false, budget: budget({ spentMinor: 499_000 }),
      estimatedCostMinor: 5_000, enabledAgents: ['A02'],
    });
    expect(r.refusedBecause).toBe('budget_exhausted');
    expect(r.detail).toContain('a limit checked afterwards is a record of the overspend');
  });

  it('refuses an agent that is not switched on for this tenant', () => {
    const r = mayRun({
      agent: 'A07', killSwitchOn: false, budget: budget(),
      estimatedCostMinor: 1, enabledAgents: ['A02'],
    });
    expect(r.refusedBecause).toBe('agent_not_permitted_here');
  });

  it('REFUSES a proposal with no evidence behind it', () => {
    const r = acceptProposal({
      proposalId: 'P-1', agent: 'A02', summary: 'order 40 more cases of ghee',
      wouldRequire: 'POST /v1/purchase/orders', evidence: [], createdAt: NOW,
    });
    expect(r.refusedBecause).toBe('proposal_without_evidence');
    expect(r.detail).toContain('somebody follows because it sounded confident');
  });

  it('marks every accepted proposal as having committed nothing (hard rule #5)', () => {
    const r = acceptProposal({
      proposalId: 'P-1', agent: 'A02', summary: 'order 40 more cases of ghee',
      wouldRequire: 'POST /v1/purchase/orders', createdAt: NOW,
      evidence: [{ source: 'sales history', reference: 'rpt-1188', summary: '40% up over eight weeks' }],
    });
    expect(r.ok).toBe(true);
    const committed: false = r.proposals![0]!.committed;
    expect(committed).toBe(false);
    expect(r.detail).toContain('requires POST /v1/purchase/orders by a person');
  });

  it('offers no way to apply a proposal', async () => {
    // It would be a second path into every domain with none of that domain's controls, and it is
    // precisely the endpoint added "just to save the manager some clicks".
    const service = await import('../../services/ai/src/index');
    for (const name of Object.keys(service)) {
      expect(name).not.toMatch(/apply|commit|execute|writeThrough/i);
    }
  });

  it('answers 503 for a killed agent and 429 for an exhausted budget', async () => {
    const proposal: Omit<Proposal, 'committed'> = {
      proposalId: 'P-1', agent: 'A02', summary: 'a suggestion',
      wouldRequire: 'POST /v1/purchase/orders', createdAt: NOW,
      evidence: [{ source: 's', reference: 'r', summary: 'x' }],
    };
    const deps = (over: Partial<AiDeps> = {}): AiDeps => ({
      killSwitchOn: () => false, setKillSwitch: () => {}, budget: () => budget(),
      enabledAgents: () => ['A02'] as readonly AgentId[], run: () => [proposal],
      openProposals: () => [], now: () => NOW, ...over,
    });

    const killed = kernelFor(aiRoutes(deps({ killSwitchOn: () => true })));
    const a = await handle(killed, {
      method: 'POST', path: '/v1/ai/agents/A02/runs', body: { estimatedCostMinor: 1 },
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-1' },
    });
    expect(a.status).toBe(503);

    const broke = kernelFor(aiRoutes(deps({ budget: () => budget({ spentMinor: 500_000 }) })));
    const b = await handle(broke, {
      method: 'POST', path: '/v1/ai/agents/A02/runs', body: { estimatedCostMinor: 1_000 },
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-2' },
    });
    expect(b.status).toBe(429);
  });

  it('says on every reply that nothing was committed', async () => {
    const deps: AiDeps = {
      killSwitchOn: () => false, setKillSwitch: () => {}, budget: () => budget(),
      enabledAgents: () => ['A02'], openProposals: () => [], now: () => NOW,
      run: () => [{
        proposalId: 'P-1', agent: 'A02', summary: 'a suggestion',
        wouldRequire: 'POST /v1/purchase/orders', createdAt: NOW,
        evidence: [{ source: 's', reference: 'r', summary: 'x' }],
      }],
    };
    const k = kernelFor(aiRoutes(deps));
    const res = await handle(k, {
      method: 'POST', path: '/v1/ai/agents/A02/runs', body: { estimatedCostMinor: 1 },
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-3' },
    });
    expect((res.body as { committedAnything: boolean }).committedAnything).toBe(false);
  });

  it('turns the kill switch on and says what it did to the shop', async () => {
    let on = false;
    const deps: AiDeps = {
      killSwitchOn: () => on, setKillSwitch: (_t, v) => { on = v; }, budget: () => budget(),
      enabledAgents: () => ['A02'], run: () => [], openProposals: () => [], now: () => NOW,
    };
    const k = kernelFor(aiRoutes(deps));
    const res = await handle(k, {
      method: 'PUT', path: '/v1/ai/kill-switch', body: { on: true },
      headers: { authorization: 'Bearer good', 'idempotency-key': 'k-4' },
    });
    expect(res.status).toBe(200);
    expect(on).toBe(true);
    expect((res.body as { effect: string }).effect).toContain('Nothing else in the shop changes');
  });
});
