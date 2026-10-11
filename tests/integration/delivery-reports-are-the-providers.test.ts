import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { recordingTransport } from '../../packages/notifications/src/index';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { SqlIdempotencyStore, MemoryIdempotencyStore, type IdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { campaignSendAdapter, notificationQueueAdapter } from '../../services/api/src/adapters';
import { deliveryReportSecretsFromEnv } from '../../services/customer/src/provider-reports';
import { signedReport, testProviderSecret, TEST_PROVIDER } from '../support/provider-report';

/**
 * **PF-10 (round 6) — a delivery report is believed only when it is the PROVIDER's (M21-FR-01 · M31-FR-03 · P-04 ·
 * hard rule #4).**
 *
 * Before, `POST …/messages/:id/status` took a report from any staff session holding a permission, matched on a
 * predictable provider reference, with no signature. Through the REAL routes (API harness, in memory and on PostgreSQL),
 * after a real campaign send and a real drain to the recording provider:
 *   • a report signed with the provider's secret, relayed by the provider relay's machine identity, is recorded once;
 *   • the same report sent again is acknowledged as a REPLAY and not recorded twice;
 *   • REFUSED: unsigned; signed with the wrong secret; altered after signing; a signature moved to another message;
 *     stale (sent ten minutes ago); an unknown provider; another configured provider claiming this provider's message;
 *     and EVERY person's session — cashier, manager, owner — even with a correctly signed body;
 *   • with no provider configured, the route refuses (503) even a perfectly signed report;
 *   • the out-of-band queue receipt route obeys the same rule.
 */

const OWNER = 'u-owner'; const CHECKER = 'u-checker'; const MANAGER = 'u-manager'; const CASHIER = 'u-cash'; const RELAY = 'u-relay';
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function scene(h: ApiHarness, T: string): Promise<void> {
  const post = (path: string, u: string, body: unknown) => h.request({ method: 'POST', path, userId: u, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
  await h.seedOwner(T, OWNER);
  await h.provisionOwner(T, CHECKER);
  await h.provisionRole(T, MANAGER, 'store_manager');
  await h.provisionRole(T, CASHIER, 'cashier');
  await h.provisionRole(T, RELAY, 'message_provider_relay');
  expect((await post('/v1/customers/cust-a/consent', OWNER, { purpose: 'marketing', channel: 'sms', given: true, evidence: 'ticked the box' })).status).toBeLessThan(300);
  expect((await post('/v1/customers/cust-b/consent', OWNER, { purpose: 'marketing', channel: 'sms', given: true, evidence: 'ticked the box' })).status).toBeLessThan(300);
  expect((await post('/v1/notifications/templates/tpl', OWNER, { purpose: 'marketing', channel: 'sms', body: 'SRE: {offer}' })).status).toBe(201);
  expect((await post('/v1/notifications/templates/tpl/approval', CHECKER, { version: 1 })).status).toBe(200);
  expect((await post('/v1/notifications/budget', OWNER, { capMinor: 100_000, costMinorByChannel: { sms: 25 } })).status).toBe(201);
  expect((await h.request({ method: 'PUT', path: '/v1/service/campaigns/frequency-policy', userId: OWNER, tenantId: T, idempotencyKey: 'pol', body: { capPerWindow: 5, windowDays: 7 } })).status).toBe(200);
  expect((await post('/v1/service/campaigns/c1/send', OWNER, { purpose: 'marketing', channel: 'sms', templateId: 'tpl', containsPromotion: true, audience: ['cust-a', 'cust-b'], values: { offer: 'rice 10% off' } })).status).toBe(201);
}

async function onlyTheProvidersWordCounts(h: ApiHarness, T: string, secret: string, otherSecret: string, store: EventStore): Promise<void> {
  await scene(h, T);
  const drain = await h.request({ method: 'POST', path: '/v1/notifications/queue/drain', userId: OWNER, tenantId: T, idempotencyKey: 'drain-1', body: {} });
  expect(drain.status).toBe(200);
  const P = '/v1/service/campaigns/c1/messages/cmp-c1-cust-a/status';
  const P2 = '/v1/service/campaigns/c1/messages/cmp-c1-cust-b/status';
  const post = (path: string, u: string, body: unknown) => h.request({ method: 'POST', path, userId: u, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
  const fields = { status: 'delivered', providerRef: 'rec-cmp-c1-cust-a', reportedAt: new Date().toISOString() };
  const good = signedReport(P, fields, secret, { reportId: 'prov-r-1' });
  const reports = async () => (await campaignSendAdapter({ store, now: () => new Date().toISOString() }).callbacks(T, 'c1'));

  // Every PERSON's session is refused — even carrying a correctly signed body.
  expect((await post(P, CASHIER, good)).status).toBe(403);
  for (const who of [MANAGER, OWNER]) expect((await post(P, who, good)).status, who).toBe(403);
  expect(codeOf(await post(P, OWNER, good))).toBe('not_the_provider_relay'); // the owner holds the permission — not the role
  // Unsigned; wrong secret; altered after signing; moved to another message; stale; unknown provider.
  const unsigned = Object.fromEntries(Object.entries(good).filter(([k]) => k !== 'signature'));
  expect(codeOf(await post(P, RELAY, unsigned))).toBe('delivery_report_unsigned');
  expect(codeOf(await post(P, RELAY, signedReport(P, fields, testProviderSecret(), { reportId: 'prov-r-x' })))).toBe('delivery_report_bad_signature');
  expect(codeOf(await post(P, RELAY, { ...good, status: 'failed', reason: 'never arrived' }))).toBe('delivery_report_bad_signature');
  expect(codeOf(await post(P2, RELAY, signedReport(P, { ...fields, providerRef: 'rec-cmp-c1-cust-b' }, secret, { reportId: 'prov-r-moved' })))).toBe('delivery_report_bad_signature');
  expect(codeOf(await post(P, RELAY, signedReport(P, fields, secret, { reportId: 'prov-r-old', sentAt: new Date(Date.now() - 10 * 60_000).toISOString() })))).toBe('delivery_report_stale');
  expect(codeOf(await post(P, RELAY, signedReport(P, fields, secret, { reportId: 'prov-r-u', provider: 'nobody-sms' })))).toBe('unknown_provider');
  // Another configured provider cannot report on a message this provider took.
  expect(codeOf(await post(P, RELAY, signedReport(P, fields, otherSecret, { reportId: 'prov-r-o', provider: 'other-sms' })))).toBe('not_this_providers_message');
  expect(await reports()).toEqual([]);                                   // nothing believed so far

  // The provider's own signed report, relayed: recorded once — and the same report again is a replay, not a record.
  const ok = await post(P, RELAY, good);
  expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  const again = await post(P, RELAY, good);
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ replayed: true });
  const kept = await reports();
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ messageId: 'cmp-c1-cust-a', status: 'delivered', provider: TEST_PROVIDER, reportId: 'prov-r-1', recordedBy: RELAY });
  const status = (await h.request({ method: 'GET', path: '/v1/service/campaigns/c1/status', userId: OWNER, tenantId: T })).body as { totals: Record<string, number> };
  expect(status.totals).toMatchObject({ deliveredReported: 1 });

  // The out-of-band queue receipt obeys the same rule: a person is refused; the provider's signed word is taken.
  const Q = '/v1/notifications/queue/cmp-c1-cust-b/delivered';
  expect(codeOf(await post(Q, OWNER, signedReport(Q, {}, secret)))).toBe('not_the_provider_relay');
  expect(codeOf(await post(Q, RELAY, {}))).toBe('delivery_report_unsigned');
  expect((await post(Q, RELAY, signedReport(Q, { providerRef: 'rec-cmp-c1-cust-b' }, secret))).status).toBe(200);
}

/**
 * PA-08 / PF-10 round 7 — the out-of-band QUEUE receipt routes (`…/queue/:id/failed`, `…/delivered`): the provider's
 * report id is the idempotency key, and only the provider the sender handed the message to may report on it.
 */
async function queueReportsAreTheTakingProvidersOnce(h: ApiHarness, T: string, secret: string, otherSecret: string, transport: ReturnType<typeof recordingTransport>, store: EventStore): Promise<void> {
  await scene(h, T);
  // The first send attempt fails at the provider (transient): both messages stay pending, handed to the recording provider.
  transport.failWith({ reason: 'provider busy' }, 2);
  expect((await h.request({ method: 'POST', path: '/v1/notifications/queue/drain', userId: OWNER, tenantId: T, idempotencyKey: 'drain-f', body: {} })).status).toBe(200);
  const post = (path: string, u: string, body: unknown) => h.request({ method: 'POST', path, userId: u, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
  const pending = async () => ((await h.request({ method: 'GET', path: '/v1/notifications/queue/pending', userId: OWNER, tenantId: T })).body as { pending: { id: string; attempts: number }[] }).pending;
  const deadLetters = async () => ((await h.request({ method: 'GET', path: '/v1/notifications/queue/dead-letters', userId: OWNER, tenantId: T })).body as { deadLetters: { id: string }[] }).deadLetters;
  const attemptsOf = async (id: string) => (await pending()).find((x) => x.id === id)?.attempts;
  expect(await attemptsOf('cmp-c1-cust-a')).toBe(1);
  const queueEvents = async () => notificationQueueAdapter({ store, now: () => new Date().toISOString() }).events!(T);
  const failuresOn = async (id: string) => (await queueEvents()).filter((e) => e.id === id && e.change === 'failed').length;

  const F = '/v1/notifications/queue/cmp-c1-cust-a/failed';
  const failure = signedReport(F, { reason: 'handset unreachable', maxAttempts: 3 }, secret, { reportId: 'fail-r-1' });
  // A staff session — the owner's, the manager's — is refused even with a correctly signed body; nothing recorded.
  for (const who of [CASHIER, MANAGER, OWNER]) expect((await post(F, who, failure)).status, who).toBe(403);
  expect(codeOf(await post(F, OWNER, failure))).toBe('not_the_provider_relay'); // the owner holds the permission — not the role
  // Another configured provider cannot report on a message the recording provider took.
  expect(codeOf(await post(F, RELAY, signedReport(F, { reason: 'x', maxAttempts: 3 }, otherSecret, { provider: 'other-sms', reportId: 'other-1' })))).toBe('not_this_providers_message');
  // A message never handed to any provider has nobody who can report on it.
  expect((await post('/v1/notifications/queue/n-fresh', OWNER, { customerId: 'cust-a', purpose: 'marketing', channel: 'sms', templateId: 'tpl', values: { offer: 'dal 5% off' } })).status).toBe(201);
  const FF = '/v1/notifications/queue/n-fresh/failed';
  expect(codeOf(await post(FF, RELAY, signedReport(FF, { reason: 'x' }, secret)))).toBe('not_handed_to_a_provider');
  expect(await attemptsOf('cmp-c1-cust-a')).toBe(1);
  expect(await attemptsOf('n-fresh')).toBe(0);

  // The taking provider's signed failure: one more attempt (2 of 3) — and the SAME report replayed within its freshness
  // window, three times, is acknowledged as a replay: never another attempt, never a dead letter.
  const first = await post(F, RELAY, failure);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body).toMatchObject({ state: 'pending', attempts: 2 });
  for (let i = 0; i < 3; i += 1) {
    const again = await post(F, RELAY, failure);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, state: 'pending', attempts: 2 });
  }
  expect(await attemptsOf('cmp-c1-cust-a')).toBe(2);
  expect(await deadLetters()).toEqual([]);
  expect(await failuresOn('cmp-c1-cust-a')).toBe(2);                 // the sender's attempt + ONE provider report
  // A DISTINCT failure report from the provider is its own fact: the third attempt — dead-lettered, as the engine rules.
  expect((await post(F, RELAY, signedReport(F, { reason: 'handset unreachable', maxAttempts: 3 }, secret, { reportId: 'fail-r-2' }))).body).toMatchObject({ state: 'dead_letter', attempts: 3 });
  expect((await deadLetters()).map((d) => d.id)).toEqual(['cmp-c1-cust-a']);

  // DELIVERED obeys the same two rules: the wrong provider is refused; the taking provider's report lands once.
  const D = '/v1/notifications/queue/cmp-c1-cust-b/delivered';
  expect(codeOf(await post(D, OWNER, signedReport(D, {}, secret)))).toBe('not_the_provider_relay');
  expect(codeOf(await post(D, RELAY, signedReport(D, { providerRef: 'x' }, otherSecret, { provider: 'other-sms', reportId: 'other-d' })))).toBe('not_this_providers_message');
  expect(await attemptsOf('cmp-c1-cust-b')).toBe(1);                 // still pending: nothing believed
  const delivered = signedReport(D, { providerRef: 'rec-cmp-c1-cust-b' }, secret, { reportId: 'del-r-1' });
  expect((await post(D, RELAY, delivered)).body).toMatchObject({ state: 'delivered' });
  expect((await post(D, RELAY, delivered)).body).toMatchObject({ replayed: true, state: 'delivered' });
  expect((await queueEvents()).filter((e) => e.id === 'cmp-c1-cust-b' && e.change === 'delivered')).toHaveLength(1);
}

async function noProviderNoReport(h: ApiHarness, T: string, secret: string): Promise<void> {
  await scene(h, T);
  await h.request({ method: 'POST', path: '/v1/notifications/queue/drain', userId: OWNER, tenantId: T, idempotencyKey: 'drain-1', body: {} });
  const P = '/v1/service/campaigns/c1/messages/cmp-c1-cust-a/status';
  const r = await h.request({ method: 'POST', path: P, userId: RELAY, tenantId: T, idempotencyKey: 'r1', body: signedReport(P, { status: 'delivered', providerRef: 'rec-cmp-c1-cust-a' }, secret) });
  expect(r.status).toBe(503);
  expect(codeOf(r)).toBe('no_delivery_provider_configured');
}

describe('PF-10 r6 — a delivery report is believed only when it is the provider\'s (in memory)', () => {
  it('signed, fresh, relayed and not a replay — or refused; every person\'s session refused', async () => {
    const secret = testProviderSecret(); const other = testProviderSecret();
    const store = new InMemoryEventStore();
    const h = apiHarness({ store, idempotency: new MemoryIdempotencyStore(), notificationTransport: recordingTransport(), deliveryReportSecrets: new Map([[TEST_PROVIDER, secret], ['other-sms', other]]) });
    await onlyTheProvidersWordCounts(h, 'ab000000-0000-4000-8000-00000000f10a', secret, other, store);
  });

  it('PA-08 r7: the queue receipt routes — a replayed failure is one fact, never another attempt; only the taking provider reports; staff refused', async () => {
    const secret = testProviderSecret(); const other = testProviderSecret();
    const store = new InMemoryEventStore(); const transport = recordingTransport();
    const h = apiHarness({ store, idempotency: new MemoryIdempotencyStore(), notificationTransport: transport, deliveryReportSecrets: new Map([[TEST_PROVIDER, secret], ['other-sms', other]]) });
    await queueReportsAreTheTakingProvidersOnce(h, 'ab000000-0000-4000-8000-00000000f10c', secret, other, transport, store);
  });

  it('with no provider configured, even a perfectly signed report is refused', async () => {
    await noProviderNoReport(apiHarness({ notificationTransport: recordingTransport() }), 'ab000000-0000-4000-8000-00000000f10b', testProviderSecret());
  });

  it('the operator\'s secrets come from the environment; a short one is refused and said (never its value)', () => {
    const long = testProviderSecret();
    const read = deliveryReportSecretsFromEnv({ DELIVERY_REPORT_SECRET__ACME_SMS: long, DELIVERY_REPORT_SECRET__TINY: 'short', OTHER: 'x' });
    expect([...read.secrets.keys()]).toEqual(['acme-sms']);
    expect(read.problems).toEqual(['DELIVERY_REPORT_SECRET__TINY: shorter than 32 characters — refused']);
    expect(read.problems.join(' ')).not.toContain('short\'');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(!DATABASE_URL)('PF-10 r6 — the same on real PostgreSQL', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('signed, fresh, relayed and not a replay — or refused; with no provider configured, refused', async () => {
    const sql = pgPoolClient(pool);
    const secret = testProviderSecret(); const other = testProviderSecret();
    const store = new SqlEventStore(sql);
    const idempotency: IdempotencyStore = new SqlIdempotencyStore(sql);
    await onlyTheProvidersWordCounts(apiHarness({ store, idempotency, notificationTransport: recordingTransport(), deliveryReportSecrets: new Map([[TEST_PROVIDER, secret], ['other-sms', other]]) }), randomUUID(), secret, other, store);
    await noProviderNoReport(apiHarness({ store, idempotency, notificationTransport: recordingTransport() }), randomUUID(), secret);
  });

  it('PA-08 r7: the queue receipt routes — replay is one fact, the wrong provider and staff refused — on PostgreSQL', async () => {
    const sql = pgPoolClient(pool);
    const secret = testProviderSecret(); const other = testProviderSecret();
    const store = new SqlEventStore(sql); const transport = recordingTransport();
    const h = apiHarness({ store, idempotency: new SqlIdempotencyStore(sql), notificationTransport: transport, deliveryReportSecrets: new Map([[TEST_PROVIDER, secret], ['other-sms', other]]) });
    await queueReportsAreTheTakingProvidersOnce(h, randomUUID(), secret, other, transport, store);
  });
});
