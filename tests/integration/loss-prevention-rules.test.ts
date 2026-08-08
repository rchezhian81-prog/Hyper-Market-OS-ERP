import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Loss-prevention anomaly rules & detection (M15-FR-01, API-05) end to end through the real API.
// "Control by exception" (P-03): a store configures its OWN thresholds as DATA (no code), and activity
// — voids, refunds, discounts, no-sales, cash variances, already synced from the lanes — is evaluated
// against them into exceptions that LINK back to the transactions. DETECT-ONLY: nothing is blocked or
// sanctioned (AI-NFR-12); a raised exception is what opens a case (M15-FR-04).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-08-08T10:00:00Z';

const setRule = (h: ApiHarness, t: string, u: string, kind: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/loss-prevention/rules/${kind}`, userId: u, tenantId: t, idempotencyKey: key ?? `rule-${kind}`, body });
const getRules = (h: ApiHarness, t: string, u: string) =>
  h.request({ method: 'GET', path: `/v1/loss-prevention/rules`, userId: u, tenantId: t });
const evaluate = (h: ApiHarness, t: string, u: string, events: unknown, key?: string) =>
  h.request({ method: 'POST', path: `/v1/loss-prevention/evaluate`, userId: u, tenantId: t, idempotencyKey: key ?? `eval-${String((events as unknown[]).length)}-${u}`, body: { events } });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Exc { cashierId: string; kind: string; breach: string; observed: number; limit: number; severity: string; linkedTxnIds: string[] }
const excs = (res: { body: unknown }): Exc[] => (res.body as { exceptions: Exc[] }).exceptions;

const voids = (n: number, cashier = 'c1') => Array.from({ length: n }, (_, i) => ({ txnId: `v${i + 1}`, kind: 'void', cashierId: cashier, valueMinor: 5_000, at: AT }));

describe('loss-prevention rules: configurable thresholds, activity evaluated into linked exceptions, detect-only (M15-FR-01)', () => {
  it('configures rules as data and evaluates activity into linked exceptions', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    expect((await setRule(h, A, 'u-owner', 'void', { maxCount: 3, escalateAtMultiple: 2 })).status).toBe(201);
    expect((await setRule(h, A, 'u-owner', 'refund', { maxSingleValueMinor: 100_000 })).status).toBe(201);
    expect(((await getRules(h, A, 'u-owner')).body as { rules: unknown[] }).rules).toHaveLength(2);

    // 4 voids (over the count of 3, below the ×2 escalate) + one big refund (over the single-value limit).
    const events = [...voids(4), { txnId: 'r1', kind: 'refund', cashierId: 'c1', valueMinor: 150_000, at: AT }];
    const out = excs(await evaluate(h, A, 'u-owner', events));

    const vc = out.find((e) => e.kind === 'void' && e.breach === 'count');
    expect(vc).toMatchObject({ cashierId: 'c1', observed: 4, limit: 3, severity: 'flag' });
    expect(vc?.linkedTxnIds).toEqual(['v1', 'v2', 'v3', 'v4']);   // links back to the transactions

    const rs = out.find((e) => e.kind === 'refund' && e.breach === 'single_value');
    expect(rs).toMatchObject({ observed: 150_000, limit: 100_000, severity: 'flag' });
    expect(rs?.linkedTxnIds).toEqual(['r1']);
  });

  it('escalates a spike above the multiple, and raises nothing for a kind with no rule', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await setRule(h, A, 'u-owner', 'void', { maxCount: 3, escalateAtMultiple: 2 });

    // 6 voids = 2× the limit → escalate, not merely flag.
    const spike = excs(await evaluate(h, A, 'u-owner', voids(6)));
    expect(spike.find((e) => e.breach === 'count')?.severity).toBe('escalate');

    // Refunds with no refund rule configured → no refund exceptions (a store enables only what it wants).
    const withRefunds = excs(await evaluate(h, A, 'u-owner', [{ txnId: 'r1', kind: 'refund', cashierId: 'c1', valueMinor: 999_999, at: AT }], 'eval-refunds'));
    expect(withRefunds.filter((e) => e.kind === 'refund')).toHaveLength(0);
  });

  it('is authorized (rule.manage vs read/evaluate), per-tenant, and refuses malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // configures and evaluates
    await h.provisionRole(A, 'u-acct', 'accountant');     // reads/evaluates, does NOT configure
    await h.provisionRole(A, 'u-cash', 'cashier');        // neither

    expect((await setRule(h, A, 'u-mgr', 'void', { maxCount: 3 })).status).toBe(201);
    expect((await setRule(h, A, 'u-acct', 'refund', { maxCount: 3 })).status).toBe(403);   // no lp.rule.manage
    expect((await setRule(h, A, 'u-cash', 'refund', { maxCount: 3 })).status).toBe(403);
    expect((await evaluate(h, A, 'u-acct', voids(4), 'eval-acct')).status).toBe(200);       // an accountant may evaluate
    expect((await evaluate(h, A, 'u-cash', voids(4), 'eval-cash')).status).toBe(403);

    // A rule with no limit never fires; an unknown kind is refused.
    expect(codeOf(await setRule(h, A, 'u-owner', 'discount', {}, 'rule-empty'))).toBe('rule_has_no_limit');
    expect((await setRule(h, A, 'u-owner', 'nonsense', { maxCount: 1 }, 'rule-bad')).status).toBe(404);

    // Another tenant has no rules — the same activity raises nothing.
    await h.seedOwner(B, 'u-owner-b');
    expect(excs(await evaluate(h, B, 'u-owner-b', voids(9), 'eval-b'))).toHaveLength(0);
  });
});
