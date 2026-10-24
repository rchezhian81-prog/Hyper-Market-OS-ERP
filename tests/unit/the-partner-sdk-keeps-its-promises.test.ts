import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPartnerClient, verifyWebhook, matchesTemplate, PartnerApiError, SDK_VERSION, API_VERSION, type Manifest } from '../../packages/partner-sdk/src/index';
import { signOutbound } from '../../services/platform/src/outbound-webhooks';

// M36-FR-04 (OB-288 P4): the partner SDK — versioned, standalone, over the published manifest and the signed webhooks that
// already exist; it never mints a token; the idempotency key belongs to the decision, not the attempt.

const MANIFEST: Manifest = { apis: [{ api: 'API-10', name: 'x', routes: [
  { method: 'GET', path: '/v1/platform/devices', permission: 'p', entitlement: null, write: false, idempotent: false },
  { method: 'POST', path: '/v1/platform/devices/:deviceId/register', permission: 'p', entitlement: null, write: true, idempotent: true },
  { method: 'POST', path: '/v1/legacy/thing', permission: 'p', entitlement: null, write: true, idempotent: false },
] }] };

function fakeApi(answers: number[] = []) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
    if (url.endsWith('/v1/platform/api-manifest')) return { status: 200, json: async () => MANIFEST };
    const status = answers.length > 0 ? answers.shift()! : 200;
    if (status === -1) throw new Error('the line dropped');
    return { status, json: async () => (status < 300 ? { ok: true } : { error: { code: 'not_readable_as_a_device', whatHappened: 'no branch', wasItSaved: 'not_saved', nextSafeAction: 'send the branch' } }) };
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('the partner client', () => {
  it('speaks v1, sends only the token it was handed, and calls no token endpoint', async () => {
    const api = fakeApi();
    const c = createPartnerClient({ baseUrl: 'https://api.example.test/', accessToken: () => 'issued-token', fetch: api.fetch });
    await c.get('/v1/platform/devices');
    expect([SDK_VERSION, API_VERSION]).toEqual(['1.0.0', 'v1']);
    expect(api.calls.map((x) => x.url)).toEqual(['https://api.example.test/v1/platform/api-manifest', 'https://api.example.test/v1/platform/devices']);
    expect(api.calls.every((x) => x.headers['authorization'] === 'Bearer issued-token' && x.headers['x-sre-sdk-version'] === '1.0.0')).toBe(true);
    expect(api.calls.some((x) => /token|oauth|auth\/|login|sign-in/.test(x.url))).toBe(false);
    await expect(createPartnerClient({ baseUrl: 'https://a', accessToken: () => '', fetch: api.fetch }).get('/v1/platform/devices')).rejects.toMatchObject({ code: 'no_access_token', wasItSaved: 'not_saved' });
  });

  it('refuses, before sending anything, an unversioned call, one not in the manifest, and a write that is not idempotent', async () => {
    const api = fakeApi();
    const c = createPartnerClient({ baseUrl: 'https://a', accessToken: () => 't', fetch: api.fetch });
    await expect(c.get('/platform/devices')).rejects.toMatchObject({ code: 'unversioned_call', status: 0, wasItSaved: 'not_saved' });
    await expect(c.get('/v1/platform/secret-things')).rejects.toMatchObject({ code: 'not_in_the_published_surface' });
    await expect(c.send(c.intend('POST', '/v1/legacy/thing', {}))).rejects.toMatchObject({ code: 'write_not_idempotent' });
    expect(api.calls.map((x) => x.url)).toEqual(['https://a/v1/platform/api-manifest']); // only the manifest was ever asked
    expect(matchesTemplate('/v1/platform/devices/:deviceId/register', '/v1/platform/devices/till-9/register')).toBe(true);
    expect(matchesTemplate('/v1/platform/devices/:deviceId/register', '/v1/platform/devices//register')).toBe(false);
  });

  it('one intent, one key: every retry of a dropped line or a 503 carries the SAME idempotency key; a 4xx stops with the API\'s words', async () => {
    const api = fakeApi([-1, 503, 201]);
    let n = 0;
    const c = createPartnerClient({ baseUrl: 'https://a', accessToken: () => 't', fetch: api.fetch, newKey: () => `key-${n += 1}`, maxAttempts: 3 });
    const intent = c.intend('POST', '/v1/platform/devices/till-9/register', { branchId: 'B1', kind: 'pos_lane', label: 'Lane 9' });
    expect(await c.send(intent)).toEqual({ ok: true });
    const writes = api.calls.filter((x) => x.method === 'POST');
    expect(writes.map((x) => x.headers['idempotency-key'])).toEqual(['key-1', 'key-1', 'key-1']);
    const refusing = fakeApi([400]);
    const c2 = createPartnerClient({ baseUrl: 'https://a', accessToken: () => 't', fetch: refusing.fetch });
    const err = await c2.send(c2.intend('POST', '/v1/platform/devices/till-9/register', {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartnerApiError);
    expect(err).toMatchObject({ status: 400, code: 'not_readable_as_a_device', whatHappened: 'no branch', wasItSaved: 'not_saved', nextSafeAction: 'send the branch' });
    expect(refusing.calls.filter((x) => x.method === 'POST')).toHaveLength(1); // never retried
    // Still unanswered after every attempt: "unknown" — send the same intent later.
    const down = fakeApi([503, 503]);
    const c3 = createPartnerClient({ baseUrl: 'https://a', accessToken: () => 't', fetch: down.fetch, maxAttempts: 2 });
    await expect(c3.send(c3.intend('POST', '/v1/platform/devices/till-9/register', {}))).rejects.toMatchObject({ wasItSaved: 'unknown' });
  });
});

describe('the webhook check matches what head office signs', () => {
  const secret = ['partner', 'webhook', 'secret', 'built', 'at', 'run', 'time'].join('-');
  const body = JSON.stringify({ id: 'SUB-A.ev-1', apiVersion: 'v1', type: 'SaleCommitted', occurredAt: '2026-10-24T05:00:00.000Z', tenantId: 't', subscriptionId: 'SUB-A', data: { saleId: 'S-1' } });
  const ts = '2026-10-24T05:00:01.000Z';
  const headers = { 'X-SRE-Webhook-Id': 'SUB-A.ev-1', 'x-sre-webhook-timestamp': ts, 'x-sre-webhook-signature': signOutbound(secret, ts, body), 'x-sre-api-version': 'v1' };
  const now = Date.parse(ts) + 10_000;
  it('accepts a genuine delivery and hands back the typed event; refuses tamper, replay, wrong version, missing headers', () => {
    expect(verifyWebhook<{ saleId: string }>({ secret, headers, rawBody: body, nowMs: now })).toMatchObject({ ok: true, messageId: 'SUB-A.ev-1', event: { type: 'SaleCommitted', data: { saleId: 'S-1' } } });
    expect(verifyWebhook({ secret, headers, rawBody: body.replace('S-1', 'S-9'), nowMs: now })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyWebhook({ secret: `${secret}x`, headers, rawBody: body, nowMs: now })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyWebhook({ secret, headers, rawBody: body, nowMs: now + 3_600_000 })).toEqual({ ok: false, reason: 'stale' });
    expect(verifyWebhook({ secret, headers: { ...headers, 'x-sre-api-version': 'v2' }, rawBody: body, nowMs: now })).toEqual({ ok: false, reason: 'wrong_api_version' });
    expect(verifyWebhook({ secret, headers: { ...headers, 'X-SRE-Webhook-Id': 'other' }, rawBody: body, nowMs: now })).toEqual({ ok: false, reason: 'id_mismatch' });
    expect(verifyWebhook({ secret, headers: {}, rawBody: body, nowMs: now })).toEqual({ ok: false, reason: 'missing_headers' });
  });
});

describe('the SDK stands alone and holds no signing power', () => {
  const dir = 'packages/partner-sdk/src';
  const sources = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);
  it('imports nothing outside its own package except the platform\'s crypto, and has a version', () => {
    for (const [f, src] of sources) {
      for (const m of src.matchAll(/from '([^']+)'/g)) expect(m[1] === 'node:crypto' || m[1]!.startsWith('./'), `${f} imports ${m[1]}`).toBe(true);
    }
    expect(JSON.parse(readFileSync('packages/partner-sdk/package.json', 'utf8'))).toMatchObject({ name: '@sre/partner-sdk', version: SDK_VERSION });
  });
  it('mints no token: no JWT signing, no private key, no token endpoint anywhere in its source', () => {
    for (const [f, src] of sources) expect(/jsonwebtoken|createSign|privateKey|BEGIN [A-Z ]*PRIVATE KEY|\/token\b|grant_type|client_secret/.test(src), f).toBe(false);
  });
});
