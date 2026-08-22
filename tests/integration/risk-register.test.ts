import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Risk register & quality-gate blocking, end to end (M34-FR-04, compliance API). An OPEN CRITICAL risk
// blocks the quality gates it is registered against, and the only way past is not to ignore it but to
// ACCEPT it — in a named person's own name, with a written reason (a decision has an author, §28). An
// accepted risk no longer blocks (acceptance is a recorded decision, not silence). Append-only. Register/
// accept gated compliance.risk.manage; the gate reads compliance.risk.read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const register = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/compliance/risks/${id}`, userId: u, tenantId: A, idempotencyKey: key ?? `reg-${id}`, body });
const accept = (h: ApiHarness, u: string, id: string, rationale: unknown, key?: string) =>
  h.request({ method: 'POST', path: `/v1/compliance/risks/${id}/acceptance`, userId: u, tenantId: A, idempotencyKey: key ?? `acc-${id}`, body: rationale === undefined ? {} : { rationale } });
const blocked = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/compliance/gates/blocked', userId: u, tenantId: A });
const canPass = (h: ApiHarness, u: string, gate: string) =>
  h.request({ method: 'GET', path: `/v1/compliance/gates/${gate}/can-pass`, userId: u, tenantId: A });
const listRisks = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/compliance/risks', userId: u, tenantId: A });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Blocked = { blocked: { gate: string; riskId: string; reason: string }[]; count: number };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // compliance.risk.manage + read
  await h.provisionRole(A, 'u-cash', 'cashier');       // neither
  return h;
}

describe('risk register: an open critical risk blocks its gate until accepted (M34-FR-04)', () => {
  it('blocks a gate on an open critical risk, and unblocks it only on a named, reasoned acceptance', async () => {
    const h = await cast();
    expect((await register(h, 'u-mgr', 'r1', { title: 'unpatched edge OS', severity: 'critical', ownerUserId: 'u-sec', blocksGates: ['QG-06'] })).status).toBe(201);

    const b1 = (await blocked(h, 'u-owner')).body as Blocked;
    expect(b1.count).toBe(1);
    expect(b1.blocked[0]).toMatchObject({ gate: 'QG-06', riskId: 'r1' });
    expect(b1.blocked[0]?.reason).toContain('u-sec'); // names the owner
    expect((await canPass(h, 'u-owner', 'QG-06')).body).toMatchObject({ canPass: false });

    // Accepting is a decision — recorded in the caller's own name, with a reason.
    const acc = await accept(h, 'u-mgr', 'r1', 'residual risk accepted pending external pentest; compensating controls in place');
    expect(acc.status).toBe(200);
    expect(acc.body).toMatchObject({ status: 'accepted', acceptedBy: 'u-mgr' });

    // Accepted no longer blocks (P-08: a recorded decision, not silence).
    expect(((await blocked(h, 'u-owner')).body as Blocked).count).toBe(0);
    expect((await canPass(h, 'u-owner', 'QG-06')).body).toMatchObject({ canPass: true });
  });

  it('blocks only on open AND critical, and refuses an unjustified or back-door acceptance', async () => {
    const h = await cast();
    await register(h, 'u-mgr', 'r-high', { title: 'high but not critical', severity: 'high', ownerUserId: 'u-sec', blocksGates: ['QG-06'] });
    await register(h, 'u-mgr', 'r-mit', { title: 'critical but mitigated', severity: 'critical', status: 'mitigated', ownerUserId: 'u-sec', blocksGates: ['QG-07'] });
    expect(((await blocked(h, 'u-owner')).body as Blocked).count).toBe(0); // neither blocks

    // Acceptance without a written reason is refused; a missing risk is a 404.
    await register(h, 'u-mgr', 'r-c', { title: 'critical', severity: 'critical', ownerUserId: 'u-sec', blocksGates: ['QG-08'] });
    expect(codeOf(await accept(h, 'u-mgr', 'r-c', undefined))).toBe('acceptance_needs_a_rationale');
    expect((await accept(h, 'u-mgr', 'ghost', 'reason')).status).toBe(404);
    // Acceptance cannot be back-doored through a plain register.
    expect(codeOf(await register(h, 'u-mgr', 'r-back', { title: 'x', severity: 'critical', ownerUserId: 'u-sec', status: 'accepted' }))).toBe('not_readable_as_a_risk');
  });

  it('re-registering restates the risk (a downgrade lifts the block), and the list reflects the latest', async () => {
    const h = await cast();
    await register(h, 'u-mgr', 'r2', { title: 'two gates', severity: 'critical', ownerUserId: 'u-sec', blocksGates: ['QG-01', 'QG-02'] });
    expect(((await blocked(h, 'u-owner')).body as Blocked).count).toBe(2);

    // Re-state it as low severity — no longer critical, so it stops blocking.
    await register(h, 'u-mgr', 'r2', { title: 'two gates', severity: 'low', ownerUserId: 'u-sec', blocksGates: ['QG-01', 'QG-02'] }, 'reg-r2-b');
    expect(((await blocked(h, 'u-owner')).body as Blocked).count).toBe(0);
    const list = (await listRisks(h, 'u-owner')).body as { risks: { riskId: string; severity: string }[] };
    expect(list.risks.find((r) => r.riskId === 'r2')?.severity).toBe('low');
  });

  it('is gated to compliance managers, and an acceptance survives a restart', async () => {
    const h = await cast();
    expect((await register(h, 'u-cash', 'x1', { title: 'x', severity: 'critical', ownerUserId: 'u-sec' })).status).toBe(403);
    expect((await blocked(h, 'u-cash')).status).toBe(403);

    await register(h, 'u-mgr', 'r3', { title: 'db backup gap', severity: 'critical', ownerUserId: 'u-sec', blocksGates: ['QG-03'] });
    await accept(h, 'u-mgr', 'r3', 'accepted for the pilot window with daily manual snapshots');

    const restarted = apiHarness({ store: h.store });
    expect((await canPass(restarted, 'u-owner', 'QG-03')).body).toMatchObject({ canPass: true });
    const list = (await listRisks(restarted, 'u-owner')).body as { risks: { riskId: string; status: string }[] };
    expect(list.risks.find((r) => r.riskId === 'r3')?.status).toBe('accepted');
  });
});
