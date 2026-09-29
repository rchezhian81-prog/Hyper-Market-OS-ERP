import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs operator script, imported for its pure token builder.
import { buildStoreToken } from '../../scripts/issue-store-token.mjs';
import { buildOperatorToken, parseEnvText, parseFlags, demoTenantIds, tokenPolicyFromEnv } from '../../scripts/lib/operator-env';
import { verifyToken } from '../../services/identity/src/token';
import { TEST_IDP } from '../support/api-harness';

// The operator tools mint their own short-lived token (scripts/ only — production never mints, hard
// rule #4). Two minters that could drift is a token the API might one day refuse at 9pm on load night,
// so this pins them byte-for-byte to each other AND to the real verifier.

const NOW = Date.parse('2026-10-01T09:00:00.000Z');
const POLICY = TEST_IDP.policy();

describe('the operator token', () => {
  it('is byte-identical to the store-token script\'s and verifies against the API\'s policy', () => {
    const claims = { sub: 'u-chezhian', tenantId: 'ab000000-0000-4000-8000-000000000042', ttlSeconds: 600 };
    const mine = buildOperatorToken(claims, POLICY, NOW);
    expect(mine).toBe(buildStoreToken(claims, POLICY, NOW));
    const v = verifyToken(mine, POLICY, NOW + 1000);
    expect(v.ok).toBe(true);
    expect(v).toMatchObject({ principal: { userId: 'u-chezhian', tenantId: claims.tenantId } });
    const wrongKey = { ...POLICY, secret: ['a', 'different', 'signing', 'key'].join('-').padEnd(40, 'x') };
    expect(verifyToken(mine, wrongKey, NOW).ok).toBe(false);
    expect(verifyToken(mine, POLICY, NOW + 2 * 3_600_000).ok).toBe(false); // long after the ten minutes (and any skew allowance)
  });
  it('reads the env, the flags and the demo tenant list the way the runbook says', () => {
    const env = parseEnvText('# comment\nMIGRATION_TARGET_KIND=rehearsal\nIDP_SIGNING_KEY = k\nIDP_ISSUER=https://i\nIDP_AUDIENCE=a\nDEMO_TENANT_IDS=de300000-0000-4000-8000-000000000001, x\n\nBROKEN LINE\n');
    expect(env).toEqual({ MIGRATION_TARGET_KIND: 'rehearsal', IDP_SIGNING_KEY: 'k', IDP_ISSUER: 'https://i', IDP_AUDIENCE: 'a', DEMO_TENANT_IDS: 'de300000-0000-4000-8000-000000000001, x' });
    expect(tokenPolicyFromEnv(env)).toEqual({ policy: { secret: 'k', issuer: 'https://i', audience: 'a' }, missing: [] });
    expect(tokenPolicyFromEnv({ IDP_ISSUER: 'https://i' }).missing).toEqual(['IDP_SIGNING_KEY', 'IDP_AUDIENCE']);
    expect(parseFlags(['--dir', '/x', '--dry-run', '--api', 'http://h', '--out'])).toEqual({ dir: '/x', 'dry-run': true, api: 'http://h', out: true });
    expect(demoTenantIds(env, 'y,de300000-0000-4000-8000-000000000001')).toEqual(['pilot-demo', 'de300000-0000-4000-8000-000000000001', 'x', 'y']);
    expect(demoTenantIds({}, undefined)).toEqual(['pilot-demo']);
  });
});
