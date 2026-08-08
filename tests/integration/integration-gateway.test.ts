import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Integration gateway — certified matrix, adapter registration & health, end to end through the real
// API (M32-FR-04, API-11). An uncertified combination is REFUSED, not merely undocumented. Two refusals
// are absolute with no override anywhere: a payment adapter that declares it retains anything outside
// the permitted list cannot be registered (hard rule #3), and a credential that is a literal rather than
// a vault:// reference is refused (hard rule #4). Health is "when did it last WORK", not "is it
// configured" — an adapter silent for days is green on any dashboard that reports configuration. And no
// integration failure may reach the till (`posUnaffected` typed true, hard rule #1). Proves the wired
// gateway against the real pipeline and real RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const matrix = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/integration/matrix/${id}`, userId, tenantId, idempotencyKey: `m-${id}`, body });
const adapter = (h: ApiHarness, tenantId: string, userId: string, id: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/integration/adapters/${id}`, userId, tenantId, idempotencyKey: `a-${id}`, body });
const heartbeat = (h: ApiHarness, tenantId: string, userId: string, adapterId: string, hbId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/integration/adapters/${adapterId}/heartbeats/${hbId}`, userId, tenantId, idempotencyKey: `hb-${hbId}`, body });
const deviceCheck = (h: ApiHarness, tenantId: string, userId: string, query: Record<string, string>) =>
  h.request({ method: 'GET', path: '/v1/integration/devices/check', userId, tenantId, query });
const health = (h: ApiHarness, tenantId: string, userId: string) =>
  h.request({ method: 'GET', path: '/v1/integration/health', userId, tenantId });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Health { adapters: { adapterId: string; state: string }[]; posUnaffected: boolean }
interface Device { allowed: boolean; outcome: string; alternatives: string[] }
const stateOf = (r: Health, id: string) => r.adapters.find((a) => a.adapterId === id)?.state;

describe('integration gateway: card data and inline credentials refused, silence is caught (M32-FR-04)', () => {
  it('refuses an inline credential, card-data retention, and an uncertified or unauthorised payment provider', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await matrix(h, A, 'u-owner', 'pay-rzp', { category: 'payment', vendor: 'razorpay', model: 'gateway', versions: [], certifiedOn: '2026-01-01', rbiAuthorised: true });
    await matrix(h, A, 'u-owner', 'pay-dodgy', { category: 'payment', vendor: 'dodgypay', model: 'gateway', versions: [], certifiedOn: '2026-01-01', rbiAuthorised: false });

    // A literal credential (not vault://) — refused, catching what the repo secret-scan never sees.
    expect(codeOf(await adapter(h, A, 'u-owner', 'a-inline', { category: 'accounting', vendor: 'tally', credentialRef: 'not-a-vault-ref', environment: 'production', enabled: true }))).toBe('credential_inline');
    // A payment adapter declaring it keeps a PAN — refused outright, no override (hard rule #3).
    expect(codeOf(await adapter(h, A, 'u-owner', 'a-card', { category: 'payment', vendor: 'razorpay', credentialRef: 'vault://pay', environment: 'production', enabled: true, retains: ['pan', 'provider_token'] }))).toBe('stores_card_data');
    // A payment vendor not on the matrix.
    expect(codeOf(await adapter(h, A, 'u-owner', 'a-unknown', { category: 'payment', vendor: 'unknownpay', credentialRef: 'vault://pay', environment: 'production', enabled: true }))).toBe('not_certified');
    // Certified but not RBI-authorised — tokenisation from an unauthorised gateway is refused (§35).
    expect(codeOf(await adapter(h, A, 'u-owner', 'a-dodgy', { category: 'payment', vendor: 'dodgypay', credentialRef: 'vault://pay', environment: 'production', enabled: true }))).toBe('provider_not_authorised');

    // A clean payment adapter (certified, RBI, only permitted retention, vault credential) is registered.
    expect((await adapter(h, A, 'u-owner', 'a-rzp', { category: 'payment', vendor: 'razorpay', credentialRef: 'vault://pay', environment: 'production', enabled: true, retains: ['provider_token', 'last4'] })).status).toBe(201);
    // A non-payment adapter needs no matrix entry, just a vault credential.
    expect((await adapter(h, A, 'u-owner', 'a-tally', { category: 'accounting', vendor: 'tally', credentialRef: 'vault://tally', environment: 'production', enabled: true })).status).toBe(201);
  });

  it('certifies a device, and refuses an uncertified or wrong-firmware one while NAMING the alternative', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await matrix(h, A, 'u-owner', 'hw-zebra', { category: 'hardware', vendor: 'Zebra', model: 'DS2208', versions: ['1.4'], certifiedOn: '2026-01-01', deviceKind: 'barcode_scanner' });

    const ok = (await deviceCheck(h, A, 'u-owner', { vendor: 'Zebra', model: 'DS2208', deviceKind: 'barcode_scanner' })).body as Device;
    expect(ok.allowed).toBe(true);
    expect(ok.outcome).toBe('certified');

    const no = (await deviceCheck(h, A, 'u-owner', { vendor: 'Cheapo', model: 'X1', deviceKind: 'barcode_scanner' })).body as Device;
    expect(no.allowed).toBe(false);
    expect(no.outcome).toBe('not_certified');
    expect(no.alternatives).toContain('Zebra DS2208'); // a refusal that names what to buy instead

    const old = (await deviceCheck(h, A, 'u-owner', { vendor: 'Zebra', model: 'DS2208', deviceKind: 'barcode_scanner', firmware: '9.9' })).body as Device;
    expect(old.outcome).toBe('wrong_version');
  });

  it('catches an adapter that has gone silent, and keeps the till unaffected either way', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await adapter(h, A, 'u-owner', 'a-tally', { category: 'accounting', vendor: 'tally', credentialRef: 'vault://tally', environment: 'production', enabled: true });
    await adapter(h, A, 'u-owner', 'a-wa', { category: 'messaging', vendor: 'whatsapp', credentialRef: 'vault://wa', environment: 'production', enabled: true });
    await adapter(h, A, 'u-owner', 'a-off', { category: 'logistics', vendor: 'shiprocket', credentialRef: 'vault://ship', environment: 'production', enabled: false });
    // Tally last worked long ago; WhatsApp has never reported a success.
    await heartbeat(h, A, 'u-owner', 'a-tally', 'hb1', { ok: true, at: '2020-01-01T09:00:00Z' });
    await heartbeat(h, A, 'u-owner', 'a-wa', 'hb2', { ok: false, at: '2026-08-06T09:00:00Z' });

    const r = (await health(h, A, 'u-owner')).body as Health;
    expect(stateOf(r, 'a-tally')).toBe('silent');  // "configured" is not health — it last worked years ago
    expect(stateOf(r, 'a-wa')).toBe('silent');      // never a success
    expect(stateOf(r, 'a-off')).toBe('disabled');
    expect(r.posUnaffected).toBe(true);             // no integration failure reaches a sale (hard rule #1)
    expect(r.adapters[0]?.state).toBe('silent');    // worst first
  });

  it('is authorized (owner configures, manager reads) and per-tenant, and refuses malformed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // reads health, does NOT configure integrations
    await h.provisionRole(A, 'u-cash', 'cashier');       // neither

    expect((await adapter(h, A, 'u-cash', 'a-x', { category: 'accounting', vendor: 'tally', credentialRef: 'vault://t', environment: 'production', enabled: true })).status).toBe(403);
    expect((await adapter(h, A, 'u-mgr', 'a-y', { category: 'accounting', vendor: 'tally', credentialRef: 'vault://t', environment: 'production', enabled: true })).status).toBe(403);
    expect((await health(h, A, 'u-mgr')).status).toBe(200); // a manager may read the health picture
    expect((await health(h, A, 'u-cash')).status).toBe(403);
    expect((await adapter(h, A, 'u-owner', 'a-bad', { category: 'nonsense', vendor: 'x', credentialRef: 'vault://x', environment: 'production', enabled: true })).status).toBe(400);
    expect((await deviceCheck(h, A, 'u-owner', { vendor: 'Zebra' })).status).toBe(400);

    await h.seedOwner(B, 'u-owner-b');
    const other = (await health(h, B, 'u-owner-b')).body as Health;
    expect(other.adapters).toEqual([]);
    expect(other.posUnaffected).toBe(true);
  });
});
