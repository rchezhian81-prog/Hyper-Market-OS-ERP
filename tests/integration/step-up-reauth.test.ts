// Step-up re-authentication at the API boundary (SEC-03 / GAP-SEC-06) — the property a browser-only
// control cannot give: a DIRECT API call to a sensitive route is refused unless the SIGNED token
// carries a recent, MFA-backed re-authentication. Driven through the REAL pipeline via `apiHarness`,
// exactly as production composes it, on the two §28 sensitive routes now gated: a privilege grant
// (`POST /v1/identity/grants`) and an irreversible erasure (`POST .../erasure-execution`).
//
// The step-up check runs AFTER permission + entitlement and BEFORE the handler, so these assertions
// hold without setting up a valid grant/erasure body: a refusal here is the auth-tier control firing,
// and a non-`reauthentication_required` outcome is proof the control PASSED and the handler ran.

import { describe, it, expect } from 'vitest';
import { apiHarness } from '../support/api-harness';

const T = 'reauth-tenant';
const OWNER = 'reauth-owner';

const codeOf = (res: { body: unknown }): string | undefined =>
  (res.body as { error?: { code?: string } } | undefined)?.error?.code;

async function ownerHarness() {
  const h = apiHarness();
  await h.seedOwner(T, OWNER); // genesis owner: holds identity.role.grant + privacy.erasure.execute
  return h;
}

const GRANT = '/v1/identity/grants';
const ERASURE = '/v1/privacy/data-requests/req-demo/erasure-execution';

describe('step-up re-auth — privilege grant (POST /v1/identity/grants)', () => {
  it('a fresh, MFA-backed sign-in PASSES the step-up gate (not refused for re-auth)', async () => {
    const h = await ownerHarness();
    const res = await h.request({ method: 'POST', path: GRANT, userId: OWNER, tenantId: T, body: {}, idempotencyKey: 'k1' });
    expect(res.status, 'step-up must not refuse a fresh MFA sign-in').not.toBe(403);
    expect(codeOf(res)).not.toBe('reauthentication_required');
  });

  it('a sign-in with NO re-auth evidence is REFUSED (403 reauthentication_required)', async () => {
    const h = await ownerHarness();
    const res = await h.request({ method: 'POST', path: GRANT, userId: OWNER, tenantId: T, body: {}, idempotencyKey: 'k2', authTimeFromNowSeconds: null, amr: null });
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('reauthentication_required');
  });

  it('a single-factor sign-in (no mfa) is REFUSED — the factor is insufficient', async () => {
    const h = await ownerHarness();
    const res = await h.request({ method: 'POST', path: GRANT, userId: OWNER, tenantId: T, body: {}, idempotencyKey: 'k3', amr: ['pwd'] });
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('reauthentication_required');
  });

  it('a stale re-auth (older than the window) is REFUSED', async () => {
    const h = await ownerHarness();
    const res = await h.request({ method: 'POST', path: GRANT, userId: OWNER, tenantId: T, body: {}, idempotencyKey: 'k4', authTimeFromNowSeconds: -100_000 });
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('reauthentication_required');
  });

  it('a DIRECT raw API call with a valid-but-non-MFA token cannot bypass the control', async () => {
    const h = await ownerHarness();
    // A genuinely signed, unexpired token for the owner — but minted with NO re-auth evidence. This is
    // exactly the "call the API directly, skip the browser prompt" attack GAP-SEC-06 was about.
    const token = h.idp.issue({ sub: OWNER, tenantId: T, authTimeFromNowSeconds: null, amr: null });
    const res = await h.raw({ method: 'POST', path: GRANT, token, body: {}, idempotencyKey: 'k5' });
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('reauthentication_required');
  });
});

describe('step-up re-auth — irreversible erasure (POST .../erasure-execution)', () => {
  it('a sign-in with no re-auth evidence is REFUSED before the handler runs', async () => {
    const h = await ownerHarness();
    const res = await h.request({ method: 'POST', path: ERASURE, userId: OWNER, tenantId: T, body: {}, idempotencyKey: 'e1', authTimeFromNowSeconds: null, amr: null });
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('reauthentication_required');
  });

  it('a fresh MFA sign-in PASSES the step-up gate (the handler then runs and decides on its own merits)', async () => {
    const h = await ownerHarness();
    const res = await h.request({ method: 'POST', path: ERASURE, userId: OWNER, tenantId: T, body: {}, idempotencyKey: 'e2' });
    expect(codeOf(res)).not.toBe('reauthentication_required');
  });
});

describe('step-up is per-route — an ordinary route is unaffected by missing re-auth evidence', () => {
  it('GET /v1/identity/me works with a token carrying NO auth_time / amr', async () => {
    const h = await ownerHarness();
    const token = h.idp.issue({ sub: OWNER, tenantId: T, authTimeFromNowSeconds: null, amr: null });
    const res = await h.raw({ method: 'GET', path: '/v1/identity/me', token });
    expect(res.status).toBe(200);
  });
});
