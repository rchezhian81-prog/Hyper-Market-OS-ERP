import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TEST_IDP } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';
import { pushFindings } from '../../scripts/lib/push-findings.mjs';
import { MACHINE_IDENTITY_REFUSAL_CODE } from '../../services/identity/src/machine-identities';

// OB-331 (owner, 23 Oct 2026, in writing): the CI scan findings reach head office's findings register by an automatic,
// authenticated push — the CI scanner's own machine identity (role findings_push, machine-only, nothing else). The push
// script (scripts/lib/push-findings.mjs, the CI step's own code) is driven here against the real API: a run is recorded
// once, the findings it reports are on the register, a re-push is "already there", and no person — not even the owner
// who holds the right only to approve the grant — can push. With no key the script says so and sends nothing. In memory
// and on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const report = (runId: string) => ({
  tool: 'semgrep', source: 'sast', runId, scannedAt: new Date().toISOString(), commit: 'a'.repeat(40), complete: true,
  observations: [{ fingerprint: 'fp-sqli-1', tool: 'semgrep', source: 'sast', ruleId: 'js.sqli', title: 'SQL built from input', severity: 'high', location: 'services/x.ts:12' }],
});

describe.each(backings)('the CI scanner pushes its findings to the register (OB-331) — on $name', ({ harness }) => {
  it('pushed under the machine identity: recorded once, the finding on the register; a person is refused; no key sends nothing', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'ci-scanner', 'findings_push');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    // The CI step's fetch reaches the real API (the token is a MACHINE credential: no interactive sign-in evidence).
    const machineToken = TEST_IDP.issue({ sub: 'ci-scanner', tenantId: T, authTimeFromNowSeconds: null, amr: null });
    const shim = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      const res = await h.raw({ method: init.method as 'POST', path: new URL(url).pathname, token: init.headers['authorization']!.replace(/^Bearer /, ''), idempotencyKey: init.headers['idempotency-key'], body: JSON.parse(init.body) });
      return { status: res.status };
    }) as unknown as typeof fetch;
    const files: Record<string, string> = { 'semgrep.findings.json': JSON.stringify(report('gh-1-1')) };
    const said: string[] = [];
    const push = (env: Record<string, string>) => pushFindings({ env, reports: Object.keys(files), read: async (f: string) => files[f]!, fetch: shim, say: (l: string) => { said.push(l); } });

    // No key: nothing sent, said visibly.
    expect(await push({ FINDINGS_REGISTER_URL: 'https://ho.example.test' })).toMatchObject({ sent: 0, why: 'no_key_set' });
    expect(said.at(-1)).toContain('findings not sent: no key set');

    const env = { FINDINGS_PUSH_TOKEN: machineToken, FINDINGS_REGISTER_URL: 'https://ho.example.test' };
    expect(await push(env)).toMatchObject({ sent: 1, notSent: 0, results: [{ outcome: 'sent' }] });
    expect(said.join('\n')).not.toContain(machineToken);

    h = harness(h); // ── cold restart ──
    // A re-push of the same run is one run: the stored reply replayed (same idempotency key) or "already on the register".
    const again = await push(env);
    expect(again.sent).toBe(1);
    expect(['sent', 'already_recorded']).toContain(again.results[0]!.outcome);
    const scans = (await h.request({ method: 'GET', path: '/v1/compliance/finding-scans', userId: 'u-mgr', tenantId: T })).body as { scans: { runId: string; importedBy: string; pushedByCi?: boolean }[] };
    expect(scans.scans).toEqual([expect.objectContaining({ runId: 'gh-1-1', importedBy: 'ci-scanner', pushedByCi: true })]);
    const register = (await h.request({ method: 'GET', path: '/v1/compliance/findings', userId: 'u-mgr', tenantId: T })).body as { findings: { severity: string; status: string }[] };
    expect(register.findings).toEqual([expect.objectContaining({ severity: 'high', status: 'open' })]);

    // No person pushes: the owner (who holds the right only to approve the grant) and a manager (no right at all).
    const asPerson = (userId: string) => h.request({ method: 'POST', path: '/v1/compliance/finding-scans/pushed', userId, tenantId: T, idempotencyKey: `p-${userId}`, body: { report: report(`gh-2-${userId}`) } });
    const owner = await asPerson('u-owner');
    expect(owner.status).toBe(403);
    expect((owner.body as { error: { code: string } }).error.code).toBe('not_the_ci_scanner_identity');
    expect((await asPerson('u-mgr')).status).toBe(403);
    // The machine identity is machine-only: it can never be given a person's role beside it.
    const mixed = await h.request({ method: 'POST', path: '/v1/identity/grants', userId: 'u-mgr', tenantId: T, idempotencyKey: 'mix', body: { grantId: 'g-mix', userId: 'ci-scanner', roleId: 'cashier', branchScope: 'all', reason: 'x' } });
    expect(JSON.stringify(mixed.body)).toContain(MACHINE_IDENTITY_REFUSAL_CODE);
    // A bad token is refused by the API, and the script says the findings were not sent — it never throws.
    const bad = await push({ ...env, FINDINGS_PUSH_TOKEN: 'not-a-token' });
    expect(bad).toMatchObject({ sent: 0, results: [{ outcome: 'refused', status: 401 }] });
  }, 120_000);
});
