import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { recordingPartner, approvedSubscription, type Raw } from '../support/outbound-partner';
import { apiHarness } from '../support/api-harness';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **W3 · D14-FR-06 and M36-FR-04 — the two registers the office pages list, through the real API.**
 *
 *   • `GET /v1/integration/outbound-webhooks` lists every partner subscription (latest version) with its message totals,
 *     the events head office publishes and whether a sender is configured — so a dead letter is visible without knowing a
 *     subscription's id (P-08). A redelivery puts the dead letter back as a NEW series; the old attempts stay (hard rule
 *     #6), and the list shows it waiting again. The signing secret is never in the answer, only its vault:// reference.
 *   • `GET /v1/platform/partners` lists every credential (with how it stands on the shop's day: active, revoked,
 *     expired), every connector certification and every sandbox — read back the same after a cold restart, on the
 *     in-memory store and (with DATABASE_URL) real PostgreSQL. A cashier is refused both.
 */

const OWNER = 'u-owner'; const ADMIN = 'u-admin'; const CHECKER = 'u-checker'; const CASH = 'u-cash';
const SECRET = ['w3', 'outbound', 'list', 'secret', 'built', 'at', 'run', 'time'].join('-').padEnd(40, 'x');
const backings = useRestartableBackings();

describe.each(backings)('the partner register is listed — on $name', ({ harness }) => {
  it('credentials with their standing, certifications and sandboxes; the same after a restart; a cashier refused', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, ADMIN, 'platform_admin');
    await h.provisionRole(T, CASH, 'cashier');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, hh = h) =>
      hh.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const empty = await call('GET', '/v1/platform/partners', ADMIN);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ credentials: [], certifications: [], sandboxes: [], listed: true });

    const cred = { partnerId: 'sre-integrator', environment: 'sandbox', scopedTenantIds: [T], scopes: ['catalogue.read'], issuedOn: '2026-01-01', expiresOn: '2099-01-01' };
    expect((await call('POST', '/v1/platform/partners/cred-a', ADMIN, cred)).status).toBe(201);
    expect((await call('POST', '/v1/platform/partners/cred-b', ADMIN, { ...cred, expiresOn: '2026-02-01' })).status).toBe(201);
    expect((await call('POST', '/v1/platform/partners/cred-c', ADMIN, cred)).status).toBe(201);
    expect((await call('POST', '/v1/platform/partners/cred-c/revoke', ADMIN, { revokedOn: '2026-03-01' })).status).toBe(200);
    expect((await call('POST', '/v1/platform/partners/sandboxes/sb-1', ADMIN, { partnerId: 'sre-integrator', createdOn: '2026-01-01', expiresOn: '2099-01-01' })).status).toBe(201);
    expect((await call('POST', '/v1/platform/partners/certifications/cert-1', ADMIN, { partnerId: 'sre-integrator', connectorId: 'tally-bridge', certifiedOn: '2026-06-01', againstVersions: [{ contract: 'API-02', version: 'v1' }], certifiedBy: ADMIN })).status).toBe(201);

    for (const hh of [h, harness(h)]) {
      const listed = await call('GET', '/v1/platform/partners', ADMIN, undefined, hh);
      expect(listed.status).toBe(200);
      const body = listed.body as { credentials: { credentialId: string; state: string; revokedOn?: string }[]; sandboxes: { sandboxId: string; syntheticDataOnly: boolean }[]; certifications: { connectorId: string }[] };
      expect(body.credentials.map((c) => [c.credentialId, c.state])).toEqual([['cred-a', 'active'], ['cred-b', 'expired'], ['cred-c', 'revoked']]);
      expect(body.credentials[2]!.revokedOn).toBe('2026-03-01');
      expect(body.sandboxes).toEqual([expect.objectContaining({ sandboxId: 'sb-1', syntheticDataOnly: true, expired: false })]);
      expect(body.certifications).toEqual([expect.objectContaining({ connectorId: 'tally-bridge', certifiedBy: ADMIN })]);
      expect(JSON.stringify(body)).not.toMatch(/secret|token/i);
    }
    expect((await call('GET', '/v1/platform/partners', CASH)).status).toBe(403);
  });
});

describe('the partner webhook subscriptions are listed with their dead letters (D14-FR-06)', () => {
  it('lists each subscription and its totals; a redelivered dead letter waits again and its history stays', async () => {
    const partner = recordingPartner();
    const h = apiHarness({ outboundTransport: partner, outboundSecrets: new Map([['w3-partner', SECRET]]) });
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, ADMIN, 'platform_admin');
    await h.provisionRole(T, CHECKER, 'platform_admin');
    await h.provisionRole(T, CASH, 'cashier');
    const raw: Raw = (method, path, user, body, key, query) => h.request({ method, path, userId: user, tenantId: T, ...(key === undefined ? {} : { idempotencyKey: key }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const list = async () => (await raw('GET', '/v1/integration/outbound-webhooks', ADMIN)).body as { subscriptions: { subscriptionId: string; signingKeyRef: string; totals: { all: number; delivered: number; pending: number; deadLettered: number } }[]; publishedEvents: string[]; transport: string; deadLettered: number };

    const none = await list();
    expect(none).toMatchObject({ subscriptions: [], transport: 'recording-partner', deadLettered: 0, approvalKind: 'partner_webhook_subscription' });
    expect(none.publishedEvents).toEqual(['InventoryMoved', 'SaleCommitted']);

    const good = { partnerId: 'sre-integrator', url: 'https://integrator.example.test/hooks', eventTypes: ['SaleCommitted'], signingKeyRef: 'vault://w3-partner', maxAttempts: 2 };
    expect((await raw('POST', '/v1/integration/outbound-webhooks/SUB-W3', ADMIN, await approvedSubscription(raw, ADMIN, CHECKER, 'SUB-W3', good), `sub-${randomUUID()}`)).status).toBe(201);
    await new Promise((r) => setTimeout(r, 5));
    const sale = { saleId: 'W3-1', receiptNumber: 'R-W3-1', laneId: 'lane-1', cashierId: CASH, tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(), totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [], tenders: [{ kind: 'cash', amountMinor: 1_000 }] };
    expect((await raw('POST', '/v1/sales', OWNER, sale, 'sale-w3-1')).status).toBe(202);
    partner.answers.push(400);
    expect((await raw('POST', '/v1/integration/outbound-deliveries/drain', ADMIN, {}, `drain-${randomUUID()}`)).status).toBe(200);

    const after = await list();
    expect(after.subscriptions).toEqual([expect.objectContaining({ subscriptionId: 'SUB-W3', signingKeyRef: 'vault://w3-partner', totals: { all: 1, delivered: 0, pending: 0, deadLettered: 1 } })]);
    expect(after.deadLettered).toBe(1);
    expect(JSON.stringify(after)).not.toContain(SECRET);

    const dead = (await raw('GET', '/v1/integration/outbound-webhooks/SUB-W3/dead-letters', ADMIN)).body as { deadLetters: { messageId: string }[] };
    const messageId = dead.deadLetters[0]!.messageId;
    expect((await raw('POST', `/v1/integration/outbound-webhooks/SUB-W3/messages/${encodeURIComponent(messageId)}/redeliver`, ADMIN, {}, `re-${randomUUID()}`)).status).toBe(200);
    expect((await list()).subscriptions[0]!.totals).toEqual({ all: 1, delivered: 0, pending: 1, deadLettered: 0 });
    // The first series' attempt is still on the ledger: the dead letter was never deleted, only sent again.
    const facts = await h.store.readStream(T, streamName(STREAM.platform, 'outbound-webhooks'));
    expect(facts.filter((f) => (f.event.payload as { change: string; outcome?: string }).outcome === 'dead_lettered')).toHaveLength(1);
    expect((await raw('GET', '/v1/integration/outbound-webhooks', CASH)).status).toBe(403);
  });
});
