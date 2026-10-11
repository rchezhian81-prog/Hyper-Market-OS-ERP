import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { recordingTransport } from '../../packages/notifications/src/transport';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlIdempotencyStore, MemoryIdempotencyStore } from '../../services/kernel/src/index';
import { signedReport, testProviderSecret, TEST_PROVIDER } from '../support/provider-report';

/**
 * **A campaign goes out through the queue, within the owner's frequency cap, with its delivery status recorded
 * (audit PF-10 · M21-FR-01 · M31-FR-04).**
 *
 * Through the real API: the owner sets the cap (2 marketing messages per customer per channel per 7 days); a campaign
 * cannot be sent before that. The campaign's approved template comes from head office's register; each recipient's
 * consent from their own ledger; the frequency history from the PA-08 queue itself. Approved recipients are ENQUEUED on
 * the PA-08 queue (a re-send queues nothing twice). A customer who withdraws after being queued is WITHHELD by the
 * sender's re-check (the queue's drain, recording test transport). The third campaign excludes the two customers at the
 * cap and the one who withdrew — by reason. A provider's delivery report is recorded against its message only with that
 * provider's reference, and the status read shows every message. All of it again after a restart, and on PostgreSQL.
 */

const OWNER = 'u-owner'; const CHECKER = 'u-checker'; const MANAGER = 'u-manager';
// PF-10 r6: delivery reports are the provider's, signed with its callback secret and relayed by the relay's identity.
const RELAY = 'u-provider-relay';
const SECRET = testProviderSecret();
const SECRETS = new Map([[TEST_PROVIDER, SECRET]]);
const A = 'cust-a'; const B = 'cust-b'; const C = 'cust-c'; const D = 'cust-d';

async function cast(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, OWNER);
  await h.provisionOwner(T, CHECKER);
  await h.provisionRole(T, MANAGER, 'store_manager');
  await h.provisionRole(T, RELAY, 'message_provider_relay');
  for (const c of [A, B, C, D]) await h.provisionRole(T, c, 'customer');
  for (const c of [A, B, C]) {
    const r = await h.request({ method: 'POST', path: '/v1/me/privacy/consent', userId: c, tenantId: T, idempotencyKey: `yes-${c}`, body: { purpose: 'marketing', channel: 'sms', given: true } });
    expect(r.status).toBe(201);
  }
  await h.request({ method: 'POST', path: '/v1/notifications/templates/tpl-offer', userId: OWNER, tenantId: T, idempotencyKey: 'tpl-d', body: { purpose: 'marketing', channel: 'sms', body: 'SRE this week: {offer}' } });
  // PA-08 round 4: the owner's messaging budget — nothing is sent until it is set; room for plenty here.
  expect((await h.request({ method: 'POST', path: '/v1/notifications/budget', userId: OWNER, tenantId: T, idempotencyKey: 'budget', body: { capMinor: 100_000, costMinorByChannel: { sms: 25 } } })).status).toBe(201);
  expect((await h.request({ method: 'POST', path: '/v1/notifications/templates/tpl-offer/approval', userId: CHECKER, tenantId: T, idempotencyKey: 'tpl-a', body: { version: 1 } })).status).toBe(200);
}

const send = (h: ApiHarness, T: string, campaignId: string, key: string) => h.request({
  method: 'POST', path: `/v1/service/campaigns/${campaignId}/send`, userId: OWNER, tenantId: T, idempotencyKey: key,
  body: { purpose: 'marketing', channel: 'sms', templateId: 'tpl-offer', containsPromotion: true, audience: [A, B, C, D], values: { offer: 'rice 10% off' } },
});
const status = (h: ApiHarness, T: string, campaignId: string) => h.request({ method: 'GET', path: `/v1/service/campaigns/${campaignId}/status`, userId: OWNER, tenantId: T });
const report = (h: ApiHarness, T: string, campaignId: string, messageId: string, body: Record<string, unknown>, key: string) => {
  const path = `/v1/service/campaigns/${campaignId}/messages/${messageId}/status`;
  return h.request({ method: 'POST', path, userId: RELAY, tenantId: T, idempotencyKey: key, body: signedReport(path, body, SECRET, { reportId: `${T}-${key}` }) });
};
const code = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;

async function journey(h: ApiHarness, T: string, restart: () => ApiHarness): Promise<void> {
  await cast(h, T);

  // No cap set: a marketing campaign cannot go — and a manager cannot set the cap (the owner's call).
  const early = await send(h, T, 'c1', 'c1-early');
  expect(early.status).toBe(409);
  expect(code(early)).toBe('frequency_cap_not_set');
  expect((await h.request({ method: 'PUT', path: '/v1/service/campaigns/frequency-policy', userId: MANAGER, tenantId: T, idempotencyKey: 'pol-m', body: { capPerWindow: 9, windowDays: 1 } })).status).toBe(403);
  const pol = await h.request({ method: 'PUT', path: '/v1/service/campaigns/frequency-policy', userId: OWNER, tenantId: T, idempotencyKey: 'pol', body: { capPerWindow: 2, windowDays: 7 } });
  expect(pol.status, JSON.stringify(pol.body)).toBe(200);

  // Campaign 1: A, B, C queued on the PA-08 queue; D has no consent and is excluded by name.
  const c1 = await send(h, T, 'c1', 'c1');
  expect(c1.status, JSON.stringify(c1.body)).toBe(201);
  expect(c1.body).toMatchObject({ queued: 3, excludedByReason: { no_consent: 1 } });
  const pending = ((await h.request({ method: 'GET', path: '/v1/notifications/queue/pending', userId: OWNER, tenantId: T })).body as { pending: { id: string }[] }).pending.map((p) => p.id).sort();
  expect(pending).toEqual(['cmp-c1-cust-a', 'cmp-c1-cust-b', 'cmp-c1-cust-c']);
  // The same campaign sent again (a new key) queues nothing twice.
  const again = await send(h, T, 'c1', 'c1-again');
  expect(again.body).toMatchObject({ queued: 0, alreadyQueued: 3 });

  // The sender drains: three delivered to the (recording) provider.
  const drain1 = await h.request({ method: 'POST', path: '/v1/notifications/queue/drain', userId: OWNER, tenantId: T, idempotencyKey: 'drain-1', body: {} });
  expect(drain1.status, JSON.stringify(drain1.body)).toBe(200);

  // Campaign 2 queued for A, B, C — then C withdraws in the app before the sender runs: C's message is WITHHELD.
  expect((await send(h, T, 'c2', 'c2')).body).toMatchObject({ queued: 3 });
  expect((await h.request({ method: 'POST', path: '/v1/me/privacy/consent', userId: C, tenantId: T, idempotencyKey: 'no-c', body: { purpose: 'marketing', channel: 'sms', given: false } })).status).toBe(201);
  const drain2 = (await h.request({ method: 'POST', path: '/v1/notifications/queue/drain', userId: OWNER, tenantId: T, idempotencyKey: 'drain-2', body: {} })).body as { outcome: { id: string; result: string }[] };
  expect(drain2.outcome.find((o) => o.id === 'cmp-c2-cust-c')?.result).toBe('withheld');

  // Campaign 3: A and B have had 2 in the window (the cap) — excluded; C withdrew; D never consented. Nothing queued.
  const c3 = await send(h, T, 'c3', 'c3');
  expect(c3.status).toBe(200);
  expect(c3.body).toMatchObject({ queued: 0, excludedByReason: { frequency_cap: 2, withdrawn: 1, no_consent: 1 } });

  // DELIVERY REPORTS — against the message, with the provider's own reference.
  const ok = await report(h, T, 'c1', 'cmp-c1-cust-a', { status: 'delivered', providerRef: 'rec-cmp-c1-cust-a', reportedAt: '2026-10-10T10:05:00.000Z' }, 'r1');
  expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  expect((await report(h, T, 'c1', 'cmp-c1-cust-a', { status: 'read', providerRef: 'rec-cmp-c1-cust-a', reportedAt: '2026-10-10T10:09:00.000Z' }, 'r2')).status).toBe(201);
  expect((await report(h, T, 'c1', 'cmp-c1-cust-b', { status: 'failed', providerRef: 'rec-cmp-c1-cust-b', reason: 'handset unreachable', reportedAt: '2026-10-10T10:06:00.000Z' }, 'r3')).status).toBe(201);
  const forged = await report(h, T, 'c1', 'cmp-c1-cust-a', { status: 'delivered', providerRef: 'someone-else', reportedAt: '2026-10-10T10:07:00.000Z' }, 'r4');
  expect(code(forged)).toBe('provider_reference_mismatch');
  const notSent = await report(h, T, 'c2', 'cmp-c2-cust-c', { status: 'delivered', providerRef: 'rec-cmp-c2-cust-c' }, 'r5');
  expect(code(notSent)).toBe('not_handed_to_a_provider');
  expect(code(await report(h, T, 'c1', 'cmp-c9-cust-a', { status: 'delivered', providerRef: 'x' }, 'r6'))).toBe('unknown_campaign_message');
  expect((await report(h, T, 'c1', 'cmp-c1-cust-c', { status: 'failed', providerRef: 'rec-cmp-c1-cust-c' }, 'r7')).status).toBe(400); // a failure needs its reason
  // A customer cannot report on deliveries.
  expect((await h.request({ method: 'POST', path: '/v1/service/campaigns/c1/messages/cmp-c1-cust-a/status', userId: A, tenantId: T, idempotencyKey: 'cust-r', body: { status: 'delivered', providerRef: 'rec-cmp-c1-cust-a' } })).status).toBe(403);

  const check = async (hh: ApiHarness) => {
    const s1 = (await status(hh, T, 'c1')).body as { messages: { messageId: string; queueState: string; providerRef?: string; report?: { status: string; reason?: string } }[]; totals: Record<string, number> };
    expect(s1.messages.find((m) => m.messageId === 'cmp-c1-cust-a')).toMatchObject({ queueState: 'delivered', providerRef: 'rec-cmp-c1-cust-a', report: { status: 'read' } });
    expect(s1.messages.find((m) => m.messageId === 'cmp-c1-cust-b')).toMatchObject({ report: { status: 'failed', reason: 'handset unreachable' } });
    expect(s1.totals).toMatchObject({ queued: 3, sent: 3, deliveredReported: 1, failedReported: 1 });
    const s2 = (await status(hh, T, 'c2')).body as { totals: Record<string, number> };
    expect(s2.totals).toMatchObject({ queued: 3, sent: 2, withheld: 1 });
  };
  await check(h);

  // RESTART: a new process over the same store — the status, the history and the cap all read the same.
  const h2 = restart();
  await check(h2);
  expect((await send(h2, T, 'c4', 'c4')).body).toMatchObject({ queued: 0, excludedByReason: { frequency_cap: 2 } });
}

describe('a campaign goes through the queue within the cap, with delivery reports (PF-10)', () => {
  it('in memory, across a restart', async () => {
    const transport = recordingTransport();
    const h = apiHarness({ notificationTransport: transport, deliveryReportSecrets: SECRETS });
    await journey(h, 'ab000000-0000-4000-8000-0000000f1010', () => apiHarness({ store: h.store, idempotency: new MemoryIdempotencyStore(), notificationTransport: transport, deliveryReportSecrets: SECRETS }));
    // The provider was handed exactly the five messages that were not withheld, each once, with the approved words.
    expect(transport.sent.map((m) => m.messageId).sort()).toEqual(['cmp-c1-cust-a', 'cmp-c1-cust-b', 'cmp-c1-cust-c', 'cmp-c2-cust-a', 'cmp-c2-cust-b']);
    expect(new Set(transport.sent.map((m) => m.text))).toEqual(new Set(['SRE this week: rice 10% off']));
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('a campaign goes through the queue within the cap — real PostgreSQL, across a restart (PF-10)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('the same journey on PostgreSQL', async () => {
    const sql = pgPoolClient(pool);
    const transport = recordingTransport();
    const fresh = (): { store: EventStore; idempotency: SqlIdempotencyStore; notificationTransport: typeof transport; deliveryReportSecrets: typeof SECRETS } => ({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), notificationTransport: transport, deliveryReportSecrets: SECRETS });
    await journey(apiHarness(fresh()), randomUUID(), () => apiHarness(fresh()));
  });
});
