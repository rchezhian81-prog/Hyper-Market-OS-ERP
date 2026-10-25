import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, TEST_IDP, type ApiHarness } from '../support/api-harness';
import { recordingPartner, approvedSubscription, type Raw } from '../support/outbound-partner';
import { createPartnerClient, verifyWebhook, PartnerApiError, type PartnerClient } from '../../packages/partner-sdk/src/index';

/**
 * **M36-FR-04 acceptance: "a partner builds an integration against the sandbox using versioned APIs, with no SRE code
 * change, and it runs unchanged against a production tenant."** The partner's code below uses only @sre/partner-sdk: the
 * published manifest, idempotent intents and the signed webhooks that already exist. Its credential (a token for its own
 * service identity in each tenant) is issued out of band — here by the test identity server, standing in for SRE's
 * administrator; the SDK never mints one. Synthetic data only; no partner is live (recording transport).
 */

const SECRET_NAME = 'partner-sdk-signing';
const SECRET = ['partner', 'sdk', 'test', 'secret', 'built', 'at', 'run', 'time'].join('-').padEnd(40, 'x');

/** The SDK's fetch, answered by the real API pipeline (the harness) instead of the network. */
function fetchInto(h: ApiHarness, lose: { next: boolean } = { next: false }): typeof globalThis.fetch {
  return (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    const token = (init.headers['authorization'] ?? '').replace(/^Bearer /, '');
    const r = await h.raw({
      method: init.method as never, path: u.pathname, token, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }),
      ...(init.headers['idempotency-key'] === undefined ? {} : { idempotencyKey: init.headers['idempotency-key'] }),
      query: Object.fromEntries(u.searchParams.entries()),
    });
    // A lost answer: the server did the work, the partner never heard back.
    if (lose.next && init.method !== 'GET') { lose.next = false; throw new Error('connection reset'); }
    return { status: r.status, json: async () => r.body };
  }) as unknown as typeof globalThis.fetch;
}

/** THE PARTNER'S INTEGRATION — written once, against the SDK only. */
async function partnerIntegration(sre: PartnerClient): Promise<{ routes: number; devices: string[]; refusal: PartnerApiError }> {
  const manifest = await sre.manifest();
  const intent = sre.intend('POST', '/v1/platform/devices/kiosk-1/register', { branchId: 'B1', kind: 'kiosk', label: 'Price kiosk 1' });
  await sre.send(intent);
  await sre.send(intent); // resent after a doubt — the same key, one effect
  const fleet = await sre.get<{ devices: { deviceId: string }[] }>('/v1/platform/devices');
  const refusal = await sre.send<unknown>(sre.intend('POST', '/v1/platform/devices/kiosk-2/register', { kind: 'kiosk' })).then(() => { throw new Error('a device with no branch was taken'); }, (e: unknown) => e as PartnerApiError);
  return { routes: manifest.apis.reduce((n, a) => n + a.routes.length, 0), devices: fleet.devices.map((d) => d.deviceId), refusal };
}

describe('a partner builds against the sandbox with the SDK and runs unchanged against a production shop (M36-FR-04)', () => {
  it('manifest, idempotent intents (a lost answer resent is one effect), the API\'s words on a refusal, signed webhooks, reconcile', async () => {
    const partner = recordingPartner();
    const h = apiHarness({ outboundTransport: partner, outboundSecrets: new Map([[SECRET_NAME, SECRET]]) });
    const SANDBOX = randomUUID(); const PROD = randomUUID();
    for (const T of [SANDBOX, PROD]) {
      await h.seedOwner(T, 'u-owner');
      await h.provisionRole(T, 'svc-partner-a', 'platform_admin'); // the partner's service identity in that shop
      await h.provisionRole(T, 'u-checker', 'platform_admin');
    }
    // SRE's administrator registers the sandbox (hard rule #7: generated data only).
    const reg = await h.request({ method: 'POST', path: `/v1/platform/partners/sandboxes/sb-${SANDBOX.slice(0, 8)}`, userId: 'u-checker', tenantId: SANDBOX, idempotencyKey: 'sb', body: { partnerId: 'partner-a', createdOn: '2026-10-01', expiresOn: '2030-01-01' } });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);

    const lose = { next: true };
    const client = (T: string, l?: { next: boolean }) => createPartnerClient({
      baseUrl: 'https://api.example.test', accessToken: () => TEST_IDP.issue({ sub: 'svc-partner-a', tenantId: T }), fetch: fetchInto(h, l), maxAttempts: 2,
    });
    const inSandbox = await partnerIntegration(client(SANDBOX, lose));
    expect(inSandbox.routes).toBeGreaterThan(1000);
    expect(inSandbox.devices.filter((d) => d === 'kiosk-1')).toHaveLength(1);
    expect(inSandbox.refusal).toBeInstanceOf(PartnerApiError);
    expect(inSandbox.refusal).toMatchObject({ status: 400, code: 'not_readable_as_a_device', wasItSaved: 'not_saved' });
    // The same code, unchanged, against a production shop — and the sandbox's device never reaches it (two tenants, §35).
    const inProd = await partnerIntegration(client(PROD));
    expect(inProd.devices).toEqual(['kiosk-1']);
    // A sandbox credential is the sandbox's: presented to the production shop it reaches nothing.
    const crossed = createPartnerClient({ baseUrl: 'https://api.example.test', accessToken: () => TEST_IDP.issue({ sub: 'svc-partner-x', tenantId: PROD }), fetch: fetchInto(h) });
    await expect(crossed.manifest()).rejects.toMatchObject({ status: 403 });

    // ── The signed webhooks that already exist, received and checked with the SDK ──
    const raw: Raw = (method, path, user, body, key, query) => h.request({ method, path, userId: user, tenantId: SANDBOX, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
    const sub = { partnerId: 'partner-a', url: 'https://partner-a.example.test/hooks', eventTypes: ['SaleCommitted'], signingKeyRef: `vault://${SECRET_NAME}`, maxAttempts: 3 };
    const from = new Date(Date.now() - 1_000).toISOString();
    expect((await raw('POST', '/v1/integration/outbound-webhooks/SUB-SDK', 'u-owner', await approvedSubscription(raw, 'u-owner', 'u-checker', 'SUB-SDK', sub), 'sub')).status).toBe(201);
    await new Promise((r) => setTimeout(r, 5));
    const sale = { saleId: 'SDK-1', receiptNumber: 'R-SDK-1', laneId: 'lane-1', cashierId: 'u-owner', tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(), totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [], tenders: [{ kind: 'cash', amountMinor: 1_000 }] };
    expect((await raw('POST', '/v1/sales', 'u-owner', sale, 'sale-sdk')).status).toBe(202);
    expect((await raw('POST', '/v1/integration/outbound-deliveries/drain', 'u-owner', {}, 'drain-1')).status).toBe(200);
    const got = partner.sent.at(-1)!;
    const verdict = verifyWebhook<{ saleId: string }>({ secret: SECRET, headers: got.headers, rawBody: got.body, nowMs: Date.now() });
    expect(verdict).toMatchObject({ ok: true, event: { type: 'SaleCommitted', subscriptionId: 'SUB-SDK', data: { saleId: 'SDK-1' } } });
    expect(verifyWebhook({ secret: SECRET, headers: got.headers, rawBody: got.body.replace('SDK-1', 'SDK-9'), nowMs: Date.now() })).toMatchObject({ ok: false, reason: 'bad_signature' });
    // Reconcile what head office sent with what was received — through the SDK.
    const rec = await client(SANDBOX).reconcile<{ totals: { all: number; delivered: number } }>('SUB-SDK', from);
    expect(rec.totals).toMatchObject({ all: 1, delivered: 1 });
  }, 120_000);
});
