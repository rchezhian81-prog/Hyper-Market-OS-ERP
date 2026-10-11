import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness, TEST_IDP } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import type { HttpRequest } from '../../services/kernel/src/index';
import { verifyOutboundSignature, type OutboundTransport } from '../../services/platform/src/outbound-webhooks';

/**
 * **D14-FR-06 / M32-FR-01·02 · roadmap §30.1: "signed webhooks with replay protection, retry schedule, dead-letter and
 * reconciliation endpoint" — the OUTBOUND half: head office tells a partner what happened.**
 *
 * On the real API (in memory, and on real PostgreSQL through the production assembly and its own sender worker), with a
 * recording partner transport (no partner is live):
 *
 *   • SUBSCRIBE — https only, published event types only, a vault:// reference never the secret, setup rights only; the
 *     same subscription again is unchanged; a change is a new version.
 *   • SIGNED — each message carries its id (the partner's idempotency key), a timestamp and v1=HMAC(secret, ts.body); the
 *     partner's reference check accepts it and refuses a tampered body or a stale replay. The body is versioned (v1).
 *   • RETRY — a 503 is tried again only after its backoff (1 min, then 2 …); a delivered message is never sent twice.
 *   • DEAD LETTER — a 400 (the partner refusing it) is dead-lettered at once; retries run out after maxAttempts; a dead
 *     letter is listed, never deleted, and a person may send it again (a new series; the history stays).
 *   • HELD — with the signing secret unavailable nothing is sent unsigned; the message waits and is said.
 *   • RECONCILE — every message since a time with its status and the totals; switched off, nothing more is sent.
 */

const OWNER = 'u-owner'; const CASHIER = 'u-cash';
const SECRET_NAME = 'partner-a-signing';
const SECRET = ['outbound', 'test', 'secret', 'built', 'at', 'run', 'time'].join('-').padEnd(40, 'x');

interface Sent { url: string; headers: Record<string, string>; body: string }
function recordingPartner(): OutboundTransport & { sent: Sent[]; answers: (number | null)[] } {
  const sent: Sent[] = []; const answers: (number | null)[] = [];
  return {
    name: 'recording-partner', sent, answers,
    send: async (m) => { sent.push({ url: m.url, headers: { ...m.headers }, body: m.body }); const a = answers.length > 0 ? answers.shift()! : 200; return { status: a }; },
  };
}

type Raw = (method: HttpRequest['method'], path: string, user: string, body?: unknown, key?: string, query?: Record<string, string>) => Promise<{ status: number; body: unknown }>;
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;
const sale = (saleId: string) => ({
  saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: CASHIER, tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(),
  totalMinor: 1_000, currency: 'INR', packVersion: 0, lines: [], tenders: [{ kind: 'cash', amountMinor: 1_000 }],
});

async function theOutboundPath(raw: Raw, partner: ReturnType<typeof recordingPartner>, drain: () => Promise<void>): Promise<void> {
  const post = (user: string, path: string, body: unknown, key = `k-${randomUUID()}`) => raw('POST', path, user, body, key);
  const S = '/v1/integration/outbound-webhooks/SUB-A';
  const good = { partnerId: 'partner-a', url: 'https://partner-a.example.test/hooks', eventTypes: ['SaleCommitted'], signingKeyRef: `vault://${SECRET_NAME}`, maxAttempts: 3 };

  // SUBSCRIBE — the refusals, then the subscription.
  expect(codeOf(await post(OWNER, S, { ...good, url: 'http://partner-a.example.test/hooks' }))).toBe('not_readable_as_an_outbound_webhook');
  expect(codeOf(await post(OWNER, S, { ...good, signingKeyRef: SECRET }))).toBe('not_readable_as_an_outbound_webhook'); // a literal secret, never
  expect(codeOf(await post(OWNER, S, { ...good, eventTypes: ['PayrollRun'] }))).toBe('event_type_not_published');
  expect((await post(CASHIER, S, good)).status).toBe(403);
  const made = await post(OWNER, S, good, 'sub-1');
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect(made.body).toMatchObject({ subscription: { version: 1, active: true, setBy: OWNER } });
  expect((await post(OWNER, S, good, 'sub-1b')).body).toMatchObject({ unchanged: true });

  // Two sales after it was made.
  vi.setSystemTime(Date.now() + 1_000);
  expect((await post(OWNER, '/v1/sales', sale('OUT-1'), 'sale-1')).status).toBe(202);
  expect((await post(OWNER, '/v1/sales', sale('OUT-2'), 'sale-2')).status).toBe(202);

  // PASS 1 — the first is taken; the second gets a 503 and waits for its backoff.
  partner.answers.push(200, 503);
  await drain();
  expect(partner.sent).toHaveLength(2);
  const first = partner.sent[0]!;
  expect(first.url).toBe(good.url);
  expect(first.headers['x-sre-api-version']).toBe('v1');
  const body = JSON.parse(first.body) as { id: string; apiVersion: string; type: string; data: { saleId: string } };
  expect(body).toMatchObject({ apiVersion: 'v1', type: 'SaleCommitted', data: { saleId: 'OUT-1' } });
  expect(first.headers['x-sre-webhook-id']).toBe(body.id);
  // The partner's check: genuine → ok; a tampered body or a replay an hour later → refused.
  const ts = first.headers['x-sre-webhook-timestamp']!; const sig = first.headers['x-sre-webhook-signature']!;
  expect(verifyOutboundSignature({ secret: SECRET, timestamp: ts, body: first.body, signature: sig, nowMs: Date.now() })).toEqual({ ok: true });
  expect(verifyOutboundSignature({ secret: SECRET, timestamp: ts, body: first.body.replace('OUT-1', 'OUT-9'), signature: sig, nowMs: Date.now() })).toMatchObject({ ok: false, reason: 'bad_signature' });
  expect(verifyOutboundSignature({ secret: SECRET, timestamp: ts, body: first.body, signature: sig, nowMs: Date.now() + 3_600_000 })).toMatchObject({ ok: false, reason: 'stale' });

  // PASS 2 at once — nothing: the delivered one is never re-sent, the failed one is not due yet.
  await drain();
  expect(partner.sent).toHaveLength(2);
  // A minute later its retry is due and goes; the same id (the partner dedupes on it).
  vi.setSystemTime(Date.now() + 61_000);
  await drain();
  expect(partner.sent).toHaveLength(3);
  expect(partner.sent[2]!.headers['x-sre-webhook-id']).toBe(partner.sent[1]!.headers['x-sre-webhook-id']);

  // DEAD LETTER — the partner refuses the third (400): dead at once, listed; a person sends it again and it goes.
  expect((await post(OWNER, '/v1/sales', sale('OUT-3'), 'sale-3')).status).toBe(202);
  partner.answers.push(400);
  await drain();
  const dead = (await raw('GET', `${S}/dead-letters`, OWNER)).body as { deadLetters: { messageId: string; lastStatus: number; attempts: number }[] };
  expect(dead.deadLetters).toHaveLength(1);
  expect(dead.deadLetters[0]).toMatchObject({ lastStatus: 400, attempts: 1 });
  const deadId = dead.deadLetters[0]!.messageId;
  await drain();
  expect(partner.sent).toHaveLength(4); // a dead letter is not retried by itself
  expect((await post(CASHIER, `${S}/messages/${encodeURIComponent(deadId)}/redeliver`, {})).status).toBe(403);
  expect((await post(OWNER, `${S}/messages/${encodeURIComponent(deadId)}/redeliver`, {}, 'redo-1')).body).toMatchObject({ series: 2, requeuedBy: OWNER });
  partner.answers.push(200);
  await drain();
  expect(partner.sent).toHaveLength(5);
  expect(codeOf(await post(OWNER, `${S}/messages/${encodeURIComponent(deadId)}/redeliver`, {}))).toBe('not_a_dead_letter');

  // RETRIES RUN OUT — maxAttempts 3: three failures in a row and it is dead, said as "gave up".
  expect((await post(OWNER, '/v1/sales', sale('OUT-4'), 'sale-4')).status).toBe(202);
  for (const wait of [0, 61_000, 121_000]) { vi.setSystemTime(Date.now() + wait); partner.answers.push(503); await drain(); }
  const recon = (await raw('GET', `${S}/reconciliation`, OWNER)).body as { totals: Record<string, number>; messages: { status: string; detail: string | null; attempts: number }[] };
  expect(recon.totals).toEqual({ all: 4, delivered: 3, pending: 0, deadLettered: 1 });
  expect(recon.messages.find((m) => m.status === 'dead_lettered')).toMatchObject({ attempts: 3, detail: expect.stringMatching(/^gave up after 3 attempt/) });
  expect((await raw('GET', `${S}/reconciliation`, OWNER, undefined, undefined, { from: 'not-a-time' })).status).toBe(400);

  // SWITCHED OFF — kept as a version; nothing more is sent.
  expect((await post(OWNER, `${S}/deactivate`, {}, 'off-1')).body).toMatchObject({ subscription: { active: false, version: 2 } });
  expect((await post(OWNER, '/v1/sales', sale('OUT-5'), 'sale-5')).status).toBe(202);
  const before = partner.sent.length;
  await drain();
  expect(partner.sent).toHaveLength(before);
}

async function heldWithoutTheSecret(raw: Raw, partner: ReturnType<typeof recordingPartner>, drain: () => Promise<void>): Promise<void> {
  const S = '/v1/integration/outbound-webhooks/SUB-NOKEY';
  vi.setSystemTime(Date.now() + 1_000); // a subscription delivers what happens from the moment it is made
  expect((await raw('POST', S, OWNER, { partnerId: 'partner-b', url: 'https://partner-b.example.test/h', eventTypes: ['SaleCommitted'], signingKeyRef: 'vault://not-configured' }, 'sub-nokey')).status).toBe(201);
  vi.setSystemTime(Date.now() + 1_000);
  expect((await raw('POST', '/v1/sales', OWNER, sale('NOKEY-1'), 'sale-nokey')).status).toBe(202);
  const before = partner.sent.filter((s) => s.url.includes('partner-b')).length;
  await drain();
  expect(partner.sent.filter((s) => s.url.includes('partner-b')).length).toBe(before); // nothing is ever sent unsigned
  const recon = (await raw('GET', `${S}/reconciliation`, OWNER)).body as { totals: { pending: number } };
  expect(recon.totals.pending).toBe(1);
}

describe('outbound webhooks — signed, retried, dead-lettered, reconciled (real API, in memory)', () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterAll(() => { vi.useRealTimers(); });
  it('the whole path, and nothing sent without its secret', async () => {
    const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0d14';
    const partner = recordingPartner();
    const h = apiHarness({ outboundTransport: partner, outboundSecrets: new Map([[SECRET_NAME, SECRET]]) });
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, CASHIER, 'cashier');
    const raw: Raw = (method, path, user, body, key, query) => h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
    const drain = async () => { const r = await raw('POST', '/v1/integration/outbound-deliveries/drain', OWNER, {}, `drain-${randomUUID()}`); expect(r.status, JSON.stringify(r.body)).toBe(200); };
    await theOutboundPath(raw, partner, drain);
    await heldWithoutTheSecret(raw, partner, drain);
  });
  it('without a partner transport nothing is sent and the drain says so (503); messages wait, listed', async () => {
    const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa1d14';
    const h = apiHarness();
    await h.seedOwner(T, OWNER);
    const r = await h.request({ method: 'POST', path: '/v1/integration/outbound-deliveries/drain', userId: OWNER, tenantId: T, idempotencyKey: 'd-1', body: {} });
    expect(r.status).toBe(503);
    expect(codeOf(r)).toBe('no_outbound_transport');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;
describeOrSkip('outbound webhooks on real PostgreSQL, through the production assembly and its own sender worker', () => {
  let cloud: RealCloud;
  const partner = recordingPartner();
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    cloud = await startRealCloud({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: ['d14', 'pack', 'key'].join('-').padEnd(48, '0'),
      providers: { outboundTransport: partner, outboundWorkerIntervalMs: 3_600_000 },
      env: { [`OUTBOUND_WEBHOOK_SECRET__${SECRET_NAME}`]: SECRET },
    });
    await cloud.grant(CASHIER, 'cashier');
  }, 120_000);
  afterAll(async () => { await cloud?.stop(); vi.useRealTimers(); });
  it('the whole path — each pass run by the API\'s own worker — and nothing sent without its secret', async () => {
    expect(cloud.said.join('\n')).toContain('outbound webhooks: the sender runs every 3600 s through recording-partner');
    const raw: Raw = async (method, path, user, body, key, query) => {
      const qs = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
      const res = await fetch(`${cloud.baseUrl}${path}${qs}`, {
        method,
        headers: { authorization: `Bearer ${TEST_IDP.issue({ sub: user, tenantId: cloud.tenantId })}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key === undefined ? {} : { 'idempotency-key': key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
    };
    // The worker's own pass (the same one the timer runs), over the shops named in WORKER_TENANT_IDS.
    const drain = async () => { const p = await cloud.outboundWorker!.runOnce(); expect(p.failed).toEqual([]); };
    await theOutboundPath(raw, partner, drain);
    await heldWithoutTheSecret(raw, partner, drain);
  }, 120_000);
});
