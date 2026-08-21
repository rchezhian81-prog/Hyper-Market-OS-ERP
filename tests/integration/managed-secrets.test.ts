import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// M32-FR-03 managed secrets on the live API. The surface holds NO secret material — a vault reference,
// an owner and dates, never the key. Rotation overlaps (the old version stays valid for a grace period);
// a no-grace rotation is refused (that is a revocation). Revocation is immediate and NAMES what breaks.
// The review flags an overdue key, a revoked secret a live adapter still points at, and a sandbox
// credential wired into production — phrased by what the secret protects. Gated platform.setup.write/read.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const register = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/integration/secrets/${id}`, userId: u, tenantId: A, idempotencyKey: key, body });
const rotate = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/integration/secrets/${id}/rotation`, userId: u, tenantId: A, idempotencyKey: key, body });
const revoke = (h: ApiHarness, u: string, id: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: `/v1/integration/secrets/${id}/revocation`, userId: u, tenantId: A, idempotencyKey: key, body });
const inventory = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/integration/secrets', userId: u, tenantId: A });
const review = (h: ApiHarness, u: string, body: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: '/v1/integration/secrets/review', userId: u, tenantId: A, idempotencyKey: key, body });

const secret = (over: Record<string, unknown> = {}) =>
  ({ kind: 'payment_provider', vaultRef: 'vault://payments/live#v1', owner: 'u-owner', protects: 'the live payment key', rotateEveryDays: 90, environment: 'production', ...over });

type Issue = { secretId: string; finding: string; blocking: boolean };

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(A, 'u-owner');            // holds platform.setup.write + platform.setup.read
  await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds platform.health.read, NOT platform.setup.*
  return h;
}

describe('managed secrets: references only, rotate with overlap, revoke names breakage (M32-FR-03)', () => {
  it('registers a reference and lists the inventory; a raw value in vaultRef is refused', async () => {
    const h = await cast();
    expect((await register(h, 'u-owner', 'pay', secret(), 'k1')).status).toBe(201);
    const inv = (await inventory(h, 'u-owner')).body as { count: number; secrets: { secretId: string; state: string }[] };
    expect(inv.count).toBe(1);
    expect(inv.secrets[0]).toMatchObject({ secretId: 'pay', state: 'active' });
    // A plaintext key (not a scheme URI) is refused — the surface never holds a value.
    expect(codeOf(await register(h, 'u-owner', 'bad', secret({ vaultRef: 'sk_live_abc123' }), 'k2'))).toBe('not_readable_as_a_secret_reference');
  });

  it('rotates with an overlap and refuses a no-grace rotation', async () => {
    const h = await cast();
    await register(h, 'u-owner', 'pay', secret(), 'k1');
    const r = (await rotate(h, 'u-owner', 'pay', { newVaultRef: 'vault://payments/live#v2', graceDays: 7 }, 'k2')).body as { rotated: boolean; next: { version: number; state: string }; oldValidUntil: string };
    expect(r.rotated).toBe(true);
    expect(r.next).toMatchObject({ version: 2, state: 'active' });
    expect(r.oldValidUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The inventory now shows v2 active.
    expect(((await inventory(h, 'u-owner')).body as { secrets: { version: number }[] }).secrets[0]?.version).toBe(2);
    // A no-grace rotation is refused — a hard cut is a revocation.
    expect(codeOf(await rotate(h, 'u-owner', 'pay', { newVaultRef: 'vault://payments/live#v3', graceDays: 0 }, 'k3'))).toBe('no_grace_on_rotation');
  });

  it('revokes immediately and names the adapters that stop working', async () => {
    const h = await cast();
    await register(h, 'u-owner', 'pay', secret(), 'k1');
    const rv = (await revoke(h, 'u-owner', 'pay', { reason: 'key leaked in a screenshot', referencedBy: [{ adapterId: 'checkout', vaultRef: 'vault://payments/live#v1', environment: 'production' }] }, 'k2')).body as { revoked: { state: string }; breaks: string[]; detail: string };
    expect(rv.revoked.state).toBe('revoked');
    expect(rv.breaks).toEqual(['checkout']);
    expect(rv.detail).toContain('STOP WORKING NOW');
  });

  it('review flags an overdue key, and blocks on a revoked-still-referenced or sandbox-in-production secret', async () => {
    const h = await cast();
    // Overdue: last rotated long ago against a 90-day policy.
    await register(h, 'u-owner', 'old', secret({ vaultRef: 'vault://old#v1', lastRotatedOn: '2025-01-01' }), 'k1');
    // A sandbox credential that a production adapter points at.
    await register(h, 'u-owner', 'sbx', secret({ vaultRef: 'vault://sbx#v1', environment: 'sandbox' }), 'k2');
    // A revoked secret still referenced by a live adapter.
    await register(h, 'u-owner', 'rev', secret({ vaultRef: 'vault://rev#v1' }), 'k3');
    await revoke(h, 'u-owner', 'rev', { reason: 'rotated out' }, 'k4');

    const rev = (await review(h, 'u-owner', {
      asAt: '2026-08-20',
      referencedBy: [
        { adapterId: 'checkout', vaultRef: 'vault://rev#v1', environment: 'production' },
        { adapterId: 'sandbox-checkout', vaultRef: 'vault://sbx#v1', environment: 'production' },
      ],
    }, 'k5')).body as { issues: Issue[]; detail: string };
    const findings = rev.issues.map((i) => i.finding);
    expect(findings).toContain('overdue_rotation');
    expect(findings).toContain('revoked_still_referenced');
    expect(findings).toContain('sandbox_in_production');
    // The blocking ones sort first.
    expect(rev.issues[0]?.blocking).toBe(true);
    expect(rev.detail).toContain('WILL fail');
  });

  it('gates management on platform.setup, and survives a restart', async () => {
    const h = await cast();
    // A store manager (no platform.setup.*) cannot register or review a secret.
    expect((await register(h, 'u-mgr', 'pay', secret(), 'k1')).status).toBe(403);
    expect((await review(h, 'u-mgr', {}, 'k2')).status).toBe(403);
    await register(h, 'u-owner', 'pay', secret(), 'k3');
    await rotate(h, 'u-owner', 'pay', { newVaultRef: 'vault://payments/live#v2', graceDays: 7 }, 'k4');

    const restarted = apiHarness({ store: h.store });
    const inv = (await inventory(restarted, 'u-owner')).body as { secrets: { version: number; state: string }[] };
    expect(inv.secrets[0]).toMatchObject({ version: 2, state: 'active' }); // the rotated state rebuilt
  });
});
