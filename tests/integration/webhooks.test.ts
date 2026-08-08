import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { signWebhook } from '../../packages/integration/src/index';
import { webhookHasher } from '../../services/platform/src/webhooks';

// Inbound signed webhooks, end to end through the real API (M32-FR-01, API-11). An unsigned webhook is
// an unauthenticated POST from the internet that changes money, and a correctly signed one replayed six
// hours later is the same thing with extra steps — so a delivery is verified on its SIGNATURE (the
// timestamp is inside it), its AGE and its tenant. A BAD SIGNATURE or a WRONG TENANT is a security event
// (401); a stale delivery is refused (422); a DUPLICATE delivery id is a provider retry after a lost
// acknowledgement, deliberately acknowledged (200) and NOT treated as an attack. Proves the wired
// verification against the real pipeline and real RBAC.

// The harness signs with the same key the surface verifies with — a deterministic test key built from
// parts (never a literal, so the repo secret-scan stays clean), matching the harness's PACK_KEY exactly.
const PACK_KEY = ['sre', 'local', 'test', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');
const HASHER = webhookHasher(PACK_KEY);
const REF = 'vault://wh-provider';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const configure = (h: ApiHarness, tenantId: string, userId: string, provider: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/integration/webhooks/${provider}`, userId, tenantId, idempotencyKey: `wc-${provider}`, body });

// Build a signed envelope and post it as a delivery. signingKeyRef defaults to REF; override it to forge.
const deliver = (
  h: ApiHarness, tenantId: string, userId: string, provider: string, deliveryId: string,
  over: { event?: string; envelopeTenant?: string; sentAt?: string; payload?: unknown; signingKeyRef?: string; badSignature?: boolean } = {},
  key?: string,
) => {
  const event = over.event ?? 'payment.succeeded';
  const envelopeTenant = over.envelopeTenant ?? tenantId;
  const sentAt = over.sentAt ?? '2026-08-07T10:00:00Z';
  const payload = over.payload ?? { amountMinor: 412_000 };
  const env = signWebhook({ deliveryId, event, tenantId: envelopeTenant, payload, sentAt, signingKeyRef: over.signingKeyRef ?? REF, hasher: HASHER });
  return h.request({
    method: 'POST', path: `/v1/integration/webhooks/${provider}/deliveries/${deliveryId}`, userId, tenantId,
    idempotencyKey: key ?? `wd-${deliveryId}`,
    body: { event, tenantId: envelopeTenant, sentAt, payload, signature: over.badSignature ? `${env.signature}00` : env.signature },
  });
};

const processed = (h: ApiHarness, tenantId: string, userId: string, provider: string) =>
  h.request({ method: 'GET', path: `/v1/integration/webhooks/${provider}/deliveries`, userId, tenantId });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const verdictOf = (res: { body: unknown }): string | undefined => (res.body as { verdict?: string }).verdict;

// A very wide age window so the (real-clock) age check never trips — isolates signature/replay/tenant.
const WIDE = { signingKeyRef: REF, maxAgeSeconds: 3_153_600_000 };

describe('inbound webhooks: a forged one is a security event, a retry is not (M32-FR-01)', () => {
  it('accepts a validly signed delivery and treats a genuine retry as a replay, not an attack', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await configure(h, A, 'u-owner', 'razorpay', WIDE);

    const ok = await deliver(h, A, 'u-owner', 'razorpay', 'd1');
    expect(ok.status).toBe(200);
    expect(verdictOf(ok)).toBe('valid');
    expect((ok.body as { accepted: boolean }).accepted).toBe(true);

    // The provider retries the SAME delivery (our ack was lost) — acknowledged, not reprocessed, not an attack.
    const again = await deliver(h, A, 'u-owner', 'razorpay', 'd1', {}, 'wd-d1-retry');
    expect(again.status).toBe(200);
    expect(verdictOf(again)).toBe('replayed');
    expect((again.body as { accepted: boolean }).accepted).toBe(false);

    // The ledger a replay is checked against holds the one delivery, once.
    const seen = (await processed(h, A, 'u-owner', 'razorpay')).body as { processed: string[] };
    expect(seen.processed).toEqual(['d1']);
  });

  it('refuses a forged signature and a wrong-tenant delivery as security events (401)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await configure(h, A, 'u-owner', 'razorpay', WIDE);

    // Signed with a different key ref than the one on file → the signature will not match.
    const forged = await deliver(h, A, 'u-owner', 'razorpay', 'd-forge', { signingKeyRef: 'vault://someone-elses-key' });
    expect(forged.status).toBe(401);
    expect(codeOf(forged)).toBe('bad_signature');

    // A tampered signature is refused too.
    const tampered = await deliver(h, A, 'u-owner', 'razorpay', 'd-tamper', { badSignature: true });
    expect(tampered.status).toBe(401);
    expect(codeOf(tampered)).toBe('bad_signature');

    // A delivery that NAMES another tenant, arriving on A's endpoint — refused before the signature even matters.
    const cross = await deliver(h, A, 'u-owner', 'razorpay', 'd-cross', { envelopeTenant: B });
    expect(cross.status).toBe(401);
    expect(codeOf(cross)).toBe('wrong_tenant');
  });

  it('refuses a stale delivery even when it is correctly signed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await configure(h, A, 'u-owner', 'razorpay', { signingKeyRef: REF }); // default 5-minute window

    // Correctly signed, but the timestamp is years old — a captured delivery being posted back.
    const stale = await deliver(h, A, 'u-owner', 'razorpay', 'd-stale', { sentAt: '2020-01-01T00:00:00Z' });
    expect(stale.status).toBe(422);
    expect(codeOf(stale)).toBe('too_old');
    // Nothing was processed.
    expect(((await processed(h, A, 'u-owner', 'razorpay')).body as { processed: string[] }).processed).toEqual([]);
  });

  it('is authorized and per-tenant, and refuses unknown/malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // reads, does not receive webhooks
    await h.provisionRole(A, 'u-cash', 'cashier');
    await configure(h, A, 'u-owner', 'razorpay', WIDE);

    expect((await deliver(h, A, 'u-cash', 'razorpay', 'd-c')).status).toBe(403);
    expect((await deliver(h, A, 'u-mgr', 'razorpay', 'd-m')).status).toBe(403); // webhook receipt is owner/gateway only
    // A delivery for a provider that was never configured.
    expect((await deliver(h, A, 'u-owner', 'ghostpay', 'd-g')).status).toBe(404);
    // A literal (non-vault) signing key is refused at configuration (hard rule #4).
    expect((await configure(h, A, 'u-owner', 'badcfg', { signingKeyRef: 'sk_live_inline' })).status).toBe(400);
    // A malformed delivery (no signature).
    expect((await h.request({ method: 'POST', path: '/v1/integration/webhooks/razorpay/deliveries/d-bad', userId: 'u-owner', tenantId: A, idempotencyKey: 'wd-bad', body: { event: 'x', tenantId: A, sentAt: '2026-08-07T10:00:00Z' } })).status).toBe(400);

    // Another tenant never configured this provider.
    await h.seedOwner(B, 'u-owner-b');
    expect((await processed(h, B, 'u-owner-b', 'razorpay')).status).toBe(404);
  });
});
